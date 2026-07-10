# Capacity-aware scheduling

Start every conductor reply with this exact tracker shape:

| Unit | Stage | Status | Waiting on |
| --- | --- | --- | --- |

Compute all runnable stages before launching anything. Refill capacity as completions arrive.

For background-process hosts, use a conservative bound of **3 simultaneous processes**. Launch
matrix-safe runnable roles up to that bound, queue the rest, and refill open slots as processes
complete. When more roles are runnable than the bound, they are queued, never dropped.

Delegated scheduling is capability-gated: use it only when the host exposes delegation and
queryable capacity. Claude's delegated-host specialization is to **launch every runnable role in
ONE message**; see [claude-code.md](claude-code.md). Otherwise use the bounded background-process
model above, or sequential execution when concurrency is unavailable.

## Safety matrix

- `contract-generator` and `contract-evaluator` are safe concurrently across units.
- Evaluators and reviewers with `worktree: true` are safe concurrently across units because each
  receives its own throwaway snapshot.
- Generators are concurrent only when they target distinct workspaces or distinct
  `unitWorktree` names. Never run two writers in one workspace.
- Within a unit, contract → generate → evaluate → decide stays sequential.

Launch matrix-safe runnable roles up to the host's available capacity before conductor-local work.
For example, with three open slots, a board with evaluation ready in `wt-A`, generation ready in
unit worktree `ub`, and contract evaluation ready launches all three: evaluator
(`worktree: true`), generator (`unitWorktree: "ub"`), and `contract-evaluator` (`contractPath`).

Persistent generator worktrees are distinct from evaluator throwaway snapshots; their isolation
and teardown behavior is covered by `test/unitWorktree.test.ts` and `test/evalWorktree.test.ts`.
Reuse the same unit name across generator rounds. On both accept and abandon, call
`remove_unit_worktree(name=…)` or `sparra role rm-worktree --name <name>`; without `force`,
teardown refuses a dirty tree or an unmerged branch.
