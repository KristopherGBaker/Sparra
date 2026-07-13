/**
 * `src/conduct/announce.ts` — the stable run-START announcement line for `sparra conduct`.
 *
 * A conduct run generates its `runId` + `runDir` at START (in `runConduct`), long before the run-END
 * `run: <runId> → <runDir>` summary. The HTTP bridge (`conductors/http`) needs to learn a spawned
 * conduct child's `runId`/`runDir` from its stdout as soon as the run begins — so it can surface that
 * run's parked decisions on `GET /jobs/:id` and route `POST /jobs/:id/decision` at it.
 *
 * This module is the SINGLE choke point for that line's format: `runConduct` emits it via
 * {@link formatRunStartAnnouncement}, and the bridge parses it via {@link parseRunStartAnnouncement}
 * using the SAME {@link RUN_START_RE}. Keep the emit + parse in lockstep by construction — never
 * duplicate the pattern.
 */

/** The stable prefix of the run-START announcement line (distinct from the run-END `run:` summary). */
export const RUN_START_PREFIX = "conduct: run-start";

/**
 * Match a run-START announcement line, capturing `runId` (group 1, whitespace-free) and `runDir`
 * (group 2, the rest of the line). The prefix is matched wherever it appears in the line — NOT
 * start-anchored — so a decorated child line (the phase logger prepends a `› ` marker, and may add
 * ANSI color) still parses; `$` anchors `runDir` to the rest of the line.
 */
export const RUN_START_RE = /conduct: run-start (\S+) → (.+)$/;

/** Format the run-START announcement line for `runId` + `runDir`. */
export function formatRunStartAnnouncement(runId: string, runDir: string): string {
  return `${RUN_START_PREFIX} ${runId} → ${runDir}`;
}

/** A parsed run-START announcement. */
export interface RunStartAnnouncement {
  runId: string;
  runDir: string;
}

/**
 * Parse a single line as a run-START announcement, returning `{runId, runDir}` or `undefined`. The
 * line is trimmed of trailing CR/whitespace first so a `\r\n`-terminated child line still matches.
 */
export function parseRunStartAnnouncement(line: string): RunStartAnnouncement | undefined {
  const m = RUN_START_RE.exec(line.trim());
  if (!m) return undefined;
  return { runId: m[1]!, runDir: m[2]!.trim() };
}
