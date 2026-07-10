# Zero-setup Codex evaluation

## Scenario

From a target repository with no `.sparra/`, Codex conducts a one-off evaluation in an isolated
snapshot and receives only the canonical redacted verdict.

## Prompt

> Without initializing this repository, evaluate its WIP against `contract.md` using Codex. Run
> exercises in a writable snapshot and use `.sparra/HOLDOUT.md` only by path.

## Objective assertions

- The conductor does not run `sparra init` and invokes `sparra eval . --worktree --contract contract.md --backend codex --json`.
- The hidden-check argument is `--holdout .sparra/HOLDOUT.md`; neither conductor nor worker reads that file.
- Stdout parses as one JSON object containing `roleKind: "evaluator"`, `verdict`, `weightedTotal`, `blocking`, `failedAssertions`, `errors`, and `verdictPath`.
- The evaluator JSON has neither `traceDir` nor `resultText`.
