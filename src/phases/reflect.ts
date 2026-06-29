import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Ctx } from "../context.ts";
import { newRunId } from "../context.ts";
import { loadPrompt } from "../prompts.ts";
import { runSession, type RunResult, type RunSessionParams } from "../sdk/session.ts";
import { scopedWriterGuard, ensureAutoProbed } from "../sdk/guard.ts";
import { banner, color, detail, info, ok, warn } from "../util/log.ts";
import { ensureDir, exists, moveFile, readDir, readText, writeText } from "../util/io.ts";
import { appendLearning } from "../memory.ts";

/** The user-level Sparra home (cross-project), overridable via SPARRA_HOME (mirrors SPARRA_DEBUG). */
export function sparraHome(): string {
  return process.env.SPARRA_HOME || path.join(os.homedir(), ".sparra");
}

/** The shared, cross-project inbox where harness-level reflect findings accumulate for the Sparra repo. */
export function upstreamInboxDir(): string {
  return path.join(sparraHome(), "reflections");
}

/**
 * Drop ONE harness-level reflection into the user-level inbox as a NEW, uniquely-named file. The name
 * carries a non-time random token (randomUUID) so two routings with an identical stamp NEVER collide —
 * this is the concurrency-safe alternative to appending to a shared file (no cross-process lock needed).
 * Returns the written path.
 */
export async function routeUpstreamFinding(project: string, stamp: string, content: string): Promise<string> {
  const dir = upstreamInboxDir();
  await ensureDir(dir);
  const file = path.join(dir, `${project}-${stamp}-${randomUUID().slice(0, 8)}.md`);
  await writeText(file, content);
  return file;
}

/** Print (and optionally archive) the accumulated harness-level reflections — runs NO model session. */
async function showUpstream(clear: boolean): Promise<void> {
  banner("REFLECT · UPSTREAM");
  const dir = upstreamInboxDir();
  const files = readDir(dir).filter((f) => f.endsWith(".md")).sort();
  if (files.length === 0) {
    warn(`(empty inbox) no harness-level reflections in ${dir}.`);
    return;
  }
  ok(`${files.length} harness-level reflection(s) in ${dir}:`);
  for (const f of files) {
    process.stdout.write(`\n${color.bold("── " + f + " ──")}\n`);
    process.stdout.write(((await readText(path.join(dir, f))) ?? "") + "\n");
  }
  if (clear) {
    const archive = path.join(dir, "archive");
    for (const f of files) await moveFile(path.join(dir, f), path.join(archive, f));
    ok(`archived ${files.length} reflection(s) → ${path.relative(sparraHome(), archive)}`);
  } else {
    info(`Fold these into the Sparra repo, then ${color.bold("sparra reflect --upstream --clear")} to archive.`);
  }
}

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
export async function cmdReflect(
  ctx: Ctx,
  opts: {
    apply?: boolean;
    run?: string;
    upstream?: boolean;
    clear?: boolean;
    runSessionFn?: (p: RunSessionParams) => Promise<RunResult>;
  } = {}
): Promise<void> {
  if (opts.upstream) return showUpstream(!!opts.clear);
  if (opts.apply) return applyReflection(ctx);
  const run = opts.runSessionFn ?? runSession;

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
with a short before/after for the key edits.

If any finding is about the Sparra HARNESS itself (a config knob, a guard/holdout gap, a phase/role bug, a backend limit) rather than THIS project's prompts, do NOT make it a prompt edit — list it with its rationale in ${path.relative(ctx.root, outDir)}/upstream.md (a portable note that gets routed to a shared inbox for the Sparra repo). Omit the file if there are no harness-level findings.

Write ONLY inside ${path.relative(ctx.root, outDir)}/.`;

  info(`Reflecting on run ${runId} with ${role.model}…`);
  await run({
    role: "reflector",
    prompt: task,
    systemPrompt: system,
    backend: role.backend,
    model: role.model,
    effort: role.effort,
    cwd: ctx.root,
    tools: ["Read", "Glob", "Grep", "Write"],
    ...scopedWriterGuard(ctx, [outDir]),
    maxTurns: ctx.config.build.maxTurnsPerSession,
    traceDir: path.join(outDir, "trace"),
    traceSeq: 1,
  });

  // Route any harness-level findings to the shared user-level inbox BEFORE the candidates check, so a
  // harness-only reflection (no prompt edits) still carries upstream.
  const upstreamFile = path.join(outDir, "upstream.md");
  if (exists(upstreamFile)) {
    const content = (await readText(upstreamFile)) ?? "";
    if (content.trim()) {
      const dest = await routeUpstreamFinding(path.basename(ctx.root), stamp, content);
      ok(`Harness-level findings → ${dest}`);
      info(`Triage them in the Sparra repo with ${color.bold("sparra reflect --upstream")}.`);
    }
  }

  const candidates = fs.existsSync(candidatesDir) ? fs.readdirSync(candidatesDir).filter((f) => f.endsWith(".md")) : [];
  if (candidates.length === 0) {
    warn("Reflector proposed no prompt changes.");
    return;
  }

  ok(`Proposed changes to ${candidates.length} prompt(s):`);
  await appendLearning(ctx.paths, {
    item: "reflect",
    kind: "note",
    detail: `reflection on run ${runId} proposed prompt edits to: ${candidates.map((f) => f.replace(/\.md$/, "")).join(", ")}.`,
    at: new Date().toISOString(),
  });
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
export async function applyReflection(ctx: Ctx): Promise<void> {
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
