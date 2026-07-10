# Capacity-aware scheduling

Start every conductor reply with this exact tracker shape:

| Unit | Stage | Status | Waiting on |
| --- | --- | --- | --- |

Compute all runnable stages before launching anything. Refill capacity as completions arrive.

## Safety matrix

- `contract-generator` and `contract-evaluator` are safe concurrently across units.
- Evaluators and reviewers with `worktree: true` are safe concurrently across units because each
  receives its own throwaway snapshot.
- Generators are concurrent only when they target distinct workspaces or distinct
  `unitWorktree` names. Never run two writers in one workspace.
- Within a unit, contract → generate → evaluate → decide stays sequential.

Launch every matrix-safe runnable role before conductor-local work. A board with evaluation ready
in `wt-A`, generation ready in unit worktree `ub`, and contract evaluation ready launches all
three: evaluator (`worktree: true`), generator (`unitWorktree: "ub"`), and
`contract-evaluator` (`contractPath`).

Persistent generator worktrees are distinct from evaluator throwaway snapshots. Reuse the same
unit name across generator rounds. On accept or abandon, call `remove_unit_worktree(name=…)` or
`sparra role rm-worktree --name <name>`; without `force`, teardown refuses dirty work or an
unmerged branch.
