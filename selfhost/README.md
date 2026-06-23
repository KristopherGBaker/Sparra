# Self-host: run Sparra on Sparra

Sparra can improve its own codebase. Because this repo has source + git history,
Sparra detects it as an **existing** project, which means the safe brownfield rules
apply: it builds in an **isolated git worktree** (a sibling dir, `../Sparra-build-*`),
**never commits to your branch**, only deviates **within an item's scope** (bigger
changes become proposals in `.sparra/proposals/`), and the evaluator runs the
existing checks and treats new failures as hard fails.

## One-time setup

```bash
bash selfhost/setup.sh
```

That runs `sparra init`, installs [`config.yaml`](config.yaml) into `.sparra/`, and
drops the scoped [`PLAN.md`](PLAN.md) (first target: **add a unit-test suite**) at the
repo root. The runtime artifacts it creates (`.sparra/`, `PLAN.md`, `CODEBASE_MAP.md`,
`CHANGELOG.md`) are gitignored in this repo, so they won't pollute commits.

## Drive it

```bash
sparra orient     # map the codebase → CODEBASE_MAP.md
sparra freeze     # your call — lock the plan
sparra build      # autonomous build in a sibling worktree
# review the worktree, then merge what you want by hand
```

Or use the TUI: `sparra-tui` (Dashboard watches progress, `b` builds, `r` reflects).

## What to know

- **The worktree has no `node_modules`** (gitignored), so the exerciser's recipe is
  `npm install && npm run typecheck && npm test` — the first install per run is slow.
- **No live self-modification:** the running harness executes from this repo while
  the build edits a *worktree copy* you review and merge. A bad run can't corrupt
  your working tree.
- **Scope tightly.** The shipped plan targets one thing (tests). For other work,
  edit `PLAN.md` (or `sparra plan`) and keep it focused, or use `sparra build --only <item>`.
- **Cheaper self-improvement:** `sparra reflect` tunes Sparra's *own agent prompts*
  from a run's traces (you approve the diff) — no code risk.

## Cleanup

```bash
git worktree list                       # see build worktrees
git worktree remove ../Sparra-build-<id>
rm -rf .sparra PLAN.md CODEBASE_MAP.md CHANGELOG.md   # reset self-host state
```
