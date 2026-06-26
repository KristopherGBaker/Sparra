# Sparra

A long-running **autonomous build harness**. You **plan collaboratively** with it, optionally **prototype** to de-risk, then hand off to an **autonomous build loop** that builds work item by work item — each one negotiated against a checkable "done" contract and graded by an adversarial evaluator that *actually runs the artifact*. It works on **new and existing codebases**, and runs on pluggable agent backends — **Claude and Codex** today.

The guiding principle: **the filesystem is the source of truth and the only shared state.** Every phase reads its inputs from disk and writes its outputs to disk, so the whole thing is inspectable, diffable, and **resumable from any point**.

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

## Quick start

```bash
npm install                       # installs the Claude Agent SDK + deps
npm link                          # put `sparra` / `sparra-tui` on your PATH (run once, from this repo)
# auth: set ANTHROPIC_API_KEY, or be logged in via Claude Code

cd your-project/                  # new or existing — Sparra detects which
sparra orient        # existing projects only → CODEBASE_MAP.md
sparra plan          # the collaborative interview (or use the TUI: `sparra-tui`)
sparra freeze        # YOUR call — locks the plan as build input
sparra build         # the autonomous generator/evaluator loop
sparra reflect       # propose prompt improvements from the run's traces
sparra status        # where am I? what's next?
sparra new "next"    # done? start the next feature — archives this cycle, fresh plan
```

No build step — the bins run the TypeScript directly via `tsx`, so edits/`git pull` take effect immediately. (`npm link` symlinks back to this repo; keep it where it is. Undo: `npm rm -g sparra`.)

There are runnable examples to watch: [`examples/cli-greenfield/`](examples/cli-greenfield/) (a tiny Node CLI), [`examples/ios-greenfield/`](examples/ios-greenfield/) (a SwiftUI tip calculator) and [`examples/ios-notes/`](examples/ios-notes/) (a SwiftData notes app). The iOS ones need Xcode + `xcodebuildmcp` + `xcodegen` (see [docs/ios.md](docs/ios.md)).

## How it works

- **Plan → freeze → build.** A relentless, human-led planning interview co-edits `PLAN.md`; nothing advances to building until *you* run `freeze`. → [docs/phases.md](docs/phases.md)
- **Adversarial build loop.** Each work item gets a negotiated, proportionate "done" contract (a handful of checkable assertions, not a wishlist), is implemented by a generator, then **exercised for real** by an adversarial evaluator that grades it with evidence (and won't pass a flaky artifact, one that only "passes" via a degenerate/gamed input, or one whose own shipped tests crash as delivered). Stuck items **GAN-pivot**: discard and restart from scratch. An optional **code-review gate** adds a second lens on the diff — security, dead code, conventions — before acceptance. → [docs/build-loop.md](docs/build-loop.md)
- **Pluggable agent backends.** Every model step runs through one interface, so you choose the backend **per role** — Claude *or* Codex — and can even have one family **build** while another **judges**. Roles can be handed **agent skills** (SKILL.md), loaded natively on Claude and inlined on Codex. → [docs/backends.md](docs/backends.md)
- **Pluggable exerciser.** CLI, web, or **iOS/macOS** — for Apple apps the multimodal evaluator builds, launches the Simulator, drives the UI, and *reads screenshots* to verify UI changes. → [docs/ios.md](docs/ios.md)
- **Bounded & safe by default.** Per-item USD/token budgets ("start closed"), a git-worktree boundary with a backend-independent escape backstop, and an optional **holdout wall** of evaluator-only checks the builder can't overfit to. Accepted items can be **auto-committed** as conventional commits onto the Sparra branch (never your main). → [docs/build-loop.md](docs/build-loop.md)
- **Self-improving & resumable.** Full transcripts to `traces/`, `sparra reflect` proposes prompt diffs you approve, durable cross-run `memory.md`, and resume-from-disk at any phase. → [docs/configuration.md](docs/configuration.md)
- **Everything is a knob.** Per-role models/backends/effort, rubric weights, pivot thresholds, budgets, deviation strictness, exerciser. → [docs/configuration.md](docs/configuration.md)

## Docs

| | |
|---|---|
| [Phases](docs/phases.md) | orient → plan ⇄ prototype → freeze → build → reflect; the TUI; greenfield vs brownfield |
| [The build loop](docs/build-loop.md) | contract negotiation, exercising, GAN pivots, holdout wall, sandbox-first safety, budgets, memory |
| [Agent backends](docs/backends.md) | the `AgentBackend` seam, Claude + Codex, per-role + cross-backend evaluation |
| [iOS / macOS](docs/ios.md) | `xcodebuildmcp`, XcodeGen, the launch-screen requirement, multimodal UI grading |
| [Configuration](docs/configuration.md) | every knob, on-disk layout, resuming |

## Requirements

- **Node 18+**, and an **Anthropic credential** (`ANTHROPIC_API_KEY` or a Claude Code login).
- For the **Codex** backend: `npm i @openai/codex-sdk` + the `codex` CLI (optional; only if you use it).
- For **iOS/macOS** builds: macOS + Xcode + a Simulator + `xcodebuildmcp` + `xcodegen`.

> SDK signatures are verified against the installed packages' own `.d.ts`, not training data. Claude Agent SDK pinned at `@anthropic-ai/claude-agent-sdk@0.3.186`.
