import path from "node:path";

import { autoProbeCtx, type Ctx } from "../context.ts";
import { banner, detail, err, info, ok, raw } from "../util/log.ts";
import { exists, readDir, readTextSync } from "../util/io.ts";
import {
  runConduct,
  resumeConduct,
  type ConductDeps,
  type ConductOptions,
  type ConductResult,
  type ResumeConductOptions,
  type ResumeConductResult,
} from "../conduct/run.ts";
import { conductRunDir, isDirectRunFile, isSafeRunId, runStatePath, safeConductRunDir } from "../conduct/runState.ts";
import { requestExists, writeDecisionAnswer } from "../conduct/decisionEngine.ts";
import { projectPendingDecisions } from "../conduct/pending.ts";
import type { ConductRunState, UnitStateEntry } from "../conduct/types.ts";

/**
 * `sparra conduct "<prompt>"` — the headless conductor: from ONE prompt, decompose into 1..N units
 * and per unit negotiate a contract → generate → cross-model evaluate → decide, all through the
 * existing isolated role-run machinery (`conductors/core`). Two brain modes: `hybrid` (deterministic
 * loop + an LLM conductor consulted at the five judgment points) and `llm` (the brain drives
 * turn-by-turn); a decision engine surfaces important decisions to a human (park / park-timeout /
 * auto) via file + TTY channels, answerable from another terminal with `conduct --decide`. Nothing
 * lands on the user's branch — units generate on their own worktrees.
 */

const DEFAULT_MAX_UNITS = 4;
const DEFAULT_CONCURRENCY = 2;

type Flags = Record<string, string | boolean | string[]>;

/** Parsed, validated conduct invocation, or a rejection message. PURE — no I/O, so a malformed
 *  request is rejected with ZERO side effects (no run dir, no role spend). */
export type ParseConductResult =
  | { ok: true; opts: ConductOptions }
  | { ok: false; error: string };

/**
 * Validate the prompt + flags into {@link ConductOptions}. Strict: `--max-units`/`--concurrency`/
 * `--max-turns` must be POSITIVE INTEGERS (a missing value, non-numeric, or non-positive is
 * rejected, each naming the offending flag); `--budget` must be a non-negative number (`0` accepted
 * = unlimited, per the role-run convention; negative/non-numeric/missing-value rejected).
 */
export function parseConductFlags(prompt: string, flags: Flags): ParseConductResult {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return { ok: false, error: 'conduct: a prompt is required — usage: sparra conduct "<prompt>"' };
  }

  const maxUnits = parsePositiveInt(flags["max-units"], "max-units", DEFAULT_MAX_UNITS);
  if (typeof maxUnits === "string") return { ok: false, error: maxUnits };

  const concurrency = parsePositiveInt(flags["concurrency"], "concurrency", DEFAULT_CONCURRENCY);
  if (typeof concurrency === "string") return { ok: false, error: concurrency };

  const maxTurns = parseOptionalPositiveInt(flags["max-turns"], "max-turns");
  if (typeof maxTurns === "string") return { ok: false, error: maxTurns };

  const budget = parseOptionalBudget(flags["budget"]);
  if (typeof budget === "string") return { ok: false, error: budget };

  const brain = parseBrain(flags["brain"]);
  if (typeof brain === "string" && brain !== "hybrid" && brain !== "llm") {
    return { ok: false, error: brain };
  }

  // `--merge` implies `--commit` (merge integrates the branches it first commits).
  const merge = flags["merge"] === true;
  const commit = merge || flags["commit"] === true;

  const opts: ConductOptions = {
    prompt: trimmed,
    maxUnits,
    concurrency,
    dryRun: flags["dry-run"] === true,
  };
  if (maxTurns !== undefined) opts.maxTurns = maxTurns;
  if (budget !== undefined) opts.budget = budget;
  if (brain === "hybrid" || brain === "llm") opts.brain = brain;
  // `--auto` forces the never-park surface for this run.
  if (flags["auto"] === true) opts.surface = "auto";
  if (commit) opts.commit = true;
  if (merge) opts.merge = true;
  return { ok: true, opts };
}

