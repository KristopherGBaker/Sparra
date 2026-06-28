---
name: sparra-loop
description: >-
  Run Sparra's adversarial build loop INSIDE an interactive Claude Code session:
  set up the project (`sparra init` + per-role backend/model config), then drive a
  contract → generate → cross-model adversarial evaluate (e.g. a Codex evaluator
  grading Claude's work) → pivot/accept loop using the `run_role` MCP tool (or
  `sparra role run`), with the holdout wall enforced by the runner. Use when the
  user wants Sparra-style rigor on tap, to configure which model builds vs judges,
  a cross-model second opinion on generated work, or to grade an artifact against a
  contract/holdout.
---

# sparra-loop — Sparra's loop, interactively

You are the **conductor**. You drive the loop; the **rigor lives in the runner**
(`run_role`), not in this playbook. Roles run on a chosen backend (claude/codex/…)
through Sparra's existing seam, so you can pit models against each other.

## Setup (first run) — init + pick the model split
The runner reuses the project's `.sparra/` (config, prompts, rubric), so set it up once:

1. **Initialize** if there's no `.sparra/` dir: run `sparra init` (greenfield/existing is
   auto-detected; add `--docs docs` to keep planning files in a subfolder). This scaffolds
   `.sparra/config.yaml` + role prompts.
2. **Pick who builds vs judges** with the user, then edit `.sparra/config.yaml` `roles.*`
   (each role: `backend` claude|codex, `model`, optional `effort`). The high-value default
   is **cross-model**: one family builds, another judges. Example:
   ```yaml
   roles:
     generator: { backend: claude, model: opus, effort: high }
     evaluator: { backend: codex,  model: gpt-5.5, effort: high }
     reviewer:  { backend: codex,  model: gpt-5.5 }
   ```
3. **Verify the chosen backends are usable** before relying on them: Codex needs the
   `codex` CLI authed (`~/.codex`) and `@openai/codex-sdk` installed in the Sparra repo —
   if either is missing, say so and fall back to a Claude evaluator (still useful, just
   same-family). Confirm Claude auth (CC login / `ANTHROPIC_API_KEY`).
4. **Holdout (optional but recommended):** if the user wants a second, hidden gate, create
   `.sparra/HOLDOUT.md` with acceptance checks **the generator must not see** — you (the
   conductor) write it but DON'T keep it in context after; pass it to the evaluator by path.

You can re-run `sparra init` later (it preserves existing config/PLAN), and tweak
`roles.*` per project anytime — changes are picked up on the next role run.

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

## Two ways to be interactive — pick by scope
- **Ad-hoc choreography (this skill):** you drive `run_role` calls with the user between
  them — for a standalone eval, a one-off contract/generate/evaluate, or a quick
  cross-model second opinion. Use this for everything that ISN'T a full multi-item build.
- **The full engine, with human gates:** when the user wants Sparra's real loop
  (decompose, deps, budget, pivots, review, reconcile, commit, resume) but with steering,
  use **`sparra build --step=contract,round`** — don't re-implement the loop here.

### Standalone eval on a WIP tree
`sparra eval [dir] --contract contract.md [--backend codex] [--holdout .sparra/HOLDOUT.md] [--out v.md]`
— grade whatever the user has been building, no full process. (Alias for `role run --kind evaluator`.)

### Driving `sparra build --step` (checkpoint-and-resume)
The build pauses at each checkpoint by writing a steering folder and exiting; you help the
user act on it, then re-run `sparra build` to continue. At each pause:
- `--step=contract` → review/edit the proposed contract file, then resume.
- `--step=round` → read `.sparra/interactive/<run>/<item>/pause.md` (a holdout-redacted
  verdict summary), then set `decision.json` to **continue** (edit `feedback.md` to steer),
  **pivot** (rebuild fresh), **accept** (overriding a FAIL needs a `reason` — it's recorded
  to memory), or **abandon**. Then `sparra build` resumes.
Never read the holdout to write feedback — the summary is already redacted; pasting holdout
into `feedback.md` is rejected on resume.

## How to invoke a role
- **Preferred (interactive): the MCP tool** `run_role` from the `sparra-run` server
  (holdout enforced server-side; never returns holdout). Args: `roleKind`, `brief`|
  `briefPath`, `contractPath`, `workspace`, `holdoutPath`, `backend`, `model`, `out`.
- **CLI fallback (scriptable):** `sparra role run --kind evaluator --backend codex
  --brief brief.md --contract contract.md --holdout .sparra/HOLDOUT.md --out v.md`.

## Backends
Defaults come from `roles.*` (see Setup). Override per call with `backend`/`model` — handy
to get a one-off second opinion from a different model without editing config.

## Don't
- Don't reimplement grading yourself in this session — call the evaluator role (it has
  the rubric + holdout + the exerciser).
- Don't paste holdout/contract acceptance secrets into a generator brief — the runner
  will reject a leak, but don't rely on it; keep them in files referenced by path.
