# The role-runner — Sparra's roles in interactive Claude Code

Sparra's build loop is autonomous. The **role-runner** exposes its individual roles
(generator, evaluator, contract-generator/evaluator, reviewer) as a callable seam, so
you can drive Sparra's *adversarial, cross-model* rigor from inside an interactive
Claude Code session — without reimplementing the engine. (Design + the Claude⇄Codex
planning session that produced it: [explorations/sparra-in-claude-code.md](explorations/sparra-in-claude-code.md).)

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
claude plugin marketplace add /path/to/Sparra
claude plugin install sparra@sparra-skills        # gives you /sparra-loop
# (or, without the plugin: ln -s /path/to/Sparra/skills/sparra-loop ~/.claude/skills/sparra-loop)
```
Then, in any project, invoke **`/sparra-loop`** — it runs `sparra init`, helps set the
per-role backend/model split, optionally scaffolds a holdout, and drives the loop. (No
plugin? Use `sparra role run` directly after `sparra init`.) Versions move fast — if a
flag differs, check `claude mcp --help` / `claude plugin --help`.

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
holdoutPath, backend, model, out })`. The **`sparra-loop` skill** is the driving playbook.

### `sparra role run` (CLI — scriptable / headless)
The same runner for scripts and CI:

```bash
# A Codex evaluator grading a Claude generator's work, against a contract + holdout:
sparra role run --kind evaluator --backend codex \
  --brief brief.md --contract contract.md \
  --holdout .sparra/HOLDOUT.md --workspace . --out .sparra/verdicts/r1.md
```
Flags: `--kind` (generator | contract-generator | contract-evaluator | evaluator |
reviewer), `--backend`, `--model`, `--brief <file>` | `--brief-text "…"`, `--contract
<file>`, `--holdout <file>`, `--workspace <dir>`, `--out <file>`.

**Standalone WIP eval** has a shortcut — `sparra eval [dir] --contract contract.md
[--backend codex] [--holdout .sparra/HOLDOUT.md] [--out v.md]` (alias for `role run --kind
evaluator`, with the brief defaulted) — to grade whatever you've been building, no full
plan→freeze→build.

## What the runner enforces (the holdout wall)
- **Only the evaluator** ever sees holdout contents — they're injected into its prompt
  by the runner. Every other ("forbid") role's brief is checked with
  `assertNoHoldoutLeak` **before any backend call** (a leak throws a *sanitized* error —
  no holdout text), and forbid roles are denied tool-reads of the holdout file **and the
  whole `.sparra/` dir** (which also holds the frozen holdout, verdicts, and evaluator
  traces) on the Claude backend (see residual below).
- **The evaluator may quote holdout** in its evidence/blocking/notes — so the runner
  **redacts** any verbatim holdout line from the verdict before it reaches the conductor
  (the `--out` file and the MCP payload). The conductor never receives holdout text.
- **Fail-closed:** a `--holdout` path that doesn't exist aborts the run.
- **Backend-agnostic safety:** the generator gets `writeScope=[workspace]`; every other
  role runs read-only — so Codex roles sandbox correctly too (Codex ignores hooks).
- **Verdict:** evaluator output is parsed shape-aware, scores clamped, the weighted total
  recomputed by us, and it fails below threshold even if the model says "pass".

## Cross-model is the point
Per-role backends come from `.sparra/config.yaml` (`roles.*`); override per call with
`--backend`/`backend`. The high-value pattern is an **independent second opinion**:
Claude generates, Codex evaluates (or vice versa) — the same cross-backend evaluation
Sparra supports, now one call away in an interactive session.

## Honest limits
- It needs the project's `.sparra/` (config, prompts, rubric) — run `sparra init` once. The
  **`sparra-loop` skill drives this for you**: it runs init, helps set the per-role
  backend/model split (cross-model), and can scaffold a holdout, before driving the loop.
- The runner is a **single-shot role**, not the full loop — it injects the contract,
  conventions (CODEBASE_MAP/Apple), and memory, but not multi-round pivot/feedback state
  (the conductor threads that between calls).
- **Codex forbid roles**: Codex ignores Claude hooks, so the on-disk `.sparra/` read-deny
  doesn't apply; its sandbox still allows reading mounted dirs. This matches the base
  build loop's exposure (a Codex generator can read the repo, which contains `.sparra/`).
  The wall's *guaranteed* property — holdout never enters a forbid role's prompt/context,
  and never reaches the conductor (prompt-leak check + verdict redaction) — holds for all
  backends; only the on-disk read-deny is Claude-only. To fully close it for Codex, keep
  the holdout outside the workspace, or run forbid roles on Claude.
- A broad `Grep`/`Glob` with no path (scanning the whole workspace, when `.sparra/` lives
  under it) is a residual the exact-path/dir deny can't catch on the Claude side either;
  the prompt-wall + redaction remain the primary guarantees.
- **Evaluator traces** contain the holdout by design (the evaluator may see it); they
  live in a `role-run-evaluator-*` trace dir. Read **verdicts**, not evaluator traces.
