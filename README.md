# Sparra

A long-running **adversarial build harness**. It builds software one work item at a time: each item is negotiated into a checkable "done" contract, implemented by a generator, then graded by an adversarial evaluator that *actually runs the artifact*, with **cross-model judging** (Claude builds while Codex judges, or vice versa) and an optional **holdout wall** the builder can't overfit to. It works on **new and existing codebases**, over pluggable agent backends (**Claude and Codex** today).

**Two ways to drive it:**

1. **Interactively, from a Claude Code session** (how most sessions go). The **`/sparra-loop` skill** puts *you* on the wheel: **contract → generate → cross-model adversarial evaluate → pivot/accept**, steering between every step, with the holdout wall enforced by the runner. Same rigor as the autonomous loop, your hand on the wheel.
2. **Fully autonomous, as CLI phases**: `plan → freeze → build → reflect`. You hand off and the loop runs unattended, item by item. (See [Autonomous CLI phases](#autonomous-cli-phases).)

The guiding principle: **the filesystem is the source of truth and the only shared state.** Every step reads its inputs from disk and writes its outputs to disk, so the whole thing is inspectable, diffable, and **resumable from any point**, and both modes share the same on-disk state and the same role-runner seam.

The end-to-end lifecycle (the interactive loop drives the **build** step by hand; autonomous runs the whole column):

```
 sparra init                      detect greenfield vs existing; scaffold .sparra/
   ├─(existing)→ orient           map the repo → CODEBASE_MAP.md
   ▼
 plan  (interactive)  ⇄  prototype (throwaway, for learning)
   │   co-edit PLAN.md in a relentless one-question-at-a-time interview
   │   ← you decide, nothing automated →
   ▼
 freeze                           snapshot the plan as build input (your call)
   ▼
 build (autonomous)               per item: negotiate a "done" contract → generate →
   │                              evaluator EXERCISES it → grade → (code review) → pivot/accept → commit
   ▼
 reflect                          read the run's traces → propose prompt edits you approve
   ▼
 new                              next feature, same project: archive this cycle, fresh plan
```

## Quick start: drive it from Claude Code

```bash
npm install                       # installs the Claude Agent SDK + deps
npm link                          # put `sparra` / `sparra-tui` / `sparra-run-mcp` on your PATH (run once, from this repo)
# auth: set ANTHROPIC_API_KEY, or be logged in via Claude Code
```

Then, from a Claude Code session in your project, invoke the **`/sparra-loop`** skill. *You* drive the loop, **contract → generate → cross-model adversarial evaluate → pivot/accept**, steering between every step, with the **holdout wall** enforced by the runner. It's the interactive analogue of the autonomous build loop: same rigor, your hand on the wheel.

Both the **`/sparra-loop`** skill (drive the loop) and the **`/sparra`** skill (drive + debug Sparra) ship as a Claude Code **plugin** (`.claude-plugin/marketplace.json`), alongside a `sparra-role` subagent the conductor delegates role-runs to.

**The seam under both modes is the role-runner**: run ONE Sparra role once, on a backend you pick.

- The **`run_role` MCP tool** (server `sparra-run`) for an interactive session, and the `sparra role run` / `sparra eval` CLI for scripts and headless use.
- Roles: `generator` · `contract-generator` · `contract-evaluator` · `evaluator` · `reviewer`.
- The **holdout is passed BY PATH**: only the evaluator ever sees its contents; the parsed **verdict** comes back (never raw output).
- Per-call **`--backend` / `--model` / `--effort`** (`low|medium|high|xhigh|max`) override the role's configured defaults for that one call.

```bash
# A Codex evaluator grading a Claude generator's WIP tree, against a contract + holdout:
sparra eval . --contract contract.md --backend codex \
  --holdout .sparra/HOLDOUT.md --out .sparra/verdicts/r1.md
# (alias for: sparra role run --kind evaluator …)
```

**Why this is the point:** **cross-model on tap** (Claude builds while Codex judges, or vice versa) gives a genuine independent second opinion. Use it for a one-off review of a round, or run **standalone `sparra eval <dir>`** to grade a work-in-progress tree against a contract (and an optional holdout): Sparra-grade adversarial rigor without the full plan→freeze→build loop. No `.sparra/` is required for an ad-hoc eval; it synthesizes a default-backed context.

See **[docs/role-runner.md](docs/role-runner.md)** for install, the MCP wiring, and exactly what the holdout wall does (and doesn't) guarantee.

## How it works

- **Plan → freeze → build.** A relentless, human-led planning interview co-edits `PLAN.md`; nothing advances to building until *you* run `freeze`. → [docs/phases.md](docs/phases.md)
- **Adversarial build loop.** Each work item gets a negotiated, proportionate "done" contract (a handful of checkable assertions, not a wishlist), is implemented by a generator, then **exercised for real** by an adversarial evaluator that grades it with evidence (and won't pass a flaky artifact, one that only "passes" via a degenerate/gamed input, or one whose own shipped tests crash as delivered). Stuck items **GAN-pivot**: discard and restart from scratch. An optional **code-review gate** adds a second lens on the diff (security, dead code, conventions) before acceptance. → [docs/build-loop.md](docs/build-loop.md)
- **Pluggable agent backends.** Every model step runs through one interface, so you choose the backend **per role** (Claude *or* Codex, incl. **local models** via LM Studio/Ollama) and can even have one family **build** while another **judges**, or route **per work item** (local for trivial/sensitive items, cloud for the hard ones). Roles can be handed **agent skills** (SKILL.md), loaded natively on Claude and inlined on Codex. → [docs/backends.md](docs/backends.md)
- **Pluggable exerciser.** CLI, web, or **iOS/macOS**: for Apple apps the multimodal evaluator builds, launches the Simulator, drives the UI, and *reads screenshots* to verify UI changes. → [docs/ios.md](docs/ios.md)
- **Bounded & safe by default.** Per-item USD/token budgets ("start closed"), a git-worktree boundary with a backend-independent escape backstop, and an optional **holdout wall** of evaluator-only checks the builder can't overfit to (a *reduced* on-disk surface: scope-exclusion + prompt-wall + verdict redaction, not an airtight box; see [docs/role-runner.md](docs/role-runner.md)). Accepted items can be **auto-committed** as agent-authored, atomic conventional commits (a cheap `committer` model splits the diff; harness executes) onto the Sparra branch, **never your main**. With `git.provisionDeps`, dependencies are auto-provisioned into the build worktree so verify/eval run there. → [docs/build-loop.md](docs/build-loop.md)
- **Survives provider limits (unattended).** Opt-in **auto-restart**: when a model hits a rate/usage window, the loop switches to a configured **cross-provider fallback model** or **waits the window out**, then retries the same round, bounded by hard wait/restart caps and resumable from disk. → [docs/build-loop.md](docs/build-loop.md#auto-restart--model-fallback-on-provider-limits)
- **Self-improving & resumable.** Full transcripts to `traces/`, `sparra reflect` proposes prompt diffs you approve, and `sparra prompts audit` runs a **conciseness auditor over Sparra's own role prompts**, proposing tightenings with a coverage-gated `--apply` (an independent verifier pass guards it; `--source default` audits the shipping defaults, report-only). Durable cross-run `memory.md`, and resume-from-disk at any phase. → [docs/configuration.md](docs/configuration.md)
- **Everything is a knob.** Per-role models/backends/effort, rubric weights, pivot thresholds, budgets, deviation strictness, exerciser. → [docs/configuration.md](docs/configuration.md)

## Autonomous CLI phases

Prefer to hand off and let it run unattended? The same engine runs as a sequence of CLI phases:

```bash
cd your-project/                  # new or existing; Sparra detects which
sparra orient        # existing projects only → CODEBASE_MAP.md
sparra plan          # the collaborative interview (or use the TUI: `sparra-tui`)
sparra freeze        # YOUR call; locks the plan as build input
sparra build         # the autonomous generator/evaluator loop
sparra reflect       # propose prompt improvements from the run's traces
sparra status        # where am I? what's next?
sparra new "next"    # done? start the next feature; archives this cycle, fresh plan
```

No build step: the bins run the TypeScript directly via `tsx`, so edits/`git pull` take effect immediately. (`npm link` symlinks back to this repo; keep it where it is. Undo: `npm rm -g sparra`.)

### More commands

Beyond the phase flow above, the CLI exposes (run `sparra help` for the full signatures):

- `prototype "<idea>"` · `log-finding <FINDINGS.md>` · `snapshot`: Phase B throwaway prototypes and folding findings back into `PLAN.md`.
- `build [--fresh] [--only <item-id>] [--step contract,round,commit,item]`: `--step` pauses the autonomous loop at each checkpoint for human steering; `--only` rebuilds a single item.
- `prompts [status|sync|audit [--apply] [--source default|effective]] [--role <r>] [--dry-run]`: compare/sync `.sparra/prompts` with the built-in defaults; `audit` is a concision review (see self-improvement above).
- `batch [-k N]`: run N builds of the frozen plan and summarize the failures.
- `finish [--pr|--merge --yes] [--teardown] [--force] [--branch <name>] [--new "<title>"]`: close out a cycle by landing the Sparra branch (PR or ff-only merge), tearing down, archiving.
- `clean [--yes] [--force]`: prune stale Sparra worktrees/branches (dry-run by default).
- `resume`: continue whatever phase you're in, from disk.
- `role run …` / `eval …`: the interactive/cross-model role seam (see the quick start above).
- `sparra-tui`: a terminal UI over the same phases.

## Docs

| | |
|---|---|
| [Phases](docs/phases.md) | orient → plan ⇄ prototype → freeze → build → reflect; the TUI; greenfield vs brownfield |
| [The build loop](docs/build-loop.md) | contract negotiation, exercising, GAN pivots, holdout wall, sandbox-first safety, budgets, memory |
| [Agent backends](docs/backends.md) | the `AgentBackend` seam, Claude + Codex, per-role + cross-backend evaluation |
| [Role-runner](docs/role-runner.md) | run Sparra's roles (cross-model adversarial eval, holdout wall) from an interactive Claude Code session via `sparra role run` + the MCP `run_role` tool |
| [iOS / macOS](docs/ios.md) | `xcodebuildmcp`, XcodeGen, the launch-screen requirement, multimodal UI grading |
| [Configuration](docs/configuration.md) | every knob, on-disk layout, resuming |

## Requirements

- **Node 20+**, and an **Anthropic credential** (`ANTHROPIC_API_KEY` or a Claude Code login).
- For the **Codex** backend: `npm i @openai/codex-sdk` + the `codex` CLI (optional; only if you use it).
- For **iOS/macOS** builds: macOS + Xcode + a Simulator + `xcodebuildmcp` + `xcodegen`.

> SDK signatures are verified against the installed packages' own `.d.ts`, not training data. Claude Agent SDK pinned at `@anthropic-ai/claude-agent-sdk@0.3.186`.
