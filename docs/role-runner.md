# The role-runner: Sparra's roles in interactive Claude Code

Driving Sparra **interactively from a Claude Code session** is a first-class way to use
it. Instead of handing off to the autonomous `sparra build` loop, *you* run the same
adversarial, cross-model rigor one step at a time: **contract → generate → cross-model
evaluate → pivot/accept**, steering between every step, with the holdout wall enforced
for you. The **role-runner** is the seam that makes this possible, exposing Sparra's
individual roles (generator, evaluator, contract-generator/evaluator, reviewer) as
callable units so you drive the loop without reimplementing the engine. (Design + the
Claude⇄Codex planning session that produced it:
[explorations/sparra-in-claude-code.md](explorations/sparra-in-claude-code.md).)

It reuses Sparra's existing `runSession`/`AgentBackend` seam, guards, exerciser, and
verdict logic. The policy (which backend/guard/tools a role gets, and the **holdout
wall**) lives in `src/build/roleRun.ts` — above the backend, below the conductor.

## Install (for general use in Claude Code)
One-time, from the Sparra repo:
```bash
npm install
npm link                       # puts `sparra` + `sparra-run-mcp` on PATH
npm i @openai/codex-sdk        # only if you want a Codex backend (also: `codex` CLI authed at ~/.codex)
```
Register the MCP tool (user scope → available in every project; the server uses its
working directory as the project root, so launch `claude` from the project):
```bash
claude mcp add sparra-run --scope user -- sparra-run-mcp
# or pin a root per project:  claude mcp add sparra-run --scope project -- sparra-run-mcp --root "$PWD"
```
Install the driving skill (ships in Sparra's plugin marketplace):
```bash
claude plugin marketplace add "$PWD"              # assumes cwd is the Sparra repo; else use the clone path, e.g. ~/code/Sparra
claude plugin install sparra@sparra-skills        # gives you /sparra-loop
# (or, without the plugin: ln -s /path/to/Sparra/skills/sparra-loop ~/.claude/skills/sparra-loop)
```
Then, in any project, invoke **`/sparra-loop`** — it runs `sparra init`, helps set the
per-role backend/model split, optionally scaffolds a holdout, and drives the loop. (No
plugin? Use `sparra role run` / `sparra eval` directly — no `sparra init` required for
ad-hoc eval; the MCP tool likewise needs no init'd project.) Versions move fast — if a
flag differs, check `claude mcp --help` / `claude plugin --help`.

**Picking up edits to the skill/agents.** The plugin is a snapshot pinned to a git
commit, not a live read of your working tree — so changes here aren't auto-loaded.
After committing them (on the branch the marketplace resolves, i.e. `main`), run
`make update-plugin` (≡ `claude plugin marketplace update sparra-skills && claude
plugin update sparra@sparra-skills`) and start a fresh session. For rapid skill-only
iteration, symlink instead: `ln -s "$PWD/skills/sparra-loop" ~/.claude/skills/sparra-loop`.

## Two surfaces, one runner

### MCP `run_role` (interactive — recommended)
The narrow tool a Claude Code session calls. The holdout boundary is enforced
server-side: you pass a holdout **path**, never contents, and the server returns only
normalized artifacts (for the evaluator, the parsed **verdict** — never the raw
output). Wire it into Claude Code pointed at your project:

```json
{ "mcpServers": { "sparra-run": {
    "command": "node",
    "args": ["/path/to/Sparra/bin/sparra-run-mcp.mjs", "--root", "/path/to/your/project"] } } }
```

Then the model calls `run_role({ roleKind, brief|briefPath, contractPath, workspace,
holdoutPath, backend, model, effort, out, maxBudgetUsd })`. `effort` (`low|medium|high|xhigh|max`)
overrides the role's configured reasoning effort for that one call — handy to raise an
adversarial pass (e.g. `xhigh`) without editing config. `maxBudgetUsd` overrides
`build.maxBudgetUsdPerItem` for that one call (`0` = unlimited; omit to use the config cap).
The **`sparra-loop` skill** is the driving playbook.

To **iterate a role without re-reading the workspace from scratch** (e.g. feeding the
generator the evaluator's blocking points for another round), pass
`resumeSessionId` + `resumeBackend` from the previous call's returned `sessionId`/`backend`
— the runner resumes that backend session, or starts fresh (with a warning) if the backend
differs, since session ids aren't portable across backends. Every result returns `sessionId`
+ `backend` for exactly this.

**Provider limits / empty completions.** If a backend hits a rate/usage/session limit — or
returns a **silent empty completion** (`tokens: 0`, no output, which the Codex backend now
classifies as a limit rather than a bogus empty result) — `run_role` **auto-falls-back** down
`roles.<role>.fallback` (skipping a fallback on an already-limited backend), mirroring the build
loop. The result reflects the backend that actually ran; if the whole chain was limited, the
result carries `limitHit` (and the MCP payload includes it). Treat `limitHit` as **retry/fall
back, not a behavioral failure** — never feed it back to the generator.

**Always-readable workspace + no-progress fast-fail.** Every role's workspace and granted read
dirs are **auto-approved for reads in the guard itself** (Read/Glob/Grep with an explicit in-scope
path), independent of the resolved permission mode or a model classifier — so a writer can never
silently starve with every read denied (the failure where a generator burned tokens and produced
nothing). The holdout-read block is composed into the *same* hook as a deny-decider, so it still
wins over the read allow (a holdout/`.sparra` read is denied even though it sits in the read scope);
a pathless `Grep`/`Glob` over the cwd is **not** auto-granted (it could surface a cwd-resident
holdout) and defers to the permission mode. As a backstop, a **writer that finishes without
changing any file** is flagged `noProgress: true` on the result and the MCP payload — like
`limitHit`, the conductor treats it as "investigate the brief/permissions", not a behavioral FAIL.

**Turn-cap stops.** If a role stops at the per-session turn cap (`build.maxTurnsPerSession`) with
work unfinished, the result and MCP payload carry `hitMaxTurns: true` (suppressed under a limit,
which is the real reason in that case). It is **not** a failure — the conductor should **resume the
same session** by re-calling `run_role` with `resumeSessionId` + `resumeBackend` set to this
result's `sessionId`/`backend`, mirroring how the build loop continues a turn-capped generator
across rounds rather than re-reading the workspace or pivoting.

#### Subagent delegation (the conductor's pattern)
The `sparra-loop` conductor delegates **each** role-run to a **Claude subagent** (the
plugin's `sparra-role` agent, or a general subagent given the `run_role` tool) instead
of calling it from the main session. The subagent invokes the role, reads the
**already-redacted** result, and returns **only a short, decision-relevant summary** —
the evaluator's verdict (pass/fail + blocking points) or a one-paragraph
generator/reviewer digest. The raw diff and full verdict never enter the main thread,
which keeps it lean over a long loop and stacks context isolation on top of the holdout
wall. This moves only *where the tool call and its result live* (subagent vs. main
session) — the model work is unchanged, and the **role's backend stays configurable**:
a Claude subagent can still launch a Codex role via `--backend codex`/`backend`.

- **MCP reachability:** a subagent **inherits the parent session's MCP tools by
  default**, so it can call `mcp__sparra-run__run_role`. A custom agent that sets
  `tools:` must list `mcp__sparra-run__run_role` (or the wildcard `mcp__sparra-run`).
- **CLI fallback:** when the MCP tool isn't reachable (headless / interactive-auth
  edge cases), the subagent runs `sparra role run …` / `sparra eval …` via Bash.
- **Holdout discipline carries over:** the subagent never reads `HOLDOUT.md` (passes it
  by path), reads the redacted verdict (not raw output or `role-run-evaluator-*`
  traces), and returns no holdout text — so the conductor still never receives holdout.
- **Parallelism:** independent role-runs can run as concurrent subagents (e.g. evaluate
  item A while generating item B). Read-only roles parallelize freely; the caveat is
  that **two writer (generator) role-runs must not target the same workspace
  concurrently**.

### `sparra role run` (CLI — scriptable / headless)
The same runner for scripts and CI:

```bash
# A Codex evaluator grading a Claude generator's work, against a contract + holdout:
sparra role run --kind evaluator --backend codex \
  --brief brief.md --contract contract.md \
  --holdout .sparra/HOLDOUT.md --workspace . --out .sparra/verdicts/r1.md
```
Flags: `--kind` (generator | contract-generator | contract-evaluator | evaluator |
reviewer), `--backend`, `--model`, `--effort <low|medium|high|xhigh|max>`, `--brief <file>` |
`--brief-text "…"`, `--contract <file>`, `--holdout <file>`, `--workspace <dir>`, `--out <file>`,
`--budget <usd>` (overrides `build.maxBudgetUsdPerItem` for this run; `0` = unlimited).

**Standalone WIP eval** has a shortcut — `sparra eval [dir] --contract contract.md
[--backend codex] [--holdout .sparra/HOLDOUT.md] [--out v.md] [--budget <usd>]` (alias for `role run --kind
evaluator`, with the brief defaulted) — to grade whatever you've been building, no full
plan→freeze→build.

`--brief` is **optional for the read-only judge roles** — `evaluator`, `reviewer`, and
`contract-evaluator` synthesize a sensible default brief from their inputs (the workspace, and for
`contract-evaluator` the `--contract`), so a config-less `run_role`/`sparra-loop` call needn't hand-write
one. Writers/proposers (`generator`, `contract-generator`) still require an explicit `--brief`, and
`contract-evaluator` needs at least a `--contract` (nothing to critique otherwise).

## What the runner enforces (the holdout wall)
- **Only the evaluator** ever sees holdout contents — they're injected into its prompt
  by the runner. Every other ("forbid") role's brief is checked with
  `assertNoHoldoutLeak` **before any backend call** (a leak throws a *sanitized* error —
  no holdout text), and forbid roles are denied tool-reads of the holdout file **and the
  whole `.sparra/` dir** (which also holds the frozen holdout, verdicts, and evaluator
  traces) on the Claude backend, **and any holdout-bearing dir is excluded from a forbid
  role's granted read dirs** (`additionalDirectories`) on every backend — that means a
  candidate dir is dropped if it contains the `.sparra` machinery, the live `HOLDOUT.md`
  (which, with a configured `docsDir`, lives under `docsBase` *outside* `.sparra`), or the
  frozen holdout (see residuals below).
- **The evaluator may quote holdout** in its evidence/blocking/notes — so the runner
  **redacts** any verbatim holdout line from the verdict before it reaches the conductor
  (the `--out` file and the MCP payload). The conductor never receives holdout text.
- **Fail-closed:** a `--holdout` path that doesn't exist aborts the run.
- **Backend-agnostic safety:** the generator gets `writeScope=[workspace]`; every other
  role runs read-only — so Codex roles sandbox correctly too (Codex ignores hooks).
- **Verdict:** evaluator output is parsed shape-aware, scores clamped, the weighted total
  recomputed by us, and it fails below threshold even if the model says "pass".

## Holdout wall — residuals (reduced surface, not a full close)
The on-disk read surface is **shrunk**, not eliminated. Stated honestly:
- **Claude forbid roles** are blocked from on-disk holdout reads by the PreToolUse
  deny-hook (`makeHoldoutReadDecider` — denies `Read`/`Glob`/`Grep`/`Bash` targeting the
  holdout files or the `.sparra` dir) **and** now have every holdout-bearing dir excluded
  from their granted read scope (`buildReadDirs(..., { excludeHoldoutScope: true })` drops
  `ctx.root`/any extra dir that contains the `.sparra` machinery, the live `HOLDOUT.md`
  — including the `docsBase` case where it sits *outside* `.sparra` — or the frozen holdout).
  The worktree cwd still holds the full code checkout, so dropping `ctx.root` doesn't blind
  the role to the source.
- **A path-less `Grep` on Claude is uncatchable** — a search with no `path` can match
  holdout content without ever naming `.sparra`, so a path decider fundamentally can't stop
  it. The **prompt-wall** (`assertNoHoldoutLeak`, before any backend call) **and verdict
  redaction** are the guarantee here.
- **Codex ignores hooks**, so for Codex forbid roles the `.sparra` exclusion shrinks the
  surface (the holdout dir is no longer mounted as an additional read root), but when the
  run is **in-place** (`workspace === ctx.root`) the holdout under `.sparra` sits inside the
  role's own cwd — which can't be excluded (it *is* the cwd) and Codex's sandbox allows
  reading it. Sparra emits a **loud warning** in that case (it does not hard-refuse — that
  would break legitimate in-place Codex runs); the prompt-wall + verdict redaction remain
  the guarantee. To fully close it for Codex, keep the holdout outside the workspace, or run
  forbid roles on Claude.

## Cross-model is the point
Per-role backends come from `.sparra/config.yaml` (`roles.*`); override per call with
`--backend`/`backend`. The high-value pattern is an **independent second opinion**:
Claude generates, Codex evaluates (or vice versa) — the same cross-backend evaluation
Sparra supports, now one call away in an interactive session.

## Honest limits
- **Zero-setup:** `sparra eval` / `sparra role run` / the MCP `run_role` tool work in a
  repo with **no `.sparra/`** — they synthesize a default-backed context (built-in
  prompts + `defaultConfig`'s per-role backends + an in-memory greenfield store), so no
  `sparra init` is required for an ad-hoc cross-model second opinion. `sparra init` is
  **optional** — run it only to customize (per-role backends, rubric, edited prompts, a
  scaffolded holdout) or to run the full `plan → freeze → build` loop. An existing
  `.sparra/config.yaml` is always honored unchanged. The **`sparra-loop` skill** can
  drive init + the per-role backend/model split + a holdout when you want them.
- The runner is a **single-shot role**, not the full loop — it injects the contract,
  conventions (CODEBASE_MAP/Apple), and memory, but not multi-round pivot/feedback state
  (the conductor threads that between calls).
- **Codex forbid roles**: Codex ignores Claude hooks, so the on-disk `.sparra/` read-deny
  doesn't apply. The `.sparra` read-scope exclusion (above) now drops the holdout dir from
  its mounted read roots, but an **in-place** run (cwd `=== ctx.root`) leaves the holdout
  reachable inside the cwd — Sparra **warns loudly** there. The wall's *guaranteed* property
  — holdout never enters a forbid role's prompt/context, and never reaches the conductor
  (prompt-leak check + verdict redaction) — holds for all backends. To fully close the
  on-disk surface for Codex, keep the holdout outside the workspace, or run forbid roles on
  Claude. (See "Holdout wall — residuals" above.)
- **Evaluator traces** contain the holdout by design (the evaluator may see it); they
  live in a `role-run-evaluator-*` trace dir. Read **verdicts**, not evaluator traces.
