import fsp from "node:fs/promises";

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
import { assertionKey, normalizeAssertionId } from "../build/assertionId.ts";
import type { AssertionId } from "../build/types.ts";

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
  /** Contract-defect / strike-assertion recovery: rewrite the unit's contract to STRIKE (deactivate)
   *  the poisoned assertion, preserving its id + rationale as an INERT annotation — never a gradeable
   *  assertion. Called ONLY when the contract-defect signature holds; the strike is immediately followed
   *  by a re-EVALUATION of the existing artifact (no generate round). */
  strikeAssertion: (assertionId: AssertionId, rationale: string) => Promise<void>;
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

/** The failing assertion ids reported by one round's evaluator (already redacted to genuine failures
 *  by the runner — un-run/no-signal assertions are excluded upstream). */
function failedAssertionIds(summary: ParentSummary): AssertionId[] {
  return (summary.failedAssertions ?? []).map((a) => a.id);
}

/**
 * DETECT the contract-defect signature over a unit's completed rounds. The signature: the SAME
 * assertion id appears in the failed set of EVERY completed round AND the final round has NO OTHER
 * failing assertion (its failed set is exactly that one id). Returns the poisoned id when it holds,
 * else `undefined`.
 *
 * Deliberately does NOT require a singleton failure in every round — an earlier round may fail the
 * poisoned id PLUS others; only the FINAL round must isolate it. Any round where the id is absent from
 * the failed set (it passed there, or that round failed a different id) breaks the signature, as does a
 * final round with two or more distinct failing ids.
 */
export function detectContractDefect(rounds: ConductRoundRecord[]): AssertionId | undefined {
  if (rounds.length === 0) return undefined;
  const finalIds = failedAssertionIds(rounds[rounds.length - 1]!.evaluator);
  // The final round must isolate exactly ONE failing assertion (no OTHER failing ids).
  if (finalIds.length !== 1) return undefined;
  const poisoned = finalIds[0]!;
  // Normalize before keying: a JSON round-trip can carry `"7"` (or `" 7 "`) where another round has `7`.
  const poisonedId = normalizeAssertionId(poisoned);
  const poisonedKey = assertionKey(poisonedId);
  // A gate Jev judged environment-blocked in the FINAL round could not run — that is not a contract
  // defect (the assertion is fine; the grader's sandbox is the problem), so never strike it.
  const finalEnvBlocked = rounds[rounds.length - 1]!.evaluator.envBlockedAssertionIds ?? [];
  if (finalEnvBlocked.some((id) => assertionKey(normalizeAssertionId(id)) === poisonedKey)) return undefined;
  // That id must appear in the failed set of EVERY completed round (compared by key).
  for (const r of rounds) {
    if (!failedAssertionIds(r.evaluator).some((id) => assertionKey(normalizeAssertionId(id)) === poisonedKey)) return undefined;
  }
  return poisonedId;
}

/** The rationale recorded on a contract-defect strike (audit trail + inert contract annotation). */
function contractDefectRationale(assertionId: AssertionId): string {
  return (
    `contract-defect signature: assertion #${assertionId} failed every round while all other ` +
    `assertions passed — the artifact is correct and the assertion is the defect`
  );
}

/**
 * STRIKE-ASSERTION recovery: deactivate the poisoned assertion in the contract, then re-EVALUATE the
 * EXISTING artifact (NEVER a generate round) and route the re-eval through the NORMAL acceptance
 * decision — a passing re-eval reaches the accept path, a failing one the normal failure handling.
 */
async function strikeAndReEvaluate(
  deps: ConductUnitDeps,
  args: { poisonedId: AssertionId; round: number; priorVerdictPaths: string[]; rounds: ConductRoundRecord[] },
): Promise<{ outcome: UnitOutcome; finalVerdict?: ParentSummary; rounds: ConductRoundRecord[] }> {
  const { poisonedId, round, rounds } = args;
  // 1. Strike the poisoned assertion (surgical: only it becomes inert; every other assertion unchanged).
  await deps.strikeAssertion(poisonedId, contractDefectRationale(poisonedId));
  // 2. Re-run EVALUATION of the existing artifact — NO generator invocation.
  const ctx = { round, feedback: [] as string[], pivoting: false, priorVerdictPaths: [...args.priorVerdictPaths] };
  const evalSpec = deps.specs.evaluatorSpec(ctx);
  const evalRaw = await deps.runRole(evalSpec);
  const evalRec = await recover(deps, evalSpec, evalRaw);
  if (evalRec.abandon) {
    rounds.push({ round, evaluator: evalRec.summary, pivoted: false });
    deps.recordRound?.(roundAttempt(round, false, "abandon", evalRec.summary, "strike-assertion re-eval recovery abandoned at judgment point"));
    return { outcome: "abandoned", finalVerdict: evalRec.summary, rounds };
  }
  const evalSummary = evalRec.summary;
  rounds.push({ round, evaluator: evalSummary, pivoted: false });
  // 3. Route the re-eval through the NORMAL acceptance decision.
  const decision = deps.decide(
    evalSummary,
    { consecutiveFailures: 0 },
    { pivotAfterFailures: deps.pivotAfterFailures, requireCrossModel: deps.requireCrossModel },
  );
  if (decision === "accept") {
    deps.recordRound?.(roundAttempt(round, false, "accept", evalSummary, "strike-assertion re-eval accepted"));
    return { outcome: "accepted", finalVerdict: evalSummary, rounds };
  }
  if (decision === "grade-not-independent") {
    deps.recordRound?.(roundAttempt(round, false, "terminal-inconclusive", evalSummary, "strike-assertion re-eval: cross-model gate collapse"));
    return { outcome: "grade-not-independent", finalVerdict: evalSummary, rounds };
  }
  if (decision === "inconclusive") {
    deps.recordRound?.(roundAttempt(round, false, "terminal-inconclusive", evalSummary, "strike-assertion re-eval inconclusive (no behavioral signal)"));
    return { outcome: "inconclusive", finalVerdict: evalSummary, rounds };
  }
  // revise / pivot — the re-eval still fails: normal failure handling leaves the unit exhausted.
  deps.recordRound?.(roundAttempt(round, false, "terminal-fail", evalSummary, "strike-assertion re-eval still failing"));
  return { outcome: "exhausted", finalVerdict: evalSummary, rounds };
}

