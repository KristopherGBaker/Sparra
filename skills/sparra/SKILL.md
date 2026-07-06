---
name: sparra
description: >-
  Drive and debug Sparra — the autonomous build harness (collaborative plan → freeze
  → autonomous build → reflect, over pluggable Claude/Codex agent backends). Use this
  whenever the user is working with Sparra: running, resuming, or kicking off a `sparra
  build`; setting up or editing `.sparra/config.yaml`; choosing per-role backends/models;
  configuring the iOS/macOS exerciser (xcodebuildmcp/XcodeGen); authoring a `HOLDOUT.md`;
  doing cross-backend (Codex builds, Claude judges) runs; or diagnosing a run from its
  artifacts (state.json, contracts, verdicts, traces, memory.md). Trigger on mentions of
  "sparra", a `.sparra/` directory, "the build harness", a stalled/failed/over-budget
  build item, contract negotiation, GAN pivots, or an iOS Simulator build via Sparra —
  even if the user doesn't say "skill".
---

# Working with Sparra

Sparra is a long-running autonomous build harness. The human plans collaboratively, then
hands off to an autonomous loop that builds one work item at a time — each negotiated
against a checkable "done" contract and graded by an adversarial evaluator that *actually
runs the artifact*. It runs on pluggable agent backends (Claude + Codex).

**The mental model that explains everything:** the filesystem is the source of truth and
the only shared state. Every phase reads inputs from disk and writes outputs to disk, so
runs are inspectable, diffable, and resumable from any point. When something looks wrong,
you debug by *reading the artifacts*, not by guessing.

## Find the repo and its docs first

The authoritative docs live in the Sparra repo. Locate it and read the relevant doc
before doing anything non-trivial — don't reconstruct behavior from memory:

```bash
SPARRA_REPO="$(dirname "$(dirname "$(readlink "$(command -v sparra)")")")"  # repo root via the linked bin
ls "$SPARRA_REPO/docs"   # phases.md build-loop.md backends.md configuration.md ios.md
```
- `docs/phases.md` — the workflow (orient→plan⇄prototype→freeze→build→reflect), greenfield vs brownfield
- `docs/build-loop.md` — contract negotiation, exercising, GAN pivots, holdout wall, sandbox-first, budgets, memory
- `docs/backends.md` — the `AgentBackend` seam, Claude + Codex, per-role + cross-backend evaluation
- `docs/configuration.md` — every knob, the `.sparra/` layout, resuming
- `docs/ios.md` — Apple-platform builds (xcodebuildmcp, XcodeGen, the mandatory launch screen)

If `sparra` isn't on PATH, run via `node "$SPARRA_REPO/bin/sparra.mjs"`.

## Driving a run

The commands, in order. Nothing advances toward building except the human-run `freeze`.

```bash
sparra init            # detect greenfield vs existing; scaffold .sparra/
sparra orient          # existing projects only → CODEBASE_MAP.md
sparra plan            # collaborative interview → PLAN.md
sparra prototype "…"   # optional throwaway spike → FINDINGS.md
sparra freeze          # the human gate — locks PLAN.md (+ CODEBASE_MAP/HOLDOUT) as build input
sparra build           # the autonomous generator↔evaluator loop
sparra measure [dir]   # run measure.command → parse JSON metrics → diff vs baseline (compare-only; --set-baseline; --worktree)
sparra reflect [--traces <glob-or-dir>] # propose prompt edits from build or role-run traces (--apply to accept)
sparra reflect --upstream [--done <ids>] [--wontdo <ids>] [--reason "…"] [--clear]  # list/triage per-finding harness reflections in ~/.sparra/reflections (SPARRA_HOME); --clear archives ALL
sparra prompts status  # 3-way drift vs defaults: same/stale(newer default)/local(your edit)/conflict/drifted/missing
sparra prompts sync    # adopt STALE only (safe); --role <r> or --all force-overwrite (discards edits); --dry-run
# A `stale` (newer-default) prompt is surfaced once on the build AND `sparra eval`/`role run`/`sparra-loop` paths.
sparra prompts audit   # concision + readability review of role prompts (cut redundancy, format for fast parsing — not terseness) → prompts/audit/<role>.md; --apply tightens in place behind a coverage guard PLUS an independent prompt-audit-verifier pass (re-derives the original's rules; skips if any are missing)
sparra status          # where am I / what's next
sparra new "<title>"   # next feature, same project: archive this cycle → fresh plan
sparra clean           # prune stale sparra worktrees/branches (dry-run; --yes acts, --force unmerged)
sparra resume          # continue whatever phase, from .sparra/state.json
```

