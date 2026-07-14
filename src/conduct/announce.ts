/**
 * `src/conduct/announce.ts` — the stable stdout announcement lines for `sparra conduct`.
 *
 * TWO announcement lines are the SINGLE choke point for what a conduct child tells its parent (the
 * HTTP bridge) over the untrusted, potentially-logged stdout channel:
 *
 *  1. run-START (`conduct: run-start <runId> → <runDir>`): emitted at START (in `runConduct`), long
 *     before the run-END `run: <runId> → <runDir>` summary, so the bridge can learn a spawned child's
 *     `runId`/`runDir` as soon as the run begins. The bridge NEVER trusts the announced `runDir` text —
 *     it re-derives `<root>/.sparra/conduct/<runId>` and realpath-guards it.
 *  2. decision-parked (`conduct: decision-parked <runId> <seq>`): emitted every time the decision engine
 *     PARKS a judgment point, so the bridge can emit a `decision_parked` event on `GET /events`. This
 *     line carries ONLY `runId` + `seq` — a safe id and a number — and NEVER the decision `question`,
 *     `kind`, or any free text. Decision questions are `ParentSummary`-derived and holdout-safe, but we
 *     still keep free text OFF the wire line (stdout can be logged/mirrored anywhere); the bridge reads
 *     `question`/`kind` ONLY from the realpath-guarded `<seq>.request.json` file under the allowlisted
 *     root. {@link formatDecisionParkedAnnouncement}'s signature accepts only `(runId, seq)`, so no
 *     free-text field can be smuggled onto the line by construction.
 *
 * Each line's emit + parse stay in lockstep by construction (one `format…`/`parse…` pair per line, over
 * one shared regex) — never duplicate the pattern.
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

/** The stable prefix of the decision-parked announcement line (distinct from `conduct: run-start`). */
export const DECISION_PARKED_PREFIX = "conduct: decision-parked";

/**
 * Match a decision-parked announcement line, capturing `runId` (group 1, whitespace-free) and `seq`
 * (group 2, digits). The prefix is matched wherever it appears in the line — NOT start-anchored — so a
 * decorated child line (the phase logger prepends a `› ` marker, and may add ANSI color) still parses,
 * exactly like {@link RUN_START_RE}. `\s*$` tolerates a trailing CR/space on a `\r\n`-terminated line.
 */
export const DECISION_PARKED_RE = /conduct: decision-parked (\S+) (\d+)\s*$/;

/** Format the decision-parked announcement line for `runId` + `seq`. The signature accepts ONLY these
 *  two values — there is deliberately NO free-text/question parameter, so the wire line can never carry
 *  a `question`/`kind` (the holdout-safety rule; see the module doc). */
export function formatDecisionParkedAnnouncement(runId: string, seq: number): string {
  return `${DECISION_PARKED_PREFIX} ${runId} ${seq}`;
}

/** A parsed decision-parked announcement — runId + seq ONLY (never any free text). */
export interface DecisionParkedAnnouncement {
  runId: string;
  seq: number;
}

/**
 * Parse a single line as a decision-parked announcement, returning `{runId, seq}` or `undefined`. The
 * line is trimmed of trailing CR/whitespace first (so a `\r\n`-terminated child line still matches);
 * `seq` is parsed as an integer and a non-numeric/NaN seq yields `undefined`.
 */
export function parseDecisionParkedAnnouncement(line: string): DecisionParkedAnnouncement | undefined {
  const m = DECISION_PARKED_RE.exec(line.trim());
  if (!m) return undefined;
  const seq = Number.parseInt(m[2]!, 10);
  if (Number.isNaN(seq)) return undefined;
  return { runId: m[1]!, seq };
}
