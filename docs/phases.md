# Phases

Sparra's flow mirrors how real software gets built: plan together → optionally de-risk → hand off to an autonomous loop once you're satisfied. Each phase is a CLI command; everything reads from and writes to disk, so any phase is resumable.

```
init → [orient] → plan ⇄ prototype → freeze → build → reflect
```

The **only** edge that advances toward building is the human-run `freeze`. Nothing auto-advances.

---

## Phase 0 — ORIENT (existing projects only)
`sparra orient` runs a read-only agent that maps the repo — architecture, module boundaries, the conventions/idioms **actually in use** (with file:line evidence), the build system, how tests run, CI, and the **seams** where new work attaches — into **`CODEBASE_MAP.md`**. Greenfield skips this. This map is what lets planning answer its own questions instead of interrupting you.

## Phase A — COLLABORATIVE PLANNING (interactive, human-led)
`sparra plan` opens an interview that **co-edits `PLAN.md` with you**:

- Interviews you **relentlessly**, one decision at a time, resolving dependencies between decisions in order.
- **One question at a time**, always with its **recommended answer** so you can confirm or redirect.
- **Explores instead of asking** when the codebase / prototypes / logged findings can answer.
- **Never auto-advances to building** — it has no build tools; only you decide the plan is done.
- Keeps the plan **high-level** (granular upfront plans cascade errors over long horizons): intent, constraints, risks, open questions, and — for existing projects — which patterns/modules to conform to.

Resumable across restarts (the session id is persisted): quit and re-run `sparra plan` to continue. In-interview: `/snapshot`, `/freeze`, `/exit`, `/help`. Or `sparra snapshot` from the shell.

## Phase B — EXPLORATION / PROTOTYPING (optional)
`sparra prototype "<idea>"` builds a **throwaway** prototype in an **isolated workspace** — `prototypes/<name>/` (greenfield) or a dedicated **git worktree** (existing repos), never mixed into the real tree. The purpose is **learning**; it writes a `FINDINGS.md`. Fold learnings back with `sparra log-finding <FINDINGS.md>`. Loop A ⇄ B freely. **Prototypes are discarded by default** — promoting anything into the real build is deliberate.

## FREEZE GATE (your decision, not automated)
There is **no automated "plan is done" check.** When satisfied, run `sparra freeze`. It snapshots `PLAN.md` (and `CODEBASE_MAP.md`, and an optional `HOLDOUT.md`) into `.sparra/frozen/` as build input. **The frozen plan is a strong _prior_, not a literal contract.**

## Phase C — AUTONOMOUS BUILD
`sparra build` runs the long-horizon generator ↔ adversarial-evaluator loop against the frozen plan. See **[the build loop](build-loop.md)** for the full mechanics (contract negotiation, exercising, GAN pivots, budgets, holdout, safety).

## Self-improvement (outer loop)
- Every agent's **full transcript** is written to `.sparra/traces/<run>/` as readable markdown.
- `sparra reflect` reviews the last run's traces, finds where the evaluator was too lenient/harsh or drifted from the rubric, and **proposes prompt edits** (a diff per prompt). `sparra reflect --apply` applies them, backing up the originals. It also appends a note to `.sparra/memory.md`.
- `sparra batch -k N` runs **N independent builds** of the same frozen plan and summarizes which items are flaky across runs.

## Next feature — `sparra new`
When a cycle is done and you want to build the *next* feature in the same project, run
**`sparra new ["<title>"]`**. It archives the finished cycle's working set — `PLAN.md`, the
frozen input, `workitems/`, `contracts/`, `verdicts/`, `reviews/`, and the run's traces —
into **`.sparra/cycles/<NNNN>-<slug>/`** (with a `cycle.json` manifest), **carries forward**
the cross-cycle artifacts (`memory.md`, `CHANGELOG.md`, `CODEBASE_MAP.md`, config,
calibration, prompts), writes a fresh `PLAN.md`, and returns to the **`plan`** phase. Then
it's the normal `plan → freeze → build` again — no `--fresh` needed (the cycle starts clean).

