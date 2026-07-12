import type { RunUnitResult } from "../../conductors/core/index.ts";

/**
 * `src/conduct/types.ts` — the on-disk shapes for a `sparra conduct` run.
 *
 * The filesystem is the source of truth (like every other Sparra phase): a run's `run.json` plus
 * its per-unit briefs/contracts under `.sparra/conduct/<runId>/` fully describe it, so a crashed
 * run is still inspectable. Only holdout-safe, `ParentSummary`-derived control values are recorded —
 * never a raw transcript, a verdict dump, holdout text, or an evaluator trace dir.
 */

/** One decomposed unit (prompt → 1..N of these via the `decomposer` role). */
export interface ConductUnit {
  /** Stable id, e.g. `unit-001`. */
  id: string;
  title: string;
  summary: string;
  /** The full brief text written to `<runDir>/<id>/brief.md`. */
  brief: string;
}

/** Terminal-or-pending outcome recorded for one unit. Mirrors the core `RunUnitResult["outcome"]`
 *  plus the conduct-only lifecycle markers. */
export type UnitOutcome = RunUnitResult["outcome"] | "pending" | "running" | "dry-run" | "error";

/** One unit's persisted entry in `run.json`. Fields (score/cost/branch/worktree) are derived from
 *  the unit's role `ParentSummary`s — never hardcoded. */
export interface UnitStateEntry {
  id: string;
  title: string;
  outcome: UnitOutcome;
  briefPath: string;
  contractPath?: string;
  /** True when the contract negotiation converged (evaluator agreed); false when it was forced
   *  (rounds exhausted, proceeded with the latest proposal). */
  contractAgreed?: boolean;
  contractForced?: boolean;
  /** Final evaluator weighted score (`ParentSummary.weightedTotal`). */
  score?: number;
  /** Summed `costUsd` across the unit's role runs. */
  cost?: number;
  /** The unit worktree's branch (`generator.unitWorktree.branch`). */
  branch?: string;
  /** The unit worktree's name (`generator.unitWorktree.name`). */
  worktree?: string;
  /** Set when the unit threw (scheduler `{ id, error }`). */
  error?: string;
}

/** Overall run status. `running` and `pending` are NON-final; the rest are terminal. */
export type ConductOverallStatus = "pending" | "running" | "completed" | "dry-run" | "error";

/** The full `run.json` document. */
export interface ConductRunState {
  runId: string;
  prompt: string;
  status: ConductOverallStatus;
  createdAt: string;
  updatedAt: string;
  /** Effective (post-clamp) knobs, echoed for inspectability. */
  maxUnits: number;
  concurrency: number;
  dryRun: boolean;
  units: UnitStateEntry[];
}
