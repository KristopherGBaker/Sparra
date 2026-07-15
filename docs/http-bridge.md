# The HTTP bridge: Sparra as a remote conductor host

`conductors/http` is a small `node:http` service — a **remote conductor host** — that lets a
Tailscale-connected agent trigger `sparra` phases and role-runs on a Mac it doesn't have a shell on.
It's built entirely on `conductors/core` (the same host-agnostic `runRole`/`runUnit` the Pi conductor
uses); this doc covers the HTTP-specific surface. Setup/on-ramp: [`conductors/http/README.md`](../conductors/http/README.md).

## Install (one command)

`make bridge-install` (equivalently `node bin/sparra-bridge-setup.mjs install`) is the whole install:
it auto-derives the LaunchAgent plist from this checkout (node path, a `PATH` env var carrying node's
bin dir so the `tsx` re-exec resolves under launchd's bare environment, `bin/sparra-bridge.mjs`,
working directory, `~/Library/Logs` log paths, `~/.sparra/bridge.yaml` config), generates a crypto-random
Bearer **token**, seeds `~/.sparra/bridge.yaml` once (never clobbering an existing one), writes the
plist mode `0600`, and loads it via `launchctl`. The token is printed **once** on stdout as a
ready-to-paste `export SPARRA_BRIDGE_TOKEN=<token>` line — it lives only in the plist otherwise, never
in a log. A re-install preserves that token; `make bridge-install ROTATE=1` (or `install
--rotate-token`) rotates it. `make bridge-update` restarts, `make bridge-remove` uninstalls (keeping
`bridge.yaml`). Full walkthrough + `bridge.yaml` fields: [`conductors/http/README.md`](../conductors/http/README.md).

## Dashboard

`GET /` serves the **Sparra Bridge Console**: a self-contained, responsive web dashboard (dark
instrument-console styling, light/dark theme, no external assets or new dependency) for driving +
monitoring the bridge from a browser — the `/projects` targets rail, a live job feed, cancel, and
`/role`/`/unit` summary readouts rendered as finite holdout-safe cards (never scrollback). The feed's
lifecycle status is driven by ONE `GET /events?since=<cursor>` poll per 1.5s tick covering EVERY tracked
job (not a per-job sweep) — see [`GET /events`](#get-events--cursor-delta-lifecycle-feed) below; the
currently-selected job's detail stage (its already-redacted streaming phase log + the full
`pendingDecisions` projection, neither of which `/events` carries) is polled separately, via
`GET /jobs/:id`, and ONLY while that job is running. It is served WITHOUT auth, like `GET /health` — a
browser's top-level navigation can't attach an `Authorization` header — but every data call the page's
own client script makes is still Bearer-gated; the token is entered once via an on-page modal and held
only in `sessionStorage`. `bridge.yaml`'s `dashboard` field (default `true`) gates the route: `false`
→ `404`, for operators who want zero unauthenticated HTTP surface beyond `/health`.

**Two operating modes.** A header segmented switch (`conduct` | `full cycle`) chooses the operator's
posture; the choice persists across reloads (`localStorage`). The default is **conduct**:

- A full-width **Conduct Deck** sits above the three columns, bound to the selected target. It carries a
  target selector (chips synced with the rail selection), a large mono multi-line prompt (the hero of
  the page, autofocused on entry), a subtle pipeline strip — `decompose ▸ contract ▸ generate ▸
  evaluate ▸ decide` — that names what one line drives, the conduct controls (brain `hybrid`|`llm`, max
  units, the `auto`/`commit`/`merge`/`land`/`push` toggles forming a landing-tier chain where each
  deeper toggle implies every shallower one (`push` implies `land` implies `merge` implies `commit`),
  budget, max turns), the
  primary `conduct` launch button (disabled with a reason until a target is selected and the prompt is
  non-blank), and a secondary runId + `resume run` affordance. Each target keeps its own prompt draft
  across selection switches.
