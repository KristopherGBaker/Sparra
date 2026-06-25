---
name: sparra
description: >-
  Drive and debug Sparra — the autonomous build harness (collaborative plan → freeze
  → autonomous build → reflect, over pluggable Claude/Codex agent backends). Use this
  whenever the user is working with Sparra: running, resuming, or kicking off a `sparra
  build`; setting up or editing `.sparra/config.yaml`; choosing per-role backends/models;
  configuring the iOS/macOS exerciser (xcodebuildmcp/XcodeGen); authoring a `HOLDOUT.md`;
  doing cross-backend (Codex builds, Claude judges) runs; or diagnosing a run from its
  artifacts (state.json, contracts, verdicts, traces, memory.md). Trigger on mentions of
  "sparra", a `.sparra/` directory, "the build harness", a stalled/failed/over-budget
  build item, contract negotiation, GAN pivots, or an iOS Simulator build via Sparra —
  even if the user doesn't say "skill".
---

# Working with Sparra

Sparra is a long-running autonomous build harness. The human plans collaboratively, then
hands off to an autonomous loop that builds one work item at a time — each negotiated
against a checkable "done" contract and graded by an adversarial evaluator that *actually
runs the artifact*. It runs on pluggable agent backends (Claude + Codex).

**The mental model that explains everything:** the filesystem is the source of truth and
the only shared state. Every phase reads inputs from disk and writes outputs to disk, so
runs are inspectable, diffable, and resumable from any point. When something looks wrong,
you debug by *reading the artifacts*, not by guessing.

## Find the repo and its docs first

The authoritative docs live in the Sparra repo. Locate it and read the relevant doc
before doing anything non-trivial — don't reconstruct behavior from memory:

```bash
SPARRA_REPO="$(dirname "$(dirname "$(readlink "$(command -v sparra)")")")"  # repo root via the linked bin
ls "$SPARRA_REPO/docs"   # phases.md build-loop.md backends.md configuration.md ios.md
```
- `docs/phases.md` — the workflow (orient→plan⇄prototype→freeze→build→reflect), TUI, greenfield vs brownfield
- `docs/build-loop.md` — contract negotiation, exercising, GAN pivots, holdout wall, sandbox-first, budgets, memory
- `docs/backends.md` — the `AgentBackend` seam, Claude + Codex, per-role + cross-backend evaluation
- `docs/configuration.md` — every knob, the `.sparra/` layout, resuming
- `docs/ios.md` — Apple-platform builds (xcodebuildmcp, XcodeGen, the mandatory launch screen)

If `sparra` isn't on PATH, run via `node "$SPARRA_REPO/bin/sparra.mjs"`.

## Driving a run

The commands, in order. Nothing advances toward building except the human-run `freeze`.

```bash
sparra init            # detect greenfield vs existing; scaffold .sparra/
sparra orient          # existing projects only → CODEBASE_MAP.md
sparra plan            # collaborative interview → PLAN.md  (or: sparra-tui)
sparra prototype "…"   # optional throwaway spike → FINDINGS.md
sparra freeze          # the human gate — locks PLAN.md (+ CODEBASE_MAP/HOLDOUT) as build input
sparra build           # the autonomous generator↔evaluator loop
sparra reflect         # propose prompt edits from the run's traces (--apply to accept)
sparra status          # where am I / what's next
sparra resume          # continue whatever phase, from .sparra/state.json
```

`--root <dir>` targets a project; otherwise the cwd is used. Re-running `sparra build`
resumes — passed/abandoned/budget_exceeded items are skipped.

**Run each project in its OWN directory.** Do not nest a Sparra work dir inside another
Sparra project (e.g. building inside the Sparra repo, or under a parent that has its own
`PLAN.md`/`.sparra/`). Read-only roles can read up the tree and get confused by the outer
project's plan. The example `run.sh` scripts also derive the repo path from their own
location, so don't copy them out of the repo — drive the global `sparra` directly, or pass
an out-of-repo work dir.

## Configuring (`.sparra/config.yaml`)

Seeded on `init`; edit and re-run (picked up live). Full knob list: `docs/configuration.md`.
The few that matter most:

