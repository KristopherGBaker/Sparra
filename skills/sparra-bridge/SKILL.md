---
name: sparra-bridge
description: >-
  Drive a remote Sparra build harness over its HTTP bridge (conductors/http) — a
  Tailscale-only service that lets you trigger `sparra` phases and role-runs on a Mac
  you don't have a shell on. Use whenever you need to hit the bridge's endpoints:
  check a remote build's status, list allowlisted projects, kick off / resume / reflect
  a build, run one cross-model role or a full contract→generate→evaluate unit, poll a
  job's log, or cancel one — with the holdout wall preserved across the network. Trigger
  on "the Sparra bridge", "trigger a build on the other Mac", "GET /projects", a
  `SPARRA_BRIDGE_TOKEN`/`bridge.yaml`, a `100.x`/tailnet Sparra endpoint, or a `{jobId}`
  from the bridge.
---

# sparra-bridge — client for the Sparra HTTP bridge

The bridge (`conductors/http`, served by `bin/sparra-bridge.mjs`) is a **remote conductor host**: an
agent on your tailnet POSTs to it to run Sparra on another Mac. This skill drives all of its
endpoints. The **service** side (installing/configuring the bridge) is documented in
`conductors/http/README.md` + `docs/http-bridge.md`; this skill is the **caller** side.

## Connect

The bridge binds to the host's Tailscale IPv4 (or `127.0.0.1` locally), default port **8787**.

```bash
export SPARRA_BRIDGE_URL="http://100.x.y.z:8787"   # the host's tailnet address:port
export SPARRA_BRIDGE_TOKEN="…"                       # the shared Bearer token (bridge.yaml operator's)
# sanity check — /health needs no token:
curl -s "$SPARRA_BRIDGE_URL/health"                  # -> {"ok":true}
```

A ready-made helper is bundled — `scripts/bridge.sh` (reads those two env vars, wraps auth + JSON +
poll-until-done). Source it or crib from it: `source skills/sparra-bridge/scripts/bridge.sh`.

## Two rules that shape every call

1. **Phase triggers are ASYNC.** `/init /freeze /build /reflect /resume` return `202 {jobId}`
   immediately and run in the background. You must **poll `GET /jobs/:id`** until `status` is terminal
   (`succeeded` | `failed` | `canceled`) and read its `log`. `/plan`, `/role`, `/unit`, and the
   `GET`s are synchronous (they return the result directly).
2. **The holdout wall holds over HTTP.** `/role` returns a redacted `ParentSummary` and `/unit` a
   holdout-safe projection — never a raw transcript, verdict dump, trace dir, or holdout text. There
   is **no file-read endpoint**. Do not try to fetch raw artifacts; there is no HTTP way to, by design.

## Auth + errors (every non-`/health`, non-`GET /` route)

Send `Authorization: Bearer $SPARRA_BRIDGE_TOKEN`. Handle:

| Code | Meaning | What to do |
| --- | --- | --- |
| `401` | missing/wrong token | fix the token; it's checked before routing, so 401 hides whether the route/body were even valid |
| `403` | path outside the allowlist, or `/plan` while `allowRemotePlan:false` | target a root the bridge allowlists; `/plan` needs the operator to opt in |
| `400` | malformed JSON, unknown body field (strict schema), or a bad path | fix the body; only documented fields are accepted |
| `409` | per-target mutation lock — a writer is already in flight on that root | wait for the holder (its `jobId` is named) to settle, then retry |
| `413` | body over 1 MiB | shrink it (e.g. pass `briefPath` instead of an inline `brief`) |
| `404` | unknown `jobId` (or `GET /` when `dashboard:false`) | — |

## Endpoints

Full field-by-field contract + a curl per endpoint: **[references/endpoints.md](references/endpoints.md)**.
The essentials:

**Discover (read-only, never locks)**
```bash
curl -s "$SPARRA_BRIDGE_URL/health"                                   # {ok:true}
curl -s -H "Authorization: Bearer $SPARRA_BRIDGE_TOKEN" \
  "$SPARRA_BRIDGE_URL/projects"
# {projects:[{root, phase, next}]} — one per allowlisted root unless discoverProjects:true (discovery)
```

