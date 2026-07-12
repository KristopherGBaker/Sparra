# The HTTP bridge: Sparra as a remote conductor host

`conductors/http` is a small `node:http` service — a **remote conductor host** — that lets a
Tailscale-connected agent trigger `sparra` phases and role-runs on a Mac it doesn't have a shell on.
It's built entirely on `conductors/core` (the same host-agnostic `runRole`/`runUnit` the Pi conductor
uses); this doc covers the HTTP-specific surface. Setup/on-ramp: [`conductors/http/README.md`](../conductors/http/README.md).

## Dashboard

`GET /` serves the **Sparra Bridge Console**: a self-contained, responsive web dashboard (dark
instrument-console styling, light/dark theme, no external assets or new dependency) for driving +
monitoring the bridge from a browser — health, the `/projects` targets rail, per-target
build/reflect/resume/init/freeze triggers, a live job feed polling `GET /jobs/:id`'s already-redacted
phase log, cancel, and `/role`/`/unit` summary readouts rendered as finite holdout-safe cards (never
scrollback). It is served WITHOUT auth, like `GET /health` — a browser's top-level navigation can't
attach an `Authorization` header — but every data call the page's own client script makes is still
Bearer-gated; the token is entered once via an on-page modal and held only in `sessionStorage`.
`bridge.yaml`'s `dashboard` field (default `true`) gates the route: `false` → `404`, for operators who
want zero unauthenticated HTTP surface beyond `/health`.

The client logic lives in `conductors/http/dashboard.client.js` — a DOM-free, plain-ESM module (no
Node built-ins) that is BOTH inlined verbatim into the served page (by `handlers/dashboard.ts`, read
+ assembled once and cached) AND imported directly by `dashboard.test.ts`, so the tests exercise the
exact code the browser runs. `dashboard.html` holds only the CSS/markup and a thin real `view`
adapter (DOM writes) + boot wiring — no request-building, schema, or holdout-projection logic is
duplicated there.

## Endpoints

| Method + Path | Body | Response |
| --- | --- | --- |
| `GET /` | — (unauthenticated) | `200 text/html; charset=utf-8` (the dashboard) or `404` when `dashboard: false` |
| `GET /health` | — (unauthenticated) | `200 { ok: true }` |
| `GET /projects` | — | `200 { projects: [{ root, phase, next }] }` — one entry per allowlisted root, unless `discoverProjects:true` (see below) |
| `POST /init` | `{ root, mode?, docs? }` | `202 { jobId }` |
| `POST /freeze` | `{ root }` | `202 { jobId }` |
| `POST /plan` | `{ root, content }` | `200 { ok: true }` (403 unless `allowRemotePlan: true`) |
| `POST /build` | `{ root, fresh?, only?, step?, budget?, maxTurns? }` | `202 { jobId }` |
| `POST /reflect` | `{ root, apply? }` | `202 { jobId }` |
| `POST /resume` | `{ root }` | `202 { jobId }` |
| `POST /role` | `{ root\|workspace, kind, brief?, briefPath?, contractPath?, holdoutPath?, backend?, model?, effort?, worktree?, unitWorktree?, budget?, maxTurns? }` | `200 ParentSummary` (verbatim, holdout-redacted) |
| `POST /unit` | `{ root\|workspace, brief?, briefPath?, contractPath?, holdoutPath?, backend?, generatorModel?, evaluatorModel?, effort?, worktree?, unitWorktree?, budget?, maxTurns?, maxRounds?, contractRounds?, proceedIfNotAgreed? }` | `200 UnitProjection` (`{ outcome, contract: { agreed, rounds }, cycle? }`) |
| `GET /jobs/:id` | — | `200 Job` (`{ id, kind, root?, status, log, exitCode?, result?, createdAt }`) or `404` |
| `POST /jobs/:id/cancel` | — | `200 Job` (now `status: "canceled"`) or `404` |

