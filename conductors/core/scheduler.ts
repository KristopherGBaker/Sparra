import { mapBounded, type BoundedOptions, type BoundedResults } from "./bounded.ts";
import { runUnit, type RunUnitConfig, type RunUnitResult } from "./contract.ts";
import type { RoleRunner } from "./loop.ts";

/**
 * `conductors/core/scheduler.ts` — the multi-unit scheduler: run SEVERAL independent units (each a
 * full `runUnit`: contract → generate → evaluate → decide) at once, bounded and collected.
 *
 * Built on the same shared {@link mapBounded} pump as `pool.ts`'s single-role pool, just fanned out
 * one level higher: each queued item here is a WHOLE unit rather than a single role-run. Like every
 * other `conductors/core` module, this one never spawns a process or parses an envelope itself — it
 * only calls `runUnit`, which in turn only calls the injected {@link RoleRunner}; only
 * `RunUnitResult` (itself built entirely from `ParentSummary`s) ever flows through it.
 *
 * SAFETY INVARIANT: units run CONCURRENTLY (bounded), but WITHIN a unit the roles stay SEQUENTIAL —
 * `runUnit` itself runs contract negotiation and the build cycle's generate/evaluate rounds one at a
 * time, exactly as it does standalone. Concurrency here is only ACROSS units. Each `UnitJob.config`'s
 * specs (contract-evaluator/generator/evaluator) MUST target a DISTINCT workspace / unitWorktree —
 * two writers must never share a workspace. The scheduler only bounds and collects; picking distinct
 * workspaces per unit is the CALLER's responsibility (this module never inspects or defaults them).
 */

/** One queued unit: a caller id plus the full unit config it should run through {@link runUnit}. */
export interface UnitJob {
  id: string;
  config: RunUnitConfig;
}

/** Result for one unit job, in the same position as its input job. */
export type UnitJobResult = { id: string; result: RunUnitResult } | { id: string; error: string };

/** Ordered results plus the maximum number of units that were ever running at once. */
export type SchedulerResults = BoundedResults<UnitJobResult>;

/**
 * Run `jobs` through {@link runUnit}, at most `options.concurrency` (default 3) units at once.
 *
 * Implemented via the shared {@link mapBounded} pump, so it inherits the same queueing (excess jobs
 * QUEUE, never drop), input-order results, and non-enumerable `peakConcurrency` as `pool.ts`. A
 * single unit that throws resolves to `{ id, error }` — the worker below catches `runUnit`'s
 * rejection itself — and never rejects the whole batch; the other units still complete.
 *
 * See the module-level SAFETY INVARIANT above: concurrency is across units only, never within one;
 * and distinct workspaces per unit are the caller's responsibility.
 */
export function runUnitsConcurrently(
  deps: { runRole: RoleRunner },
  jobs: UnitJob[],
  options: BoundedOptions = {},
): Promise<SchedulerResults> {
  return mapBounded<UnitJob, UnitJobResult>(
    jobs,
    (job) =>
      runUnit(deps, job.config).then(
        (result): UnitJobResult => ({ id: job.id, result }),
        (err: unknown): UnitJobResult => ({
          id: job.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      ),
    options,
  );
}
