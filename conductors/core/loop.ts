import type { RunRoleSpec } from "./roleClient.ts";
import type { ParentSummary } from "./summary.ts";

/**
 * `conductors/core/loop.ts` — the host-agnostic build-cycle orchestrator: generate → cross-model
 * evaluate → decide, driven as a PROGRAM over the already-built `conductors/core` pieces.
 *
 * This module never spawns a process or parses an envelope itself — it only calls the injected
 * {@link RoleRunner} (production: {@link ../core/index.ts}'s `runRole`; tests: a scripted fake) and
 * reasons over the {@link ParentSummary} it returns. It therefore never reads a holdout file and
 * never carries a holdout-bearing field (`resultText`/`resultDigest`/`traceDir`) — those are already
 * redacted by `toParentSummary` before a summary ever reaches this file.
 */

/** The injected role executor. Production wires the core `runRole`; tests wire a scripted fake. */
export type RoleRunner = (spec: RunRoleSpec) => Promise<ParentSummary>;

/** Per-round context handed to a {@link BuildCycleConfig}'s spec builders, so each round can inject
 *  prior blocking feedback / a pivot signal into the role's args. */
export interface RoundContext {
  round: number;
  /** The prior round's `evaluator.blocking` lines (holdout-safe), or `[]` on round 1. */
  feedback: string[];
  /** True once `pivotAfterFailures` consecutive fails have been hit — the next round should try a
   *  different approach rather than a small revision. */
  pivoting: boolean;
  /** Prior rounds' runner-persisted redacted verdict FILE paths (never contents), in round order.
   *  `[]`/absent on round 1. An evaluator spec builder threads these forward as repeatable
   *  `--prior-blocking <path>` so a re-grade verifies settled blocking ground rather than
   *  re-litigating it. Holdout-safe: each verdict file is already holdout-redacted by the runner. */
  priorVerdictPaths?: string[];
}

/** A per-round decision function: the SAME signature as {@link decideFromEvaluation}. Injecting one
 *  lets a host (e.g. `sparra conduct`'s judgment-strategy seam) consult a pluggable strategy at the
 *  judgment point without reimplementing the round loop. Defaults to {@link decideFromEvaluation}. */
export type DecideFn = (
  evaluator: ParentSummary,
  state: { consecutiveFailures: number },
  config: { pivotAfterFailures: number; requireCrossModel: boolean },
) => Decision;

/** Config for one build cycle: how to build each round's generator/evaluator spec, and the loop's
 *  stopping/pivoting thresholds. */
export interface BuildCycleConfig {
  generatorSpec: (ctx: RoundContext) => RunRoleSpec;
  evaluatorSpec: (ctx: RoundContext) => RunRoleSpec;
  /** Max rounds before giving up. Default 5. */
  maxRounds?: number;
  /** Consecutive evaluator FAILs before pivoting instead of revising. Default 2. */
  pivotAfterFailures?: number;
  /** Reject a same-model "pass" as acceptance evidence. Default true. */
  requireCrossModel?: boolean;
  /** Injected per-round decision strategy. Defaults to {@link decideFromEvaluation} (identical
   *  behavior when omitted), so a host can supply a judgment strategy at the decision point. */
  decide?: DecideFn;
}

/** The decision made after one round's evaluation. */
export type Decision = "accept" | "revise" | "pivot" | "grade-not-independent" | "inconclusive";

/** The terminal outcome of a whole build cycle. */
export type CycleOutcome = "accepted" | "exhausted" | "grade-not-independent" | "inconclusive";

/** One round's generator/evaluator summaries and the decision reached from them. */
export interface RoundRecord {
  round: number;
  generator: ParentSummary;
  evaluator: ParentSummary;
  decision: Decision;
}

/** The full result of a build cycle. */
export interface BuildCycleResult {
  outcome: CycleOutcome;
  rounds: RoundRecord[];
  finalVerdict?: ParentSummary;
}

