# Plan: add a unit-test suite for Sparra's pure modules

## Intent
Sparra has no automated tests yet. Add a fast, dependency-light unit-test suite
covering the **pure, deterministic** modules so future changes (including Sparra's
own self-improvement runs) have a real safety net. This is deliberately the first
self-host target because these functions need no network/SDK and are trivially
exercisable.

## Constraints
- Use **vitest** (add as a devDependency); wire up `npm test` to run it once
  (non-watch) so CI/the evaluator can run it.
- Tests must be pure and offline — **no** calls to the Claude Agent SDK, no
  network, no spawning real model sessions.
- Do not change runtime behavior of the modules under test; if a test reveals a
  genuine bug, note it as a deviation in CHANGELOG.md (don't silently rewrite
  unrelated code).
- TypeScript must still typecheck (`npm run typecheck`).

## Approach
Add `vitest` + an `npm test` script. Write focused unit tests for the pure modules,
importing them directly. Prioritize the logic most relied upon by the build loop:
- `src/util/extract.ts` — `extractJson` (fenced + bare JSON, last-block-wins,
  malformed input) and `hasMarker`.
- `src/sdk/scoping.ts` — `denyWriteOutsideRoots`, `denyWriteNotFile`,
  `denyAnyWrite`, `denyBash`, `denyBashMutation`, `within`, `firstDeny`.
- `src/detect.ts` — `detect` over fixtures (empty dir → greenfield; manifest+source
  → existing; partial scaffolding → greenfield-light; `--mode` override).
- `src/config.ts` — the deep-merge of partial YAML over defaults.
- `src/build/pivot.ts` — `updateStreaksAndDecide` (streak increments, reset on a
  passing criterion, pivot at N).

## Patterns to conform to
- Match the existing code style in CODEBASE_MAP.md (ESM, `.ts` import extensions,
  small focused modules).
- Put tests next to or mirroring the source (e.g. `test/` or `*.test.ts`); follow
  whatever the codebase already implies.

## Risks & unknowns
- Some "pure" helpers touch the filesystem (`detect` reads dirs) — use temp-dir
  fixtures, not the real repo.
- vitest + ESM + tsx/TS config must resolve `.ts` import specifiers; verify the
  test runner config handles them.

## Success criteria
- `npm test` exists and runs vitest once (non-watch), exiting 0 when tests pass.
- There are passing tests for `extractJson`, the `scoping.ts` deciders, `detect`,
  the config deep-merge, and `updateStreaksAndDecide`.
- Tests are offline and deterministic (no SDK/network).
- `npm run typecheck` still passes with no new errors.