- **`roles.<role>: { backend?, model, effort? }`** — `backend` defaults to `claude`; set
  `codex` to run that role on Codex. Roles: orienter, planner, **decomposer**, prototyper,
  contractGenerator, contractEvaluator, generator, evaluator, reflector.
- **`build.maxBudgetUsdPerItem` / `maxTokensPerItem`** — per-item caps; crossing either
  halts the item `BUDGET_EXCEEDED` and the run continues. `0` = no cap.
- **`exercise.mechanism`** — `cli` | `web` | `ios` | `computer-use` | `custom`.
- **`contract` / `pivot` / `rubric`** — assertion range (scaled per item), GAN restart
  threshold, scoring weights + pass threshold.

### Cross-backend (Codex builds, Claude judges)
A genuine quality lever — independent model families catch each other's blind spots.
```yaml
roles:
  generator:  { backend: codex,  model: gpt-5-codex }
  decomposer: { backend: claude, model: opus }              # keep PLANNING on Claude
  evaluator:  { backend: claude, model: opus, effort: high } # independent grader
```
Two rules of thumb: **keep `decomposer` on Claude** even when Codex builds (Codex tends to
over-split), and on a **subscription or with Codex, cap with `maxTokensPerItem`, not USD**
— Codex reports tokens (its `costUsd` is `0`), so the dollar cap only bounds the Claude side.
Needs `npm i @openai/codex-sdk` + the `codex` CLI (auth from `~/.codex`).

### iOS / macOS
`mechanism: ios` drives `xcodebuildmcp`; the multimodal evaluator screenshots the running
app and reads it. Needs Xcode + a Simulator + `xcodebuildmcp` + `xcodegen`. The generated
project MUST set a launch screen (`INFOPLIST_KEY_UILaunchScreen_Generation: YES`) or the
app letterboxes at 320×480 and UI automation misses. Full guide: `docs/ios.md`.

### Holdout / isolation wall
Author acceptance checks in `HOLDOUT.md`; only the evaluator sees them (enforced in code).
The builder can't overfit to checks it can't read. Frozen alongside the plan. Strongest
combined with cross-backend grading. See `docs/build-loop.md`.

## Diagnosing a run

This is the highest-value thing the skill does. **Read the artifacts in order**, then map
the symptom to a cause. The full per-artifact guide and the failure-signature table are in
**[subskills/diagnose.md](subskills/diagnose.md)** — read it whenever a run stalls, fails,
goes over budget, or produces a surprising verdict.

Quick triage (from the project's `.sparra/`):
```bash
node -e "const s=require('./.sparra/state.json');console.log('phase',s.phase);for(const[k,v]of Object.entries(s.build.items||{}))console.log(k,v.status,'r'+v.round,'score',v.lastScore,'$'+(v.costUsd||0).toFixed(2),(v.tokensUsed||0)+'tok')"
ls .sparra/workitems/items.json .sparra/contracts .sparra/verdicts .sparra/traces
```
Then, by symptom: decomposition shape → `workitems/items.json`; contract not converging →
`contracts/<id>.contract.md`; low/failing score → `verdicts/<id>.r<n>.verdict.md` (blocking
+ evidence); anything deeper → the role transcripts in `traces/<run>/`; recurring learnings
→ `memory.md`.

## Hard-won gotchas (cheat sheet)

- **Run in its own dir** (see above) — nesting causes false "wrong project" rejections.
- **Decomposition belongs on Claude.** If the decomposer over-splits (a standalone
  "scaffold" or "verify it" item, or 8+ items for a small app), it's likely on Codex —
  move `decomposer` to Claude.
- **iOS: launch screen is mandatory**, else letterbox → UI automation fails. Build in the
  project's own dir, not nested.
- **Budgets on a subscription/Codex**: use `maxTokensPerItem`; USD shows `$0` for Codex.
- **`BUDGET_EXCEEDED` ≠ crash** — the item halts, the run continues to the next item.
- **Contracts are proportionate**: a handful of *observable product-behavior* assertions,
  scaled to the item — not build-setting/toolchain trivia. Over-spec is a review failure too.
- **Never commits to your main branch.** Existing repos build on a worktree/branch.
- After a meaningful run, `sparra reflect` turns the traces into proposed prompt edits.
