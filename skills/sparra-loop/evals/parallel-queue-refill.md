# Parallel queue and refill

## Scenario

Codex has five runnable independent units, exceeding the conservative current-host limit of three
background processes, and must queue and refill without unsafe writer overlap.

## Prompt

> Schedule five independent runnable units using current Codex capabilities. Show the initial
> launches, queued units, completion handling, and refills without assuming hidden capacity.

## Objective assertions

- At most `3` background CLI role processes run simultaneously; the other two units remain explicitly queued, not dropped.
- The initial batch launches three matrix-safe roles before waiting, and every completion immediately refills an open slot from the queue.
- Two generators run concurrently only with distinct `workspace` paths or distinct `unitWorktree` names.
- Evaluator and reviewer concurrency uses `worktree: true`; stages within one unit remain sequential.
- If delegated workers become available, capacity is queried from a stable host surface; otherwise the conservative process bound remains in force.
