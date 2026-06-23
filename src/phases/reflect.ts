import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Ctx } from "../context.ts";
import { newRunId } from "../context.ts";
import { loadPrompt } from "../prompts.ts";
import { runSession } from "../sdk/session.ts";
import { scopedWriterGuard, ensureAutoProbed } from "../sdk/guard.ts";
import { banner, color, detail, info, ok, warn } from "../util/log.ts";
import { ensureDir, exists, writeText } from "../util/io.ts";

function listReflectDirs(reflectRoot: string): string[] {
  try {
    return fs
      .readdirSync(reflectRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(reflectRoot, e.name))
      .sort();
  } catch {
    return [];
  }
}

function showDiff(current: string, candidate: string): void {
  const r = spawnSync("diff", ["-u", current, candidate], { encoding: "utf8" });
  if (r.status === 0) {
    detail("(no change)");
    return;
  }
  process.stdout.write((r.stdout || "") + "\n");
}

/** Propose prompt improvements from the last run's traces (does NOT apply them). */
export async function cmdReflect(ctx: Ctx, opts: { apply?: boolean; run?: string } = {}): Promise<void> {
  if (opts.apply) return applyReflection(ctx);

  banner("SELF-IMPROVEMENT · REFLECT");
  const runId = opts.run ?? ctx.store.data.build.runId;
  if (!runId) {
    warn("No build run found to reflect on. Run `sparra build` first (or pass --run <runId>).");
    return;
  }
  const traceDir = ctx.paths.traceDir(runId);
  if (!exists(traceDir)) {
    warn(`No traces at ${path.relative(ctx.root, traceDir)}.`);
    return;
  }

  await ensureAutoProbed(ctx);
  const stamp = newRunId("reflect");
  const outDir = path.join(ctx.paths.reflect, stamp);
  const candidatesDir = path.join(outDir, "candidates");
  await ensureDir(candidatesDir);

  const role = ctx.config.roles.reflector;
  const system = await loadPrompt(ctx.paths, "reflector");

  const task = `Reflect on the last build run to improve the role prompts.

READ:
- Traces from this run: ${path.relative(ctx.root, traceDir)}/ (every agent's full transcript)
- Verdicts: ${path.relative(ctx.root, ctx.paths.verdicts)}/
- Contracts: ${path.relative(ctx.root, ctx.paths.contracts)}/
- Current role prompts: ${path.relative(ctx.root, ctx.paths.prompts)}/

Find where the EVALUATOR was too lenient/harsh or diverged from the rubric, where CONTRACTS were too weak, or where calibration drifted.

For EACH prompt you would change, WRITE the full improved prompt to:
  ${path.relative(ctx.root, candidatesDir)}/<role>.md
(use the same role filename as in prompts/, e.g. evaluator.md). Preserve all {{PLACEHOLDERS}}.

Also WRITE ${path.relative(ctx.root, outDir)}/SUMMARY.md explaining each change and why,
with a short before/after for the key edits. Write ONLY inside ${path.relative(ctx.root, outDir)}/.`;

  info(`Reflecting on run ${runId} with ${role.model}…`);
  await runSession({
    role: "reflector",
    prompt: task,
    systemPrompt: system,
    model: role.model,
    effort: role.effort,
    cwd: ctx.root,
    tools: ["Read", "Glob", "Grep", "Write"],
    ...scopedWriterGuard(ctx, [outDir]),
    maxTurns: ctx.config.build.maxTurnsPerSession,
    traceDir: path.join(outDir, "trace"),
    traceSeq: 1,
  });

  const candidates = fs.existsSync(candidatesDir) ? fs.readdirSync(candidatesDir).filter((f) => f.endsWith(".md")) : [];
  if (candidates.length === 0) {
    warn("Reflector proposed no prompt changes.");
    return;
  }

  ok(`Proposed changes to ${candidates.length} prompt(s):`);
  for (const f of candidates) {
    const role = f.replace(/\.md$/, "");
    process.stdout.write(`\n${color.bold("── " + role + " ──")}\n`);
    showDiff(ctx.paths.promptFile(role), path.join(candidatesDir, f));
  }
  const summary = path.join(outDir, "SUMMARY.md");
  if (exists(summary)) info(`Rationale: ${path.relative(ctx.root, summary)}`);
  info(`Apply with: ${color.bold("sparra reflect --apply")}  (backs up current prompts first)`);
}

/** Apply the most recent reflection's candidate prompts, backing up the current ones. */
async function applyReflection(ctx: Ctx): Promise<void> {
  banner("REFLECT · APPLY");
  const dirs = listReflectDirs(ctx.paths.reflect).filter((d) => exists(path.join(d, "candidates")));
  const latest = dirs[dirs.length - 1];
  if (!latest) {
    warn("No reflection proposals to apply. Run `sparra reflect` first.");
    return;
  }
  const candidatesDir = path.join(latest, "candidates");
  const backupDir = path.join(latest, "backup");
  await ensureDir(backupDir);
  const candidates = fs.readdirSync(candidatesDir).filter((f) => f.endsWith(".md"));
  let applied = 0;
  for (const f of candidates) {
    const role = f.replace(/\.md$/, "");
    const live = ctx.paths.promptFile(role);
    const cur = exists(live) ? fs.readFileSync(live, "utf8") : "";
    await writeText(path.join(backupDir, f), cur);
    await writeText(live, fs.readFileSync(path.join(candidatesDir, f), "utf8"));
    detail(`applied ${role} (backup in ${path.relative(ctx.root, backupDir)})`);
    applied++;
  }
  ok(`Applied ${applied} prompt update(s) from ${path.relative(ctx.root, latest)}.`);
}
