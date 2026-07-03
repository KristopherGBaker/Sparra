# CLAUDE.md

Guidance for working in the **Sparra** repo (the harness's own codebase — not a project Sparra builds).

## What this is

Sparra is a long-running **autonomous build harness**: collaborative `plan` → human `freeze` → autonomous `build` (per item: negotiate a "done" contract → generate → an adversarial evaluator *exercises* the artifact → grade → optional code review → pivot/accept → optional commit) → `reflect`. Every model step runs through a pluggable **AgentBackend** (Claude + Codex today). **The filesystem is the source of truth and the only shared state** — phases read inputs from disk and write outputs to disk, so runs are inspectable, diffable, and resumable.

## Commands

```bash
npm run typecheck     # tsc --noEmit — run after every change
npm test              # vitest run (15 test files); keep green
npm run sparra -- …   # run the CLI locally via tsx (or `node bin/sparra.mjs …`)
npm link              # put `sparra` on PATH (once)
```

No build step — bins run the TypeScript directly via `tsx` (`type: module`, `.ts` imports use explicit extensions). **Always run `npm run typecheck && npm test` before committing.**

## Architecture

- `src/cli.ts` — command dispatch. `src/phases/` — one file per phase: `init`, `orient`, `plan`, `prototype`, `freeze`, `build`, `reflect`, `status`, `batch`.
- `src/build/` — the build-loop internals: `decompose`, `contract`, `generate`, `evaluate`, `review` (code-review gate), `pivot`, `reconcile`, `budget`, `holdout`, `swiftConventions`, `modeText`, `types`.
- `src/sdk/` — the agent seam. `backend.ts` (the `AgentBackend` interface + `AgentRequest`/`AgentResult` + registry), `session.ts` (the single choke point: `runSession` → `getBackend().runTask`), `backends/{claude,codex}.ts`, plus `skills`, `hooks`, `guard`, `exercise`, `scoping`, `permissions`, `format`, `trace`.
- `src/` core: `config.ts` (all knobs + `defaultConfig`), `prompts.ts` (role system prompts + `DEFAULT_PROMPTS`), `paths.ts` (`.sparra/` layout), `state.ts`, `context.ts`, `memory.ts`, `detect.ts`.
- `src/util/` — `git`, `io`, `log`, `extract`.

## Conventions & invariants (don't break these)

- **Verify SDK signatures against the installed `.d.ts`** (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, `@openai/codex-sdk/dist/index.d.ts`), never from memory.
- **Safety:** autonomous roles never use `bypassPermissions`; permission default is `auto` (SDK classifier if available, else `acceptEdits`) with a deny-hook (Claude) / OS sandbox (Codex). Sparra **never commits to the user's main branch** — existing repos build on a git worktree/branch, which is the hard outer boundary.
- **Isolation:** the Claude backend runs with `settingSources: []` + `strictMcpConfig: true` (no ambient/parent-project leak); declared skills load via a scoped throwaway local plugin. State is explicit on disk. Note `settingSources: []` does **not** suppress auto-fetched claude.ai cloud connectors (Drive/Gmail/Calendar) — the PreToolUse deny-hook (`denyAmbientMcp`) is the authoritative block: every guard rejects any `mcp__*` call that isn't `mcp__exercise__*`. Keep that deny in place.
- **Holdout wall is enforced in code** — a leak of `HOLDOUT.md` into a forbid role's *prompt* throws (`assertNoHoldoutLeak`), AND every forbid role (interactive `roleRun` *and* the autonomous build-loop generator/reviewer/contract/decomposer/reconcile) drops holdout-bearing dirs from its read scope (authoritative for the Read/Glob/Grep tool) and carries the centralized `makeHoldoutReadDecider` PreToolUse deny-hook. The Bash deny is **best-effort** (a shell with no FS sandbox can read an absolute path / assemble it from pieces — a residual, same as Codex which ignores hooks); the authoritative guarantees are scope-exclusion + the prompt wall + verdict redaction. Keep all of these on every forbid role; the verdict fed back to the generator stays holdout-redacted. The build-loop forbid roles that get a *cwd* — the decomposer + contract-generator/-evaluator — run in a **holdout-free cwd** (`holdoutFreeCwd`: the build worktree when building isolated, since `.sparra` is gitignored and absent there; else `ctx.root` for in-place runs) so a pathless Glob/Grep no longer searches the holdout-bearing root. Their `makeHoldoutReadDecider` tracks **that** cwd (not a hardcoded `ctx.root`), kept as defense-in-depth alongside the prompt wall + redaction; in-place runs keep `cwd=ctx.root` + the Bash residual.
- **Keep the role prompts (`DEFAULT_PROMPTS`) concise — they are read on every item, so length is a recurring token + attention cost.** `reflect` tends to *append* findings, so the prompts ratchet upward over cycles. When you fold in a reflect finding (or any prompt edit), fit it into the existing structure rather than bolting on a new section: extend a bullet, add one to a list, or generalize a rule already present. Don't restate a rule in both a dedicated section *and* the PROCESS steps — state it once and reference it. After editing, re-read the whole role string and cut duplication; a finding usually adds a clause, not a paragraph. Prefer one generalized principle with a short concrete example over several near-duplicate domain-specific rules.
- **Backends are per-role and capability-driven** — read `capabilities`, use the richest path, degrade. New backend = implement `AgentBackend`, `registerBackend`, import for side effect in `session.ts`.

## Testing

Vitest, in `test/`. Tests **inject dependencies** (e.g. `BuildDeps`, `runSessionFn`) and **never make live API/model calls** — fake the session and assert on the request/flow. Add tests with each feature; mirror the existing patterns (`build.test.ts`, `review.test.ts`, `skills.test.ts`).

The phase logger (`src/util/log.ts`) is **silenced under vitest** (gated on `process.env.VITEST`) so the runner's pass/fail summary isn't buried in phase-log noise; set `SPARRA_LOG_IN_TESTS=1` to restore log output for debugging (a test asserting on log output must set this escape hatch).

## Git

Do feature work on a `sparra/<topic>` branch, then fast-forward merge to `main` (never commit directly to `main`). Use **conventional commits**; end commit messages with the `Claude-Session:` footer. Commit/push only when the user asks.

## ⚠️ Keep docs in sync with feature work

**Any change that adds or alters user-facing behavior (a config knob, a phase, a role, a backend capability, a CLI flag) MUST update the docs in the same change.** This repo's "docs" are three layers — update all that apply:

1. **`README.md`** — the on-ramp: the loop diagram, the "How it works" bullets, requirements. Update when a headline capability changes.
2. **`docs/`** — the detail: `configuration.md` (every knob + the `.sparra/` layout), `build-loop.md`, `backends.md`, `phases.md`, `ios.md`. A new config field belongs in `configuration.md`; new loop behavior in `build-loop.md`; backend changes in `backends.md`.
3. **`skills/sparra/`** — the operational skill: `SKILL.md` (driving/configuring/diagnosing) and `subskills/diagnose.md` (the failure-signature table + artifact list). Update when behavior, knobs, or failure modes change, and bump the plugin version in `.claude-plugin/marketplace.json`.

A feature isn't done until typecheck + tests pass **and** these reflect it. When in doubt, grep the docs/skill for the old behavior and fix every hit.
