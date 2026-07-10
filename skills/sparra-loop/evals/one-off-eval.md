# One-off evaluation

## Scenario

Grade an existing work-in-progress tree without initializing or running the full build loop, while
preserving the evaluator's writable exercise environment and the holdout wall.

## Prompt

> Evaluate the current WIP against `contract.md` with a Codex judge. Run the repository's tests in
> an isolated snapshot, include the hidden checks by path, pin the expected source HEAD, scope the
> grade to this unit's base ref, and save a caller-selected verdict copy as `v.md`.

## Objective assertions

- The standalone command is `sparra eval [dir] --worktree --contract contract.md --backend codex
  --holdout .sparra/HOLDOUT.md --out v.md --expected-head <sha> --eval-base <ref>`.
- The documented alias is `sparra role run --kind evaluator` and accepts the evaluator role's
  `--contract`, `--holdout`, `--backend`, and `--out` arguments.
- `--worktree` is present when the evaluator runs tests or builds, so the WIP snapshot has writable
  exercise scratch and provisioned dependencies.
- `--expected-head <sha>` pins the source checkout HEAD before model tokens are spent, and
  `--eval-base <ref>` scopes changed-file SCOPE/DEVIATION judgment to `<ref>..HEAD` plus WIP.
- The evaluator invocation represented through `run_role` uses `roleKind: "evaluator"`,
  `backend: "codex"`, `worktree: true`, `holdoutPath: ".sparra/HOLDOUT.md"`, and
  `crossModelBaseline: { backend: <generator-backend>, model: <generator-model> }`.
- The conductor never reads `HOLDOUT.md` or `.sparra/frozen/HOLDOUT.frozen.md`; it passes only the
  path in `holdoutPath`.
- The conductor consumes the holdout-redacted evaluator verdict and `verdictPath`, never the raw
  evaluator output.
- The redacted verdict is auto-persisted at
  `.sparra/verdicts/role-run-evaluator-<stamp>.verdict.md` even when no `out` argument is supplied.
- An evaluator payload never returns `traceDir`, and the conductor never tails evaluator traces.
- No holdout text is copied into conductor context, a generator brief, evaluator feedback, or any
  subagent summary.