`--root <dir>` targets a project; otherwise the cwd is used. Re-running `sparra build`
resumes — passed/abandoned/budget_exceeded items are skipped.

**Starting the next feature in the same project:** run `sparra new ["<title>"]`. It archives
the finished cycle's working set (PLAN, frozen input, workitems, contracts, verdicts, reviews,
the run's traces) to `.sparra/cycles/<NNNN>-<slug>/`, carries forward `memory.md` /
`CHANGELOG.md` / `CODEBASE_MAP.md` / config / calibration / prompts, writes a fresh `PLAN.md`,
and returns to `plan`. Then it's `plan → freeze → build` again (no `--fresh` needed). Without
it, you'd manually clear the working set and remember `build --fresh` — and `build` now warns
if the frozen plan changed but the run wasn't re-decomposed.

**Run each project in its OWN directory.** Do not nest a Sparra work dir inside another
Sparra project (e.g. building inside the Sparra repo, or under a parent that has its own
`PLAN.md`/`.sparra/`). Read-only roles can read up the tree and get confused by the outer
project's plan. The example `run.sh` scripts also derive the repo path from their own
location, so don't copy them out of the repo — drive the global `sparra` directly, or pass
an out-of-repo work dir.

## Configuring (`.sparra/config.yaml`)

Seeded on `init`; edit and re-run (picked up live). Full knob list: `docs/configuration.md`.
The few that matter most:

- **`roles.<role>: { backend?, model, effort?, baseUrl?, apiKey?, skills?, sandbox? }`** — `backend`
  defaults to `claude`; set `codex` to run that role on Codex. `baseUrl` points a codex role at a
  local OpenAI-compatible endpoint (LM Studio/Ollama). `sandbox` (`workspace-write` default |
  `danger-full-access`) widens a **write** role's Codex OS sandbox for native toolchains (e.g.
  `xcodebuild`); full access is honored **only on a git worktree/branch** boundary, else downgraded
  with a loud warning. Roles: orienter, planner, **decomposer**,
  prototyper, contractGenerator, contractEvaluator, generator, evaluator, **reviewer**, reflector.
- **`roles.generatorLocal`** + work-item **`gen: "local"`** — hybrid builds: tagged items build on
  a local model, the rest on `generator`. Decomposer tags trivial items when `generatorLocal` is set;
  edit tags in `items.json`. See `docs/backends.md`.
- **Work-item `relevantPaths`** — optional array of repo-relative files the decomposer names as most
  relevant to an item; the generator/contract-generator then prefer the CODEBASE_MAP section(s)
  covering those seams (plus a listing of the files) over a blind head-slice of the map. Paths only —
  no file bodies. Omitted → the head-slice (unchanged). Editable in `items.json`. See `docs/build-loop.md`.
- **`build.maxBudgetUsdPerItem` / `maxTokensPerItem` / `zeroCostTokenCap`** — per-item caps;
  crossing USD/tokens halts the item `BUDGET_EXCEEDED` and the run continues. `0` = no cap.
  `zeroCostTokenCap` applies only when the USD cap is active, cost reports zero/unknown, and
  `maxTokensPerItem` is off. The standalone role surfaces override the USD cap per call:
  `run_role`'s `maxBudgetUsd` / `role run`/`eval`'s `--budget <usd>` (omit = config cap;
  `0` = unlimited).
