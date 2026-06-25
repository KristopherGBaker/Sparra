# Configuration

Every knob lives in **`.sparra/config.yaml`** (seeded on `init` with mode-aware defaults; edit and re-run any phase — changes are picked up live). Models accept SDK aliases (`opus` · `sonnet` · `haiku` · `fable`) or full model ids. Anything you omit inherits the default.

```yaml
roles:                        # per role: { backend?, model, effort? }  (backend defaults to "claude")
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

permission:
  mode: auto                  # auto (default) | acceptEdits | plan ; never bypassPermissions
  denyBashContains: ["rm -rf /", "git push", "shutdown", "mkfs", ":(){", "curl | sh", "sudo "]

git:
  strategy: worktree          # worktree | branch | inplace
  branchPrefix: "sparra/"
  autoCommit: false           # Sparra never commits to your main branch autonomously

rubric:
  weights: { design: 0.25, originality: 0.15, craft: 0.3, functionality: 0.3 }
  passThreshold: 75
  useCalibration: true        # read .sparra/calibration/{good,slop}/ to match your taste

pivot: { N: 3, threshold: 50 }             # GAN restart after N rounds below threshold on one criterion

contract: { assertionMin: 6, assertionMax: 20, maxNegotiationRounds: 4 }   # upper guide, scaled per item

build:
  maxRoundsPerItem: 6
  maxTurnsPerSession: 60
  maxBudgetUsdPerItem: 5      # notional USD cap (tokens × list price); 0 = no cap
  maxTokensPerItem: 0         # direct token ceiling — the lever on a subscription/Codex; 0 = no cap

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
- **`permission.mode`** — `auto` uses the SDK's model-classifier approvals when available on your plan, else `acceptEdits`; either way a deny-hook (Claude) / sandbox (Codex) enforces scope. `bypassPermissions` is refused.
- **`contract`** — the assertion range is an *upper guide*, scaled down for small items; the evaluator rejects padding and over-specification. See [build loop](build-loop.md).
- **`build` budgets** — start-closed; crossing the USD **or** token cap halts an item as `BUDGET_EXCEEDED` and the run continues. `total_cost_usd` is notional on a subscription — use `maxTokensPerItem` there.
- **`exercise.ios`** — full Apple-platform guide in [docs/ios.md](ios.md).
- **`review`** — an optional agent code-review gate after the behavioral evaluator passes (a second lens for code quality the exerciser can't see). Off by default; see [build loop](build-loop.md#code-review-optional). Best with `roles.reviewer.backend` set to a *different* family than the generator.

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
   ├─ prompts/         # editable role system prompts (reflect diffs these)
   ├─ calibration/     # good/ vs slop/ reference samples
   ├─ reflect/         # proposed prompt diffs awaiting approval
   ├─ traces/<run>/    # full transcripts per role, as markdown
   └─ runs/            # batch summaries
```

## Resuming
`sparra resume` continues whatever phase you're in, purely from `.sparra/state.json` + the artifacts. Re-run `sparra build` to resume an interrupted build — passed items are skipped; `BUDGET_EXCEEDED`/`abandoned` items are skipped too.
