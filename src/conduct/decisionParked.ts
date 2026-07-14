import type { Ctx } from "../context.ts";
import { info, warn } from "../util/log.ts";
import { runScriptHooks } from "../scriptHooks.ts";
import { formatDecisionParkedAnnouncement } from "./announce.ts";
import type { DecisionRequest } from "./decision.ts";

/**
 * `src/conduct/decisionParked.ts` — the ONE shared seam every `sparra conduct` decision-park site
 * routes through, so run.ts (the deterministic + brain judge paths) and merge.ts (the merge-landing
 * park) share identical behavior. When a decision PARKS it does two things:
 *
 *  1. Emits the stable decision-parked announce line to the SAME `info(...)` logger the run-START line
 *     uses, so it lands on the child's stdout for the HTTP bridge to parse into a `decision_parked`
 *     event. The line carries ONLY `runId` + `seq` (see `announce.ts` — no free text on the wire).
 *  2. Preserves the pre-existing `onDecisionRequest` test seam (fired synchronously, exactly as before).
 *  3. ALWAYS invokes the `onDecisionParked` script hook (U1/U2) — on EVERY park, no config gate. With
 *     no `scriptHooks.onDecisionParked` configured the runner simply returns `{ok:true, ran:0}` and
 *     spawns nothing. `onDecisionParked` is an AFTER-event → best-effort: a hook failure/timeout only
 *     warns and NEVER blocks the parked decision from being answered (the caller launches this helper
 *     as a caught fire-and-forget from the SYNCHRONOUS `onRequestWritten` seam).
 *
 * The `question` (holdout-safe, `ParentSummary`-derived) travels only via the hook's stdin JSON — never
 * on the announce line and never in an env var (see `scriptHooks.ts`).
 */

/** The minimal deps shape both `ConductDeps` and `LandingDeps` satisfy for the park seam. */
export interface DecisionParkedDeps {
  /** The `runScriptHooks` invocation (default: the real runner). Injected in tests. */
  runScriptHooksFn?: typeof runScriptHooks;
  /** Pre-existing test seam: called with the written `<seq>.request.json` path. */
  onDecisionRequest?: (requestPath: string) => void;
}

/** Handle a parked decision: announce line (stdout) + preserved `onDecisionRequest` seam + always-fired
 *  best-effort `onDecisionParked` hook. Called as a fire-and-forget with an explicit `.catch(→warn)` at
 *  each `onRequestWritten` site, so this `async` helper can never surface an unhandled rejection or
 *  block the (synchronous) decision poller. */
export async function handleDecisionParked(
  ctx: Ctx,
  deps: DecisionParkedDeps,
  args: { runId: string; runDir: string; req: DecisionRequest; requestPath: string },
): Promise<void> {
  // (1) The wire announce line — runId + seq ONLY (holdout-safe by the format API's shape).
  info(formatDecisionParkedAnnouncement(args.runId, args.req.seq));
  // (2) Preserve the pre-existing test seam (fired synchronously, before the hook await, so it fires
  //     even if the hook rejects — existing conduct/merge tests rely on it).
  deps.onDecisionRequest?.(args.requestPath);
  // (3) Always fire the after-event hook (best-effort; no config gate). `question` rides ONLY in the
  //     hook's stdin JSON, never on the wire line or an env var.
  const runHooks = deps.runScriptHooksFn ?? runScriptHooks;
  await runHooks(
    "onDecisionParked",
    {
      runId: args.runId,
      runDir: args.runDir,
      ...(ctx.root ? { root: ctx.root } : {}),
      decisionSeq: args.req.seq,
      decisionKind: args.req.kind,
      question: args.req.question,
    },
    ctx.config,
  );
}

/** Wrap {@link handleDecisionParked} as the caught, fire-and-forget SYNC callback wired into each
 *  `DecisionEngineDeps.onRequestWritten` — the seam stays synchronous + `void`, and any rejection
 *  (e.g. a throwing injected `runScriptHooksFn`) is converted to a `warn(...)`, never an unhandled
 *  rejection and never a blocked poller. */
export function makeOnRequestWritten(
  ctx: Ctx,
  deps: DecisionParkedDeps,
  ids: { runId: string; runDir: string },
): (requestPath: string, req: DecisionRequest) => void {
  return (requestPath: string, req: DecisionRequest): void => {
    void handleDecisionParked(ctx, deps, { runId: ids.runId, runDir: ids.runDir, req, requestPath }).catch(
      (e: unknown) => warn(`conduct: onDecisionParked handling failed — ${e instanceof Error ? e.message : String(e)}`),
    );
  };
}
