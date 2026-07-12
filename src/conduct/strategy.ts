import {
  decideFromEvaluation,
  type DecideFn,
  type ParentSummary,
} from "../../conductors/core/index.ts";
import type { DecisionRequest, DecisionResolution } from "./decision.ts";

/**
 * `src/conduct/strategy.ts` — the judgment-strategy SEAM for `sparra conduct`.
 *
 * A conductor makes a decision at each build-cycle round (accept / revise / pivot / …). The
 * deterministic strategy delegates verbatim to the core `decideFromEvaluation` PURE function (which
 * enforces the cross-model gate: a `sameModelGrade` pass is never accepted). U2 WIDENS this seam
 * with `resolve` for the higher-level judgment points (contract non-convergence, unit exhaustion,
 * gate collapse, budget/limit recovery, borderline accept) so the LLM conductor brain / decision
 * engine plug in HERE without forking the loop; an alternative implementation observably changes
 * what the run does.
 */

/** A pluggable judgment strategy. `decide` has the exact signature of core `decideFromEvaluation`,
 *  so the deterministic default is a drop-in and any injected strategy is consulted at the same
 *  decision point (the per-round build-cycle judgment). */
export interface JudgmentStrategy {
  /** The per-round build-cycle decision (accept / revise / pivot / …). */
  decide: DecideFn;
  /**
   * Resolve a HIGHER-LEVEL judgment point (contract non-convergence, unit exhaustion, gate
   * collapse, budget/limit recovery, borderline accept). U1 had only `decide`; U2 widens the
   * interface HERE rather than forking the loop — the conduct unit runner consults `resolve` at
   * each judgment point, and its answer is applied to the run path. Defaults to
   * {@link deterministicJudgment} (the offered kind's deterministic default). The decision-engine /
   * brain wiring is a concrete `resolve` supplied by the conduct run.
   */
  resolve?: (request: DecisionRequest) => Promise<DecisionResolution>;
}

/** The deterministic resolution for a judgment point: the kind's default option, no human/brain. */
export async function deterministicJudgment(request: DecisionRequest): Promise<DecisionResolution> {
  return {
    answer: request.default,
    source: "auto-deterministic",
    via: "auto",
    rationale: "deterministic default (no brain / decision surface)",
  };
}

/** The shipped default: delegates verbatim to core `decideFromEvaluation` — same decisions, same
 *  cross-model-gate enforcement — and resolves judgment points to their deterministic default. */
export const deterministicStrategy: JudgmentStrategy = {
  decide: (
    evaluator: ParentSummary,
    state: { consecutiveFailures: number },
    config: { pivotAfterFailures: number; requireCrossModel: boolean },
  ) => decideFromEvaluation(evaluator, state, config),
  resolve: deterministicJudgment,
};