/** Validate `--brain`: `undefined` when absent, `"hybrid"`/`"llm"` when valid, an error string when
 *  present-but-invalid (missing value / unknown mode). */
function parseBrain(v: Flags[string] | undefined): "hybrid" | "llm" | undefined | string {
  if (v === undefined) return undefined;
  if (v !== "hybrid" && v !== "llm") {
    return `conduct: --brain must be "hybrid" or "llm" (got "${typeof v === "string" ? v : ""}")`;
  }
  return v;
}

/** Required positive-integer flag with a default when absent. Returns the number, or an error string. */
function parsePositiveInt(v: Flags[string] | undefined, name: string, def: number): number | string {
  if (v === undefined) return def;
  const parsed = parseOptionalPositiveInt(v, name);
  if (typeof parsed === "string") return parsed;
  // `parsed` is a number here (never undefined — `v` is defined).
  return parsed as number;
}

/** Optional positive-integer flag: `undefined` when absent, the number when valid, an error string
 *  when present-but-invalid (missing value / non-numeric / non-positive). */
function parseOptionalPositiveInt(v: Flags[string] | undefined, name: string): number | undefined | string {
  if (v === undefined) return undefined;
  if (typeof v !== "string") return `conduct: --${name} requires a positive integer value`;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    return `conduct: --${name} must be a positive integer (got "${v}")`;
  }
  return n;
}

/** Optional `--budget`: `undefined` when absent, a non-negative number when valid (`0` = unlimited),
 *  an error string when present-but-invalid (missing value / non-numeric / negative). */
function parseOptionalBudget(v: Flags[string] | undefined): number | undefined | string {
  if (v === undefined) return undefined;
  if (typeof v !== "string") return "conduct: --budget requires a numeric value (USD; 0 = unlimited)";
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    return `conduct: --budget must be a non-negative number (got "${v}"); 0 = unlimited`;
  }
  return n;
}

/** Injectable seams for `cmdConduct` (tests inject fakes so validation is exercised with no spend). */
export interface CmdConductDeps extends ConductDeps {
  runConductFn?: (ctx: Ctx, opts: ConductOptions, deps: ConductDeps) => Promise<ConductResult>;
  resumeConductFn?: (
    ctx: Ctx,
    runId: string,
    opts: ResumeConductOptions,
    deps: ConductDeps,
  ) => Promise<ResumeConductResult>;
  autoProbe?: typeof autoProbeCtx;
}

/** Project the injectable seams down to the `ConductDeps` the conductor / resume paths consume. */
function toConductDeps(deps: CmdConductDeps): ConductDeps {
  return {
    ...(deps.runRole ? { runRole: deps.runRole } : {}),
    ...(deps.runSessionFn ? { runSessionFn: deps.runSessionFn } : {}),
    ...(deps.strategy ? { strategy: deps.strategy } : {}),
    ...(deps.sparraBin ? { sparraBin: deps.sparraBin } : {}),
    ...(deps.brain !== undefined ? { brain: deps.brain } : {}),
    ...(deps.brainSessionFn ? { brainSessionFn: deps.brainSessionFn } : {}),
    ...(deps.tty ? { tty: deps.tty } : {}),
    ...(deps.ensureUnitWorktreeFn ? { ensureUnitWorktreeFn: deps.ensureUnitWorktreeFn } : {}),
    ...(deps.landingGit ? { landingGit: deps.landingGit } : {}),
    ...(deps.commitGit ? { commitGit: deps.commitGit } : {}),
  };
}

/**
 * The `sparra conduct` command. Validates FIRST (a bad flag aborts with zero side effects — no run
 * dir, no auto-permission probe, no role spend), THEN probes permissions and runs the conductor.
 */
