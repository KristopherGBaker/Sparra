import type { Verdict } from "./types.ts";

/** One assertion the generator claimed in its report JSON (`assertionsClaimed`). */
export interface AssertionClaim {
  id: number;
  claim: string; // "pass" | "fail" (anything else is ignored)
  how?: string;
}

/** Claims-vs-verdict calibration gap: assertion ids the generator called the other way. */
export interface ClaimsDiff {
  count: number;
  ids: number[];
}

/**
 * Pure claims-vs-verdict diff: which assertions did the generator claim one way while the
 * evaluator graded the other? An omitted/empty claims field is a complete no-op; claims
 * without a matching verdict assertion (or with a non-pass/fail claim) are skipped.
 */
export function diffClaims(claims: AssertionClaim[] | undefined, assertions: Verdict["assertions"]): ClaimsDiff {
  if (!Array.isArray(claims) || claims.length === 0) return { count: 0, ids: [] };
  const byId = new Map<number, boolean>();
  for (const a of assertions) byId.set(Number((a as { id?: unknown })?.id), Boolean((a as { pass?: unknown })?.pass));
  const ids: number[] = [];
  for (const c of claims) {
    const id = Number(c?.id);
    if (!Number.isFinite(id) || !byId.has(id)) continue;
    const claimedPass = c.claim === "pass" ? true : c.claim === "fail" ? false : undefined;
    if (claimedPass !== undefined && claimedPass !== byId.get(id) && !ids.includes(id)) ids.push(id);
  }
  return { count: ids.length, ids };
}

/** Markdown section appended to the round's verdict artifact (ids + count only — never
 *  evaluator/holdout text, so the redaction flow is untouched). */
export function renderClaimGap(gap: ClaimsDiff): string {
  return `\n## Calibration gap (generator claims vs verdict)\n- ${gap.count} claimed assertion(s) contradicted by the evaluator: ids ${gap.ids.join(", ")}\n`;
}