- Target cards in the rail slim to identity + status (name, path, phase chip, `next ▸`) and act as
  selectors for the deck — no per-card action buttons.

Switching to **full cycle** hides the deck and restores the full per-card action surface — per-target
build/reflect/resume/init/freeze triggers, `unit`, the role-kind select + run-role row, budget/maxTurns
steppers, and the `fresh` toggle. The conduct controls live only in the deck (not duplicated here).
Every action reachable in one mode is reachable in exactly one of the two. The jobs feed and detail
stage (job list, terminal, pending-decision cards, `/role`/`/unit` readouts) are present in both modes.

The client logic lives in `conductors/http/dashboard.client.js` — a DOM-free, plain-ESM module (no
Node built-ins) that is BOTH inlined verbatim into the served page (by `handlers/dashboard.ts`, read
+ assembled once and cached) AND imported directly by `dashboard.test.ts`, so the tests exercise the
exact code the browser runs. `dashboard.html` holds only the CSS/markup and a thin real `view`
adapter (DOM writes) + boot wiring — no request-building, schema, holdout-projection, or
change-detection logic is duplicated there. The client is also the single source of truth for "what is
displayed": its pure render-plan helpers (`planJobFeed`/`applyJobFeed`, `planStage`/`applyStage`) diff
the previously-displayed snapshot against the next, so an identical 1.5s poll writes NOTHING to the DOM
(no blink). The elapsed-time counter lives in its own node updated via `textContent` only, the `rise`
entrance animation fires just for a first-appearing job row, and the log pane is rewritten only on a
real log-content change (following the tail if scrolled to the bottom, else preserving the reader's
offset).

## Endpoints

| Method + Path | Body | Response |
| --- | --- | --- |
| `GET /` | — (unauthenticated) | `200 text/html; charset=utf-8` (the dashboard) or `404` when `dashboard: false` |
| `GET /health` | — (unauthenticated) | `200 { ok: true }` |
| `GET /projects` | — | `200 { projects: [{ root, phase, next }] }` — one entry per allowlisted root, unless `discoverProjects:true` (see below) |
| `GET /jobs` | — | `200 [Job, …]` — every tracked job NEWEST-FIRST; each entry is the `GET /jobs/:id` projection MINUS `log` (`{ id, kind, root?, status, exitCode?, result?, createdAt, pendingDecisions? }`). Jobs are in-memory since bridge boot (last-N, dropped on restart) — see below |
| `POST /init` | `{ root, mode?, docs? }` | `202 { jobId }` |
| `POST /freeze` | `{ root }` | `202 { jobId }` |
| `POST /plan` | `{ root, content }` | `200 { ok: true }` (403 unless `allowRemotePlan: true`) |
| `POST /build` | `{ root, fresh?, only?, step?, budget?, maxTurns? }` | `202 { jobId }` |
| `POST /reflect` | `{ root, apply? }` | `202 { jobId }` |
| `POST /resume` | `{ root }` | `202 { jobId }` |
| `POST /conduct` | fresh: `{ root, prompt, auto?, mode?, maxUnits?, concurrency?, budget?, maxTurns?, commit?, merge?, land?, push? }` · resume: `{ root, resume, auto?, commit?, merge?, land?, push? }` (EXACTLY ONE of `prompt`\|`resume`) | `202 { jobId }` |
| `POST /jobs/:id/decision` | `{ seq, answer, note? }` | `200 { ok, seq, chosen }` or `404`/`409`/`400` |
| `POST /role` | `{ root\|workspace, kind, brief?, briefPath?, contractPath?, holdoutPath?, backend?, model?, effort?, worktree?, unitWorktree?, budget?, maxTurns? }` | `200 ParentSummary` (verbatim, holdout-redacted) |
| `POST /unit` | `{ root\|workspace, brief?, briefPath?, contractPath?, holdoutPath?, backend?, generatorModel?, evaluatorModel?, effort?, worktree?, unitWorktree?, budget?, maxTurns?, maxRounds?, contractRounds?, proceedIfNotAgreed? }` | `200 UnitProjection` (`{ outcome, contract: { agreed, rounds }, cycle? }`) |
| `GET /jobs/:id` | — | `200 Job` (`{ id, kind, root?, status, log, exitCode?, result?, createdAt, pendingDecisions? }`) or `404` |
| `POST /jobs/:id/cancel` | — | `200 Job` (now `status: "canceled"`) or `404` |
| `GET /events` | — | `200 { events: [BridgeEvent, …], cursor }` — cursor-delta feed across ALL jobs (see below) |