Each cycle's contracts/verdicts are preserved as a permanent record, and `memory.md` makes
the harness smarter across features. (Without `new` you'd have to manually clear the working
set and remember `build --fresh`; `build` now also *warns* if the frozen plan changed but the
run wasn't re-decomposed.)

## Close-out — `sparra finish`
When a build cycle is **terminal** (every item `passed`/`failed`/`abandoned`/`budget_exceeded`)
and the tree is clean, **`sparra finish`** lands the Sparra branch, tears down its isolation,
and archives the cycle — **without ever silently touching your main branch.** It refuses (no
side effects) if the build is mid-flight or the working tree is dirty.

```
sparra finish [--pr | --merge --yes] [--teardown] [--force] [--branch <name>] [--new "<title>"]
```

- **Land (opt-in; the default touches nothing).**
  - `--pr` — open a PR from the `sparra/<topic>` branch into your integration branch via
    `gh pr create` (the recommended safe default). If `gh` isn't installed, finish prints the
    exact manual `git push … && gh pr create …` command and continues.
  - `--merge` — explicitly checks out the configured **default branch** and `git merge --ff-only`
    the Sparra branch into it (never the current HEAD), **only** with `--merge` **plus** a
    confirmation (`--yes`). It tests fast-forwardability **before** touching the checkout, so it
    **aborts with the checkout left exactly as it found it** if the default branch has diverged
    (no clean fast-forward); it never uses `--no-ff`, never force-pushes, never hard-resets.
  - no land flag — finish reports that the branch is ready and how to land it.
- **Teardown** (after a successful `--merge`, or with `--teardown`) — `git worktree remove`
  the build worktree, then `git branch -d` the branch (**merged-only**). Deleting an **unmerged**
  branch needs an explicit `--force` (`-D`); otherwise finish refuses. The worktree is removed
  before the branch. Teardown is **all-or-nothing**: only when both the worktree removal and the
  branch delete succeed does finish clear `build.branch`/`workspaceDir`; if either is refused or
  fails it leaves that state intact so you can safely retry (e.g. with `--force`).
- **Archive** — calls the same `archiveCycle()` as `new`, moving the working set **including the
  live `HOLDOUT.md`** into `.sparra/cycles/<NNNN>-<slug>/`. With `--new "<title>"` it chains
  straight into a fresh cycle (`cmdNew`) instead of just closing.
- **Branch resolution.** finish operates on the recorded `build.branch` by default, but can also
  close out a Sparra branch it didn't create. The effective branch is
  `--branch <name>` ▸ recorded `build.branch` ▸ **auto-detected** current branch. Auto-detect only
  picks the checked-out branch when it carries the configured `branchPrefix` (e.g. `sparra/…`) and
  is **not** your integration branch — your `main`/`master` is never auto-selected. An explicit
  `--branch` always wins over recorded state; if the named branch doesn't exist, finish **refuses
  before any side effect**.

**Holdout safety:** `HOLDOUT.md` is archived privately into the cycle dir and **never** rides
into a PR or a merge. `.sparra/` is gitignored, so the normal case is already safe; if a
`HOLDOUT.md` is a *tracked* file a `--pr`/`--merge` would carry, finish **hard-stops the land
before any PR/merge** (it refuses loudly and tells you to `git rm --cached` it and add it to
`.gitignore`) — the cycle is still archived privately, but no land proceeds while the holdout is
tracked. No code in the land/teardown/archive path reads holdout contents.

---

## The interactive TUI
Prefer a live dashboard? `sparra-tui` (or `npm run tui`) is an Ink app with three panes (`Tab` / `d`·`p`·`l`):

- **Dashboard** — phase, per-item status/score/pivots/cost, and a live tail of the active agent's trace.
- **Plan** — the planning interview in-process (`/snapshot` · `/freeze` · `/exit`); same resumable session as `sparra plan`.
- **Logs** — actions by key: `o`rient · `s`napshot · `f`reeze · `b`uild · `r`eflect (`k` cancels).

It's a thin front-end over the same filesystem state and phase functions — identical to the CLI and equally resumable.

---

## Greenfield vs. brownfield

| | **Greenfield** | **Existing codebase** |
|---|---|---|
| Phase 0 | skipped | full repo map → `CODEBASE_MAP.md` |
| Contracts | assertions define "done" | **+ mandatory** no-regression & conforms-to-conventions clauses |
| Evaluator | exercises the artifact | **+ runs the repo's existing test suite**; new failures = hard fail |
| Deviation | **free** to depart from the plan when it improves the product | **constrained**: improve only *within the item's scope*; bigger ideas become **proposals** in `.sparra/proposals/` |
| Git safety | builds in place | builds on a **worktree/branch**; never commits to your main branch |

Every deviation is recorded to `CHANGELOG.md` with rationale and reconciled into `PLAN.md`. Strictness is a knob (`strict` | `moderate` | `free`), defaulted by mode.
