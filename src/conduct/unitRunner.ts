import {
  negotiateContract,
  type ContractNegotiationResult,
  type DecideFn,
  type ParentSummary,
  type RoleRunner,
  type RunRoleSpec,
} from "../../conductors/core/index.ts";
import type { RoleConfig } from "../config.ts";
import type { Brain, DriveContext } from "./brain.ts";
import type { DecisionResolution, DecisionSource, DecisionVia, JudgmentKind } from "./decision.ts";
import { buildRecoverySpec, classifyRecovery, type RecoveryCaps } from "./recovery.ts";
import type { UnitOutcome } from "./types.ts";
import type { UnitRoleSpecs } from "./roleSpecs.ts";
import type { AttemptInput, AttemptKind } from "../build/attemptLedger.ts";

/**
 * `src/conduct/unitRunner.ts` — the conductor-BRAIN unit orchestrations for `sparra conduct`.
 *
 *   hybrid → the deterministic contract → generate → evaluate → decide loop runs (via the same core
 *            pieces), and the brain / decision engine is consulted at the FIVE judgment points
 *            (contract non-convergence, unit exhaustion, cross-model gate collapse, budget/limit
 *            recovery, borderline accept). A normal passing round never consults the brain.
 *   llm    → the brain DRIVES turn-by-turn: each turn it picks the next action (run / revise / pivot
 *            / escalate / finalize / accept / abandon / surface) until the run completes or the
 *            round budget exhausts (a hard bound — an endlessly-driving brain still terminates).
 *
 * Recovery is deterministic-first (`limitHit`→fallback, cap-hit→resume, empty-completion→evaluate);
 * only the ambiguous case (a limit with no fallback) escalates to a judgment point.
 */

/** One brain-driven build round's evaluator summary (holdout-safe `ParentSummary`), the round number,
 *  and whether it was a pivot — carried out of the unit runner so the shared conduct finalization can
 *  build a stop report with best score/round, latest redacted blocking/evidence, and pivot count. */
export interface ConductRoundRecord {
  round: number;
  evaluator: ParentSummary;
  pivoted: boolean;
}

export interface ConductUnitResult {
  outcome: UnitOutcome;
  contractAgreed: boolean;
  /** True when the build proceeded despite a non-agreed contract (forced finalization). */
  contractForced: boolean;
  finalVerdict?: ParentSummary;
  /** Every evaluated build round's record, in round order. Additive — drives the stop report's
   *  best-round/latest-verdict/pivot facts on the brain path (mirrors the deterministic path's
   *  `RunUnitResult.cycle.rounds`). */
  rounds: ConductRoundRecord[];
}

export interface ConductUnitDeps {
  runRole: RoleRunner;
  specs: UnitRoleSpecs;
  decide: DecideFn;
  brain?: Brain;
  /** Surface a judgment point (park/timeout/auto) AND record it into run state; returns the answer. */
  judge: (kind: JudgmentKind, summary?: ParentSummary) => Promise<DecisionResolution>;
  /** Record a deterministic (non-surfaced) decision — e.g. a concrete recovery or a 2nd-pivot escalation. */
  noteDecision: (
    kind: JudgmentKind,
    answer: string,
    source: DecisionSource,
    via: DecisionVia,
    rationale?: string,
  ) => void;
  /** Optional per-round ATTEMPT-LEDGER sink (U1): called at each round's decided outcome with an
   *  already-redacted record ({round, kind, decision, score/verdict/verdictPath where available, reason,
   *  cost, lineage computed by the sink}). Undefined = no ledger (backward-compatible). Best-effort
   *  telemetry — never a gate. Holdout-safe: built only from `ParentSummary` control fields. */
  recordRound?: (input: AttemptInput) => void;
  /** Write a GENERALIZED-spec brief revision as a NEW file (never edits history); returns its path. */
  writeGeneralizedBrief: (round: number) => Promise<string>;
  /** Publish a pivot / generalize-spec judgment decision to project memory (best-effort, serialized
   *  through the coordinator's one writer). Called at the ACTUAL decision call sites so a discarded
   *  change still teaches a later unit/run. Absent → no decision learning (deterministic path / tests). */
  recordDecisionLearning?: (d: { decision: "pivot" | "generalize-spec"; round: number; summary?: ParentSummary }) => void;
  recoveryCaps: RecoveryCaps;
  generatorRole: RoleConfig;
  unit: string;
  contractMaxRounds: number;
  maxRounds: number;
  pivotAfterFailures: number;
  requireCrossModel: boolean;
  passThreshold: number;
  /** A PASS whose score is within this many points of threshold is a BORDERLINE accept. */
  borderlineMargin: number;
  /** RESUME: when set, the contract phase is SKIPPED — the persisted contract file is reused as-is
   *  (its agreement/forced state carried here), so a resumed unit re-enters straight at generate with
   *  NO contract-generator/contract-evaluator run. Absent on a fresh run (negotiate as normal). */
  resumeContract?: { agreed: boolean; forced: boolean };
  /** RESUME: prior rounds' persisted redacted verdict paths (from the unit's run.json entry), used to
   *  SEED the re-grade `--prior-blocking` threading so a resumed re-grade verifies settled ground.
   *  Paths only — never contents. Absent/[] on a fresh run. */
  seedVerdictPaths?: string[];
}

