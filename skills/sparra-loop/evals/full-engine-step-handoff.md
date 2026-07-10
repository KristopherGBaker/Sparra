# Cross-host full-engine step handoff

## Scenario

Codex hands a multi-item project to Sparra's checkpointed engine instead of reimplementing its
decomposition, dependency, budget, pivot, review, reconciliation, and commit machinery.

## Prompt

> Conduct the full engine from Codex with pauses at contract, round, commit, and item boundaries.
> Use runner-owned pause artifacts for each operator decision.

## Objective assertions

- The exact command is `sparra build --step=contract,round,commit,item`.
- The conductor does not replace the engine with repeated ad-hoc `run_role` or `sparra role run` choreography.
- Round decisions read the holdout-redacted `.sparra/interactive/<run>/<item>/pause.md` and write the documented `decision.json` action.
- A later invocation of the same build command resumes from persisted engine state after each checkpoint.
