# Interactive runner paths

## Standalone evaluation

For a WIP tree without the full engine:

```bash
sparra eval . --worktree --contract contract.md --backend codex \
  --holdout .sparra/HOLDOUT.md --out v.md \
  --expected-head <sha> --eval-base <ref> --json
```

This aliases `sparra role run --kind evaluator` and accepts the evaluator's `--contract`,
`--holdout`, `--backend`, `--model`, `--out`, and provenance flags. `--worktree` is required when
the evaluator exercises the artifact. Optional `--baseline-command <cmd>` requires `--eval-base`
and runs an allowlisted configured verification command at the base SHA; infrastructure failures
degrade to an unavailable note rather than laundering a generator claim.

`--json` emits one canonical payload on stdout while human logs go to stderr. It includes the
auto-persisted redacted `verdictPath`; evaluator JSON omits `traceDir` and `resultText`.

## Full-engine checkpoints

Run `sparra build --step=contract,round,commit,item`; at a pause, inspect
`.sparra/interactive/<run>/<item>/pause.md`, which is holdout-redacted, write the requested
`decision.json`, and rerun `sparra build`:

- `contract`: review/edit the proposed contract, then resume.
- `round`: choose exactly `continue`, `pivot`, `accept`, or `abandon`. A `continue` may edit
  `feedback.md`; accepting FAIL requires `reason`.
- `commit`: after pass, choose `commit` or `skip`; present only when `git.autoCommit` is enabled.
- `item`: choose `continue` for the next item or `stop` for a later build resume.

Never read holdout material to author feedback; resume rejects pasted holdout content.
