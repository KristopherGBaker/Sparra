# Parallel scheduling

## Scenario

Schedule several independent units in one Claude conductor turn while preventing writer collisions
and preserving sequential stages within each unit.

## Prompt

> U-A is ready for evaluation in `wt-A`, U-B is ready for generation in its `ub` unit worktree,
> and U-C is ready for contract evaluation. Show the tracker, compute the runnable set, and launch
> all safe work now. Do not serialize independent units.

## Objective assertions

- Every conductor reply starts with a tracker table whose columns are exactly `Unit`, `Stage`,
  `Status`, and `Waiting on`.
- The parallel-safety matrix marks `contract-generator` and `contract-evaluator` safe concurrently
  across units.
- The matrix marks evaluator and reviewer calls with `worktree: true` safe concurrently across
  units because each uses its own throwaway WIP-snapshot worktree.
- The matrix permits concurrent generators only when they target distinct workspaces or distinct
  `unitWorktree` names; two generators never write one workspace concurrently.
- The matrix keeps `contract → generate → evaluate → decide` sequential within one unit.
- The scheduler follows the verbatim rule `Launch every runnable role-run in ONE message` and each
  launched role subagent uses `run_in_background: true`.
- For the prompt's board, one message launches U-A evaluator with `worktree: true`, U-B generator
  with `unitWorktree: "ub"`, and U-C `contract-evaluator` with `contractPath: <path>`.
- Conductor-local work occurs only after every runnable role has been launched.
- The under-scheduling tripwire is the verbatim rule `if two or more units are pending but you just
  launched only one subagent this turn, you under-scheduled`; the next action is to recompute the
  runnable set and launch the rest before ending the turn.
