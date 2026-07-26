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

## Installing the interactive conductor

Both hosts require `npm install && npm link` in the Sparra checkout (`make link`); the link exposes
the `sparra` and `sparra-run-mcp` package bins on `PATH`.

- **Claude Code:** `make setup-claude` — registers `sparra-run-mcp`, adds the repo marketplace,
  installs `sparra@sparra-skills`; then invoke `/sparra-loop` in the target project.
- **Codex:** `make setup-codex` — registers the checkout as a marketplace and installs
  `sparra@sparra-skills`. Start a fresh thread in the target project and ask it to use
  `sparra-loop`. Whenever the `.codex-plugin/plugin.json` cachebuster changes, run
  `make update-codex-plugin` and start another fresh thread.
- **Remote (HTTP bridge):** trigger `sparra` phases/role-runs on another Mac over Tailscale via
  `conductors/http` (Bearer token, path allowlist, holdout wall preserved) — see `docs/http-bridge.md`.
- **Pi:** `make setup-pi` (= `pi install ./conductors/pi`, loads live from the checkout) — the
  package ships the Pi-native
  `sparra-loop` conductor skill + `sparra_role` tool + `/sparra-loop` command, and references this
  `sparra` skill. Then say "conduct a Sparra loop …" or `/skill:sparra-loop`.

