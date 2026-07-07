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
import { banner, color, detail, info, ok, raw, warn } from "../util/log.ts";
import { ensureDir, exists, moveFile, readText, writeText } from "../util/io.ts";
import { loadInbox, triageUpstream, parseInbox, incrementFinding, type InboxFinding } from "./upstreamTriage.ts";
import { appendLearning } from "../memory.ts";
import { readHoldout, redactHoldout } from "../build/holdout.ts";

/** The user-level Sparra home (cross-project), overridable via SPARRA_HOME (mirrors SPARRA_DEBUG). */
export function sparraHome(): string {
  return process.env.SPARRA_HOME || path.join(os.homedir(), ".sparra");
}

/** The shared, cross-project inbox where harness-level reflect findings accumulate for the Sparra repo. */
export function upstreamInboxDir(): string {
  return path.join(sparraHome(), "reflections");
}

/** One-line summary of a finding for prompt injection (first meaningful body line, max 80 chars). */
function extractGist(text: string): string {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || /^#{1,6}/.test(t) || t.startsWith("<!-- sparra-")) continue;
    return t.length > 80 ? t.slice(0, 77) + "..." : t;
  }
  return "";
}

/**
 * Route harness-level findings from a reflector's `upstream.md` into the shared user-level inbox.
 *
 * Recurrence-aware: each `### section` in `content` is checked for a `RECURRENCE-OF: <title>` line.
 * A matching LIVE inbox finding (trim+case-normalized; `archive/` excluded) gets its recurrence
 * counter bumped in place — no duplicate file is written. Unmatched or genuinely-new findings are
 * collected and written as a single new, uniquely-named file (recurrence 1). A run that produces
 * ONLY recurrences adds NO new inbox file — returns null. Fail-safe: an unmatched `RECURRENCE-OF`
 * tag is treated as a NEW finding (never silently dropped).
 *
 * Collision-safe: two concurrent new-finding routings with the same stamp still produce distinct
 * files via a non-time randomUUID token (no cross-process lock needed).
 */
export async function routeUpstreamFinding(project: string, stamp: string, content: string): Promise<string | null> {
  const dir = upstreamInboxDir();
  await ensureDir(dir);

  // Load the LIVE inbox (archive/ excluded) for recurrence matching.
  const { findings: liveFindings } = await loadInbox(dir);
  const normalize = (s: string) => s.trim().toLowerCase();
  // First match wins for duplicate live titles.
  const liveByTitle = new Map<string, InboxFinding>();
  for (const f of liveFindings) {
    const key = normalize(f.title);
    if (!liveByTitle.has(key)) liveByTitle.set(key, f);
  }

  // Parse the content into finding segments.
  const segments = parseInbox(content);

  // newParts collects text segments + new finding segments for the output file.
  // Recurrence findings are excluded (counter bumped in place; no duplicate written).
  const newParts: string[] = [];
  let hasNewFinding = false;
  const incrementTargets: InboxFinding[] = [];

  for (const seg of segments) {
    if (seg.kind === "text") {
      // Keep preamble/non-finding text so holdout-redacted context survives the route.
      newParts.push(seg.text);
      continue;
    }
    const recurrenceMatch = /^RECURRENCE-OF:\s*(.+)$/m.exec(seg.text);
    if (recurrenceMatch) {
      const claimedKey = normalize(recurrenceMatch[1]!);
      const match = liveByTitle.get(claimedKey);
      if (match) {
        incrementTargets.push(match);
        continue; // matched → increment existing finding, do not emit a new one
      }
      // Unmatched RECURRENCE-OF → fail-safe to NEW
    }
    newParts.push(seg.text);
    hasNewFinding = true;
  }

  // Apply increments: group by file, apply sequentially to an in-memory string.
  if (incrementTargets.length > 0) {
    const byFile = new Map<string, InboxFinding[]>();
    for (const t of incrementTargets) {
      const list = byFile.get(t.file) ?? [];
      list.push(t);
      byFile.set(t.file, list);
    }
    for (const [file, targets] of byFile) {
      const filePath = path.join(dir, file);
      let fileContent = (await readText(filePath)) ?? "";
      for (const t of targets) {
        fileContent = incrementFinding(fileContent, t.segIndex);
      }
      await writeText(filePath, fileContent);
    }
  }

  // Write new findings (if any) as a single uniquely-named file.
  // If ALL findings were recurrences (only text segments remain), skip the new file.
  if (!hasNewFinding) return null;
  const newContent = newParts.join("\n");
  const file = path.join(dir, `${project}-${stamp}-${randomUUID().slice(0, 8)}.md`);
  await writeText(file, newContent);
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
  ok(`${files.length} reflection file(s), ${findings.length} finding(s) in ${dir} (ranked by recurrence):`);
  // Findings are already in recurrence-DESC order from loadInbox; globalIndex matches the display rank.
  for (const f of findings) {
    process.stdout.write(`\n${color.bold(`  [${f.globalIndex}] ×${f.recurrence} ${f.title}`)}\n`);
    process.stdout.write(f.text + "\n");
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

function listRoleRunTraceDirs(tracesRoot: string): string[] {
  try {
    return fs
      .readdirSync(tracesRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^role-run-/.test(e.name))
      .map((e) => path.join(tracesRoot, e.name))
      .sort();
  } catch {
    return [];
  }
}

function newestReflectMtime(reflectRoot: string): number | null {
  const mtimes = listReflectDirs(reflectRoot)
    .filter((d) => /^reflect-/.test(path.basename(d)))
    .map((d) => {
      try {
        return fs.statSync(d).mtimeMs;
      } catch {
        return 0;
      }
    })
    .filter((m) => m > 0);
  return mtimes.length ? Math.max(...mtimes) : null;
}

function hasGlobMagic(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}

function globToRegex(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(out + "$");
}

function globSearchRoot(absPattern: string): string {
  const idx = absPattern.search(/[*?[\]{}]/);
  if (idx < 0) return path.dirname(absPattern);
  const prefix = absPattern.slice(0, idx);
  const slash = prefix.lastIndexOf(path.sep);
  return slash <= 0 ? path.parse(absPattern).root : prefix.slice(0, slash);
}

function walkDirs(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      out.push(p);
      visit(p);
    }
  };
  visit(root);
  return out;
}

