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
| `pool.ts` | `runRolesConcurrently(jobs, {concurrency})` — bounded-concurrent isolated role-runs, since not every host offers them natively. Returns summaries only (raw payloads never retained), preserves input order, exposes `peakConcurrency`. |

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
holdout guard, the process boundary via a stub `sparra`, and the bounded pool (peak==bound, no
cross-talk). No live model/network. `npm run typecheck && npm test` must stay green.

## Status

`conductors/core` is built and tested. Next: the **Pi adapter** (`conductors/pi/`) exposing the core
as Pi tools/commands + an SDK/RPC-driven loop.