/** A PASS within `margin` points of the (per-verdict or configured) threshold is borderline. */
function isBorderline(summary: ParentSummary, threshold: number, margin: number): boolean {
  if (summary.weightedTotal === undefined) return false;
  const t = summary.passThreshold ?? threshold;
  const delta = summary.weightedTotal - t;
  return delta >= 0 && delta <= margin;
}

/** Apply the deterministic recovery map (or escalate the ambiguous case). */
async function recover(
  deps: ConductUnitDeps,
  spec: RunRoleSpec,
  summary: ParentSummary,
): Promise<{ summary: ParentSummary; abandon?: boolean }> {
  const action = classifyRecovery(summary, deps.recoveryCaps);
  if (action.kind === "none" || action.kind === "evaluate") return { summary };
  if (action.kind === "fallback" || action.kind === "resume") {
    // NEVER behavioral-FAIL feedback: recover by reshaping the next role-run and re-running.
    deps.noteDecision("recovery", action.kind, "auto-deterministic", "auto", `deterministic recovery: ${action.kind}`);
    const recovered = await deps.runRole(buildRecoverySpec(spec, action));
    return { summary: recovered };
  }
  // Ambiguous (a provider limit with no configured fallback): surface it.
  const res = await deps.judge("recovery", summary);
  if (res.answer === "abandon") return { summary, abandon: true };
  // wait / fallback: retry the same role-run once.
  const retried = await deps.runRole(spec);
  return { summary: retried };
}

/** RESUME: synthesize a settled `ContractNegotiationResult` from persisted state WITHOUT running any
 *  contract role — the persisted contract file is reused in place. */
function resumedContract(r: { agreed: boolean; forced: boolean }): ContractNegotiationResult {
  return { agreed: r.agreed, rounds: [], critiquePaths: [] };
}

/** hybrid: deterministic loop + brain/decision-engine at the five judgment points. */
export async function runUnitHybrid(deps: ConductUnitDeps): Promise<ConductUnitResult> {
  // RESUME: skip the contract phase entirely when re-entering at generate (persisted contract reused).
  const contract = deps.resumeContract
    ? resumedContract(deps.resumeContract)
    : await negotiateContract(
        { runRole: deps.runRole },
        {
          contractGeneratorSpec: deps.specs.contractGeneratorSpec,
          contractEvaluatorSpec: deps.specs.contractEvaluatorSpec,
          maxRounds: deps.contractMaxRounds,
        },
      );

  let brief: string | undefined;
  let contractForced = deps.resumeContract?.forced ?? false;
  if (!deps.resumeContract && !contract.agreed) {
    const res = await deps.judge("contract-nonconvergence", contract.rounds.at(-1)?.evaluator);
    if (res.answer === "abandon") {
      return { outcome: "abandoned", contractAgreed: false, contractForced: false, rounds: [] };
    }
    if (res.answer === "revise-brief") {
      brief = await deps.writeGeneralizedBrief(0);
    }
    // finalize / revise-brief both proceed to the build (forced finalization).
    contractForced = true;
  }

  const cycle = await runHybridRounds(deps, brief);
  return {
    outcome: cycle.outcome,
    contractAgreed: contract.agreed,
    contractForced,
    rounds: cycle.rounds,
    ...(cycle.finalVerdict ? { finalVerdict: cycle.finalVerdict } : {}),
  };
}

