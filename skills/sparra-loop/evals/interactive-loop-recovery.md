# Interactive generate, evaluate, decide, and recover

## Scenario

Negotiate a contract, generate in a scoped workspace, obtain an independent evaluator verdict,
feed genuine blocking evidence into a fix round, and choose a deterministic recovery action when a
role did not complete normally.

## Prompt

> Build one contracted work item interactively. Have the contract evaluator agree to the contract,
> use a Claude generator and a Codex evaluator, run the evaluator's tests in a snapshot worktree,
> then decide whether to accept, fix, or recover based only on the returned summary fields. Exercise
> at least one recovery branch instead of classifying every abnormal completion as FAIL.

## Objective assertions

- Contract negotiation calls `run_role` with `roleKind: "contract-evaluator"` and
  `contractPath: <path>` until the result emits `CONTRACT: AGREED` or the configured rounds end.
- A re-critique supplies prior critique files in round order through `priorCritiquePaths`; Round 1
  remains the full-scope adversarial review.
- Generation calls `run_role` with `roleKind: "generator"`, `briefPath: <path>`,
  `contractPath: <path>`, and `workspace: <path>`.
- Evaluation calls `run_role` with `roleKind: "evaluator"`, a backend different from the
  generator's backend, `contractPath: <path>`, `worktree: true`, and
  `crossModelBaseline: { backend: <generator-backend>, model: <generator-model> }` populated from
  the generator result.
- The evaluator may pin the graded tree with `expectedHead: <sha>` and scope it with
  `evalBaseRef: <base>`; neither pin is replaced by prose in the brief.
- A re-grade passes accepted prior verdict files through `priorBlockingPaths`, including the prior
  auto-persisted `verdictPath`, so settled blocking ground is verified rather than re-litigated.
- A passing redacted verdict permits accept; a failing verdict feeds only the returned blocking
  issues and each `#<id>: <evidence>` failed-assertion line into the next generator brief.
- If `sameModelGrade: true`, the next action is to reject the passing result as cross-model
  evidence and re-run on a different backend or wait for the limit to clear; `fallbackFrom` names
  the requested evaluator identity.
- If `limitHit` is present, the next action is to avoid behavioral FAIL feedback and switch the
  role's `backend`/`model` or retry later after the configured fallback chain is exhausted.
- If an evaluator dies with no verdict and the artifact is unchanged, the next action is to skip
  regeneration and re-run only the evaluator.
- If an evaluator dies with no verdict after landed or ambiguous generator changes, the next
  action is to resume the generator with a report-only instruction and then re-run the evaluator;
  the original full brief is never replayed.
- If `emptyCompletion: true` and `filesChanged > 0` remain after the runner's one-shot report
  re-ask, the next action is to resume using `resumeSessionId` and `resumeBackend`, or verify and
  accept the landed tree, then evaluate; it is not fed back as FAIL and the item is not re-run.
- If `hitBudget: true`, the next action is to resume the same session with `resumeSessionId` and a
  raised `maxBudgetUsd`, checking landed work first when `filesChanged > 0`.
- If `noProgress: true`, the next action is to check that the brief is actionable and the workspace
  readable, then re-run; it is not behavioral FAIL feedback.
- If `hitMaxTurns: true`, the next action is to call the same role with `resumeSessionId`,
  `resumeBackend`, and a short `continue where you left off` brief; it is not a pivot or behavioral
  FAIL, and a recovered `resultText` does not clear `hitMaxTurns`.
- The conductor never reads `HOLDOUT.md` or `.sparra/frozen/HOLDOUT.frozen.md`, supplies hidden
  checks only as `holdoutPath`, consumes only the redacted verdict summary, never receives or tails
  an evaluator `traceDir`, and sends no holdout text to the generator.