const DEFAULT_MAX_ROUNDS = 5;
const DEFAULT_PIVOT_AFTER_FAILURES = 2;
const DEFAULT_REQUIRE_CROSS_MODEL = true;

/**
 * PURE decision function: given one evaluator {@link ParentSummary} and the running
 * `consecutiveFailures` count, decide what to do next. Never touches I/O.
 *
 * Order of checks (per the cross-model gate first): a `sameModelGrade === true` evaluation is
 * rejected as acceptance evidence EVEN IF `verdict === "pass"` — a same-model grader collapsing the
 * gate is not a pass, it's a configuration problem the caller must fix with a distinct grader.
 */
export function decideFromEvaluation(
  evaluator: ParentSummary,
  state: { consecutiveFailures: number },
  config: { pivotAfterFailures: number; requireCrossModel: boolean },
): Decision {
  if (config.requireCrossModel && evaluator.sameModelGrade === true) {
    return "grade-not-independent";
  }
  if (evaluator.verdict === "pass") {
    return "accept";
  }
  if (evaluator.verdict === "fail") {
    return state.consecutiveFailures + 1 >= config.pivotAfterFailures ? "pivot" : "revise";
  }
  // null/undefined verdict — abnormal (e.g. the role errored before producing a verdict).
  return "inconclusive";
}

/**
 * Run one build cycle: generate → evaluate → decide, up to `config.maxRounds`. Orchestrates ONLY
 * via `deps.runRole` — never spawns a process or parses an envelope itself; the injected runner
 * (core `runRole`, or a test fake) is the sole boundary that ever touches a raw payload.
 */
export async function runBuildCycle(
  deps: { runRole: RoleRunner },
  config: BuildCycleConfig,
): Promise<BuildCycleResult> {
  const maxRounds = config.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const pivotAfterFailures = config.pivotAfterFailures ?? DEFAULT_PIVOT_AFTER_FAILURES;
  const requireCrossModel = config.requireCrossModel ?? DEFAULT_REQUIRE_CROSS_MODEL;
  const decide = config.decide ?? decideFromEvaluation;

  const rounds: RoundRecord[] = [];
  let round = 1;
  let consecutiveFailures = 0;
  let feedback: string[] = [];
  let pivoting = false;
  let lastEvaluator: ParentSummary | undefined;
  // Each graded round's persisted verdict path, threaded forward as the NEXT round's evaluator
  // `--prior-blocking` (settled-ground re-grade). Paths only — never contents.
  const priorVerdictPaths: string[] = [];

  while (round <= maxRounds) {
    const ctx: RoundContext = { round, feedback, pivoting, priorVerdictPaths: [...priorVerdictPaths] };
    const generator = await deps.runRole(config.generatorSpec(ctx));
    const evaluator = await deps.runRole(config.evaluatorSpec(ctx));
    lastEvaluator = evaluator;
    if (evaluator.verdictPath) priorVerdictPaths.push(evaluator.verdictPath);

    const decision = decide(
      evaluator,
      { consecutiveFailures },
      { pivotAfterFailures, requireCrossModel },
    );
    rounds.push({ round, generator, evaluator, decision });

    if (decision === "accept") {
      return { outcome: "accepted", rounds, finalVerdict: evaluator };
    }
    if (decision === "grade-not-independent") {
      return { outcome: "grade-not-independent", rounds, finalVerdict: evaluator };
    }
    if (decision === "inconclusive") {
      return { outcome: "inconclusive", rounds, finalVerdict: evaluator };
    }
    if (decision === "revise") {
      consecutiveFailures++;
      feedback = evaluator.blocking ?? [];
      pivoting = false;
      round++;
      continue;
    }
    // decision === "pivot"
    consecutiveFailures = 0;
    feedback = evaluator.blocking ?? [];
    pivoting = true;
    round++;
  }

  return { outcome: "exhausted", rounds, finalVerdict: lastEvaluator };
}
