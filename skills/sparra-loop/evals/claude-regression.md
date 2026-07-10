# Claude adapter regression

## Scenario

After the shared-core and Codex split, Claude Code repeats representative one-off evaluation,
parallel scheduling, recovery, and teardown behavior through its dedicated adapter.

## Prompt

> From Claude Code, run representative skill paths after the host split: one evaluator, three
> independent runnable roles, one turn-cap recovery, and one accepted unit teardown.

## Objective assertions

- Every role call runs in the shipped `sparra-role` Task worker and each runnable Task uses `run_in_background: true`.
- Three matrix-safe independent roles launch in one message before conductor-local work.
- The evaluator uses `worktree: true`, returns no `traceDir`, and exposes only the canonical redacted verdict fields.
- `hitMaxTurns: true` resumes using the returned `sessionId` and `backend`; it is not behavioral FAIL feedback.
- Accept teardown calls `remove_unit_worktree(name=<name>)` or `sparra role rm-worktree --name <name>` and preserves dirty/unmerged WIP unless forced.
