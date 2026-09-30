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
  /**
   * Optional repo-relative paths most relevant to this item. The decomposer may name them so the
   * generator and contract-generator prefer the CODEBASE_MAP section(s) covering these seams (plus a
   * short listing of the files) over a blind head-slice of the map — see `selectMapContext`. Omitted
   * when the decomposer is unsure; absent → the head-slice, byte-for-byte today's behavior. Paths
   * only — file bodies are never injected. The human can override in items.json before building.
   */
  relevantPaths?: string[];
}

export type ExerciseStatus = "ran" | "blocked" | "mixed";

/** A verdict assertion id: plain integers, or labels like `"6b"` / `"H4"`. Normalize with
 *  `normalizeAssertionId` and compare by `assertionKey` (both in `assertionId.ts`). */
export type AssertionId = number | string;

export interface Verdict {
  assertions: { id: AssertionId; pass: boolean; evidence: string }[];
  /** Assertion ids the evaluator could not execute for an environment/tooling reason. These are
   *  no-signal, distinct from failed assertions, and excluded from assertion-anchored caps. */
  unrunAssertionIds?: AssertionId[];
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
  claimMismatches?: { count: number; ids: AssertionId[] };
  /** Holdout assertions the evaluator flagged CONTRACT-CONTRADICTED — each demands behavior the
   *  agreed contract explicitly forbids, or forbids behavior it explicitly mandates, citing the
   *  clause. A flag is NOT an artifact pass or fail: a VALID one (evaluate.ts validates the cited
   *  clause resolves + is distinctive) RETIRES that holdout from the round's grading and is
   *  persisted holdout-redacted, keyed by a stable `holdoutId`, so later rounds treat it as settled
   *  (mirrors ACCEPTED-BLOCKING). Conductor/generator-visible copies are holdout-redacted. */
  holdoutContradictions?: HoldoutContradiction[];
  /** Opt-in Jev annotation (`evaluator.envBlockJudge`): which FAILED assertions likely could not
   *  execute in the grader's environment. Informational — it never changes `verdict`, `pass`, scores
   *  or `unrunAssertionIds`; only `auto`-band ids freeze pivot streaks. Absent unless the judge ran. */
  envBlock?: EnvBlockAnnotation;
}

/** Why an env-block classification was incomplete (precedence: timeout > request-failed > invalid-response). */
export type EnvBlockError = "timeout" | "request-failed" | "invalid-response";

/** One flagged assertion: `auto` = confident it was environment-blocked; `suspect` = worth a look. */
export interface EnvBlockFlag {
  id: AssertionId;
  noul: number;
  choice: string;
  confidence: number;
  band: "auto" | "suspect";
}

export interface EnvBlockAnnotation {
  model: string;
  /** Flagged (auto or suspect) assertions only. */
  assertions: EnvBlockFlag[];
  error?: EnvBlockError;
}

/** An evaluator-flagged direct contradiction between a HOLDOUT check and the agreed contract.
 *  `holdout` is the holdout assertion text (holdout-redacted before it reaches conductor/generator);
 *  `contractClause` quotes the contradicted contract clause verbatim; `reason` explains the
 *  contradiction. Shape is stable across the build-loop and interactive paths. */
export interface HoldoutContradiction {
  holdout: string;
  contractClause: string;
  reason: string;
}

/** A durable, holdout-SAFE retirement record persisted in the verdict channel and threaded into
 *  later rounds. Keyed by `holdoutId` (a content hash of the normalized holdout text — reveals no
 *  holdout text, stable across rounds, distinguishes multiple holdouts after redaction). */
export interface RetiredHoldout {
  holdoutId: string;
  contractClause: string;
  reason: string;
}

export const RUBRIC_CRITERIA = ["design", "originality", "craft", "functionality"] as const;
export type Criterion = (typeof RUBRIC_CRITERIA)[number];