On Codex, prefer background CLI calls: `sparra role run … --json --out <file>` and
`sparra eval … --json`, with each stdout envelope redirected to its own file. Resume with
`--resume-session <id> --resume-backend <backend>`. Blocking MCP `run_role` is last-resort: its
server needs `tool_timeout_sec >= 1800` instead of Codex's 60-second default, and headless
`codex exec` cannot approve the data-export gate.

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
sparra reflect --upstream [--done <ids>] [--wontdo <ids>] [--reason "…"] [--clear]  # list/triage harness reflections in ~/.sparra/reflections (SPARRA_HOME), ranked by recurrence ×N DESC; --clear archives ALL
sparra prompts status  # 3-way drift vs defaults: same/stale(newer default)/local(your edit)/conflict/drifted/missing
sparra prompts sync    # adopt STALE only (safe); --role <r> or --all force-overwrite (discards edits); --dry-run
# A `stale` (newer-default) prompt is surfaced once on the build AND `sparra eval`/`role run`/`sparra-loop` paths.
sparra prompts audit   # concision + readability review of role prompts (cut redundancy, format for fast parsing — not terseness) → prompts/audit/<role>.md; --apply tightens in place behind a coverage guard PLUS an independent prompt-audit-verifier pass (re-derives the original's rules; skips if any are missing)
sparra status          # where am I / what's next
sparra new "<title>"   # next feature, same project: archive this cycle → fresh plan
sparra clean           # prune stale sparra worktrees/branches (dry-run; --yes acts, --force unmerged)
sparra resume          # continue whatever phase, from .sparra/state.json
```

For scriptable role calls, `sparra role run … --json` and `sparra eval … --json` emit the same
holdout-safe payload as MCP `run_role`: one JSON object on stdout, with human logs on stderr.
Resume a CLI role session with `--resume-session <id> --resume-backend <backend>`; MCP uses the
matching `resumeSessionId`/`resumeBackend` inputs. Evaluator JSON intentionally omits `resultText`
and `traceDir`; non-evaluators use `resultText`, and both include `errors`.

`--root <dir>` targets a project; otherwise the cwd is used. Re-running `sparra build`
resumes — passed/abandoned/budget_exceeded items are skipped.

**Headless conductor (`sparra conduct "<prompt>"`).** Drives the whole conductor pattern from ONE
prompt (no `sparra init` needed): decompose → per-unit contract-negotiate → generate → cross-model
evaluate → decide, all through the isolated `role run … --json` machinery. By default (no
`--commit`/`--merge`/`--land`/`--push`) nothing is committed, merged, landed, or pushed — each unit
just builds on its own `sparra/<name>` worktree. The opt-in landing flags chain: `--commit` →
`--merge` (integrates accepted branches onto a run/feature branch, never the default branch) →
`--land` (requires `conduct.landToDefault: true`; fast-forwards the **default branch** only on a
fully-clean, true-ff run) → `--push` (requires `conduct.push: true`; a plain non-force push after a
successful land — never fatal on failure). **Resume** a crashed/interrupted run with
`sparra conduct --resume <runId> [--commit|--merge|--land|--push] [--auto]`. **Inspect with zero
spend**: `--status <runId> [--attempts]` / `--list`. A decision engine parks judgment points
(park / park-timeout / `--auto`), answerable via file, TTY, `--decide <runId> <seq> <answer>`, or
the HTTP bridge. Cross-unit learning appends holdout-safe outcome lines to `.sparra/memory.md`.
Full flag-by-flag reference (brain modes, resume semantics, bridge parity, multi-round re-grades,
push/land gating details): **[subskills/configure.md](subskills/configure.md)** and
**[docs/conduct.md](../../docs/conduct.md)**.

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

Seeded on `init`; edit and re-run (picked up live). Full per-knob reference + the `sparra conduct`
flag walkthrough now live in **[subskills/configure.md](subskills/configure.md)**; the complete
knob list is also in `docs/configuration.md`. The few that matter most:

- **`roles.<role>: { backend?, model, effort?, sandbox? }`** — `backend` defaults to `claude`;
  set `codex` to run that role on Codex. `roles.generatorLocal` + item `gen: "local"` hybrid-routes
  trivial items to a local model. Roles: orienter, planner, decomposer, prototyper,
  contractGenerator, contractEvaluator, generator, evaluator, evaluatorSecond, reviewer, reflector.
- **`build.maxBudgetUsdPerItem` / `maxTokensPerItem` / `zeroCostTokenCap`** — per-item spend caps;
  crossing halts the item `BUDGET_EXCEEDED` and the run continues (`0` = no cap). `zeroCostTokenCap`
  is the fallback when the USD cap is active but cost reports `$0`/unknown.
- **`build.maxTurnsPerSession`** — per-session turn cap (default 80); `role run`/`eval --max-turns`
  and MCP `run_role`'s `maxTurns` override it per call.
- **`exercise.mechanism`** — `cli` | `web` | `ios` | `computer-use` | `custom`.
- **`build.verifyCommands`** — commands the **generator** may self-run (auto-approved) to stop
  "writing blind" (typecheck/test/build). Gated to a worktree boundary; an in-place `run_role` can
  opt in with `allowVerify: true` / `--verify`.
- **`contract` / `pivot` / `rubric`** — assertion range scaled per item, GAN pivot threshold +
  workspace reset, scoring weights/pass threshold.
- **`measure` / `review` / `evaluator.secondOpinion`** — opt-in post-accept QA diff, code-review
  gate, and cross-model re-grade gate (all off by default; see subskill for semantics).
- **`git.autoCommit` / `pullBeforeWork`**, **`build.skills` / `extraReadDirs`**, **`scriptHooks`** —
  per-item conventional commits, pre-build ff-only sync, agent skills per role, extra read-only
  dirs, and external lifecycle hooks.
- **Eval integrity & reliability** — provenance guards (`expectedHead`/`evalBaseRef`), a verified
  baseline (`baselineCommand`), fallback/`sameModelGrade` signaling, `build.autoRestart` (provider
  limits) and `build.escalateAfterRounds`/`assertionEscalateAfter` (quality escalation),
  `build.preflightVerify` and `build.distillTechnique` — all detailed in the subskill.

See **[subskills/configure.md](subskills/configure.md)** for the exact semantics of every knob
above (plus `build.env`, `exercise.sandbox`, and the default writable-scratch env layer — see
[diagnose](subskills/diagnose.md) for the EPERM + socket-listen failure signatures it fixes).

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
Then, by symptom: a terminal NON-PASS item/unit (`budget_exceeded`/`failed`/inconclusive/`abandoned`,
conduct `exhausted`/`error`) → its **stop report** first — `reports/<run>/<id>.stop.md` (build) or
`conduct/<run>/<unit>/stop.md` (conduct; its path is on the unit's `run.json` + `conduct --status`):
the stop reason (tripped cap + value / rounds exhausted / error), best score+round, spend, artifact
location, unresolved blocking + failed assertions, and a next action; decomposition shape →
`workitems/items.json`; contract not converging → `contracts/<id>.contract.md`; low/failing score →
`verdicts/<run>/<id>.r<n>.verdict.md` (run-scoped subdir; interactive evaluator runs persist
`verdicts/role-run-evaluator-<stamp>.verdict.md`) — blocking with failed assertion evidence +
UN-RUN/no-signal ids; anything deeper → the role transcripts in `traces/<run>/`; recurring learnings
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
- **When building Sparra itself, keep docs in sync in the same change.** Per the Sparra
  repo's own `CLAUDE.md`, a change that adds or alters user-facing behavior updates all
  four layers that apply: `README.md` (headline capability), `docs/` (the detail doc for
  that knob/behavior/backend), `skills/sparra/` (`SKILL.md` + `subskills/diagnose.md`, plus
  a plugin-version bump in `.claude-plugin/marketplace.json`), and **the repo map** —
  `CLAUDE.md`'s own Architecture bullets and `docs/phases.md`'s phase overview — whenever
  the change adds or renames a command, phase, module, or directory.
- After a meaningful run, `sparra reflect` turns build traces or auto-discovered interactive
  `role-run-*` traces into proposed prompt edits (`--traces <glob-or-dir>` overrides selection), and routes any
  **harness-level** findings (about Sparra itself, not this project's prompts) into a shared user-level
  inbox `~/.sparra/reflections/` (`SPARRA_HOME` overrides), each finding written as its own `###` section.
  Only material findings (those that caused a bounce, a wasted round, a wrong grade, burned turns, or a forced
  override) are routed; recurring ones increment a `×N` counter on the existing inbox entry (no duplicates).
  From the Sparra repo, `sparra reflect --upstream` lists every finding ranked by recurrence `×N` DESC with a
  global 1-based index; `--done <ids>` / `--wontdo <ids>` (comma-separated, optional `--reason "<text>"`) triage
  individual findings into `archive/` and leave the un-triaged ones to resurface next run, while `--clear`
  archives ALL files at once. Nothing is applied automatically.
