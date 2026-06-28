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
  # Cross-backend example: generator: { backend: codex, model: gpt-5-codex }
  # Hybrid (local for trivial/sensitive items, cloud for the hard ones):
  #   generator:      { backend: codex, model: gpt-5-codex }
  #   generatorLocal: { backend: codex, model: qwen3.5-9b, baseUrl: http://localhost:1234/v1 }  # LM Studio
  # Fallback model when the primary's backend is rate/usage-limited (needs build.autoRestart):
  #   generator: { backend: codex, model: gpt-5-codex, fallback: { backend: claude, model: opus } }
  # Widen a Codex WRITE role's native sandbox for toolchains the default profile blocks (xcodebuild):
  #   generator: { backend: codex, model: gpt-5-codex, sandbox: danger-full-access }  # needs a worktree

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

rubric:
  weights: { design: 0.25, originality: 0.15, craft: 0.3, functionality: 0.3 }
  passThreshold: 75
  useCalibration: true        # read .sparra/calibration/{good,slop}/ to match your taste

pivot: { N: 3, threshold: 50 }             # GAN restart after N rounds below threshold on one criterion

contract: { assertionMin: 6, assertionMax: 20, maxNegotiationRounds: 6 }   # upper guide, scaled per item

build:
  maxRoundsPerItem: 6
  maxTurnsPerSession: 60
  maxBudgetUsdPerItem: 5      # notional USD cap (tokens × list price); 0 = no cap
  maxTokensPerItem: 0         # direct token ceiling — the lever on a subscription/Codex; 0 = no cap
  autoRestart:                # wait out (or fall back from) a provider rate/usage limit
    enabled: false            # off by default; on → an unattended build can sleep for hours
    maxWaitSec: 21600         # cap on ONE wait (6h — long enough for a Claude 5-hour window)
    pollSec: 300              # recheck cadence when the backend gives no reset time (e.g. Codex)
    maxRestarts: 20           # total wait cycles before stopping (resumable via `sparra build`)
  skills: []                  # agent skills for the builder roles, e.g. ["xcodebuildmcp-cli", "swiftui-design"]
                              # (per-role override: roles.<role>.skills)
  extraReadDirs: []           # extra dirs the build may READ (e.g. ["~/.cache/models"]) — for big
                              # assets you don't want in git; pre-stage once, no commit, no network

format:
  enabled: true
  command: ""                 # "" → auto-detect (prettier; existing repos detect from CODEBASE_MAP.md).
  autodetect: true            # e.g. "sh -c 'swiftformat {file}; swiftlint --fix --path {file}'"

exercise:
  mechanism: cli              # cli | web | ios | computer-use | custom
  runExistingTests: true
  existingTestCommand: ""      # auto-detected from CODEBASE_MAP.md if empty
  customRecipe: ""
  web: { startCommand: "", baseUrl: "http://localhost:3000" }
  ios: { cli: "xcodebuildmcp", scheme: "", simulator: "", platform: "ios" }   # platform: "macos" runs the .app on the host + verifies via XCUITest; see docs/ios.md

deviation: { strictness: moderate }        # strict | moderate | free (defaulted by mode)

review:                                    # opt-in agent code-review gate (off by default)
  enabled: false
  blockOn: high                            # high (security/correctness/dead-code) | all | none

