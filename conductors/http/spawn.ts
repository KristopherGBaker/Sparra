/**
 * `conductors/http/spawn.ts` — the tracked subprocess launcher for the `sparra` CLI, plus the
 * per-target mutation lock.
 *
 * Every phase endpoint (and every WRITING conductor call) drives a long-running `sparra` process. This
 * module owns the two invariants that make that safe to expose over HTTP:
 *   - the child's stdout/stderr are streamed verbatim into the job log via `appendLog`. That log is
 *     Sparra's OWN phase log — already holdout-redacted by Sparra itself — so we add NO extra
 *     redaction here, but we also never surface a trace dir or verdict file through it.
 *   - a {@link TargetLock} admits at most ONE in-flight MUTATING job per resolved target, because
 *     `state.json` is not concurrency-safe across builds of one root. A second writer for a locked
 *     target is rejected (409) rather than racing.
 *
 * The child spawner is INJECTED so tests drive a fake child with no real process.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { Job, JobStore } from "./jobs.ts";

/** How long to wait after SIGTERM before escalating to SIGKILL. */
const KILL_GRACE_MS = 5_000;

/** The minimal child-process surface `spawnPhase` uses — satisfied by `node:child_process`'s
 *  `ChildProcess` and by a test fake alike. */
export interface SpawnedChild {
  stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(event: "data", cb: (chunk: Buffer | string) => void): void } | null;
  on(event: "close", cb: (code: number | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** The injectable spawner. Production wires `node:child_process`'s `spawn`; tests wire a fake. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => SpawnedChild;

/** Options for one tracked phase spawn. */
export interface SpawnPhaseOptions {
  /** Sparra binary. Default: `$SPARRA_BIN` → the repo's `bin/sparra.mjs`. */
  sparraBin?: string;
  /** Argv passed to the sparra CLI (e.g. `["build","--fresh"]`). */
  args: string[];
  /** Working directory — ALWAYS the resolved, guarded root. */
  cwd: string;
  /** Extra env merged over `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Injected collaborators for {@link spawnPhase}. */
export interface SpawnPhaseDeps {
  jobs: JobStore;
  /** The child spawner; defaults to `node:child_process`'s `spawn`. */
  spawn?: SpawnFn;
  /** Called exactly once when the job settles (close/error/cancel) — releases the mutation lock. */
  release?: () => void;
}

/** The repo's own `bin/sparra.mjs`, resolved relative to THIS module (not a cwd). */
function repoSparraBin(): string {
  return fileURLToPath(new URL("../../bin/sparra.mjs", import.meta.url));
}

/** Resolve the command + argv to actually exec: a `.mjs/.cjs/.js` bin runs under the current node,
 *  anything else is treated as an executable on PATH. Mirrors `conductors/core/roleClient.ts`. */
function resolveCommand(bin: string, args: string[]): { command: string; commandArgs: string[] } {
  if (/\.[cm]?js$/.test(bin)) {
    return { command: process.execPath, commandArgs: [bin, ...args] };
  }
  return { command: bin, commandArgs: args };
}

/**
 * Spawn the `sparra` CLI for one phase job: stream stdout+stderr into the job log, register a
 * `cancel()` that SIGTERMs then SIGKILLs, and on exit `finish` the job (`succeeded` on exit 0, else
 * `failed`). The mutation lock (via `deps.release`) is freed on close, error, OR cancel — exactly once.
 *
 * Returns the same `job` for convenience. The child runs ASYNC; this call returns as soon as the
 * process is spawned and its handlers are wired.
 */
export function spawnPhase(job: Job, options: SpawnPhaseOptions, deps: SpawnPhaseDeps): Job {
  const spawnFn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const bin = options.sparraBin ?? process.env.SPARRA_BIN ?? repoSparraBin();
  const { command, commandArgs } = resolveCommand(bin, options.args);

  const child = spawnFn(command, commandArgs, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });

  // `settled` prevents a late `close` from overwriting a `canceled` job back to `failed`.
  let settled = false;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    deps.release?.();
  };

  // The child's own output is Sparra's already-redacted phase log; we append it verbatim (no extra
  // redaction) but never expose trace dirs / verdict files through any endpoint.
  child.stdout?.on("data", (chunk) => deps.jobs.appendLog(job.id, chunk.toString()));
  child.stderr?.on("data", (chunk) => deps.jobs.appendLog(job.id, chunk.toString()));

  child.on("error", (err) => {
    deps.jobs.appendLog(job.id, `\n[bridge] failed to spawn sparra: ${err.message}\n`);
    if (!settled) {
      settled = true;
      deps.jobs.finish(job.id, { status: "failed" });
    }
    release();
  });

  child.on("close", (code) => {
    release();
    if (settled) return; // already canceled — keep the canceled status
    settled = true;
    deps.jobs.finish(job.id, {
      status: code === 0 ? "succeeded" : "failed",
      ...(code !== null ? { exitCode: code } : {}),
    });
  });

  deps.jobs.registerCancel(job.id, () => {
    // Mark settled FIRST so the eventual `close` doesn't flip the canceled job to failed.
    settled = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore — the process may already be gone
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, KILL_GRACE_MS);
    // Don't keep the event loop alive purely for the escalation timer.
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    release();
  });

  return job;
}

/**
 * The per-target mutation lock: at most ONE in-flight mutating job per resolved root/workspace.
 *
 * WHY: Sparra's `state.json` is not concurrency-safe across builds of a single root, so two
 * simultaneous mutating requests for the same target would corrupt each other. Read-only work
 * (`GET /projects`, evaluator/reviewer role runs) never acquires this.
 */
export class TargetLock {
  /** resolved target → the jobId currently holding the lock. */
  private readonly holders = new Map<string, string>();

  /** Try to acquire the lock for `target` on behalf of `jobId`. On contention, returns the holder's
   *  jobId so the caller can name it in a 409. */
  tryAcquire(target: string, jobId: string): { ok: true } | { ok: false; jobId: string } {
    const existing = this.holders.get(target);
    if (existing !== undefined) return { ok: false, jobId: existing };
    this.holders.set(target, jobId);
    return { ok: true };
  }

  /** Release the lock for `target` (idempotent). */
  release(target: string): void {
    this.holders.delete(target);
  }

  /** The jobId currently holding `target`, or undefined. */
  holder(target: string): string | undefined {
    return this.holders.get(target);
  }
}
