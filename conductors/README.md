# conductors/

Building blocks for **interactive conductor hosts** — the agent/host that drives Sparra's
collaborative loop (contract → generate → cross-model evaluate → decide) from the outside. This is
distinct from a **backend** (`src/sdk/backends/*`), which is a model that *plays a role*; a conductor
is the host that *orchestrates the roles*.

Today the loop is conducted from Claude Code (first-class) and Codex (experimental) via the
`sparra-loop` skill. `conductors/` is where a **programmatic** conductor lives — currently the **Pi**
build (see [`../docs/explorations/alternative-conductor-hosts.md`](../docs/explorations/alternative-conductor-hosts.md)
for why Pi). opencode remains a possible future host that would reuse the same core.

## `conductors/core` — host-agnostic core

The parts that are identical no matter which host conducts:

| Module | Purpose |
| --- | --- |
| `summary.ts` | **The holdout wall, in code.** `toParentSummary(payload)` projects the canonical envelope to a `ParentSummary` via a type-checked ALLOWLIST (`PARENT_SAFE_FIELDS`). A compile-time guard rejects any holdout-bearing field in the allowlist; unknown/future envelope fields are dropped until consciously added. |
| `roleClient.ts` | `runRole(spec)` runs one role via `sparra … --json` and returns ONLY the redacted summary. `runRoleRaw` is a flagged escape hatch returning the full payload for code that stays inside the boundary. |
| `roleWorker.ts` | A spawnable process boundary (`tsx roleWorker.ts -- <sparra args>`) that prints only the summary — for MODEL-driven hosts where even the parent process must not parse the raw envelope. |
| `bounded.ts` | `mapBounded(items, worker, {concurrency})` — the generic bounded-concurrency pump: at most `concurrency` workers at once, excess QUEUED (never dropped), results in INPUT order, non-enumerable `peakConcurrency`. One shared implementation for `pool.ts` and `scheduler.ts`. |
| `pool.ts` | `runRolesConcurrently(jobs, {concurrency})` — bounded-concurrent isolated role-runs (via `mapBounded`). Returns summaries only (raw payloads never retained), preserves input order, exposes `peakConcurrency`. |
| `scheduler.ts` | `runUnitsConcurrently({ runRole }, jobs, {concurrency})` — runs SEVERAL full units (`runUnit`) at once (via `mapBounded`). Per-unit `{ id, result }`/`{ id, error }` in input order; one failing unit never sinks the batch. Units are concurrent but roles WITHIN a unit stay sequential; each unit's config MUST target a distinct workspace/unitWorktree (caller's contract — two writers never share a workspace). |
| `loop.ts` | `runBuildCycle({ runRole }, config)` + `decideFromEvaluation` — the generate → cross-model evaluate → decide orchestrator, driven over an injected `RoleRunner`. Bounded by `maxRounds`; threads `evaluator.blocking` as next-round feedback; pivots after N fails; **rejects a `sameModelGrade` pass** as non-independent. Pure decision fn + host-agnostic loop; only `ParentSummary` flows through. |
| `contract.ts` | `negotiateContract({ runRole }, config)` — the CONTRACT phase: runs a `contract-evaluator` up to `maxRounds` (default 3), detecting agreement SOLELY from the structured `evaluator.contractAgreed` boolean (the critique prose is never read). A non-agreed round's `outPath` is threaded forward, by path only, as the next round's `ContractRoundContext.priorCritiquePaths`. `runUnit({ runRole }, config)` composes it with `runBuildCycle`: negotiates the contract, then — only if agreed (or `proceedIfNotAgreed`) — runs the existing build cycle, reusing it rather than reimplementing generate → evaluate → decide. |

The canonical envelope type is **`src/roleEnvelope.ts`** (`RunRolePayload`) — the single runner↔conductor
contract emitted by both the MCP `run_role` tool and the `--json` CLI. The core imports it so its
projection stays in lockstep with what the runner actually emits.

### Two isolation modes

- **Program conductor** (e.g. Pi driven via its SDK as a program): call `runRole` / `runRolesConcurrently`
  in-process. The raw payload is parsed and dropped before return, never reaching a model or a log.
- **Model-driven conductor** (a Pi agent session, an opencode subagent): the host's child shells out
  to `roleWorker.ts`, so the raw envelope never enters the parent process at all.

Both rely on the SAME deterministic redaction (`toParentSummary`) — never on a model's compliance.

## Safety invariant

Never read `HOLDOUT.md`; pass only its path to the evaluator and consume only the redacted verdict
(`verdictPath`). The core enforces summary-only return structurally; a conductor built on it must not
re-introduce raw role output, full verdicts, or evaluator traces into its context.

## Tests

`conductors/core/*.test.ts` (vitest, in the `unit` project) — allowlist correctness incl. the
holdout guard, the process boundary via a stub `sparra`, the bounded pool (peak==bound, no
cross-talk), and the CONTRACT phase (`contract.test.ts`: agreement detection, prior-critique
path-threading, bounded exhaustion, `runUnit` composition). No live model/network. `npm run
typecheck && npm test` must stay green.

## `conductors/pi` — the Pi adapter

Exposes the core to a **Pi** host. Pi + `typebox` are optional peer deps (installed here as devDeps);
the tested logic stays free of them so `npm test` never loads Pi.

