import type { ItemState } from "../state.ts";
import type { Verdict } from "./types.ts";
import { TRUNCATION_MARKER } from "./feedback.ts";

/**
 * Per-item ATTEMPT LEDGER (Q6). On each GAN pivot the build loop appends what was tried and why
 * it failed to the durable item state; a fresh (pivot) restart then gets a bounded
 * "PRIOR ATTEMPTS — do not repeat these approaches" section, so "genuinely different" is
 * concrete rather than aspirational. Applies on every run shape (in-place included — the ledger
 * needs no workspace reset).
 *
 * REDACTION WALL (same as feedback.ts): ledger text is built ONLY from the generator's own
 * report and Verdict fields — both already holdout-redacted upstream. Do NOT feed raw evaluator
 * session/result text into `recordAttempt`.
 */

/** Per-entry char caps — one attempt can't flood the fresh prompt. */
export const APPROACH_CAP = 500;
export const FAILURE_CAP = 400;
/** Bounded injection: only the most recent N ledger entries are rendered. */
export const MAX_PROMPT_ATTEMPTS = 5;

export interface AttemptEntry {
  round: number;
  approach: string;
  failure: string;
}

const truncate = (s: string, cap: number): string =>
  s.length > cap ? s.slice(0, cap) + TRUNCATION_MARKER : s;

/** Append a (capped) attempt entry to the item's durable ledger. */
export function recordAttempt(item: ItemState, entry: AttemptEntry): void {
  item.attempts ??= [];
  item.attempts.push({
    round: entry.round,
    approach: truncate(entry.approach.trim() || "(no report recorded)", APPROACH_CAP),
    failure: truncate(entry.failure.trim() || "(no failure detail recorded)", FAILURE_CAP),
  });
}

/** The top blocking items (already redacted Verdict fields only) as the entry's failure text. */
export function attemptFailure(verdict: Verdict): string {
  return verdict.blocking.slice(0, 3).join("; ") || verdict.notes || "";
}

/** Render the bounded PRIOR ATTEMPTS section for a FRESH (pivot) generate; "" when no ledger. */
export function renderPriorAttempts(attempts: AttemptEntry[] | undefined): string {
  if (!attempts?.length) return "";
  const shown = attempts.slice(-MAX_PROMPT_ATTEMPTS);
  const lines = shown.map(
    (a) => `- round ${a.round} approach: ${a.approach}\n  failed because: ${a.failure}`
  );
  return `PRIOR ATTEMPTS — do not repeat these approaches (each already failed):\n${lines.join("\n")}`;
}
