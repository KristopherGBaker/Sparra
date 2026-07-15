# Configuration

Every knob lives in **`.sparra/config.yaml`** (seeded on `init` with mode-aware defaults; edit and re-run any phase — changes are picked up live). Models accept SDK aliases (`opus` · `sonnet` · `haiku` · `fable`) or full model ids. Anything you omit inherits the default.

> **Zero-setup standalone surfaces.** `sparra eval`, `sparra role run`, and the MCP `run_role` tool work in a repo with **no `.sparra/`** — they fall back to the built-in defaults (this same `defaultConfig` + the built-in role prompts) with an in-memory greenfield store, so `sparra init` is **not** required for an ad-hoc cross-model eval/role-run. Run `init` only to customize (per-role backends, rubric, edited prompts) or to drive the full `plan → freeze → build` loop. An existing `.sparra/config.yaml` is always honored unchanged.

```yaml
roles:                        # per role: { backend?, model, effort?, baseUrl?, apiKey?, skills?, sandbox? }  (backend defaults to "claude")
  orienter:          { model: sonnet, effort: high }
  planner:           { model: opus,   effort: high }
  decomposer:        { model: sonnet, effort: high }   # plan → work items (a planning act)
  prototyper:        { model: sonnet, effort: medium }
  contractGenerator: { model: sonnet, effort: high }
  contractEvaluator: { model: opus,   effort: high }
  generator:         { model: sonnet, effort: high }
  evaluator:         { model: opus,   effort: high }
  reviewer:          { model: opus,   effort: high }   # code-review gate (opt-in; see `review`)
  committer:         { model: haiku,  effort: low }    # authors commit(s) when git.agentCommits=agent
  reflector:         { model: opus,   effort: high }
  conductor:         { model: sonnet, effort: medium }  # `sparra conduct` brain (hybrid/llm); sees only holdout-safe summaries
  # Cross-backend example: generator: { backend: codex, model: gpt-5-codex }
  # Hybrid (local for trivial/sensitive items, cloud for the hard ones):
  #   generator:      { backend: codex, model: gpt-5-codex }
  #   generatorLocal: { backend: codex, model: qwen3.5-9b, baseUrl: http://localhost:1234/v1 }  # LM Studio
  # Fallback model when the primary's backend is rate/usage-limited (needs build.autoRestart):
  #   generator: { backend: codex, model: gpt-5-codex, fallback: { backend: claude, model: opus } }
  # QUALITY escalation — a stronger role the generator switches to after build.escalateAfterRounds
  # FAILED rounds on an item (quality-triggered, vs the limit-triggered fallback above):
  #   generator: { model: sonnet, escalation: { model: opus, effort: high } }
  # Widen a Codex WRITE role's native sandbox for toolchains the default profile blocks (xcodebuild):
  #   generator: { backend: codex, model: gpt-5-codex, sandbox: danger-full-access }  # needs a worktree

conduct:                      # `sparra conduct` (headless conductor) intelligence
  brain: hybrid               # hybrid (deterministic loop + LLM at judgment points) | llm (brain drives turn-by-turn)
  decisions:
    surface: park-timeout     # park (wait for a human) | park-timeout (auto-resolve after timeoutSec) | auto (never park; --auto)
    timeoutSec: 1800          # seconds a parked decision waits before the brain/deterministic policy decides
# The conductor brain uses `roles.conductor` (default claude/sonnet/medium) and sees ONLY holdout-safe
# ParentSummary-derived material. Answer a parked decision from the file, an inline TTY prompt,
# `sparra conduct --decide <runId> <seq> <answer> [--note "…"]` in another terminal, OR the HTTP bridge
# (`POST /jobs/:id/decision`) — see docs/http-bridge.md.

permission:
  mode: auto                  # auto (default) | acceptEdits | plan ; never bypassPermissions
  denyBashContains: ["rm -rf /", "git push", "shutdown", "mkfs", ":(){", "curl | sh", "sudo "]

git:
  strategy: worktree          # worktree | branch | inplace
  branchPrefix: "sparra/"
  autoCommit: false           # true → commit each accepted item, ONLY on the Sparra
                              # worktree/branch (never your main branch / in-place)
  agentCommits: agent         # agent → the `committer` role splits the diff into atomic
                              # conventional commit(s), harness executes (model never runs
                              # git), Sparra-Item trailer appended, sweep + template fallback.
                              # template → one deterministic commit from item title/summary.
  provisionDeps:              # copy the repo's deps into the worktree so verify/eval can run there
    enabled: true             # false → skip (e.g. you provision node_modules yourself)
    dirs: ["node_modules"]    # top-level dirs to copy (copy-on-write where supported, never symlinked)
    swiftPackages: true       # SwiftPM package? prewarm `swift package resolve` into the durable
                              #   worktree-local cache so an offline swift build/test runs as-shipped
                              #   (non-fatal no-op off-knob / non-Swift / in-place)
  pullBeforeWork: false       # true → before build/conduct/prototype cut a FRESH workspace from
                              #   local HEAD, fast-forward-only sync the current branch with its
                              #   upstream (`git pull --ff-only`), so a stale local clone doesn't
                              #   silently build on stale code. Skipped (non-fatal note, no
                              #   fetch/pull attempted) with no repo, no commits, a detached HEAD,
                              #   or no upstream configured; a failed pull (offline, diverged)
                              #   never blocks the run. Never pushes, never touches another branch.
                              #   Applies to build's fresh worktree/branch (not resume, not
                              #   --workspace-override), a fresh `conduct` run (once, before any
                              #   unit worktree — never on --resume), and `prototype`'s worktree.
                              #   Default false (opt-in; today's behavior unchanged).

rubric:
  weights: { design: 0.25, originality: 0.15, craft: 0.3, functionality: 0.3 }
  passThreshold: 75
  useCalibration: true        # read .sparra/calibration/{good,slop}/ to match your taste
  anchorFunctionality: true   # with any FAILED contract assertion, cap the functionality score
                              #   at round(100 × passed/total) — a ceiling only (never a boost),
                              #   noted in the verdict; no assertions → no cap; false disables

pivot:
  N: 3                        # GAN restart after N rounds below threshold on one criterion
  threshold: 50
  resetWorkspace: true        # on a pivot, reset the workspace to the item-start state (revert
                              #   tracked changes + remove non-ignored untracked files; gitignored
                              #   scratch survives — clean WITHOUT -x) so the fresh generator can't
                              #   re-anchor on the failed attempt's files. Default true but INERT
                              #   unless an exact Sparra-owned anchor holds at reset time:
                              #   git.autoCommit on (HEAD == item-start), a recorded Sparra branch
                              #   that carries git.branchPrefix (a recorded "main" refuses — the
                              #   reset only ever targets Sparra-owned branches), and the
                              #   workspace's live git branch matching it (no-git, detached HEAD,
                              #   branch mismatch all refuse). In-place runs never reset.
                              #   The pivot's attempt LEDGER (see build-loop.md) is unaffected.

contract:
  assertionMin: 6             # upper guide, scaled per item
  assertionMax: 20
  maxNegotiationRounds: 6
  probeVerifyCommands: true   # harness dry-runs the agreed contract's "I will verify by" commands
                              #   (no model, safe executor, cwd=workspace); a USAGE error (command not
                              #   found / unknown flag / usage text) or an UNSAFE command (safety-rule-
                              #   rejected — the harness can never run it) bounces the contract back
                              #   into negotiation with the probe output; false skips the probe.
                              #   The executor is allowlist-by-default: unknown tools are rejected, and
                              #   npm/yarn/pnpm/bun run ONLY as test / run <script> / run-script <script>
                              #   (npm version, npm install, a bare yarn are unsafe pre-spawn; so are
                              #   cargo publish, go clean, mvn deploy, …) — declare anything else in
                              #   build.verifyCommands to opt in

build:
  maxItems: 12                # cap on how many work items a decomposition may produce; extra
                              #   items are clamped (head kept, with a warning); 0 = no cap
  jsonReask: true             # on an unparseable generator report / evaluator verdict, re-ask
                              #   ONCE on the same session ("re-emit ONLY the JSON block") before
                              #   the usual fallback (degraded report / forced FAIL). Also recovers
                              #   a forfeited report on a CAP death (autonomous + interactive): a
                              #   writer that hit OUR budget cap OR the turn cap with work landed but
                              #   no parseable report gets one tight (1-turn), text-only report-only
                              #   re-ask before the conductor steps in — the cap state (hitBudget /
                              #   hitMaxTurns) stays set, so recovery never masks the cap
  maxRoundsPerItem: 6
  maxTurnsPerSession: 60
  escalateAfterRounds: 0      # quality escalation: after this many FAILED rounds on an item, switch
                              #   its generator to roles.<generator>.escalation for the remaining
                              #   rounds (blocked/limit-retried rounds don't count); 0 = off
  assertionEscalateAfter: 2   # per-ASSERTION feedback escalation (K): once the SAME contract
                              #   assertion FAILS this many consecutive rounds, its next patch
                              #   feedback UNCAPS that assertion's evidence + prepends a diagnose-first
                              #   instruction naming the id — a register between a plain patch and a
                              #   full GAN pivot (blocked/all-un-run rounds don't count; a pivot
                              #   resets the streaks); 0 = disabled
  maxBudgetUsdPerItem: 5      # notional USD cap (tokens × list price); 0 = no cap
  maxTokensPerItem: 0         # direct token ceiling — the lever on a subscription/Codex; 0 = no cap
  zeroCostTokenCap: 0         # fallback token ceiling when USD cap is active but reported cost is
                              #   zero/unknown and maxTokensPerItem is off; 0 = no fallback cap
  autoRestart:                # wait out (or fall back from) a provider rate/usage limit
    enabled: false            # off by default; on → an unattended build can sleep for hours
    maxWaitSec: 21600         # cap on ONE wait (6h — long enough for a Claude 5-hour window)
    pollSec: 300              # recheck cadence when the backend gives no reset time (e.g. Codex)
    maxRestarts: 20           # total wait cycles before stopping (resumable via `sparra build`)
  env: {}                     # string env vars injected into build SDK sessions, evaluator
                              #   run_command spawns, and verify/measure command spawns; merged
                              #   over process.env, so PATH/auth vars survive and build.env wins
  skills: []                  # agent skills for the builder roles, e.g. ["xcodebuildmcp-cli", "swiftui-design"]
                              # (per-role override: roles.<role>.skills)
  verifyCommands:             # commands the GENERATOR may self-run (typecheck/test/build) to stop
    [npm test, tsc, ...]      #   writing blind — auto-approved on a worktree boundary, or in-place via
                              #   run_role `allowVerify` / `--verify`; [] disables. Also the explicit
                              #   opt-in for the harness executor's argv[0] allowlist (probe/rerun gate,
                              #   AND the evaluator's `baselineCommand` allowlist — see below):
                              #   unknown tools are rejected by default; a prefix match here allows them.
                              #   PIPE SPLIT / ENV-PREFIX: the harness EXECUTOR (probe/rerun/preflight/
                              #   measure) spawns argv with no shell and rejects EVERY pipe AND every
                              #   leading env-var assignment (`npm test | tail` and `TMPDIR=/x npm test`
                              #   are both unsafe there). The generator's self-verify Bash ALLOW-HOOK
                              #   provides two narrow carve-outs:
                              #   (1) A leading LITERAL env-var assignment (`KEY=VALUE …`) is stripped
                              #   and the core is re-checked against the allowlist — so
                              #   `TMPDIR=/tmp/sprj-x npm test` and `LANG=C LC_ALL=C npm run typecheck`
                              #   are granted. KEY must be a valid identifier; VALUE (after stripping
                              #   one optional matched quote pair) must be metacharacter-free (no $,
                              #   backtick, ;|&<>\, unmatched quote, or whitespace). Multiple
                              #   assignments are allowed; an empty value (KEY=) is valid.
                              #   (2) A read-only output-shaping filter pipe AFTER an allowlisted
                              #   command (`npm test 2>&1 | tail -5`) — the left stage is re-checked
                              #   for forbidden tokens so nothing launders behind the prefix, and each
                              #   filter stage is arg-validated (no file read/write).
                              #   Both compose: `TMPDIR=/x npm test | tail -20` strips the prefix then
                              #   routes the core through the filter-pipe check. See build-loop.md.
                              # `baselineCommand` (per-call CLI/MCP flag, not a config key) — evaluator-
                              #   only, opt-in: `run_role baselineCommand=<cmd>` / `sparra eval/role run
                              #   --baseline-command <cmd>`. Requires `evalBaseRef`. The RUNNER (not the
                              #   generator) runs the allowlisted command at the base ref SHA in a
                              #   throwaway DETACHED worktree, captures output (capped 10 KB), and injects
                              #   a runner-owned `[VERIFIED BASELINE @ <sha>]` block the evaluator trusts
                              #   over any prose carveout. The command must prefix-match a
                              #   `build.verifyCommands` entry (no shell expansion, no pipes). Infra
                              #   failures → UNAVAILABLE note; eval proceeds. See docs/role-runner.md.
  flakinessReruns: 2          # after a PASSING verdict the harness re-runs the contract's verify
                              #   commands this many times; ANY non-ok result demotes the pass to a
                              #   failed round (mixed exits = FLAKY, all-nonzero = failing-as-shipped,
                              #   UNSAFE = safety-rule-rejected/never ran) with the command + output
                              #   as blocking feedback; 0 = off
  flakinessLoadRerun: false   # off by default. When on AND flakinessReruns >= 1, the rerun gate ADDS
                              #   >=1 further pass of each command run while a bounded, self-terminating
                              #   background CPU-load process runs concurrently — IN ADDITION to (not
                              #   replacing) the quiet reruns — so a suite that only times out under
                              #   machine load (e.g. a test firing a live network/SDK call, visible only
                              #   as a load-dependent hang) is classified flaky/failing deterministically
                              #   instead of by luck of ambient load. NO-OP when flakinessReruns is 0 or
                              #   this knob is off (no load process spawned). Off keeps Sparra's own CI
                              #   unaffected; opt in for load-sensitive gates
  preflightVerify: false      # PRE-evaluator gate (no model): after each generation and BEFORE the
                              #   evaluator, run the contract's own verify commands via the safe
                              #   executor; a deterministic BEHAVIORAL failure SKIPS the evaluator that
                              #   round and bounces back to the generator with the (holdout-redacted)
                              #   output — so a gen that fails its own gates never costs an evaluator
                              #   session. usage/unsafe/all-green fall through to eval; capped at one
                              #   bounce before the evaluator must run; false (default) = off
  distillTechnique: false     # on item terminal (pass OR fail) distill ONE transferable TECHNIQUE —
                              #   what FIXED (or was tried on) the item — from the item's durable round
                              #   history (last report + attempt ledger) and append it to memory.md as a
                              #   marked (`technique:`), holdout-redacted `note`, within the existing
                              #   memory caps. Deterministic (no model call), never the score/bookkeeping,
                              #   once per item across resume; false (default) = memory exactly as today
  extraReadDirs: []           # extra dirs the build may READ (e.g. ["~/.cache/models"]) — for big
                              # assets you don't want in git; pre-stage once, no commit, no network