export async function cmdConduct(
  ctx: Ctx,
  prompt: string,
  flags: Flags,
  deps: CmdConductDeps = {},
): Promise<ConductResult | undefined> {
  banner("sparra conduct");
  const parsed = parseConductFlags(prompt, flags);
  if (!parsed.ok) {
    err(parsed.error);
    process.exitCode = 1;
    return undefined;
  }

  // Probe permissions only AFTER validation succeeds (mirrors `role run` — a rejected request spends
  // zero model tokens; the probe is a live SDK query).
  await (deps.autoProbe ?? autoProbeCtx)(ctx);

  // Apply config defaults for the brain mode + decision surface (a run always has a brain mode —
  // `hybrid` by default; the flag/config selects it).
  if (parsed.opts.brain === undefined) parsed.opts.brain = ctx.config.conduct.brain;
  if (parsed.opts.surface === undefined) parsed.opts.surface = ctx.config.conduct.decisions.surface;
  if (parsed.opts.timeoutSec === undefined) parsed.opts.timeoutSec = ctx.config.conduct.decisions.timeoutSec;

  const runConductFn = deps.runConductFn ?? runConduct;
  const conductDeps = toConductDeps(deps);

  info(
    `prompt="${parsed.opts.prompt.slice(0, 80)}${parsed.opts.prompt.length > 80 ? "…" : ""}" ` +
      `max-units=${parsed.opts.maxUnits} concurrency=${parsed.opts.concurrency} ` +
      `brain=${parsed.opts.brain} decisions=${parsed.opts.surface}` +
      (parsed.opts.merge ? " merge" : parsed.opts.commit ? " commit" : "") +
      (parsed.opts.dryRun ? " (dry-run)" : ""),
  );
  const result = await runConductFn(ctx, parsed.opts, conductDeps);
  detail(`run: ${result.runId} → ${result.runDir}`);
  for (const u of result.state.units) {
    detail(
      `  ${u.id} [${u.outcome}]` +
        (u.score !== undefined ? ` score=${u.score}` : "") +
        (u.branch ? ` branch=${u.branch}` : "") +
        (u.worktree ? ` worktree=${u.worktree}` : ""),
    );
  }
  return result;
}

/**
 * `sparra conduct --resume <runId> [--commit|--merge] [--auto]` — reload a persisted run's `run.json`
 * and CONTINUE it in place: accepted/dry-run units are skipped, pending/running/error units re-enter
 * at the correct stage (an agreed/forced contract → straight to generate; else renegotiate from the
 * persisted brief), worktrees are reused-or-recreated by stable name, and the SAME run.json is
 * appended to (monotonic decision seq + a per-resume `resumedAt`). A missing runId → usage error; an
 * unknown runId → exit 1 naming it with ZERO side effects (no run dir, no auto-permission probe, no
 * spend); a run with nothing to continue is a no-op. Composes with `--commit`/`--merge` + parking.
 */
