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
Run **every** `run_role` call below inside a subagent that returns only a summary —
see [How to invoke a role](#how-to-invoke-a-role--delegate-to-a-subagent).

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
4. **Decide.** Act on the subagent's returned summary (verdict + blocking points) —
   not a raw re-read of the verdict file. If it passes, accept (commit if the user
   wants). If it fails, feed the blocking issues back into the generator brief and
   repeat. Pivot to a fresh approach after repeated failures on the same point.
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

## How to invoke a role — delegate to a subagent
Run **every** role-run (generator, evaluator, contract-*, reviewer) inside a
**subagent**, not from this main session. The subagent invokes the role, reads the
already-redacted result, and returns ONLY a concise, decision-relevant summary. This
keeps the main thread lean over a long loop and stacks context isolation on top of
the runner's holdout wall. The model work does **not** move onto Claude — the role's
backend stays whatever `roles.*`/your `backend` arg says (a Claude subagent can still
launch a Codex evaluator via `run_role`/`--backend codex`).

- **Spawn the `sparra-role` subagent** (shipped in this plugin) via the Task tool,
  telling it the role and the exact args (`roleKind`, `brief`/`briefPath`,
  `contractPath`, `workspace`, `holdoutPath`, `backend`, `model`, `out`). If that
  agent isn't available, spawn a general subagent and instruct it to call the
  `run_role` MCP tool with the same args and these same holdout rules.
- **How the subagent reaches the role:** a subagent **inherits the session's MCP
  tools by default**, so it can call **`mcp__sparra-run__run_role`** from the
  `sparra-run` server (the `sparra-role` agent also lists it explicitly; a general
  subagent needs `mcp__sparra-run__run_role` or `mcp__sparra-run`). **CLI fallback**
  when MCP isn't reachable: `sparra role run --kind evaluator --backend codex --brief
  brief.md --contract contract.md --holdout .sparra/HOLDOUT.md --out v.md` (or
  `sparra eval …`) via Bash.
- **What comes back to you (summary only):** evaluator → the **verdict** (pass/fail,
  total vs. threshold, blocking points to feed back as the next brief);
  generator/reviewer/contract-* → a **one-paragraph digest**. The raw diff, the full
  verdict dump, and any role output must **NOT** be pasted into this main session —
  it lives and dies in the subagent.
- **Holdout carries over:** the subagent inherits the rules below — never read
  `HOLDOUT.md`, pass it by path, read the redacted verdict (not raw output/traces),
  and return no holdout text. The conductor never receives holdout.

### Parallelism
Independent role-runs can run as **concurrent subagents** — e.g. evaluate item A
while generating item B, or get two cross-model second opinions at once. Read-only
roles (evaluator, reviewer, contract-evaluator) are always safe to parallelize. The
one caveat: **two WRITER role-runs (generators) must not target the same workspace
concurrently** — give them separate workspaces or run them in sequence.

## Backends
Defaults come from `roles.*` (see Setup). Override per call with `backend`/`model` — handy
to get a one-off second opinion from a different model without editing config.

## Don't
- Don't reimplement grading yourself in this session — call the evaluator role (it has
  the rubric + holdout + the exerciser).
- Don't paste holdout/contract acceptance secrets into a generator brief — the runner
  will reject a leak, but don't rely on it; keep them in files referenced by path.
