import { mapBounded, type BoundedOptions, type BoundedResults } from "./bounded.ts";
import { type RunRoleSpec, runRole } from "./roleClient.ts";
import type { ParentSummary } from "./summary.ts";

/** One unit of work for the pool: a caller id plus the role invocation. */
export interface RoleJob {
  id: string;
  spec: RunRoleSpec;
}

/** Result for one job, in the same position as its input job. */
export type RoleJobResult =
  | { id: string; summary: ParentSummary }
  | { id: string; error: string };

/** Same shape as {@link BoundedOptions} — kept as this module's own name since it's its public API. */
export type PoolOptions = BoundedOptions;

/** Ordered results plus the maximum number of role-runs that were ever in flight at once. */
export type PoolResults = BoundedResults<RoleJobResult>;

/**
 * Run `jobs` through {@link runRole}, at most `concurrency` at a time.
 *
 * Host-agnostic concurrency: Sparra's conductor hosts (Pi's independent sessions, opencode's
 * *sequential* built-in subagents) don't all offer bounded-parallel isolated role-runs, so a
 * conductor owns the scheduling here in plain code. Each job runs via `runRole`, which spawns its
 * own `sparra … --json` child process and returns ONLY the redacted {@link ParentSummary} — so no
 * raw envelope is ever retained across jobs, and one job's holdout-bearing output can never reach
 * another's result.
 *
 * Implemented via the shared {@link mapBounded} pump (`bounded.ts`) — the queueing/ordering/peak
 * bookkeeping lives in exactly one place, shared with `scheduler.ts`. Results preserve input order
 * (not completion order). A failing job resolves to `{ id, error }` and never rejects the whole
 * batch: the worker below catches `runRole`'s rejection itself before `mapBounded` ever sees it. The
 * returned array also carries a non-enumerable `peakConcurrency` recording the max role-runs ever in
 * flight, so a caller can assert the bound.
 */
export function runRolesConcurrently(jobs: RoleJob[], options: PoolOptions = {}): Promise<PoolResults> {
  return mapBounded<RoleJob, RoleJobResult>(
    jobs,
    (job) =>
      runRole(job.spec).then(
        (summary): RoleJobResult => ({ id: job.id, summary }),
        (err: unknown): RoleJobResult => ({
          id: job.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      ),
    options,
  );
}
