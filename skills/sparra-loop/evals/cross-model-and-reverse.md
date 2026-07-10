# Cross-model loop and reverse split

## Scenario

Codex conducts one Claude-generator/Codex-evaluator fail/fix/re-grade cycle, then demonstrates the
reverse Codex-generator/Claude-evaluator split.

## Prompt

> Run a cross-model loop through one failing verdict, a targeted fix, and a re-grade. Then repeat
> the role identity setup in reverse, always using actual returned backend and model identities.

## Objective assertions

- The first generator uses `backend: "claude"`; its evaluator uses `backend: "codex"`, `worktree: true`, and `crossModelBaseline` equal to the generator result's `backend` and `model`.
- Only returned `blocking` and `failedAssertions` evidence enters the fix brief; holdout text and evaluator traces do not.
- The re-grade supplies the prior `verdictPath` through `priorBlockingPaths` and accepts only a passing independent verdict.
- The reverse run uses a Codex generator and Claude evaluator, with `crossModelBaseline` populated from that Codex generator's actual result.
