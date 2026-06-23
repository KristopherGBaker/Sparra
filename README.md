# Sparra

A long-running **autonomous build harness** built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). It is structured around how real software gets built: you **plan collaboratively** first, **optionally prototype** to de-risk, then hand off to an **autonomous build loop** once you're satisfied. It works on **new projects and existing codebases**.

> **SDK target:** `@anthropic-ai/claude-agent-sdk@0.3.186` (the version installed in this repo; signatures verified against the package's own `.d.ts`, not training data).

The guiding principle: **the filesystem is the source of truth and the only shared state.** Every phase reads its inputs from disk and writes its outputs to disk, so the whole thing is inspectable, diffable, and **resumable from any point** — kill it mid-build and run `sparra resume`.

---

## The flow: `0 → A → B → freeze → C → reflect`

```
 sparra init                         detect greenfield vs existing; scaffold .sparra/
   │
   ├─(existing)→ Phase 0  ORIENT     map the repo → CODEBASE_MAP.md
   │
   ▼
 Phase A  PLAN  (interactive)        co-edit PLAN.md in a relentless interview  ⇄  Phase B  PROTOTYPE
   │                                                                                (throwaway, for learning)
   │  ← you decide, nothing automated
   ▼
 FREEZE GATE   sparra freeze         snapshot PLAN.md (+ CODEBASE_MAP.md) as build input
   │
   ▼
 Phase C  BUILD  (autonomous)        per item: negotiate a "done" contract → generate →
   │                                 adversarial evaluator EXERCISES it → grade → pivot/accept
   ▼
 SELF-IMPROVEMENT  sparra reflect    read this run's traces → propose prompt edits you approve
```

---

## Quick start

```bash
npm install                      # installs the Agent SDK + deps
# auth: set ANTHROPIC_API_KEY, or be logged in via Claude Code

cd your-project/                 # new or existing — Sparra detects which
node /path/to/sparra/bin/sparra.mjs init
# (or `npm link` this repo so `sparra` is on your PATH)

sparra orient        # existing projects only → CODEBASE_MAP.md
sparra plan          # the collaborative interview (Phase A)
sparra prototype "spike an approach"   # optional (Phase B)
sparra freeze        # YOUR call — locks the plan as build input
sparra build         # autonomous generator/evaluator loop (Phase C)
sparra reflect       # propose prompt improvements from the run's traces
sparra status        # where am I? what's next?
```

There's a **runnable end-to-end example** you can watch in [`examples/cli-greenfield/`](examples/cli-greenfield/).

---

## The phases in detail

### Phase 0 — ORIENT (existing projects only)
`sparra orient` runs a read-only agent that maps the repo — architecture, module boundaries, the conventions/idioms **actually in use** (with file:line evidence), the build system, how tests are run, CI, and the **seams** where new work attaches — into **`CODEBASE_MAP.md`**. Greenfield skips this (a `--light` pass handles partial scaffolding). This map is what lets the interview answer its own questions instead of asking you.

### Phase A — COLLABORATIVE PLANNING (interactive, human-led)
`sparra plan` opens an interview that **co-edits `PLAN.md` with you**:

- It interviews you **relentlessly**, walking down each branch of the design tree and resolving dependencies between decisions **one at a time**.
- It asks **one question at a time**, and **always gives its recommended answer** so you can just confirm or redirect.
- **If a question can be answered by exploring the codebase, prototypes, or logged findings, it explores instead of asking.**
- It **never auto-advances to building** — it has no build tools, and only you decide the plan is done.
- The plan stays **high-level on implementation detail** (granular upfront plans cascade errors over long horizons); it captures intent, constraints, risks, open questions, and — for existing projects — which patterns/modules to conform to.

The session is **resumable across restarts** (the SDK session id is persisted): quit and run `sparra plan` again to pick up the conversation. Inside the interview: `/snapshot`, `/freeze`, `/exit`, `/help`. Or `sparra snapshot` from the shell.

### Phase B — EXPLORATION / PROTOTYPING (optional, agentic)
`sparra prototype "<idea>"` spins up a **throwaway** prototype in an **isolated workspace** — `prototypes/<name>/` for greenfield, a dedicated **git worktree** for existing repos — never mixed into the real tree. The run's purpose is **learning**; you run and use the output yourself. It writes a `FINDINGS.md`. Fold the learnings back into the plan with `sparra log-finding <FINDINGS.md>`. Loop A ⇄ B as much as you want; prototype code and findings become explorable context the interview can draw on. **Prototypes are discarded by default — promoting anything into the real build is a deliberate, explicit step.**

### FREEZE GATE (your decision, not automated)
There is **no automated "plan is done" check.** When you're satisfied, you run `sparra freeze`. It snapshots `PLAN.md` (and `CODEBASE_MAP.md`) and copies them into `.sparra/frozen/` as the build input. **The frozen plan is a strong _prior_, not a literal contract.**

### Phase C — AUTONOMOUS BUILD (generator + adversarial evaluator)
`sparra build` runs the long-horizon loop against the frozen plan:

1. **Decompose** the plan into coarse work items (count scales to plan size).
2. **Contract negotiation.** For each item, *before any code*, the generator proposes a "done" contract — *"I'll build X, verify by Y"* — with **15–30 concrete, individually checkable assertions**. A separate **adversarial** evaluator (harsh system prompt) critiques scope, verification, and missing edge cases. They iterate until both agree. The whole negotiation is saved to `.sparra/contracts/<id>.contract.md`. For existing projects every contract **must** include *"does not regress existing behavior"* and *"conforms to the conventions in CODEBASE_MAP.md."*
3. **Generate.** The generator implements the item against the **contract** (not the plan prose), writing only inside the work scope.
4. **Exercise & grade.** The evaluator is adversarial and **actually runs the artifact** — it does not read diffs. The exerciser is **pluggable** (see below). It grades each contract assertion PASS/FAIL **with evidence**, scores the **rubric**, and emits a structured verdict to `.sparra/verdicts/`. On existing projects it **also runs the repo's existing test suite** and treats new failures as a hard fail. Grading is against the **contract + rubric**, *not* the literal plan text.
5. **GAN-style pivot.** If an item stays below threshold on the **same rubric criterion** for `N` consecutive rounds, Sparra **discards and restarts that item from scratch** with a different approach instead of patching forever. `N` and the threshold are configurable.
6. **Accept → reconcile.** On pass, deviations are reconciled into `PLAN.md` so the plan never goes stale.

### Self-improvement (outer loop)
- Every agent's **full transcript** is written to `.sparra/traces/<run>/` as readable markdown.
- `sparra reflect` runs a reviewer over the last run's traces, finds where the evaluator was too lenient or diverged from the rubric, and **proposes prompt edits** (you see a diff per prompt). `sparra reflect --apply` applies them, backing up the originals first.
- `sparra batch -k N` runs **N independent builds** of the same frozen plan and summarizes which items are flaky across runs.

---

## Greenfield vs. brownfield: the differences that matter

| | **Greenfield** | **Existing codebase** |
|---|---|---|
| Phase 0 | skipped (light pass for scaffolding) | full repo map → `CODEBASE_MAP.md` |
| Contracts | assertions define "done" | **+ mandatory** no-regression & conforms-to-conventions clauses |
| Evaluator | exercises the artifact | **+ runs the repo's existing test suite**; new failures = hard fail |
| Deviation | **free** to depart from the plan when it improves the product | **constrained**: may improve *within the current item's scope*, but must not refactor/restructure out-of-scope code or break existing behavior; anything bigger becomes a **proposal** for you in `.sparra/proposals/` |
| Git safety | builds in place | builds on a **worktree/branch**; never commits to your main branch |

Every deviation is recorded to `CHANGELOG.md` with rationale and reconciled into `PLAN.md`. The deviation strictness is a config knob (`strict` | `moderate` | `free`), defaulted by mode.

---

## The pluggable exerciser

The evaluator exercises the real artifact via `config.exercise.mechanism`:

- **`cli`** — runs the built tool with real arguments; asserts on stdout/stderr/exit codes (an `eh`-style CLI). *Default.*
- **`web`** — starts the app, probes it over HTTP (`http_request` tool); wire in Playwright / Chrome MCP via config for richer flows.
- **`ios`** — drives `xcrun simctl` / `xcodebuild test` / XCUITest; wire in XcodeBuildMCP for accessibility automation.
- **`computer-use`** — exercise end-to-end as a user would.
- **`custom`** — your own shell recipe.

Under the hood the evaluator gets an in-process MCP server (`mcp__exercise__run_command`, plus `http_request` for web) so every exercise is structured and logged.

---

## Configuration — every knob

All knobs live in **`.sparra/config.yaml`** (seeded on `init`, mode-aware defaults). Models accept SDK aliases (`opus` · `sonnet` · `haiku` · `fable`) or full model ids.

```yaml
roles:                      # per-role model + reasoning effort
  orienter:          { model: sonnet, effort: high }
  planner:           { model: opus,   effort: high }
  prototyper:        { model: sonnet, effort: medium }
  contractGenerator: { model: sonnet, effort: high }
  contractEvaluator: { model: opus,   effort: high }
  generator:         { model: sonnet, effort: high }
  evaluator:         { model: opus,   effort: high }
  reflector:         { model: opus,   effort: high }

permission:
  mode: safe-auto           # safe-auto | acceptEdits | default | plan | bypass
  denyBashContains: ["rm -rf /", "git push", ...]

git:
  strategy: worktree        # worktree | branch | inplace
  branchPrefix: "sparra/"
  autoCommit: false         # Sparra never commits to your main branch autonomously

rubric:
  weights: { design: 0.25, originality: 0.15, craft: 0.3, functionality: 0.3 }
  passThreshold: 75
  useCalibration: true      # read .sparra/calibration/{good,slop}/ to match your taste

pivot: { N: 3, threshold: 50 }            # GAN restart after N rounds below threshold on one criterion

contract: { assertionMin: 15, assertionMax: 30, maxNegotiationRounds: 4 }

build: { maxRoundsPerItem: 6, maxTurnsPerSession: 60, maxBudgetUsdPerItem: 0 }

exercise:
  mechanism: cli            # cli | web | ios | computer-use | custom
  runExistingTests: true
  existingTestCommand: ""    # auto-detected from CODEBASE_MAP.md if empty
  customRecipe: ""
  web: { startCommand: "", baseUrl: "http://localhost:3000" }
  ios: { scheme: "", simulator: "iPhone 15" }

deviation: { strictness: moderate }       # strict | moderate | free (default by mode)

batch: { K: 3 }
```

### Calibration (matching your taste)
Drop reference files into `.sparra/calibration/good/` (aim for this) and `.sparra/calibration/slop/` (avoid this). When `rubric.useCalibration` is on, the evaluator reads them before scoring originality/craft, so its taste matches yours.

---

## On-disk artifacts

```
your-project/
├─ CODEBASE_MAP.md     # Phase 0 (existing only)
├─ PLAN.md             # the living plan (Phase A); reconciled during build
├─ CHANGELOG.md        # every deviation, with rationale
├─ prototypes/         # throwaway prototypes (greenfield)
└─ .sparra/
   ├─ config.yaml      # every knob
   ├─ state.json       # phase machine + per-item status + session ids (resume)
   ├─ frozen/          # PLAN.frozen.md, CODEBASE_MAP.frozen.md (build input)
   ├─ snapshots/       # timestamped PLAN/MAP checkpoints
   ├─ workitems/       # decomposition (items.json)
   ├─ contracts/       # negotiated "done" contracts
   ├─ verdicts/        # evaluator scores + assertion pass/fail
   ├─ proposals/       # out-of-scope changes logged for you (brownfield)
   ├─ prompts/         # editable role system prompts (reflect diffs these)
   ├─ calibration/     # good/ vs slop/ reference samples
   ├─ reflect/         # proposed prompt diffs awaiting approval
   ├─ traces/<run>/    # full transcripts per role, as markdown
   └─ runs/            # batch summaries
```

---

## How it maps to the SDK

Every role is a separate `query()` call through one wrapper (`src/sdk/session.ts`) — own `systemPrompt` (from `.sparra/prompts/`), own `model`/`effort`. Sessions never share memory; they hand off through files.

- **Interactive planning** uses **resume-based multi-turn** (`resume: <sessionId>` per turn) rather than a single streaming session, specifically so the interview survives process restarts (the design goal: resumable from filesystem state at any phase).
- **Autonomous roles** are one-shot `query()` calls in a loop; sessions that hit `maxTurns` are resumed; GAN restarts use a fresh session.
- **Permissions:** "safer auto" maps to `permissionMode: 'default'` plus a programmatic `canUseTool` that allows in-scope `Write`/`Edit` and **denies** out-of-scope ones and dangerous Bash — so nothing prompts, but file edits stay scoped. (We avoid `acceptEdits` for builders precisely so this backstop can't be bypassed.) Note that Bash file writes are gated by a denylist rather than full path-parsing, so for hard containment on existing repos the **git worktree** is the real boundary (the build's cwd is the worktree; relative writes land there).
- **Exercising** uses an in-process MCP server built with `createSdkMcpServer` + `tool()`.
- `settingSources: []` isolates each session from ambient settings — Sparra's state is explicit on disk.

---

## Resuming, safety, ergonomics

- **Resumable everywhere.** `sparra resume` continues whatever phase you're in, purely from `.sparra/state.json` + the artifacts. Re-run `sparra build` to resume an interrupted build (passed items are skipped).
- **Safe by default.** `permission.mode: safe-auto` (not blanket skip-permissions). On existing repos, work happens on a worktree/branch; Sparra never commits to your main branch autonomously.
- **Per-role models** are fully configurable — use Opus where judgment matters, Haiku where it doesn't.

---

## Limitations & notes

- GAN restarts re-run the generator with a "start from scratch" instruction rather than doing a file-level git rollback; for strict rollback use `git: { strategy: worktree }` and discard the branch.
- The `canUseTool` path-scoping covers the `Write`/`Edit` tools; Bash writes are gated only by `denyBashContains`. On existing repos, rely on the **worktree** strategy for containment rather than the Bash denylist.
- The `ios` / `computer-use` exercisers ship with `run_command` + guidance; richer device automation expects an external MCP (XcodeBuildMCP, Playwright/Chrome MCP) wired via config.
- Requires an Anthropic credential (`ANTHROPIC_API_KEY` or a Claude Code login).
