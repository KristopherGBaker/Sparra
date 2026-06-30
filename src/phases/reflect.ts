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
import { ensureDir, exists, moveFile, readText, writeText } from "../util/io.ts";
import { loadInbox, triageUpstream } from "./upstreamTriage.ts";
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

/** Parse a comma-separated index list into numbers; throws (atomically, before any I/O) on bad input. */
function parseIds(raw: string | boolean | undefined, flag: string): number[] {
  if (raw === undefined) return [];
  if (raw === true || (typeof raw === "string" && raw.trim() === "")) {
    throw new Error(`${flag} requires comma-separated indices (e.g. ${flag} 1,3)`);
  }
  return (raw as string).split(",").map((s) => {
    const t = s.trim();
    if (!/^\d+$/.test(t)) throw new Error(`invalid index "${t}" for ${flag} (use comma-separated positive integers)`);
    return Number(t);
  });
}

/**
 * List (with per-finding global indices), triage, or archive the accumulated harness-level reflections.
 * Runs NO model session. Triage (`done`/`wontdo`) splices the marked findings into `archive/`; `clear`
 * (with no triage flags) archives ALL files; otherwise it just lists.
 */
async function showUpstream(opts: {
  clear?: boolean;
  done?: string | boolean;
  wontdo?: string | boolean;
  reason?: string;
  now?: () => Date;
}): Promise<void> {
  banner("REFLECT · UPSTREAM");
  const dir = upstreamInboxDir();
  const triaging = opts.done !== undefined || opts.wontdo !== undefined;

  if (triaging) {
    const done = parseIds(opts.done, "--done");
    const wontdo = parseIds(opts.wontdo, "--wontdo");
    const res = await triageUpstream({ dir, done, wontdo, reason: opts.reason, now: opts.now });
    const archive = path.relative(sparraHome(), path.join(dir, "archive"));
    for (const a of res.archived) ok(`#${a.globalIndex} ${a.disposition} — "${a.title}" → ${archive}/${a.file}`);
    for (const f of res.filesMovedWhole) detail(`${f} had no findings left — moved out of the inbox`);
    return;
  }

  const { files, findings } = await loadInbox(dir);
  if (files.length === 0) {
    warn(`(empty inbox) no harness-level reflections in ${dir}.`);
    return;
  }
  ok(`${files.length} reflection file(s), ${findings.length} finding(s) in ${dir}:`);
  for (const file of files) {
    process.stdout.write(`\n${color.bold("── " + file.file + " ──")}\n`);
    for (const f of findings.filter((x) => x.file === file.file)) {
      process.stdout.write(`${color.bold(`  [${f.globalIndex}] ${f.title}`)}\n`);
      process.stdout.write(f.text + "\n");
    }
  }
  if (opts.clear) {
    const archive = path.join(dir, "archive");
    const names = files.map((f) => f.file);
    for (const f of names) await moveFile(path.join(dir, f), path.join(archive, f));
    ok(`archived ${names.length} reflection(s) → ${path.relative(sparraHome(), archive)}`);
  } else {
    info(
      `Triage with ${color.bold("sparra reflect --upstream --done <ids>")} / ${color.bold("--wontdo <ids> [--reason …]")}, ` +
        `or ${color.bold("--clear")} to archive all.`
    );
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
    done?: string | boolean;
    wontdo?: string | boolean;
    reason?: string;
    now?: () => Date;
    runSessionFn?: (p: RunSessionParams) => Promise<RunResult>;
  } = {}
): Promise<void> {
  if (opts.upstream)
    return showUpstream({ clear: opts.clear, done: opts.done, wontdo: opts.wontdo, reason: opts.reason, now: opts.now });
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

If any finding is about the Sparra HARNESS itself (a config knob, a guard/holdout gap, a phase/role bug, a backend limit) rather than THIS project's prompts, do NOT make it a prompt edit — write EACH such finding as its own \`### <short title>\` section (with its rationale) in ${path.relative(ctx.root, outDir)}/upstream.md (a portable note routed to a shared inbox for the Sparra repo, where each section is triaged separately). Omit the file if there are no harness-level findings.

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
