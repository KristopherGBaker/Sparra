import type { ParentSummary } from "../../conductors/core/index.ts";
import type { Paths } from "../paths.ts";
import {
  appendLearning,
  hasLearningLine,
  DEFAULT_CAPS,
  type Learning,
  type LearningKind,
} from "../memory.ts";
import type { UnitOutcome } from "./types.ts";

/**
 * `src/conduct/learnings.ts` — cross-unit learning for `sparra conduct`.
 *
 * The build phase already publishes each item's outcome to `.sparra/memory.md` so later items don't
 * re-discover a settled failure; the conduct path did not. This module closes that gap: at every
 * unit terminal outcome (and at pivot / generalize-spec judgment decisions) the conductor composes ONE
 * bounded, parent-safe line and appends it via the EXISTING `src/memory.ts` mechanism (same caps, same
 * format). Later-started role-runs in the same run — and every future build/conduct run — then pick it
 * up through the unchanged PRIOR LEARNINGS injection (no new plumbing).
 *
 * Holdout safety by construction: a line is composed ONLY from a {@link ParentSummary} (the parent-safe
 * allowlist) plus harness scalars (run/unit id, title, exact outcome token, rounds, score). The
 * composer's signature accepts `ParentSummary` — never the raw `RunRolePayload` — so a holdout-bearing
 * field (`resultText`, a raw verdict, a trace) can't be threaded in even by mistake.
 *
 * Concurrency: all appends route through ONE coordinator-owned {@link ConductLearningWriter} — a
 * promise-chain queue in the conduct process — so concurrent unit completions never interleave a write.
 * Best-effort: one `appendLearning` rejection neither poisons the queue nor propagates to the run.
 */

/** Collapse whitespace and hard-cap a free-text fragment (title / blocking reason) so one memory line
 *  stays compact. Never returns holdout content — inputs are already parent-safe. */
function condense(s: string, cap: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > cap ? `${t.slice(0, cap).trimEnd()}…` : t;
}

/** The dominant failure reason for a non-accepted unit, with a defined precedence:
 *  1) the first parent-safe `blocking` summary line (a faithful condensation), else
 *  2) the harness error message (an `error` outcome carrying no `blocking`), else
 *  3) none (the outcome token alone conveys it). */
function failureReason(summary: ParentSummary | undefined, error: string | undefined): string | undefined {
  const first = summary?.blocking?.find((b) => b.trim());
  if (first) return condense(first, 160);
  if (error?.trim()) return condense(error, 160);
  return undefined;
}

/** The existing {@link LearningKind} that best fits a terminal outcome. `accepted` → `passed`; a
 *  budget/limit-terminal (any of the parent-safe limit flags) → `budget_exceeded`; `exhausted`/`error`
 *  → `failed`; the deliberate/abnormal terminals (`abandoned`, `grade-not-independent`, `inconclusive`)
 *  → `note`. NEVER `passed` for a non-accepted outcome. No new kinds are introduced. */
function terminalKind(outcome: UnitOutcome, summary: ParentSummary | undefined): LearningKind {
  if (outcome === "accepted") return "passed";
  if (summary && (summary.hitBudget || summary.hitMaxTurns || summary.limitHit)) return "budget_exceeded";
  if (outcome === "exhausted" || outcome === "error") return "failed";
  return "note";
}

/** Input to {@link composeUnitLearning}: harness-owned unit metadata plus the parent-safe summary. */
export interface UnitLearningInput {
  runId: string;
  unitId: string;
  title: string;
  /** The exact outcome token recorded in run.json (e.g. `accepted`, `exhausted`, `grade-not-independent`). */
  outcome: UnitOutcome;
  rounds: number;
  /** The unit's final parent-safe verdict summary (weightedTotal / blocking / limit flags), if any. */
  summary?: ParentSummary;
  /** A harness error message for an `error` outcome carrying no `blocking`. */
  error?: string;
  at?: string;
}

/** Compose ONE terminal {@link Learning} for a completed conduct unit. Reads only parent-safe fields. */
export function composeUnitLearning(input: UnitLearningInput): Learning {
  const kind = terminalKind(input.outcome, input.summary);
  const score = input.summary?.weightedTotal !== undefined ? `score ${input.summary.weightedTotal}` : "score n/a";
  const reason = input.outcome === "accepted" ? undefined : failureReason(input.summary, input.error);
  const rounds = `${input.rounds} round${input.rounds === 1 ? "" : "s"}`;
  const detail =
    `run ${input.runId} · ${input.outcome} · ${condense(input.title, 80)} (${rounds}, ${score})` +
    (reason ? ` — ${reason}` : "");
  return { item: input.unitId, kind, detail, ...(input.at ? { at: input.at } : {}) };
}

