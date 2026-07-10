# Contract → generate → evaluate → decide

## Contract

Draft checkable assertions, including existing-project no-regression, conventions, and docs-sync
clauses. Run `contract-evaluator` with `contractPath` until it emits `CONTRACT: AGREED` or the
configured rounds end. Round 1 is full-scope. On later rounds pass prior critique files in order
through `priorCritiquePaths`; the trusted runner may read `.sparra/` paths. Use
`contract-generator` when a model should draft the contract.

The runner labels later context with its `RE-CRITIQUE` delta instruction: grade only the change,
preserve resolved positions unless new evidence is named, and keep style nits non-blocking. On an
older runner without `priorCritiquePaths`, inline the prior critique text plus that delta
instruction in the brief; do not ask a forbid role to read a `.sparra/` path itself.

## Generate

Call `run_role` with `roleKind: "generator"`, `briefPath`, `contractPath`, and `workspace`.
Writers are scoped to that workspace. Use a stable `unitWorktree` name when the unit needs an
isolated persistent worktree across rounds; the result identifies its name, directory, branch,
and whether it was created.

## Evaluate

Call `run_role` with `roleKind: "evaluator"`, `contractPath`, the optional `holdoutPath`, and a
backend different from the generator. Whenever tests/builds run, pass `worktree: true` for a
writable throwaway WIP snapshot with provisioned dependencies.

Always pass `crossModelBaseline: { backend, model }` from the generator result. If the actual
fallback grader matches it, `sameModelGrade: true` means the independence gate collapsed;
`fallbackFrom` names the requested grader. A passing same-model grade is not cross-model evidence.

Use `expectedHead` to pin the source HEAD before tokens are spent and `evalBaseRef` to scope
changed-file judgments to `<base>..HEAD` plus WIP. These controls are not replaced by prose. On a
re-grade, pass accepted prior redacted verdict files, including `verdictPath`, in
`priorBlockingPaths` so settled blocking ground is verified rather than re-litigated.

## Decide

- PASS with an independent grade: accept; optionally review with `roleKind: "reviewer"`.
- FAIL: give the generator only concise blocking issues and each failed assertion's
  `#<id>: <evidence>` line. Pivot after repeated failure on the same point.
- `sameModelGrade: true`: change evaluator backend/model or wait, then obtain an independent grade.
- An abnormal completion is not automatically FAIL; follow [recovery.md](recovery.md).

After a run, `sparra reflect` discovers new non-evaluator-safe role traces and redacted evaluator
evidence. Use `--traces` to select explicitly and `--apply` only after reviewing. Project-local
findings improve this project's contract/brief/prompts; material harness findings route to the
upstream inbox for later `sparra reflect --upstream` triage.
