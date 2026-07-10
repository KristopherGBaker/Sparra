# Recovery and resume

Classify from the canonical summary before changing the artifact:

- `limitHit`: provider unavailable/limited. Do not send behavioral FAIL feedback; use the fallback
  chain, change backend/model, or retry later.
- Evaluator stopped with no verdict and artifact unchanged: skip regeneration and rerun only the
  evaluator.
- Evaluator stopped with no verdict after landed or ambiguous generator changes: resume the
  generator with a report-only instruction, then evaluate. Never replay the original full brief.
- `emptyCompletion: true` with `filesChanged > 0`: work landed but its report did not. Resume the
  same session or verify and accept the tree, then evaluate; never rerun the item from scratch.
- `hitBudget: true`: resume the same session with a raised `maxBudgetUsd`, first checking landed
  work when `filesChanged > 0`.
- `noProgress: true`: check that the brief is actionable and workspace readable, then rerun; this
  is not behavioral FAIL feedback.
- `hitMaxTurns: true`: resume the same role/session with a short “continue where you left off”
  brief. Do not pivot. A recovered report does not clear `hitMaxTurns`.
- `sameModelGrade: true`: reject the grade as cross-model evidence and choose a distinct grader.
- `verifyGateWarning`: enable the named configured gates with `allowVerify`/`--verify` before
  trusting verification claims.

The runner may make one tightly capped report-only re-ask after a writer's budget or turn-cap
completion failure. A recovered report appears in `resultText` while `errors` records recovery;
`hitMaxTurns` remains true. If recovery cannot produce a report, landed work is still preserved.

For MCP resume, pass `resumeSessionId` and `resumeBackend` from the prior result. For CLI resume,
pass `--resume-session <id>` and `--resume-backend <backend>`. Session IDs are backend-specific.
