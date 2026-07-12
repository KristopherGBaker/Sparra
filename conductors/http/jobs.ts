/**
 * `conductors/http/jobs.ts` — the in-memory job store.
 *
 * A `Job` tracks one triggered Sparra run (build/reflect/role/…) that a later unit will drive. This
 * unit only stores lifecycle + log + a place for a holdout-safe `result`; no disk persistence, no
 * subprocess spawning. The clock is injected so tests are deterministic.
 */

export type JobStatus = "running" | "succeeded" | "failed" | "canceled";

export interface Job {
  id: string;
  /** What kind of run this is, e.g. "build". */
  kind: string;
  /** The allowlisted project root this run targets, if any. */
  root?: string;
  status: JobStatus;
  /** Appended run log. */
  log: string;
  exitCode?: number;
  /** Holdout-safe summary, set by a later unit. */
  result?: unknown;
  createdAt: number;
}

export interface CreateJobInput {
  kind: string;
  root?: string;
  /** Override the generated id (tests/determinism). */
  id?: string;
}

export interface FinishInput {
  status: Exclude<JobStatus, "running" | "canceled">;
  exitCode?: number;
}

export interface JobStoreOptions {
  /** Max retained jobs; older jobs are evicted by insertion order when exceeded. Default 50. */
  lastNJobs?: number;
  /** Injected clock. Default `Date.now`. */
  now?: () => number;
  /** Injected id generator. Default `crypto.randomUUID`. */
  genId?: () => string;
}

/** In-memory, bounded, insertion-ordered job store. */
export class JobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly cancels = new Map<string, () => void>();
  private readonly lastNJobs: number;
  private readonly now: () => number;
  private readonly genId: () => string;

  constructor(options: JobStoreOptions = {}) {
    this.lastNJobs = Math.max(1, options.lastNJobs ?? 50);
    this.now = options.now ?? Date.now;
    this.genId = options.genId ?? (() => globalThis.crypto.randomUUID());
  }

  createJob(input: CreateJobInput): Job {
    const id = input.id ?? this.genId();
    const job: Job = {
      id,
      kind: input.kind,
      status: "running",
      log: "",
      createdAt: this.now(),
    };
    if (input.root !== undefined) job.root = input.root;
    this.jobs.set(id, job);
    this.evictOverflow();
    return job;
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  listJobs(): Job[] {
    return [...this.jobs.values()];
  }

  appendLog(id: string, chunk: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.log += chunk;
  }

  /** Transition a running job to a terminal `succeeded`/`failed` state. */
  finish(id: string, input: FinishInput): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = input.status;
    if (input.exitCode !== undefined) job.exitCode = input.exitCode;
  }

  /** Register a cancel callback (e.g. to kill a subprocess) invoked by {@link cancelJob}. */
  registerCancel(id: string, cancel: () => void): void {
    this.cancels.set(id, cancel);
  }

  /**
   * Cancel a job: invoke its registered `cancel()` callback (if any) and mark it `canceled`. A job
   * with no callback is still marked canceled. Returns the job (or undefined if unknown).
   */
  cancelJob(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const cancel = this.cancels.get(id);
    if (cancel) {
      try {
        cancel();
      } catch {
        // A throwing cancel callback must not prevent the job from being marked canceled.
      }
      this.cancels.delete(id);
    }
    job.status = "canceled";
    return job;
  }

  /** Keep at most `lastNJobs`; evict OLDEST by insertion order (Map preserves it). */
  private evictOverflow(): void {
    while (this.jobs.size > this.lastNJobs) {
      const oldest = this.jobs.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.jobs.delete(oldest);
      this.cancels.delete(oldest);
    }
  }
}
