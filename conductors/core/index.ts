/**
 * `conductors/core` — the host-agnostic core for building a Sparra **conductor** (the interactive
 * host that drives the collaborative loop: contract → generate → cross-model evaluate → decide).
 *
 * It provides the pieces that are the SAME regardless of which host conducts (Pi, opencode, a plain
 * program):
 *   - {@link ./summary.ts}  — the holdout wall in code: `toParentSummary` + the type-checked
 *                             allowlist. A conductor exposes only a `ParentSummary` to its context.
 *   - {@link ./roleClient.ts} — `runRole` / `runRoleRaw`: run one role via `sparra … --json` and
 *                             get back the redacted summary.
 *   - {@link ./roleWorker.ts} — a spawnable process boundary for model-driven hosts.
 *   - {@link ./bounded.ts}  — `mapBounded`: the generic bounded-concurrency pump shared by `pool.ts`
 *                             and `scheduler.ts`.
 *   - {@link ./pool.ts}     — `runRolesConcurrently`: bounded-concurrent isolated role-runs, since
 *                             not every host offers them natively.
 *   - {@link ./loop.ts}     — `runBuildCycle` / `decideFromEvaluation`: the generate → cross-model
 *                             evaluate → decide orchestrator, driven over an injected `RoleRunner`.
 *   - {@link ./contract.ts} — `negotiateContract` / `runUnit`: the CONTRACT phase (run a
 *                             `contract-evaluator` until it agrees) composed with `runBuildCycle`
 *                             into a full contract → generate → evaluate → decide unit.
 *   - {@link ./scheduler.ts} — `runUnitsConcurrently`: the multi-unit scheduler — runs several
 *                             independent `runUnit`s bounded-concurrently over the same pump.
 *
 * The canonical envelope itself lives in `src/roleEnvelope.ts` (the runner↔conductor contract);
 * these types re-export it so a host imports one place.
 */

export type { RunRolePayload, PromptDriftNote } from "../../src/roleEnvelope.ts";

export {
  HOLDOUT_BEARING_FIELDS,
  PARENT_SAFE_FIELDS,
  toParentSummary,
  type HoldoutBearingField,
  type ParentSafeField,
  type ParentSummary,
} from "./summary.ts";

export { runRole, runRoleRaw, type RunRoleSpec } from "./roleClient.ts";

export { roleWorkerMain } from "./roleWorker.ts";

export {
  mapBounded,
  type BoundedOptions,
  type BoundedResults,
  type BoundedState,
} from "./bounded.ts";

export {
  runRolesConcurrently,
  type PoolOptions,
  type PoolResults,
  type RoleJob,
  type RoleJobResult,
} from "./pool.ts";

export {
  decideFromEvaluation,
  runBuildCycle,
  type BuildCycleConfig,
  type BuildCycleResult,
  type CycleOutcome,
  type DecideFn,
  type Decision,
  type RoleRunner,
  type RoundContext,
  type RoundRecord,
} from "./loop.ts";

export {
  negotiateContract,
  runUnit,
  type ContractNegotiationConfig,
  type ContractNegotiationResult,
  type ContractRoundContext,
  type ContractRoundRecord,
  type RunUnitConfig,
  type RunUnitResult,
  type UnitOutcome,
} from "./contract.ts";

export {
  runUnitsConcurrently,
  type SchedulerResults,
  type UnitJob,
  type UnitJobResult,
} from "./scheduler.ts";
