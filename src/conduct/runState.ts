import { realpathSync } from "node:fs";
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

/**
 * Validate a `runId` as an OPAQUE, single-segment identifier BEFORE any path is built from it — the
 * guard that keeps `conduct --resume <runId>` / `--decide <runId>` from escaping `.sparra/conduct/`
 * or mutating an unrelated `run.json`. Rejects: empty, any path separator (`/`, `\`), `..` (traversal),
 * absolute paths, a leading `-` (arg-injection), and anything outside `[A-Za-z0-9._-]` (`newRunId`
 * only ever emits that set). An allowlist — default-deny. Pure (no I/O), so a bad id is refused with
 * zero side effects.
 */
export function isSafeRunId(runId: unknown): runId is string {
  if (typeof runId !== "string" || runId.length === 0) return false;
  if (/[/\\]/.test(runId)) return false;
  if (runId.includes("..")) return false;
  if (path.isAbsolute(runId)) return false;
  if (runId.startsWith("-")) return false;
  return /^[A-Za-z0-9._-]+$/.test(runId);
}

/** The run directory for a conduct run: `<root>/.sparra/conduct/<runId>/`. */
export function conductRunDir(sparraDir: string, runId: string): string {
  return path.join(sparraDir, "conduct", runId);
}

/** The `run.json` path inside a run directory. */
export function runStatePath(runDir: string): string {
  return path.join(runDir, "run.json");
}

/**
 * Resolve `runId` to its run directory, requiring the result to stay CONTAINED within
 * `<sparraDir>/conduct/` even after symlink resolution. `isSafeRunId` already refuses `..`/separators
 * on the opaque id, but a run dir could itself be (or contain) a symlink planted to point outside the
 * conduct tree; realpathing both the conduct root and the run dir and re-asserting segment containment
 * closes that escape BEFORE any read. Returns the realpath'd, contained run dir, or `undefined` when
 * the id is unsafe, the run dir does not exist, or the resolved dir escapes the conduct root. Read-only
 * (realpath only — never a mutation), so an unsafe/unknown request has ZERO side effects.
 */
export function safeConductRunDir(sparraDir: string, runId: string): string | undefined {
  if (!isSafeRunId(runId)) return undefined;
  const conductDir = path.join(sparraDir, "conduct");
  let realConduct: string;
  try {
    realConduct = realpathSync(conductDir);
  } catch {
    return undefined; // no conduct dir at all → no run to resolve
  }
  let realRun: string;
  try {
    realRun = realpathSync(path.join(conductDir, runId));
  } catch {
    return undefined; // run dir doesn't exist (unknown run)
  }
  // `realRun` must be a direct-or-nested child of the realpath'd conduct root, at a SEGMENT boundary —
  // reject `` (the root itself), `..`, an actual parent step, or an absolute (different-root) relative.
  const rel = path.relative(realConduct, realRun);
  if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    return undefined;
  }
  return realRun;
}

/**
 * True iff the file at `runDir` + `segments` is a DIRECT (non-symlink) file at exactly that location
 * within the run tree. A run dir can be realpath-CONTAINED (see {@link safeConductRunDir}) yet still
 * hold a symlink FILE — a `run.json` or `<seq>.request.json` planted as a link to a holdout
 * brief/contract/verdict (which lives INSIDE the conduct tree, so dir-containment alone does NOT catch
 * it) or to a file outside the tree entirely; a symlinked `decisions/` DIR is the same escape one level
 * up. A naive read would follow the link and leak the redirected file's contents. We realpath `runDir`
 * ONCE, then require `realpathSync(runDir/…/segments) === realRunDir/…/segments`: any symlink anywhere
 * in the `segments` tail (leaf file OR an intermediate dir) makes the resolved path diverge from the
 * expected in-tree location and is refused fail-closed. Robust to a non-realpath'd `runDir` (e.g. a
 * macOS `/var`→`/private/var` ancestor): the expected side is built from the realpath'd run dir too.
 * A missing path throws internally → `false`. Read-only.
 */
export function isDirectRunFile(runDir: string, ...segments: string[]): boolean {
  try {
    const realRun = realpathSync(runDir);
    const expected = path.join(realRun, ...segments);
    return realpathSync(path.join(runDir, ...segments)) === expected;
  } catch {
    return false;
  }
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
