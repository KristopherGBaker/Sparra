# The role-runner: Sparra's roles in interactive hosts

Driving Sparra **interactively from Claude Code or Codex** is a first-class way to use it.
Instead of handing off to the autonomous `sparra build` loop, *you* run the same
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

## Claude Code: install and run

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
(`make link setup-claude` runs all of the above; `make setup-codex` / `make setup-pi` set up the
other conductor hosts.)

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

## Codex: install and run

> **Experimental / WIP.** Codex as an interactive *conductor* lags the Claude Code path and may stay
> that way until Codex exposes better host capabilities for what the loop needs. Codex as a
> *backend* — building or judging a role, the cross-model seam — is fully supported and unaffected
> by this caveat.

One-time, install dependencies from the Sparra clone and expose both package bins on `PATH`:

```bash
npm install
npm link                       # required: provides `sparra` + `sparra-run-mcp`
```

Open an interactive Codex session in that clone and ask it to install the local plugin declared by
[`.codex-plugin/plugin.json`](../.codex-plugin/plugin.json):

```text
Install the local Sparra plugin from this checkout using .codex-plugin/plugin.json.
```

Start a **fresh Codex thread in the project you want to build**, then ask `Use sparra-loop to add
feature X`. The installed skill uses [the Codex adapter](../skills/sparra-loop/references/codex.md):
background CLI first, and blocking direct MCP only as a last resort. The backend used for each
Sparra role is still selected independently from the Codex conductor host.

### Background JSON CLI (primary)

Codex should keep its conductor responsive by launching the installed `sparra` PATH command in the
background. Each process writes one holdout-safe JSON envelope; use a distinct file per call:

```bash
sparra role run --kind generator --brief brief.md --contract contract.md \
  --backend claude --json --out generator-result.md > generator-envelope.json &
sparra eval . --worktree --contract contract.md --backend codex \
  --json > evaluator-envelope.json &
```

Resume a stopped role with the `sessionId` and `backend` from its prior envelope:

```bash
sparra role run --kind generator --brief brief.md --contract contract.md --json \
  --resume-session <id> --resume-backend <backend> > resumed-envelope.json &
```

Wait for a process to finish before parsing its JSON. `--out <file>` is the caller-selected role
artifact; redirected stdout is the separate JSON envelope. Evaluator envelopes remain
holdout-redacted.

### Direct MCP (approval-gated fallback)

The plugin's [`.codex-plugin/mcp.json`](../.codex-plugin/mcp.json) registers the
`sparra-run-mcp` PATH bin with
`tool_timeout_sec: 1800`. Codex defaults MCP tools to **60 seconds**, which kills a real
multi-minute `run_role`; every manual registration must therefore set `tool_timeout_sec` to at
least `1800`. Put the equivalent registration in the target project's `.codex/config.toml` or
your user-level `~/.codex/config.toml`:

```toml
[mcp_servers.sparra-run]
command = "sparra-run-mcp"
tool_timeout_sec = 1800
startup_timeout_sec = 30
```

Headless `codex exec` treats a direct `run_role` call as a potential **data export** and cannot
satisfy its approval gate. Approve the call in an interactive Codex session, or use the background
JSON CLI path above. If the server cannot start or `sparra-run-mcp` is missing, return to the
Sparra clone and run `npm link`.

