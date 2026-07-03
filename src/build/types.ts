export interface WorkItem {
  id: string;
  title: string;
  summary: string;
  dependsOn: string[];
  rationale: string;
  /**
   * Optional generator routing. "local" runs this item on `roles.generatorLocal`
   * (e.g. a local LM Studio model) instead of `roles.generator` — for trivially-simple
   * or privacy-sensitive items. Omitted/"default" → the main generator. The decomposer
   * may tag items (when a local generator is configured); the human can override in
   * items.json before building.
   */
  gen?: "local" | "default";
}

export type ExerciseStatus = "ran" | "blocked" | "mixed";

export interface Verdict {
  assertions: { id: number; pass: boolean; evidence: string }[];
  /** Assertion ids the evaluator could not execute for an environment/tooling reason. These are
   *  no-signal, distinct from failed assertions, and excluded from assertion-anchored caps. */
  unrunAssertionIds?: number[];
  scores: { design: number; originality: number; craft: number; functionality: number };
  weightedTotal: number;
  verdict: "pass" | "fail";
  /** Did the EXERCISE actually run? "ran" (default/absent) = real observed commands; "mixed" =
   *  some commands ran while some were environment-blocked; "blocked" = no command ran because of
   *  ENVIRONMENT (sandbox/EPERM/missing tool/simulator), NOT the artifact — inconclusive. */
  exerciseStatus?: ExerciseStatus;
  blocking: string[];
  notes: string;
  /** Set by the build loop when the generator's `assertionsClaimed` contradicted this verdict
   *  (build/claims.ts) — the round's calibration gap (assertion ids + count only). */
  claimMismatches?: { count: number; ids: number[] };
}

export const RUBRIC_CRITERIA = ["design", "originality", "craft", "functionality"] as const;
export type Criterion = (typeof RUBRIC_CRITERIA)[number];
