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

export interface PoolOptions {
  /** Max role-runs in flight at once. Excess jobs QUEUE (FIFO), never drop. Default 3. */
  concurrency?: number;
  /** Optional observer of live pool state, fired on every spawn and completion. */
  onState?: (state: { active: number; peak: number; completed: number; total: number }) => void;
}

/** Ordered results plus the maximum number of role-runs that were ever in flight at once. */
export type PoolResults = RoleJobResult[] & { peakConcurrency: number };

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
 * Results preserve input order (not completion order). A failing job resolves to `{ id, error }`
 * and never rejects the whole batch. The returned array also carries a non-enumerable
 * `peakConcurrency` recording the max role-runs ever in flight, so a caller can assert the bound.
 */
export function runRolesConcurrently(jobs: RoleJob[], options: PoolOptions = {}): Promise<PoolResults> {
  const bound = Math.max(1, options.concurrency ?? 3);
  const onState = options.onState;
  const results = new Array<RoleJobResult>(jobs.length);

  const withPeak = (peak: number): PoolResults => {
    Object.defineProperty(results, "peakConcurrency", { value: peak, enumerable: false });
    return results as PoolResults;
  };

  if (jobs.length === 0) return Promise.resolve(withPeak(0));

  return new Promise<PoolResults>((resolve) => {
    let active = 0;
    let peak = 0;
    let nextIndex = 0;
    let completed = 0;

    const report = () => onState?.({ active, peak, completed, total: jobs.length });

    const pump = (): void => {
      while (active < bound && nextIndex < jobs.length) {
        const index = nextIndex++;
        const job = jobs[index]!;
        active++;
        peak = Math.max(peak, active);
        report();

        runRole(job.spec)
          .then(
            (summary) => {
              results[index] = { id: job.id, summary };
            },
            (err: unknown) => {
              results[index] = { id: job.id, error: err instanceof Error ? err.message : String(err) };
            },
          )
          .finally(() => {
            active--;
            completed++;
            report();
            if (completed === jobs.length) resolve(withPeak(peak));
            else pump();
          });
      }
    };

    pump();
  });
}
