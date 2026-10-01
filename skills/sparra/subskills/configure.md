# Configuring Sparra

The full per-knob reference for `.sparra/config.yaml`, plus the complete `sparra conduct` flag
walkthrough. `SKILL.md` keeps only a short "knobs that matter most" digest with pointers here —
this is the deep-detail companion, read it when you need the exact knob semantics, not just the
headline. See also `docs/configuration.md` (every knob, `.sparra/` layout, resuming) and
`docs/conduct.md` (the conductor's full reference doc).

- [`sparra conduct` — full flag reference](#sparra-conduct--full-flag-reference)
- [Configuring (`.sparra/config.yaml`)](#configuring-sparraconfigyaml)

## `sparra conduct` — full flag reference

**Headless conductor (`sparra conduct "<prompt>"`).** Drives the whole conductor pattern from ONE
prompt (no `sparra init` needed): decompose → per unit contract-negotiate → generate → cross-model
evaluate → decide, all through the isolated `role run … --json` machinery. Flags:
`--max-units N` (default 4), `--concurrency N` (default 2), `--budget <usd>` (0 = unlimited),
`--max-turns <n>`, `--dry-run` (decompose + briefs only, no role spend beyond the decomposer), plus the
opt-in landing flags `--commit` (commit an accepted unit's WIP onto its `sparra/<name>` branch — message
carries the unit's score + conduct `runId`), `--merge` (implies `--commit`: integrate accepted
branches into a safe target — a run branch `sparra/<runId>` when started on the default branch, else the
current branch, **never** the default branch — rebase+ff preferred with a merge-commit fallback,
conflicts/dirty target parked, merged worktrees torn down; `run.json` records `committedSha`/`mergedInto`),
and the further opt-in `--land` (implies `--merge`; ALSO requires `conduct.landToDefault: true` in
config — a hard error otherwise, never a silent downgrade): once every accepted unit landed cleanly on
the run branch, fast-forwards the **default branch itself** to that tip — but ONLY on a
default-branch-started, fully-clean (every unit terminal `accepted`, no unresolved parked decision, no
merge park), true-fast-forward run; any miss parks a `land-blocked` decision and leaves the default
branch untouched. Never a merge commit, never `--force`; `--land` itself never pushes anywhere.
`run.json` records `landedInto` on success. A yet further opt-in `--push` (implies `--land`; ALSO
requires `conduct.push: true` in config — a SECOND, separate hard-gated double gate, never a silent
downgrade) runs immediately after a SUCCESSFUL `--land`: a plain, non-force `git push` of the just-landed
default branch to its configured upstream (no `--force`, no `--ff-only` — not a valid `git push` flag; a
non-force push is inherently fast-forward-only since git rejects a non-fast-forward update by default).
A push failure (offline, a divergent/non-ff remote, no upstream) is always non-fatal — the completed
land is never rolled back — and `run.json` records the durable outcome (`pushed: {ok, branch?, note}`)
for every requested-push path, including "no land happened this run". Writes `.sparra/conduct/<runId>/`
(`run.json` + per-unit `brief.md`/`contract.md`), generating each unit on its own `sparra/<name>`
worktree — by default (no `--commit`/`--merge`/`--land`/`--push`) nothing is committed, merged, landed,
or pushed, and the default branch and its remote are never touched; `run.json` reports each accepted
unit's branch/worktree. Two brain modes: `--brain hybrid` (default — deterministic loop + an LLM
conductor consulted at the five judgment points) and `--brain llm` (the brain drives turn-by-turn); a
decision engine surfaces important decisions (park / park-timeout / `--auto`), answerable from the file,
an inline TTY prompt, `sparra conduct --decide <runId> <seq> <answer>` in another terminal, or the HTTP
bridge (`POST /jobs/:id/decision`). The bridge's `POST /conduct` has full parity: a fresh run
(`{root,prompt,…,commit?,merge?}`, self-landing forwarded verbatim) OR a resume (`{root,resume,commit?,
merge?,auto?}`, EXACTLY ONE of `prompt`|`resume`), and a resumed run re-announces so its
`pendingDecisions` stay answerable remotely. **Resume a crashed/interrupted run in place** with
`sparra conduct --resume <runId> [--commit|--merge|--land|--push] [--auto]` (any prompt arg is ignored): it skips
already-accepted/dry-run units, re-enters pending/running/error units at the right stage (agreed/forced
contract → straight to generate, no re-negotiation; else renegotiate from the persisted brief), reuses
or recreates each unit worktree by stable name, and **appends to the same `run.json`** (monotonic
decision seq + a `resumedAt` stamp); prior parked decisions stay answerable and unresolved ones re-park.
Unknown runId → exit 1 (no side effects); a terminal all-accepted run → no-op. Multi-round re-grades
(normal AND resumed) thread each prior round's redacted `verdictPath` onto the next evaluator as
repeatable `--prior-blocking` (paths only) so settled blocking ground is verified, not re-litigated.
**Cross-unit learning:** at each unit terminal outcome (and at pivot / generalize-spec decisions)
`conduct` appends ONE holdout-safe, `ParentSummary`-derived line to the shared `.sparra/memory.md`
(via `src/memory.ts`, existing caps) through a single serialized best-effort writer — so a later-started
unit and every future run pick it up under **PRIOR LEARNINGS** with no new plumbing (see
[docs/conduct.md](../../../docs/conduct.md#cross-unit-learning-project-memory)).
**Inspect runs with zero spend**: `sparra conduct --status <runId> [--attempts] [--json]` prints a
holdout-safe projection of one run (header + per-unit id + title + outcome + score + cost + branch +
short-sha + mergedInto + any still-parked decisions with a `--decide` hint); `--attempts` additionally
dumps each unit's per-round attempt-ledger lineage (round, kind, decision, score/verdict, reason). The
build loop's per-item ledger is surfaced the same way via `sparra status --attempts`. And
`sparra conduct --list [--json]` lists all runs
newest-first (runId, status, accepted/total, total cost, updatedAt; a corrupt `run.json` shows
`unreadable`; no runs → "no conduct runs"). Both are read-only/promptless (paths + metadata only, never
brief/contract/verdict contents); the pending-decision projection is shared with the HTTP bridge.
Full reference: **[docs/conduct.md](../../../docs/conduct.md)**.

## Configuring (`.sparra/config.yaml`)

Seeded on `init`; edit and re-run (picked up live). Full knob list: `docs/configuration.md`.

- **`roles.<role>: { backend?, model, effort?, baseUrl?, apiKey?, skills?, sandbox? }`** — `backend`
  defaults to `claude`; set `codex` to run that role on Codex. `baseUrl` points a codex role at a
  local OpenAI-compatible endpoint (LM Studio/Ollama). `sandbox` (`workspace-write` default |
  `danger-full-access`) widens a **write** role's Codex OS sandbox for native toolchains (e.g.
  `xcodebuild`); full access is honored **only on a git worktree/branch** boundary, else downgraded
  with a loud warning. Roles: orienter, planner, **decomposer**,
  prototyper, contractGenerator, contractEvaluator, generator, evaluator, **evaluatorSecond**, **reviewer**, reflector.
- **`roles.generatorLocal`** + work-item **`gen: "local"`** — hybrid builds: tagged items build on
  a local model, the rest on `generator`. Decomposer tags trivial items when `generatorLocal` is set;
  edit tags in `items.json`. See `docs/backends.md`.
- **Work-item `relevantPaths`** — optional array of repo-relative files the decomposer names as most
  relevant to an item; the generator/contract-generator then prefer the CODEBASE_MAP section(s)
  covering those seams (plus a listing of the files) over a blind head-slice of the map. Paths only —
  no file bodies. Omitted → the head-slice (unchanged). Editable in `items.json`. See `docs/build-loop.md`.
- **`build.maxBudgetUsdPerItem` / `maxTokensPerItem` / `zeroCostTokenCap`** — per-item caps (the USD
  cap is **pre-re-ask**: a capped run may add one ≤ $4 recovery turn — size for `cap + min($4, cap)`);
  crossing USD/tokens halts the item `BUDGET_EXCEEDED` and the run continues. `0` = no cap.
  `zeroCostTokenCap` applies only when the USD cap is active, cost reports zero/unknown, and
  `maxTokensPerItem` is off. The standalone role surfaces override the USD cap per call:
  `run_role`'s `maxBudgetUsd` / `role run`/`eval`'s `--budget <usd>` (omit = config cap;
  `0` = unlimited).
- **`build.maxTurnsPerSession`** — the per-session turn cap (default 80). `role run`/`eval`'s
  `--max-turns <n>` and MCP `run_role`'s `maxTurns` both override it per call (positive integer;
  omit/invalid = config default — no `0` = unlimited). So an MCP conductor can pre-size a
  verify-heavy role's turns up front instead of relying on the default plus resume-on-`hitMaxTurns`.
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
  the commit or exclude foreign WIP. Both are rejected on a writer/contract-generator.
  `baselineCommand` (evaluator-only, requires `evalBaseRef`) — the RUNNER runs the allowlisted
  command at the base ref SHA in a throwaway worktree and injects a `[VERIFIED BASELINE @ <sha>]`
  block the evaluator trusts over prose carveouts; infra failures degrade to UNAVAILABLE. See `docs/role-runner.md`.
- **`run_role` / `role run` `out` capture** — non-evaluator artifacts are normalized from the
  first markdown heading (heading-less output is trimmed + warned); evaluator `out` remains the
  harness verdict template. Every evaluator run ALSO **auto-persists** its redacted verdict to a
  uniquely-named `.sparra/verdicts/role-run-evaluator-<stamp>.verdict.md` (surfaced as `verdictPath`,
  separate from `out`/`outPath`) with no `out` needed. The verdict header now names the **ACTUAL
  post-fallback grader** (e.g. `evaluator (claude/opus — fell back from codex/gpt-5.5)`) — not
  the configured backend — so a conductor can tell a real cross-model grade from a collapsed one.
  See `docs/role-runner.md`.
- **Fallback provenance + same-model-grade signal** — pass the generator's `backend`/`model` as
  `crossModelBaseline` on the evaluator `run_role` call. The runner then sets `sameModelGrade:
  true` on the result/payload if the evaluator's actual post-fallback identity matches the
  generator (the gate collapsed), `false` if it differs, and `undefined` if the field was omitted.
  `fallbackFrom` is set when a fallback occurred (names the originally-requested evaluator role).
  See `docs/role-runner.md` → "Fallback provenance + same-model-grade warning".
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
  all-un-run rounds (and Jev `auto`-band ids, see `evaluator.envBlockJudge`) don't advance the
  streak; a pivot resets it. See `docs/build-loop.md`.
- **`exercise.mechanism`** — `cli` | `web` | `ios` | `computer-use` | `custom`.
- **`build.verifyCommands`** — verification commands the **generator** may self-run (auto-approved)
  to stop "writing blind" — typecheck/test/build (e.g. `npm test`, `tsc`). A Claude
  contract-evaluator receives the same strict allow-hook on an isolated autonomous or `--worktree`
  run; in-place contract evaluation receives no grant, and Codex relies on its OS sandbox. Gated to a worktree
  boundary; `[]` disables. An **in-place** `run_role` (no worktree) can opt into the SAME
  strict allow-hook with `allowVerify: true` (MCP) / `--verify` (CLI) — so the interactive
  generator self-verifies its gates and the conductor no longer has to run every gate out-of-band.
  The **generator's Bash allow-hook** accepts two extra shapes beyond a bare command (the harness
  executor still rejects both — allow-hook only): **(a)** a leading literal env-var assignment
  `KEY=VALUE <core>` (e.g. `TMPDIR=/tmp/sprj-x npm test`, `LANG=C LC_ALL=C npm run typecheck`) —
  the core is re-validated by the full safety rules; **(b)** a trailing output-shaping filter pipe
  (e.g. `npm test 2>&1 | tail -20`). Both compose freely. The harness executor (`build.verifyCommands`
  as config entries) still runs each entry as a single shell-less argv — no pipe/chain/env-prefix.
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
  unset, no distilled-technique note is appended — the other writers (build item outcomes, and
  `sparra conduct` unit learnings) still write `memory.md`.
- **`build.env`** — string env vars merged over `process.env` and injected into build SDK
  sessions, evaluator `run_command` spawns, and verify/measure command spawns. Use this for
  per-project tool cache/user dirs (for example `HOME: /private/tmp` under a sandbox). Optional
  `.sparra/environment.md` carries concise environment notes for writer prompts.
- **`exercise.sandbox`** — `workspace-write` (default) | `read-only` | `danger-full-access`. The
  sandbox a **Codex** evaluator's exercise runs under on a worktree boundary: `workspace-write` lets
  `npm test`/`tsc` write the scratch they need (network off; a source-integrity guard reverts+fails
  any artifact-source write). `read-only` is the strict pre-fix behavior. `danger-full-access` is the
  opt-in for a gate Seatbelt denies OUTRIGHT rather than starving of scratch — an **iOS/macOS**
  exercise needs CoreSimulatorService XPC, which scratch can't grant, so a `workspace-write` judge
  marks those gates UN-RUN; it lifts the sandbox (guard still armed, network no longer withholdable)
  and, like `roles.*.sandbox`, is honored only on an isolated checkout — denied, you get a loud
  warning, not a silent read-only judge. **Use it on every Swift/Xcode project with a Codex judge**:
  under `workspace-write` 83% of those verdicts had un-run gates (3% with full access), and the
  runner warns at run start when a Codex judge exercises one without it. The Claude evaluator exercises via the in-process runner
  regardless.
- **default writable-scratch env layer (all sandboxed build sessions)** — the **evaluator**,
  **contract-evaluator**, the **generator/writer**, AND the **contract-negotiation** sessions get a
  default env layer (`src/build/judgeScratch.ts`, `createSandboxSessionEnv`) that redirects `TMPDIR`,
  `CLANG_MODULE_CACHE_PATH`, and `SWIFTPM_CACHE_DIR` into writable **scratch**, so a read-only sandbox
  / unwritable `$HOME` no longer EPERMs *before any Sparra code runs*: Vitest's
  `node_modules/.vite-temp`/`/var/folders` temp writes, the **tsx** IPC socket **path** under
  `tmpdir/tsx-*`, and clang's `~/.cache/clang/ModuleCache`. `TMPDIR`/`CLANG_MODULE_CACHE_PATH` are a
  fresh per-run scratch (regenerable), while **`SWIFTPM_CACHE_DIR`** is a **durable, worktree-local**
  cache so an **offline** `swift build` reuses what the provisioning-time **SwiftPM prewarm** resolved
  (`git.provisionDeps.swiftPackages`, default on). Precedence:
  `process.env` → scratch defaults → `build.env` (override wins). This fixes **path writability only** —
  the sandbox still denies unix-socket `listen(2)` as **policy**. So every judge/evaluator session env
  ALSO sets **`SPARRA_JUDGE_SANDBOX=1`** (never the generator): under it every suite that spawns the
  real CLI / a tsx subprocess **vitest-SKIPS visibly** (shared `test/helpers/judgeEnv.ts`), so the full
  suite is EXPECTED green and a nonzero full-suite exit is a REAL signal (no longer UN-RUN / mixed) —
  EXCEPT the runner's own worker/reporter-RPC-timeout signature (whole files aborting on
  `Timeout calling "onTaskUpdate"`/`onCollected` with zero failing assertions = runner CPU saturation →
  UN-RUN, confirmed by an isolation re-run, never an artifact FAIL). That
  behavior + the residual capability matrix + a **KNOWN RUNNER LIMITS** note (rendered for every judge
  that runs the suite, including a no-OS-sandbox Claude judge) are surfaced up front via the injected
  **known-limits block** (`sandboxCapabilityNotes` + `runnerLimitations`). The contract-evaluator additionally
  relaxes to `workspace-write` (network off, integrity-guarded) on an isolated checkout so it can
  prove the contract's verify commands run; `--worktree` now accepts it. The read-only proposer roles
  (reviewer, contract-generator) keep the plain merged `build.env`. See
  [diagnose](diagnose.md) for the EPERM + socket-listen failure signatures.
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
  an item passes the evaluator (and the optional second-opinion gate), a `reviewer` role reads
  the diff for what the exerciser can't see (security, dead/vestigial code, conventions).
  `blockOn`: `high` (security/correctness/dead-code) | `all` | `none`. Best on a backend ≠ the
  generator's.
