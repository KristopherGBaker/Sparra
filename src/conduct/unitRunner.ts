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

export interface ConductUnitResult {
  outcome: UnitOutcome;
  contractAgreed: boolean;
  /** True when the build proceeded despite a non-agreed contract (forced finalization). */
  contractForced: boolean;
  finalVerdict?: ParentSummary;
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
  /** Write a GENERALIZED-spec brief revision as a NEW file (never edits history); returns its path. */
  writeGeneralizedBrief: (round: number) => Promise<string>;
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

/** hybrid: deterministic loop + brain/decision-engine at the five judgment points. */
export async function runUnitHybrid(deps: ConductUnitDeps): Promise<ConductUnitResult> {
  const contract = await negotiateContract(
    { runRole: deps.runRole },
    {
      contractGeneratorSpec: deps.specs.contractGeneratorSpec,
      contractEvaluatorSpec: deps.specs.contractEvaluatorSpec,
      maxRounds: deps.contractMaxRounds,
    },
  );

  let brief: string | undefined;
  let contractForced = false;
  if (!contract.agreed) {
    const res = await deps.judge("contract-nonconvergence", contract.rounds.at(-1)?.evaluator);
    if (res.answer === "abandon") {
      return { outcome: "abandoned", contractAgreed: false, contractForced: false };
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
    ...(cycle.finalVerdict ? { finalVerdict: cycle.finalVerdict } : {}),
  };
}

async function runHybridRounds(
  deps: ConductUnitDeps,
  briefOverride?: string,
): Promise<{ outcome: UnitOutcome; finalVerdict?: ParentSummary }> {
  let round = 1;
  let consecutiveFailures = 0;
  let feedback: string[] = [];
  let pivoting = false;
  let pivotCount = 0;
  let genRole = deps.generatorRole;
  let brief = briefOverride;
  let lastEval: ParentSummary | undefined;

  while (round <= deps.maxRounds) {
    const ctx = { round, feedback, pivoting };
    const genSpec = deps.specs.generatorSpecFor(genRole, ctx, brief);
    const genRaw = await deps.runRole(genSpec);
    const genRec = await recover(deps, genSpec, genRaw);
    if (genRec.abandon) return { outcome: "abandoned", finalVerdict: lastEval };

    const evalSpec = deps.specs.evaluatorSpec(ctx);
    const evalRaw = await deps.runRole(evalSpec);
    const evalRec = await recover(deps, evalSpec, evalRaw);
    if (evalRec.abandon) return { outcome: "abandoned", finalVerdict: evalRec.summary };
    const evalSummary = evalRec.summary;
    lastEval = evalSummary;

    const decision = deps.decide(
      evalSummary,
      { consecutiveFailures },
      { pivotAfterFailures: deps.pivotAfterFailures, requireCrossModel: deps.requireCrossModel },
    );

    if (decision === "accept") {
      if (isBorderline(evalSummary, deps.passThreshold, deps.borderlineMargin)) {
        const res = await deps.judge("borderline-accept", evalSummary);
        if (res.answer === "abandon") return { outcome: "abandoned", finalVerdict: evalSummary };
        if (res.answer === "revise") {
          consecutiveFailures += 1;
          feedback = evalSummary.blocking ?? [];
          pivoting = false;
          round += 1;
          continue;
        }
      }
      return { outcome: "accepted", finalVerdict: evalSummary };
    }
    if (decision === "grade-not-independent") {
      const res = await deps.judge("gate-collapse", evalSummary);
      if (res.answer === "accept-anyway") return { outcome: "accepted", finalVerdict: evalSummary };
      if (res.answer === "retry") {
        round += 1;
        continue;
      }
      return { outcome: "grade-not-independent", finalVerdict: evalSummary };
    }
    if (decision === "inconclusive") {
      return { outcome: "inconclusive", finalVerdict: evalSummary };
    }
    if (decision === "revise") {
      consecutiveFailures += 1;
      feedback = evalSummary.blocking ?? [];
      pivoting = false;
      round += 1;
      continue;
    }
    // decision === "pivot"
    pivotCount += 1;
    consecutiveFailures = 0;
    feedback = evalSummary.blocking ?? [];
    pivoting = true;
    if (pivotCount >= 2) {
      // 2nd pivot: prefer escalation / spec-generalization over another same-level round.
      if (genRole.escalation) {
        genRole = genRole.escalation;
        deps.noteDecision("unit-exhausted", "escalate", "auto-deterministic", "auto", "2nd pivot → escalate generator");
      } else {
        brief = await deps.writeGeneralizedBrief(round);
        deps.noteDecision("unit-exhausted", "generalize-spec", "auto-deterministic", "auto", "2nd pivot → generalize brief");
      }
    }
    round += 1;
  }

  // Rounds exhausted → the fifth judgment point.
  const res = await deps.judge("unit-exhausted", lastEval);
  if (res.answer === "abandon") return { outcome: "abandoned", finalVerdict: lastEval };
  return { outcome: "exhausted", finalVerdict: lastEval };
}

/** llm: the brain drives turn-by-turn, hard-bounded by the round budget. */
export async function runUnitLlm(deps: ConductUnitDeps): Promise<ConductUnitResult> {
  const contract = await negotiateContract(
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
  const contractForced = !contract.agreed;

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
      return { outcome: "accepted", contractAgreed: contract.agreed, contractForced, ...(last ? { finalVerdict: last } : {}) };
    }
    if (action === "abandon") {
      return { outcome: "abandoned", contractAgreed: contract.agreed, contractForced };
    }
    if (action === "surface") {
      const res = await deps.judge("unit-exhausted", last);
      if (res.answer === "abandon") {
        return { outcome: "abandoned", contractAgreed: contract.agreed, contractForced };
      }
      // otherwise fall through to run a round this turn
    }
    if (action === "escalate" && genRole.escalation) {
      genRole = genRole.escalation;
      deps.noteDecision("unit-exhausted", "escalate", "brain", "auto", "llm chose escalate");
    }

    // run / revise / pivot / escalate / finalize → run ONE generate+evaluate round.
    const pivoting = action === "pivot";
    const feedback = action === "revise" && d?.feedback ? [d.feedback] : pivoting ? last?.blocking ?? [] : [];
    const ctx = { round, feedback, pivoting };
    await deps.runRole(deps.specs.generatorSpecFor(genRole, ctx));
    last = await deps.runRole(deps.specs.evaluatorSpec(ctx));
    round += 1;
  }

  // Budget/round exhausted — terminal, no further drive/role calls.
  return { outcome: "exhausted", contractAgreed: contract.agreed, contractForced, ...(last ? { finalVerdict: last } : {}) };
}

/** Re-export for `run.ts` to type its contract result. */
export type { ContractNegotiationResult };