Every route but `GET /health` and `GET /` (the dashboard page load) requires
`Authorization: Bearer <$SPARRA_BRIDGE_TOKEN>`; a missing/wrong token is `401` before routing details
are revealed. Every strict-schema body rejects unknown
fields (`400`). A request body over 1 MiB is `413`; malformed JSON is `400`. `/init`, `/freeze`,
`/build`, `/reflect`, `/resume`, `/conduct`, `/plan`, `/role` (writer kinds only), and `/unit` each
acquire the per-target mutation lock (see below) — a second writer for a target already in flight gets
`409` naming the holder's `jobId`.

## Conduct over the bridge + remote decisions

`POST /conduct` triggers `sparra conduct "<prompt>"` as an async job exactly like the other phase
triggers: the argv is built server-side from the validated body only (`conduct <prompt> [--auto]
[--brain <mode>] [--max-units N] [--concurrency N] [--budget N] [--max-turns N]
[--commit] [--merge] [--land] [--push]`), the child runs with `cwd` = the guarded root, and it holds the per-target lock
while it runs. Numeric fields are validated to CLI-meaningful values (positive integers for
`maxUnits`/`concurrency`/`maxTurns`, a non-negative number for `budget`), and `mode` ∈ `hybrid|llm` — an
out-of-range value is a `400`, not a spawn.

