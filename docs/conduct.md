# `sparra conduct` — the headless conductor

`sparra conduct "<prompt>"` replicates the interactive `/sparra-loop` conductor pattern **headlessly**:
from a single prompt it decomposes into 1..N units, and per unit drives
**contract-negotiate → generate → cross-model evaluate → decide**, running every role through Sparra's
existing isolated role-run machinery (`conductors/core`).

This is the **deterministic** conductor core. An LLM conductor brain and an interactive
decision/parking surface are follow-up units — the decision seam (`src/conduct/strategy.ts`) is
already injectable, but only the deterministic strategy (delegating to the core `decideFromEvaluation`)
ships today.

Like `sparra role run` / `sparra eval`, `conduct` works **without `sparra init`** — it resolves a
config-less, default-backed context via `loadCtxForRole` and creates `.sparra/` on demand.

## Usage

```bash
sparra conduct "<prompt>" [--max-units N] [--concurrency N] [--budget <usd>] [--max-turns <n>] [--dry-run]
```

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--max-units N` | `4` | Clamp the decomposition to at most N units (head kept, order preserved). A small prompt may legitimately yield a single unit. Must be a positive integer. |
| `--concurrency N` | `2` | Bounded number of units run at once (`runUnitsConcurrently`). Within a unit, roles stay sequential. Must be a positive integer. |
| `--budget <usd>` | (config) | Per-role-run USD cap (`--budget` on each `role run`). `0` = unlimited, per the existing role-run convention. Negative/non-numeric is rejected. |
| `--max-turns <n>` | (config) | Per-role-run turn cap. Must be a positive integer. |
| `--dry-run` | off | Decompose + write briefs only — **no role spend beyond the decomposer**. |

A malformed flag (missing value, non-numeric, non-positive `--max-units`/`--concurrency`/`--max-turns`,
or negative `--budget`) is rejected **before any model spend** — the command exits non-zero naming the
offending flag and creates no run directory.

## Artifacts layout

Everything lands under `.sparra/conduct/<runId>/` (the filesystem is the source of truth):

```
.sparra/conduct/<runId>/
  run.json                 # units, per-unit outcome/score/cost/branch/worktree, overall status
  <unit-id>/
    brief.md               # the unit's brief (written from the decomposition)
    contract.md            # the finalized (agreed or forced) contract
    critique-rN.md         # per-round contract-evaluator critiques (paths threaded, never inlined here)
```

`run.json` is written **incrementally** and **atomically** (temp-file + rename), so a crashed run is
still inspectable: completed units carry their fields and the overall `status` stays non-final
(`running`) until the run finishes (`completed`).

## Safety properties

- **Cross-model gate.** Each evaluator spec carries the generator's identity as its cross-model
  baseline (`--baseline-backend`/`--baseline-model`), so the runner sets `sameModelGrade` when the
  evaluator's post-fallback identity collapses onto the generator's. The core `decideFromEvaluation`
  never accepts a `sameModelGrade` pass — that check stays effective through the conduct path.
- **Holdout wall.** If the project has a `HOLDOUT.md`, only its **path** is passed to evaluator specs.
  The conduct process never reads or inlines holdout content; conductor-visible state (`run.json`,
  the in-memory state) carries only holdout-safe `ParentSummary`-derived fields. Generator, contract,
  and decomposer specs never receive a holdout path.
- **Git safety.** `conduct` never lands anything on your checked-out branch or the default branch.
  Each unit generates on its **own persistent** `sparra/<name>` unit worktree; `run.json` reports each
  accepted unit's branch + worktree. Merge orchestration is a later unit — `conduct` reports branches
  and leaves them.

## What it reuses

`conduct` does **not** reimplement the loop. It composes the host-agnostic `conductors/core`:
`runUnit` (via `runUnitsConcurrently`), `negotiateContract` (extended with an optional
contract-generator so the contract is drafted, not assumed), `runBuildCycle`, `decideFromEvaluation`,
the `RoleRunner` seam, and the `ParentSummary` allowlist. Roles run as `sparra role run … --json`
subprocesses; the spawned bin defaults to this repo's own `bin/sparra.mjs` and honors `SPARRA_BIN`.
