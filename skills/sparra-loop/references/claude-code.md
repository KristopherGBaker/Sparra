# Claude Code adapter

Run every role call in the shipped `sparra-role` Task worker so long outputs remain outside the
conductor. The worker calls inherited `mcp__sparra-run__run_role`; if MCP is unavailable, it uses
`sparra role run … --json` or `sparra eval … --json`. The configured role backend does not move
onto Claude merely because Claude conducts it.

For each scheduler turn, **launch every runnable role in ONE message**. More explicitly:
**Launch every runnable role-run in ONE message**, with every Task using
`run_in_background: true`; only then do conductor-local work. This preserves responsiveness and
parallelism. Foreground is reserved for a genuinely quick call that must block immediately.

**Under-scheduling tripwire:** **if two or more units are pending but you just launched only one
subagent this turn, you under-scheduled**. Recompute the runnable set and launch the rest before
ending the turn.

Example: one message launches U-A's evaluator (`worktree: true`), U-B's generator
(`unitWorktree: "ub"`), and U-C's contract evaluator (`contractPath`); local synthesis follows.

Give the worker the exact runner arguments, including backend/model/effort, workspace, contract,
holdout path, worktree controls, provenance, budget, resume values, and cross-model baseline. It
returns every canonical decision field plus an optional concise `resultDigest`, never raw role
output. Do not tail evaluator traces. For non-evaluator progress, a small filtered pulse from the
returned holdout-free `traceDir` is allowed; never dump the transcript.

The MCP server is persistent and may retain pre-edit Sparra code. When modifying the runner itself,
exercise current code through the fresh-process CLI path unless the server has restarted.