**Landing tiers (`commit`/`merge`/`land`/`push`).** The optional booleans `commit`/`merge`/`land`/`push`
are forwarded verbatim as `--commit`/`--merge`/`--land`/`--push` (the CLI owns the full
`--push`⇒`--land`⇒`--merge`⇒`--commit` implication; the bridge synthesizes none of them), so a
remote/dashboard-triggered run can self-land its accepted units onto their `sparra/<name>` branch
(`commit`), integrate onto the run branch (`merge`), fast-forward the target's default branch to the run
branch's tip (`land`), and push that landed default branch to its upstream remote (`push`) — instead of
being report-only. `land`/`push` additionally require `conduct.landToDefault`/`conduct.push` to be `true`
in the TARGET project's own `sparra.config`/`bridge.yaml`-adjacent config; the CLI enforces this with a
hard error, which surfaces through the normal job-failure path (`GET /jobs/:id` → `failed` with the
CLI's stderr) — the bridge does **not** read or re-implement that gate itself.

**Resume (`resume: "<runId>"`).** The SAME endpoint resumes a crashed/interrupted run: send
`{ root, resume: "<runId>" }` (plus any of `auto`/`commit`/`merge`/`land`/`push`) and the argv becomes
`conduct --resume <runId> [--auto] [--commit] [--merge] [--land] [--push]`. EXACTLY ONE of
`prompt`|`resume` must be present — both or neither is a `400`. A resume body may carry ONLY
`root, resume, commit, merge, land, push, auto`; any run-shaping field
(`mode`/`maxUnits`/`concurrency`/`budget`/`maxTurns`) alongside `resume` is a fail-closed `400` (the
CLI's `--resume` accepts only `--commit|--merge|--land|--push|--auto` — and re-evaluates the
`land`/`push` config gates over the persisted run state). The `runId` is validated as a safe
single-segment id (`isSafeRunId`) BEFORE any lock or spawn — an unsafe id (`..`, a separator, a leading
`-`) is a `400` with zero side effects. A resumed run re-announces its run-START line, so
`pendingDecisions` on `GET /jobs/:id` and `POST /jobs/:id/decision` work identically to a fresh run. The
`bridge.sh` client exposes both:
`bridge conduct <root> <prompt> [--commit] [--merge] [--land] [--push] [extra-json]` and
`bridge resume <root> <runId> [--commit] [--merge] [--land] [--push] [--auto]`.

A conduct run parks its important decisions (U2's decision engine) under
`.sparra/conduct/<runId>/decisions/`. The bridge learns the run's `runId`/`runDir` by parsing a stable
run-START line the conduct phase prints at run start, then surfaces the still-PARKED decisions on
`GET /jobs/:id` as a `pendingDecisions` array — projected to exactly
`{ seq, unit, kind, question, options, default, expiresAt }` (nothing else from the request file
crosses; the job stays `running` while parked). Answer one remotely with:

```bash
curl -s -X POST $H $J -d '{"seq":1,"answer":"finalize"}' "$SPARRA_BRIDGE_URL/jobs/$JOB_ID/decision"
```

The answer is validated against the parked request's `options` (off-menu → `400`), resolved
**in-process** via the same engine functions the CLI's `conduct --decide` uses (`writeDecisionAnswer` +
`applyFileDecisionToRunState`) — the bridge never shells out and never reimplements the
`<seq>.decision.json` write. An unknown job/run/seq is `404`; a second answer for a resolved seq is
`409` (the first answer stands). The audit line for a decision records only the `seq` + the chosen
option key + result — never the free-text `note`. This is holdout-safe by construction: the decision
requests/answers and job projections are all `ParentSummary`-derived, and no endpoint reads a run
artifact beyond the decisions dir + the `run.json` projection.

## `GET /events` — cursor-delta lifecycle feed

`GET /events?since=<cursor>` returns everything NEW across ALL tracked jobs since the caller's last
cursor, in ONE request — a lighter alternative to a client enumerating jobs and polling each one's
`GET /jobs/:id` individually. The bridge-only `EventLog` (`conductors/http/events.ts`) is an in-memory,
bounded ring (`~1000` events) fed by a single shared instance: `JobStore` emits into it, and this route
reads from the SAME instance, so nothing observed by one is invisible to the other. It also persists to
`eventsLogPath` (append-only JSONL, tailable) and re-seeds the ring + its id counter from that file at
startup, so a cursor a client already holds keeps working across a bridge restart. A direct (non-bridge)
CLI run never emits here — this feed is bridge-only, like `bridge-audit.log`.

Response shape: `{ events: BridgeEvent[], cursor: number }` — `cursor` is the highest event id emitted
so far; pass it back as `since` on your next poll (an omitted/non-numeric/negative `since` is treated as
`0`, returning everything currently retained). `cursor` never regresses, even once old events have
scrolled out of the ring past `ringSize`.

Three event types (`type` field):
- **`job_started`** — `{ jobId, kind, root? }`, emitted when `JobStore.createJob` registers a job.
- **`job_done`** — `{ jobId, status, root? }` (`status` ∈ `succeeded|failed|canceled`), emitted on
  `finish`/`cancelJob`.
- **`decision_parked`** — `{ jobId, root?, runId, seq, question?, kind? }`, emitted when a `conduct`
  job parks a judgment point. The conduct child prints a `conduct: decision-parked <runId> <seq>` line
  (runId + seq **only**, never free text); the bridge's stdout observer trusts only those two values and
  reads `question`/`kind` from the run's realpath-guarded `<seq>.request.json` file (fail-closed — no
  recorded run dir, a foreign runId, or an unreadable/guard-rejected request emits nothing). The
  `question` is the parked request's own `ParentSummary`-derived text, holdout-safe by construction. It
  flows on `GET /events` like the other two (and each `(runId, seq)` is emitted at most once per job).

