import { autoProbeCtx, type Ctx } from "../context.ts";
import { banner, detail, err, info } from "../util/log.ts";
import { runConduct, type ConductDeps, type ConductOptions, type ConductResult } from "../conduct/run.ts";

/**
 * `sparra conduct "<prompt>"` — the headless conductor: from ONE prompt, decompose into 1..N units
 * and per unit negotiate a contract → generate → cross-model evaluate → decide, all through the
 * existing isolated role-run machinery (`conductors/core`). Deterministic decision strategy only;
 * an LLM conductor brain / interactive decision surface are follow-up units (the strategy seam is
 * already injectable). Nothing lands on the user's branch — units generate on their own worktrees.
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

  const opts: ConductOptions = {
    prompt: trimmed,
    maxUnits,
    concurrency,
    dryRun: flags["dry-run"] === true,
  };
  if (maxTurns !== undefined) opts.maxTurns = maxTurns;
  if (budget !== undefined) opts.budget = budget;
  return { ok: true, opts };
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
  autoProbe?: typeof autoProbeCtx;
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

  const runConductFn = deps.runConductFn ?? runConduct;
  const conductDeps: ConductDeps = {
    ...(deps.runRole ? { runRole: deps.runRole } : {}),
    ...(deps.runSessionFn ? { runSessionFn: deps.runSessionFn } : {}),
    ...(deps.strategy ? { strategy: deps.strategy } : {}),
    ...(deps.sparraBin ? { sparraBin: deps.sparraBin } : {}),
  };

  info(
    `prompt="${parsed.opts.prompt.slice(0, 80)}${parsed.opts.prompt.length > 80 ? "…" : ""}" ` +
      `max-units=${parsed.opts.maxUnits} concurrency=${parsed.opts.concurrency}` +
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
