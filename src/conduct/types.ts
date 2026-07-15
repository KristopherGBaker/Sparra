import type { RunUnitResult } from "../../conductors/core/index.ts";
import type { DecisionRecord } from "./decision.ts";

/**
 * `src/conduct/types.ts` — the on-disk shapes for a `sparra conduct` run.
 *
 * The filesystem is the source of truth (like every other Sparra phase): a run's `run.json` plus
 * its per-unit briefs/contracts under `.sparra/conduct/<runId>/` fully describe it, so a crashed or
 * interrupted run is both inspectable AND resumable in place via `sparra conduct --resume <runId>`.
 * Only holdout-safe, `ParentSummary`-derived control values are recorded —
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
export type UnitOutcome =
  | RunUnitResult["outcome"]
  | "pending"
  | "running"
  | "dry-run"
  | "error"
  /** A conductor decision (brain or human) ended the unit deliberately without acceptance. */
  | "abandoned";

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
  /** Every judgment-point decision surfaced for this unit (park/timeout/auto), in order. */
  decisions?: DecisionRecord[];
  /** Each graded round's runner-persisted redacted verdict FILE path (never contents), in round
   *  order. Threaded forward as repeatable `--prior-blocking` on a later round's evaluator (a normal
   *  multi-round re-grade AND a resumed re-grade) so settled blocking ground is verified, not
   *  re-litigated. Holdout-safe: the verdict file the runner writes is already holdout-redacted. */
  verdictPaths?: string[];
  /** Opt-in `--commit`: the `sparra/<name>` branch tip (40-hex) after the unit's WIP was committed.
   *  Absent when the flags are off, or the unit produced no committable WIP. */
  committedSha?: string;
  /** Opt-in `--merge`: the target branch this accepted unit was merged into (`sparra/<runId>` or the
   *  current non-default branch). Absent when only `--commit`, or the merge parked/failed. */
  mergedInto?: string;
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
  /** One ISO timestamp per `conduct --resume` of this run, in resume order. Absent until first
   *  resumed. Lets an inspector see the run was continued in place rather than re-created. */
  resumedAt?: string[];
  /** Effective (post-clamp) knobs, echoed for inspectability. */
  maxUnits: number;
  concurrency: number;
  dryRun: boolean;
  /** The conductor brain mode for this run (`hybrid`/`llm`), or absent for the plain deterministic
   *  path (no brain). */
  brain?: "hybrid" | "llm";
  /** How decisions surfaced for this run (`park`/`park-timeout`/`auto`). */
  decisionSurface?: "park" | "park-timeout" | "auto";
  units: UnitStateEntry[];
  /** Opt-in `--land` (implies `--merge`; requires `conduct.landToDefault: true`): once the run's
   *  accepted units all landed cleanly on the run branch, the DEFAULT branch was fast-forwarded to it —
   *  `"<defaultBranch>@<sha>"` (the branch name + the landed commit). Absent when `--land` was off,
   *  the run started off the default branch, the run wasn't fully clean, or the land parked/failed
   *  (see `landDecisions`). Never set except on a genuine fast-forward of the default branch. */
  landedInto?: string;
  /** Run-scoped (not per-unit) `land-blocked` decisions surfaced by the opt-in `--land` step — a
   *  non-fast-forward default branch, or a failure of the landing write itself. Mirrors each unit's
   *  `decisions` array but lives at the run level since `--land` targets the whole run, not one unit. */
  landDecisions?: DecisionRecord[];
  /** Opt-in `--push` (implies `--land`; requires `conduct.push: true`): the DURABLE outcome of the
   *  push step attempted immediately after `--land` resolves (success, failure, or park) this run —
   *  recorded for EVERY requested-push path, never left transient-log-only. `ok: true` on a successful
   *  push (`branch` names what was pushed); `ok: false` on a non-fatal push failure (offline, a
   *  divergent/non-ff remote, no upstream) OR when no land happened this run — `note` always carries
   *  the concrete reason. Absent when `--push` was off, or `--push`/`conduct.push` were not BOTH set.
   *  Never mutated by anything other than the push step itself; never affects `landedInto`. */
  pushed?: { ok: boolean; branch?: string; note: string };
}
