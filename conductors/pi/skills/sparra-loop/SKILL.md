---
name: sparra-loop
description: >-
  Conduct Sparra's adversarial build loop from Pi: draft a contract, then drive
  contract → generate → cross-model evaluate → decide with the holdout wall intact,
  using the sparra_role tool / the /sparra-loop command / the sparra CLI. Use when the
  user wants to run or resume a Sparra build, get a cross-model second opinion, or grade
  an artifact against a contract (and optional holdout) — so they don't have to hand-wire
  every flag.
---

# sparra-loop — Pi conductor

You are the **conductor** on a Pi host. Rigor and isolation live in Sparra's runner — you orchestrate
the roles; you do not judge or redact yourself. The roles run on their configured backend (Claude,
Codex, …) via the `sparra` CLI, regardless of which model conducts.

## One safety rule (never violate)

**Never read `HOLDOUT.md` / `.sparra/HOLDOUT.md` / any holdout file. Pass only its PATH to the
evaluator, consume only the redacted verdict summary, never inspect evaluator traces, and never send
holdout text to a generator or into another summary.** Every evaluator verdict is persisted
already-redacted under `.sparra/verdicts/` — refer to the returned `verdictPath`, never raw output.

The `sparra_role` tool and the `sparra … --json` surface enforce this structurally (they return only
the holdout-safe summary). Your job is to not defeat it: don't re-read the raw diff, full verdict, or
holdout into your own context.

## Your three surfaces (prefer the first two)

- **`sparra_role` tool** — runs ONE role in isolation and returns ONLY the summary
  (verdict / weightedTotal / passThreshold / blocking / verdictPath / flags — never the raw
  transcript or holdout). Call it once per role-run. Params: `args` (the sparra CLI argv, e.g.
  `["role","run","--kind","generator","--brief",…,"--contract",…]` or `["eval",".","--contract",…]`),
  optional `sparraBin`, and `holdoutPath` (forwarded as `--holdout <path>` — path only, never read).
- **`/sparra-loop` command** — drives a whole single-unit cycle (contract negotiation → generate →
  cross-model evaluate → decide) in one call when you already have a brief + contract file:
  `/sparra-loop --brief <path> --contract <path> [--holdout <path>] [--generator-model m]
  [--evaluator-model m] [--backend b] [--contract-rounds n] [--max-rounds n] [--proceed-if-not-agreed]`.
  It prints a holdout-safe per-round report and a final `outcome`.
- **`sparra` CLI** (`bash`) — for setup and anything the tool/command don't cover
  (`sparra init`, `sparra status`, drafting/reading the contract & brief files, `sparra build …`).

## Cross-model gate (the point of a conductor)

Run the **generator and the evaluator on DIFFERENT models** — a same-model "pass" is not independent
evidence and the loop rejects it (`sameModelGrade` → not accepted). Sensible defaults:
generator `claude/sonnet`, evaluator + contract-evaluator `claude/opus` (cross-tier), or
`claude` generator / `codex` evaluator (cross-backend). Confirm the chosen backends are authenticated
before relying on the split; if one is unavailable, fall back to a same-*family* different-*model*
grader rather than collapsing to the same model.

## The flow

1. **Understand the target.** Read the request; if there's a repo, `sparra status` / look around.
   Ad-hoc runs work without `sparra init` — only init if the user wants the full checkpointed engine
   or persistent config (`.sparra/config.yaml`).
2. **Draft a contract** — checkable assertions the artifact must satisfy: the feature's success
   criteria, plus existing-project no-regression, conventions, and docs-sync clauses. Write it to a
   file (you author this WITH the user; it is not holdout). Optionally author hidden checks at a
   `HOLDOUT.md` path — write it, then only ever pass its PATH onward.
3. **Negotiate the contract** — run `contract-evaluator` (via `sparra_role` with
   `args:["role","run","--kind","contract-evaluator","--contract",<path>,"--out",<critique path>]`,
   on the evaluator model) until its summary's `contractAgreed` is true or rounds run out; thread each
   round's `outPath` back as `--prior-critique <path>`. (`/sparra-loop` does this for you.)
4. **Generate** — `sparra_role` generator (`--kind generator --brief … --contract …`) on the
   generator model, in the target workspace.
5. **Evaluate** — `sparra_role` evaluator (`eval <dir> --contract …`, different model), passing
   `holdoutPath` when there is one, and `--worktree` when it must run tests/builds.
6. **Decide** — PASS with an independent grade → accept (optionally review). FAIL → feed back only the
   `blocking` lines + failed-assertion evidence to the next generator round; pivot after repeated
   failure on the same point. A `sameModelGrade` pass → get a distinct grader, don't accept it.
7. **Report** — summaries only: verdict, weightedTotal/passThreshold, blocking count, `verdictPath`,
   outcome. Never paste the raw role output.

For multiple independent units, run several full cycles — keep each in a DISTINCT workspace/worktree
(never two writers in one workspace).

## Recovery (from the summary flags, before changing the artifact)

`limitHit` → provider limited: retry / change model, not a behavioral FAIL. `hitMaxTurns` /
`emptyCompletion` with landed work → resume the same session, don't re-run from scratch.
`noProgress` → check the brief/permissions. `verifyGateWarning` → enable verification
(`--verify` / a worktree) before trusting verify claims. `sameModelGrade` → change grader.
