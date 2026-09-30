import { assertionKey, normalizeAssertionId } from "./assertionId.ts";
import type { AssertionId, Verdict } from "./types.ts";

/** One assertion the generator claimed in its report JSON (`assertionsClaimed`). */
export interface AssertionClaim {
  id: AssertionId;
  claim: string; // "pass" | "fail" (anything else is ignored)
  how?: string;
}

/** Claims-vs-verdict calibration gap: assertion ids the generator called the other way. */
export interface ClaimsDiff {
  count: number;
  ids: AssertionId[];
}

/**
 * Pure claims-vs-verdict diff: which assertions did the generator claim one way while the
 * evaluator graded the other? An omitted/empty claims field is a complete no-op; claims
 * without a matching verdict assertion (or with a non-pass/fail claim) are skipped.
 */
export function diffClaims(claims: AssertionClaim[] | undefined, assertions: Verdict["assertions"]): ClaimsDiff {
  if (!Array.isArray(claims) || claims.length === 0) return { count: 0, ids: [] };
  const byKey = new Map<string, boolean>();
  for (const a of assertions) {
    const id = normalizeAssertionId((a as { id?: unknown })?.id);
    if (id !== 0) byKey.set(assertionKey(id), Boolean((a as { pass?: unknown })?.pass));
  }
  const ids: AssertionId[] = [];
  const seen = new Set<string>();
  for (const c of claims) {
    const id = normalizeAssertionId(c?.id);
    const key = assertionKey(id);
    if (id === 0 || !byKey.has(key)) continue; // 0 = missing/unusable id
    const claimedPass = c.claim === "pass" ? true : c.claim === "fail" ? false : undefined;
    if (claimedPass !== undefined && claimedPass !== byKey.get(key) && !seen.has(key)) {
      seen.add(key);
      ids.push(id);
    }
  }
  return { count: ids.length, ids };
}

/** Markdown section appended to the round's verdict artifact (ids + count only — never
 *  evaluator/holdout text, so the redaction flow is untouched). */
export function renderClaimGap(gap: ClaimsDiff): string {
  return `\n## Calibration gap (generator claims vs verdict)\n- ${gap.count} claimed assertion(s) contradicted by the evaluator: ids ${gap.ids.join(", ")}\n`;
}
