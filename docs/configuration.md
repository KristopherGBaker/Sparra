# Configuration

Every knob lives in **`.sparra/config.yaml`** (seeded on `init` with mode-aware defaults; edit and re-run any phase — changes are picked up live). Models accept SDK aliases (`opus` · `sonnet` · `haiku` · `fable`) or full model ids. Anything you omit inherits the default.

```yaml
roles:                        # per role: { backend?, model, effort?, baseUrl?, apiKey?, skills? }  (backend defaults to "claude")
  orienter:          { model: sonnet, effort: high }
  planner:           { model: opus,   effort: high }
  decomposer:        { model: sonnet, effort: high }   # plan → work items (a planning act)
  prototyper:        { model: sonnet, effort: medium }
  contractGenerator: { model: sonnet, effort: high }
  contractEvaluator: { model: opus,   effort: high }
  generator:         { model: sonnet, effort: high }
  evaluator:         { model: opus,   effort: high }
  reviewer:          { model: opus,   effort: high }   # code-review gate (opt-in; see `review`)
  reflector:         { model: opus,   effort: high }
  # Cross-backend example: generator: { backend: codex, model: gpt-5-codex }
  # Hybrid (local for trivial/sensitive items, cloud for the hard ones):
  #   generator:      { backend: codex, model: gpt-5-codex }
  #   generatorLocal: { backend: codex, model: qwen3.5-9b, baseUrl: http://localhost:1234/v1 }  # LM Studio

permission:
  mode: auto                  # auto (default) | acceptEdits | plan ; never bypassPermissions
  denyBashContains: ["rm -rf /", "git push", "shutdown", "mkfs", ":(){", "curl | sh", "sudo "]

git:
  strategy: worktree          # worktree | branch | inplace
  branchPrefix: "sparra/"
  autoCommit: false           # true → one conventional commit per accepted item, ONLY on
                              # the Sparra worktree/branch (never your main branch / in-place)

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
  ios: { cli: "xcodebuildmcp", scheme: "", simulator: "" }   # see docs/ios.md

deviation: { strictness: moderate }        # strict | moderate | free (defaulted by mode)

review:                                    # opt-in agent code-review gate (off by default)
  enabled: false
  blockOn: high                            # high (security/correctness/dead-code) | all | none

batch: { K: 3 }
```

## Notes on a few knobs
- **`roles.*.backend`** — `claude` (default) or `codex`. See [backends](backends.md). Decomposition reads best on Claude; keep `decomposer` there if you put the builder on Codex.
- **`roles.*.baseUrl` / `roles.*.apiKey`** — point a role at an OpenAI-compatible endpoint instead of the backend default — e.g. a **local** model served by LM Studio (`http://localhost:1234/v1`) or Ollama. Only the **`codex`** backend honors it (Codex supplies the agent loop + tools; the model runs locally). `model` is then the local model id; `apiKey` defaults to a dummy. See [backends — local models](backends.md#local-models-lm-studio--ollama).
- **`roles.generatorLocal`** — an optional **second generator** for **hybrid builds**. Work items the decomposer tags `gen: "local"` (trivially-simple or privacy-sensitive) build on `generatorLocal`; everything else uses `generator`. Unset → all items use `generator`. You can add/remove the `gen` tag per item in `.sparra/workitems/items.json` before building (the decomposer only proposes it, and only when `generatorLocal` is configured).
- **`permission.mode`** — `auto` uses the SDK's model-classifier approvals when available on your plan, else `acceptEdits`; either way a deny-hook (Claude) / sandbox (Codex) enforces scope. `bypassPermissions` is refused.
- **`contract`** — the assertion range is an *upper guide*, scaled down for small items; the evaluator rejects padding and over-specification. See [build loop](build-loop.md).
- **`build` budgets** — start-closed; crossing the USD **or** token cap halts an item as `BUDGET_EXCEEDED` and the run continues. `total_cost_usd` is notional on a subscription — use `maxTokensPerItem` there.
- **`exercise.ios`** — full Apple-platform guide in [docs/ios.md](ios.md).
- **`review`** — an optional agent code-review gate after the behavioral evaluator passes (a second lens for code quality the exerciser can't see). Off by default; see [build loop](build-loop.md#code-review-optional). Best with `roles.reviewer.backend` set to a *different* family than the generator.
- **`build.skills` / `roles.*.skills`** — agent skills (SKILL.md) made available to a role. Builder roles (`generator`, `prototyper`) inherit `build.skills`; other roles (e.g. `evaluator`) opt in via their own `roles.<role>.skills`. Resolved from the repo's `skills/`, `~/.claude/skills`, or `~/.agents/skills` (or an explicit path). See [backends — skills](backends.md#skills). Example: `roles.evaluator.skills: ["xcodebuildmcp-cli"]` to give the iOS grader your build/run skill.
- **`build.extraReadDirs`** — extra directories the build (generator **and** evaluator) may **read**, beyond the work dir and repo root — added to each backend's `additionalDirectories`. For large assets you don't want in git: pre-stage them once (e.g. a face-recognition model under `~/.cache/…`) and list the dir here, so the sandboxed build reads it **without committing it or opening network**. Paths may be absolute, `~`-prefixed, or relative to the repo root. (Codex grants read+write to these within its sandbox; Claude grants read with writes still gated — treat as read-only intent.)

## On-disk artifacts
The filesystem is the source of truth and the only shared state — inspectable, diffable, resumable.

```
your-project/
├─ CODEBASE_MAP.md     # Phase 0 (existing only)
├─ PLAN.md             # the living plan (Phase A); reconciled during build
├─ HOLDOUT.md          # optional: evaluator-only acceptance checks (isolation wall)
├─ CHANGELOG.md        # every deviation, with rationale
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