- **eval provenance (`expectedHead` / `evalBaseRef`, judge roles only)** — `run_role`'s
  `expectedHead`/`evalBaseRef` (CLI `role run`/`eval`'s `--expected-head <sha>` / `--eval-base <ref>`)
  make a judge deterministic about *what* it grades, verified **before any tokens are spent**.
  `expectedHead` aborts (naming both SHAs) if the graded HEAD — the source checkout's on a
  `worktree` run, the workspace's in place — isn't the commit the brief cites, so a judge never
  grades the wrong tree; a match injects a provenance header (on a worktree run it notes the
  workspace is a detached WIP-snapshot commit whose parent is that HEAD, so a differing in-workspace
  `git rev-parse HEAD` isn't misread as tampering). `evalBaseRef` scopes the changed-files judgment
  to `<base>..HEAD` + the source tree's WIP so a snapshot carrying another unit's uncommitted WIP
  doesn't fail SCOPE/DEVIATION assertions on foreign files — instead of relying on prose to pin
  the commit or exclude foreign WIP. Both are rejected on a writer/contract-generator. See `docs/role-runner.md`.
- **`run_role` / `role run` `out` capture** — non-evaluator artifacts are normalized from the
  first markdown heading (heading-less output is trimmed + warned); evaluator `out` remains the
  harness verdict template. Every evaluator run ALSO **auto-persists** its redacted verdict to a
  uniquely-named `.sparra/verdicts/role-run-evaluator-<stamp>.verdict.md` (surfaced as `verdictPath`,
  separate from `out`/`outPath`) with no `out` needed. See `docs/role-runner.md`.
- **`build.autoRestart`** + **`roles.*.fallback`** — for **unattended** builds: on a *provider*
  rate/usage limit (not your budget caps), switch to a cross-provider `fallback` model or wait
  the window out, then retry the same round (not charged against `maxRoundsPerItem`). Off by
  default. Bounded by `maxWaitSec`/`maxRestarts`; checkpoints before sleeping (resume via
  `sparra build`); `sparra status` shows it *paused … resumes ~HH:MM*. See `docs/build-loop.md`.
- **`build.escalateAfterRounds`** + **`roles.<generator>.escalation`** — opt-in **quality**
  escalation (vs the *limit*-triggered `fallback`): after N FAILED rounds on an item, its
  generator switches to the stronger `escalation` role for the remaining rounds — per-item,
  one-way, new session on the switch, memory note appended. Blocked and limit-retried rounds
  don't count; the escalated role's own `fallback` still applies on a limit. `0` = off (default).
- **`build.assertionEscalateAfter`** — per-**assertion** feedback escalation (K, default `2`; `0`
  disables). Once the SAME contract assertion FAILS K consecutive rounds, its next **patch**
  feedback UNCAPS that assertion's evidence and prepends a **diagnose-first** instruction naming the
  id — a register between a plain patch and a full GAN pivot. Pairs with **error-biased evidence
  truncation** (over-cap evidence keeps the error-bearing tail, not a blind head-slice). Blocked/
  all-un-run rounds don't advance the streak; a pivot resets it. See `docs/build-loop.md`.
- **`exercise.mechanism`** — `cli` | `web` | `ios` | `computer-use` | `custom`.
- **`build.verifyCommands`** — verification commands the **generator** may self-run (auto-approved)
  to stop "writing blind" — typecheck/test/build (e.g. `npm test`, `tsc`). Only single,
  self-contained commands are approved (no chaining/redirect/network/mutation/commit), gated to a
  worktree boundary; `[]` disables. An **in-place** `run_role` (no worktree) can opt into the SAME
  strict allow-hook with `allowVerify: true` (MCP) / `--verify` (CLI) — so the interactive
  generator self-verifies its gates and the conductor no longer has to run every gate out-of-band.
- **`build.preflightVerify`** — off by default. When on, after each generation and **before** the
  evaluator, the harness runs the contract's own *"I will verify by"* commands via the safe
  executor; a deterministic **behavioral** failure **skips the evaluator that round** and bounces
  back to the generator with the (holdout-redacted) output — so a generation that fails its own
  gates never costs a full evaluator session. usage/unsafe/all-green fall through to the evaluator;
  capped at one bounce before an evaluator round must run.
- **`build.distillTechnique`** — off by default. When on, at each item terminal (pass **or** fail)
  the harness distills **one** 1–2 line transferable **technique** (what FIXED / was tried on the
  item) from the item's durable round history (last report + attempt ledger) and appends it to
  `memory.md` as a `technique:`-marked, holdout-redacted `note` — deterministic (no model call),
  **never the score/bookkeeping**, once per item across resume (dedup keys on the marker). With it
  unset, memory content is exactly as today.
- **`build.env`** — string env vars merged over `process.env` and injected into build SDK
  sessions, evaluator `run_command` spawns, and verify/measure command spawns. Use this for
  per-project tool cache/user dirs (for example `HOME: /private/tmp` under a sandbox). Optional
  `.sparra/environment.md` carries concise environment notes for writer prompts.
- **`exercise.sandbox`** — `workspace-write` (default) | `read-only`. The sandbox a **Codex**
  evaluator's exercise runs under on a worktree boundary: `workspace-write` lets `npm test`/`tsc`
  write the scratch they need (network off; a source-integrity guard reverts+fails any
  artifact-source write). `read-only` is the strict pre-fix behavior. The Claude evaluator
  exercises via the in-process runner regardless.
- **default writable-scratch env layer (judge roles)** — the **evaluator** and **contract-evaluator**
  role-runs get a default env layer (`src/build/judgeScratch.ts`) that redirects `TMPDIR`,
  `CLANG_MODULE_CACHE_PATH`, and `SWIFTPM_CACHE_DIR` into a fresh per-run writable **scratch** dir,
  so a read-only sandbox / unwritable `$HOME` no longer EPERMs *before any Sparra code runs*: Vitest's
  `node_modules/.vite-temp`/`/var/folders` temp writes, the **tsx** IPC socket **path** under
  `tmpdir/tsx-*`, and clang's `~/.cache/clang/ModuleCache`. Precedence:
  `process.env` → scratch defaults → `build.env` (override wins). This fixes **path writability only** —
  the sandbox still denies unix-socket `listen(2)` as **policy**, so a tsx socket smoke still UN-RUNs
  under a sandboxed judge; that known limit is surfaced up front via the injected
  **known-capability matrix** (`sandboxCapabilityNotes`) so socket-dependent gates are classified
  UN-RUN, not re-proved. The contract-evaluator additionally
  relaxes to `workspace-write` (network off, integrity-guarded) on an isolated checkout so it can
  prove the contract's verify commands run; `--worktree` now accepts it. See
  [diagnose](subskills/diagnose.md) for the EPERM + socket-listen failure signatures.
- **`contract` / `pivot` / `rubric`** — assertion range (scaled per item), GAN restart
  threshold, scoring weights + pass threshold. `pivot.resetWorkspace` (default true) resets
  the workspace to the item-start state on a pivot (revert tracked + clean non-ignored
  untracked, never `-x`) so the fresh generator can't re-anchor on the failed attempt —
  gated to `git.autoCommit` + a recorded Sparra-OWNED branch (it must carry
  `git.branchPrefix`; a recorded `main` refuses) whose live git state matches
  (in-place runs never reset); each pivot also appends a per-item attempt ledger that fresh
  restarts see as a "PRIOR ATTEMPTS — do not repeat these approaches" section. `rubric.anchorFunctionality` (default true)
  caps the functionality score at `round(100 × passed/runnable-total)` when any runnable assertion failed
  (UN-RUN assertion ids are no-signal and excluded; ceiling only, noted in the verdict).
- **`measure: { enabled, command, baselineFile, regressionThreshold, defaultGoal }`** — opt-in
  **post-accept QA step** (off by default). After an item is accepted, `measure.command` (a SINGLE
  argv command — no pipe/chain; its own value is the executor argv[0]-allowlist opt-in, like
  `verifyCommands`) prints a JSON `metrics` object; Sparra parses the **last** such object (leading
  logs tolerated), diffs each metric against `baselineFile` (default `.sparra/measure/baseline.json`,
  always under the MAIN repo `.sparra` so it survives a worktree build), flags a metric regressed
  when it worsens past `regressionThreshold` per its goal (`defaultGoal` for a bare number), records
  a report under `.sparra/measure/`, and appends a `MEASURE` memory line reflect reads. **Non-blocking
  by design** — a regression is a signal, never a gate (item stays passed, commit proceeds). Runs with
  cwd = the worktree holding the artifact; guarded by a durable `acceptance.measured` flag (not part
  of `acceptanceComplete`). Standalone: `sparra measure [dir] [--worktree] [--set-baseline] [--out f]`
  (default compare-only — baseline written only with `--set-baseline`).
- **`review: { enabled, blockOn }`** — opt-in **code-review gate** (off by default). After
  an item passes the evaluator, a `reviewer` role reads the diff for what the exerciser
  can't see (security, dead/vestigial code, conventions). `blockOn`: `high` (security/
  correctness/dead-code) | `all` | `none`. Best on a backend ≠ the generator's.
- **`git.autoCommit`** — when true, each accepted item is one **conventional commit** onto
  the Sparra worktree/branch (never your main branch; never in-place). Default false.
- **`build.skills` / `roles.<role>.skills`** — **agent skills** (SKILL.md) for roles.
  Builder roles (generator, prototyper) inherit `build.skills`; others (e.g. evaluator) opt
  in via their own list. Resolved from repo `skills/`, `~/.claude/skills`, `~/.agents/skills`.
- **`build.extraReadDirs`** — extra dirs the build (generator + evaluator) may READ (added to
  `additionalDirectories`). For big assets you don't want in git (e.g. a model): pre-stage once,
  list the dir, no commit/network. Absolute, `~`, or repo-relative.

### Cross-backend (Codex builds, Claude judges)
A genuine quality lever — independent model families catch each other's blind spots.
```yaml
roles:
  generator:  { backend: codex,  model: gpt-5-codex }
  decomposer: { backend: claude, model: opus }              # keep PLANNING on Claude
  evaluator:  { backend: claude, model: opus, effort: high } # independent grader
```
Two rules of thumb: **keep `decomposer` on Claude** even when Codex builds (Codex tends to
over-split), and on a **subscription or with Codex, cap with `maxTokensPerItem`** (or set
`zeroCostTokenCap` as the fallback when `maxTokensPerItem` is intentionally off) — Codex
reports tokens and often `costUsd: 0`, so a dollar cap alone can't bind.
Needs `npm i @openai/codex-sdk` + the `codex` CLI (auth from `~/.codex`).

### iOS / macOS
`mechanism: ios` drives `xcodebuildmcp`; the multimodal evaluator screenshots the running
app and reads it. Needs Xcode + `xcodebuildmcp` + `xcodegen`. Set **`exercise.ios.platform`**:
- **`ios`** (default) — iOS Simulator; UI via simctl/ui-automation. The project MUST set a launch
  screen (`INFOPLIST_KEY_UILaunchScreen_Generation: YES`) or the app letterboxes at 320×480 and
  UI automation misses.
- **`macos`** — no simulator: the `.app` runs on the host and the UI is verified via an **XCUITest**
  target (`macos test`) + `xcresulttool` screenshots + `screencapture` (xcodebuildmcp's screenshot/
  ui-automation is simulator-only). The generator includes a UI-test target.

**`exercise.ios.visual`** (iOS only, default `true`) injects the **visual-verification recipe**: a
static **screenshot** chain (Read the PNG + a11y-hierarchy dump) **and** an **animation** chain
(`simctl io … recordVideo --codec=h264` → `ffmpeg … "fps=N,scale=W:-2,tile=CxR"` → Read ONE contact
sheet, judged start→mid→end, coarse-then-dense), plus the `#if DEBUG` launch-arg reach convention,
the honest boundary (geometry/nav proven; motion feel/jank/120 Hz/GPU-ML **not**), and **UN-RUN**
semantics (Simulator/`ffmpeg` unavailable → env-blocked, never failed). Needs **ffmpeg** for
animation. Set `false` for the pre-recipe guidance.

Full guide: `docs/ios.md`.

### Holdout / isolation wall
Author acceptance checks in `HOLDOUT.md`; only the evaluator sees them (enforced in code).
The builder can't overfit to checks it can't read. Frozen alongside the plan. Strongest
combined with cross-backend grading. See `docs/build-loop.md`.

### Code review (optional)
`review.enabled: true` adds a `reviewer` role that reads the diff/source after the evaluator
passes — a second lens for security, dead code, structure, and convention conformance the
exerciser can't see. `blockOn` (`high`|`all`|`none`) decides what fails acceptance; findings
land in `.sparra/reviews/`. Run it on a backend ≠ the generator's for fresh eyes.

### Skills (per role)
Hand a role agent skills via `build.skills` (builders inherit) or `roles.<role>.skills`
(others opt in). **Claude** loads them natively as a scoped throwaway local plugin, so
`settingSources` stays `[]` (no ambient leak); **Codex** has no skill channel, so the
`SKILL.md` is inlined into the input. Declared in config → reproducible. E.g.
`roles.evaluator.skills: [xcodebuildmcp-cli]` to give the iOS grader your build/run skill.

## Diagnosing a run

This is the highest-value thing the skill does. **Read the artifacts in order**, then map
the symptom to a cause. The full per-artifact guide and the failure-signature table are in
**[subskills/diagnose.md](subskills/diagnose.md)** — read it whenever a run stalls, fails,
goes over budget, or produces a surprising verdict.

Quick triage (from the project's `.sparra/`):
```bash
node -e "const s=require('./.sparra/state.json');console.log('phase',s.phase);for(const[k,v]of Object.entries(s.build.items||{}))console.log(k,v.status,'r'+v.round,'score',v.lastScore,'$'+(v.costUsd||0).toFixed(2),(v.tokensUsed||0)+'tok')"
ls .sparra/workitems/items.json .sparra/contracts .sparra/verdicts .sparra/traces
```
Then, by symptom: decomposition shape → `workitems/items.json`; contract not converging →
`contracts/<id>.contract.md`; low/failing score → `verdicts/<run>/<id>.r<n>.verdict.md` (run-scoped
subdir; interactive evaluator runs persist `verdicts/role-run-evaluator-<stamp>.verdict.md`) — blocking
with failed assertion evidence + UN-RUN/no-signal ids; anything deeper → the role transcripts in `traces/<run>/`; recurring learnings
→ `memory.md`.

## Hard-won gotchas (cheat sheet)

- **Run in its own dir** (see above) — nesting causes false "wrong project" rejections.
- **Decomposition belongs on Claude.** If the decomposer over-splits (a standalone
  "scaffold" or "verify it" item, or 8+ items for a small app), it's likely on Codex —
  move `decomposer` to Claude.
- **iOS: launch screen is mandatory**, else letterbox → UI automation fails. Build in the
  project's own dir, not nested.
- **Budgets on a subscription/Codex**: use `maxTokensPerItem`; `zeroCostTokenCap` is only the
  fallback when USD is active but cost is `$0`/unknown and `maxTokensPerItem` is off.
- **`BUDGET_EXCEEDED` ≠ crash** — the item halts, the run continues to the next item.
- **Contracts are proportionate**: a handful of *observable product-behavior* assertions,
  scaled to the item — not build-setting/toolchain trivia. Over-spec is a review failure too.
- **The evaluator won't pass a flaky artifact.** An intermittently-failing required check is
  an artifact defect, not "environmental" — rerun-to-green doesn't launder it. For a full-suite
  gate that runs it once quietly and once under concurrent load; a load-only timeout (e.g. a test
  firing a live network/SDK call) is an artifact defect too. The harness rerun gate can add that
  concurrent-load pass itself — opt in via `build.flakinessLoadRerun` (off by default).
- **UN-RUN ≠ FAIL.** A verdict can list `unrunAssertionIds` when the evaluator environment
  could not execute a gate; `exerciseStatus: mixed` means some gates ran and some were env-blocked,
  while `blocked` means nothing ran. Treat UN-RUN as no signal, not a product failure.
- **Never commits to your main branch.** Existing repos build on a worktree/branch; opt into
  per-item conventional commits *on that branch* with `git.autoCommit` (never main/in-place).
- **Skills are declared, not ambient.** List them in `build.skills` / `roles.*.skills`;
  Claude loads natively (settingSources stays []), Codex inlines the SKILL.md.
- After a meaningful run, `sparra reflect` turns build traces or auto-discovered interactive
  `role-run-*` traces into proposed prompt edits (`--traces <glob-or-dir>` overrides selection), and routes any
  **harness-level** findings (about Sparra itself, not this project's prompts) into a shared user-level
  inbox `~/.sparra/reflections/` (`SPARRA_HOME` overrides), each finding written as its own `###` section.
  From the Sparra repo, `sparra reflect --upstream` lists every finding with a global 1-based index;
  `--done <ids>` / `--wontdo <ids>` (comma-separated, optional `--reason "<text>"`) triage individual
  findings into `archive/` and leave the un-triaged ones to resurface next run, while `--clear` archives
  ALL files at once. Nothing is applied automatically.
