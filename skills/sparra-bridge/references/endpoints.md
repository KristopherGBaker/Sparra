# Sparra HTTP bridge — full endpoint reference

Every endpoint the bridge serves, with exact body fields, responses, and a curl. Base URL =
`$SPARRA_BRIDGE_URL` (host tailnet IP:port, default `:8787`). Auth header (all but `GET /health` and
`GET /`): `-H "Authorization: Bearer $SPARRA_BRIDGE_TOKEN"`. Bodies are strict JSON — an unknown field
is `400`. This mirrors `conductors/http/register.ts` + `docs/http-bridge.md`; if they ever disagree,
the code wins.

Legend: `H=` the auth header, `J=` `-H "Content-Type: application/json"`.

## GET / — dashboard (unauthenticated)
`200 text/html` (the Sparra Bridge Console) or `404` when `bridge.yaml` has `dashboard:false`. For
humans in a browser, not for programmatic use.

## GET /health — liveness (unauthenticated)
```bash
curl -s "$SPARRA_BRIDGE_URL/health"        # -> {"ok":true}
```

## GET /projects — list allowlisted projects (read-only, no lock)
```bash
curl -s $H "$SPARRA_BRIDGE_URL/projects"
# -> {"projects":[{"root":"/abs/path","phase":"build","next":"sparra build"}, …]}
```
One entry per allowlisted root, UNLESS the target's `bridge.yaml` sets `discoverProjects: true` — then
each root is walked (up to `discoverDepth`, default 3) and every Sparra project found under it (a dir
containing `.sparra/`) is its own entry instead. `phase` is that project's `.sparra/state.json` phase;
`next` is a static hint string. No other state content is exposed.

## POST /init — scaffold `.sparra/` (async)
Body: `{ root, mode?, docs? }` — `mode` ∈ `greenfield|existing`; `docs` = docs subfolder.
`202 {jobId}`. Runs `sparra init`.
```bash
curl -s -X POST $H $J -d '{"root":"/abs/proj","mode":"existing"}' "$SPARRA_BRIDGE_URL/init"
```

## POST /freeze — lock the plan as build input (async)
Body: `{ root }`. `202 {jobId}`. Runs `sparra freeze`. The deliberate human gate — expose remotely
only intentionally.

## POST /plan — write PLAN.md (opt-in)
Body: `{ root, content }` — `content` is the full PLAN.md text. `200 {ok:true}`. **`403` unless the
operator set `allowRemotePlan:true`.** The server computes the write target itself
(`<root>/<docsDir>/PLAN.md`) and re-checks it against the allowlist; it writes exactly that one file.
```bash
curl -s -X POST $H $J -d '{"root":"/abs/proj","content":"# PLAN\n…"}' "$SPARRA_BRIDGE_URL/plan"
```

## POST /build — run the autonomous build loop (async)
Body: `{ root, fresh?, only?, step?, budget?, maxTurns? }`
- `fresh` (bool) — ignore prior build state.
- `only` (string) — build just this item id.
- `step` (string) — pause points, e.g. `"contract,round,commit,item"`.
- `budget` (number) — USD cap per item (overrides config; `0` = unlimited).
- `maxTurns` (number) — turn cap per session.
`202 {jobId}`. Runs `sparra build`. Poll the job; the `log` is Sparra's phase log.
```bash
curl -s -X POST $H $J -d '{"root":"/abs/proj","budget":5,"maxTurns":80}' "$SPARRA_BRIDGE_URL/build"
```

## POST /reflect — self-improvement pass (async)
Body: `{ root, apply? }` — `apply` (bool) actually applies proposed prompt edits. `202 {jobId}`.

## POST /resume — continue the current phase from disk (async)
Body: `{ root }`. `202 {jobId}`. Recovery-friendly: Sparra resumes wherever it left off.

