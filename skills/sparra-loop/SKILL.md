---
name: sparra-loop
description: >-
  Run Sparra's adversarial build loop INSIDE an interactive Claude Code session:
  drive a contract → generate → cross-model adversarial evaluate (e.g. a Codex
  evaluator grading Claude's work) → pivot/accept loop using the `run_role` MCP
  tool (or `sparra role run`), with the holdout wall enforced by the runner. Use
  when the user wants Sparra-style rigor on tap, a cross-model second opinion on
  generated work, or to grade an artifact against a contract/holdout.
---

# sparra-loop — Sparra's loop, interactively

You are the **conductor**. You drive the loop; the **rigor lives in the runner**
(`run_role`), not in this playbook. Roles run on a chosen backend (claude/codex/…)
through Sparra's existing seam, so you can pit models against each other.

## The one rule that matters: the holdout wall
- **Never read `HOLDOUT.md`** (or `.sparra/frozen/HOLDOUT.frozen.md`). Pass it to the
  evaluator **by path** (`holdoutPath`). The runner is the only thing that reads it,
  and only for the evaluator. If you read it, you contaminate the generator through
  shared context.
- Read **verdicts**, never the evaluator's raw output. The MCP tool returns only the
  verdict for the evaluator role.

## The loop
1. **Contract.** Write/refine the "done" contract with the user (a short list of
   checkable assertions). Optionally negotiate it: `run_role(contract-generator)` then
   `run_role(contract-evaluator)`. Save it to a file (e.g. `.sparra/contract.md`).
2. **Generate.** `run_role(roleKind="generator", briefPath=…, contractPath=…,
   workspace=…)`. Writes are scoped to the workspace.
3. **Adversarially evaluate — cross-model.** `run_role(roleKind="evaluator",
   backend="codex", contractPath=…, holdoutPath=".sparra/HOLDOUT.md", workspace=…,
   out=".sparra/verdicts/r1.md")`. The evaluator exercises the artifact for real and
   grades it against the contract + holdout. Using a *different* backend than the
   generator is the point — an independent second opinion.
4. **Decide.** Read the verdict. If it passes, accept (commit if the user wants). If it
   fails, feed the blocking issues back into the generator brief and repeat. Pivot to a
   fresh approach after repeated failures on the same point.
5. **Review (optional).** `run_role(roleKind="reviewer")` for a code-review gate.

## How to invoke a role
- **Preferred (interactive): the MCP tool** `run_role` from the `sparra-run` server
  (holdout enforced server-side; never returns holdout). Args: `roleKind`, `brief`|
  `briefPath`, `contractPath`, `workspace`, `holdoutPath`, `backend`, `model`, `out`.
- **CLI fallback (scriptable):** `sparra role run --kind evaluator --backend codex
  --brief brief.md --contract contract.md --holdout .sparra/HOLDOUT.md --out v.md`.

## Backends
Per-role defaults come from `.sparra/config.yaml` (`roles.*`). Override per call with
`backend`/`model`. Codex needs the `codex` CLI authed (`~/.codex`) + `@openai/codex-sdk`.
The killer move is **cross-model**: Claude generates, Codex evaluates (or vice versa).

## Don't
- Don't reimplement grading yourself in this session — call the evaluator role (it has
  the rubric + holdout + the exerciser).
- Don't paste holdout/contract acceptance secrets into a generator brief — the runner
  will reject a leak, but don't rely on it; keep them in files referenced by path.
