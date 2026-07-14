import type { SparraConfig } from "./config.ts";
import { runScriptHooks, type ScriptHookOutcome } from "./scriptHooks.ts";

/**
 * `withPhaseHooks` — the universal phase-boundary fire point (U2): wraps a hookable phase's body
 * with `onPhaseStart` (gate) → `run()` → `onPhaseEnd` (best-effort). One tiny module so `src/cli.ts`
 * (and any other phase-command entry point) shares the exact same wiring, and so the wiring is
 * directly unit-testable with a fake `runScriptHooksFn` — no real spawn, no CLI argv parsing.
 *
 * Gate semantics mirror `src/scriptHooks.ts`: a `required` `onPhaseStart` hook that fails/times out
 * returns `{ ok: false, gateFailure }` and `run()` is NEVER called — the phase body does not execute.
 * `onPhaseEnd` is always best-effort (its own outcome is ignored) and only fires after a `run()` that
 * actually completed (an exception thrown by `run()` propagates — `onPhaseEnd` does not run and does
 * not swallow it).
 */

/** A minimal shape of the harness `Ctx` this needs — avoids importing the full `Ctx` type here and
 *  keeps this module import-light (no `context.ts` → `state.ts` → … chain). */
export interface PhaseHooksCtx {
  root: string;
  config: SparraConfig;
}

export interface PhaseHooksDeps {
  /** Injectable seam for tests (default: the real `runScriptHooks`). */
  runScriptHooksFn?: typeof runScriptHooks;
}

/** The result `withPhaseHooks` returns to its caller: whether the phase actually ran, and — on a
 *  gate failure — the offending hook's details so the caller can report a precise error. */
export interface PhaseHooksResult {
  ok: boolean;
  gateFailure?: ScriptHookOutcome["gateFailure"];
}

export async function withPhaseHooks(
  phase: string,
  ctx: PhaseHooksCtx,
  run: () => Promise<void>,
  deps: PhaseHooksDeps = {},
): Promise<PhaseHooksResult> {
  const runHooks = deps.runScriptHooksFn ?? runScriptHooks;

  const start = await runHooks("onPhaseStart", { phase, root: ctx.root }, ctx.config);
  if (!start.ok) {
    return { ok: false, gateFailure: start.gateFailure };
  }

  await run();

  // Best-effort — a failing/`!ok` onPhaseEnd never throws or changes the reported outcome; the
  // runner itself already only warns on an after-event failure (see scriptHooks.ts), so this call's
  // own promise never rejects on a hook failure. We deliberately ignore its return value.
  await runHooks("onPhaseEnd", { phase, root: ctx.root, status: "completed" }, ctx.config);

  return { ok: true };
}
