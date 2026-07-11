# conductors/pi

The **Pi conductor adapter** — exposes `conductors/core` (see [`../README.md`](../README.md)) as
Pi tools and an SDK-driven isolated-role runner. It does not reimplement redaction, spawning, or
concurrency — everything here is a thin wrapper over the core.

## Files

| File | Pi/typebox? | Purpose |
| --- | --- | --- |
| `roleRunner.ts` | **No** — Pi-free | `runSparraRoleForTool(input, deps?)`: builds a `RunRoleSpec` from a structured tool input and calls the core's `runRole` (injectable via `deps.runRole` for tests). Returns `{ summary, text }` — a `ParentSummary` plus a compact, holdout-safe rendering (verdict / weightedTotal / passThreshold / blocking count / verdictPath / flags). This is the tested logic. |
| `extension.ts` | **Yes** (real Pi extension) | Default-exports `sparraConductorExtension(pi)`, which registers the `sparra_role` tool (TypeBox params) on a Pi `ExtensionAPI`. `execute` calls `runSparraRoleForTool` and returns `{ content: [{type:"text",text}], details: { summary } }`. This is Pi's own entrypoint — never imported by a test. |
| `piConductor.ts` | Lazy only | `runIsolatedRoleViaPiSdk(opts?)`: the PROGRAM-conductor pattern — spawns an isolated Pi agent session (via the Pi SDK) restricted to `["bash","read"]` tools that runs `conductors/core/roleWorker.ts`, and returns only the parsed summary. The Pi SDK is loaded via `await import(...)` **inside** the function, so importing this module (or `index.ts`) never loads Pi. |
| `index.ts` | **No** — Pi-free | Barrel re-exporting `runSparraRoleForTool` (+ types) and `runIsolatedRoleViaPiSdk` (+ types), plus the core types. Deliberately does **not** re-export `extension.ts` — that file's top-level Pi/typebox imports would load Pi the moment the barrel is imported. |
| `roleRunner.test.ts` | **No** — offline | Vitest, drives `runSparraRoleForTool` against the core's stub `sparra` (`conductors/core/__fixtures__/stub-sparra.mjs`) and an injected `runRole` spy. No model auth, no network. |

## Pi + typebox are optional peer deps

`@earendil-works/pi-coding-agent` and `typebox` are installed here as **devDependencies** (not
runtime `dependencies`) — they're needed to build/typecheck `extension.ts` and `piConductor.ts` and
to run a live smoke, but `roleRunner.ts` and `index.ts` (and everything `npm test` exercises) never
import them. A consumer who only wants the Pi-free tool logic doesn't need Pi installed at all.

## Loading the extension in Pi

Point Pi's extension loader at `conductors/pi/extension.ts` (or a compiled `.js` if your Pi build
requires it) so `sparraConductorExtension` runs at startup and registers `sparra_role`. The tool
takes `{ args: string[], roleKind?: string, sparraBin?: string, holdoutPath?: string }` and returns
only the redacted summary — never a raw evaluator transcript, `HOLDOUT.md` content, or trace
directory.

## Live smoke: `runIsolatedRoleViaPiSdk`

`piConductor.ts`'s `runIsolatedRoleViaPiSdk` is **live-only** — it needs a real, authenticated Pi
model (default `openai-codex` / `gpt-5.6-sol`; requires Codex OAuth login) and is not exercised by
`npm test`. To smoke-test it once logged in:

```ts
import { runIsolatedRoleViaPiSdk } from "./conductors/pi/piConductor.ts";

const summary = await runIsolatedRoleViaPiSdk({
  roleArgs: ["role", "run", "--kind", "evaluator", "--contract", "contract.md"],
  cwd: "/path/to/a/sparra/unit/worktree",
});
console.log(summary.verdict, summary.weightedTotal);
```

Run it with `tsx`, e.g.:

```sh
npx tsx -e '
import { runIsolatedRoleViaPiSdk } from "./conductors/pi/piConductor.ts";
const s = await runIsolatedRoleViaPiSdk({ roleArgs: ["role","run","--kind","evaluator"] });
console.log(JSON.stringify(s, null, 2));
'
```

If no model is available for the requested provider/model (auth absent), it throws a clear error
rather than silently no-op'ing.

## Safety invariant

Same as `conductors/core`: never read `HOLDOUT.md` directly; only pass its path (`holdoutPath` on
the tool input becomes `--holdout <path>` in the sparra CLI args) and consume the redacted summary.
Neither `roleRunner.ts` nor `extension.ts` ever opens a holdout path itself.

## Tests

`conductors/pi/roleRunner.test.ts` (vitest, in the `unit` project, alongside `conductors/core`'s
tests) — offline, no live model/network. `npm run typecheck && npx vitest run conductors/` must
stay green.
