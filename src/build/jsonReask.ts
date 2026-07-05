import type { RunSessionParams } from "../sdk/session.ts";

/**
 * The shared JSON re-ask: resume a session ONCE to re-emit only the final report/verdict JSON
 * block when a run produced no parseable report but the work is (or the reply nearly was) there.
 * Both the autonomous generator (`generate.ts`) and the interactive role-runner (`roleRun.ts`)
 * build their resume request from this one place, so the report-only prompt reads identically and
 * neither copy-pastes the paragraph.
 */
export const REPORT_REASK_PROMPT =
  "Your previous reply had no parseable report JSON. Re-emit ONLY the JSON block per your instructions — nothing else.";

/**
 * The evaluator's WRONG-SHAPE verdict re-ask: a JSON block WAS emitted but it fails `isVerdict`
 * (e.g. missing/non-object `scores`, missing `verdict`/`weightedTotal`). A generic "re-emit the
 * block" can't fix a block that was already emitted, so this NAMES the specific required fields
 * the best verdict-like candidate is missing/invalid (computed by the caller) — while still
 * instructing "re-emit ONLY the JSON block". Kept here so the paragraph lives in one place.
 */
export function verdictReaskPrompt(missingFields: string[]): string {
  const fields = missingFields.length ? missingFields.join(", ") : "scores, verdict";
  return `Your previous reply had a JSON block but of the wrong shape — the verdict is missing or has an invalid value for: ${fields}. Re-emit ONLY the JSON verdict block per your instructions, with the required field(s) present and valid — nothing else.`;
}

/** A report re-ask needs exactly ONE turn: enough to re-emit the block, not enough to re-enter
 *  work. The role-runner's cap-death re-ask pins this so a session resumed after a cap can't
 *  quietly keep building past the cap it just hit. */
export const REPORT_REASK_MAX_TURNS = 1;

/** Default tight USD cap for a cap-death report re-ask (role-runner). Small on purpose — a report
 *  re-emit is one short turn — and clamped below the original run's cap by the caller so it stays
 *  materially tighter than the run that just died. */
export const REPORT_REASK_MAX_BUDGET_USD = 0.5;

/**
 * Session-request overrides for the one-shot report re-ask: resume the dying session with the
 * report-only prompt. Spread over the caller's base request. `tightCap` (the role-runner's
 * cap-death path) additionally PINS the re-ask to one turn + a small USD budget so the resume
 * can't re-enter work; the autonomous generator omits it (its re-ask behavior is unchanged).
 */
export function reportReaskOverrides(opts: {
  role: string;
  sessionId: string;
  tightCap?: { maxBudgetUsd: number };
}): Partial<RunSessionParams> {
  return {
    role: opts.role,
    prompt: REPORT_REASK_PROMPT,
    resume: opts.sessionId,
    ...(opts.tightCap ? { maxTurns: REPORT_REASK_MAX_TURNS, maxBudgetUsd: opts.tightCap.maxBudgetUsd } : {}),
  };
}