Every route but `GET /health` and `GET /` (the dashboard page load) requires
`Authorization: Bearer <$SPARRA_BRIDGE_TOKEN>`; a missing/wrong token is `401` before routing details
are revealed. Every strict-schema body rejects unknown
fields (`400`). A request body over 1 MiB is `413`; malformed JSON is `400`. `/init`, `/freeze`,
`/build`, `/reflect`, `/resume`, `/plan`, `/role` (writer kinds only), and `/unit` each acquire the
per-target mutation lock (see below) — a second writer for a target already in flight gets `409`
naming the holder's `jobId`.

## Configuration (`bridge.yaml`)

`loadBridgeConfig` (`conductors/http/config.ts`) validates every field of `BridgeConfig`:

| Field | Required | Meaning |
| --- | --- | --- |
| `roots` | yes | Absolute project-root allowlist — the single source of truth for the path guard. |
| `port` | no (default `8787`) | TCP port to listen on. |
| `bind` | no | Explicit bind-address override (still refused if it resolves to a wildcard). |
| `lastNJobs` | no (default `50`) | Max jobs retained in the in-memory `JobStore`. |
| `auditLogPath` | no (default `~/.sparra/bridge-audit.log`) | Where the append-only request audit log is written. |
| `allowRemotePlan` | no (default `false`) | Whether `POST /plan` is permitted at all. |
| `dashboard` | no (default `true`) | Whether `GET /` serves the Sparra Bridge Console; `false` → `404`. |
| `discoverProjects` | no (default `false`) | Opt-in recursive project discovery for `GET /projects` (see below). |
| `discoverDepth` | no (default `3`) | Max depth the discovery walk descends below a root (root itself = `0`); validated to `0`–`8`. |

## `GET /projects` discovery

By default (`discoverProjects` unset or `false`) `GET /projects` reports exactly one entry per
allowlisted root — that root's OWN `phase`, unchanged from before this feature existed. Set
`discoverProjects: true` to instead WALK each allowlisted root (up to `discoverDepth` levels, root =
depth `0`) and report every directory that contains a `.sparra/` as its own project entry
(`{root, phase, next}`), which is useful when a root (e.g. `~/code`) is a parent of many projects
rather than a project itself. The walk stops descending once it finds a project (a nested `.sparra/`
below an already-found project is not a second entry), skips common noise directories
(`node_modules`, `.git`, `.hg`, `.svn`, `dist`, `build`, `.next`, `target`, `.venv`, `venv`,
`__pycache__`, `.cache`, `DerivedData`), NEVER follows a symlinked directory (so it can't cycle or
escape the allowlist), and caps total results at 500 for a deterministic, sorted response.

## Safety invariants

- **Tailscale-only bind.** `resolveBind` never yields a wildcard address (`0.0.0.0`/`::`) — it throws
  instead. Default: this host's Tailscale IPv4, or `127.0.0.1` when Tailscale is unavailable.
  Override via `$SPARRA_BRIDGE_BIND` or `bridge.yaml`'s `bind` (still refused if it's a wildcard).
- **Fail-closed auth.** The bridge refuses to construct a server (`createRequestListener`/`createServer`)
  with an unset/empty token, and refuses to start (`startBridge`) with an unset/empty
  `$SPARRA_BRIDGE_TOKEN` — there is no state in which it comes up allow-all. Bearer comparison is
  constant-time (`checkBearer`), including for a wrong token of the SAME length as the real one.
- **Path allowlist before any effect.** Every request-supplied path field (`root`/`workspace`,
  `briefPath`, `contractPath`, `holdoutPath`, `worktree`, `unitWorktree`, and `/plan`'s
  server-computed `docsDir`-joined write target) is resolved through `resolveWithinAllowlist` BEFORE
  any spawn, read, or write. A `root` and a `workspace` on the same request are each checked
  INDEPENDENTLY, so a caller can't smuggle an out-of-allowlist target behind an in-allowlist one.
- **Audit line, never the raw path.** Exactly one audit line is emitted per request (accepted or
  rejected), carrying the MATCHED ROUTE TEMPLATE (e.g. `/jobs/:id`, or the `<unmatched>` sentinel on
  404) and the matched allowlist ROOT ENTRY — never the raw request path or the sub-path below the
  matched root.

