# Holdout wall

## Scenario

Both host paths evaluate hidden checks while keeping their contents outside conductor, generator,
shared summaries, and evaluator trace access.

## Prompt

> Evaluate with `.sparra/HOLDOUT.md`, then run a fix round using only safe verdict evidence. Prove
> what paths and fields cross each role boundary.

## Objective assertions

- The conductor passes only `holdoutPath: ".sparra/HOLDOUT.md"` or `--holdout .sparra/HOLDOUT.md` and never reads either holdout location.
- Generator, contract, reviewer, and conductor prompts contain no holdout contents; only the evaluator receives the path through the runner.
- Evaluator payloads omit `traceDir` and `resultText`; the conductor consumes only the redacted `verdictPath`, `blocking`, and `failedAssertions`.
- Fix feedback contains concrete redacted blocking evidence and no holdout text, raw evaluator output, or evaluator trace excerpt.
