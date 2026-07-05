import { readJson, writeJson, exists } from "./util/io.ts";
import type { Paths } from "./paths.ts";

export type Mode = "greenfield" | "existing";

/** The phases of the Sparra state machine. Transitions are command-driven; the only
 *  edge that advances toward building is the human-run `freeze`. */
export type Phase =
  | "init" // detected, scaffolded, not yet oriented/planned
  | "orient" // mapping an existing codebase (Phase 0)
  | "plan" // collaborative planning (Phase A)
  | "prototype" // last action was a prototype (Phase B); still pre-freeze
  | "frozen" // freeze gate passed; build input captured
  | "build" // autonomous build in progress (Phase C)
  | "done";

export interface ItemState {
  status: "pending" | "contracting" | "building" | "passed" | "failed" | "abandoned" | "budget_exceeded";
  round: number;
  pivots: number;
  /** Consecutive rounds each rubric criterion stayed below the pivot threshold. */
  criterionFailStreak: Record<string, number>;
  lastScore?: number;
  /** Cumulative USD spent on this item across all rounds (feeds the budget guard). */
  costUsd?: number;
  /** Cumulative tokens spent on this item across all rounds (feeds the token budget guard). */
  tokensUsed?: number;
  generatorSessionId?: string;
  /** Backend the stored generatorSessionId belongs to — a session id isn't portable across
   *  providers, so on a fallback to another backend we must start fresh, not resume. */
  generatorBackend?: string;
  /** FAILED rounds accumulated toward quality escalation (`build.escalateAfterRounds`).
   *  Blocked (inconclusive) rounds and limit-fallback rounds don't count. */
  failedRounds?: number;
  /** This item's generator switched to its `escalation` role (per-item, one-way). */
  escalated?: boolean;
  /** Consecutive PREFLIGHT bounces since the evaluator last ran (`build.preflightVerify`). A
   *  preflight bounce fires only while this is 0; it's reset to 0 the moment an evaluator round
   *  runs, so the gate can never bounce the item twice without the evaluator weighing in. Durable
   *  so the one-bounce cap survives a resume (a rebuild seeded post-bounce goes to the evaluator). */
  preflightBounces?: number;
  /** Attempt ledger: one entry per GAN pivot ({round, approach, failure}, capped — see
   *  build/attempts.ts). Rendered into the FRESH restart's prompt as "PRIOR ATTEMPTS" so a
   *  pivot can't silently repeat a failed approach. Built ONLY from the generator's own report
   *  + already-redacted Verdict fields (the feedback.ts redaction wall). */
  attempts?: { round: number; approach: string; failure: string }[];
  /** The most recent generator report (capped) — durable so a HUMAN pivot decided on resume
   *  (a later process, where the round's GenerateOutput is out of scope) can still record what
   *  the discarded attempt tried. */
  lastReport?: string;

  // ── Interactive (`sparra build --step`) — unused in autonomous builds ──
  /** Round whose verdict a `--step=round` pause is waiting on (so resume applies the
   *  human's decision instead of re-evaluating). */
  lastEvaluatedRound?: number;
  /** Deviations from the paused round's generation, so a resumed human "accept" can
   *  still reconcile the plan + build the commit message. */
  lastDeviations?: { summary: string; rationale: string; scope: "in-scope" | "out-of-scope" }[];
  /** The contract checkpoint has been acknowledged for this item (don't re-pause). */
  contractAcked?: boolean;
  /** Reason recorded when a human ACCEPTED a round the evaluator failed (audit trail). */
  overrideReason?: string;

  /** Durability bookkeeping for acceptance — each side effect runs exactly once across a
   *  crash/resume. Once `status` is "passed" this ledger drives `finishAcceptance`: a missing
   *  flag means that side effect still has to run; a kill between any two effects resumes
   *  mid-finish and re-drives only the unfinished ones. `committed` marks the commit STEP
   *  *resolved* — actually committed, human-skipped (commit gate), or N/A (autoCommit off / no
   *  branch) — so it never repeats and is never silently dropped. (A legacy passed item from
   *  before this field existed has no `acceptance` and is treated as already-finished.)
   *  `measured` gates the OPTIONAL, config-gated post-accept measure step (see phases/build.ts);
   *  it is deliberately NOT part of `acceptanceComplete`, so a measure-disabled project still
   *  completes acceptance and resumes correctly. */
  acceptance?: { reconciled?: boolean; committed?: boolean; memoryAppended?: boolean; measured?: boolean };
}

