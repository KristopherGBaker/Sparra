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
 *
 * When an assertion has failed the SAME check for K consecutive rounds the build loop
 * ESCALATES it (`escalateAssertionIds`): its evidence is rendered UNCAPPED and the patch
 * feedback is prefixed with a diagnose-first instruction naming those ids — a register
 * between a plain patch and a full GAN pivot (see `src/phases/build.ts`).
 */

/** Per-assertion evidence cap (chars) — roughly a few lines of observed output. */
export const EVIDENCE_CAP = 300;
/** Marks an ELISION in over-cap evidence — placed between the kept head and the kept
 *  error-bearing tail (not a trailing suffix), so a long compiler/test dump keeps both
 *  the leading context and the actual failing line. */
export const TRUNCATION_MARKER = " …[truncated]";
/** Lines matching this are error-bearing and kept preferentially by the tail window. */
const ERROR_LINE_RE = /error|fail|expected|✕|✗/i;

export interface FeedbackOptions {
  /** Override the per-assertion evidence cap (chars). Default `EVIDENCE_CAP`. */
  evidenceCap?: number;
  /** Assertion ids to ESCALATE: render their evidence UNCAPPED and prepend a diagnose-first
   *  instruction naming them (set by the patch branch once an assertion's fail streak reaches
   *  `build.assertionEscalateAfter`). Other assertions stay capped. */
  escalateAssertionIds?: number[];
}

/** Char index where the LAST error-bearing line begins, or -1 if none matches. */
function lastErrorLineStart(text: string): number {
  const lines = text.split("\n");
  let offset = 0;
  let found = -1;
  for (const line of lines) {
    if (ERROR_LINE_RE.test(line)) found = offset;
    offset += line.length + 1; // +1 for the elided "\n"
  }
  return found;
}

/**
 * Error-biased truncation: evidence AT OR UNDER `cap` is returned byte-identically (as today).
 * Over-cap evidence keeps a HEAD window + an error-bearing TAIL window joined by
 * `TRUNCATION_MARKER`, so the actual failing line at the end of a long dump survives instead of
 * being sliced off by a blind head-only cut. The kept text (head + tail, excluding the marker)
 * never exceeds `cap`. Pure/deterministic — same input → same output.
 */
export function truncateEvidence(evidence: string, cap: number): string {
  if (evidence.length <= cap) return evidence;
  // Bias toward the tail: compiler/test dumps put the real failing line at the END. Keep a
  // minority head for leading context and the majority for the error-bearing tail.
  const minHead = Math.floor(cap * 0.15);
  let headLen = Math.floor(cap * 0.35);
  let tailLen = cap - headLen;
  const errStart = lastErrorLineStart(evidence);
  if (errStart >= 0) {
    // Grow the tail back to the start of the last error line when it fits, but never starve
    // the head below `minHead` (so a very early error can't blow the leading context away).
    const fromErr = evidence.length - errStart;
    tailLen = Math.min(cap - minHead, Math.max(tailLen, fromErr));
    headLen = cap - tailLen;
  }
  const head = evidence.slice(0, headLen);
  const tail = evidence.slice(evidence.length - tailLen);
  return head + TRUNCATION_MARKER + tail;
}

/** `#<id>: <evidence>` lines for FAILED assertions only, evidence capped + marked — except
 *  ESCALATED ids (`escalateAssertionIds`), whose evidence is rendered UNCAPPED. */
function failedAssertionLines(verdict: Verdict, opts: FeedbackOptions = {}): string[] {
  const cap = opts.evidenceCap ?? EVIDENCE_CAP;
  const escalate = new Set(opts.escalateAssertionIds ?? []);
  const unrun = new Set(verdict.unrunAssertionIds ?? []);
  return verdict.assertions
    .filter((a) => !a.pass && !unrun.has(a.id))
    .map((a) => {
      const evidence = (a.evidence ?? "").trim();
      const rendered = escalate.has(a.id) ? evidence : truncateEvidence(evidence, cap);
      return `#${a.id}: ${rendered || "(no evidence recorded)"}`;
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
      const capped = truncateEvidence(evidence, cap);
      return `#${a.id}: ${capped || "(environment prevented execution)"}`;
    });
}

/** Diagnose-first prefix for the PATCH path when one or more assertions have hit the escalation
 *  streak — names the ids and demands a root-cause statement before another symptom patch. "" when
 *  nothing is escalated (so a non-escalated round renders byte-identically to before). */
function diagnoseFirstPrefix(opts: FeedbackOptions): string {
  const ids = opts.escalateAssertionIds ?? [];
  if (!ids.length) return "";
  const named = ids.map((id) => `#${id}`).join(", ");
  return (
    `DIAGNOSE FIRST: assertion(s) ${named} have failed the same check for repeated rounds — ` +
    `stop patching symptoms. State the ROOT CAUSE of ${named} (why the prior fixes did not work) ` +
    `before editing, then fix that cause. Their full (uncapped) evidence is below.\n`
  );
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
  return `${diagnoseFirstPrefix(opts)}Address these ${verdictBody(verdict, opts)}`;
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