Every field beyond the log-assigned `id`/`ts` is defensively bounded before it ever reaches the ring or
the file — `jobId` is char-classed + length-capped exactly like the audit log's job ids, and every other
string field is control-character-stripped and length-capped — so no unbounded or secret-smuggling
value can ride an event, holdout-safe by construction like every other bridge surface.

```bash
curl -H "Authorization: Bearer $TOKEN" "http://$HOST:$PORT/events?since=0"
```

## Configuration (`bridge.yaml`)

`loadBridgeConfig` (`conductors/http/config.ts`) validates every field of `BridgeConfig`:

| Field | Required | Meaning |
| --- | --- | --- |
| `roots` | yes | Absolute project-root allowlist — the single source of truth for the path guard. |
| `port` | no (default `8787`) | TCP port to listen on. |
| `bind` | no | Explicit bind-address override (still refused if it resolves to a wildcard). |
| `lastNJobs` | no (default `50`) | Max jobs retained in the in-memory `JobStore`. |
| `auditLogPath` | no (default `~/.sparra/bridge-audit.log`) | Where the append-only request audit log is written. |
| `eventsLogPath` | no (default `~/.sparra/bridge-events.jsonl`) | Where the append-only lifecycle events feed (backing `GET /events`) is written; read back at startup to seed the in-memory ring so cursors survive a restart. |
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
  instead. Default: this host's Tailscale IPv4 (probed via `tailscale ip -4`, trying the PATH binary
  then the App Store/standalone `.app` bundle and Homebrew CLI locations, accepting only a well-formed
  IPv4), or `127.0.0.1` when Tailscale is unavailable. Override via `$SPARRA_BRIDGE_BIND` or
  `bridge.yaml`'s `bind` (still refused if it's a wildcard).
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
  already-redacted phase log, not a raw file) plus — for a conduct job — the `pendingDecisions`
  projection read solely from the run's `decisions/` dir (each field `ParentSummary`-derived by
  construction), and `GET /projects` returns only the `phase` control field of `.sparra/state.json`
  plus a static hint string — never any other state content.

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

## Troubleshooting the LaunchAgent

The bridge runs under `launchd`, which starts services with a **bare environment** (`PATH` =
`/usr/bin:/bin:/usr/sbin:/sbin`, no login shell). Two symptoms follow from that; both are handled by
the installer/resolver, but if you see them on an older plist or a hand-edited config:

- **`env: node: No such file or directory` in `~/Library/Logs/sparra-bridge.err.log`, service
  crash-loops with `last exit code = 127`.** The bridge re-execs `tsx` via a `#!/usr/bin/env node`
  shebang, and launchd's bare `PATH` omits an nvm/Homebrew node. Fix: the rendered plist sets a `PATH`
  env var (running node's bin dir prepended to the system PATH). Re-run `make bridge-install` to
  regenerate a plist that has it.
- **Health works on `127.0.0.1:8787` but the tailnet IP refuses the connection** — `lsof -nP
  -iTCP:8787 -sTCP:LISTEN` shows it bound to `127.0.0.1`. Auto-bind fell back to loopback because the
  GUI (Mac App Store / standalone) Tailscale CLI can't reach its helper from a launchd session and so
  can't report the tailnet IP. Fix: set `bind:` to this host's Tailscale IPv4 explicitly in
  `~/.sparra/bridge.yaml` (find it with `/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4`),
  then `make bridge-update`. The open-source/Homebrew `tailscaled` doesn't have this limitation.

Quick end-to-end check: `curl http://<tailnet-ip>:8787/health` → `{"ok":true}`, and
`curl -H "Authorization: Bearer $SPARRA_BRIDGE_TOKEN" http://<tailnet-ip>:8787/projects` lists your
allowlisted roots.
