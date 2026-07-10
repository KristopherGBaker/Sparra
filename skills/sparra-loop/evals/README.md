# sparra-loop dogfood specifications

This directory is the pre-split baseline of the Claude `sparra-loop` behavior documented by
`skills/sparra-loop/SKILL.md` at git commit
`39ce34410a5ef35c39872ec9b65e2bf77c33c255`.

Each scenario preserves one documented operator path as a prompt plus objective assertions:

| Documented behavior | Baseline scenario |
| --- | --- |
| Setup, backend/model split, verify gates, and holdout setup | [`setup-model-split.md`](setup-model-split.md) |
| Standalone evaluation and its evaluator-role alias | [`one-off-eval.md`](one-off-eval.md) |
| Contract → generate → evaluate → decide, including recovery | [`interactive-loop-recovery.md`](interactive-loop-recovery.md) |
| Tracker-driven parallel scheduling | [`parallel-scheduling.md`](parallel-scheduling.md) |
| Per-unit worktree teardown on accept or abandon | [`teardown.md`](teardown.md) |
| Handoff to the checkpointed full build engine | [`full-engine-handoff.md`](full-engine-handoff.md) |

A later refactor compares each file with the corresponding behavior in the refactored skill. An
assertion passes if and only if the refactored skill still documents and enables the command,
argument, payload field, file boundary, or verbatim decision rule named by that assertion.

These files add no user-facing config knob, phase, role, backend capability, or CLI flag. The
repository on-ramp, detailed docs, operational skill, and marketplace version therefore require no
docs-sync change in this phase.

## Cross-host dogfood

The files above are the Phase 0 Claude baseline. The following are the cross-host specifications
added in Phase 5; they test the shared contract and host adapters without replacing that baseline.

| Cross-host behavior | Scenario |
| --- | --- |
| Config-less evaluation conducted from Codex | [`zero-setup-codex-eval.md`](zero-setup-codex-eval.md) |
| Claude→Codex fail/fix/re-grade and reverse Codex→Claude split | [`cross-model-and-reverse.md`](cross-model-and-reverse.md) |
| Refusal when evaluator independence collapses | [`collapsed-independence.md`](collapsed-independence.md) |
| All canonical recovery-envelope branches | [`recovery-envelope.md`](recovery-envelope.md) |
| Conservative Codex process queue and refill | [`parallel-queue-refill.md`](parallel-queue-refill.md) |
| Runner-enforced holdout wall | [`holdout-wall.md`](holdout-wall.md) |
| Codex handoff to the full stepped engine | [`full-engine-step-handoff.md`](full-engine-step-handoff.md) |
| Representative Claude adapter regression | [`claude-regression.md`](claude-regression.md) |