export async function cmdConductResume(
  ctx: Ctx,
  runId: string,
  flags: Flags,
  deps: CmdConductDeps = {},
): Promise<ResumeConductResult | undefined> {
  banner("sparra conduct --resume");
  if (!runId) {
    err('conduct --resume: a runId is required — usage: sparra conduct --resume <runId>');
    process.exitCode = 1;
    return undefined;
  }

  // Unsafe or unknown runId → exit 1 naming it, with ZERO side effects: validate the id as an opaque
  // identifier (rejecting `../`/separators so it can't escape `.sparra/conduct/`) BEFORE touching the
  // filesystem, the live-SDK probe, or any run-state write (mirrors the malformed-flag fast-path).
  const runDir = conductRunDir(ctx.paths.dir, runId);
  if (!isSafeRunId(runId) || !exists(runStatePath(runDir))) {
    err(`conduct --resume: no such run "${runId}" (looked in ${runDir})`);
    process.exitCode = 1;
    return { status: "unknown-run", runId, runDir };
  }

  const merge = flags["merge"] === true;
  const commit = merge || flags["commit"] === true;
  const resumeOpts: ResumeConductOptions = {
    ...(commit ? { commit: true } : {}),
    ...(merge ? { merge: true } : {}),
    ...(flags["auto"] === true ? { surface: "auto" } : {}),
  };

  // Probe permissions only AFTER the run is known to exist (an unknown run spends zero tokens).
  await (deps.autoProbe ?? autoProbeCtx)(ctx);

  const resumeFn = deps.resumeConductFn ?? resumeConduct;
  const result = await resumeFn(ctx, runId, resumeOpts, toConductDeps(deps));
  if (result.status === "unknown-run") {
    // Defensive: the pre-check above should already have handled this.
    err(`conduct --resume: no such run "${runId}" (looked in ${result.runDir})`);
    process.exitCode = 1;
    return result;
  }
  if (result.status === "nothing-to-do") {
    detail(`run: ${result.runId} → ${result.runDir} (nothing to resume)`);
    return result;
  }
  detail(`run: ${result.runId} → ${result.runDir} (resumed)`);
  for (const u of result.state.units) {
    detail(
      `  ${u.id} [${u.outcome}]` +
        (u.score !== undefined ? ` score=${u.score}` : "") +
        (u.branch ? ` branch=${u.branch}` : "") +
        (u.worktree ? ` worktree=${u.worktree}` : ""),
    );
  }
  return result;
}

/**
 * `sparra conduct --decide <runId> <seq> <answer> [--note …]` — answer a parked decision from another
 * terminal (also the future call target of the U3 HTTP bridge). Writes `<seq>.decision.json` where
 * the run's poller looks; an unknown run or unparked seq exits non-zero with a naming error and
 * spends nothing (no model call, no run dir created).
 */
export async function cmdConductDecide(
  ctx: Ctx,
  runId: string,
  seqStr: string,
  answer: string,
  note?: string,
): Promise<void> {
  banner("sparra conduct --decide");
  if (!runId || !seqStr || !answer) {
    err("conduct --decide: usage — sparra conduct --decide <runId> <seq> <answer> [--note …]");
    process.exitCode = 1;
    return;
  }
  const seq = Number(seqStr);
  if (!Number.isInteger(seq) || seq <= 0) {
    err(`conduct --decide: <seq> must be a positive integer (got "${seqStr}")`);
    process.exitCode = 1;
    return;
  }
  const runDir = conductRunDir(ctx.paths.dir, runId);
  if (!isSafeRunId(runId) || !exists(runDir) || !exists(runStatePath(runDir))) {
    err(`conduct --decide: no such run "${runId}" (looked in ${runDir})`);
    process.exitCode = 1;
    return;
  }
  if (!(await requestExists(runDir, seq))) {
    err(`conduct --decide: no parked decision #${seq} in run "${runId}"`);
    process.exitCode = 1;
    return;
  }
  const res = await writeDecisionAnswer(runDir, seq, answer, note);
  if (!res.ok) {
    if (res.reason === "bad-option") {
      err(
        `conduct --decide: "${answer}" is not a valid answer for decision #${seq} — ` +
          `choose one of: ${(res.validOptions ?? []).join(", ")}`,
      );
    } else {
      err(`conduct --decide: decision #${seq} in run "${runId}" is already resolved (cannot overwrite)`);
    }
    process.exitCode = 1;
    return;
  }
  ok(`conduct --decide: recorded answer "${answer}" for decision #${seq} → ${res.path} (run.json updated)`);
}

// ─────────────────────────── read-only reporting (--status / --list) ────────────────────────────

/**
 * The routing decision for a `sparra conduct` invocation carrying `--status`/`--list`. PURE — no I/O,
 * so an illegal flag combination is classified with ZERO side effects (no run dir, no probe, no
 * spend). `none` means neither reporting flag is present; the caller falls through to the existing
 * run/`--decide`/`--resume` routing unchanged.
 */