- **`evaluator.secondOpinion: { enabled }`** + **`roles.evaluatorSecond`** — opt-in
  **second-opinion gate** (off by default). On a **PASS verdict only** (bounded cost), a second
  evaluator on a **different backend/model** re-grades the same inputs; a real `fail` demotes the
  accept to a failed round with merged, holdout-redacted blocking. NO-OP with a warning when
  `evaluatorSecond` is unset or resolves to the same effective backend+model as the
  actually-selected primary evaluator (after fallback). A limit/empty/blocked/all-un-run second
  grade never demotes (accept proceeds). Stops a lenient primary evaluator laundering slop.
- **`evaluator.envBlockJudge: { enabled, model, apiKeyEnv, autoNoul, autoConfidence, suspectNoul,
  concurrency, timeoutMs }`** — opt-in (off) TypeSafe **Jev annotation** of FAILED assertions that
  likely *could not execute* in the evaluator's sandbox (EPERM, read-only FS, no simulator) and were
  misfiled as failures. Sends ONLY each failed assertion's holdout-redacted `#<id>: <evidence>`
  (≤1500 chars) to TypeSafe, and only when `$TYPESAFE_API_KEY` (or `apiKeyEnv`) is set. It NEVER
  changes the verdict/scores/un-run ids; its one effect is that `auto`-band ids (noul ≥ 0.8,
  `environment_blocked`, confidence ≥ 0.8) stop advancing the pivot/escalation streaks (all-`auto`
  ⇒ the round is inconclusive like a blocked exercise) and reach a conductor as
  `envBlockedAssertionIds`. `suspect` ids (noul ≥ 0.5) are informational. Fail-open.
