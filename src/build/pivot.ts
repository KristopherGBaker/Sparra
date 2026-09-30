import type { SparraConfig } from "../config.ts";
import type { ItemState } from "../state.ts";
import { assertionKey, assertionKeySet } from "./assertionId.ts";
import { autoEnvBlockedKeys } from "./envBlockJudge.ts";
import { RUBRIC_CRITERIA, type AssertionId, type Verdict } from "./types.ts";

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
  const unrun = assertionKeySet(verdict.unrunAssertionIds);
  const allAssertionsUnrun = verdict.assertions.length > 0 && verdict.assertions.every((a) => unrun.has(assertionKey(a.id)));
  if (allAssertionsUnrun) {
    return { pivot: false, criterion: undefined, streaks: { ...item.criterionFailStreak } };
  }
  // Every failed runnable assertion is one Jev judged environment-blocked (`envBlock`, auto band):
  // the round carries no artifact signal, so — exactly like a blocked exercise — freeze the streaks.
  const envBlocked = autoEnvBlockedKeys(verdict);
  const failedRunnable = verdict.assertions.filter((a) => !a.pass && !unrun.has(assertionKey(a.id)));
  if (failedRunnable.length > 0 && failedRunnable.every((a) => envBlocked.has(assertionKey(a.id)))) {
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

/**
 * Per-ASSERTION fail streaks — the finer-grained companion to the per-criterion GAN streaks,
 * feeding the escalation register (`build.assertionEscalateAfter`) in the patch branch.
 *
 * Mirrors `updateStreaksAndDecide`'s guards: a BLOCKED exercise or an ALL-un-run verdict is
 * inconclusive (environment, not the artifact) and advances NO streak. Otherwise each FAILED, RUN
 * (non-un-run) assertion's streak increments; every OTHER previously-tracked id that carries a live
 * signal this round (passed, or simply not failing/absent) resets to 0 — exactly as
 * `updateStreaksAndDecide` zeroes a criterion whose score is at/above threshold, so a fixed
 * assertion can't keep a stale streak and spuriously escalate. Un-run ids carry no signal and are
 * left untouched. An id Jev judged environment-blocked (`envBlock`, auto band) is treated exactly
 * like an un-run id. Returns a fresh map (never mutates `item`).
 */
export function updateAssertionStreaks(item: ItemState, verdict: Verdict): Record<string, number> {
  const streaks = { ...(item.assertionFailStreak ?? {}) };
  if (verdict.exerciseStatus === "blocked") return streaks;
  const unrun = assertionKeySet(verdict.unrunAssertionIds);
  for (const key of autoEnvBlockedKeys(verdict)) unrun.add(key);
  const allAssertionsUnrun = verdict.assertions.length > 0 && verdict.assertions.every((a) => unrun.has(assertionKey(a.id)));
  if (allAssertionsUnrun) return streaks;
  // Keys of the ids that FAILED with a live signal this round (un-run ids are no-signal, excluded).
  const failing = new Set(verdict.assertions.filter((a) => !a.pass && !unrun.has(assertionKey(a.id))).map((a) => assertionKey(a.id)));
  // Reset every previously-tracked id that is NOT failing this round and still carries a signal
  // (i.e. it is not un-run now) — a fixed/absent assertion drops back to 0.
  for (const key of Object.keys(streaks)) {
    if (unrun.has(key)) continue; // no signal — leave this id's streak as-is
    if (!failing.has(key)) streaks[key] = 0;
  }
  // Advance the failing ids.
  for (const key of failing) streaks[key] = (streaks[key] ?? 0) + 1;
  return streaks;
}

/** Failed assertion ids whose streak has reached the escalation threshold (`>= after`, `after > 0`).
 *  Un-run ids and Jev-judged environment-blocked (auto band) ids never qualify. Empty when escalation
 *  is disabled (`after <= 0`) or nothing is at streak. */
export function assertionsToEscalate(streaks: Record<string, number>, verdict: Verdict, after: number): AssertionId[] {
  if (after <= 0) return [];
  const unrun = assertionKeySet(verdict.unrunAssertionIds);
  for (const key of autoEnvBlockedKeys(verdict)) unrun.add(key);
  return verdict.assertions
    .filter((a) => !a.pass && !unrun.has(assertionKey(a.id)) && (streaks[assertionKey(a.id)] ?? 0) >= after)
    .map((a) => a.id);
}
