# Agent backends (Claude · Codex · …)

Every model-driven step goes through a pluggable **`AgentBackend`** (`src/sdk/backend.ts`), so the orchestration loop is independent of which coding agent runs a task. `src/sdk/session.ts` is the single choke point: `runSession(req)` → `getBackend(req.backend).runTask(req)`.

Two backends ship today:

| | **`claude`** (default) | **`codex`** |
|---|---|---|
| SDK | `@anthropic-ai/claude-agent-sdk` | `@openai/codex-sdk` (optional peer dep, lazy-loaded) |
| Sessions / resume | ✓ | ✓ (threads) |
| Streaming + usage | ✓ | ✓ |
| Structured output | emulated (instruct + extract) | **native** `outputSchema` |
| Tool-call hooks | ✓ (Pre/PostToolUse) | — |
| Sandbox | — (hooks + permission mode) | **native OS sandbox** |
| Cost | USD + tokens | tokens |

The Codex SDK is **optional**: install only if you use it — `npm i @openai/codex-sdk` plus the `codex` CLI on PATH (auth comes from `~/.codex`). Absent, the backend no-ops with a clear message; the rest of the harness runs fine.

## Per-role backend
Pick the backend **per role** in `config.yaml`. Each role is `{ backend?, model, effort? }` (backend defaults to `claude`):

```yaml
roles:
  generator:  { backend: codex,  model: gpt-5-codex }
  evaluator:  { backend: claude, model: opus, effort: high }   # independent grader
  decomposer: { backend: claude, model: opus }                 # planning act — keep on Claude
```

## Cross-backend evaluation
Because backend is per-role, you can have **one family build and another judge** (Codex builds, Claude grades — or vice-versa). Independent model families catch each other's blind spots far better than one model grading itself — the same reasoning behind the [holdout wall](build-loop.md#holdout--isolation-wall-optional). It's a config change, not code.

> Heads-up: decomposition is a *planning* act and reads best on a model that follows the decomposer prompt closely. If you put the builder on Codex, keep `decomposer` on Claude (Codex tends to over-split). That's why `decomposer` is its own role.

## Normalized intent, native enforcement
A request carries **backend-agnostic intent** — `writeScope`, `readOnly`, `outputSchema`, `maxTokens` — and each backend satisfies it natively:

- **Claude** → PreToolUse scoping hooks + permission mode; `outputSchema` via instruct-and-extract.
- **Codex** → OS `sandbox_mode` (`read-only` / `workspace-write`) + `approvalPolicy: never`; `outputSchema` natively.

The **git worktree is the outer boundary for every backend**, with `writeScopeViolations()` as a backend-independent post-hoc backstop (see [sandbox-first safety](build-loop.md#sandbox-first-safety)).

## Adding a backend
Implement `AgentBackend` (`id`, `capabilities`, `runTask(req) → AgentResult`) in `src/sdk/backends/<id>.ts`, `registerBackend(...)` it, and import it for its side effect in `session.ts`. The engine reads `capabilities` and uses the richest path available, degrading otherwise. Nothing else changes.

## How it maps to the SDKs
- Each role is one backend task with its own `systemPrompt` (from `.sparra/prompts/`), `backend`/`model`/`effort`. Sessions never share memory — they hand off through files.
- **Interactive planning** uses **resume-based multi-turn** (resume by session/thread id per turn) so the interview survives process restarts.
- **Autonomous roles** are one-shot tasks in a loop; sessions that hit `maxTurns` are resumed; GAN restarts use a fresh session.
- `settingSources: []` (Claude) and a clean env isolate each session from ambient settings — Sparra's state is explicit on disk, which is also why the harness can't accidentally inherit a different project's config.
