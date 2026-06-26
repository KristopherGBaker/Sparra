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
| Skills | native (scoped local plugin) | `SKILL.md` inlined into input |
| Cost | USD + tokens | tokens |

The Codex SDK is **optional**: install only if you use it — `npm i @openai/codex-sdk` plus the `codex` CLI on PATH (auth comes from `~/.codex`). Absent, the backend no-ops with a clear message; the rest of the harness runs fine.

## Per-role backend
Pick the backend **per role** in `config.yaml`. Each role is `{ backend?, model, effort?, baseUrl?, apiKey?, skills? }` (backend defaults to `claude`; `baseUrl` targets a local/OpenAI-compatible endpoint — see [local models](#local-models-lm-studio--ollama)):

```yaml
roles:
  generator:  { backend: codex,  model: gpt-5-codex }
  evaluator:  { backend: claude, model: opus, effort: high }   # independent grader
  decomposer: { backend: claude, model: opus }                 # planning act — keep on Claude
```

## Local models (LM Studio / Ollama)
Point a **`codex`** role at a local OpenAI-compatible server with `baseUrl` (+ optional `apiKey`). Codex still drives the agentic loop and tools; only the model is local — so the work stays on your machine:
```yaml
roles:
  generator: { backend: codex, model: qwen3.5-9b, baseUrl: http://localhost:1234/v1 }  # LM Studio
```
The Codex CLI also has native local support (`--oss --local-provider lmstudio|ollama`); the SDK path above is the harness's equivalent. Caveat: small local models are far weaker than frontier cloud models at agentic tool-calling — expect more rounds/pivots on hard items.

### Hybrid: local for some items, cloud for others
Set a second generator, `roles.generatorLocal`, and the build routes **per work item**: items the decomposer tags `gen: "local"` (trivially-simple or privacy-sensitive — pure scaffolding, a tiny config/struct) build locally; everything else uses the main `generator`. The decomposer only proposes the tag when `generatorLocal` is set, and you can edit the tag in `.sparra/workitems/items.json` before building. Falls back to `generator` (with a warning) if an item is tagged local but no `generatorLocal` is configured.
```yaml
roles:
  generator:      { backend: codex, model: gpt-5-codex }                                   # the hard items
  generatorLocal: { backend: codex, model: qwen3.5-9b, baseUrl: http://localhost:1234/v1 } # the trivial ones
```

## Cross-backend evaluation
Because backend is per-role, you can have **one family build and another judge** (Codex builds, Claude grades — or vice-versa). Independent model families catch each other's blind spots far better than one model grading itself — the same reasoning behind the [holdout wall](build-loop.md#holdout--isolation-wall-optional). It's a config change, not code.

The optional [code-review gate](build-loop.md#code-review-optional) is a third independent lens: set `roles.reviewer.backend` to a family *different from the generator* so the reviewer reads the diff with genuinely fresh eyes.

## Skills
Roles can be given [agent skills](https://docs.claude.com/en/docs/claude-code/skills) (SKILL.md) via `build.skills` (builder roles `generator`/`prototyper` inherit it) or per-role `roles.<role>.skills` (other roles opt in). Resolution searches the repo's `skills/`, then `~/.claude/skills`, then `~/.agents/skills` (or an explicit path). Missing skills warn and are skipped. The backends differ — Sparra normalizes it:

- **Claude** — loaded natively as a scoped throwaway local plugin (`Options.plugins` + `Options.skills`), so `settingSources` stays `[]` and **only the declared skills** are available (no ambient/parent-project leak).
- **Codex** — the resolved `SKILL.md` bodies are **inlined into the input** (Codex's SDK exposes no system-prompt or declared-skill channel), so the role gets the same guidance wherever the skill lives.

Because skills are *declared in config*, a run reproduces on any machine with the same skill files. Example — give the iOS grader your build/run skill instead of baking it into prompts:

```yaml
build:
  skills: ["swiftui-design"]                      # builder roles inherit this
roles:
  evaluator: { skills: ["xcodebuildmcp-cli"] }    # grading role, opt-in
```

> Heads-up: decomposition is a *planning* act and reads best on a model that follows the decomposer prompt closely. If you put the builder on Codex, keep `decomposer` on Claude (Codex tends to over-split). That's why `decomposer` is its own role.

## Normalized intent, native enforcement
A request carries **backend-agnostic intent** — `writeScope`, `readOnly`, `outputSchema`, `maxTokens` — and each backend satisfies it natively:

- **Claude** → PreToolUse scoping hooks + permission mode; `outputSchema` via instruct-and-extract.
- **Codex** → OS `sandbox_mode` (`read-only` / `workspace-write`) + `approvalPolicy: never`; `outputSchema` natively.

The **git worktree is the outer boundary for every backend**, with `writeScopeViolations()` as a backend-independent post-hoc backstop (see [sandbox-first safety](build-loop.md#sandbox-first-safety)).

## Adding a backend
Implement `AgentBackend` (`id`, `capabilities`, `runTask(req) → AgentResult`) in `src/sdk/backends/<id>.ts`, `registerBackend(...)` it, and import it for its side effect in `session.ts`. The engine reads `capabilities` and uses the richest path available, degrading otherwise. Nothing else changes.

## How it maps to the SDKs
- Each role is one backend task with its own `systemPrompt` (from `.sparra/prompts/`), `backend`/`model`/`effort`. On Claude the system prompt is a native option; **on Codex (no system-prompt channel) it's folded into the input** ahead of the task, along with any inlined skills. Sessions never share memory — they hand off through files.
- **Interactive planning** uses **resume-based multi-turn** (resume by session/thread id per turn) so the interview survives process restarts.
- **Autonomous roles** are one-shot tasks in a loop; sessions that hit `maxTurns` are resumed; GAN restarts use a fresh session.
- `settingSources: []` + `strictMcpConfig: true` (Claude) and a clean env isolate each session from ambient settings — Sparra's state is explicit on disk, which is also why the harness can't accidentally inherit a different project's config. One gap those flags *don't* cover: **auto-fetched claude.ai cloud connectors** (Drive/Gmail/Calendar) attach from the logged-in account, not from a settings file. So the PreToolUse deny-hook (`denyAmbientMcp`, in every guard) is the real boundary — it rejects any `mcp__*` tool that isn't Sparra's own `mcp__exercise__*`. Build agents get no reach into your personal cloud.
