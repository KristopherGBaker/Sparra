# Phases

Sparra's flow mirrors how real software gets built: plan together → optionally de-risk → build once you're satisfied. Each phase is a CLI command; everything reads from and writes to disk, so any phase is resumable.

The **build** step runs two ways: hand it off to the autonomous loop (`sparra build`, this page), or drive it yourself from a Claude Code session via the [role-runner](role-runner.md) (the `/sparra-loop` skill), the same adversarial rigor with your hand on the wheel. The plan/freeze/reflect phases below are shared by both.

```
init → [orient] → plan ⇄ prototype → freeze → build → reflect
```

The **only** edge that advances toward building is the human-run `freeze`. Nothing auto-advances.

---

## Phase 0 — ORIENT (existing projects only)
`sparra orient` runs an agent that reads the repo and maps it — architecture, module boundaries, the conventions/idioms **actually in use** (with file:line evidence), the build system, how tests run, CI, and the **seams** where new work attaches — into **`CODEBASE_MAP.md`**. It runs under a single-file writer guard: it may read anything but the **only** file it can write is `CODEBASE_MAP.md` (every other write and any Bash mutation is blocked). Greenfield skips this. This map is what lets planning answer its own questions instead of interrupting you.

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
`sparra build` runs the long-horizon generator ↔ adversarial-evaluator loop against the frozen plan. See **[the build loop](build-loop.md)** for the full mechanics (contract negotiation, exercising, GAN pivots, budgets, holdout, safety). On accept, an optional **[measure step](build-loop.md#measure)** (opt-in `measure.enabled`) runs the project's own QA harness between reconcile and commit — a non-blocking signal that records metric regressions vs. a baseline. It's also available standalone: `sparra measure [dir] [--worktree] [--set-baseline] [--out f]` (mirrors `sparra eval`).

## Self-improvement (outer loop)
- Every agent's **full transcript** is written as readable markdown under `.sparra/traces/<run>/` for build runs, or `.sparra/traces/role-run-*` for ad-hoc role-run sessions.
- `sparra reflect` reviews the selected run's traces, finds where the evaluator was too lenient/harsh or drifted from the rubric, and **proposes prompt edits** (a diff per prompt). With a build run recorded, it uses that run as before. Without a build run, it auto-discovers `.sparra/traces/role-run-*` dirs and reflects over the session window newer than the newest `.sparra/reflect/reflect-*` output; if there is no prior reflect, it uses all role-run traces. Evaluator role-run trace bodies are excluded before the reflector sees them because they may contain holdout content. `sparra reflect --traces <glob-or-dir>` overrides both build-run selection and the session window. `sparra reflect --apply` applies proposed prompt edits, backing up the originals. It also appends a note to `.sparra/memory.md`.
- **Harness-level findings → a shared inbox.** Some findings are about **Sparra itself** (a config knob, a guard/holdout gap, a phase/role bug, a backend limit), not this project's prompts. The reflector tags those separately and `sparra reflect` routes each into a user-level inbox — `~/.sparra/reflections/` (override the root with `SPARRA_HOME`) — as its **own uniquely-named file** (so parallel reflects in different projects never collide, no locking). Each finding is written under its own `###` heading. **Recurrence-aware:** when the reflector re-observes an existing inbox finding it tags it `RECURRENCE-OF: <exact title>`; the harness increments that finding's `×N` counter in place (no duplicate file) — only material findings (those that caused a bounce, a wasted round, a wrong grade, burned turns, or a forced override) are routed. Later, from the Sparra repo, `sparra reflect --upstream` lists every finding ranked by recurrence count DESC (`×N` shown per entry) with a **global 1-based index**; triage them one at a time with `--done <ids>` / `--wontdo <ids>` (comma-separated; optional `--reason "<text>"`), which splices each marked finding out to `archive/<file>` under a disposition marker and leaves the un-triaged ones to resurface next run. `--upstream --clear` (no triage flags) still archives ALL files at once. Nothing is applied to Sparra automatically — you triage.
- `sparra batch -k N` runs **N independent builds** of the same frozen plan and summarizes which items are flaky across runs.
- `sparra prompts status` classifies each `.sparra/prompts/<role>.md` **three ways** against the current default via `.baseline.json`: **`same`**, **`stale`** (a newer default is available — safe to adopt), **`local`** (your/`reflect`'s edit; no update), **`conflict`** (both moved), **`drifted`** (legacy, no baseline), **`missing`**. `sparra prompts sync` adopts **`stale` only** (leaving local edits alone); `--role <r>` force-overwrites one role and `--all` overwrites every changed role (both DISCARD local edits, with a warning). Any sync refreshes the baseline. A `stale` prompt is now also surfaced once on the **build** and **`sparra eval` / `role run` / `sparra-loop`** startup paths, so a fresh loop learns a newer default exists. See [configuration](configuration.md#prompt-drift-sparra-prompts-status--sync).

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

## Pruning leftovers — `sparra clean`
Finished or abandoned runs can leave behind stale Sparra worktrees and branches (`sparra/<topic>`).
**`sparra clean`** prunes them — and, like `finish`, it **never silently touches anything you care
about.**

```
sparra clean [--yes] [--force]
```

- **Dry run by default.** Without `--yes`, `clean` only **previews**: it lists the candidate
  worktrees it WOULD remove, the merged branches it WOULD delete, and the unmerged branches it
  WOULD skip — and touches nothing.
- **Candidates.** Worktrees whose checkout is **not** the main checkout and whose branch carries the
  configured `git.branchPrefix`; branches that carry the prefix and are **neither** the default
  branch **nor** the currently checked-out branch.
- **`--yes` executes.** It removes the candidate worktrees **first** (a worktree pins its branch),
  then deletes branches: **merged** branches with `git branch -d` (merged-only). An **unmerged**
  branch is **skipped** unless you add **`--force`** (`git branch -D`).
- **Hard invariants:** never removes the main checkout, never deletes the default branch or the
  current branch, never deletes an unmerged branch without `--force`.

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
