import { spawn } from "node:child_process";
import type { SparraConfig, ScriptHookEvent, ScriptHookSpec } from "./config.ts";
import { stringProcessEnv } from "./build/env.ts";
import { EXEC_TIMEOUT_MS, EXEC_OUTPUT_CAP } from "./build/exec.ts";
import { warn as logWarn } from "./util/log.ts";

/**
 * Runner for user-configurable `scriptHooks` (see `src/config.ts`) — the harness-side foundation
 * only; NO fire points live here (those are wired by the callers at each lifecycle point, U2).
 *
 * A single entry point, `runScriptHooks`, spawns each configured hook for one event IN ORDER, no
 * shell (argv array only — never `unsafeExecReason`'s argv[0] allowlist from `src/build/exec.ts`;
 * these are the user's OWN trusted commands from their own config, not a contracted verify
 * command). The only safety applied is: no shell, a per-hook timeout, a combined stdout+stderr
 * BYTE cap (`OutputCapture`, shared across both streams, measured on raw bytes not decoded
 * chars), and a scrubbed `SPARRA_HOOK_*` env namespace (`sanitizedParentEnv` deletes every
 * reserved key from the parent env copy BEFORE layering the ctx-derived vars back on, so a
 * stale parent-held value can never leak through for a field this call's ctx omits).
 *
 * Failure policy (the opt-in gate): "before" events (onRunStart/onPhaseStart/onUnitStart) can
 * GATE the lifecycle step — a `required: true` hook that exits non-zero or times out stops the
 * rest of that event's hooks and reports a `gateFailure` for the caller to act on. Every other
 * event is best-effort: a failure only warns and the run continues (`required` on an AFTER event
 * is a no-op past the warning — gating a step that's already complete is meaningless).
 */

export type { ScriptHookEvent, ScriptHookSpec } from "./config.ts";

/** Holdout-safe fields carried to a hook. `question` may carry decision text — it is deliberately
 *  NEVER placed in an env var (the char-safe subset); it is included only in the stdin JSON. */
export interface ScriptHookContext {
  root?: string;
  phase?: string;
  runId?: string;
  runDir?: string;
  unit?: string;
  status?: string;
  decisionSeq?: number;
  decisionKind?: string;
  question?: string;
}

/** Injectable seams so tests never spawn a real process, sleep, or touch disk. */
export interface ScriptHookDeps {
  /** Defaults to a thin wrapper over `node:child_process.spawn` (no shell). */
  spawnFn?: typeof spawn;
  /** Defaults to the phase logger's warn (silenced under vitest). */
  warn?: (msg: string) => void;
  /** Overrides the per-hook timeout for every hook this call runs (mainly for fast tests);
   *  falls back to `spec.timeoutSec * 1000`, then the module default. */
  timeoutMs?: number;
  /** Overrides the output cap — a single BUDGET IN BYTES shared across stdout+stderr COMBINED
   *  (never a separate cap per stream). Measured on raw bytes, not decoded JS string chars, so a
   *  multi-byte sequence split at the boundary is truncated exactly at the byte cap. */
  outputCap?: number;
  /** Injectable clock; unused by the runner today but kept for deterministic future extension
   *  (e.g. a caller wanting to stamp outcomes) without another deps-shape churn. */
  now?: () => number;
}

/** One event's outcome. `gateFailure` is set only when a "before" event's `required` hook failed
 *  or timed out (the caller aborts the lifecycle step using it); otherwise `ok` is always true —
 *  best-effort ("after") failures never flip `ok`, they only warn. */
export interface ScriptHookOutcome {
  ok: boolean;
  /** Count of hooks actually spawned this call (0 for a no-op empty-config event). */
  ran: number;
  gateFailure?: {
    event: ScriptHookEvent;
    command: string;
    exitCode?: number | null;
    signal?: string | null;
    timedOut?: boolean;
  };
}

/** "Before" events can gate their lifecycle step on a `required` hook failing; every other event
 *  is best-effort. One source of truth for the policy — testable directly. */
const BEFORE_EVENTS: readonly ScriptHookEvent[] = ["onRunStart", "onPhaseStart", "onUnitStart"];

export function isBeforeEvent(event: ScriptHookEvent): boolean {
  return (BEFORE_EVENTS as readonly string[]).includes(event);
}

/** The full reserved `SPARRA_HOOK_*` env-var namespace — INCLUDING `SPARRA_HOOK_QUESTION`, which
 *  is never SET by this runner but must still be scrubbed from the parent env copy (see
 *  `sanitizedParentEnv`) so a stale value inherited from the parent process can never leak into a
 *  hook whenever `ctx` happens to omit that field. */
