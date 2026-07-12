import fsp from "node:fs/promises";
import path from "node:path";

import { ensureDir } from "../util/io.ts";
import type { ConductRunState } from "./types.ts";

/**
 * `src/conduct/runState.ts` — the atomic, incremental `run.json` writer.
 *
 * Writes are serialized through a single promise chain (units run concurrently, so their
 * completion callbacks can race) and land via temp-file + rename, so a crashed run never leaves a
 * half-written / corrupt `run.json` — a reader either sees the prior complete document or the next
 * complete one, never a torn write.
 */

/** The run directory for a conduct run: `<root>/.sparra/conduct/<runId>/`. */
export function conductRunDir(sparraDir: string, runId: string): string {
  return path.join(sparraDir, "conduct", runId);
}

/** The `run.json` path inside a run directory. */
export function runStatePath(runDir: string): string {
  return path.join(runDir, "run.json");
}

/**
 * Serializing, atomic run-state writer. Every `write` is queued behind the previous one and lands
 * via `<file>.tmp.<n>` → rename, so concurrent unit-completion callbacks can't interleave a torn
 * write. `runDir` is created on demand.
 */
export class RunStateWriter {
  private chain: Promise<void> = Promise.resolve();
  private seq = 0;
  constructor(private readonly runDir: string) {}

  /** Queue an atomic write of `state`. The document is SNAPSHOTTED synchronously here, so a queued
   *  write reflects the state at call time even though later mutations may already be in flight.
   *  Resolves when THIS write has landed. */
  write(state: ConductRunState): Promise<void> {
    const body = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + "\n";
    const next = this.chain.then(() => this.writeNow(body));
    // Keep the chain alive even if a write rejects, so later writes still run.
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async writeNow(body: string): Promise<void> {
    await ensureDir(this.runDir);
    const file = runStatePath(this.runDir);
    const tmp = `${file}.tmp.${process.pid}.${this.seq++}`;
    await fsp.writeFile(tmp, body, "utf8");
    await fsp.rename(tmp, file);
  }
}
