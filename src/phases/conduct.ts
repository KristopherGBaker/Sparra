import { autoProbeCtx, type Ctx } from "../context.ts";
import { banner, detail, err, info, ok } from "../util/log.ts";
import { exists } from "../util/io.ts";
import {
  runConduct,
  resumeConduct,
  type ConductDeps,
  type ConductOptions,
  type ConductResult,
  type ResumeConductOptions,
  type ResumeConductResult,
} from "../conduct/run.ts";
import { conductRunDir, isSafeRunId, runStatePath } from "../conduct/runState.ts";
import { requestExists, writeDecisionAnswer } from "../conduct/decisionEngine.ts";

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