/** The dedup needles (ALL must appear in one memory entry) for a terminal line — keyed on
 *  runId + unitId + exact outcome, NOT on `hasLearning(unitId, kind)` (two outcomes can share a kind). */
export function unitLearningDedup(input: { runId: string; unitId: string; outcome: UnitOutcome }): string[] {
  return [`${input.unitId} ·`, `run ${input.runId} · ${input.outcome} ·`];
}

/** A conduct judgment decision worth remembering (a discarded change may still teach). */
export interface DecisionLearningInput {
  runId: string;
  unitId: string;
  /** `pivot` → kind `pivot`; `generalize-spec` → kind `note` carrying the stable literal marker. */
  decision: "pivot" | "generalize-spec";
  round: number;
  summary?: ParentSummary;
  at?: string;
}

/** Compose ONE decision {@link Learning} for a pivot / generalize-spec judgment. `pivot` uses kind
 *  `pivot`; `generalize-spec` uses kind `note` and always carries the literal `generalize-spec` marker. */
export function composeDecisionLearning(input: DecisionLearningInput): Learning {
  const kind: LearningKind = input.decision === "pivot" ? "pivot" : "note";
  const reason = input.summary?.blocking?.find((b) => b.trim());
  const detail =
    `run ${input.runId} · ${input.decision} @ ${input.unitId} round ${input.round}` +
    (reason ? ` — ${condense(reason, 120)}` : "");
  return { item: input.unitId, kind, detail, ...(input.at ? { at: input.at } : {}) };
}

/** Dedup needles for a decision line — keyed on runId + unitId + decision + round (a decision's stable
 *  identity across replay/resume), NOT on the shared `LearningKind`. */
export function decisionLearningDedup(input: {
  runId: string;
  unitId: string;
  decision: "pivot" | "generalize-spec";
  round: number;
}): string[] {
  return [`${input.unitId} ·`, `run ${input.runId} · ${input.decision} @ ${input.unitId} round ${input.round}`];
}

/** Injectable deps for the writer (tests fake `appendLearning`; production uses the real one). */
export interface LearningWriterDeps {
  appendLearningFn?: typeof appendLearning;
  /** ISO stamp for the line's date (default: real clock). */
  now?: () => string;
}

/**
 * The ONE coordinator-owned serialized learning writer for a conduct run. Every completion/decision
 * route enqueues through the SAME instance, so concurrent unit completions can never interleave or lose
 * a write (memory.ts appends are same-process sequential; this queue guarantees they stay so).
 *
 * File-based no-duplicate guard: before each append the queued task checks whether an entry already
 * carries all the `dedupNeedles` — so a resume replaying the SAME terminal transition (or decision)
 * never double-appends, while two DIFFERENT runs (distinct runId) always both append.
 *
 * Best-effort: a rejected `appendLearning` is swallowed so it neither poisons the queue (a SUBSEQUENT
 * enqueue still appends) nor propagates to the run/unit outcome.
 */
export class ConductLearningWriter {
  private queue: Promise<void> = Promise.resolve();
  private readonly append: typeof appendLearning;
  private readonly now: () => string;

  constructor(
    private readonly paths: Paths,
    deps: LearningWriterDeps = {},
  ) {
    this.append = deps.appendLearningFn ?? appendLearning;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /** Enqueue one learning behind a file-based dedup guard. Returns a promise that always resolves
   *  (best-effort). All appends use `DEFAULT_CAPS` — no cap constants are raised, no bypass write. */
  write(learning: Learning, dedupNeedles: string[]): Promise<void> {
    const task = this.queue.then(async () => {
      if (await hasLearningLine(this.paths, dedupNeedles)) return;
      await this.append(this.paths, { ...learning, at: learning.at ?? this.now() }, DEFAULT_CAPS);
    });
    // Swallow so ONE rejection neither poisons the chain nor rejects the caller (memory is best-effort).
    this.queue = task.catch(() => {});
    return this.queue;
  }

  /** Resolve once every currently-enqueued write has settled. */
  drain(): Promise<void> {
    return this.queue.then(() => {});
  }
}