export interface SparraState {
  version: 1;
  mode: Mode;
  phase: Phase;
  createdAt: string;
  updatedAt: string;
  planning: { sessionId?: string; turns: number };
  freeze: { frozenAt?: string; snapshot?: string };
  /** Cached result of probing whether SDK 'auto' permission mode works on this plan. */
  autoSupported?: boolean;
  build: {
    runId?: string;
    currentItem?: string;
    /** Where the build runs (root, or an isolated worktree). Persisted for resume. */
    workspaceDir?: string;
    branch?: string;
    workspaceNote?: string;
    /** Monotonic trace-file sequence within the run. */
    traceSeq?: number;
    /** Total auto-restart wait cycles spent this run (bounded by build.autoRestart.maxRestarts). */
    restarts?: number;
    /** Epoch-ms the current limit window reopens, while the loop is sleeping on it (else unset).
     *  Surfaced by `status` so a paused build reads as "waiting until …", not hung. */
    waitingUntil?: number;
    /** Backends currently in a limit window → epoch-ms they reopen. Drives fallback-model
     *  selection (skip a limited backend) and resumes correctly across a process restart. */
    limitedRoles?: Record<string, number>;
    items: Record<string, ItemState>;
    /** Hash of the frozen plan the current items were decomposed from — lets `build`
     *  warn when the plan changed but the run wasn't re-decomposed (`--fresh` / `new`). */
    lastBuiltPlanHash?: string;
    /** Interactive checkpoints enabled this run (`sparra build --step=contract,round,commit,item`).
     *  Persisted so a resume (`sparra build`) keeps the same human-in-the-loop mode. */
    step?: ("contract" | "round" | "commit" | "item")[];
    /** An active checkpoint the build is paused at, awaiting the human (then resume). */
    paused?: { kind: "contract" | "round" | "commit" | "item"; itemId: string; round: number };
  };
  /** Last SDK session id per role, for resume/fork. */
  sessions: Record<string, string>;
}

export function newState(mode: Mode): SparraState {
  const now = new Date().toISOString();
  return {
    version: 1,
    mode,
    phase: "init",
    createdAt: now,
    updatedAt: now,
    planning: { turns: 0 },
    freeze: {},
    build: { items: {} },
    sessions: {},
  };
}

const VALID: Record<Phase, Phase[]> = {
  init: ["orient", "plan"],
  orient: ["plan"],
  plan: ["prototype", "plan", "frozen"],
  prototype: ["plan", "prototype", "frozen"],
  frozen: ["build", "plan"], // can thaw back to plan if needed
  build: ["build", "done", "plan"],
  done: ["build", "plan"],
};

export class StateStore {
  private constructor(public readonly paths: Paths, public data: SparraState) {}

  static async load(paths: Paths): Promise<StateStore | null> {
    if (!exists(paths.state)) return null;
    const data = await readJson<SparraState>(paths.state);
    if (!data) return null;
    return new StateStore(paths, data);
  }

  static create(paths: Paths, mode: Mode): StateStore {
    return new StateStore(paths, newState(mode));
  }

  async save(): Promise<void> {
    this.data.updatedAt = new Date().toISOString();
    await writeJson(this.paths.state, this.data);
  }

  canTransition(to: Phase): boolean {
    return VALID[this.data.phase]?.includes(to) ?? false;
  }

  async transition(to: Phase, force = false): Promise<void> {
    if (!force && !this.canTransition(to)) {
      throw new Error(`Illegal phase transition: ${this.data.phase} → ${to}`);
    }
    this.data.phase = to;
    await this.save();
  }

  async recordSession(role: string, sessionId: string): Promise<void> {
    this.data.sessions[role] = sessionId;
    await this.save();
  }
}