## Holdout wall across HTTP

`/role` and `/unit` are the load-bearing holdout-safe endpoints — they never shell out themselves,
never parse a raw role envelope, and never open a holdout file in-process:

- `/role` delegates to `conductors/core`'s `runRole`, which already redacts the runner's raw envelope
  to a `ParentSummary` via the allowlist in `conductors/core/summary.ts`. The handler returns that
  `ParentSummary` **verbatim** — it adds no field of its own.
- `/unit` delegates to `conductors/core`'s `runUnit` and projects the result down to `UnitProjection`
  — built SOLELY from already-redacted, decision-relevant fields (`outcome`, `contract.agreed`,
  `contract.rounds.length`, and — if a build cycle ran — `cycle.outcome`, `cycle.rounds.length`, and
  `cycle.finalVerdict` which is itself a `ParentSummary`). It never carries a raw round record,
  `resultText`, a `traceDir`, or a raw verdict dump.
- `holdoutPath` is forwarded to the role runner as a `--holdout <path>` ARGUMENT and is never read by
  the bridge process itself — the file is opened only inside the runner's own isolation boundary,
  same as every other conductor built on `conductors/core`.
- **No endpoint reads an arbitrary file and returns its content.** There is no file-read endpoint at
  all; `GET /jobs/:id` returns only the job's own streamed subprocess log (Sparra's own
  already-redacted phase log, not a raw file), and `GET /projects` returns only the `phase` control
  field of `.sparra/state.json` plus a static hint string — never any other state content.

## Job model

An in-memory `JobStore` (`conductors/http/jobs.ts`) tracks every triggered async run:

- **Bounded, insertion-ordered retention.** At most `bridge.yaml`'s `lastNJobs` (default 50) jobs are
  kept; the OLDEST is evicted first once the cap is exceeded. There is no disk persistence — a bridge
  restart drops job history (in-flight subprocesses are also lost, since nothing survives the process
  that spawned them).
- **Lifecycle.** `running` → `succeeded` | `failed` (phase jobs: exit code 0 vs non-zero; `/role`/
  `/unit`: no thrown error vs one) | `canceled` (via `POST /jobs/:id/cancel`). A `settled` guard on
  phase jobs prevents a late subprocess `close` event from overwriting an already-`canceled` status
  back to `failed`.
- **Cancel.** `cancelJob` invokes the job's registered cancel callback (if any) and marks it
  `canceled` regardless of whether a callback existed or threw. For a spawned phase subprocess, cancel
  sends `SIGTERM`, then escalates to `SIGKILL` after a grace period if the process hasn't exited.
  `/role`/`/unit` register a cancel callback that releases the per-target mutation lock.
- **Log.** Phase jobs stream the child's stdout+stderr into the job's `log` field verbatim — this is
  Sparra's OWN already-redacted phase log, so no extra redaction is applied, but nothing else (a
  trace dir, a verdict file) is ever surfaced through it.

## The per-target mutation lock

A single `TargetLock` (`conductors/http/spawn.ts`), shared across BOTH the phase routes and the
conductor routes (`conductors/http/register.ts` constructs one and threads it into both), admits at
most ONE in-flight mutating job per resolved target (root or workspace). This is because a project's
`.sparra/state.json` is not concurrency-safe across simultaneous writers. Concretely:

- A `/build` in flight on a root blocks a `/unit` (or another `/build`, `/reflect`, `/plan`, …) on
  that SAME root — the second request gets `409` naming the first's `jobId`, rather than racing.
- Read-only work never locks: `GET /projects`, and the read-only role kinds (`evaluator`, `reviewer`,
  `contract-evaluator`) over `/role`.
- The lock is released exactly once per job, whether it settles by completing, failing, or being
  canceled.

## Non-goals

No TLS termination (the tailnet IS the transport encryption), no multi-tenant auth (one shared
token), no public-internet exposure (the bind guard forbids it), and no file-read endpoint of any
kind — by design, so the holdout wall has no HTTP-shaped way around it.