**Picking up plugin edits.** A Codex plugin install is a cached snapshot keyed on
`.codex-plugin/plugin.json`'s semver/cachebuster version. After bumping it, run
`make update-codex-plugin` from the Sparra checkout (`codex plugin remove` + `add` of
`sparra@sparra-skills`). Then start a fresh thread; an existing thread keeps the old skills and
MCP tools loaded.

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
holdoutPath, backend, model, effort, out, maxBudgetUsd, maxTurns, allowVerify, worktree, keepWorktree,
unitWorktree, expectedHead, evalBaseRef, crossModelBaseline })`.
`worktree` (read-only judge roles — `evaluator`, `reviewer`, **and `contract-evaluator`**) runs the
eval/review/critique in a **temporary, throwaway linked git worktree** snapshotted from `workspace`'s
WIP — the same machinery as `sparra eval --worktree` (`keepWorktree` retains it), torn down after the
run.

`unitWorktree: <name>` is the **generator (writer)** counterpart and is a *different* thing: a
**PERSISTENT, named per-unit worktree** on a `sparra/<name>` branch, created on first use (deps
provisioned) and **reused across that unit's rounds** so the generator's WIP survives round N → N+1.
The worktree IS the writer's safety boundary. It's writer-only (rejected on a judge role) and
mutually exclusive with `worktree`. The result surfaces `unitWorktree: { name, dir, branch, created }`
so the conductor knows where the WIP lives; tear it down explicitly on accept/abandon with the
`remove_unit_worktree` MCP tool or `sparra role rm-worktree --name <name> [--force]` (WIP-safe —
refuses a dirty tree / unmerged branch unless forced). This makes **parallel generators run iff they
use distinct `unitWorktree` names / workspaces**, so conductors no longer hand-roll `git worktree
add` + dep provisioning or serialize. The registry (`state.json`'s `build.unitWorktrees`) is
**self-healing**: if a registry entry for a name is missing but its worktree already exists on disk
on exactly `sparra/<name>` (e.g. a registry write raced with another writer's `state.json` save), the
next `ensureUnitWorktree` for that name **adopts** it back into the registry from git ground truth
instead of failing — no manual `--workspace` resume needed to recover a dropped entry. Pass it whenever the
evaluator will **exercise** the tree (run `npm test`/builds), or a **contract-evaluator** will run
the contract's verify commands to prove they're runnable: it gives the exercise/probe writable
scratch + provisioned deps, whereas an in-place `run_role` eval stays read-only and false-blocks on
scratch writes (EPERM on `node_modules/.vite-temp` etc.). **Judge-env skip flag + capability notes:** every
judge role env — `evaluator` or `contract-evaluator` — sets **`SPARRA_JUDGE_SANDBOX=1`** (never the
generator), so every suite that spawns the real CLI / a `--import tsx` subprocess **vitest-SKIPS
visibly** via the shared `test/helpers/judgeEnv.ts` instead of a socket-`listen` EPERM; the full suite
is then EXPECTED green and a nonzero full-suite exit is a REAL signal. A Codex (OS-sandboxed) judge
also has a **known-capability matrix** injected up front (`sandboxCapabilityNotes`,
`src/build/judgeScratch.ts`) stating that behavior; for any OTHER gate that fails only because
unix-domain-socket `listen(2)` is denied by sandbox **policy** (even with a writable scratch `TMPDIR`),
it's classified **UN-RUN** (environment-blocked, not an artifact FAIL) with at most one confirming
probe — no re-proving it every round. A Claude judge (no OS sandbox) gets no notes. See
[backends → known-capability matrix](backends.md#known-sandbox-capability-matrix-surfaced-to-the-judge).

**Eval provenance (`expectedHead` / `evalBaseRef`, judge roles only).** Two controls that make a
judge run *deterministic about what it's grading* — verified **before any tokens are spent** (the
session never launches on a mismatch), on both the `worktree` and in-place paths. CLI:
`--expected-head <sha>` / `--eval-base <ref>` on `role run` and `eval`.
- `expectedHead` — the commit SHA the brief cites as the artifact to grade. The runner resolves the
  **source checkout's HEAD** (on a `worktree` run) or the **workspace HEAD** (in place) and **aborts
  with an error naming BOTH SHAs** if they differ, so a judge never silently grades a tree at a
  different commit than the brief claims. On a match it injects a provenance header stating the
  verified HEAD; on a worktree run the header also notes the graded workspace is a **detached
  WIP-snapshot commit whose parent is that HEAD** (matching `addWipWorktree`), so a judge that runs
  `git rev-parse HEAD` in its workspace and sees the snapshot SHA doesn't misread it as tampering.
- `evalBaseRef` — a base ref that **scopes the changed-files judgment to this unit**: the runner
  computes `<base>..HEAD` plus the source tree's current WIP paths and injects a scope block telling
  the judge to grade SCOPE/DEVIATION assertions **only** against those files and to treat every other
  changed file in the snapshot as foreign WIP. This fixes the failure where a worktree snapshot
  bundles another unit's uncommitted WIP and scope assertions FAIL on files that aren't the unit's.
  An unresolvable ref aborts pre-launch. Both are rejected on a writer / contract-generator.

**Verified baseline (`baselineCommand`, evaluator-only, opt-in).** When a generator's report
claims "N tests are pre-existing failures", the eval brief forwards that prose and the evaluator
may waive them — with no way to verify. `baselineCommand` closes this: together with `evalBaseRef`,
it makes the **runner** (not the generator) produce a `[VERIFIED BASELINE]` block by running the
command at the base ref's SHA in a throwaway DETACHED worktree and injecting the runner-owned result
into the evaluator's brief. The evaluator is instructed to treat **only** failures reflected in the
baseline as pre-existing; any failure absent from it is a **new regression that blocks**; prose
alone is not a verified baseline.

- Requires `evalBaseRef` (the base to compare against).
- `baselineCommand` must match a `build.verifyCommands` allowlist entry — chained/piped/subshell
  forms and non-allowlisted commands are **rejected pre-launch without spawning**.
- An infra failure AFTER the base SHA resolves (worktree creation, dep provisioning, or spawn)
  yields a `[VERIFIED BASELINE: UNAVAILABLE — <reason>]` note; the eval **proceeds** (degrade-safe)
  but the note explicitly states prose alone is not a verified manifest.
- Off by default — with no `baselineCommand`, the output is byte-for-byte unchanged.

CLI: `--baseline-command <cmd>` on `role run --kind evaluator` and `eval`.
MCP: `baselineCommand` field (evaluator-only).

Example:
```bash
sparra eval . --eval-base HEAD~5 --baseline-command "npm test"
# → runner runs `npm test` at HEAD~5 in a throwaway worktree, injects [VERIFIED BASELINE]
```

`effort` (`low|medium|high|xhigh|max`)
overrides the role's configured reasoning effort for that one call — handy to raise an
adversarial pass (e.g. `xhigh`) without editing config. `maxBudgetUsd` overrides
`build.maxBudgetUsdPerItem` for that one call (`0` = unlimited; omit to use the config cap).
`maxTurns` overrides `build.maxTurnsPerSession` for that one call — pre-size a verify-heavy role
instead of falling back to the config cap. **Unlike `maxBudgetUsd`, a `0` here is NOT an unlimited
sentinel:** only a positive integer is honored; `0`/negative/fractional (an unbounded turn cap is a
footgun) falls back to the config default, as does omitting it.
`allowVerify` (generator-only) lets an **in-place** run — one with no Sparra `build.branch`,
i.e. the interactive `/sparra-loop` path — auto-run its project's `build.verifyCommands`
(typecheck/test/build) through the same **strict** allow-hook the build loop uses on a worktree,
so each self-verify gate isn't blocked by the permission wall on a hooks-only backend (Claude
without `auto`). It reuses the existing `allowVerifyBash` decider unchanged — the opt-in only drops the branch
precondition. The allow-hook auto-approves three shapes (allow-hook only; the harness executor
stays strict on all of them):

This opt-in remains generator-only. Separately, `role run --kind contract-evaluator --worktree`
automatically gives a Claude contract-evaluator the same strict allow-hook for configured bare
commands; an in-place contract-evaluator receives no grant. Codex uses its OS sandbox and does not
claim hook enforcement.
- **Plain command:** a single `build.verifyCommands`-prefix match with no chaining / redirect /
  network / mutation / install / commit.
- **Leading literal env-var assignment:** one or more `KEY=VALUE` tokens before the core command —
  e.g. `TMPDIR=/tmp/x npm test`, `LANG=C LC_ALL=C npm run typecheck`. KEY must be a valid
  identifier; VALUE (after stripping one optional matched quote pair) must be metacharacter-free
  (no `$`, backtick, `;|&<>\`, unmatched quote, or whitespace). The core is re-validated by the
  full safety rules — no laundering through the prefix.
- **Output-shaping filter pipe:** an allow-prefix (with an optional `2>&1` / `>/dev/null` discard)
  piped into pure, non-executing text filters — `npm test 2>&1 | tail -5`, `… | grep -E "fail"`,
  `… | wc -l` — so a giant test dump can be trimmed instead of false-blocked. Each filter stage
  is validated **argument-by-argument against a per-tool allowlist** (default-deny): non-flag
  operands are capped (a file path is rejected) and only known output-shaping flags are accepted,
  so a file-reading/writing arg (`sort -o out`, `cat /etc/passwd`, `grep -f pat.txt`) is rejected.

The env-var-prefix and filter-pipe shapes compose freely: `TMPDIR=/x npm test | tail -20` strips
the prefix then routes the core through the filter-pipe check. The harness executor spawns argv
with **no shell** and stays strictly strict — env-prefix, pipe, and chain are all rejected there. It is a **no-op for
read-only roles** (only the generator's writer guard consumes it; the evaluator does not
self-verify). The **`sparra-loop` skill** is the driving playbook.

**Verify-gate advisory (`verifyGateWarning`).** When a generator role-run's contract references
one or more of the configured `build.verifyCommands` (e.g. `npm test`, `npm run typecheck`) but
self-verify is **not** enabled (no `allowVerify`, no `build.branch` / worktree boundary), those
commands are approval-blocked — the generator can only claim them "unverified". The runner
detects this **at launch time** and surfaces a `verifyGateWarning` field on the `run_role` result
payload (and emits it to the phase log) naming the specific gated commands and how to fix it:
pass `allowVerify: true` (`--verify` on the CLI) or run on a git worktree/branch boundary. This
lets the conductor act before spending a session on work that can't self-verify. The warning is
**holdout-safe** — it names only command strings from the config, never contract or holdout body
text. When self-verify IS enabled, or the contract references no configured verify command, the
field is absent.

To **iterate a role without re-reading the workspace from scratch** (e.g. feeding the
generator the evaluator's blocking points for another round), pass
`resumeSessionId` + `resumeBackend` from the previous call's returned `sessionId`/`backend`
— the runner resumes that backend session, or starts fresh (with a warning) if the backend
differs, since session ids aren't portable across backends. Every result returns `sessionId`
+ `backend` for exactly this. On the CLI, pass the same values as
`--resume-session <id> --resume-backend <backend>` to `sparra role run`.

**Provider limits / empty completions.** If a backend hits a rate/usage/session limit — or
returns a **silent empty completion** (which the Codex backend detects and stamps with an
**explicit `emptyCompletion` marker** on its result, classifying it as a limit rather than a bogus
empty result) — `run_role` **auto-falls-back** down `roles.<role>.fallback` (skipping a fallback
on an already-limited backend), mirroring the build loop. The result reflects the backend that
actually ran; if the whole chain was limited, the result carries `limitHit` (and the MCP payload
includes it). Treat `limitHit` as **retry/fall back, not a behavioral failure** — never feed it
back to the generator. **Exception — a writer whose work already landed:** if a WRITER's attempt
is an empty completion (the explicit marker, never re-inferred from `tokens===0 && !resultText`,
which a genuine limit can also exhibit) **and its files DID change**, the chain **stops without
falling back** — a second generator would clobber the landed work — and the result is
reclassified (below) as `emptyCompletion`, with the ec's `limitHit` cleared.

**Empty completion / budget death — "did the work land?" self-report.** A writer run can die at
the per-call budget cap (`maxBudgetUsd` / `build.maxBudgetUsdPerItem`) or lose its final report
emission even though the work fully landed on disk. So the writer **change-set probe runs however
the run ended**, and every writer result carries:
- **`filesChanged`** (always populated for a writer) — the count of files whose **content** differs
  from a pre-run snapshot; `>0` means work landed. Detection is **content-based, not path-set
  membership**: a file that was already dirty at run start (the normal continuation/fix-round case)
  and gets a real edit counts, while a dirty-but-untouched file — or a byte-identical rewrite —
  does not. So it is **no longer a false signal on continuation rounds**. The snapshot is bounded to
  git-reported changed files (clean untouched files are never read). Telemetry, never suppressed.
- **`emptyCompletion: true`** — empty/failed result text **but files DID change**: the work
  LANDED, only the report failed to emit. **Resume the session** (`resumeSessionId` +
  `resumeBackend` = the result's `sessionId`/`backend`) to re-emit the report, or accept the
  landed work — never re-run the item or feed it back as a FAIL.
- **`hitBudget: true`** — the run stopped on **our own** budget cap (not a provider limit, not a
  turn cap). Telemetry; resume via `sessionId` (raising the cap if warranted).

Classification is a strict first-match matrix — at most ONE of `limitHit` / `hitMaxTurns` /
`emptyCompletion` / `noProgress` is set: a genuine limit stays `limitHit` (suppressing a
co-occurring turn cap); a turn cap stays `hitMaxTurns`; an ec/budget death **with** landed work →
`emptyCompletion`; an ec **without** landed work stays `limitHit` (nothing ran — not
`noProgress`); a budget death without landed work sets no flag (`hitBudget` + `sessionId` are the
resume signal); a clean run where the writer changed nothing → `noProgress`.

**Always-readable workspace + no-progress fast-fail.** Every role's workspace and granted read
dirs are **auto-approved for reads in the guard itself** (Read/Glob/Grep with an explicit in-scope
path), independent of the resolved permission mode or a model classifier — so a writer can never
silently starve with every read denied (the failure where a generator burned tokens and produced
nothing). The holdout-read block is composed into the *same* hook as a deny-decider, so it still
wins over the read allow (a holdout/`.sparra` read is denied even though it sits in the read scope);
a pathless unfiltered `Grep`/`Glob` over the cwd is **not** auto-granted (it could surface a
cwd-resident holdout); selective Glob patterns and Grep `glob:` filters are allowed only when
their resolved matches cannot expose protected artifacts. As a backstop, a **writer that finishes without
changing any file's content** (content-compared against the pre-run snapshot, so an edit to an
already-dirty file on a continuation round is NOT falsely flagged) is marked `noProgress: true` on
the result and the MCP payload — like `limitHit`, the conductor treats it as "investigate the
brief/permissions", not a behavioral FAIL.

**Turn-cap stops.** If a role stops at the per-session turn cap (`build.maxTurnsPerSession`) with
work unfinished, the result and MCP payload carry `hitMaxTurns: true` (suppressed under a limit,
which is the real reason in that case). It is **not** a failure — the conductor should **resume the
same session** by re-calling `run_role` with `resumeSessionId` + `resumeBackend` set to this
result's `sessionId`/`backend`, mirroring how the build loop continues a turn-capped generator
across rounds rather than re-reading the workspace or pivoting.

**Turn-cap report recovery.** A generator that hits the turn cap *mid-report* forfeits its
completion-report JSON — the calibration machinery (`assertionsClaimed`) would lose it. So when a
writer dies at the turn cap with landed work (`filesChanged > 0`) but **no parseable completion
report** (empty text, prose, or incidental/wrong-shape JSON — a properly-shaped report is left
alone), the runner does the **same one-shot re-ask** it does for a budget-cap death: with
`build.jsonReask` on it resumes the same session ONCE, tightly capped (1 turn, a model-aware budget
derived from this session's own observed cost — `jsonReask.ts`'s `reaskBudgetUsd`, sized to cover
one turn on an expensive model like opus while staying materially tighter than the run's own cap)
and **text-only** (`tools: []`/`readOnly: true`/`permissionMode: "default"`/hooks cleared — tool-stripping
is the write-block for Claude; plan mode was dropped because plan mode's own prompt induces a
plan-file Write that the sandbox blocks, burning the single turn with no JSON emitted), with a report-only prompt (never the full brief). On a
usable reply the report surfaces in `resultText` and an `errors` note records the recovery, while
`hitMaxTurns` **stays true** — recovery never launders a capped run as complete, so the conductor
still resumes to finish the unfinished work. Gated to our-own-cap deaths (a co-occurring provider
limit is left to the fallback chain) and fires at most once.

**Evaluator cap-death verdict recovery.** A cap-killed **evaluator** is **resumed** once by the same
re-ask, applied to its own product — the JSON **verdict**. When the evaluator dies on **our own budget
cap OR the turn cap** (`hitBudget` / `hitMaxTurns`, never a provider `limitHit`) and its reply carries
**no parseable verdict** (`isVerdict`-shaped: a `scores` object plus `verdict`/`weightedTotal`;
incidental or wrong-shape JSON such as `{"cmd":…}` never counts and is re-asked, while a
properly-shaped verdict is left alone), the runner **resumes the same session ONCE** with
`build.jsonReask` on, tightly capped
(1 turn, the same `reaskBudgetUsd`-derived model-aware budget as the writer path) and
**text-only/read-only** (same `tools: []`/`readOnly: true`/
`permissionMode: "default"`/cleared hooks tightCap as the writer path), prompted with
`VERDICT_REASK_PROMPT` to re-emit **only** the JSON verdict block — never re-grade past the cap. On a
usable verdict-shaped reply the recovered verdict is parsed into `result.verdict` (and
`verdictPath`/`--out`) and an `errors` note records the recovery, while `hitBudget`/`hitMaxTurns`
**stay set** (cap telemetry is never laundered). A failed/disabled re-ask, or a provider-limit death
(resuming a limited session is futile — mirrors the generator rule), leaves today's **forced-fail
"no verdict parsed" verdict** so the conductor can decide a full re-eval. Fires at most once.

**Live progress (non-evaluator roles).** A backgrounded role streams its transcript to disk as it
works (`TraceWriter` appends per step). For a **non-evaluator** role the result and MCP payload
carry `traceDir` — that role is holdout-free by scope, so the conductor may tail
`<traceDir>/NN-*.md` (filtered to tool-call headers to stay cheap) for a live heartbeat between the
spawn and completion. The **evaluator's** `traceDir` is **omitted** from the MCP payload: its trace
is holdout-bearing by design, and the conductor's context feeds forward into the next generator
brief, so its only progress signal is the redacted verdict.

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
  --holdout .sparra/HOLDOUT.md --workspace . --out .sparra/verdicts/r1.md --json
```
Flags: `--kind` (generator | contract-generator | contract-evaluator | evaluator |
reviewer), `--backend`, `--model`, `--effort <low|medium|high|xhigh|max>`, `--brief <file>` |
`--brief-text "…"`, `--contract <file>`, `--holdout <file>`, `--workspace <dir>`, `--out <file>`,
`--budget <usd>` (overrides `build.maxBudgetUsdPerItem` for this run; `0` = unlimited),
`--max-turns <n>` (overrides `build.maxTurnsPerSession` for this run — a positive integer only;
`0`, negative, fractional, or non-numeric falls back to the config default, unlike `--budget`'s
`0` = unlimited, since an unbounded turn cap is a footgun),
`--json` (one machine-readable payload on stdout; human logs move to stderr),
`--resume-session <id>` and `--resume-backend <backend>` (resume a prior backend session),
`--verify` (a bare boolean — the CLI form of the `allowVerify` MCP arg: lets an **in-place
generator** auto-run `build.verifyCommands` through the strict allow-hook; no-op on `eval`, which
runs the evaluator, not a writer), `--prior-critique <file>` (repeatable, contract-evaluator
only — the CLI form of the `priorCritiquePaths` MCP arg: the RUNNER reads each file and inlines it
into the re-critique task labeled by round in the order given, so critique files under `.sparra/`
work even though the role itself can't read them), and `--prior-blocking <file>` (repeatable,
evaluator only — the CLI form of the `priorBlockingPaths` MCP arg: inlines the prior round's
ACCEPTED blocking items into the evaluator re-grade task, prefixed with the ACCEPTED-BLOCKING
instruction, so a fresh evaluator sees that the conductor accepted those blockings and does not
whipsaw-bounce an already-accepted fix or reverse an accepted out-of-scope carve-out; files under
`.sparra/` work).

