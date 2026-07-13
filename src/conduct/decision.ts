import type { ParentSummary } from "../../conductors/core/index.ts";

/**
 * `src/conduct/decision.ts` — the shapes + deterministic policy for `sparra conduct`'s decision
 * engine and conductor brain.
 *
 * A "judgment point" is a moment where an experienced human conducting /sparra-loop would pause and
 * choose. Five arise DURING a unit's build (the fixed loop set): contract non-convergence, unit
 * exhaustion, cross-model gate collapse, budget/limit recovery, and a borderline final accept. A
 * sixth, `merge-blocked`, arises AFTER acceptance in the opt-in `--merge` landing phase (a merge
 * conflict or a dirty merge target). At each, the run surfaces a {@link DecisionRequest} — built ONLY
 * from holdout-safe, `ParentSummary`-derived material, so a request/record can never quote holdout
 * evidence.
 */

/** The judgment points. The first five arise in a unit's build loop; `merge-blocked` in the
 *  post-accept `--merge` landing phase (conflict / dirty target). */
export type JudgmentKind =
  | "contract-nonconvergence"
  | "unit-exhausted"
  | "gate-collapse"
  | "recovery"
  | "borderline-accept"
  | "merge-blocked";

/**
 * Where a resolved decision's answer came from — a CLOSED enum covering every resolution path:
 *   file             — a `<seq>.decision.json` file the poller found.
 *   tty              — an inline readline answer on the terminal.
 *   brain            — the LLM conductor decided (auto mode, or after a park timeout).
 *   auto-deterministic — the deterministic policy decided (auto/timeout, brain unavailable).
 *   brain-fallback   — the brain was consulted but its JSON was invalid after a reask → deterministic.
 */
export type DecisionSource = "file" | "tty" | "brain" | "auto-deterministic" | "brain-fallback";

/** The trigger that produced the resolution. */
export type DecisionVia = "park" | "timeout" | "auto";

/** A holdout-safe request surfaced at a judgment point. Serialized to `<seq>.request.json`. */
export interface DecisionRequest {
  /** Stable id (also embedded in the filename `<seq>`). */
  id: string;
  /** Per-run monotonic sequence number. */
  seq: number;
  /** The unit this decision belongs to. */
  unit: string;
  kind: JudgmentKind;
  /** One-line human-readable question. */
  question: string;
  /** The offered answers (the closed choice set). */
  options: string[];
  /** The deterministic default (always one of `options`). */
  default: string;
  /** ISO timestamp after which `park-timeout` auto-resolves. */
  expiresAt: string;
  /** Holdout-safe context (scalars derived from `ParentSummary` / brief / contract / run state). */
  context?: Record<string, string | number | boolean | null>;
}

/** A resolved answer plus how it was reached. */
export interface DecisionResolution {
  answer: string;
  note?: string;
  rationale?: string;
  source: DecisionSource;
  via: DecisionVia;
}

/**
 * The persisted audit record in `run.json` (and mirrored in the phase log). A record is appended
 * `status: "pending"` the moment its request is surfaced, then UPDATED in place to
 * `status: "resolved"` when answered — so ONE seq yields exactly ONE durable record that transitions
 * pending → resolved (whether the running poller or an out-of-band `conduct --decide` resolves it).
 */
export interface DecisionRecord {
  seq: number;
  unit: string;
  kind: JudgmentKind;
  question: string;
  options: string[];
  default: string;
  /** `pending` while awaiting an answer; `resolved` once decided. */
  status: "pending" | "resolved";
  requestedAt: string;
  /** The chosen answer (one of `options`) — present once `resolved`. */
  chosen?: string;
  rationale?: string;
  note?: string;
  source?: DecisionSource;
  via?: DecisionVia;
  resolvedAt?: string;
}

/** A brain's structured answer at a judgment point (or a driven llm turn). */
export interface BrainDecision {
  answer: string;
  rationale?: string;
  /** llm-drive only: one-line feedback carried by a `revise` action. */
  feedback?: string;
}