**Trigger a phase (async → {jobId})** — `root` must be an allowlisted absolute path:
```bash
curl -s -X POST -H "Authorization: Bearer $SPARRA_BRIDGE_TOKEN" -H "Content-Type: application/json" \
  -d '{"root":"/Users/me/proj","budget":5,"maxTurns":80}' "$SPARRA_BRIDGE_URL/build"   # 202 {jobId}
# /reflect {root,apply?}  /resume {root}  /init {root,mode?,docs?}  /freeze {root}  likewise
```

**Run one role / a full unit (sync → summary; holdout-safe)**:
```bash
# one cross-model role-run (e.g. an evaluator second opinion). holdoutPath is forwarded, never read.
curl -s -X POST -H "Authorization: Bearer $SPARRA_BRIDGE_TOKEN" -H "Content-Type: application/json" \
  -d '{"workspace":"/Users/me/proj","kind":"evaluator","contractPath":"…","holdoutPath":"…","backend":"codex","model":"gpt-5.6-sol","worktree":true}' \
  "$SPARRA_BRIDGE_URL/role"          # 200 ParentSummary {verdict, weightedTotal, blocking, …}
# a full contract→generate→evaluate→decide unit:
curl -s -X POST -H "Authorization: Bearer $SPARRA_BRIDGE_TOKEN" -H "Content-Type: application/json" \
  -d '{"root":"/Users/me/proj","briefPath":"…","contractPath":"…","generatorModel":"sonnet","evaluatorModel":"gpt-5.6-sol"}' \
  "$SPARRA_BRIDGE_URL/unit"          # 200 {outcome, contract:{agreed,rounds}, cycle?}
```

**Job control**:
```bash
curl -s -H "Authorization: Bearer $SPARRA_BRIDGE_TOKEN" "$SPARRA_BRIDGE_URL/jobs/$ID"          # {status,log,exitCode?,result?}
curl -s -X POST -H "Authorization: Bearer $SPARRA_BRIDGE_TOKEN" "$SPARRA_BRIDGE_URL/jobs/$ID/cancel"  # SIGTERM→SIGKILL
```

## The job-watch loop (for the async phase endpoints)

```bash
ID=$(curl -s -X POST -H "Authorization: Bearer $SPARRA_BRIDGE_TOKEN" -H "Content-Type: application/json" \
     -d '{"root":"/Users/me/proj"}' "$SPARRA_BRIDGE_URL/build" | jq -r .jobId)
while :; do
  J=$(curl -s -H "Authorization: Bearer $SPARRA_BRIDGE_TOKEN" "$SPARRA_BRIDGE_URL/jobs/$ID")
  S=$(jq -r .status <<<"$J")
  [ "$S" = running ] || { echo "$J" | jq '{status,exitCode}'; break; }
  sleep 5
done
```
`bridge.sh` wraps this as `bridge watch <jobId>`. Poll on an interval (~5s); the `log` field grows
with Sparra's own already-redacted phase log.

## Common workflows

- **Trigger + watch a build:** `POST /build` → `bridge watch <jobId>` → on `failed`, read `.log`.
- **Cross-model second opinion:** `POST /role kind:evaluator` with a `contractPath` (+ `holdoutPath`,
  `worktree:true`) on a backend/model different from whoever generated → read the `ParentSummary`.
- **Full remote unit:** `POST /unit` with `briefPath`+`contractPath` and distinct `generatorModel`/
  `evaluatorModel` → inspect `outcome` + `contract.agreed` + `cycle.finalVerdict`.
- **Headless plan→build:** `POST /init` → (author `PLAN.md`, then `POST /plan {root,content}` iff the
  operator set `allowRemotePlan:true`) → `POST /freeze` → `POST /build` → watch. If `/plan` 403s, the
  human owns the freeze gate — coordinate out-of-band.
- **Recover a stalled run:** `POST /resume {root}` (Sparra is resumable from disk), then watch.

## Don'ts

- Don't expect raw role output/verdicts/holdout over HTTP — only summaries + the redacted phase log.
- Don't fire a second writer at a root with one in flight — you'll get `409`; wait or target another.
- Don't put secrets in URLs or logs; the token is a header only. The bridge audits every request but
  never logs the token or raw request paths.