function resolveTracePattern(ctx: Ctx, raw: string): string[] {
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(ctx.root, raw);
  if (!hasGlobMagic(raw)) {
    try {
      return fs.statSync(abs).isDirectory() ? [abs] : [];
    } catch {
      return [];
    }
  }
  const root = globSearchRoot(abs);
  const rx = globToRegex(abs.split(path.sep).join("/"));
  return walkDirs(root)
    .filter((d) => rx.test(d.split(path.sep).join("/")))
    .sort();
}

function isEvaluatorRoleRunTrace(dir: string): boolean {
  return /^role-run-evaluator-/.test(path.basename(dir));
}

function nonEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((name) => !name.startsWith("."));
  } catch {
    return false;
  }
}

function denyTraceReadDecider(cwd: string, traceRoot: string): (tool: string, input: unknown) => string | null {
  const root = path.resolve(traceRoot);
  const within = (child: string, parent: string) => {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  const resolve = (p: string) => (path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p));
  const deny = "Raw role-run traces may contain evaluator-only holdout content; read the sanitized reflect bundle instead.";
  return (tool, input) => {
    const i = input as { file_path?: string; path?: string; pattern?: string; command?: string } | undefined;
    if (tool === "Read") {
      const target = i?.file_path ?? i?.path;
      if (target && within(resolve(target), root)) return deny;
    }
    if (tool === "Glob" || tool === "Grep") {
      const target = i?.path ?? i?.file_path;
      if (target && within(resolve(target), root)) return deny;
      if ((i?.pattern ?? "").includes(path.basename(root))) return deny;
    }
    if (tool === "Bash" && (i?.command ?? "").includes(root)) return deny;
    return null;
  };
}

interface RoleRunBundle {
  inputDir: string;
  included: string[];
  excluded: string[];
}

async function createRoleRunBundle(inputDir: string, selectedDirs: string[]): Promise<RoleRunBundle> {
  await ensureDir(inputDir);
  const included: string[] = [];
  const excluded: string[] = [];
  let index = "# Sanitized role-run trace bundle\n\n";
  for (const dir of selectedDirs) {
    const base = path.basename(dir);
    if (isEvaluatorRoleRunTrace(dir)) {
      excluded.push(dir);
      index += `- ${base}: EXCLUDED (evaluator trace; holdout-bearing)\n`;
      continue;
    }
    included.push(dir);
    index += `- ${base}: included\n`;
    const dstDir = path.join(inputDir, base);
    await ensureDir(dstDir);
    const files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort();
    for (const name of files) fs.copyFileSync(path.join(dir, name), path.join(dstDir, name));
  }
  await writeText(path.join(inputDir, "INDEX.md"), index);
  return { inputDir, included, excluded };
}

