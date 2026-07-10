---
name: sparra-loop
description: >-
  Run Sparra's adversarial build loop from an interactive agent host: set up per-role
  backends/models, decide who builds versus judges, and drive contract → generate →
  cross-model evaluate → decide with the holdout wall enforced by `run_role` or
  `sparra role run`. Use for one-off evaluation, a cross-model second opinion, or
  grading an artifact against a contract and optional holdout.
---

# sparra-loop — interactive conductor

You are the conductor; rigor and isolation live in Sparra's runner. Roles use the configured
Claude, Codex, or other backend regardless of which host conducts the loop.

## One safety rule

**Never read `HOLDOUT.md` or `.sparra/frozen/HOLDOUT.frozen.md`: pass only its path to the
evaluator, consume only the redacted verdict, never inspect evaluator traces, and never send
holdout text to a generator or another summary.**

Every evaluator verdict is also persisted, already redacted, under `.sparra/verdicts/`; use its
returned `verdictPath`, not raw role output.

## Choose the workflow

- For setup, a standalone evaluation, a one-off contract/generate/evaluate cycle, or a quick
  cross-model second opinion, use ad-hoc role runs. Read [interactive-build.md](references/interactive-build.md),
  [loop-core.md](references/loop-core.md), [role-result.md](references/role-result.md), and
  [recovery.md](references/recovery.md).
- For Sparra's full checkpointed multi-item engine—decomposition, dependencies, budgets, pivots,
  review, reconciliation, commits, and resume—run
  `sparra build --step=contract,round,commit,item`. Do not recreate that engine with ad-hoc role
  calls. Read [interactive-build.md](references/interactive-build.md).
- For multiple independent units, also read [scheduling.md](references/scheduling.md).

## Select the host adapter

Detect the current host's available delegation/background capabilities and load only its matching
adapter after the shared references above:

- Claude Code: read [claude-code.md](references/claude-code.md).
- Codex: read [codex.md](references/codex.md).
- A host with no adapter in this installation: use the runner directly or its JSON CLI surface,
  preserving the same safety rule and canonical envelope. Do not invent host-specific behavior.

## First-run setup

Ad-hoc `sparra eval`, `run_role`, and `sparra role run` work without initialization. Run
`sparra init` only when customization or the full engine is wanted and `.sparra/` is absent;
`sparra init --docs docs` keeps planning files under `docs`.

Configure the model split in `.sparra/config.yaml`, not in role prompts:

```yaml
roles:
  generator: { backend: claude, model: opus, effort: high }
  evaluator: { backend: codex, model: gpt-5.5, effort: high }
  reviewer:  { backend: codex, model: gpt-5.5 }
build:
  verifyCommands:
    - npm run typecheck
    - npm test
```

Verify Claude authentication and both the authenticated `codex` CLI and installed
`@openai/codex-sdk` before relying on this split. If Codex is unavailable, identify a Claude
evaluator fallback as same-family, not cross-model. Keep each verify command as a separate bare
entry; do not combine entries with chains, pipes, or environment prefixes.

An in-place generator whose contract names a configured gate needs `allowVerify: true` over MCP
or `--verify` on the CLI. A `unitWorktree` generator enables self-verification automatically.
If `verifyGateWarning` appears, enable verification before spending another role turn.
For contract critique, a Claude `contract-evaluator` on a worktree can run configured bare verify
commands through the strict allow-hook; an in-place critique cannot, and Codex relies on its sandbox.

Create optional hidden checks at `.sparra/HOLDOUT.md` without reading them back into conductor
context; later supply only `holdoutPath: ".sparra/HOLDOUT.md"` to the evaluator.