/** The offered options + deterministic default for each judgment kind. */
export const JUDGMENT_OPTIONS: Record<JudgmentKind, { options: string[]; default: string }> = {
  "contract-nonconvergence": { options: ["finalize", "revise-brief", "abandon"], default: "finalize" },
  "unit-exhausted": { options: ["pivot", "generalize-spec", "abandon"], default: "pivot" },
  "gate-collapse": { options: ["abandon", "accept-anyway", "retry"], default: "abandon" },
  "recovery": { options: ["wait", "fallback", "abandon"], default: "wait" },
  "borderline-accept": { options: ["accept", "revise", "abandon"], default: "accept" },
  // Merge landing blocked (conflict / dirty target). Both options leave the target byte-identical and
  // keep the unit's worktree+branch: `skip-unit` skips just this unit; `abort-merge` stops merging
  // the rest of the run's accepted units too. Default keeps the unit for the human to merge by hand.
  "merge-blocked": { options: ["skip-unit", "abort-merge"], default: "skip-unit" },
};

/** A one-line question for each judgment kind (no holdout material). */
export function judgmentQuestion(kind: JudgmentKind, unit: string): string {
  switch (kind) {
    case "contract-nonconvergence":
      return `Unit ${unit}: the contract never converged — finalize as-is, revise the brief, or abandon?`;
    case "unit-exhausted":
      return `Unit ${unit}: rounds exhausted without acceptance — pivot, generalize the spec, or abandon?`;
    case "gate-collapse":
      return `Unit ${unit}: the cross-model gate collapsed (no distinct grader) — abandon, accept anyway, or retry?`;
    case "recovery":
      return `Unit ${unit}: a provider limit/budget issue with no clean recovery — wait, fall back, or abandon?`;
    case "borderline-accept":
      return `Unit ${unit}: the verdict is a borderline pass — accept, revise once more, or abandon?`;
    case "merge-blocked":
      return `Unit ${unit}: the merge is blocked (conflict or a dirty target) — skip this unit (keep its worktree) or abort the merge?`;
  }
}

/**
 * The DETERMINISTIC default answer for a judgment kind — the policy applied under `--auto`/timeout
 * when no brain is available (and the deterministic-first pick everywhere). Always one of the kind's
 * offered options.
 */
export function deterministicAnswer(kind: JudgmentKind): string {
  return JUDGMENT_OPTIONS[kind].default;
}

/**
 * Build a holdout-safe {@link DecisionRequest}. Context is drawn ONLY from `ParentSummary` scalars
 * (verdict, score, threshold, flags) — never from a holdout file, evaluator trace, or raw verdict.
 */
export function buildDecisionRequest(params: {
  seq: number;
  unit: string;
  kind: JudgmentKind;
  nowMs: number;
  timeoutSec: number;
  summary?: ParentSummary;
  passThreshold?: number;
}): DecisionRequest {
  const { options, default: def } = JUDGMENT_OPTIONS[params.kind];
  const context: Record<string, string | number | boolean | null> = {};
  const s = params.summary;
  if (s) {
    if (s.verdict !== undefined) context.verdict = s.verdict as string;
    if (s.weightedTotal !== undefined) context.score = s.weightedTotal;
    if (s.passThreshold !== undefined) context.passThreshold = s.passThreshold;
    if (params.passThreshold !== undefined) context.configuredThreshold = params.passThreshold;
    if (s.sameModelGrade !== undefined) context.sameModelGrade = s.sameModelGrade;
    if (s.limitHit !== undefined) context.limitHit = true;
    if (s.hitBudget !== undefined) context.hitBudget = s.hitBudget;
    if (s.hitMaxTurns !== undefined) context.hitMaxTurns = s.hitMaxTurns;
    if (s.emptyCompletion !== undefined) context.emptyCompletion = s.emptyCompletion;
    if (s.filesChanged !== undefined) context.filesChanged = s.filesChanged;
  }
  return {
    id: `${params.unit}-${params.seq}`,
    seq: params.seq,
    unit: params.unit,
    kind: params.kind,
    question: judgmentQuestion(params.kind, params.unit),
    options,
    default: def,
    expiresAt: new Date(params.nowMs + params.timeoutSec * 1000).toISOString(),
    ...(Object.keys(context).length > 0 ? { context } : {}),
  };
}