// Exported narrowly for test: reflect diff output is silence-gated like the rest of the phase
// logger — it flows through log.raw() (VITEST + SPARRA_LOG_IN_TESTS) so it stays out of `npm test`.
export function showDiff(current: string, candidate: string): void {
  const r = spawnSync("diff", ["-u", current, candidate], { encoding: "utf8" });
  if (r.status === 0) {
    detail("(no change)");
    return;
  }
  raw((r.stdout || "") + "\n");
}

/** Propose prompt improvements from the last run's traces (does NOT apply them). */
export async function cmdReflect(
  ctx: Ctx,
  opts: {
    apply?: boolean;
    run?: string;
    traces?: string;
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

  const explicitTraceDirs = typeof opts.traces === "string" ? resolveTracePattern(ctx, opts.traces) : null;
  if (explicitTraceDirs && explicitTraceDirs.length === 0) {
    warn(`No traces matched --traces pattern: ${opts.traces}.`);
    return;
  }

  const runId = opts.run ?? ctx.store.data.build.runId;
  let traceDir: string | null = null;
  let roleRunTraceDirs: string[] | null = null;
  let sourceLabel = "";
  if (explicitTraceDirs) {
    roleRunTraceDirs = explicitTraceDirs;
    sourceLabel = `selected role-run traces from --traces ${opts.traces}`;
  } else if (runId) {
    traceDir = ctx.paths.traceDir(runId);
    if (!exists(traceDir)) {
      warn(`No traces at ${path.relative(ctx.root, traceDir)}.`);
      return;
    }
    sourceLabel = `run ${runId}`;
  } else {
    const all = listRoleRunTraceDirs(ctx.paths.traces);
    if (all.length === 0) {
      warn("No build run or role-run traces found to reflect on. Run `sparra build`, create `.sparra/traces/role-run-*` traces, or pass --traces <glob-or-dir>.");
      return;
    }
    const cutoff = newestReflectMtime(ctx.paths.reflect);
    roleRunTraceDirs = cutoff == null ? all : all.filter((d) => fs.statSync(d).mtimeMs > cutoff);
    if (roleRunTraceDirs.length === 0) {
      warn("No role-run traces newer than the last reflect output. Pass --traces <glob-or-dir> to override the session window.");
      return;
    }
    sourceLabel = "role-run traces since the last reflect";
  }

  if (roleRunTraceDirs) {
    const excluded = roleRunTraceDirs.filter(isEvaluatorRoleRunTrace);
    for (const dir of excluded) warn(`Excluded evaluator trace from reflection input: ${path.basename(dir)}`);
    if (excluded.length === roleRunTraceDirs.length) {
      // Every selected trace is an evaluator trace (holdout-bearing → excluded). Only bail if there
      // is ALSO no persisted verdict to reflect on: the auto-persisted verdicts are redacted (safe)
      // and ARE evaluator-side evidence (scores, failed assertions, blocking), so a run that produced
      // only evaluator traces + verdicts still has something to reflect on — proceed and bundle them.
      if (!nonEmptyDir(ctx.paths.verdicts)) {
        warn("Only evaluator role-run traces were selected; they are holdout-bearing and excluded. No safe trace bodies remain to reflect on.");
        return;
      }
      info("Only evaluator role-run traces were selected (holdout-bearing, excluded); reflecting on the persisted redacted verdicts instead.");
    }
  }

  const stamp = newRunId("reflect");
  const outDir = path.join(ctx.paths.reflect, stamp);
  const candidatesDir = path.join(outDir, "candidates");
  await ensureDir(candidatesDir);

  await ensureAutoProbed(ctx);
  const role = ctx.config.roles.reflector;
  const system = await loadPrompt(ctx.paths, "reflector");

  let roleRunBundle: RoleRunBundle | null = null;
  if (roleRunTraceDirs) {
    roleRunBundle = await createRoleRunBundle(path.join(outDir, "input"), roleRunTraceDirs);
  }

  const buildReadLines = traceDir
    ? [
        `- Traces from this run: ${path.relative(ctx.root, traceDir)}/ (every agent's full transcript)`,
        `- Verdicts: ${path.relative(ctx.root, ctx.paths.verdicts)}/`,
        `- Contracts: ${path.relative(ctx.root, ctx.paths.contracts)}/`,
        `- Measure reports (post-accept metrics vs. baseline — regressions a code-reading evaluator can't see): ${path.relative(ctx.root, ctx.paths.measure)}/`,
      ]
    : [
        `- Sanitized role-run trace bundle: ${path.relative(ctx.root, roleRunBundle!.inputDir)}/ (non-evaluator trace bodies only; evaluator traces are excluded before reflection)`,
        ...(nonEmptyDir(ctx.paths.verdicts) ? [`- Verdicts, when produced by the interactive run: ${path.relative(ctx.root, ctx.paths.verdicts)}/`] : []),
        ...(nonEmptyDir(ctx.paths.contracts) ? [`- Contracts, when produced by the interactive run: ${path.relative(ctx.root, ctx.paths.contracts)}/`] : []),
        ...(nonEmptyDir(ctx.paths.measure) ? [`- Measure reports: ${path.relative(ctx.root, ctx.paths.measure)}/`] : []),
      ];

  // Inject the live inbox findings for recurrence tagging (only when non-empty).
  const { findings: liveInboxFindings } = await loadInbox(upstreamInboxDir());
  let inboxBlock = "";
  if (liveInboxFindings.length > 0) {
    const list = liveInboxFindings
      .map((f) => `  - "${f.title}": ${extractGist(f.text)}`)
      .join("\n");
    inboxBlock = `\nCURRENT HARNESS INBOX (existing live findings ×recurrence — avoid re-describing, tag recurrences instead):
${list}

For each finding you write to upstream.md: if it re-observes an existing inbox finding above, add a line \`RECURRENCE-OF: <exact title>\` in that \`### section\` (case- and whitespace-exact). An unmatched title is treated as a new finding — never dropped. Only report a harness finding when it materially changed this run's outcome (a bounce, a wasted/whipsaw round, a wrong grade, burned turns, a forced override) — skip speculation.`;
  }

  const task = `Reflect on ${traceDir ? "the last build run" : "the selected interactive role-run traces"} to improve the role prompts.

READ:
${buildReadLines.join("\n")}
- Current role prompts: ${path.relative(ctx.root, ctx.paths.prompts)}/

Find where the EVALUATOR was too lenient/harsh or diverged from the rubric, where CONTRACTS were too weak, or where calibration drifted.

For EACH prompt you would change, WRITE the full improved prompt to:
  ${path.relative(ctx.root, candidatesDir)}/<role>.md
(use the same role filename as in prompts/, e.g. evaluator.md). Preserve all {{PLACEHOLDERS}}.

Also WRITE ${path.relative(ctx.root, outDir)}/SUMMARY.md explaining each change and why,
with a short before/after for the key edits.

If any finding is about the Sparra HARNESS itself (a config knob, a guard/holdout gap, a phase/role bug, a backend limit) rather than THIS project's prompts, do NOT make it a prompt edit — write EACH such finding as its own \`### <short title>\` section (with its rationale) in ${path.relative(ctx.root, outDir)}/upstream.md (a portable note routed to a shared inbox for the Sparra repo, where each section is triaged separately). Omit the file if there are no harness-level findings.${inboxBlock}

Write ONLY inside ${path.relative(ctx.root, outDir)}/.`;

  info(`Reflecting on ${sourceLabel} with ${role.model}…`);
  const guard =
    roleRunBundle == null
      ? scopedWriterGuard(ctx, [outDir])
      : scopedWriterGuard(ctx, [outDir], {
          readScopes: [
            outDir,
            ctx.paths.prompts,
            ...(nonEmptyDir(ctx.paths.verdicts) ? [ctx.paths.verdicts] : []),
            ...(nonEmptyDir(ctx.paths.contracts) ? [ctx.paths.contracts] : []),
            ...(nonEmptyDir(ctx.paths.measure) ? [ctx.paths.measure] : []),
          ],
          extraDeny: [denyTraceReadDecider(ctx.root, ctx.paths.traces)],
        });
  await run({
    role: "reflector",
    prompt: task,
    systemPrompt: system,
    backend: role.backend,
    model: role.model,
    effort: role.effort,
    cwd: ctx.root,
    tools: ["Read", "Glob", "Grep", "Write"],
    ...guard,
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
      const dest = await routeUpstreamFinding(path.basename(ctx.root), stamp, redactHoldout(content, await readHoldout(ctx)));
      if (dest) {
        ok(`Harness-level findings → ${dest}`);
        info(`Triage them in the Sparra repo with ${color.bold("sparra reflect --upstream")}.`);
      } else {
        ok(`Harness-level findings → all matched existing inbox entries (recurrence counters updated).`);
      }
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
    detail: `reflection on ${runId ?? "role-run traces"} proposed prompt edits to: ${candidates.map((f) => f.replace(/\.md$/, "")).join(", ")}.`,
    at: new Date().toISOString(),
  });
  for (const f of candidates) {
    const role = f.replace(/\.md$/, "");
    raw(`\n${color.bold("── " + role + " ──")}\n`);
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
