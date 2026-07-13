# `sparra conduct` — the headless conductor

`sparra conduct "<prompt>"` replicates the interactive `/sparra-loop` conductor pattern **headlessly**:
from a single prompt it decomposes into 1..N units, and per unit drives
**contract-negotiate → generate → cross-model evaluate → decide**, running every role through Sparra's
existing isolated role-run machinery (`conductors/core`).

It runs in one of two **conductor-brain modes** and surfaces important decisions to a human through a
**decision engine** (park / park-timeout / auto), so a run can be steered exactly as an experienced
human steers /sparra-loop in auto mode.

Like `sparra role run` / `sparra eval`, `conduct` works **without `sparra init`** — it resolves a
config-less, default-backed context via `loadCtxForRole` and creates `.sparra/` on demand.

## Usage

```bash
sparra conduct "<prompt>" [--max-units N] [--concurrency N] [--budget <usd>] [--max-turns <n>] \
                          [--brain <hybrid|llm>] [--auto] [--commit] [--merge] [--dry-run]
sparra conduct --decide <runId> <seq> <answer> [--note "…"]
```

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--max-units N` | `4` | Clamp the decomposition to at most N units (head kept, order preserved). A small prompt may legitimately yield a single unit. Must be a positive integer. |
| `--concurrency N` | `2` | Bounded number of units run at once (`runUnitsConcurrently`). Within a unit, roles stay sequential. Must be a positive integer. |
| `--budget <usd>` | (config) | Per-role-run USD cap (`--budget` on each `role run`). `0` = unlimited, per the existing role-run convention. Negative/non-numeric is rejected. |
| `--max-turns <n>` | (config) | Per-role-run turn cap. Must be a positive integer. |
| `--brain <hybrid\|llm>` | `hybrid` | Conductor-brain mode (see below). `hybrid` = deterministic loop + LLM at judgment points; `llm` = the brain drives turn-by-turn. Invalid values are rejected before any spend. |
| `--auto` | off | Never park a decision — the brain decides everything (`surface: "auto"` for the run). |
| `--commit` | off | After a unit is **accepted**, commit its worktree WIP onto its own `sparra/<name>` branch — the `committer` role (when `git.agentCommits: "agent"`) or a deterministic template message (`"template"`), mirroring `src/build`'s `commitItem` (incl. holdout exclusion). The message carries the unit's **score** and the conduct **`runId`**. `run.json` records `committedSha`. Worktree + branch are kept. |
| `--merge` | off | **Implies `--commit`.** Integrate each accepted unit's branch into a **safe target** — a run branch `sparra/<runId>` when conduct started from the default branch, or the current **non-default** branch otherwise; **never** the default branch. Prefers **rebase + fast-forward**, falling back to a **merge commit**. A merge conflict or a dirty target **parks** a `merge-blocked` decision (`skip-unit` / `abort-merge`) through the same decision engine. On a **successful** merge the unit worktree is **torn down** (existing rm-worktree machinery); `run.json` records `mergedInto`. Merges are **serialized** across concurrently-completing units. |
| `--dry-run` | off | Decompose + write briefs only — **no role spend beyond the decomposer**. |

## Conductor-brain modes

- **`hybrid` (default).** The deterministic loop runs exactly as U1, but the LLM **conductor role**
  (`roles.conductor`) is consulted at the five **judgment points** and its structured answer is
  applied to the run path:
  1. **contract non-convergence** — finalize as-is / revise-brief / abandon,
  2. **unit exhausted rounds** — pivot / generalize-spec / abandon,
  3. **cross-model gate collapse** (no distinct grader) — abandon / accept-anyway / retry,
  4. **budget/limit recovery** ambiguity — wait / fallback / abandon,
  5. **borderline final accept** (a pass within a few points of threshold) — accept / revise / abandon.

  A clean, non-borderline pass never consults the brain.
- **`llm`.** The brain drives turn-by-turn: given holdout-safe run state + the latest summaries it
  chooses the next action (run role / revise-with-feedback / pivot / escalate / finalize / accept /
  abandon / surface-to-human) until the run completes or the round budget exhausts (a hard bound — an
  endlessly-driving brain still terminates with a persisted terminal outcome).

The brain sees **only holdout-safe** material: `ParentSummary` control fields, the briefs/contracts it
authored, and run state — never holdout text, evaluator traces, or raw verdicts. It runs in-process,
answers strict JSON, and re-asks once on malformed output before the deterministic fallback kicks in.

## Decision engine

The decision engine surfaces a judgment point to a human. The **filesystem is the source of truth**:

- `surface: "park"` — write `.sparra/conduct/<runId>/decisions/<seq>.request.json` (id, unit, kind,
  question, options, default, expiresAt) and **wait** for `<seq>.decision.json` (answer + optional
  note). When stdin is a TTY it ALSO prompts inline (readline) — **first answer wins** (file vs TTY).
- `surface: "park-timeout"` (default) — park, but after `timeoutSec` (default 1800) the brain (or the
  deterministic policy when no brain is available) decides and records the rationale.
- `surface: "auto"` (or `--auto`) — never park; the brain decides everything.

**Audit trail.** Each decision is a SINGLE `run.json` record per `<seq>` that transitions
`status: "pending"` → `"resolved"`: the pending record is appended (and phase-logged) the moment the
request is surfaced, then updated in place when answered — so a parked, in-flight decision is durably
inspectable and one sequence never yields two records. A resolved record carries `kind`, `chosen`,
`rationale`, optional `note`, `source` ∈ `file` / `tty` / `brain` / `auto-deterministic` /
`brain-fallback`, and the trigger `via` ∈ `park` / `timeout` / `auto`. All payloads are
**holdout-safe by construction** — built from `ParentSummary`-derived material only.

### Answering a parked decision from another terminal

```bash
sparra conduct --decide <runId> <seq> <answer> [--note "why"]
```

The `<answer>` is **validated against the parked request's `options`** (an off-menu answer exits
non-zero, naming the valid options). On success it atomically writes `<seq>.decision.json` where the
run's poller looks **and** transitions that `<seq>`'s `run.json` record to `resolved` (`source: "file"`).
The write is **exclusive** — an already-resolved decision cannot be overwritten (a second `--decide`
for the same `<seq>` exits non-zero, the first answer stands), so one sequence yields exactly one
durable resolution whether the running poller or `--decide` resolves it. An unknown run or unparked
`<seq>` exits non-zero with a naming error and spends nothing.

**Remote (HTTP bridge).** The same parked decisions are answerable over the HTTP bridge without shell
access: `POST /conduct` triggers a run, `GET /jobs/:id` surfaces the run's still-parked
`pendingDecisions` (`{seq, unit, kind, question, options, default, expiresAt}`), and
`POST /jobs/:id/decision {seq, answer, note?}` (or `bridge decide <jobId> <seq> <answer>`) answers one —
resolved **in-process** through the very same `writeDecisionAnswer` + `applyFileDecisionToRunState`
engine functions this CLI uses (no shell-out, no reimplemented protocol). So a parked decision can be
answered from the file, an inline TTY prompt, `conduct --decide` in another terminal, **or** the bridge
over the network. See [docs/http-bridge.md](http-bridge.md#conduct-over-the-bridge--remote-decisions).

A malformed flag (missing value, non-numeric, non-positive `--max-units`/`--concurrency`/`--max-turns`,
or negative `--budget`) is rejected **before any model spend** — the command exits non-zero naming the
offending flag and creates no run directory.

## Commit & merge landing (`--commit` / `--merge`)

By default `conduct` is **report-only**: it leaves every accepted unit on its own `sparra/<name>`
worktree and touches no history. The opt-in landing flags change that **after** a unit is accepted:

- **`--commit`** commits the unit's worktree WIP onto its `sparra/<name>` branch (mirroring the build
  loop's `commitItem`: `committer`-role plan when `git.agentCommits: "agent"`, else a deterministic
  template commit — with the holdout excluded from the diff/plan/commit). The message carries the
  unit's **score** and the conduct **`runId`**. `run.json` gets `committedSha`. The worktree/branch
  are **kept**.
- **`--merge`** (implies `--commit`) then integrates each committed branch into a **safe target**:
  - started **on the default branch** → a new/reused **run branch `sparra/<runId>`** in a sibling
    worktree (cut from the default tip; the default branch is never modified);
  - started **on a non-default branch** → **that branch**, in place.
  - It **never** merges into the default branch — that final land stays yours.
  - It prefers **rebase + fast-forward** (linear history); if the rebase can't apply it falls back to
    a **merge commit**.
  - A **merge conflict** or a **dirty merge target** is surfaced as a **`merge-blocked`** parked
    decision through the same decision engine (options `skip-unit` — keep this unit's worktree and
    move on — or `abort-merge` — stop merging the remaining accepted units). `--auto`/a brain resolves
    it without parking; the target is left **byte-identical** and the unit's worktree + branch remain.
  - On a **successful** merge the unit worktree is **torn down** via the existing rm-worktree
    machinery (force-removed only once its branch is merged into the target), and `run.json` records
    `mergedInto`.
  - Merges into the shared target are **serialized** across concurrently-completing units — no lost
    update, no duplicate.

Without either flag, behavior is **byte-identical to today** (no commit, no merge, no teardown, and
`run.json` unit entries carry neither `committedSha` nor `mergedInto`).

## Artifacts layout

Everything lands under `.sparra/conduct/<runId>/` (the filesystem is the source of truth):

```
.sparra/conduct/<runId>/
  run.json                 # units, per-unit outcome/score/cost/branch/worktree, overall status
                           #   + committedSha/mergedInto when landed with --commit/--merge
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
- **Git safety.** `conduct` **never** touches the repo's **default branch** — that land is always
  yours. By default (no `--commit`/`--merge`) it also never commits or merges anything: each unit
  generates on its **own persistent** `sparra/<name>` unit worktree and `run.json` reports each
  accepted unit's branch + worktree, left for you. The opt-in `--commit`/`--merge` flags (below)
  commit accepted WIP onto its own `sparra/<name>` branch and integrate accepted branches into a
  **safe target that is never the default branch** — a run branch `sparra/<runId>` when conduct
  started from the default branch, or your current (non-default) branch otherwise.

## What it reuses

`conduct` does **not** reimplement the loop. It composes the host-agnostic `conductors/core`:
`runUnit` (via `runUnitsConcurrently`), `negotiateContract` (extended with an optional
contract-generator so the contract is drafted, not assumed), `runBuildCycle`, `decideFromEvaluation`,
the `RoleRunner` seam, and the `ParentSummary` allowlist. Roles run as `sparra role run … --json`
subprocesses; the spawned bin defaults to this repo's own `bin/sparra.mjs` and honors `SPARRA_BIN`.
