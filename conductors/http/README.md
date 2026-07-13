# conductors/http — the Sparra HTTP bridge

A **remote conductor host**: a small `node:http` service you run on a Mac that already has Sparra
projects on it, so a Tailscale-connected agent (a laptop, a phone shell, another machine's Claude/
Codex session) can trigger `sparra` phases and role-runs on THIS machine over the network — without
opening it to the public internet. Built entirely on `conductors/core` (the same host-agnostic
`runRole`/`runUnit` used by the Pi conductor); this package is just the HTTP transport + safety spine
around it.

**Driving it from an agent?** The caller side is packaged as the **`sparra-bridge` skill**
(`skills/sparra-bridge/`) — an operational guide over every endpoint plus a `scripts/bridge.sh`
client (auth + JSON + poll-until-done). This README is the operator/service side.

## The safety model

One rule, four layers — every layer must hold for a request to do anything:

1. **Tailscale-only bind.** The bridge NEVER binds a public/wildcard address (`0.0.0.0`/`::`) —
   `resolveBind` throws rather than falling through to one. By default it binds this host's Tailscale
   IPv4 (or `127.0.0.1` if Tailscale isn't running); a caller can pin an explicit address via
   `$SPARRA_BRIDGE_BIND` or `bridge.yaml`'s `bind`, but a wildcard is refused there too. So the only
   way to reach it at all is over your tailnet (or localhost).
2. **Bearer token.** Every route except `GET /health` and `GET /` (the dashboard page itself — a
   browser's top-level navigation can't attach a header) requires `Authorization: Bearer <token>`,
   checked in constant time against `$SPARRA_BRIDGE_TOKEN`. The bridge refuses to even start if that
   env var is unset or empty (fail-closed) — there is no allow-all mode. Every DATA call the dashboard's
   own client script makes is still Bearer-gated like any other caller.
3. **Path allowlist.** Every request-supplied `root`/`workspace` (and every path field it implies —
   `briefPath`, `contractPath`, `holdoutPath`, `worktree`, `unitWorktree`) must resolve INSIDE one of
   `bridge.yaml`'s `roots` before any spawn/read/write happens. Anything outside is rejected (400/403)
   before the target is ever touched.
4. **Holdout wall across HTTP.** `/role` and `/unit` never return raw role output, a trace directory,
   or holdout text — only the same redacted `ParentSummary` (or a projection of it) that `conductors/
   core`'s `toParentSummary` allowlist already produces for every other conductor. `holdoutPath` is
   forwarded to the runner as an argument and is never opened by the bridge itself. **No endpoint
   returns holdout text or raw role output**, full stop.

`/plan` is additionally **opt-in**: even with a valid token and an allowlisted root, it's a 403 unless
the target's `bridge.yaml` sets `allowRemotePlan: true` — the human-freeze gate stays meaningful for a
remote caller by default.

The bridge speaks plain HTTP (no TLS of its own) — the Tailscale tunnel IS the transport encryption;
don't expose the bound address through anything else (a port-forward, a public tunnel, etc.).

## Setup

### 1. Generate a token

```bash
openssl rand -hex 32   # → the value for $SPARRA_BRIDGE_TOKEN below
```

Keep it secret — it's the only thing standing between "anyone on my tailnet" and "an authenticated
remote agent."

### 2. Write `bridge.yaml`

Copy the example and edit the allowlist (see [`bridge.yaml.example`](bridge.yaml.example) for every
field):

```bash
mkdir -p ~/.sparra
cp conductors/http/bridge.yaml.example ~/.sparra/bridge.yaml
$EDITOR ~/.sparra/bridge.yaml   # set `roots` to your real project directories
```

`$SPARRA_BRIDGE_CONFIG` overrides the path if you'd rather keep it elsewhere. Every field
(`roots`, `port`, `bind`, `lastNJobs`, `auditLogPath`, `allowRemotePlan`, `dashboard`,
`discoverProjects`, `discoverDepth`) is commented in the example; the two most worth knowing about
beyond `roots`/`port`: `lastNJobs` bounds how many jobs the in-memory store retains (oldest evicted
first), and `auditLogPath` is where the append-only request audit log lands (default
`~/.sparra/bridge-audit.log`). `dashboard` (default `true`) controls whether `GET /` serves the web
console below — set it `false` for zero unauthenticated HTTP surface beyond `GET /health`.
`discoverProjects` (default `false`) turns `GET /projects` from "one entry per allowlisted root" into
a recursive walk that reports every Sparra project FOUND under each root (useful when a root like
`~/code` is a parent of many projects, not a project itself); `discoverDepth` (default `3`; validated
to `0`–`8` at config load — a negative, non-integer, or out-of-range value is REJECTED, never clamped)
bounds how deep that walk goes. See [`docs/http-bridge.md`](../../docs/http-bridge.md) for
the full discovery semantics (skip-list, symlink handling, result cap).

### 3. Install the launchd agent

The Makefile wraps the whole lifecycle:

```bash
make bridge-install   # first run copies the plist template to ~/Library/LaunchAgents and stops;
                      # edit EVERY placeholder (node path, bin path, working directory, the token —
                      # `make bridge-token` generates one — config path, log paths, an agent-backend
                      # credential), then re-run to load. Refuses to load while placeholders remain.
make bridge-update    # restart the service (unload + load) to pick up new code/config
make bridge-status    # launchctl status
make bridge-logs      # tail the stdout/stderr logs named in the plist
make bridge-remove    # unload + delete the plist
```

Or by hand:

```bash
cp conductors/http/com.sparra.bridge.plist.example ~/Library/LaunchAgents/com.sparra.bridge.plist
$EDITOR ~/Library/LaunchAgents/com.sparra.bridge.plist   # replace every placeholder
launchctl load ~/Library/LaunchAgents/com.sparra.bridge.plist
```

Check it's up: `launchctl list | grep com.sparra.bridge`, and tail the log paths you configured.
To stop/uninstall: `launchctl unload ~/Library/LaunchAgents/com.sparra.bridge.plist` (and delete the
plist if you're done with it for good).

Prefer to run it in a foreground terminal first (to watch for startup errors) before installing the
plist: `SPARRA_BRIDGE_TOKEN=<token> node bin/sparra-bridge.mjs`.

## Dashboard

`GET /` serves the **Sparra Bridge Console** — a self-contained, holdout-safe web dashboard for
driving + monitoring the bridge (health, per-target phase triggers with budget/maxTurns/fresh
controls, a live job feed with the redacted phase log, and `/role`/`/unit` summary readouts) from a
browser over your tailnet, phone included. It needs no token to LOAD (a browser's top-level
navigation can't attach an `Authorization` header), but every data call the page itself makes is
Bearer-gated exactly like a `curl` caller — enter your token once via the on-page modal; it's held in
`sessionStorage`, never persisted to disk. Set `bridge.yaml`'s `dashboard: false` to disable it
entirely (→ 404), for zero unauthenticated HTTP surface beyond `GET /health`. The page is a single
static asset — no external script/style/image references, no new dependency — built from
`conductors/http/dashboard.client.js` (the DOM-free API/controller logic, unit-tested in
`dashboard.test.ts`) inlined into `conductors/http/dashboard.html` at serve time.

## Endpoints

| Method + Path | Body | Response |
| --- | --- | --- |
| `GET /` | — (unauthenticated) | `200 text/html` (the dashboard) or `404` when `dashboard: false` |
| `GET /health` | — (unauthenticated) | `200 { ok: true }` |
| `GET /projects` | — | `200 { projects: [...] }` |
| `POST /init` | `{ root, mode?, docs? }` | `202 { jobId }` |
| `POST /freeze` | `{ root }` | `202 { jobId }` |
| `POST /plan` | `{ root, content }` | `200 { ok: true }` (opt-in, see below) |
| `POST /build` | `{ root, fresh?, only?, step?, budget?, maxTurns? }` | `202 { jobId }` |
| `POST /reflect` | `{ root, apply? }` | `202 { jobId }` |
| `POST /resume` | `{ root }` | `202 { jobId }` |
| `POST /conduct` | fresh: `{ root, prompt, auto?, mode?, maxUnits?, concurrency?, budget?, maxTurns?, commit?, merge? }` · resume: `{ root, resume, auto?, commit?, merge? }` (EXACTLY ONE of `prompt`\|`resume`) | `202 { jobId }` |
| `POST /role` | `{ root\|workspace, kind, ... }` | `200 ParentSummary` |
| `POST /unit` | `{ root\|workspace, ... }` | `200 UnitProjection` |
| `GET /jobs/:id` | — | `200 Job` (conduct jobs carry `pendingDecisions`) or `404` |
| `POST /jobs/:id/cancel` | — | `200 Job` or `404` |
| `POST /jobs/:id/decision` | `{ seq, answer, note? }` | `200 { ok, seq, chosen }` (answer a parked conduct decision) |

Full field-by-field request/response shapes: [`docs/http-bridge.md`](../../docs/http-bridge.md).

One authenticated example per endpoint (`$HOST`/`$PORT` = wherever you bound; `$TOKEN` =
`$SPARRA_BRIDGE_TOKEN`):

`GET /` — the dashboard console (unauthenticated load; see [Dashboard](#dashboard) above):

```bash
curl "http://$HOST:$PORT/"
```

`GET /health` — unauthenticated liveness check:

```bash
curl "http://$HOST:$PORT/health"
```

`GET /projects` — read-only status (phase + next-step hint) for every allowlisted root:

```bash
curl -H "Authorization: Bearer $TOKEN" "http://$HOST:$PORT/projects"
```

`POST /init` — scaffold `.sparra/` for a project:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"root":"/Users/example/code/my-app"}' \
  "http://$HOST:$PORT/init"
```

`POST /freeze` — lock the plan as build input:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"root":"/Users/example/code/my-app"}' \
  "http://$HOST:$PORT/freeze"
```

`POST /plan` — write `PLAN.md` remotely (only when the TARGET's `bridge.yaml` sets
`allowRemotePlan: true`; 403 otherwise):

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"root":"/Users/example/code/my-app","content":"# Plan\n\nBuild X."}' \
  "http://$HOST:$PORT/plan"
```

`POST /build` — run the autonomous build loop:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"root":"/Users/example/code/my-app","fresh":false}' \
  "http://$HOST:$PORT/build"
```

`POST /reflect` — propose prompt edits from build traces:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"root":"/Users/example/code/my-app"}' \
  "http://$HOST:$PORT/reflect"
```

`POST /resume` — continue whatever phase `.sparra/state.json` says is next:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"root":"/Users/example/code/my-app"}' \
  "http://$HOST:$PORT/resume"
```

`POST /conduct` — drive the headless conductor from one prompt (decompose → per-unit
contract/generate/evaluate/decide); poll the job, then answer any parked decision it surfaces:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"root":"/Users/example/code/my-app","prompt":"add a /health endpoint","budget":5}' \
  "http://$HOST:$PORT/conduct"
```

`POST /jobs/:id/decision` — poll `GET /jobs/$JOB_ID`; a `pendingDecisions:[{seq,…}]` entry means the
conduct run is parked — answer it (the `answer` must be one of that decision's `options`):

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"seq":1,"answer":"finalize"}' \
  "http://$HOST:$PORT/jobs/$JOB_ID/decision"
```

`POST /role` — one holdout-safe role-run (`generator`/`evaluator`/`reviewer`/`contract-generator`/
`contract-evaluator`); returns `ParentSummary` verbatim, never raw output:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"root":"/Users/example/code/my-app","kind":"evaluator","contractPath":"contract.md"}' \
  "http://$HOST:$PORT/role"
```

`POST /unit` — the full contract → generate → evaluate → decide cycle for one work item:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"root":"/Users/example/code/my-app","briefPath":"brief.md"}' \
  "http://$HOST:$PORT/unit"
```

`GET /jobs/:id` — poll a triggered job's status/log/result:

```bash
curl -H "Authorization: Bearer $TOKEN" "http://$HOST:$PORT/jobs/$JOB_ID"
```

`POST /jobs/:id/cancel` — cancel a running job (SIGTERM, then SIGKILL after a grace period):

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" "http://$HOST:$PORT/jobs/$JOB_ID/cancel"
```

## What it is NOT

Not a public API, not TLS-terminated, not a multi-tenant service — one operator's tailnet, one
token, one machine's allowlisted projects. If you need broader access control, put it behind
something that provides that and keep this bridge itself unchanged.
