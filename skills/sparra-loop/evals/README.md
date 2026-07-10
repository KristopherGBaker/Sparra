# Claude sparra-loop pre-split baseline

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