**Standalone WIP eval** has a shortcut — `sparra eval [dir] --contract contract.md
[--backend codex] [--holdout .sparra/HOLDOUT.md] [--out v.md] [--budget <usd>] [--max-turns <n>]
[--json]` (alias for `role run --kind
evaluator`, with the brief defaulted) — to grade whatever you've been building, no full
plan→freeze→build.

### Shared MCP / JSON payload

MCP `run_role`, `sparra role run --json`, and `sparra eval --json` all call the same
`buildRunRolePayload` projection. The JSON forms emit exactly one parseable object to stdout and
send human progress to stderr. Non-evaluator payloads use `resultText` (never the former `result`
key) and include `errors`, including recovered reports where both the report and recovery note are
actionable. Evaluator payloads include `errors` but omit `resultText` and `traceDir`, preserving the
holdout wall. The envelope also carries identity/session, normalized verdict fields, recovery
flags, artifact paths, `tokens`, and `costUsd`; `resultDigest` is an optional worker-only summary.

`--brief` is **optional for the read-only judge roles** — `evaluator`, `reviewer`, and
`contract-evaluator` synthesize a sensible default brief from their inputs (the workspace, and for
`contract-evaluator` the `--contract`), so a config-less `run_role`/`sparra-loop` call needn't hand-write
one. Writers/proposers (`generator`, `contract-generator`) still require an explicit `--brief`, and
`contract-evaluator` needs at least a `--contract` (nothing to critique otherwise).