batch: { K: 3 }
```

## Notes on a few knobs
- **`roles.*.backend`** — `claude` (default) or `codex`. See [backends](backends.md). Decomposition reads best on Claude; keep `decomposer` there if you put the builder on Codex.
- **`roles.*.baseUrl` / `roles.*.apiKey`** — point a role at an OpenAI-compatible endpoint instead of the backend default — e.g. a **local** model served by LM Studio (`http://localhost:1234/v1`) or Ollama. Only the **`codex`** backend honors it (Codex supplies the agent loop + tools; the model runs locally). `model` is then the local model id; `apiKey` defaults to a dummy. See [backends — local models](backends.md#local-models-lm-studio--ollama).
- **`roles.*.sandbox`** — `workspace-write` (default) | `danger-full-access`, for a **write** role on the **`codex`** backend (Claude has no OS sandbox and ignores it). `workspace-write` scopes writes to the work tree with no network; `danger-full-access` lifts the sandbox so a Codex generator can run native toolchains the default Seatbelt profile blocks — e.g. `xcodebuild`. **Read-only roles ignore this — they are always `read-only`.** **Safety:** `danger-full-access` is honored **only when the build runs on a git worktree/branch** (`git.strategy: worktree`/`branch`); on an in-place / greenfield-no-git run it is downgraded to `workspace-write` with a loud warning (the worktree is the only safety boundary, since Codex runs with no interception hooks). See [backends — per-role sandbox](backends.md#per-role-sandbox-codex--the-worktree-safety-gate).
- **`roles.generatorLocal`** — an optional **second generator** for **hybrid builds**. Work items the decomposer tags `gen: "local"` (trivially-simple or privacy-sensitive) build on `generatorLocal`; everything else uses `generator`. Unset → all items use `generator`. You can add/remove the `gen` tag per item in `.sparra/workitems/items.json` before building (the decomposer only proposes it, and only when `generatorLocal` is configured).
- **`permission.mode`** — `auto` uses the SDK's model-classifier approvals when available on your plan, else `acceptEdits`; either way a deny-hook (Claude) / sandbox (Codex) enforces scope. `bypassPermissions` is refused.
- **`contract`** — the assertion range is an *upper guide*, scaled down for small items; the evaluator rejects padding and over-specification. See [build loop](build-loop.md).
- **`build` budgets** — start-closed; crossing the USD **or** token cap halts an item as `BUDGET_EXCEEDED` and the run continues. `total_cost_usd` is notional on a subscription — use `maxTokensPerItem` there.
- **`build.autoRestart`** — the "heartbeat" for **unattended** builds: when the generator or evaluator hits a real **provider** rate/usage/session limit (vs. your own budget caps), the loop either switches to a configured **`fallback`** model or **waits** for the window to reopen, then retries the **same** round — instead of burning it. Off by default (opting in lets a build sleep for hours). State is checkpointed before each wait, so a kill mid-wait still resumes from disk; `sparra status` shows a paused build as *waiting until …*. After `maxRestarts` wait cycles it stops cleanly — re-run `sparra build` to resume. See [build loop](build-loop.md#auto-restart--model-fallback-on-provider-limits).
- **`roles.*.fallback`** — a backup `RoleConfig` (model/backend/effort/…) used when the primary role's **backend** is in a limit window (requires `build.autoRestart.enabled`). Best pointed at a **different provider** (e.g. primary `gpt-5-codex` on Codex → fallback `opus` on Claude): on a limit the loop switches models and keeps going with **no wait**, switching back once the primary's window reopens. Chainable (a fallback may have its own `fallback`); a fallback on the same, also-limited backend is skipped. Limits are keyed by backend because a plan window (e.g. Claude's 5-hour) is account-wide across that provider's models.
- **`exercise.ios`** — full Apple-platform guide in [docs/ios.md](ios.md).
- **`review`** — an optional agent code-review gate after the behavioral evaluator passes (a second lens for code quality the exerciser can't see). Off by default; see [build loop](build-loop.md#code-review-optional). Best with `roles.reviewer.backend` set to a *different* family than the generator.
- **`build.skills` / `roles.*.skills`** — agent skills (SKILL.md) made available to a role. Builder roles (`generator`, `prototyper`) inherit `build.skills`; other roles (e.g. `evaluator`) opt in via their own `roles.<role>.skills`. Resolved from the repo's `skills/`, `~/.claude/skills`, or `~/.agents/skills` (or an explicit path). See [backends — skills](backends.md#skills). Example: `roles.evaluator.skills: ["xcodebuildmcp-cli"]` to give the iOS grader your build/run skill.
- **`docsDir`** — subfolder (relative to the repo root) for the human-facing docs Sparra manages — `PLAN.md`, `CODEBASE_MAP.md`, `CHANGELOG.md`, `HOLDOUT.md`. `""` (default) keeps them at the root; e.g. `docs` puts them under `docs/` to keep the root uncluttered. Set it at `sparra init --docs <dir>` (it's baked into `config.yaml`); `.sparra/` machinery stays put regardless.
- **`build.extraReadDirs`** — extra directories the build (generator **and** evaluator) may **read**, beyond the work dir and repo root — added to each backend's `additionalDirectories`. For large assets you don't want in git: pre-stage them once (e.g. a face-recognition model under `~/.cache/…`) and list the dir here, so the sandboxed build reads it **without committing it or opening network**. Paths may be absolute, `~`-prefixed, or relative to the repo root. (Codex grants read+write to these within its sandbox; Claude grants read with writes still gated — treat as read-only intent.)

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
   ├─ state.json       # phase machine + per-item status/cost/tokens + session ids (resume)
   ├─ memory.md        # durable cross-run learnings (capped); roles read it each item
   ├─ frozen/          # PLAN.frozen.md, CODEBASE_MAP.frozen.md, HOLDOUT.frozen.md (build input)
   ├─ snapshots/       # timestamped PLAN/MAP checkpoints
   ├─ workitems/       # decomposition (items.json)
   ├─ contracts/       # negotiated "done" contracts
   ├─ verdicts/        # evaluator scores + assertion pass/fail with evidence
   ├─ interactive/<run>/<item>/  # human-in-the-loop steering folders (`build --step`):
   │                   #   pause.md (redacted), decision.json, feedback.md — see build-loop.md
   ├─ proposals/       # out-of-scope changes logged for you (brownfield)
   ├─ prompts/         # editable role system prompts (reflect diffs these); seeded from the
   │                   #   built-in defaults at init — can go stale as Sparra improves. Compare/
   │                   #   adopt with `sparra prompts status` / `sparra prompts sync`.
   ├─ calibration/     # good/ vs slop/ reference samples
   ├─ reflect/         # proposed prompt diffs awaiting approval
   ├─ traces/<run>/    # full transcripts per role, as markdown
   ├─ runs/            # batch summaries
   └─ cycles/<n-slug>/ # archived past plan→build cycles (PLAN, contracts, verdicts, …) — see `sparra new`
```

`memory.md`, `CHANGELOG.md`, `CODEBASE_MAP.md`, `config.yaml`, `calibration/`, and `prompts/`
persist across cycles; the rest of the working set is archived per cycle by `sparra new`.

## Resuming
`sparra resume` continues whatever phase you're in, purely from `.sparra/state.json` + the artifacts. Re-run `sparra build` to resume an interrupted build — passed items are skipped; `BUDGET_EXCEEDED`/`abandoned` items are skipped too.
