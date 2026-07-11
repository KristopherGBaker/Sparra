import {
  runBuildCycle,
  type BuildCycleConfig,
  type BuildCycleResult,
  type CycleOutcome,
  type RoleRunner,
} from "./loop.ts";
import type { RunRoleSpec } from "./roleClient.ts";
import type { ParentSummary } from "./summary.ts";

/**
 * `conductors/core/contract.ts` — the host-agnostic CONTRACT phase: run a `contract-evaluator`
 * until it AGREES (or rounds run out), then compose it with `runBuildCycle` into a full
 * `contract → generate → evaluate → decide` unit.
 *
 * Like `loop.ts`, this module never spawns a process or parses an envelope itself — it only calls
 * the injected {@link RoleRunner} and reasons over the {@link ParentSummary} it returns. Agreement is
 * detected SOLELY from the structured `contractAgreed` boolean; the critique prose is never read —
 * only its `outPath` is threaded forward to the next round's spec builder.
 */

/** Per-round context handed to a {@link ContractNegotiationConfig.contractEvaluatorSpec}, so each
 *  round can add `--prior-critique <path>` args for the prior rounds' critiques. */
export interface ContractRoundContext {
  round: number;
  /** Paths (never contents) of prior rounds' non-agreed critiques, in round order. `[]` on round 1. */
  priorCritiquePaths: string[];
}

/** Config for one contract negotiation: how to build each round's `contract-evaluator` spec, and
 *  the loop's stopping threshold. */
export interface ContractNegotiationConfig {
  contractEvaluatorSpec: (ctx: ContractRoundContext) => RunRoleSpec;
  /** Max rounds before giving up. Default 3. */
  maxRounds?: number;
}

/** One round's contract-evaluator summary and whether it signalled agreement. */
export interface ContractRoundRecord {
  round: number;
  evaluator: ParentSummary;
  agreed: boolean;
}

/** The full result of a contract negotiation. */
export interface ContractNegotiationResult {
  agreed: boolean;
  rounds: ContractRoundRecord[];
  /** Paths of every non-agreed round's critique, in round order (the same list threaded into the
   *  final round's `ContractRoundContext`). */
  critiquePaths: string[];
}

const DEFAULT_MAX_ROUNDS = 3;

/**
 * Run the CONTRACT phase: call `config.contractEvaluatorSpec` via `deps.runRole` up to
 * `config.maxRounds` (default 3), detecting agreement from `evaluator.contractAgreed === true`.
 * Each non-agreed round's `outPath` (if present) is threaded forward as the next round's
 * `priorCritiquePaths` — the critique FILE is never read here.
 */
export async function negotiateContract(
  deps: { runRole: RoleRunner },
  config: ContractNegotiationConfig,
): Promise<ContractNegotiationResult> {
  const maxRounds = config.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const rounds: ContractRoundRecord[] = [];
  const priorCritiquePaths: string[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const ctx: ContractRoundContext = { round, priorCritiquePaths: [...priorCritiquePaths] };
    const spec = config.contractEvaluatorSpec(ctx);
    const evaluator = await deps.runRole(spec);
    const agreed = evaluator.contractAgreed === true;
    rounds.push({ round, evaluator, agreed });

    if (agreed) {
      return { agreed: true, rounds, critiquePaths: priorCritiquePaths };
    }
    if (evaluator.outPath) {
      priorCritiquePaths.push(evaluator.outPath);
    }
  }

  return { agreed: false, rounds, critiquePaths: priorCritiquePaths };
}

/** Config for a full unit: negotiate the contract, then (if agreed, or `proceedIfNotAgreed`) run
 *  the existing generate → evaluate → decide build cycle over it. */
export interface RunUnitConfig extends BuildCycleConfig {
  contract: ContractNegotiationConfig;
  /** Proceed to `runBuildCycle` even when the contract negotiation was not agreed (rounds
   *  exhausted). Default false — the caller may still choose to proceed with the strongest
   *  proposal, but only by explicit opt-in. */
  proceedIfNotAgreed?: boolean;
}

/** The terminal outcome of a full unit run: either the contract phase stopped it
 *  (`"contract-not-agreed"`) or it mirrors the underlying build cycle's outcome. */
export type UnitOutcome = CycleOutcome | "contract-not-agreed";

/** The full result of a unit run. */
export interface RunUnitResult {
  outcome: UnitOutcome;
  contract: ContractNegotiationResult;
  cycle?: BuildCycleResult;
}

/**
 * Run a full unit: negotiate the contract, then — only if agreed (or `config.proceedIfNotAgreed`)
 * — run the existing `runBuildCycle` over `config`. Reuses `runBuildCycle` rather than
 * reimplementing the generate → evaluate → decide loop.
 */
export async function runUnit(
  deps: { runRole: RoleRunner },
  config: RunUnitConfig,
): Promise<RunUnitResult> {
  const contract = await negotiateContract(deps, config.contract);

  if (!contract.agreed && !config.proceedIfNotAgreed) {
    return { outcome: "contract-not-agreed", contract };
  }

  const cycle = await runBuildCycle(deps, config);
  return { outcome: cycle.outcome, contract, cycle };
}