async function runHybridRounds(
  deps: ConductUnitDeps,
  briefOverride?: string,
): Promise<{ outcome: UnitOutcome; finalVerdict?: ParentSummary; rounds: ConductRoundRecord[] }> {
  let round = 1;
  let consecutiveFailures = 0;
  let feedback: string[] = [];
  let pivoting = false;
  let pivotCount = 0;
  let genRole = deps.generatorRole;
  let brief = briefOverride;
  let lastEval: ParentSummary | undefined;
  // Every evaluated round's record (round + evaluator summary + whether it pivoted), in order — the
  // brain-path source for the stop report's best-round/latest-verdict/pivot facts.
  const rounds: ConductRoundRecord[] = [];
  // Prior rounds' persisted verdict paths threaded onto each re-grade as `--prior-blocking`. Seeded
  // from run.json on a RESUME (verify settled ground), then extended per graded round.
  const priorVerdictPaths: string[] = [...(deps.seedVerdictPaths ?? [])];
  // Attempt-ledger phantom-round guard: a CONTINUING round's decision (continue-patch/pivot) is
  // DEFERRED and flushed at the top of the NEXT iteration — so if the loop instead EXHAUSTS, the last
  // executed round's record carries the terminal outcome rather than a spurious "continue" plus a
  // fabricated round number that never generated/evaluated. Only executed rounds are ever recorded.
  let executedRound = 0;
  let executedPivoting = false;
  let deferred: { decision: AttemptInput["decision"]; summary: ParentSummary } | null = null;

  while (round <= deps.maxRounds) {
    // Flush the PREVIOUS executed round's deferred continue decision now that another round is running.
    if (deferred && executedRound) {
      deps.recordRound?.(roundAttempt(executedRound, executedPivoting, deferred.decision, deferred.summary));
      deferred = null;
    }
    const ctx = { round, feedback, pivoting, priorVerdictPaths: [...priorVerdictPaths] };
    const genSpec = deps.specs.generatorSpecFor(genRole, ctx, brief);
    const genRaw = await deps.runRole(genSpec);
    const genRec = await recover(deps, genSpec, genRaw);
    if (genRec.abandon) {
      deps.recordRound?.(roundAttempt(round, pivoting, "abandon", genRec.summary, "generation recovery abandoned at judgment point"));
      return { outcome: "abandoned", finalVerdict: lastEval, rounds };
    }

    const evalSpec = deps.specs.evaluatorSpec(ctx);
    const evalRaw = await deps.runRole(evalSpec);
    const evalRec = await recover(deps, evalSpec, evalRaw);
    if (evalRec.abandon) {
      deps.recordRound?.(roundAttempt(round, pivoting, "abandon", evalRec.summary, "evaluation recovery abandoned at judgment point"));
      rounds.push({ round, evaluator: evalRec.summary, pivoted: false });
      return { outcome: "abandoned", finalVerdict: evalRec.summary, rounds };
    }
    const evalSummary = evalRec.summary;
    lastEval = evalSummary;
    // This round genuinely GENERATED and EVALUATED — mark it executed so a later terminal decision
    // (or the deferred-continue flush) records against a REAL round, never a fabricated one.
    executedRound = round;
    executedPivoting = pivoting;
    if (evalSummary.verdictPath) priorVerdictPaths.push(evalSummary.verdictPath);

    // Attempt-ledger sink for a TERMINAL round decision (records immediately against this executed
    // round). A CONTINUING decision instead sets `deferred` (flushed next iteration / superseded by a
    // terminal on exhaustion). Holdout-safe — built only from `ParentSummary`.
    const rec = (dec: AttemptInput["decision"], reason?: string): void => {
      deps.recordRound?.(roundAttempt(round, pivoting, dec, evalSummary, reason));
    };

    const decision = deps.decide(
      evalSummary,
      { consecutiveFailures },
      { pivotAfterFailures: deps.pivotAfterFailures, requireCrossModel: deps.requireCrossModel },
    );
    rounds.push({ round, evaluator: evalSummary, pivoted: decision === "pivot" });

    if (decision === "accept") {
      if (isBorderline(evalSummary, deps.passThreshold, deps.borderlineMargin)) {
        const res = await deps.judge("borderline-accept", evalSummary);
        if (res.answer === "abandon") {
          rec("abandon", "borderline accept abandoned at judgment point");
          return { outcome: "abandoned", finalVerdict: evalSummary, rounds };
        }
        if (res.answer === "revise") {
          deferred = { decision: "continue-patch", summary: evalSummary };
          consecutiveFailures += 1;
          feedback = evalSummary.blocking ?? [];
          pivoting = false;
          round += 1;
          continue;
        }
      }
      rec("accept");
      return { outcome: "accepted", finalVerdict: evalSummary, rounds };
    }
    if (decision === "grade-not-independent") {
      const res = await deps.judge("gate-collapse", evalSummary);
      if (res.answer === "accept-anyway") {
        rec("accept", "cross-model gate collapse — accepted anyway at judgment point");
        return { outcome: "accepted", finalVerdict: evalSummary, rounds };
      }
      if (res.answer === "retry") {
        deferred = { decision: "continue-patch", summary: evalSummary };
        round += 1;
        continue;
      }
      rec("terminal-inconclusive", "cross-model gate collapse (grade not independent)");
      return { outcome: "grade-not-independent", finalVerdict: evalSummary, rounds };
    }
    if (decision === "inconclusive") {
      rec("terminal-inconclusive", "evaluator inconclusive (no behavioral signal)");
      return { outcome: "inconclusive", finalVerdict: evalSummary, rounds };
    }
    if (decision === "revise") {
      deferred = { decision: "continue-patch", summary: evalSummary };
      consecutiveFailures += 1;
      feedback = evalSummary.blocking ?? [];
      pivoting = false;
      round += 1;
      continue;
    }
    // decision === "pivot"
    deferred = { decision: "pivot", summary: evalSummary };
    pivotCount += 1;
    consecutiveFailures = 0;
    feedback = evalSummary.blocking ?? [];
    pivoting = true;
    // A pivot is a genuinely decision-relevant event (a discarded change may still teach) — remember it.
    deps.recordDecisionLearning?.({ decision: "pivot", round, summary: evalSummary });
    if (pivotCount >= 2) {
      // 2nd pivot: prefer escalation / spec-generalization over another same-level round.
      if (genRole.escalation) {
        genRole = genRole.escalation;
        deps.noteDecision("unit-exhausted", "escalate", "auto-deterministic", "auto", "2nd pivot → escalate generator");
      } else {
        brief = await deps.writeGeneralizedBrief(round);
        deps.noteDecision("unit-exhausted", "generalize-spec", "auto-deterministic", "auto", "2nd pivot → generalize brief");
        deps.recordDecisionLearning?.({ decision: "generalize-spec", round, summary: evalSummary });
      }
    }
    round += 1;
  }

  // Rounds exhausted → the fifth judgment point. Record the terminal outcome against the LAST EXECUTED
  // round (its deferred "continue" is discarded — never flushed — so the terminal claims that round's
  // record; the FINAL ledger record reflects the unit's true outcome and NO phantom round is invented).
  const res = await deps.judge("unit-exhausted", lastEval);
  if (res.answer === "abandon") {
    if (executedRound) {
      deps.recordRound?.(roundAttempt(executedRound, executedPivoting, "abandon", lastEval, "unit exhausted — abandoned at judgment point"));
    }
    return { outcome: "abandoned", finalVerdict: lastEval, rounds };
  }
  if (executedRound) {
    deps.recordRound?.(roundAttempt(executedRound, executedPivoting, "terminal-fail", lastEval, `unit exhausted after ${deps.maxRounds} round(s)`));
  }
  return { outcome: "exhausted", finalVerdict: lastEval, rounds };
}