## POST /conduct — headless conductor from one prompt, OR resume a run (async)
Fresh run body: `{ root, prompt, auto?, mode?, maxUnits?, concurrency?, budget?, maxTurns?, commit?, merge? }`
Resume body: `{ root, resume, auto?, commit?, merge? }`
**EXACTLY ONE of `prompt` | `resume` must be present** (both or neither → `400`).
- `prompt` (string) — the one-line goal; decompose → per-unit contract → generate → evaluate → decide.
- `resume` (string) — a `<runId>` to continue a crashed/parked run IN PLACE (`conduct --resume <runId>`).
  Validated as a safe single-segment id BEFORE any lock/spawn — an unsafe id (`..`, separator, leading
  `-`) → `400`, zero side effects. A resume body may carry ONLY `root, resume, commit, merge, auto`; any
  run-shaping field (`mode`/`maxUnits`/`concurrency`/`budget`/`maxTurns`) alongside `resume` → `400`.
- `auto` (bool) — never park a decision (the brain decides everything).
- `commit`/`merge` (bool) — forwarded verbatim as `--commit`/`--merge` (self-land accepted units; the CLI
  owns `--merge` ⇒ `--commit`, the bridge synthesizes neither). Valid on both fresh and resume runs.
- `mode` ∈ `hybrid | llm` — conductor-brain mode (`--brain`); fresh-run only.
- `maxUnits`/`concurrency`/`maxTurns` — positive integers; `budget` — non-negative number (`0` =
  unlimited); all fresh-run only.
`202 {jobId}`. Runs `sparra conduct`; argv is built server-side from these fields only. Holds the
per-target lock (fresh OR resume). Poll the job — a conduct job (including a resumed one, which
re-announces) surfaces `pendingDecisions` (see below).
```bash
curl -s -X POST $H $J -d '{"root":"/abs/proj","prompt":"add a health endpoint","budget":5}' "$SPARRA_BRIDGE_URL/conduct"
curl -s -X POST $H $J -d '{"root":"/abs/proj","prompt":"add a health endpoint","commit":true}' "$SPARRA_BRIDGE_URL/conduct"
curl -s -X POST $H $J -d '{"root":"/abs/proj","resume":"conduct-2026-07-13T06-44-18","merge":true}' "$SPARRA_BRIDGE_URL/conduct"
```

