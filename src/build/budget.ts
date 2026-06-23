/**
 * Per-item budget guard — "start closed". The build loop tracks an item's
 * cumulative cost and stops working it the moment it crosses the configured cap,
 * marking it BUDGET_EXCEEDED rather than silently continuing.
 *
 * Convention (matches the rest of the config): a cap of 0 (or negative) means
 * "no cap / unlimited".
 */

/** True when the cap is active and accumulated spend has reached/passed it. */
export function budgetExceeded(capUsd: number, spentUsd: number): boolean {
  return capUsd > 0 && spentUsd >= capUsd;
}

/**
 * The budget still available for the next session, given a per-item cap and what
 * the item has already spent. Returns 0 when there is no cap (0 = unlimited),
 * which the session layer also treats as "no per-session budget".
 */
export function remainingBudget(capUsd: number, spentUsd: number): number {
  if (capUsd <= 0) return 0; // no cap
  return Math.max(0, capUsd - spentUsd);
}