export type ReportInvocation =
  | { kind: "none" }
  | { kind: "status"; runId: string; json: boolean }
  | { kind: "list"; json: boolean }
  | { kind: "usage-error"; error: string };

/**
 * The ONLY flags a read-only reporting invocation may carry. Fail-closed (default-deny): any flag
 * outside this allowlist alongside `--status`/`--list` — an action flag (`--commit`/`--merge`/`--auto`/
 * `--dry-run`), a run-shaping flag (`--brain`/`--max-units`/`--budget`/…), or an unknown typo — is a
 * usage error, so a reporting surface can never be steered by a spend/mutation flag. `root` is the
 * global working-dir selector (safe on every command); `json` toggles machine output; `status`/`list`
 * are the reporting flags themselves. `resume`/`decide` are deliberately ABSENT so they surface via the
 * specific "cannot be combined with" messages below rather than the generic sweep.
 */
const REPORT_ALLOWED_FLAGS = new Set(["status", "list", "json", "root"]);

/**
 * Classify a conduct invocation for the read-only reporting surfaces. Both `--status`/`--list` are
 * PROMPTLESS (like `--decide`/`--resume`); a prompt alongside either, `--status` combined with
 * `--list`/`--resume`/`--decide` (or `--list` with those), a value-less `--status`, and ANY other flag
 * (fail-closed — action/run-shaping/unknown) are usage errors (exit 1, no side effects). `positionals`
 * is the raw argv positional list INCLUDING the leading `conduct` verb (so `positionals.slice(1)` is
 * any stray prompt words).
 */
export function parseConductReport(positionals: string[], flags: Flags): ReportInvocation {
  const hasStatus = flags["status"] !== undefined;
  const hasList = flags["list"] !== undefined;
  if (!hasStatus && !hasList) return { kind: "none" };

  const json = flags["json"] === true;
  const label = hasStatus ? "--status" : "--list";

  // Fail-closed valued-boolean guard. `--list` and `--json` are pure BOOLEAN switches, but the generic
  // arg parser greedily binds a trailing positional as a flag's "value" (`conduct --list run-a` →
  // list="run-a"; `conduct --status run-a --json extra` → json="extra"). A valued boolean is a usage
  // error — NOT silently dropped (which would swallow the bound token) and NOT fail-OPEN (a valued
  // `--json` compares `!== true`, so a naive read would downgrade to human output the caller never
  // asked for). Only a bare `true` is accepted; a string/array value is refused with zero side effects.
  if (hasList && flags["list"] !== true) {
    return { kind: "usage-error", error: "conduct: --list is a boolean flag and takes no value" };
  }
  if (flags["json"] !== undefined && flags["json"] !== true) {
    return { kind: "usage-error", error: "conduct: --json is a boolean flag and takes no value" };
  }

  // Mutually-exclusive with each other and with the write/continue surfaces.
  if (hasStatus && hasList) {
    return { kind: "usage-error", error: "conduct: --status and --list cannot be combined" };
  }
  if (flags["resume"] !== undefined) {
    return { kind: "usage-error", error: `conduct: ${label} cannot be combined with --resume` };
  }
  if (flags["decide"] !== undefined) {
    return { kind: "usage-error", error: `conduct: ${label} cannot be combined with --decide` };
  }

  // Fail-closed: reject every OTHER flag (action, run-shaping, or unknown/typo). A reporting surface is
  // read-only + zero-spend, so a `--commit`/`--merge`/`--auto`/`--budget`/… alongside it is rejected
  // rather than silently ignored (which could imply a mutation that never happens).
  const badFlag = Object.keys(flags).find((k) => !REPORT_ALLOWED_FLAGS.has(k));
  if (badFlag !== undefined) {
    return { kind: "usage-error", error: `conduct: ${label} does not accept --${badFlag} (read-only, zero-spend)` };
  }

  // A prompt is not accepted on either reporting form (they are read-only, like --decide/--resume).
  const extra = positionals.slice(1);
  if (extra.length > 0) {
    return {
      kind: "usage-error",
      error: `conduct: ${label} is read-only and takes no prompt (got "${extra.join(" ")}")`,
    };
  }

  if (hasStatus) {
    const runId = typeof flags["status"] === "string" ? flags["status"] : "";
    if (!runId) {
      return {
        kind: "usage-error",
        error: "conduct --status: a runId is required — usage: sparra conduct --status <runId> [--json]",
      };
    }
    return { kind: "status", runId, json };
  }
  return { kind: "list", json };
}

