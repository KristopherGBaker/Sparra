# Per-unit worktree teardown

## Scenario

Remove a persistent generator worktree after its unit is either accepted or abandoned, without
silently discarding dirty or unmerged work.

## Prompt

> Unit `ua` used `unitWorktree: "ua"` across generator rounds. Tear it down after acceptance. Also
> state the teardown action if the user abandons the unit, and preserve the runner's WIP safety.

## Objective assertions

- Generator rounds use the same `unitWorktree: "ua"`, and the returned `unitWorktree` payload field
  identifies its `name`, `dir`, and `branch`.
- On accept, teardown calls `remove_unit_worktree(name="ua")` or
  `sparra role rm-worktree --name ua`.
- On abandon, teardown calls `remove_unit_worktree(name="ua")` or
  `sparra role rm-worktree --name ua`.
- Teardown does not substitute the evaluator's temporary `worktree: true` snapshot for the
  generator's persistent named `unitWorktree`.
- Without `force`, teardown refuses a dirty worktree or an unmerged unit branch rather than
  deleting WIP.