| Module | Purpose |
| --- | --- |
| `roleRunner.ts` | **Pi-free** tool logic: `runSparraRoleForTool(input, deps?)` builds a `RunRoleSpec`, calls the core `runRole`, and returns `{ summary, text }` — a `ParentSummary` plus a compact holdout-safe rendering. `holdoutPath` is forwarded as `--holdout <path>` (never read). |
| `extension.ts` | The real Pi extension: `pi.registerTool(defineTool({ name: "sparra_role", … }))` (TypeBox params); `execute` → `runSparraRoleForTool`. The only file importing Pi/typebox at the top level; never imported by a test. |
| `piConductor.ts` | `runIsolatedRoleViaPiSdk(...)` — lazy-imports Pi, spawns an isolated Codex-backed child session (`openai-codex`/`gpt-5.6-sol` by default) that runs the core `roleWorker` and returns only the summary. Live-only. |
| `loopCommand.ts` | `registerSparraLoopCommand(pi, deps?)` — registers the `/sparra-loop` Pi command that now drives the FULL unit over the core `runUnit`: negotiate the contract (adversarial `contract-evaluator`, on the evaluator model) → generate → cross-model evaluate → decide, and reports each contract + build-cycle round's summary. `--contract-rounds n` / `--proceed-if-not-agreed` control the contract phase. Pi **type-only** (no runtime Pi/typebox import; `node:os`/`node:path` built-ins only). |
| `index.ts` | The Pi-free barrel (never loads Pi/typebox on import). |
| `package.json` | The **Pi package manifest** (`keywords:["pi-package"]`, `pi.extensions:["./extension.ts"]`, `pi.skills:["./skills"]`, Pi/`typebox` as `"*"` peerDependencies, `type:module`). Makes `conductors/pi` a `pi install`-able package. |
| `skills/sparra-loop/SKILL.md` | The **conductor skill** (Agent Skills standard). Loads into Pi's system prompt so you can say *"conduct a Sparra loop on X"* instead of hand-wiring flags — it drafts the contract, sets the cross-model split, drives contract → generate → evaluate → decide via the `sparra_role` tool / `/sparra-loop` command, and enforces the one holdout rule. Analogue of Claude Code's `skills/sparra-loop`. |

The manifest's `pi.skills` also references the repo's canonical **`sparra`** skill (`../../skills/sparra`
— the broader "drive & debug the whole harness" skill: `sparra build`, `.sparra/config.yaml`, per-role
backends, diagnosing runs from artifacts, the iOS exerciser). So a local-path install exposes **both**
skills in Pi with zero copy/drift — `sparra-loop` (Pi-native) and `sparra` (shared, host-agnostic).

### Install into Pi

```bash
pi install ./conductors/pi     # from the Sparra repo root (writes to ~/.pi settings; -l for project)
pi -e ./conductors/pi          # temp, current run only (no settings write)
```

A **local-path install loads in place** — the extension's `../core` / `../../src` relative imports
resolve against the Sparra repo, so the repo must be present (this is the dev/self-host path). It
registers the `sparra_role` tool and the `/sparra-loop` command. Publishing to npm/git would require
bundling `conductors/core` + the `src/roleEnvelope.ts` contract into the tarball (relative imports
can't escape a published package) — future work.

Then, three ways to use it inside Pi:
- **Conversational (skill):** just ask — *"conduct a Sparra loop to build X against this contract"* —
  and the `sparra-loop` skill drives the whole thing (drafts/negotiates the contract, picks the
  cross-model split, generates, evaluates, decides), so you don't supply every flag. Force-load it
  with `/skill:sparra-loop`.
- **One command:** `/sparra-loop --brief <path> --contract <path> [--holdout <path>] [--contract-rounds
  n] [--proceed-if-not-agreed]` — the full cycle when you already have a brief + contract.
- **One role:** call the `sparra_role` tool directly for a single role-run / a cross-model second
  opinion.

## Status

`conductors/core` and `conductors/pi` are built and tested (`npm run typecheck` + `npx vitest run
conductors/`, and the full `npm test` suite). Both are **live-verified** end-to-end against real
Codex (`gpt-5.6-sol`) sessions:
- `runIsolatedRoleViaPiSdk` drove an isolated session → core `roleWorker` → summary-only, holdout intact.
- `runBuildCycle` drove a full generate→evaluate→decide cycle over two live child sessions and reached
  `accepted` with no raw leak.

The Pi conductor is functionally complete for a single-unit cycle: `conductors/core/contract.ts`
folds contract negotiation (`contract-evaluator` until AGREED, detected from the structured
`contractAgreed` field) into a full `runUnit` (contract → generate → evaluate → decide), and
`conductors/pi/loopCommand.ts`'s `/sparra-loop` command now drives that full `runUnit` — not just the
build cycle — so a single command invocation negotiates the contract before ever generating.

`conductors/core/scheduler.ts` (`runUnitsConcurrently`, over the shared `bounded.ts` pump) runs
several full units concurrently, and `conductors/pi/package.json` makes the adapter a `pi install`-able
package. Both are verified: the package is **live-loaded by Pi** (`pi -e ./conductors/pi` starts clean
and its `extension.ts` registers `sparra_role` + `/sparra-loop`), and the full single-unit loop was
**live-driven** over three real Codex sessions (contract-evaluator → generator → evaluator → `accepted`,
no raw leak). Next candidates: a live run on real Claude roles (not the stub), npm/git publish
(bundling the core), and a multi-unit live drive.