/** One-line prompt for the status header: first line only, trimmed, truncated (never a raw newline). */
function promptOneLine(prompt: string, max = 100): string {
  const first = (prompt ?? "").split("\n")[0]!.trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** Format a USD cost for display: fixed 2 decimals (metadata only, never precision-critical). */
function fmtCost(n: number): string {
  return n.toFixed(2);
}

/** Parse a run's `run.json`, or `undefined` when absent/torn/symlink-redirected (caller decides the
 *  surface). `runDir` MUST already be realpath-contained (`safeConductRunDir`). */
function readRunState(runDir: string): ConductRunState | undefined {
  // Symlink-redirect guard: a `run.json` planted as a SYMLINK — to a holdout brief/verdict that lives
  // inside the (dir-contained) conduct tree, or to a file outside it — must NOT be followed, or
  // `--status --json` would emit the redirected file's contents verbatim. Refuse it as "unreadable".
  if (!isDirectRunFile(runDir, "run.json")) return undefined;
  const text = readTextSync(runStatePath(runDir));
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as ConductRunState;
  } catch {
    return undefined;
  }
}

/**
 * `sparra conduct --status <runId> [--json]` — a ZERO-SPEND, read-only projection of a run's
 * `run.json`: a header (runId/status/brain/decisionSurface/timestamps/one-line prompt), one line per
 * unit (id, title, outcome, score, cost, branch, SHORT committedSha, mergedInto when present), and any
 * still-parked decisions (seq + question + a `conduct --decide <runId> <seq> <answer>` hint). `--json`
 * emits the run.json fields plus a `pendingDecisions` array instead. Output is metadata + paths ONLY —
 * never a brief/contract/verdict's contents (holdout-safe by construction: `run.json` is paths-only).
 * Unknown or unsafe runId → exit 1 naming it, with no side effects (validated as an opaque id BEFORE
 * any path is built).
 */
export async function cmdConductStatus(
  ctx: Ctx,
  runId: string,
  opts: { json?: boolean } = {},
): Promise<void> {
  // Resolve the run dir through the realpath-containment guard: an unsafe id, an unknown run, OR a run
  // dir that escapes `.sparra/conduct/` via a symlink all yield `undefined` → "no such run", exit 1,
  // with nothing read outside the conduct tree.
  const runDir = safeConductRunDir(ctx.paths.dir, runId);
  if (!runDir || !exists(runStatePath(runDir))) {
    err(`conduct --status: no such run "${runId}" (looked in ${conductRunDir(ctx.paths.dir, runId)})`);
    process.exitCode = 1;
    return;
  }
  const state = readRunState(runDir);
  if (!state) {
    err(`conduct --status: run "${runId}" has an unreadable run.json (${runStatePath(runDir)})`);
    process.exitCode = 1;
    return;
  }
  const pending = projectPendingDecisions(runDir);

  if (opts.json) {
    // Machine projection: the run.json document as-is + the holdout-safe pendingDecisions allowlist.
    raw(JSON.stringify({ ...state, pendingDecisions: pending }, null, 2) + "\n");
    return;
  }

  banner("sparra conduct --status");
  info(`run ${state.runId} [${state.status}]`);
  detail(
    `brain=${state.brain ?? "-"} decisions=${state.decisionSurface ?? "-"} ` +
      `created=${state.createdAt} updated=${state.updatedAt}`,
  );
  detail(`prompt: ${promptOneLine(state.prompt)}`);
  const units = Array.isArray(state.units) ? state.units : [];
  detail(`units (${units.length}):`);
  for (const u of units) {
    detail(`  ${unitLine(u)}`);
  }
  if (pending.length > 0) {
    info(`pending decisions (${pending.length}):`);
    for (const p of pending) {
      detail(`  #${p.seq} ${p.question}`);
      detail(`    answer: conduct --decide ${runId} ${p.seq} <answer>`);
    }
  }
}