/** Build one attempt-ledger record from a round's `ParentSummary`. Pure + holdout-safe (only the
 *  parent-safe control fields feed it). `kind` describes the generation just run; `decision` is the
 *  loop's choice after grading. */
function roundAttempt(
  round: number,
  pivoting: boolean,
  decision: AttemptInput["decision"],
  summary: ParentSummary | undefined,
  reason?: string,
): AttemptInput {
  const kind: AttemptKind = round === 1 ? "initial" : pivoting ? "pivot" : "patch";
  const verdict = summary?.verdict === "pass" ? "pass" : summary?.verdict === "fail" ? "fail" : null;
  const blocking = summary?.blocking?.slice(0, 3).join("; ");
  return {
    round,
    kind,
    decision,
    score: summary?.weightedTotal ?? null,
    verdict,
    verdictPath: summary?.verdictPath ?? null,
    reason: reason ?? blocking ?? `round ${round} ${decision}`,
    cost: summary?.costUsd ?? null,
  };
}

/** llm: the brain drives turn-by-turn, hard-bounded by the round budget. */
export async function runUnitLlm(deps: ConductUnitDeps): Promise<ConductUnitResult> {
  // RESUME: skip the contract phase (persisted contract reused in place).
  const contract = deps.resumeContract
    ? resumedContract(deps.resumeContract)
    : await negotiateContract(
        { runRole: deps.runRole },
        {
          contractGeneratorSpec: deps.specs.contractGeneratorSpec,
          contractEvaluatorSpec: deps.specs.contractEvaluatorSpec,
          maxRounds: deps.contractMaxRounds,
        },
      );

  let round = 1;
  let genRole = deps.generatorRole;
  let last: ParentSummary | undefined;
  const rounds: ConductRoundRecord[] = [];
  const contractForced = deps.resumeContract?.forced ?? !contract.agreed;
  const priorVerdictPaths: string[] = [...(deps.seedVerdictPaths ?? [])];
  // Attempt-ledger phantom-round guard: a brain decision made AFTER an already-evaluated round
  // (accept/abandon/surface→abandon) records against the LAST EXECUTED round — never a new round
  // number carrying that round's copied eval fields. A round that KEEPS going has its continue-patch
  // DEFERRED and flushed when the next round actually runs; if the loop exhausts instead, the last
  // executed round's record carries the terminal outcome. Only executed rounds are ever recorded.
  let executedRound = 0;
  let executedPivoting = false;
  let deferred = false;

  while (round <= deps.maxRounds) {
    const driveCtx: DriveContext = {
      unit: deps.unit,
      round,
      maxRounds: deps.maxRounds,
      contractAgreed: contract.agreed,
      ...(last ? { last } : {}),
    };
    const d = deps.brain ? await deps.brain.drive(driveCtx) : undefined;
    const action = d?.answer ?? "run";

    if (action === "accept") {
      if (executedRound) deps.recordRound?.(roundAttempt(executedRound, executedPivoting, "accept", last, "llm brain accepted"));
      return { outcome: "accepted", contractAgreed: contract.agreed, contractForced, rounds, ...(last ? { finalVerdict: last } : {}) };
    }
    if (action === "abandon") {
      if (executedRound) deps.recordRound?.(roundAttempt(executedRound, executedPivoting, "abandon", last, "llm brain abandoned"));
      return { outcome: "abandoned", contractAgreed: contract.agreed, contractForced, rounds };
    }
    if (action === "surface") {
      const res = await deps.judge("unit-exhausted", last);
      if (res.answer === "abandon") {
        if (executedRound) deps.recordRound?.(roundAttempt(executedRound, executedPivoting, "abandon", last, "llm brain surfaced — abandoned at judgment point"));
        return { outcome: "abandoned", contractAgreed: contract.agreed, contractForced, rounds };
      }
      // otherwise fall through to run a round this turn
    }
    if (action === "escalate" && genRole.escalation) {
      genRole = genRole.escalation;
      deps.noteDecision("unit-exhausted", "escalate", "brain", "auto", "llm chose escalate");
    }

    // About to run ANOTHER round → the prior executed round genuinely CONTINUED; flush its deferred
    // continue-patch now (using its own eval summary, still in `last`).
    if (deferred && executedRound) {
      deps.recordRound?.(roundAttempt(executedRound, executedPivoting, "continue-patch", last));
      deferred = false;
    }

    // run / revise / pivot / escalate / finalize → run ONE generate+evaluate round.
    const pivoting = action === "pivot";
    const feedback = action === "revise" && d?.feedback ? [d.feedback] : pivoting ? last?.blocking ?? [] : [];
    const ctx = { round, feedback, pivoting, priorVerdictPaths: [...priorVerdictPaths] };
    await deps.runRole(deps.specs.generatorSpecFor(genRole, ctx));
    last = await deps.runRole(deps.specs.evaluatorSpec(ctx));
    rounds.push({ round, evaluator: last, pivoted: pivoting });
    if (last.verdictPath) priorVerdictPaths.push(last.verdictPath);
    executedRound = round;
    executedPivoting = pivoting;
    deferred = true; // its disposition (continue vs terminal) is decided on the NEXT turn / at exhaustion
    round += 1;
  }

  // Budget/round exhausted — the LAST EXECUTED round is terminal (its deferred continue is discarded so
  // the terminal claims that round's record; no phantom round past the last executed one is invented).
  if (executedRound) {
    deps.recordRound?.(roundAttempt(executedRound, executedPivoting, "terminal-fail", last, `unit exhausted after ${deps.maxRounds} round(s)`));
  }
  return { outcome: "exhausted", contractAgreed: contract.agreed, contractForced, rounds, ...(last ? { finalVerdict: last } : {}) };
}

/** Re-export for `run.ts` to type its contract result. */
export type { ContractNegotiationResult };