- **`git.autoCommit`** — when true, each accepted item is one **conventional commit** onto
  the Sparra worktree/branch (never your main branch; never in-place). Default false.
- **`git.pullBeforeWork`** — opt-in (default false). When true, **before** `build`/`conduct`/
  `prototype` cut a **fresh** workspace from local HEAD, Sparra fast-forward-only syncs the
  current branch with its upstream (`git pull --ff-only`) — so a stale local clone doesn't
  silently build on stale code. Non-fatal: skipped (with a logged note) when there's no repo,
  no commits, a detached HEAD, or no upstream; a failed pull (offline, diverged) never blocks
  the run. Never on a resumed run, never with `--workspace-override`/`conduct --resume`.
- **`build.skills` / `roles.<role>.skills`** — **agent skills** (SKILL.md) for roles.
  Builder roles (generator, prototyper) inherit `build.skills`; others (e.g. evaluator) opt
  in via their own list. Resolved from repo `skills/`, `~/.claude/skills`, `~/.agents/skills`.
- **`build.extraReadDirs`** — extra dirs the build (generator + evaluator) may READ (added to
  `additionalDirectories`). For big assets you don't want in git (e.g. a model): pre-stage once,
  list the dir, no commit/network. Absolute, `~`, or repo-relative.
- **`conduct.shadowJudge`** — opt-in (`enabled: false`) SHADOW-MODE Jev judgment on `sparra conduct`
  decisions. **Enabling sends the holdout-safe decision request (kind, question, scalar context) to
  TypeSafe.** Jev's `choice`/`probabilities`/`confidence` are recorded as `shadow` beside each real
  resolution in `run.json` and never change or fail it. `model` pinned (`jev-1.13.0`), `apiKeyEnv` NAMES
  the env var (default `TYPESAFE_API_KEY`; never put the key in config), `timeoutMs` (5000) = max wait
  AFTER the real answer. Unset key → one `warn`, no shadow; bad value → default + one `warn`.