/** A markdown line that OPENS a contract assertion item, with its explicit ordinal when numbered. */
interface AssertionOpener {
  /** 0-based line index in the contract. */
  index: number;
  /** The explicit ordinal for a numbered opener (`3.` / `3)`), else `null` for an unnumbered bullet. */
  num: number | null;
}

/** A numbered assertion opener: optionally under a `-`/`*`/`+` bullet or `**bold**`, then `<n>.`/`<n>)`. */
const NUMBERED_OPENER = /^\s*(?:[-*+]\s+)?(?:\*\*)?(\d+)[.)]/;
/** An unnumbered bullet opener: `-`/`*`/`+` then non-space content. */
const BULLET_OPENER = /^\s*[-*+]\s+\S/;
/** A markdown heading. */
const HEADING = /^#{1,6}\s/;
/** The "## Assertions" (or similar) section heading. */
const ASSERTIONS_HEADING = /^#{1,6}\s+.*\bassertions?\b/i;

/** The `[start, end)` line range of the contract's assertions section — the block under an
 *  `assertions` heading (up to the next heading), or the WHOLE document when no such heading exists. */
function assertionRegion(lines: string[]): [number, number] {
  const h = lines.findIndex((l) => ASSERTIONS_HEADING.test(l));
  if (h < 0) return [0, lines.length];
  let end = lines.length;
  for (let i = h + 1; i < lines.length; i++) {
    if (HEADING.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return [h + 1, end];
}

/**
 * Resolve the poisoned assertion id to the contract LINE that opens it, across EVERY supported
 * assertion form. Returns the 0-based line index, or `-1` when the id cannot be resolved (so the caller
 * can FAIL CLOSED). Within the assertions region:
 *   1. an explicit numbered opener whose ordinal === `assertionId` wins (numbered lists);
 *   2. else, when the list is (partly) UNNUMBERED, the `assertionId`-th opener by position wins
 *      (positional/unnumbered-bullet lists — the evaluator numbers those by order);
 *   3. else — a fully-numbered list with no matching ordinal, or a position out of range — it is
 *      UNRESOLVED (`-1`): never silently strike the wrong line.
 * A non-numeric id (`"6b"`, `"H4"`) names no contract ordinal, so it is always UNRESOLVED (`-1`).
 */
export function resolveAssertionLineIndex(lines: string[], id: AssertionId): number {
  const assertionId = normalizeAssertionId(id);
  if (typeof assertionId !== "number") return -1;
  const [start, end] = assertionRegion(lines);
  const openers: AssertionOpener[] = [];
  for (let i = start; i < end; i++) {
    const numMatch = NUMBERED_OPENER.exec(lines[i]!);
    if (numMatch) {
      openers.push({ index: i, num: Number(numMatch[1]) });
    } else if (BULLET_OPENER.test(lines[i]!)) {
      openers.push({ index: i, num: null });
    }
  }
  // 1. explicit numbered opener match.
  const byNum = openers.find((o) => o.num === assertionId);
  if (byNum) return byNum.index;
  // 2. positional fallback — ONLY when the list carries unnumbered openers (a fully-numbered list with
  //    no matching ordinal must fail closed, never be resolved by accidental position).
  const hasUnnumbered = openers.some((o) => o.num === null);
  if (hasUnnumbered && assertionId >= 1 && assertionId <= openers.length) {
    return openers[assertionId - 1]!.index;
  }
  return -1;
}

/**
 * The surgical contract rewrite behind the `strikeAssertion` dep: DEACTIVATE the poisoned assertion in
 * place — the resolved opener line is flagged INERT (struck), so it is no longer a gradeable assertion
 * while its id + text survive — and append an INERT strike-record annotation carrying the struck id +
 * rationale. Every OTHER assertion id and requirement in the file is left byte-for-byte unchanged.
 *
 * FAILS CLOSED: if the id cannot be resolved to an assertion in the contract text (a missing contract,
 * an out-of-range/absent id, an unparseable form), it throws WITHOUT writing anything — no false strike
 * record, so the caller never re-evaluates against a still-live requirement.
 */
export async function strikeContractAssertion(
  contractPath: string,
  assertionId: AssertionId,
  rationale: string,
): Promise<void> {
  let text: string;
  try {
    text = await fsp.readFile(contractPath, "utf8");
  } catch {
    throw new Error(
      `strike-assertion: cannot read contract at ${contractPath} to strike assertion #${assertionId} — failing closed (no strike, no re-eval)`,
    );
  }
  const lines = text.split("\n");
  const target = resolveAssertionLineIndex(lines, assertionId);
  if (target < 0) {
    // FAIL CLOSED — do NOT write an annotation for an assertion we could not actually deactivate.
    throw new Error(
      `strike-assertion: assertion #${assertionId} could not be resolved in the contract text — failing closed (no strike record written, no re-evaluation)`,
    );
  }
  // Deactivate the resolved opener: prefix an INERT struck marker. Its text survives verbatim, but the
  // line no longer opens a live assertion item (it starts with the marker, not a number/bullet).
  lines[target] = `~~[STRUCK #${assertionId} — contract-defect; INERT, do NOT grade]~~ ${lines[target]}`;
  const body = lines.join("\n");
  const record =
    `<!-- sparra:struck-assertions -->\n` +
    `## Struck assertions (contract-defect)\n\n` +
    `INERT — do NOT grade. Struck by the conductor's contract-defect / strike-assertion recovery after ` +
    `this assertion failed every round while all other assertions passed:\n\n` +
    `- #${assertionId} — STRUCK: ${rationale}\n`;
  const sep = body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
  await fsp.writeFile(contractPath, `${body}${sep}${record}`, "utf8");
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
        // Where the deterministic path would generalize the spec, prefer STRIKE-ASSERTION instead —
        // but ONLY when the contract-defect signature holds (the same assertion has failed every round
        // while the latest round isolates it). A poisoned assertion is unsatisfiable no matter how the
        // brief is reworded, so strike it and re-evaluate the existing artifact rather than spend more
        // generate rounds. With the signature absent, behavior is UNCHANGED — generalize-spec as before.
        const poisonedId = detectContractDefect(rounds);
        if (poisonedId !== undefined) {
          deps.noteDecision("contract-defect", "strike-assertion", "auto-deterministic", "auto", contractDefectRationale(poisonedId));
          return await strikeAndReEvaluate(deps, { poisonedId, round: round + 1, priorVerdictPaths, rounds });
        }
        brief = await deps.writeGeneralizedBrief(round);
        deps.noteDecision("unit-exhausted", "generalize-spec", "auto-deterministic", "auto", "2nd pivot → generalize brief");
        deps.recordDecisionLearning?.({ decision: "generalize-spec", round, summary: evalSummary });
      }
    }
    round += 1;
  }

  // Rounds exhausted → DETECT the contract-defect signature first: the SAME assertion id failed every
  // completed round AND the final round isolated it (no other failing assertion). When it holds, the
  // artifact is correct and the CONTRACT is the defect, so surface the dedicated `contract-defect`
  // decision (default: strike the poisoned assertion + re-evaluate) rather than the generic
  // unit-exhausted point — which just spends another round on an unsatisfiable criterion.
  const poisonedId = detectContractDefect(rounds);
  if (poisonedId !== undefined) {
    const cd = await deps.judge("contract-defect", lastEval);
    if (cd.answer === "strike-assertion") {
      return await strikeAndReEvaluate(deps, { poisonedId, round, priorVerdictPaths, rounds });
    }
    if (cd.answer === "abandon") {
      if (executedRound) {
        deps.recordRound?.(roundAttempt(executedRound, executedPivoting, "abandon", lastEval, "contract-defect — abandoned at judgment point"));
      }
      return { outcome: "abandoned", finalVerdict: lastEval, rounds };
    }
    // pivot (or any non-strike, non-abandon): fall through to the plain exhausted terminal.
    if (executedRound) {
      deps.recordRound?.(roundAttempt(executedRound, executedPivoting, "terminal-fail", lastEval, `contract-defect not struck — exhausted after ${deps.maxRounds} round(s)`));
    }
    return { outcome: "exhausted", finalVerdict: lastEval, rounds };
  }

  // No contract-defect signature → the fifth judgment point. Record the terminal outcome against the
  // LAST EXECUTED round (its deferred "continue" is discarded — never flushed — so the terminal claims
  // that round's record; the FINAL ledger record reflects the unit's true outcome and NO phantom round
  // is invented).
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
    // The llm brain's ACTUAL pivot call site — publish the decision learning here (a discarded
    // change may still teach a later unit/run). The llm DRIVE_ACTIONS expose no generalize-spec
    // action, so the hybrid/shared-seam call sites above are the complete generalize-spec set.
    if (pivoting) deps.recordDecisionLearning?.({ decision: "pivot", round, ...(last ? { summary: last } : {}) });
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
