import {
  decideFromEvaluation,
  type DecideFn,
  type ParentSummary,
} from "../../conductors/core/index.ts";

/**
 * `src/conduct/strategy.ts` — the judgment-strategy SEAM for `sparra conduct`.
 *
 * A conductor makes a decision at each build-cycle round (accept / revise / pivot / …). This unit
 * ships ONLY the deterministic strategy — it delegates verbatim to the core `decideFromEvaluation`
 * PURE function (which enforces the cross-model gate: a `sameModelGrade` pass is never accepted).
 * A future unit (an LLM conductor brain, an interactive decision surface) plugs in a
 * non-deterministic strategy HERE without touching the loop: the strategy is consulted at the
 * judgment point via the core build cycle's `decide` injection, so an alternative implementation
 * observably changes what the loop does.
 */

/** A pluggable judgment strategy. `decide` has the exact signature of core `decideFromEvaluation`,
 *  so the deterministic default is a drop-in and any injected strategy is consulted at the same
 *  decision point (the per-round build-cycle judgment). */
export interface JudgmentStrategy {
  decide: DecideFn;
}

/** The shipped default: delegates verbatim to core `decideFromEvaluation` — same decisions, same
 *  cross-model-gate enforcement. A non-deterministic strategy is out of scope for this unit. */
export const deterministicStrategy: JudgmentStrategy = {
  decide: (
    evaluator: ParentSummary,
    state: { consecutiveFailures: number },
    config: { pivotAfterFailures: number; requireCrossModel: boolean },
  ) => decideFromEvaluation(evaluator, state, config),
};
