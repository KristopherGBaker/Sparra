# Full-engine handoff

## Scenario

Use Sparra's checkpointed autonomous engine for a real multi-item build instead of manually
recreating decomposition, dependencies, budgets, pivots, review, reconciliation, commits, and
resume behavior in the conductor.

## Prompt

> Run the full multi-item Sparra build with human steering at contract, round, commit, and item
> boundaries. Show the exact checkpoint command and the files or decisions used at every pause.

## Objective assertions

- The conductor invokes `sparra build --step=contract,round,commit,item` rather than manually
  choreographing the full multi-item loop with repeated `run_role` calls.
- At `--step=contract`, the operator reviews or edits the proposed contract file and re-runs
  `sparra build` to resume.
- At `--step=round`, the operator reads
  `.sparra/interactive/<run>/<item>/pause.md`, which is a holdout-redacted verdict summary, and
  writes `decision.json` with exactly one of `continue`, `pivot`, `accept`, or `abandon`.
- A `continue` round may edit `feedback.md`; an `accept` override of FAIL includes a `reason` in
  `decision.json`.
- At `--step=commit`, the already-passed item chooses `commit` or `skip` in `decision.json`; this
  checkpoint is active only when `git.autoCommit` is on.
- At `--step=item`, `decision.json` chooses `continue` for the next item or `stop` to end this run
  and permit a later `sparra build` resume.
- The operator never reads a holdout file to write `feedback.md`; pasting holdout content into
  `feedback.md` is rejected on resume.
