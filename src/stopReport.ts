import { ensureDir, writeText } from "./util/io.ts";
import { warn as defaultWarn } from "./util/log.ts";
import path from "node:path";
import type { AssertionId } from "./build/types.ts";

/**
 * `src/stopReport.ts` — structured stop reports for every TERMINAL NON-PASS outcome.
 *
 * When a build item or a conduct unit stops without accepting (budget exhausted, rounds exhausted,
 * blocked/inconclusive, human/conductor abandon, error), we do NOT reduce that to a status enum and
 * one memory line. Instead we write a human-readable Markdown artifact that states, plainly: WHY it
 * stopped (which cap tripped + its configured value, or rounds exhausted, or the error), the best
 * score achieved and in which round, rounds/pivots/spend, where the work lives and whether anything
 * is committed, the unresolved blocking items + genuinely-failed assertions from the MOST RECENT
 * redacted verdict (with a pointer to it), and a mechanical next action.
 *
 * Holdout safety: the caller sources content ONLY from harness-owned redacted material — Verdict
 * fields already redacted by `src/build/evaluate.ts` / the runner, redacted `ParentSummary` fields,
 * and state counters. Never raw evaluator output, traces, or holdout text.
 *
 * Best-effort: {@link writeStopReport} never throws to its caller and never mutates the underlying
 * outcome. A write failure warns (naming the failed path) and reports `written: false`, so no caller
 * ever falsely claims the artifact exists.
 */

/** A scalar fact that may be genuinely UNKNOWN — rendered as the literal `unknown`, never omitted. */
export type MaybeNumber = number | "unknown";
/** A tri-state fact (yes / no / not-determinable) — rendered explicitly, never silently dropped. */
export type MaybeBool = boolean | "unknown";

export interface StopReportArtifact {
  /** The isolated worktree the work lives in, when building isolated; absent = in-place. */
  worktree?: string;
  /** The `sparra/<name>` branch the work is on, when building isolated. */
  branch?: string;
  /** Whether any of the work was committed. */
  committed: MaybeBool;
  /** Whether the working tree still holds uncommitted work. */
  uncommitted: MaybeBool;
}

export interface StopReportInput {
  scope: "build" | "conduct";
  /** Item id (build) or unit id (conduct). */
  id: string;
  /** The terminal non-pass outcome (`budget_exceeded`, `failed`, `inconclusive`, `abandoned`,
   *  `exhausted`, `error`, …). */
  outcome: string;
  /** The concrete stop reason: which cap tripped + its configured value / rounds exhausted with the
   *  max-round value / blocked exercise / human abandon / error string. Caller-composed. */
  reason: string;
  /** Best weighted score achieved across all evaluated rounds. */
  bestScore: MaybeNumber;
  /** The round in which the best score was achieved. */
  bestRound: MaybeNumber;
  /** Rounds used. */
  rounds: number;
  /** Pivots used. */
  pivots: number;
  /** Accumulated USD spend. */
  costUsd: MaybeNumber;
  /** Accumulated tokens spent. */
  tokensUsed: MaybeNumber;
  artifact: StopReportArtifact;
  /** Redacted `blocking[]` bullets from the MOST RECENT verdict. */
  blocking: string[];
  /** Genuinely-failed assertions (UN-RUN excluded upstream) from the MOST RECENT verdict. */
  failedAssertions: { id: AssertionId; evidence: string }[];
  /** Path to the most recent verdict file (holdout-redacted on disk), or `unknown`/`false` when none. */
  verdictPath: string | "unknown" | false;
  /** Suggested next action, derived mechanically from the tripped limit. */
  nextAction: string;
}

function num(v: MaybeNumber): string {
  return typeof v === "number" ? String(v) : "unknown";
}

function money(v: MaybeNumber): string {
  return typeof v === "number" ? `$${v.toFixed(3)}` : "unknown";
}

function yesNo(v: MaybeBool): string {
  // A KNOWN boolean renders as the literal `true`/`false` (explicit fact); only a genuinely
  // undeterminable value renders `unknown` — never a silent omission.
  return v === "unknown" ? "unknown" : v ? "true" : "false";
}

function renderArtifact(a: StopReportArtifact): string {
  // Every fact is rendered EXPLICITLY — a missing worktree/branch is stated ("in-place" / "unknown"),
  // never silently omitted, so a reader can distinguish "no isolated worktree" from "we didn't record it".
  const worktree = a.worktree ? `\`${a.worktree}\`` : "in-place (no isolated worktree)";
  const branch = a.branch ? `\`${a.branch}\`` : "unknown";
  return [
    `- **Worktree:** ${worktree}`,
    `- **Branch:** ${branch}`,
    `- **Committed:** ${yesNo(a.committed)}`,
    `- **Uncommitted work:** ${yesNo(a.uncommitted)}`,
  ].join("\n");
}

/** Render a stop report to Markdown. Pure — no I/O, no clock. */
export function renderStopReport(input: StopReportInput): string {
  const blocking = input.blocking.length
    ? input.blocking.map((b) => `- ${b}`).join("\n")
    : "_none reported_";
  const failed = input.failedAssertions.length
    ? input.failedAssertions.map((a) => `- #${a.id}: ${a.evidence}`).join("\n")
    : "_none_";
  const verdict =
    input.verdictPath === false || input.verdictPath === "unknown"
      ? input.verdictPath === false
        ? "_none_"
        : "unknown"
      : `\`${input.verdictPath}\``;

  return (
    `# Stop report — ${input.id} (${input.scope})\n\n` +
    `- **Outcome:** ${input.outcome}\n` +
    `- **Reason for stopping:** ${input.reason}\n` +
    `- **Best score:** ${num(input.bestScore)} (round ${num(input.bestRound)})\n` +
    `- **Rounds used:** ${input.rounds}\n` +
    `- **Pivots used:** ${input.pivots}\n` +
    `- **Spend:** ${money(input.costUsd)} / ${num(input.tokensUsed)} tokens\n\n` +
    `## Artifact state\n${renderArtifact(input.artifact)}\n\n` +
    `## Unresolved blocking items\n${blocking}\n\n` +
    `## Failed assertions (most recent verdict)\n${failed}\n\n` +
    `**Most recent verdict:** ${verdict}\n\n` +
    `## Suggested next action\n${input.nextAction}\n`
  );
}

export interface WriteStopReportOptions {
  /** Absolute path to write the report to. */
  filePath: string;
  input: StopReportInput;
  /** Warn channel (default: the phase logger). Injected in tests. */
  warn?: (msg: string) => void;
  /** File writer (default: ensure-dir + writeText). Injected so tests can force a write failure. */
  writeFile?: (filePath: string, content: string) => Promise<void>;
}

async function defaultWriteFile(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeText(filePath, content);
}

/**
 * Write a stop report, best-effort. NEVER throws to the caller and NEVER alters the surrounding
 * outcome. Returns `{ written: true, path }` on success; on ANY failure it warns (naming the failed
 * path) and returns `{ written: false }` — so no caller can falsely claim the artifact exists.
 */
export async function writeStopReport(
  opts: WriteStopReportOptions,
): Promise<{ written: boolean; path?: string }> {
  const warnFn = opts.warn ?? defaultWarn;
  try {
    const content = renderStopReport(opts.input);
    await (opts.writeFile ?? defaultWriteFile)(opts.filePath, content);
    return { written: true, path: opts.filePath };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnFn(`stop report NOT written for ${opts.input.id} at ${opts.filePath}: ${msg}`);
    return { written: false };
  }
}
