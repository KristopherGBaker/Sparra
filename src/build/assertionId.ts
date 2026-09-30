import type { AssertionId } from "./types.ts";

const INTEGER_LITERAL_RE = /^[+-]?\d+$/;

/**
 * Canonicalize a model-emitted assertion id. Evaluators emit plain integers (`7`), numeric
 * strings (`"7"`), and sub-assertion / holdout labels (`"6b"`, `"H4"`). Integers (number or
 * integer-literal string) become a NUMBER; any other non-empty trimmed string is kept verbatim;
 * anything unusable (missing, null, empty, NaN, non-integer number, object) → `0`, preserving the
 * historical `?? 0` fallback for a missing id.
 */
export function normalizeAssertionId(raw: unknown): AssertionId {
  if (typeof raw === "number") return Number.isInteger(raw) ? raw : 0;
  if (typeof raw !== "string") return 0;
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  if (INTEGER_LITERAL_RE.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isSafeInteger(n) ? n : trimmed;
  }
  return trimmed;
}

/** The ONE comparison key for an assertion id — two ids are the same assertion iff keys match. */
export function assertionKey(id: AssertionId): string {
  return String(id);
}

/** Set of keys for a list of ids — the by-key stand-in for `new Set(ids)` membership tests. */
export function assertionKeySet(ids: readonly AssertionId[] | undefined): Set<string> {
  return new Set((ids ?? []).map(assertionKey));
}

/** Normalize + dedupe (by key) a model-emitted un-run id list, dropping `0` and negative numbers
 *  (no usable id) while keeping non-empty string ids. */
export function normalizeUnrunIds(arr: unknown): AssertionId[] {
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  const out: AssertionId[] = [];
  for (const raw of arr) {
    const id = normalizeAssertionId(raw);
    if (typeof id === "number" && id <= 0) continue;
    const key = assertionKey(id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}
