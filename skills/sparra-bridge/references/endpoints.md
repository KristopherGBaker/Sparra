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

## GET /jobs/:id — job status + log
```bash
curl -s $H "$SPARRA_BRIDGE_URL/jobs/$ID"
# -> {id, kind, root?, status:"running|succeeded|failed|canceled", log, exitCode?, result?, createdAt}
```
`result` is populated for `/role` (its `ParentSummary`) and `/unit` (its projection). `404` if the id
is unknown (jobs are in-memory, last-N, dropped on bridge restart). `log` is the child's
already-redacted phase log — nothing else (no trace dir/verdict file) is surfaced.

## POST /jobs/:id/cancel — kill a running job
```bash
curl -s -X POST $H "$SPARRA_BRIDGE_URL/jobs/$ID/cancel"   # -> the Job, now status:"canceled"
```
Phase subprocesses get `SIGTERM` then `SIGKILL` after a grace period; the per-target lock is released.
`404` if unknown.

## Status codes (any route)
`401` missing/wrong token (before routing) · `403` allowlist reject / `/plan` disabled · `400`
malformed JSON or unknown field or bad path · `409` per-target mutation lock (names the holder's
`jobId`) · `413` body > 1 MiB · `404` unknown job / dashboard disabled.