const RESERVED_ENV_KEYS = [
  "SPARRA_HOOK_EVENT",
  "SPARRA_HOOK_PHASE",
  "SPARRA_HOOK_ROOT",
  "SPARRA_HOOK_RUN_ID",
  "SPARRA_HOOK_RUN_DIR",
  "SPARRA_HOOK_UNIT",
  "SPARRA_HOOK_STATUS",
  "SPARRA_HOOK_DECISION_SEQ",
  "SPARRA_HOOK_DECISION_KIND",
  "SPARRA_HOOK_QUESTION",
] as const;

/** A copy of the parent process env with EVERY reserved `SPARRA_HOOK_*` key deleted FIRST —
 *  so the caller can then layer only the ctx-derived vars on top and an absent ctx field is
 *  genuinely unset in the child, never a leftover from whatever the parent happened to hold. */
function sanitizedParentEnv(): Record<string, string> {
  const env = stringProcessEnv();
  for (const key of RESERVED_ENV_KEYS) delete env[key];
  return env;
}

/** Env vars set for the ctx fields that are PRESENT — `question` is deliberately excluded (it
 *  never gets a `SPARRA_HOOK_QUESTION` var; see `RESERVED_ENV_KEYS`/`sanitizedParentEnv`). */
function hookEnv(event: ScriptHookEvent, ctx: ScriptHookContext): Record<string, string> {
  const env: Record<string, string> = { SPARRA_HOOK_EVENT: event };
  if (ctx.phase !== undefined) env.SPARRA_HOOK_PHASE = ctx.phase;
  if (ctx.root !== undefined) env.SPARRA_HOOK_ROOT = ctx.root;
  if (ctx.runId !== undefined) env.SPARRA_HOOK_RUN_ID = ctx.runId;
  if (ctx.runDir !== undefined) env.SPARRA_HOOK_RUN_DIR = ctx.runDir;
  if (ctx.unit !== undefined) env.SPARRA_HOOK_UNIT = ctx.unit;
  if (ctx.status !== undefined) env.SPARRA_HOOK_STATUS = ctx.status;
  if (ctx.decisionSeq !== undefined) env.SPARRA_HOOK_DECISION_SEQ = String(ctx.decisionSeq);
  if (ctx.decisionKind !== undefined) env.SPARRA_HOOK_DECISION_KIND = ctx.decisionKind;
  return env;
}

interface Tokenized {
  argv: string[];
  required: boolean;
  timeoutSec?: number;
  cwd?: string;
}

/** Whitespace argv tokenization — no shell, so no quoting/expansion is honored (matches the
 *  no-shell contract; a spec needing shell syntax isn't a safe script hook). */
function tokenize(spec: ScriptHookSpec): Tokenized {
  if (typeof spec === "string") {
    return { argv: spec.split(/\s+/).filter(Boolean), required: false };
  }
  return {
    argv: spec.run.split(/\s+/).filter(Boolean),
    required: spec.required ?? false,
    timeoutSec: spec.timeoutSec,
    cwd: spec.cwd,
  };
}

interface HookRunResult {
  command: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Non-zero exit, a spawn error, or a timeout — the runner's single "did this hook fail" bit. */
  failed: boolean;
  /** Captured, ALREADY CAPPED (see `outputCap`) — never unbounded even for a chatty hook.
   *  Diagnostic-only: never surfaced on `gateFailure` (documented shape stays minimal), used
   *  only to enrich the best-effort `warn(...)` call. */
  stdout: string;
  stderr: string;
}

/**
 * Bounded capture of a hook's stdout+stderr under ONE shared BYTE budget — never a separate cap
 * per stream (a hook that dumps `cap` bytes on stdout leaves zero budget for stderr, and vice
 * versa). Measured on raw BYTES (`Buffer.length`), not decoded JS string `.length` — a chunk that
 * splits a multi-byte UTF-8 sequence at the cap boundary is truncated exactly at the byte cap, so
 * a 4-byte character can never "count as 1" and slip extra bytes past a tiny cap. Exported as a
 * small, spawn-free, stateful helper so this exact truncation behavior — including the
 * multibyte-boundary and shared-across-streams cases — is directly unit-testable without
 * spawning a real or fake child process; `runOneHook` below wires it to the live `data` events.
 */
export class OutputCapture {
  private stdoutParts: Buffer[] = [];
  private stderrParts: Buffer[] = [];
  private total = 0;

  constructor(private readonly capBytes: number) {}