/** One human-readable line for a unit: id, title, outcome + optional score/cost/branch/short-sha/merge. */
function unitLine(u: UnitStateEntry): string {
  const parts = [`${u.id} [${u.outcome}] "${u.title}"`];
  if (u.score !== undefined) parts.push(`score=${u.score}`);
  if (u.cost !== undefined) parts.push(`cost=${fmtCost(u.cost)}`);
  if (u.branch) parts.push(`branch=${u.branch}`);
  if (u.committedSha) parts.push(`sha=${u.committedSha.slice(0, 12)}`);
  if (u.mergedInto) parts.push(`merged→${u.mergedInto}`);
  return parts.join(" ");
}

/** One list row: a run's headline metadata, or an `unreadable` marker for a torn/corrupt run.json. */
interface RunListRow {
  runId: string;
  status: string;
  accepted: number;
  total: number;
  cost: number;
  updatedAt: string;
}

/**
 * `sparra conduct --list [--json]` — a ZERO-SPEND enumeration of the run dirs under
 * `.sparra/conduct/` that pass `isSafeRunId` AND contain a `run.json`, newest-first by `updatedAt`.
 * Per run: runId, status, accepted/total units, summed unit cost, updatedAt. A torn/corrupt run.json
 * is listed with status `unreadable` (never a crash). No conduct dir / no runs → a friendly "no
 * conduct runs" line, exit 0. Metadata only — no brief/contract/verdict contents.
 */
export async function cmdConductList(ctx: Ctx, opts: { json?: boolean } = {}): Promise<void> {
  const conductDir = path.join(ctx.paths.dir, "conduct");
  const rows: RunListRow[] = [];
  for (const name of readDir(conductDir)) {
    // Realpath-contain each entry (rejects a symlink that escapes the conduct tree) before any read.
    const runDir = safeConductRunDir(ctx.paths.dir, name);
    if (!runDir) continue; // unsafe id, missing dir, or escapes conduct/ → not a listable run
    const statePath = runStatePath(runDir);
    if (!exists(statePath)) continue; // a dir without run.json is not a listable run
    const state = readRunState(runDir);
    if (!state) {
      // A run.json that exists but won't parse → surfaced as `unreadable`, never a crash.
      rows.push({ runId: name, status: "unreadable", accepted: 0, total: 0, cost: 0, updatedAt: "" });
      continue;
    }
    const units = Array.isArray(state.units) ? state.units : [];
    const accepted = units.filter((u) => u.outcome === "accepted").length;
    const cost = units.reduce((sum, u) => sum + (typeof u.cost === "number" ? u.cost : 0), 0);
    rows.push({
      runId: state.runId ?? name,
      status: state.status ?? "?",
      accepted,
      total: units.length,
      cost,
      updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : "",
    });
  }
  // Newest-first by ISO `updatedAt` (lexical order == chronological for ISO); unreadable rows carry
  // "" and sort to the end.
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  if (opts.json) {
    raw(JSON.stringify(rows, null, 2) + "\n");
    return;
  }

  banner("sparra conduct --list");
  if (rows.length === 0) {
    info("no conduct runs");
    return;
  }
  for (const r of rows) {
    detail(`${r.runId} [${r.status}] ${r.accepted}/${r.total} accepted cost=${fmtCost(r.cost)} updated=${r.updatedAt}`);
  }
}