When `--out` / `out` captures a non-evaluator role's markdown artifact, the runner writes
from the first real markdown heading (`#` through `######`) and drops any conversational
preamble before it; headings inside fenced code blocks are ignored. If no heading is found,
the raw completion is trimmed, written with a trailing newline, and a warning is emitted so
the conductor never gets an accidental empty artifact. Evaluator `--out` is unchanged: it
writes the harness-built verdict template, not the raw model text.

**Verdicts auto-persist — no `--out` needed.** Every evaluator role-run (via `run_role`, `sparra
role run`, or `sparra eval`) automatically writes its parsed, holdout-**redacted** verdict to a
uniquely-named file under `.sparra/verdicts/role-run-<role>-<stamp>.verdict.md`, surfaced as its own
`verdictPath` result field (the MCP payload and CLI both print it), **separate** from a caller's
`--out`/`outPath`. The unique stamp means two role-runs grading the same item id never clobber each
other, even across process restarts. This leaves evaluator-side evidence (scores, failed assertions,
blocking reasons) on disk for `sparra reflect`, whose bundle rightly **excludes** the holdout-bearing
evaluator *traces* — so before, an interactive/loop cycle that didn't pass `--out` left reflect with
no evaluator evidence at all. Passing `--out` still writes that caller-chosen file too (byte-for-byte
as before); you now get **both**.

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

