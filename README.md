# Sparra

[![CI](https://github.com/KristopherGBaker/Sparra/actions/workflows/ci.yml/badge.svg)](https://github.com/KristopherGBaker/Sparra/actions/workflows/ci.yml)

An **adversarial build harness**. Sparra builds software one work item at a time: each item is negotiated into a checkable "done" contract, implemented by a generator, then graded by an adversarial evaluator that **actually runs the artifact** — with **cross-model judging** (Claude builds while Codex judges, or vice versa) and an optional **holdout wall** of evaluator-only checks the builder can't overfit to.

```mermaid
flowchart LR
    contract["Negotiate a<br>'done' contract"] --> generate[Generator<br>implements]
    generate --> exercise["Evaluator <b>exercises</b><br>the artifact for real"]
    exercise --> grade{Grade}
    grade -->|pass| accept[Accept &<br>commit]
    grade -->|fail: feedback| generate
    grade -->|stuck| pivot[Pivot: discard,<br>restart fresh]
    pivot --> generate
```

Works on new and existing codebases, over pluggable agent backends (**Claude and Codex** today — the Codex backend also fronts any OpenAI-compatible endpoint). Everything reads and writes the filesystem, so every run is inspectable, diffable, and resumable.

> **Status:** young and still finding its form, but already earning its keep on real projects (and on Sparra itself). Inspired by the Anthropic workshop [Build Agents That Run for Hours](https://youtu.be/mR-WAvEPRwE).

## Quick start: drive it from Claude Code

The most common way to use Sparra: the **`/sparra-loop`** skill runs the loop above *inside an interactive Claude Code session*, with you on the wheel — steer every step, or let it run in auto mode and step in only when needed.

One-time setup, from a clone of this repo:

```bash
npm install && npm link           # puts `sparra` + `sparra-run-mcp` on your PATH
npm i @openai/codex-sdk           # optional: only for a Codex backend (also needs the `codex` CLI authed)

claude mcp add sparra-run --scope user -- sparra-run-mcp   # the role-runner MCP tool
claude plugin marketplace add "$PWD"
claude plugin install sparra@sparra-skills                 # gives you /sparra-loop and /sparra
```

Then open Claude Code **in your project** and type `/sparra-loop`. It sets the project up (`sparra init`, per-role backend/model split, optional holdout) and drives the loop:

```mermaid
sequenceDiagram
    participant You
    participant CC as Claude Code<br>(/sparra-loop)
    participant R as Sparra role-runner
    You->>CC: /sparra-loop "add feature X"
    CC->>R: run_role contract-generator
    CC->>R: run_role generator (e.g. Claude)
    CC->>R: run_role evaluator (e.g. Codex) — sees the holdout, exercises the work
    R-->>CC: verdict only (holdout stays redacted)
    CC->>You: round summary — accept, iterate, or pivot?
```

The holdout is passed **by path** and only the evaluator ever sees it; the runner returns the parsed verdict, never raw output. Details, guarantees, and the CLI equivalents (`sparra role run`, `sparra eval`): **[docs/role-runner.md](docs/role-runner.md)**.

**Just want a second opinion?** `sparra eval <dir> --contract contract.md --backend codex` grades any work-in-progress tree against a contract — no `.sparra/` setup required. Add `--worktree` to evaluate a snapshot without touching your tree.

## Fully autonomous: the CLI phases

Prefer to hand off? The same engine runs unattended as a sequence of phases — collaborative planning, a human freeze gate, then the autonomous build loop:

```mermaid
flowchart TB
    init["sparra init<br>(+ orient for existing repos)"] --> plan
    plan["sparra plan — collaborative<br>interview, co-edits PLAN.md"] <-.-> proto["sparra prototype<br>(throwaway, for learning)"]
    plan --> freeze["sparra freeze — <b>your call</b>,<br>locks the plan as build input"]
    freeze --> build["sparra build — the autonomous<br>loop, item by item"]
    build --> reflect["sparra reflect — proposes prompt<br>edits from the run's traces"]
    reflect --> new["sparra new / finish —<br>next feature, fresh cycle"]
```

```bash
cd your-project/     # new or existing; Sparra detects which
sparra plan && sparra freeze && sparra build && sparra reflect
sparra status        # where am I? what's next?
sparra resume        # continue any phase from disk
```

`sparra build --step` pauses at each checkpoint for human steering; `sparra help` lists everything else (`batch`, `finish`, `clean`, `prompts audit`, `measure`, …). → [docs/phases.md](docs/phases.md)

## Key ideas

- **The evaluator runs your code.** Grading is evidence-based: it builds, launches, and exercises the artifact (CLI, web, or iOS Simulator with screenshot reading), and won't pass flaky or gamed results. → [docs/build-loop.md](docs/build-loop.md)
- **Cross-model on tap.** Pick the backend per role — one model family builds while another judges, for a genuinely independent second opinion. → [docs/backends.md](docs/backends.md)
- **Holdout wall.** Evaluator-only acceptance checks the builder never sees, so it can't teach to the test. → [docs/role-runner.md](docs/role-runner.md#what-the-runner-enforces-the-holdout-wall)
- **Bounded & safe by default.** Per-item budgets, sandboxed permissions, and a git-worktree boundary — Sparra never commits to your main branch. → [docs/build-loop.md](docs/build-loop.md#sandbox-first-safety)
- **Filesystem is the source of truth.** Contracts, verdicts, traces, and memory all live in `.sparra/` on disk — resumable from any point, and it survives provider rate limits unattended. → [docs/configuration.md](docs/configuration.md)
- **Self-improving.** `sparra reflect` reads the run's traces and proposes prompt edits you approve. → [docs/phases.md](docs/phases.md#self-improvement-outer-loop)

## Docs

| | |
|---|---|
| [Phases](docs/phases.md) | orient → plan ⇄ prototype → freeze → build → reflect; greenfield vs brownfield |
| [The build loop](docs/build-loop.md) | contract negotiation, exercising, pivots, budgets, code review, measure, memory |
| [Role-runner](docs/role-runner.md) | the interactive seam: `/sparra-loop`, MCP `run_role`, `sparra eval`, the holdout wall |
| [Agent backends](docs/backends.md) | Claude + Codex, per-role backends, OpenAI-compatible endpoints, skills |
| [iOS / macOS](docs/ios.md) | Simulator builds, `xcodebuildmcp`, XcodeGen, multimodal UI grading |
| [Configuration](docs/configuration.md) | every knob, the `.sparra/` on-disk layout, resuming |

## Requirements

- **Node 20+** and an **Anthropic credential** (`ANTHROPIC_API_KEY` or a Claude Code login).
- Optional **Codex** backend: `npm i @openai/codex-sdk` + the `codex` CLI. → [docs/backends.md](docs/backends.md)
- Optional **iOS/macOS** exercising: macOS + Xcode + a Simulator + `xcodebuildmcp` + `xcodegen`. → [docs/ios.md](docs/ios.md)

No build step — the bins run the TypeScript directly via `tsx`, so a `git pull` takes effect immediately.

## License

[MIT](LICENSE) © Kristopher Baker