## POST /jobs/:id/decision — answer a parked conduct decision (sync, holdout-safe)
Body: `{ seq, answer, note? }` — `answer` MUST be one of the parked request's `options`. `200 {ok, seq,
chosen}`. Resolves IN-PROCESS via the same engine the CLI's `conduct --decide` uses (no shell-out).
`404` unknown job/run/seq · `409` the seq is already resolved (first answer stands) · `400` `answer`
not in the request's `options`. The audit line records only `{seq, decision, result}` — never `note`.
```bash
curl -s -X POST $H $J -d '{"seq":1,"answer":"finalize"}' "$SPARRA_BRIDGE_URL/jobs/$ID/decision"
```

## POST /role — run ONE role (sync, holdout-safe)
Body: `{ root|workspace, kind, brief?, briefPath?, contractPath?, holdoutPath?, backend?, model?,
effort?, worktree?, unitWorktree?, budget?, maxTurns? }`
- `kind` ∈ `generator | evaluator | reviewer | contract-generator | contract-evaluator`.
- `workspace` (or `root`) — the artifact/working dir; both are allowlist-checked INDEPENDENTLY.
- `brief`/`briefPath`, `contractPath` — the task + the "done" contract. Prefer `briefPath` (avoids 413).
- `holdoutPath` — hidden checks; forwarded to the runner as `--holdout`, **never read by the bridge**.
- `backend`/`model`/`effort` — pick who plays the role (the cross-model seam). `worktree:true` gives a
  read-only judge a writable WIP snapshot (needed if it runs tests). `unitWorktree:"<name>"` runs a
  generator in a persistent named worktree.
`200` = the runner's `ParentSummary` VERBATIM: `{ roleKind, backend, model, ok, verdict?,
weightedTotal?, passThreshold?, blocking?, failedAssertions?, sameModelGrade?, contractAgreed?,
verdictPath?, unitWorktree?, tokens, costUsd, errors, … }`. Writer kinds (`generator`,
`contract-generator`) take the mutation lock (`409` on contention); read-only kinds don't.
```bash
curl -s -X POST $H $J -d '{"workspace":"/abs/proj","kind":"evaluator","contractPath":"/abs/proj/.sparra/contract.md","holdoutPath":"/abs/proj/.sparra/HOLDOUT.md","backend":"codex","model":"gpt-5.6-sol","worktree":true}' "$SPARRA_BRIDGE_URL/role"
```

## POST /unit — full contract→generate→evaluate→decide (sync, holdout-safe)
Body: `{ root|workspace, brief?, briefPath?, contractPath?, holdoutPath?, backend?, generatorModel?,
evaluatorModel?, effort?, worktree?, unitWorktree?, budget?, maxTurns?, maxRounds?, contractRounds?,
proceedIfNotAgreed? }`. Note the split `generatorModel`/`evaluatorModel` (the cross-model gate).
`maxRounds` bounds the build cycle; `contractRounds` the negotiation; `proceedIfNotAgreed` builds even
if the contract never reaches AGREED.
`200` = `UnitProjection`: `{ outcome, contract:{ agreed, rounds }, cycle?:{ outcome, rounds,
finalVerdict? } }` — `finalVerdict` is itself a `ParentSummary`. No raw round records.
```bash
curl -s -X POST $H $J -d '{"root":"/abs/proj","briefPath":"…","contractPath":"…","generatorModel":"sonnet","evaluatorModel":"gpt-5.6-sol","contractRounds":3}' "$SPARRA_BRIDGE_URL/unit"
```

## GET /jobs — list tracked jobs (newest-first)
Returns every tracked job as a JSON array, NEWEST-FIRST by `createdAt`. Each entry is the SAME
holdout-safe per-job projection `GET /jobs/:id` returns MINUS the `log` (the listing stays light; the
log is detail-only). Conduct jobs still carry their `pendingDecisions`. Jobs are in-memory since bridge
boot (last-N, dropped on restart) — the dashboard rehydrates its feed from this on load. `bridge jobs`.
```bash
curl -s $H "$SPARRA_BRIDGE_URL/jobs"
# -> [{id, kind, root?, status, exitCode?, result?, createdAt, pendingDecisions?}, …]  (no log)
```

## GET /jobs/:id — job status + log
```bash
curl -s $H "$SPARRA_BRIDGE_URL/jobs/$ID"
# -> {id, kind, root?, status:"running|succeeded|failed|canceled", log, exitCode?, result?, createdAt}
```
`result` is populated for `/role` (its `ParentSummary`) and `/unit` (its projection). A `/conduct` job
also carries `pendingDecisions: [{seq, unit, kind, question, options, default, expiresAt}]` — the
still-PARKED decisions of its run (answer them with `POST /jobs/:id/decision`); the job stays `running`
while parked. `404` if the id is unknown (jobs are in-memory, last-N, dropped on bridge restart). `log`
is the child's already-redacted phase log — nothing else (no trace dir/verdict file) is surfaced.

## POST /jobs/:id/cancel — kill a running job
```bash
curl -s -X POST $H "$SPARRA_BRIDGE_URL/jobs/$ID/cancel"   # -> the Job, now status:"canceled"
```
Phase subprocesses get `SIGTERM` then `SIGKILL` after a grace period; the per-target lock is released.
`404` if unknown.

## GET /events — cursor-delta lifecycle feed (across ALL jobs)
```bash
curl -s $H "$SPARRA_BRIDGE_URL/events?since=0"
# -> {"events":[{"id":1,"ts":"…","type":"job_started","jobId":"…","kind":"build","root":"…"}, …],"cursor":1}
```
A lighter alternative to polling `GET /jobs/:id` per job per tick: learn everything new across every
tracked job in one request. `since` (default `0`; a non-numeric/negative value is also treated as `0`)
is the last `cursor` you saw; pass it back next poll — `cursor` in the response is the new value to
save, and it never regresses even once old events have scrolled out of the bounded in-memory ring.
Event `type` ∈ `job_started | job_done | decision_parked` — `decision_parked` is reserved (typed) but
not yet emitted by any route. Still poll the specific job's `GET /jobs/:id` for its `log` and
`pendingDecisions`; this feed carries only the lifecycle transition, not the log content.

## Status codes (any route)
`401` missing/wrong token (before routing) · `403` allowlist reject / `/plan` disabled · `400`
malformed JSON or unknown field or bad path · `409` per-target mutation lock (names the holder's
`jobId`) · `413` body > 1 MiB · `404` unknown job / dashboard disabled.