- **`reflect.dedupe`** — opt-in (`enabled: false`) semantic recurrence matching for the upstream
  inbox via TypeSafe Jev. **Enabling sends holdout-redacted finding text to TypeSafe.** `model` is a
  pinned ID (`jev-1.13.0`), `apiKeyEnv` NAMES the env var holding the key (default `TYPESAFE_API_KEY`;
  never put the key in config). `same ≥ autoThreshold` (0.9) + `same_defect` auto-merges; `≥
  suggestThreshold` (0.5) adds up to `maxSuggestions` (3) `POSSIBLE-RECURRENCE-OF:` lines;
  `concurrency` (8) bounds requests. Unset key / judge failure / bad value → exact-only routing.
- **`reflect.shippedCheck`** — knobs for `sparra reflect --upstream --check-shipped [--commits <n>]`, which
  judges each live inbox finding against the last `commits` (30) non-merge commits of the current repo and
  PRINTS a `--done` suggestion (never triages). Reuses `reflect.dedupe.model`/`apiKeyEnv` but needs no
  `dedupe.enabled` (the flag is the consent; **sends finding + commit text to TypeSafe**). A pair suggests
  only at Noul `≥ threshold` (0.8) AND choice `fixes`; `concurrency` (8) bounds requests. Unset key → warn,
  listing only; bad value → default with one warn.