format:
  enabled: true               # master switch; false → no formatting at all
  command: ""                 # "" → auto-detect (prettier; existing repos detect from CODEBASE_MAP.md).
                              #   A non-empty command is an explicit opt-in and ALWAYS runs (e.g.
                              #   "sh -c 'swiftformat {file}; swiftlint --fix --path {file}'").
  autodetect: true            # auto-detect a formatter by file type — but an autodetected formatter
                              #   only runs when the tool's config is discoverable (see notes)

measure:                                     # post-accept QA harness (opt-in; a SIGNAL, never a gate)
  enabled: false              # off by default; a config-less run is unaffected
  command: ""                 # a SINGLE argv command that prints a JSON `metrics` object on stdout
                              #   (e.g. "npm run qa:metrics") — no pipe/&&-chain (it runs no-shell,
                              #   same safe executor as build.verifyCommands; its value is the argv[0]
                              #   allowlist opt-in). See the metric-emission contract below.
  baselineFile: ""            # "" → .sparra/measure/baseline.json (always under the MAIN repo .sparra,
                              #   so it survives an isolated worktree build)
  regressionThreshold: 0.05   # flag a metric regressed when it worsens (per its goal) by > 5%
  defaultGoal: min            # goal for a bare-number metric with no explicit goal (min = lower better)

