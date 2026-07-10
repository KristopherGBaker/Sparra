# Canonical role-result envelope

MCP `run_role` and CLI `--json` return the same runner-owned, holdout-safe envelope:

```yaml
roleKind: generator | evaluator | reviewer | contract-generator | contract-evaluator
backend: string
model: string
sessionId: string?
ok: boolean
verdict: pass | fail | null
weightedTotal: number?
passThreshold: number?
blocking: string[]?
failedAssertions: object[]?
resultText: string?
resultDigest: string?
verdictPath: string?
outPath: string?
traceDir: string?
filesChanged: number?
sameModelGrade: boolean?
fallbackFrom: object?
limitHit: object?
hitBudget: boolean?
hitMaxTurns: boolean?
emptyCompletion: boolean?
noProgress: boolean?
verifyGateWarning: string?
unitWorktree: object?
promptDrift: object?
errors: string[]?
tokens: number?
costUsd: number?
```

`resultDigest` is the only optional worker synthesis and may index, never replace, control data.
Recovered generator reports retain both `resultText` and the recovery note in `errors`.

The evaluator payload contains normalized verdict fields and `verdictPath`, but omits
`resultText` and `traceDir`; its raw output and trace can contain holdout evidence. Other roles
may return holdout-free `resultText` and `traceDir`. No worker returns a raw transcript, diff,
full verdict dump, evaluator trace, or holdout text.

Use `backend`/`model` as the actual identity, `sessionId` for resume, totals and blocking fields
for decisions, paths for runner-owned artifacts only, `filesChanged` to detect landed writer work,
recovery flags according to [recovery.md](recovery.md), `promptDrift` as an informational prompt
sync notice, and `tokens`/`costUsd` for budget decisions.