  push(stream: "stdout" | "stderr", data: Buffer): void {
    if (this.total >= this.capBytes) return; // budget already exhausted — drop entirely
    const remaining = this.capBytes - this.total;
    const slice = data.length > remaining ? data.subarray(0, remaining) : data;
    (stream === "stdout" ? this.stdoutParts : this.stderrParts).push(slice);
    this.total += slice.length;
  }

  result(): { stdout: Buffer; stderr: Buffer } {
    return { stdout: Buffer.concat(this.stdoutParts), stderr: Buffer.concat(this.stderrParts) };
  }
}

/** Spawn ONE hook: no shell, combined-byte-capped stdout+stderr, timeout-killed, JSON-on-stdin. */
function runOneHook(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  stdinPayload: string,
  timeoutMs: number,
  outputCap: number,
  spawnFn: typeof spawn
): Promise<HookRunResult> {
  const command = argv.join(" ");
  return new Promise<HookRunResult>((resolve) => {
    const child = spawnFn(argv[0]!, argv.slice(1), {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    const capture = new OutputCapture(outputCap);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => capture.push("stdout", d));
    child.stderr?.on("data", (d: Buffer) => capture.push("stderr", d));
    const finish = (exitCode: number | null, signal: string | null, failed: boolean) => {
      clearTimeout(timer);
      const { stdout, stderr } = capture.result();
      resolve({ command, exitCode, signal, timedOut, failed, stdout: stdout.toString(), stderr: stderr.toString() });
    };
    child.on("error", () => {
      // Spawn-level failure (e.g. ENOENT) — treat like any other failed hook.
      finish(null, null, true);
    });
    child.on("close", (code, signal) => {
      finish(code, signal, timedOut || code !== 0);
    });
    try {
      child.stdin?.write(stdinPayload);
      child.stdin?.end();
    } catch {
      // best-effort — a hook that never reads stdin shouldn't crash the runner
    }
  });
}

/**
 * Run every hook configured for `event`, sequentially and in listed order. Empty/absent config
 * for the event is a strict no-op (nothing spawned). See module doc for the gate/best-effort
 * failure policy.
 */
export async function runScriptHooks(
  event: ScriptHookEvent,
  ctx: ScriptHookContext,
  config: SparraConfig,
  deps: ScriptHookDeps = {}
): Promise<ScriptHookOutcome> {
  const specs = config.scriptHooks?.[event] ?? [];
  if (specs.length === 0) return { ok: true, ran: 0 };

  const spawnFn = deps.spawnFn ?? spawn;
  const warnFn = deps.warn ?? logWarn;
  const before = isBeforeEvent(event);
  // "Full context object" — question included — as ONE JSON line on stdin, never in env.
  const stdinPayload = JSON.stringify(ctx) + "\n";
  const baseEnv = hookEnv(event, ctx);
  let ran = 0;

  for (const spec of specs) {
    const { argv, required, timeoutSec, cwd } = tokenize(spec);
    if (argv.length === 0) continue; // defensive; validateScriptHooks already rejects an empty run
    const resolvedCwd = cwd ?? ctx.root ?? process.cwd();
    const timeoutMs = deps.timeoutMs ?? (timeoutSec ? timeoutSec * 1000 : EXEC_TIMEOUT_MS);
    const outputCap = deps.outputCap ?? EXEC_OUTPUT_CAP;
    // Reserved keys are scrubbed from the parent copy FIRST, then baseEnv layers on only the
    // ctx-derived vars that are actually present — a stale parent-held SPARRA_HOOK_* value can
    // never leak through for a field this call's ctx omits.
    const env = { ...sanitizedParentEnv(), ...baseEnv };

    const result = await runOneHook(argv, resolvedCwd, env, stdinPayload, timeoutMs, outputCap, spawnFn);
    ran++;

    if (result.failed) {
      if (before && required) {
        return {
          ok: false,
          ran,
          gateFailure: {
            event,
            command: result.command,
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
          },
        };
      }
      // Non-required before-event failure, or ANY after-event failure (even `required`,
      // which is meaningless once the step is complete) — warn and keep going. The (already
      // capped) captured output is diagnostic-only here — it never reaches `gateFailure`.
      const diagnostic = (result.stderr || result.stdout).trim();
      warnFn(
        `script hook failed (${event}): \`${result.command}\` exited ${result.exitCode}${
          result.timedOut ? " (timed out)" : ""
        }${diagnostic ? ` — ${diagnostic.slice(0, 300)}` : ""}`
      );
    }
  }

  return { ok: true, ran };
}
