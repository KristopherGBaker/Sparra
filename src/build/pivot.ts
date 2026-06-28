import type { SparraConfig } from "../config.ts";
import type { ItemState } from "../state.ts";
import { RUBRIC_CRITERIA, type Verdict } from "./types.ts";

export interface PivotDecision {
  pivot: boolean;
  criterion?: string;
  streaks: Record<string, number>;
}

/**
 * GAN-style pivot: update per-criterion fail streaks from this round's verdict.
 * If any single criterion has stayed below the threshold for N consecutive rounds,
 * signal a pivot (discard & restart the item from scratch rather than patching).
 */
export function updateStreaksAndDecide(item: ItemState, verdict: Verdict, config: SparraConfig): PivotDecision {
  // A BLOCKED exercise is inconclusive (environment, not the artifact) — it must not move the
  // GAN-pivot machinery at all: don't advance any streak, never pivot. Keeps correct work from
  // being discarded just because the exercise couldn't run.
  if (verdict.exerciseStatus === "blocked") {
    return { pivot: false, criterion: undefined, streaks: { ...item.criterionFailStreak } };
  }
  const streaks = { ...item.criterionFailStreak };
  let pivot = false;
  let criterion: string | undefined;

  for (const c of RUBRIC_CRITERIA) {
    const score = verdict.scores[c] ?? 0;
    if (score < config.pivot.threshold) {
      streaks[c] = (streaks[c] ?? 0) + 1;
      if (streaks[c]! >= config.pivot.N) {
        pivot = true;
        criterion = c;
      }
    } else {
      streaks[c] = 0;
    }
  }

  return { pivot, criterion, streaks };
}