- **`scriptHooks`** — user-configurable **external scripts** at harness lifecycle points
  (`onRunStart`/`onRunComplete`/`onPhaseStart`/`onPhaseEnd`/`onUnitStart`/`onUnitComplete`/
  `onDecisionParked`). `{}` (default) = no hooks, byte-identical to today. Each hook is a bare
  command string or `{run, required?, timeoutSec?, cwd?}` — argv-tokenized, no shell. Before-events
  (`onRunStart`/`onPhaseStart`/`onUnitStart`) can GATE on a `required: true` hook's non-zero
  exit/timeout (stops remaining hooks for that event); after-events are best-effort (warn only,
  never gate). Hooks get `SPARRA_HOOK_*` env vars for present context fields plus the full context
  as one JSON line on stdin (parked-decision `question` text is stdin-only, never an env var). Five
  fire points are wired — phase start/end (`orient`/`plan`/`prototype`/`freeze`/`build`/`reflect`/
  `batch`), conduct run start/complete, conduct unit start/complete (deterministic + brain paths), and
  `onDecisionParked` on every parked judgment point (best-effort; also prints a `conduct: decision-parked
  <runId> <seq>` stdout line the bridge turns into a `decision_parked` event). See
  `docs/configuration.md` → "Script hooks", `docs/conduct.md`, `docs/phases.md`.
