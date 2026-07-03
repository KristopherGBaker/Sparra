import type { Verdict } from "./types.ts";

/**
 * Between-round generator feedback, rendered from the `Verdict` ONLY.
 *
 * This module is the redaction wall for generator feedback: every field on the Verdict
 * (blocking, notes, assertion evidence) is already holdout-redacted upstream in
 * `evaluate.ts`, so a pure function of the Verdict can never leak raw evaluator
 * session/result text to the generator. Do NOT add parameters that carry evaluator
 * `resultText` or transcript content.
 *
 * Each failed assertion contributes a `#<id>: <evidence>` line (evidence capped per
 * assertion so one verbose failure can't flood the prompt); passed assertions are
 * omitted — the generator only needs to see why it failed and what was observed.
 * A round's `claimMismatches` (ids + count only) adds ONE calibration nudge.
 */

/** Per-assertion evidence cap (chars) — roughly a few lines of observed output. */
export const EVIDENCE_CAP = 300;
/** Appended when an assertion's evidence was cut at the cap. */
export const TRUNCATION_MARKER = " …[truncated]";

export interface FeedbackOptions {
  /** Override the per-assertion evidence cap (chars). Default `EVIDENCE_CAP`. */
  evidenceCap?: number;
}

/** `#<id>: <evidence>` lines for FAILED assertions only, evidence capped + marked. */
function failedAssertionLines(verdict: Verdict, opts: FeedbackOptions = {}): string[] {
  const cap = opts.evidenceCap ?? EVIDENCE_CAP;
  const unrun = new Set(verdict.unrunAssertionIds ?? []);
  return verdict.assertions
    .filter((a) => !a.pass && !unrun.has(a.id))
    .map((a) => {
      const evidence = (a.evidence ?? "").trim();
      const capped = evidence.length > cap ? evidence.slice(0, cap) + TRUNCATION_MARKER : evidence;
      return `#${a.id}: ${capped || "(no evidence recorded)"}`;
    });
}

/** UN-RUN assertions are no-signal environment/tooling misses, not behavioral failures. */
function unrunAssertionLines(verdict: Verdict, opts: FeedbackOptions = {}): string[] {
  const cap = opts.evidenceCap ?? EVIDENCE_CAP;
  const unrun = new Set(verdict.unrunAssertionIds ?? []);
  return verdict.assertions
    .filter((a) => unrun.has(a.id))
    .map((a) => {
      const evidence = (a.evidence ?? "").trim();
      const capped = evidence.length > cap ? evidence.slice(0, cap) + TRUNCATION_MARKER : evidence;
      return `#${a.id}: ${capped || "(environment prevented execution)"}`;
    });
}

/** ONE calibration nudge when the round's `claimMismatches` (assertion ids + count only,
 *  set by the build loop from build/claims.ts) contradicted the verdict; "" otherwise.
 *  Stated once here — the renderers share it, never restate it. */
function calibrationLine(verdict: Verdict): string {
  const cm = verdict.claimMismatches;
  if (!cm || cm.count <= 0) return "";
  return `\nCalibration: you claimed pass on ${cm.ids.map((id) => `#${id}`).join(", ")} but the evaluator graded otherwise — VERIFY those assertions before claiming pass.`;
}

/** Blocking items + per-failed-assertion evidence — the shared body of every feedback kind. */
function verdictBody(verdict: Verdict, opts: FeedbackOptions = {}): string {
  const failed = failedAssertionLines(verdict, opts);
  const unrun = unrunAssertionLines(verdict, opts);
  const blocking = verdict.blocking.map((x) => `- ${x}`).join("\n");
  return (
    `blocking issues from the evaluator:\n${blocking || verdict.notes || "- (none listed — see failed assertions)"}` +
    `\nFailed assertions (id: observed evidence):\n${failed.join("\n") || "(see verdict)"}` +
    (unrun.length ? `\nUn-run assertions (no signal; environment/tooling could not execute):\n${unrun.join("\n")}` : "") +
    calibrationLine(verdict)
  );
}

/** PATCH path: fix the blocking issues in place; evidence shows what the evaluator observed. */
export function renderPatchFeedback(verdict: Verdict, opts: FeedbackOptions = {}): string {
  return `Address these ${verdictBody(verdict, opts)}`;
}

/** GAN-PIVOT path: keep the restart-from-scratch instruction, then the latest verdict's detail. */
export function renderPivotFeedback(
  verdict: Verdict,
  pivot: { criterion: string; threshold: number; rounds: number },
  opts: FeedbackOptions = {}
): string {
  return (
    `GAN PIVOT: this item stayed below ${pivot.threshold} on "${pivot.criterion}" for ${pivot.rounds} rounds. ` +
    `Discard the previous approach entirely and rebuild from scratch with a fundamentally different design.\n` +
    `Latest ${verdictBody(verdict, opts)}`
  );
}

/** BLOCKED-exercise path: inconclusive (environment, not the artifact) — steer toward
 *  exercisability; include failed-assertion evidence only when the verdict carries some. */
export function renderBlockedFeedback(verdict: Verdict, opts: FeedbackOptions = {}): string {
  const failed = failedAssertionLines(verdict, opts);
  const unrun = unrunAssertionLines(verdict, opts);
  const why = (verdict.blocking.slice(0, 3).join("; ") || verdict.notes).slice(0, 300);
  return (
    `The exercise could NOT run (blocked): ${why}. This is NOT a behavioral failure — ensure the artifact is exercisable (its tests/build can actually run) so it can be verified.` +
    (failed.length ? `\nWhat the evaluator observed (id: evidence):\n${failed.join("\n")}` : "") +
    (unrun.length ? `\nUn-run assertions (no signal; environment/tooling could not execute):\n${unrun.join("\n")}` : "") +
    calibrationLine(verdict)
  );
}
