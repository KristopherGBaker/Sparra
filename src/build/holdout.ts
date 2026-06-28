import type { Ctx } from "../context.ts";
import { readText } from "../util/io.ts";

/**
 * The isolation wall (from Kallistra): optional acceptance checks the human authors
 * in HOLDOUT.md that ONLY the evaluator sees. The generator and the contract
 * negotiation never see them, so the builder can't overfit/teach-to-the-test — a
 * second, independent gate on real behavior. Enforced in code via assertNoHoldoutLeak.
 */

/** Read the holdout (frozen copy preferred; falls back to the live file). "" if none. */
export async function readHoldout(ctx: Ctx): Promise<string> {
  return (await readText(ctx.paths.frozenHoldout)) ?? (await readText(ctx.paths.holdout)) ?? "";
}

/** Wrap holdout text for the EVALUATOR prompt. Pure; "" when there is no holdout. */
export function holdoutSection(text: string): string {
  if (!text.trim()) return "";
  return `\nHOLDOUT ACCEPTANCE CHECKS — the builder NEVER saw these; they guard against overfitting to the contract. Exercise each against the artifact and treat ANY holdout failure as BLOCKING (it fails the item regardless of rubric score):\n---\n${text.trim()}\n---\n`;
}

/** Redact any verbatim holdout line from conductor/human-facing text — used for
 *  role-run verdicts and interactive pause notes so the holdout the evaluator may
 *  quote never reaches the human/generator. */
export function redactHoldout(text: string, holdoutText: string): string {
  let out = text;
  for (const line of holdoutLines(holdoutText)) out = out.split(line).join("[redacted: holdout]");
  return out;
}

/** Substantive holdout lines (strip markdown markers; ignore short/structural lines). */
export function holdoutLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^[\s#>*\-\d.]+/, "").trim())
    .filter((l) => l.length >= 15);
}

/**
 * Code-enforced isolation wall: throw if any substantive holdout line appears in a
 * prompt the BUILDER (generator) or the contract negotiation can see. If holdout is
 * ever wired into those paths by mistake, the build fails loudly instead of silently
 * leaking the test.
 */
export function assertNoHoldoutLeak(role: string, prompt: string, holdoutText: string): void {
  if (!holdoutText.trim()) return;
  for (const line of holdoutLines(holdoutText)) {
    if (prompt.includes(line)) {
      throw new Error(
        `Holdout leaked into the ${role} prompt — the builder must never see holdout checks: "${line.slice(0, 60)}${line.length > 60 ? "…" : ""}"`
      );
    }
  }
}