exercise:
  mechanism: cli              # cli | web | ios | computer-use | custom
  runExistingTests: true
  requireObservedRun: true    # demote an UNOBSERVED pass (zero mcp__exercise__ activity) to fail — cli/web only, and only on an in-process-MCP eval backend (Claude)
  sandbox: workspace-write    # read-only | workspace-write — Codex evaluator's EXERCISE sandbox
  existingTestCommand: ""      # auto-detected from CODEBASE_MAP.md if empty
  customRecipe: ""
  web: { startCommand: "", baseUrl: "http://localhost:3000" }
  ios: { cli: "xcodebuildmcp", scheme: "", simulator: "", platform: "ios", visual: true }   # platform: "macos" runs the .app on the host + verifies via XCUITest; visual: true → screenshot + animation contact-sheet recipe (see docs/ios.md)

deviation: { strictness: moderate }        # strict | moderate | free (defaulted by mode)

review:                                    # opt-in agent code-review gate (off by default)
  enabled: false
  blockOn: high                            # high (security/correctness/dead-code) | all | none

batch: { K: 3 }

scriptHooks: {}                            # user scripts at lifecycle points; {} = no hooks (default). See "Script hooks" below.
```

## Notes on a few knobs
- **`roles.*.backend`** — `claude` (default) or `codex`. See [backends](backends.md). Decomposition reads best on Claude; keep `decomposer` there if you put the builder on Codex.
- **`roles.*.baseUrl` / `roles.*.apiKey`** — point a role at an OpenAI-compatible endpoint instead of the backend default — a hosted aggregator like **OpenRouter** (any model it fronts, with a real key) or a **local** server like LM Studio (`http://localhost:1234/v1`) / Ollama (key is a dummy). Only the **`codex`** backend honors it (Codex supplies the agent loop + tools; only the model is swapped). `model` is then that endpoint's model id. Keep a real key out of a committed `.sparra/config.yaml`. See [backends — OpenAI-compatible endpoints](backends.md#openai-compatible-endpoints-openrouter-lm-studio-ollama).
- **`roles.*.sandbox`** — `workspace-write` (default) | `danger-full-access`, for a **write** role on the **`codex`** backend (Claude has no OS sandbox and ignores it). `workspace-write` scopes writes to the work tree with no network; `danger-full-access` lifts the sandbox so a Codex generator can run native toolchains the default Seatbelt profile blocks — e.g. `xcodebuild`. **Read-only roles ignore this — they are always `read-only`.** **Safety:** `danger-full-access` is honored **only when the build runs on a git worktree/branch** (`git.strategy: worktree`/`branch`); on an in-place / greenfield-no-git run it is downgraded to `workspace-write` with a loud warning (the worktree is the only safety boundary, since Codex runs with no interception hooks). See [backends — per-role sandbox](backends.md#per-role-sandbox-codex--the-worktree-safety-gate).
- **`roles.generatorLocal`** — an optional **second generator** for **hybrid builds**. Work items the decomposer tags `gen: "local"` (trivially-simple or privacy-sensitive) build on `generatorLocal`; everything else uses `generator`. Unset → all items use `generator`. You can add/remove the `gen` tag per item in `.sparra/workitems/items.json` before building (the decomposer only proposes it, and only when `generatorLocal` is configured).
- **`permission.mode`** — `auto` uses the SDK's model-classifier approvals when available on your plan, else `acceptEdits`; either way a deny-hook (Claude) / sandbox (Codex) enforces scope. `bypassPermissions` is refused. The interactive role-runner surfaces (`run_role`, `sparra role run`, `sparra eval`) probe `auto` availability the same way the build phase does — cached in `state.autoSupported` when a real `.sparra/state.json` exists (memory-only, no litter, on a config-less repo) — so interactive writer roles get the richer permission mode.
- **`measure`** — the post-accept **measurement/QA step** (see [build-loop](build-loop.md#measure)). After an item is accepted it runs `measure.command`, parses structured metrics from stdout, diffs them against a stored baseline, flags regressions, records an artifact under `.sparra/measure/`, and appends a memory line that reflect reads. It is **non-blocking by design** — a regression is a *signal*, never a gate: the item stays `passed` and the commit proceeds regardless. Also a standalone `sparra measure [dir] [--worktree] [--set-baseline] [--out f]` (default **compare-only** — the baseline is written only with `--set-baseline` or the build loop's own accept). **Metric-emission contract:** `measure.command` prints a JSON object on stdout (tolerant of leading log lines — Sparra parses the **LAST** top-level JSON object that carries a `metrics` field):
  ```json
  { "metrics": { "p50_ms": 12.3, "accuracy": { "value": 0.94, "goal": "max", "unit": "ratio" } } }
  ```
  A **bare number** uses `measure.defaultGoal`; an **object** metric declares its own `goal` (`min`|`max`) and optional `unit`. **Regression rule:** `goal:"min"` regresses when `(current-baseline)/baseline > regressionThreshold`; `goal:"max"` when `(baseline-current)/baseline > regressionThreshold`. A metric **absent from the baseline** (or whose baseline value is `0`) is `isNew` — recorded, never a regression. **Unparseable / no-metrics stdout** (or a non-zero exit / unsafe command) is a non-fatal note and does **not** overwrite the baseline. Because the command runs no-shell, `measure.command` must be a single argv invocation (`npm run qa:metrics`), not a pipe/chain.
- **`format`** — the PostToolUse formatter that runs on each file the generator writes. Two escape hatches frame the behavior: a **non-empty `command`** is an explicit opt-in and **always** runs (with `{file}` substituted, else the path appended); `enabled: false` disables everything. When `command` is empty and `autodetect: true`, Sparra picks a formatter by file type **but only auto-applies one whose config is discoverable for that project** — otherwise stock rules would reindent a repo that doesn't format that way and churn diffs. Concretely for Swift: an autodetected **swiftformat** runs only when a `.swiftformat` config is found by walking **up** from the written file's directory to (and including) the workspace root (its own dir or a true ancestor — never an unrelated sibling subtree). With no such config (including a brand-new greenfield project), no swiftformat is run — set `format.command` to opt in explicitly. (`swiftlint --fix` is a linter, not a reformatter, and is not config-gated.)
- **`git.provisionDeps`** — a `git worktree` is a bare checkout with **no `node_modules`**, so the generator's verify commands and the evaluator's `npm test` couldn't run there. With this on (default), Sparra **copies** the listed dep dirs from the repo into the worktree once, after it's created — a **copy-on-write** clone where the filesystem supports it (cheap), **never a symlink** (an outside-pointing link would break the workspace-write scratch sandbox). It's a no-op for in-place runs, when the dir already exists in the worktree, or when a dir is itself a symlink (a pnpm/monorepo hoist is skipped, not copied); a copy failure is non-fatal (warn + continue). This applies both to the build loop's worktree **and** to a standalone `sparra eval`/`role run` whose workspace is a linked git worktree — so a worktree eval gets its deps without a manual `npm install`. Set `enabled: false` if you provision deps yourself.
  - **`swiftPackages`** (default `true`) — during the same provisioning step, if the source tree is a **SwiftPM package** (`Package.swift` present), Sparra runs a `swift package resolve` **prewarm** — while the network is still available — into the **durable, worktree-local SwiftPM cache** (`SWIFTPM_CACHE_DIR`, see the scratch env layer above) that the generator/evaluator/contract sessions of that worktree consume, so a later **offline** `swift build`/`swift test` in the throwaway worktree reuses the resolved dependencies instead of failing to resolve. It's a **non-fatal no-op** when the knob is off, on a non-Swift project (no `Package.swift`), or in-place; a prewarm failure is warned + recorded, never aborting provisioning. Non-Swift projects see no behavior change. Set `false` to skip the prewarm.
- **`contract`** — the assertion range is an *upper guide*, scaled down for small items; the evaluator rejects padding and over-specification. See [build loop](build-loop.md).
- **`build` budgets** — start-closed; crossing the USD **or** token cap halts an item as `BUDGET_EXCEEDED` and the run continues. `total_cost_usd` is notional on a subscription — use `maxTokensPerItem` there. `zeroCostTokenCap` is a fallback token cap used only when `maxBudgetUsdPerItem > 0`, the item reports zero/unknown cost, and `maxTokensPerItem` is `0`; set it to `0` to disable the fallback.
- **per-call budget override (role-runner)** — the standalone role surfaces take a one-off USD cap that overrides `build.maxBudgetUsdPerItem` **for that single call**: the MCP `run_role` tool accepts an optional numeric `maxBudgetUsd`, and `sparra role run` / `sparra eval` accept `--budget <usd>`. Omit it to use the configured per-item cap (unchanged behavior). `0` means **unlimited** (same convention as `maxBudgetUsdPerItem`) and is preserved as `0` end-to-end — e.g. `sparra eval ./wt --budget 0` runs uncapped, `--budget 25` caps that run at $25.
- **per-call turn-cap override (role-runner CLI only)** — `sparra role run` / `sparra eval` accept `--max-turns <n>`, overriding `build.maxTurnsPerSession` for that single call, exactly mirroring `--budget`'s CLI shape. It **diverges** from `--budget` in one way: only a **positive integer** (`n >= 1`) is accepted — `0`, negative, fractional, or non-numeric input falls back to the configured `build.maxTurnsPerSession` rather than being preserved as an "unlimited" sentinel, since an unbounded turn cap has no natural stopping point. The MCP `run_role` tool does **not** expose a `maxTurns` argument (out of scope for this flag; MCP callers still get `build.maxTurnsPerSession`).
- **`--worktree` / `--keep-worktree` (role-runner)** — `sparra eval --worktree` (and `role run --worktree` for the **read-only judge roles — evaluator, reviewer, and contract-evaluator**) runs the role in a **temporary linked git worktree** snapshotted from the selected workspace's **current WIP** (uncommitted tracked edits, untracked non-ignored files, tracked deletions — the snapshot goes through a throwaway index, so your real index/HEAD/tree are never touched). Because the workspace *is* a linked worktree, the existing paths apply unchanged: deps are provisioned per `git.provisionDeps`, the exercise/verify probe gets **writable scratch** per `exercise.sandbox` (no in-place EPERM on `node_modules/.vite-temp` etc.), and the source-integrity guard still reverts any judge write to the tracked source. The worktree (detached; no branch/ref is created) is **removed after the run**, even on error — teardown is scoped to the temp dir only, never your main tree; `--keep-worktree` retains it for inspection and prints its path. A **writer/generator is rejected** with a clear message (it gets its build worktree via the full loop). Without `--worktree`, in-place eval behavior is unchanged.
- **`build.autoRestart`** — the "heartbeat" for **unattended** builds: when the generator or evaluator hits a real **provider** rate/usage/session limit (vs. your own budget caps), the loop either switches to a configured **`fallback`** model or **waits** for the window to reopen, then retries the **same** round — instead of burning it. Off by default (opting in lets a build sleep for hours). State is checkpointed before each wait, so a kill mid-wait still resumes from disk; `sparra status` shows a paused build as *waiting until …*. After `maxRestarts` wait cycles it stops cleanly — re-run `sparra build` to resume. See [build loop](build-loop.md#auto-restart--model-fallback-on-provider-limits).
- **`roles.*.fallback`** — a backup `RoleConfig` (model/backend/effort/…) used when the primary role's **backend** is in a limit window (requires `build.autoRestart.enabled`). Best pointed at a **different provider** (e.g. primary `gpt-5-codex` on Codex → fallback `opus` on Claude): on a limit the loop switches models and keeps going with **no wait**, switching back once the primary's window reopens. Chainable (a fallback may have its own `fallback`); a fallback on the same, also-limited backend is skipped. Limits are keyed by backend because a plan window (e.g. Claude's 5-hour) is account-wide across that provider's models.
- **`roles.generator.escalation`** + **`build.escalateAfterRounds`** — opt-in **quality escalation**, distinct from `fallback`: `fallback` is *limit*-triggered (the backend is in a provider limit window), `escalation` is *quality*-triggered (the evaluator keeps failing the item). With `escalateAfterRounds: N` (> 0) and an `escalation` RoleConfig on the generator role (or on `generatorLocal` for `gen: "local"` items — each role escalates via its **own** `escalation`, or never), an item that accumulates **N FAILED rounds** switches its generator to the escalation role for the item's **remaining rounds** — per-item (the next item starts back on the primary), one level, one-way (no de-escalation), with a **new session** on the switch (round feedback carries the context; same rule as a backend change). Blocked (inconclusive) rounds and limit-retried rounds don't count toward N. The switch is logged and appended to memory as a note. Limit handling is unchanged: when the escalated role's backend hits a limit, **its** `fallback` chain applies exactly as today, and a limit-fallback round doesn't advance the counter. Default `0` (off). See [build loop](build-loop.md).
- **`exercise.sandbox`** — `workspace-write` (default) | `read-only`. The sandbox the **Codex evaluator** EXERCISES under (Claude exercises via an in-process runner and ignores this). `workspace-write` lets the exercise write the scratch test/build tools need (e.g. `node_modules/.vite-temp`, tsc/test caches) so `npm test`/`tsc` actually run, with **network off**; a runner-level **source-integrity guard** reverts + **fails** any write the evaluator makes to the artifact surface (tracked + new non-ignored files), so it still can't mutate the code it grades. Only relaxed on an **isolated-checkout boundary** — a Sparra build branch (`state.build.branch`) **or a linked git worktree** (so a standalone `sparra eval`/`run_role` on a worktree gets scratch without editing `state.json`); a plain in-place run on the main worktree stays `read-only`. `read-only` forces Codex's strict no-write sandbox (the pre-fix behavior — exercising tools that need scratch will `EPERM`). See [backends](backends.md#per-role-sandbox-codex--the-worktree-safety-gate).
- **`exercise.requireObservedRun`** — the **observed-run gate** (default `true`). A PASS verdict where the harness observed **zero** `mcp__exercise__` activity (`run_command`/`http_request` never used — `exerciseStatus` classified as "none") rests on pure self-report, so it is **demoted to fail** with a blocking note telling the evaluator to run gating commands via `run_command`. Applies only to mechanisms **`cli`** and **`web`**, where those tools ARE the exercise path; `ios`/`computer-use`/`custom` are exempt (exercising there legitimately flows through tools the classifier can't see). Failing verdicts are untouched. **Backend-aware:** the gate fires only when the eval backend can host the in-process exercise MCP server (`BackendCapabilities.inProcessMcp` — Claude). On a backend without it (Codex), the `mcp__exercise__*` tools are never attached, so **zero** `mcp__exercise__` activity is EXPECTED and does **not** demote an otherwise-passing verdict (that evaluator exercises via its native runner and self-reports `exerciseStatus`). Set `false` to opt out. See [build loop](build-loop.md#exercisers) and [backends](backends.md).
- **`exercise.ios`** — full Apple-platform guide in [docs/ios.md](ios.md).
- **`exercise.ios.visual`** — (iOS only, default `true`) injects the **visual-verification recipe** into the evaluator's iOS guidance so the multimodal grader can put *eyes* on Simulator-runnable UI/animation: a static **screenshot** chain (boot → build with `-derivedDataPath` + `CODE_SIGNING_ALLOWED=NO` → `simctl install`/`launch <args>` → `simctl io … screenshot` → Read the PNG + an accessibility-hierarchy dump) **and** an **animation** chain (`simctl io … recordVideo --codec=h264` → `ffmpeg … -vf "fps=N,scale=W:-2,tile=CxR"` → Read ONE contact sheet, judged start→mid→end, coarse-then-dense two-pass). It also carries the `#if DEBUG` launch-arg deterministic-reach convention, the **honest boundary** the evidence must state (geometry/layout/nav/transition-shape are proven; motion feel, jank, 120 Hz, gesture interruptibility, and GPU/ML paths are **not**), and **UN-RUN** semantics (Simulator/`ffmpeg` unavailable → the affected visual gates are environment-blocked, never failed and never passed via a weaker fallback). Set `false` for the pre-recipe iOS guidance (byte-identical to before the knob existed). Needs **`ffmpeg`** for the animation contact sheet. Full flow in [docs/ios.md](ios.md#visual-verification-screenshots--animation-contact-sheets).
- **`review`** — an optional agent code-review gate after the behavioral evaluator passes (a second lens for code quality the exerciser can't see). Off by default; see [build loop](build-loop.md#code-review-optional). Best with `roles.reviewer.backend` set to a *different* family than the generator.
- **`evaluator.secondOpinion`** + **`roles.evaluatorSecond`** — an optional **second-opinion gate** on accepts (off by default). The evaluator is otherwise the *sole* quality gate, so a lenient mid-tier evaluator can quietly launder slop. When `evaluator.secondOpinion.enabled` is on, **only on a PASS verdict** (bounded cost), a second evaluator (`roles.evaluatorSecond`) on a **different backend/model** re-grades the *same* inputs; if it produces a real `fail` the accept is **demoted** to a failed round whose feedback carries the second opinion's merged, **holdout-redacted** blocking (marked as a second-opinion disagreement), and the generator patches again. **Independence guard:** the gate is a **no-op with a warning** when `evaluatorSecond` is unset **or** resolves to the *same* effective backend+model as the *actually-selected* primary evaluator (i.e. after fallback resolution) — a same-model second opinion is pointless. **Bounded / laundering-proof:** it runs only on a primary PASS and demotes **only on a real fail** — a second grade that hit a provider **limit** / **empty completion**, or whose exercise was **blocked** / had **all assertions un-run**, is treated as *no second opinion* (accept proceeds), while a garbled, non-empty, non-limit completion that couldn't be parsed normalizes to `fail` and demotes (fail-closed). Its cost folds into the item budget like the review gate's. Best with `roles.evaluatorSecond.backend` on a *different* family than `roles.evaluator`. See [build loop](build-loop.md#second-opinion-gate-optional).
- **`build.skills` / `roles.*.skills`** — agent skills (SKILL.md) made available to a role. Builder roles (`generator`, `prototyper`) inherit `build.skills`; other roles (e.g. `evaluator`) opt in via their own `roles.<role>.skills`. Resolved from the repo's `skills/`, `~/.claude/skills`, or `~/.agents/skills` (or an explicit path). See [backends — skills](backends.md#skills). Example: `roles.evaluator.skills: ["xcodebuildmcp-cli"]` to give the iOS grader your build/run skill.
- **`docsDir`** — subfolder (relative to the repo root) for the human-facing docs Sparra manages — `PLAN.md`, `CODEBASE_MAP.md`, `CHANGELOG.md`, `HOLDOUT.md`. `""` (default) keeps them at the root; e.g. `docs` puts them under `docs/` to keep the root uncluttered. Set it at `sparra init --docs <dir>` (it's baked into `config.yaml`); `.sparra/` machinery stays put regardless.
- **Contract-evaluator verification boundary** — a Claude contract-evaluator may auto-run configured bare `build.verifyCommands` only on an isolated autonomous worktree or `role run --kind contract-evaluator --worktree`. It uses the shared strict allow-hook; chains, redirects, network/install commands, mutations, and non-allowlisted commands are not granted. In-place contract evaluation gets no grant, and Codex relies on its OS sandbox rather than hooks.
- **`build.verifyCommands`** — verification commands the **generator** may self-run (auto-approved) before finishing, so it stops "writing blind" — typecheck/test/build (e.g. `npm test`, `tsc`, `swift test`). A Bash command is auto-approved only when it **starts with** one of these **and** contains no command-chaining (`&&`/`;`/`|`), redirect, network install, mutation, or commit — so `npm test`/`tsc --noEmit` run but `npm test && rm -rf x`, `curl …`, `npm install`, `git commit` do not. Auto-approval is **deterministically enabled on any git worktree/branch boundary**: (1) the full autonomous build loop's `build.branch` (the Sparra-managed branch), and (2) a **linked git worktree** — which includes both a `unitWorktree` persistent per-unit generator tree and a `sparra eval --worktree` snapshot. On all boundary cases the allow-hook (`allowVerifyBash`) is used directly — no dependency on the `autoSupported` probe. An **in-place** `run_role` with no worktree/branch opts in separately via `allowVerify: true` / `sparra role run --verify` (generator only) — same strict allow-hook, just dropping the boundary precondition. **`unitWorktree` generators get self-verify automatically** (no `allowVerify` needed) because their workspace IS a linked worktree. **Codex** confines these to its workspace-write sandbox (no network); **Claude** has no OS sandbox, so for Claude these run with the worktree + "never commit to main" + the disqualifier list as the only guarantees (the same residual as the evaluator's exercise). Set to `[]` to disable generator self-verification. See [build loop](build-loop.md#generate). Two caveats on the generator self-verify surface (`run_role` / `sparra role run --kind generator --verify` — NOT `sparra eval`, the evaluator alias, where `--verify` is a no-op): **(a) each `verifyCommands` entry must be a single, directly matchable command** — chained/subshell forms (`(cd X && swift test)`, `a && b`) and multi-stage pipes (`a | b | c`) never match as a config entry, because the harness executor prefix-matches one bare command and any chain/pipe/redirect token disqualifies it for the no-shell executor; list `swift test` itself and point the role's workspace at the right directory instead. (The generator's call-time Bash allow-hook does support a leading literal env-var assignment and/or a trailing output-shaping filter pipe, as described above — that flexibility is allow-hook-only and does NOT affect what you write in `build.verifyCommands`.) **(b) a config-less ad-hoc run falls back to the DEFAULT `verifyCommands`** (npm/tsc/vitest/swift/cargo/go/pytest/make defaults), so a project with its own gates (`make seed`, a custom script) must declare them in `.sparra/config.yaml` `build.verifyCommands` before the generator can self-verify them.
- **`build.preflightVerify`** — a **pre-evaluator gate** (no model), off by default. When on, after each generation and **before** the adversarial evaluator, the harness runs the contract's own *"I will verify by"* commands once via the same safe executor as the rerun gate (reusing `build.verifyCommands` as the argv[0]-allowlist opt-in and `build.env` as the environment). A **deterministic behavioral failure** (a command ran, exited nonzero, and isn't a broken *usage* or *unsafe* command) **skips the evaluator that round** and bounces straight back to the generator with the failing command's rendered, **holdout-redacted** output framed as a *preflight* failure — so a generation that deterministically fails its own gates never costs a full evaluator session. **usage** (command broken as written), **unsafe** (safety-rule-rejected, never ran), and **all-green** outcomes fall through to the evaluator unchanged. Capped at **one bounce before an evaluator round must run** (durable per-item state, so the cap survives a resume); a preflight bounce advances `st.round` like a failed eval round. See [build loop](build-loop.md#generate).
- **`build.env`** — a string map of environment variables injected into the build's real execution surfaces: agent SDK sessions, evaluator `mcp__exercise__run_command` spawns, and the harness verify/measure command executor. Values must be strings; `FOO: 1`, booleans, objects, and null are rejected at config load with the key named. Sparra merges this map over `process.env` before injection because both shipped SDKs replace inherited env when an env object is supplied; `PATH`, auth variables, and other process env entries are preserved unless a `build.env` key intentionally overrides them. Empty/missing `env` preserves prior behavior.
- **default writable-scratch env layer (all sandboxed build sessions)** — the **evaluator**, the **contract-evaluator**, the **generator/writer**, and the **contract-negotiation** sessions run under a native sandbox / an unwritable `$HOME`, which EPERMs otherwise-innocent tooling *before any Sparra code runs*: Vitest's `node_modules/.vite-temp` + `/var/folders` temp writes, the tsx launcher's IPC socket **path** under `os.tmpdir()`, and clang's `~/.cache/clang/ModuleCache`. (The redirect fixes the socket *path*'s writability only — the sandbox still denies unix-socket `listen(2)` as **policy**; so the judge/evaluator sessions ALSO set **`SPARRA_JUDGE_SANDBOX=1`**, under which every real-CLI/tsx-subprocess suite vitest-SKIPS visibly (shared `test/helpers/judgeEnv.ts`), leaving the full suite EXPECTED green and a nonzero exit a REAL signal — no longer UN-RUN / mixed; see [backends → known-capability matrix](backends.md#known-sandbox-capability-matrix-surfaced-to-the-judge).) So for those sessions Sparra injects a **default env layer** (`src/build/judgeScratch.ts`, `createSandboxSessionEnv`) that redirects `TMPDIR`, `CLANG_MODULE_CACHE_PATH`, and `SWIFTPM_CACHE_DIR`. `TMPDIR` + `CLANG_MODULE_CACHE_PATH` point at a fresh **per-run writable scratch dir** (`<tmp>/sprj-<hex>/…`, regenerable), while **`SWIFTPM_CACHE_DIR`** points at a **durable, worktree-local** cache (`<tmp>/sparra-swiftpm/<hash>`, keyed on the workspace) so an **offline** `swift build` reuses what the provisioning-time **SwiftPM prewarm** (`git.provisionDeps.swiftPackages`) resolved. **Precedence** (lowest→highest): `process.env` → the scratch defaults → your `build.env` — so a `build.env` override of any of those keys still wins, unrelated process env is preserved, and (unlike `build.env`, which can be empty) the scratch keys always reach the SDK. Reviewer/contract-generator roles are untouched (they get the plain merged `build.env`, no scratch keys added). This is independent of `exercise.sandbox`: it only redirects temp/cache roots, it never widens write scope over the tracked source. See [backends](backends.md#per-role-sandbox-codex--the-worktree-safety-gate).
- **`build.extraReadDirs`** — extra directories the build (generator **and** evaluator) may **read**, beyond the work dir and repo root — added to each backend's `additionalDirectories`. For large assets you don't want in git: pre-stage them once (e.g. a face-recognition model under `~/.cache/…`) and list the dir here, so the sandboxed build reads it **without committing it or opening network**. Paths may be absolute, `~`-prefixed, or relative to the repo root. (Codex grants read+write to these within its sandbox; Claude grants read with writes still gated — treat as read-only intent.)

## Script hooks (`scriptHooks`)
User-configurable **external scripts** run at harness lifecycle points. `{}` (default) — a config
without a `scriptHooks` key, or with it empty — runs zero hooks and is byte-identical to today.
This is the config surface + runner (`src/scriptHooks.ts`). **Five of the seven lifecycle FIRE
POINTS are wired**: `onPhaseStart`/`onPhaseEnd` (any hookable CLI phase — `orient`, `plan`,
`prototype`, `freeze`, `build`, `reflect`, `batch`), `onRunStart`/`onRunComplete` (`sparra conduct`
run boundaries), and `onUnitStart`/`onUnitComplete` (each conduct unit, both the deterministic and
brain paths). **`onDecisionParked` is still pending** (lands alongside the bridge decision-park
announce line in a later unit). See [docs/conduct.md](conduct.md#script-hooks-fire-points) and
[docs/phases.md](phases.md#script-hooks-fire-points) for exactly which events fire at which
boundary and the before-event gate semantics. Do not confuse this with `src/sdk/hooks.ts`, the
unrelated Claude Agent SDK per-tool-call permission decider — different concept, kept under the
distinct `scriptHooks` name to avoid colliding with it. Also distinct from the HTTP **bridge's own
events log** (a separate, bridge-owned feature built elsewhere — see docs/http-bridge.md) —
`scriptHooks` runs YOUR scripts; the bridge events log just records what happened.

```yaml
scriptHooks:
  onRunStart:
    - "notify-send 'Sparra run starting'"        # plain string spec: argv-tokenized, no shell
    - run: ./scripts/preflight.sh
      required: true                              # a non-zero exit/timeout GATES the run (before-event only)
      timeoutSec: 60
      cwd: /path/to/project
  onRunComplete:
    - "./scripts/notify-done.sh"                  # after-event: best-effort, never gates
  onPhaseStart: []
  onPhaseEnd: []
  onUnitStart: []
  onUnitComplete:
    - run: ./scripts/log-unit.sh
  onDecisionParked:
    - run: ./scripts/page-me.sh
```

**Events** (exactly these seven — an unknown name is rejected at config load):
- **Before-events** — `onRunStart`, `onPhaseStart`, `onUnitStart`. Awaited; a `required: true` hook
  that exits non-zero or times out **stops the rest of that event's hooks** and gates the lifecycle
  step (the run/phase/unit does not proceed). A non-required failure only warns and continues.
- **After-events** — `onRunComplete`, `onPhaseEnd`, `onUnitComplete`, `onDecisionParked`. Every hook
  is awaited and run regardless of prior failures; a failure (even `required: true`) only logs a
  warning and never gates — gating a lifecycle step that has already completed is meaningless.

**Hook spec** — either a bare command **string** (argv-tokenized on whitespace, **no shell** — no
`&&`/`;`/`|`/redirects/expansion) or an object:
- `run` (string, required) — the command.
- `required` (boolean, default `false`) — only meaningful on a before-event; see above.
- `timeoutSec` (number) — per-hook timeout override; default reuses the harness executor's
  `EXEC_TIMEOUT_MS` magnitude (5 minutes).
- `cwd` (string) — spawn working directory. Precedence: `spec.cwd` > the lifecycle context's `root`
  > `process.cwd()`.

**Env vars + stdin contract** — each hook gets the parent environment plus `SPARRA_HOOK_EVENT`
always, and — only when the corresponding context field is present for that call —
`SPARRA_HOOK_PHASE`, `SPARRA_HOOK_ROOT`, `SPARRA_HOOK_RUN_ID`, `SPARRA_HOOK_RUN_DIR`,
`SPARRA_HOOK_UNIT`, `SPARRA_HOOK_STATUS`, `SPARRA_HOOK_DECISION_SEQ`, `SPARRA_HOOK_DECISION_KIND`.
The full lifecycle context is ALSO written to the hook's **stdin** as one JSON line (then stdin is
closed) — this is the only place `question` (parked-decision text) appears; it is deliberately never
put in an env var. A hook that doesn't read stdin is unaffected. Output (stdout+stderr) is captured
but capped (reusing the harness executor's `EXEC_OUTPUT_CAP` magnitude) so a chatty hook can never
balloon memory.

**Safety** — hooks are the user's OWN trusted commands from their own config, so they are **not**
routed through the harness verify executor's argv[0] allowlist (`build.verifyCommands`'s safety
rules); the only protections applied are: no shell, a per-hook timeout, and the output cap.

## On-disk artifacts
The filesystem is the source of truth and the only shared state — inspectable, diffable, resumable.

The human-facing docs sit at the project root by default; set **`docsDir`** (or
`sparra init --docs <dir>`) to tuck them into a subfolder like `docs/` and keep the
root clean. `.sparra/` machinery is unaffected.

```
your-project/
├─ CODEBASE_MAP.md     # Phase 0 (existing only)   ┐
├─ PLAN.md             # the living plan (Phase A)  │ at the root, or under
├─ HOLDOUT.md          # evaluator-only (isolation) │ docsDir/ when set
├─ CHANGELOG.md        # every deviation            ┘
├─ prototypes/         # throwaway prototypes (greenfield)
└─ .sparra/
   ├─ config.yaml      # every knob
   ├─ state.json       # phase machine + per-item status/cost/tokens + session ids (resume) + persistent unit-worktree registry (name→dir/branch/src)
   ├─ memory.md        # durable cross-run learnings (capped); roles read it each item
   ├─ environment.md   # optional user/reflect-authored environment notes injected into writer prompts
   ├─ frozen/          # PLAN.frozen.md, CODEBASE_MAP.frozen.md, HOLDOUT.frozen.md (build input)
   ├─ snapshots/       # timestamped PLAN/MAP checkpoints
   ├─ workitems/       # decomposition (items.json)
   ├─ contracts/       # negotiated "done" contracts
   ├─ verdicts/        # evaluator scores + assertion pass/fail with evidence (holdout-redacted).
   │  ├─ <run>/<item>.rN.verdict.md         #   autonomous build runs — RUN-SCOPED subdir so reused
   │  │                #   item ids never clobber a prior run; a resumed run reuses its own subdir
   │  └─ role-run-<role>-<stamp>.verdict.md #   interactive/loop role-runs auto-persist here (no `out`
   │                   #   needed) under a unique name, so `sparra reflect` gets evaluator evidence
   ├─ interactive/<run>/<item>/  # human-in-the-loop steering folders (`build --step`):
   │                   #   pause.md (redacted), decision.json, feedback.md — see build-loop.md
   ├─ proposals/       # out-of-scope changes logged for you (brownfield)
   ├─ prompts/         # editable role system prompts (reflect diffs these); seeded from the
   │  ├─ <role>.md     #   built-in defaults at init — can go stale as Sparra improves. Compare/
   │  └─ .baseline.json#   adopt with `sparra prompts status` / `sparra prompts sync`. Tighten with
   │                   #   `sparra prompts audit` (review files land in prompts/audit/<role>.md).
   │                   #   .baseline.json records the default hash last seeded/synced per role, so
   │                   #   drift is classified 3-way (stale/local/conflict) — a dotfile, not a role.
   ├─ calibration/     # good/ vs slop/ reference samples
   ├─ reflect/         # proposed prompt diffs awaiting approval (+ a run's upstream.md = harness findings)
   ├─ measure/         # post-accept QA metrics: baseline.json + rendered per-run regression reports
   ├─ traces/<run>/    # full transcripts per role, as markdown
   ├─ runs/            # batch summaries
   └─ cycles/<n-slug>/ # archived past plan→build cycles (PLAN, HOLDOUT, contracts, verdicts, …) — see `sparra new` / `sparra finish`
```

### Durable vs. volatile `.sparra/` (sharing config across machines)

`sparra init` writes a **Sparra-owned nested `.sparra/.gitignore`** — a **fail-closed allowlist**:
it ignores everything under `.sparra/` and then re-includes only the **durable** set, so the
machine-local and holdout-bearing rest (and *any future dir*) stays ignored by construction. It is
written **only when absent** — a `.sparra/.gitignore` you have edited is never overwritten.

| | Rides git (durable, shareable) | Stays local / never committed (volatile) |
|---|---|---|
| **Contents** | `.gitignore`, `config.yaml`, `prompts/` (incl. `.baseline.json`), `calibration/` | `state.json` (machine-local absolute paths), `environment.md`, `memory.md`, `frozen/` (holds `HOLDOUT.frozen.md`), `traces/`, `verdicts/`, `runs/`, `conduct/`, `reflect/`, `cycles/`, `snapshots/`, `contracts/`, `reviews/`, `proposals/`, `workitems/`, `measure/`, and **any future dir** |
| **Why** | role/model config + prompt overrides + taste samples are the same everywhere | absolute paths, per-machine toolchain, and every **holdout-derived** artifact must not travel |

**Working across machines.** Commit the human-facing docs (`CODEBASE_MAP.md`, `PLAN.md`,
`CHANGELOG.md`) plus the durable `.sparra/` set, and a second machine picks up your config with no
`sparra init` reconfiguration. To opt in, **drop any top-level `.sparra/` ignore line** in your
project's root `.gitignore` (Sparra never edits your top-level `.gitignore`); the nested allowlist
then keeps the volatile set ignored on its own. **Never commit `HOLDOUT.md`** — it is evaluator-only,
and `sparra finish` **refuses to land** while a tracked `HOLDOUT.md` would ride into a PR/merge.

Beyond the per-project `.sparra/`, reflect keeps a **user-level inbox** for findings about *Sparra
itself* — `~/.sparra/reflections/` (override the root with the **`SPARRA_HOME`** env var). Each
`sparra reflect` that surfaces a harness-level finding drops a uniquely-named file there, with each
finding under its own `###` heading. From the Sparra repo, `sparra reflect --upstream` lists every
finding **ranked by recurrence** — a finding that recurs across runs bumps a `×N` counter instead of
duplicating, and higher `×N` sorts first — each with a global 1-based index; triage them individually
with `--done <ids>` / `--wontdo <ids>`
(comma-separated indices from the listing; optional `--reason "<text>"`), which moves each marked
finding to `archive/<file>` under a disposition marker and leaves the un-triaged ones to resurface next
run. `--upstream --clear` (no triage flags) archives ALL inbox files at once. See [phases](phases.md).

`memory.md`, `CHANGELOG.md`, `CODEBASE_MAP.md`, `config.yaml`, `calibration/`, and `prompts/`
persist across cycles; the rest of the working set is archived per cycle by `sparra new` (or
`sparra finish`). Each `cycles/<n-slug>/` now also includes the cycle's archived **`HOLDOUT.md`**
(moved out of the live tree so a stale per-cycle holdout never bleeds into the next cycle).

## Prompt drift (`sparra prompts status` / `sync`)
`init` snapshots the defaults to `.sparra/prompts/<role>.md`, and `.baseline.json` records the hash
of the default text last seeded/synced per role. `sparra prompts status` classifies each role
**three ways** against the current default using that baseline:

- **`same`** — disk matches the current default (nothing to adopt).
- **`stale`** — disk still matches its baseline but the default moved past it (a newer default is
  available; **safe to adopt** — you never edited it).
- **`local`** — you (or `reflect`) edited it; the default is unchanged (no update available).
- **`conflict`** — both your copy AND the default moved (adopting would discard your edit).
- **`drifted`** — drifted but with **no baseline entry** (a legacy project inited before baselines):
  unclassifiable, never guessed.
- **`missing`** — the file is absent.

`sync` respects that classification so it never silently clobbers a local edit:

- `sparra prompts sync` (no flags) → adopts **`stale` only** (the safe ones); `local`/`conflict`/
  `drifted` roles are left on disk and reported as skipped (force them explicitly).
- `sparra prompts sync --role <r>` → force-overwrites that one role regardless of state (DISCARDS
  local edits).
- `sparra prompts sync --all` → overwrites every non-`same` role (strong discard warning).

Any sync refreshes `.baseline.json` for the roles it writes, so an immediate re-`status` reads
`same`. A newer-default (`stale`) prompt is also surfaced once on the **build** and **role-runner /
`sparra eval` / `sparra-loop`** paths (see [build-loop](build-loop.md) / [phases](phases.md)).

## Auditing prompt conciseness & readability (`sparra prompts audit`)
`reflect` APPENDS to role prompts, so the built-in defaults ratchet up over cycles. `sparra prompts
audit [--role <r>] [--apply] [--backend b] [--model m] [--effort e]` checks whether each prompt's
wording can be **lower-redundancy and more readable without losing any rule** — cut duplication and
padding (not structure), then format what remains for fast parsing by humans and models (one idea per
bullet/line, blank lines between distinct rules). Conciseness here means low redundancy, not terseness.

- Per role it resolves the EFFECTIVE prompt (on-disk `.sparra/prompts/<role>.md` if present, else
  the built-in default), runs the read-only `prompt-auditor` on that text, and writes a review to
  `.sparra/prompts/audit/<role>.md` with size before→after (chars + approx tokens), a per-rule
  coverage report (where each rule is `preservedIn` the tightened text, or `dropped`),
  `droppedNothing`, and the tightened proposal. With no `--role` it audits every role.
- The auditor run defaults to the `reflector` role's backend/model/effort (no new config key);
  `--backend`/`--model`/`--effort` override it.
- **`--apply` is FAIL-CLOSED behind a coverage cross-check** (the harness verifies coverage; it does
  not trust the model's flag): a prompt is overwritten ONLY when `droppedNothing === true` AND the
  tightened text is non-empty AND `coverage` is a non-empty array with NO `dropped` entry. Any other
  shape (false/missing `droppedNothing`, unparseable JSON, empty tightened, empty coverage, or a
  dropped rule) is SKIPPED, leaving the prompt byte-identical. Without `--apply` it is report-only.
- **Plus an INDEPENDENT verifier pass (on `--apply` only).** The coverage cross-check trusts the
  auditor's OWN enumeration of the original's rules — so a rule the auditor simply MISSES (never
  lists) looks fully covered, and `--apply` could silently drop it. To close that gap, once the
  coverage guard passes, a SEPARATE read-only `prompt-audit-verifier` run is given the ORIGINAL and
  the TIGHTENED text and INDEPENDENTLY re-enumerates the original's rules (NOT from the auditor's
  coverage), returning `{ "complete": boolean, "missing": [{"rule"}] }`. The prompt is overwritten
  ONLY if the verifier reports `complete: true` with an empty `missing`; otherwise (incomplete,
  missing rules, or unparseable) it is SKIPPED with a distinct "verifier flagged N missing rule(s)"
  reason and left byte-identical. The verifier runs ONCE per applied role; report-only and
  `--source default` never invoke it. Its outcome is recorded in the per-role review file.
- Safety: the audit operates ONLY on role-prompt text — it injects no holdout/memory/plan and the
  auditor is read-only (the prompt is passed inline; it has no Write/Edit/Bash tools).

## Resuming
`sparra resume` continues whatever phase you're in, purely from `.sparra/state.json` + the artifacts. Re-run `sparra build` to resume an interrupted build — passed items are skipped; `BUDGET_EXCEEDED`/`abandoned` items are skipped too.
