import type { RunRolePayload } from "../../src/roleEnvelope.ts";

/**
 * The holdout wall for conductor hosts, in code.
 *
 * A conductor delegates each role-run to an isolated child (a Pi agent session, an opencode
 * subagent, or a spawned {@link ./roleWorker.ts} process). The child runs the role via the Sparra
 * CLI/JSON surface and returns to the parent ONLY a {@link ParentSummary} — the decision-relevant
 * control fields. `toParentSummary` is what produces that projection.
 *
 * Design (learned from the spike): an ALLOWLIST, never a denylist. We copy a fixed set of named
 * control fields onto a fresh object; anything not named — today's holdout-bearing fields
 * (`resultText`, `resultDigest`, `traceDir`) AND any field a future runner adds to
 * {@link RunRolePayload} — is dropped until a human consciously adds it here. A `{...payload}`
 * spread-then-delete would silently forward every field the author forgot to remove.
 */

/** The runner-carried fields that may quote holdout evidence and must NEVER reach the parent. */
export const HOLDOUT_BEARING_FIELDS = ["resultText", "resultDigest", "traceDir"] as const;
export type HoldoutBearingField = (typeof HOLDOUT_BEARING_FIELDS)[number];

/**
 * The explicit allowlist of parent-safe control fields, in canonical order.
 *
 * `satisfies readonly (keyof RunRolePayload)[]` makes the compiler reject a typo or a field that no
 * longer exists on the envelope — so the allowlist can't silently drift from the real runner
 * contract.
 */
export const PARENT_SAFE_FIELDS = [
  "roleKind",
  "backend",
  "model",
  "sessionId",
  "ok",
  "verdict",
  "weightedTotal",
  "passThreshold",
  "blocking",
  "failedAssertions",
  "verdictPath",
  "outPath",
  "filesChanged",
  "sameModelGrade",
  "fallbackFrom",
  "limitHit",
  "hitBudget",
  "hitMaxTurns",
  "emptyCompletion",
  "noProgress",
  "verifyGateWarning",
  "unitWorktree",
  "promptDrift",
  "errors",
  "tokens",
  "costUsd",
] as const satisfies readonly (keyof RunRolePayload)[];

export type ParentSafeField = (typeof PARENT_SAFE_FIELDS)[number];

/**
 * Compile-time holdout guard: if any {@link HoldoutBearingField} ever appears in
 * {@link PARENT_SAFE_FIELDS}, this type resolves to an error-message tuple instead of `true` and the
 * assignment below fails the build. This is the wall enforced by `tsc`, not just by a runtime test.
 */
type AssertNoHoldoutInAllowlist =
  Extract<ParentSafeField, HoldoutBearingField> extends never
    ? true
    : ["HOLDOUT LEAK: a holdout-bearing field is present in PARENT_SAFE_FIELDS"];
const _assertNoHoldoutInAllowlist: AssertNoHoldoutInAllowlist = true;
void _assertNoHoldoutInAllowlist;

/** The parent-visible summary: exactly the allowlisted fields of the canonical envelope. Derived
 *  FROM the allowlist (via `Pick`), so a new envelope field is absent here until it is allowlisted. */
export type ParentSummary = Pick<RunRolePayload, ParentSafeField>;

/**
 * Project a full canonical role-result envelope down to the parent-safe summary: only the
 * allowlisted fields that are actually present on the input. Holdout-bearing and unknown fields are
 * dropped, full stop.
 */
export function toParentSummary(payload: RunRolePayload): ParentSummary {
  const summary: Partial<Record<ParentSafeField, unknown>> = {};
  for (const field of PARENT_SAFE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      summary[field] = payload[field];
    }
  }
  return summary as ParentSummary;
}