**Fallback provenance + same-model-grade warning.** When an evaluator role-run falls back from its
configured backend (e.g. `codex/gpt-5.5`) to a fallback (e.g. `claude/opus`) after a provider
limit, the result now reflects this precisely:
- The persisted verdict **header** names the **ACTUAL post-fallback grader** (e.g. `evaluator
  (claude/opus — fell back from codex/gpt-5.5)`) — not the originally-configured backend. Before
  this fix, the header always showed the requested config, so a conductor couldn't tell a real
  cross-model grade from a collapsed same-model grade at a glance.
- **`fallbackFrom?: { backend, model? }`** on the result/payload: present when a fallback occurred,
  names the originally-requested backend/model. Absent when no fallback happened. The top-level
  `backend`/`model` fields always carry the ACTUAL post-fallback identity (unchanged).
- **`crossModelBaseline?: { backend?, model? }`** request field (evaluator path): supply the
  generator's `{ backend, model }` from its prior `run_role` result. When supplied, the runner
  compares the evaluator's ACTUAL post-fallback identity against this baseline using the same
  equality rule as the U-6 second-opinion independence guard (`backendKey === backendKey &&
  model === model`, where absent backend defaults to `"claude"`). Sets **`sameModelGrade: true`**
  on the result/payload when they match (the cross-model gate has silently collapsed to a
  same-model grade), `false` when they differ, and leaves `sameModelGrade` `undefined` when this
  field is absent. When `true`, the verdict notes carry a "same-model grade — not cross-model"
  warning. Fully backwards-compatible — callers that don't supply `crossModelBaseline` see
  identical behavior to before.

The conductor pattern is: after a `run_role` generator call, pass the returned `backend`/`model`
as `crossModelBaseline` on the evaluator call. The evaluator payload then carries `sameModelGrade`
(and `fallbackFrom` if a fallback occurred) so you can detect a collapsed gate before accepting a
verdict.

## Cross-model is the point
Per-role backends come from `.sparra/config.yaml` (`roles.*`); override per call with
`--backend`/`backend`. The high-value pattern is an **independent second opinion**:
Claude generates, Codex evaluates (or vice versa) — the same cross-backend evaluation
Sparra supports, now one call away in an interactive session. **Pass `crossModelBaseline`** (the
generator's `backend`/`model`) on the evaluator call so the runner flags if a fallback collapsed
the independence (`sameModelGrade: true` on the payload). Without it, a fallback that swaps the
evaluator to the same model family as the generator silently degrades the adversarial gate.

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
