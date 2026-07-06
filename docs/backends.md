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
| External MCP tools (`mcp`) | ✓ | ✓ |
| In-process MCP host (`inProcessMcp`) | ✓ (hosts `createSdkMcpServer` — the exerciser) | — (no `ThreadOptions.mcpServers`) |
| Sandbox | — (hooks + permission mode) | **native OS sandbox** |
| Skills | native (scoped local plugin) | `SKILL.md` inlined into input |
| Env injection | `Options.env` | `CodexOptions.env` |
| Cost | USD + tokens | tokens |

The Codex SDK is **optional**: install only if you use it — `npm i @openai/codex-sdk` plus the `codex` CLI on PATH (auth comes from `~/.codex`). Absent, the backend no-ops with a clear message; the rest of the harness runs fine.

## Per-role backend
Pick the backend **per role** in `config.yaml`. Each role is `{ backend?, model, effort?, baseUrl?, apiKey?, skills?, sandbox?, fallback?, escalation? }` (backend defaults to `claude`; `baseUrl` targets an OpenAI-compatible endpoint (OpenRouter or local) — see [OpenAI-compatible endpoints](#openai-compatible-endpoints-openrouter-lm-studio-ollama); `fallback` is a limit-triggered backup RoleConfig and `escalation` a quality-triggered stronger one for generator roles — see [configuration](configuration.md#notes-on-a-few-knobs)):

```yaml
roles:
  generator:  { backend: codex,  model: gpt-5-codex }
  evaluator:  { backend: claude, model: opus, effort: high }   # independent grader
  decomposer: { backend: claude, model: opus }                 # planning act — keep on Claude
```

## OpenAI-compatible endpoints (OpenRouter, LM Studio, Ollama)
Point a **`codex`** role at any OpenAI-compatible Chat Completions endpoint with `baseUrl` (+ `apiKey`). Codex still drives the agentic loop and tools; only the **model** is swapped out — so you can route a role through a hosted aggregator like **OpenRouter** (any model it exposes) or keep everything on-device with a **local** server (LM Studio, Ollama):
```yaml
roles:
  # Hosted aggregator (cloud) — a real key, any model OpenRouter fronts:
  generator: { backend: codex, model: qwen/qwen-2.5-coder-32b-instruct, baseUrl: https://openrouter.ai/api/v1, apiKey: sk-or-... }
  # Local (on your machine) — the work never leaves the host; the key is a dummy:
  evaluator: { backend: codex, model: qwen3.5-9b, baseUrl: http://localhost:1234/v1 }  # Ollama: http://localhost:11434/v1
```
`apiKey` defaults to a dummy (`"lm-studio"`) when only `baseUrl` is set, which suits local servers that ignore it; a **hosted** endpoint needs a real key. **Treat that key as a secret** — a target project's `.sparra/config.yaml` is committed, so prefer keeping a real key out of version control. The Codex CLI also has native local support (`--oss --local-provider lmstudio|ollama`); the SDK path above is the harness's equivalent. Caveat: weaker models (small local ones especially) lag frontier cloud models at agentic tool-calling — expect more rounds/pivots on hard items.

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

### Cost tuning: contract critique vs artifact eval
Contract negotiation is **token-heavy at high effort** — a single round-1 contract critique on a frontier model at `effort: high` has run 200k–480k tokens. The gate is worth keeping, but split the spend: put the round-1 **contract** critique on a cheaper model / lower effort — via `roles.contractEvaluator` (its own RoleConfig), its `fallback`, or a per-call `--model`/`--effort` override — and reserve the strong high-effort model for the **artifact** eval (`roles.evaluator`), where adversarial exercising pays off most:
```yaml
roles:
  contractEvaluator: { backend: codex, model: gpt-5.5, effort: medium }  # contract critique — cheaper
  evaluator:         { backend: codex, model: gpt-5.5, effort: high }    # artifact eval — strong
```

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

## Environment variables
`build.env` is injected for both shipped backends. Claude receives the merged map via `Options.env`; Codex receives it via `CodexOptions.env`. Both installed SDK declaration files state that providing `env` replaces inherited `process.env`, so Sparra first builds a string-only merge of `process.env` plus `build.env` (with `build.env` winning) before passing it to either SDK. That preserves `PATH` and auth variables while letting a project pin tool cache homes such as `HOME=/private/tmp`.

Future backends should use a real env option when their SDK exposes one. If a backend lacks env injection entirely, document that asymmetry and degrade by adding the expected environment facts to the role brief; Claude and Codex do not use that prompt-only path.

## Normalized intent, native enforcement
A request carries **backend-agnostic intent** — `writeScope`, `readOnly`, `outputSchema`, `maxTokens` — and each backend satisfies it natively:

- **Claude** → PreToolUse scoping hooks + permission mode; `outputSchema` via instruct-and-extract.
- **Codex** → OS `sandbox_mode` (`read-only` / `workspace-write` / `danger-full-access`) + `approvalPolicy: never`; `outputSchema` natively.

The **git worktree is the outer boundary for every backend**, with `writeScopeViolations()` as a backend-independent post-hoc backstop (see [sandbox-first safety](build-loop.md#sandbox-first-safety)).

### Per-role sandbox (Codex) + the worktree safety gate
A **write** role can widen the native sandbox via `roles.<role>.sandbox`
(`workspace-write` | `danger-full-access`). `workspace-write` (the default) scopes writes to
the work tree with no network; `danger-full-access` lifts the sandbox so a Codex generator can
run native toolchains the default Seatbelt profile blocks — e.g. `xcodebuild` — and so
generation load can move off Claude's session limits onto Codex's quota. Mapping
(`src/sdk/backends/codex.ts` `codexSandboxMode`): `readOnly` → `read-only` **always** (read-only
roles ignore the knob) — **except** the exercising evaluator (see below); otherwise the requested
sandbox, defaulting to `workspace-write`.

### Codex evaluator: exercising under `workspace-write` (source-integrity-guarded)
The evaluator is supposed to **exercise** the artifact (run its tests/build), but Codex's
`read-only` sandbox permits **zero** writes, so `npm test`/`tsc` abort with `EPERM` writing
in-repo scratch like `node_modules/.vite-temp` — the evaluator silently degrades to code-review
only. With `exercise.sandbox: workspace-write` (the default) on a **worktree/branch boundary**, the
Codex evaluator instead exercises under `workspace-write` so that scratch can be written, with
**network off**. To preserve the rule that the evaluator must not "fix" the code it grades, the
runner wraps the exercise with a **source-integrity guard** (`src/build/integrity.ts`): it
snapshots the artifact surface (`git ls-files --cached --others --exclude-standard` — tracked +
new non-ignored files, excluding gitignored scratch) before the run and, after it, **reverts** any
modified/deleted/injected artifact file and **forces the verdict to `fail`** with a blocking line
naming the mutated files. Set `exercise.sandbox: read-only` to keep the strict pre-fix sandbox
(scratch-needing tools will `EPERM`). The **Claude** evaluator exercises via an in-process runner
and is unaffected.

The "isolated-checkout boundary" is **a Sparra build branch (`state.build.branch`) OR a linked
git worktree** (`isLinkedWorktree`) — not specifically `build.branch`. So a standalone `sparra
eval`/`run_role` on a git worktree gets writable scratch **without editing `state.json`**. A plain
in-place run (the main worktree, no `build.branch`) still gets **no** scratch.

The **contract-evaluator** is a sandboxed judge too: it runs the contract's *"I will verify by"*
commands (e.g. `npm test`) to prove they're runnable. On an **isolated checkout** (temp worktree via
`--worktree` / a build branch) it also relaxes to **`workspace-write`** with **network off** and the
same source-integrity guard (any write to the tracked surface is reverted and the run **fails**); an
**in-place** contract-evaluator stays strictly **read-only**. `sparra eval`/`role run --worktree`
therefore now **accepts the contract-evaluator** (alongside the evaluator and reviewer).

### Default writable-scratch env layer (both judge roles)
Independently of `exercise.sandbox`, both judge roles (evaluator + contract-evaluator) receive a
**default env layer** (`src/build/judgeScratch.ts`) that redirects `TMPDIR`,
`CLANG_MODULE_CACHE_PATH`, and `SWIFTPM_CACHE_DIR` into a fresh **per-run writable scratch dir**. A
read-only sandbox / unwritable `$HOME` otherwise EPERMs *before any Sparra code runs*: Vitest's
`/var/folders` temp writes, the **tsx** IPC socket (derived from `os.tmpdir()` — `tsx-<uid>` then
`<pid>.pipe`, so `node bin/sparra.mjs` dies creating it), and clang's
`~/.cache/clang/ModuleCache`. Precedence is `process.env` → scratch defaults → your `build.env`
(user override wins). This only moves temp/cache roots — it never widens the sandbox's write scope
over the tracked source (the integrity guard still governs that).

**Safety gate.** Codex runs `hooks: false` + `approvalPolicy: "never"`, so the git
worktree/branch is the *only* boundary. `danger-full-access` is therefore honored **only when
the build is on a worktree/branch** (`build.branch` set). On an in-place / greenfield-no-git run
the request is downgraded to `workspace-write` with a **loud warning** — never silently granted.
The gate lives at the request-construction layer (`src/build/generate.ts` / `roleRun.ts`, via
`gateSandbox`), which is the only place that can see git state; the backend cannot. Use
`git.strategy: worktree` to enable full access.

**Generator self-verify.** Same boundary, same idea for the *writer*: on a worktree/branch the
generator may auto-run `build.verifyCommands` (typecheck/test/build) so it stops "writing blind".
**Codex** runs these inside its `workspace-write` sandbox (no network). **Claude** has no OS
sandbox — the auto-approval is a PreToolUse `allow` for *single, self-contained* verification
commands only (chaining/redirect/network-install/mutation/commit are disqualified), so for Claude
the worktree + "never commit to main" + that disqualifier list are the guarantees (the same
residual as the Claude evaluator's in-process exercise). In-place runs never auto-approve Bash unless they opt in via `allowVerify` / `sparra role run --verify` (generator only).

**Provider limits & empty completions.** A backend reports a hit window via `AgentResult.limitHit`
(rate / usage / session / **auth**). An **auth/transport** failure — a `401 Unauthorized` / missing
bearer, "not logged in · please run /login", an invalid/expired key — classifies as `kind: "auth"`:
the session never ran, so it's a limit (pause-and-retry / fall back), never a behavioral FAIL that
would burn a round. The Codex backend also classifies a **silent empty completion**
(`tokens: 0`, no output, no error) as a limit — it's almost always unavailability or a usage
window, and treating it as a real empty result would churn the loop with a bogus failure. When it
does, it ALSO stamps the **explicit `AgentResult.emptyCompletion` marker**, so downstream
classification keys on the ORIGIN rather than re-inferring from tokens/text (a genuine limit can
also have empty text / zero tokens). That marker matters for a **writer whose files DID change**:
the role-runner reclassifies that case as `RoleRunResult.emptyCompletion` — the work LANDED, only
the report failed to emit — clears the ec's `limitHit`, and refuses to fall back (a second writer
would clobber the landed work); it also surfaces `filesChanged` (always, for a writer) and
`hitBudget` (our own `maxBudgetUsd` cap — resume via `sessionId`), see
[role-runner](role-runner.md). Otherwise, both the autonomous build loop (`build.autoRestart` +
`roles.*.fallback`) and the interactive role-runner (auto-fallback in `run_role`) act on
`limitHit` — switch to a fallback backend/model or wait — rather than failing the work.

## Adding a backend
Implement `AgentBackend` (`id`, `capabilities`, `runTask(req) → AgentResult`) in `src/sdk/backends/<id>.ts`, `registerBackend(...)` it, and import it for its side effect in `session.ts`. The engine reads `capabilities` and uses the richest path available, degrading otherwise. Nothing else changes.

## How it maps to the SDKs
- Each role is one backend task with its own `systemPrompt` (from `.sparra/prompts/`), `backend`/`model`/`effort`. On Claude the system prompt is a native option; **on Codex (no system-prompt channel) it's folded into the input** ahead of the task, along with any inlined skills. Sessions never share memory — they hand off through files.
- **Interactive planning** uses **resume-based multi-turn** (resume by session/thread id per turn) so the interview survives process restarts.
- **Autonomous roles** are one-shot tasks in a loop; sessions that hit `maxTurns` are resumed; GAN restarts use a fresh session.
- `settingSources: []` + `strictMcpConfig: true` (Claude) and a clean env isolate each session from ambient settings — Sparra's state is explicit on disk, which is also why the harness can't accidentally inherit a different project's config. One gap those flags *don't* cover: **auto-fetched claude.ai cloud connectors** (Drive/Gmail/Calendar) attach from the logged-in account, not from a settings file. So the PreToolUse deny-hook (`denyAmbientMcp`, in every guard) is the real boundary — it rejects any `mcp__*` tool that isn't Sparra's own `mcp__exercise__*`. Build agents get no reach into your personal cloud.
