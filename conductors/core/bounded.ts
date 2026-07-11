/**
 * `conductors/core/bounded.ts` — the generic bounded-concurrency pump shared by `pool.ts`
 * (role-runs) and `scheduler.ts` (whole units). Pulled out so both callers run the exact same
 * queueing/ordering/peak-tracking logic instead of two copies drifting apart.
 *
 * Host-agnostic and I/O-free: `mapBounded` never spawns a process or parses anything — it just
 * fans a `worker` out over `items` at most `concurrency` at a time.
 */

/** Live pool state, reported on every spawn and completion. */
export interface BoundedState {
  active: number;
  peak: number;
  completed: number;
  total: number;
}

export interface BoundedOptions {
  /** Max workers in flight at once. Excess items QUEUE (FIFO), never drop. Default 3. */
  concurrency?: number;
  /** Optional observer of live pool state. */
  onState?: (state: BoundedState) => void;
}

/** Ordered results plus the maximum number of workers that were ever in flight at once. */
export type BoundedResults<R> = R[] & { peakConcurrency: number };

/**
 * Run `worker` over `items`, at most `options.concurrency` (default 3) at a time. Excess items
 * QUEUE (FIFO) rather than dropping; results preserve INPUT order (not completion order). The
 * returned array carries a non-enumerable `peakConcurrency` recording the max concurrency ever
 * reached, so a caller can assert the bound.
 *
 * `mapBounded` only rejects a worker's own item — never the whole batch — when the CALLER's
 * `worker` catches its own failure and resolves to an error-shaped value (the pattern both
 * `pool.ts` and `scheduler.ts` use). If instead a worker's returned promise REJECTS uncaught,
 * `mapBounded` itself rejects with that same error (mirroring `Promise.all`, and avoiding a silent
 * hole in `results` plus a dangling unhandled rejection) — so the CALLER decides which behavior it
 * wants purely by whether `worker` catches internally. Either way `mapBounded` always terminates:
 * it settles once either every item has resolved, or one has rejected uncaught.
 */
export function mapBounded<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  options: BoundedOptions = {},
): Promise<BoundedResults<R>> {
  const bound = Math.max(1, options.concurrency ?? 3);
  const onState = options.onState;
  const results = new Array<R>(items.length);

  const withPeak = (peak: number): BoundedResults<R> => {
    Object.defineProperty(results, "peakConcurrency", { value: peak, enumerable: false });
    return results as BoundedResults<R>;
  };

  if (items.length === 0) return Promise.resolve(withPeak(0));

  return new Promise<BoundedResults<R>>((resolve, reject) => {
    let active = 0;
    let peak = 0;
    let nextIndex = 0;
    let completed = 0;

    const report = () => onState?.({ active, peak, completed, total: items.length });

    const pump = (): void => {
      while (active < bound && nextIndex < items.length) {
        const index = nextIndex++;
        const item = items[index]!;
        active++;
        peak = Math.max(peak, active);
        report();

        worker(item, index)
          .then(
            (value) => {
              results[index] = value;
            },
            (err: unknown) => {
              // Uncaught worker rejection: fail the whole batch (a Promise that has already
              // settled ignores further resolve/reject calls, so this is a safe no-op if the
              // batch already settled via an earlier rejection).
              reject(err);
            },
          )
          .finally(() => {
            active--;
            completed++;
            report();
            if (completed === items.length) resolve(withPeak(peak));
            else pump();
          });
      }
    };

    pump();
  });
}
