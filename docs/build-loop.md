# The autonomous build loop (Phase C)

`sparra build` runs a long-horizon loop against the frozen plan. Per work item:

1. **Decompose** — the plan is split into coarse work items (count scales to plan size; a one-screen app is ~1 item, not a dozen). Decomposition is a *planning* act and runs on its own [`decomposer` role](backends.md). It never makes a standalone "scaffold" or "verify it" item — setup folds into the first feature item, and verification is the loop's job.

2. **Contract negotiation** — *before any code*, the generator proposes a "done" contract (*"I'll build X, verify by Y"*) with a **handful of concrete, individually-checkable assertions** (default 6–20, **scaled down** for small items — no padding). A separate **adversarial** evaluator critiques it and they iterate until both agree; the whole negotiation is saved to `.sparra/contracts/<id>.contract.md`.
   - **Proportionality both ways.** A weak contract fails review; so does an over-specified one. The evaluator rejects assertions that gate "done" on incidental trivia (build-setting forensics, code-signing internals, hashes) or on impossible/environment-controlled properties.
   - **Existing projects** must include *"does not regress existing behavior"* and *"conforms to CODEBASE_MAP.md."*

3. **Generate** — the generator implements the item against the **contract** (not the plan prose), writing only inside the work scope. On Apple projects it's also handed the [house Swift conventions](ios.md). Files are formatted on write (below).

4. **Exercise & grade** — the evaluator is adversarial and **actually runs the artifact** — it does not read diffs. The [exerciser is pluggable](#exercisers). It marks every contract assertion PASS/FAIL **with evidence**, scores the **rubric**, and writes a structured verdict to `.sparra/verdicts/`. Grading is against the **contract + rubric**, judged on **product impact** — a working, plan-satisfying artifact isn't failed over incidental contract nits. Existing projects also run the repo's own test suite; new failures are a hard fail.

5. **GAN-style pivot** — if an item stays below threshold on the **same rubric criterion** for `N` rounds, Sparra **discards and restarts it from scratch** with a different approach instead of patching forever (`N` and threshold configurable). The pivot is logged to memory.

6. **Accept → reconcile → commit** — on pass, deviations are reconciled into `PLAN.md` so the plan never goes stale, and a learning is appended to memory. If `git.autoCommit` is on (and the build is on a Sparra-created branch/worktree), the item is committed as **one conventional commit** (`feat: <item> … Sparra-Item: <id>`) — incremental, revertable history, never on your main branch. In-place / non-git builds are never auto-committed.

---

## Exercisers
How the evaluator exercises the artifact, set by `exercise.mechanism`:

- **`cli`** *(default)* — run the built tool with real args; assert on stdout/stderr/exit codes.
- **`web`** — start the app, probe over HTTP; wire in Playwright/Chrome MCP for richer flows.
- **`ios`** — Apple-platform apps via the `xcodebuildmcp` CLI; the multimodal evaluator screenshots the running UI and reads it, plus the `describe-ui` hierarchy for deterministic checks. See **[the iOS/macOS guide](ios.md)**.
- **`computer-use`** — exercise end-to-end as a user would.
- **`custom`** — your own shell recipe.

The evaluator gets an in-process MCP server (`mcp__exercise__run_command`, plus `http_request` for web) so every exercise is structured and logged.

---

## Code review (optional)
A second, independent lens — turned on with `review.enabled` (off by default). After an
item **passes the behavioral evaluator**, a `reviewer` role reads the diff/source for what
the exerciser can't see: security (committed secrets, weakened sandboxing/ATS/entitlements),
**dead/vestigial code**, structure/duplication, swallowed errors, and conformance to
`CODEBASE_MAP.md` / the house conventions. It's read-only and best run on a **different
backend than the generator** (genuine second eyes — set `roles.reviewer.backend`).

It emits structured findings with severity; `review.blockOn` decides what gates acceptance:
`high` (security/correctness/dead-code), `all` (advisory too), or `none` (advisory-only).
A blocking finding fails the round with the findings as feedback — the item isn't accepted
until it both **runs** (evaluator) and **reads clean** (reviewer), like CI + code review on
a real team. Findings are written to `.sparra/reviews/<id>.r<n>.review.md`; cost counts
toward the per-item budget. The reviewer is held to the same **proportionality** bar as the
contract — substantive issues only, never style the formatter/linter already handles.

## Holdout / isolation wall (optional)
Author acceptance checks in **`HOLDOUT.md`** and **only the evaluator** ever sees them — the generator and the contract negotiation never do (**enforced in code**: a leak throws). The builder can't overfit to checks it can't read, so holdouts are an independent gate on real behavior; any holdout failure is blocking. Strongest combined with a **different backend grading than building** (see [backends](backends.md)). The file is frozen alongside the plan at `freeze`.

## Sandbox-first safety
Whatever scoped the writes — Claude PreToolUse hooks or Codex's OS sandbox — Sparra verifies **post-hoc** that nothing escaped the work scope into the repo (`writeScopeViolations`), warning on genuine escapes. Backend-independent. On existing repos the **git worktree** is the hard outer boundary; the build's cwd is the worktree.

## Bounded by default (budgets)
The loop "starts closed". Each item is capped by **cost and/or tokens**; crossing either halts the item as **`BUDGET_EXCEEDED`** and the run moves to the next item (it doesn't crash).

- `build.maxBudgetUsdPerItem` — default **5**. Note `total_cost_usd` is *notional* (tokens × list price); on a subscription you're billed in tokens, so this is a proxy.
- `build.maxTokensPerItem` — a **direct token ceiling**, the meaningful lever on a subscription / with Codex (which reports tokens, not USD). Default `0` (off).
- `maxTurnsPerSession` / `maxRoundsPerItem` bound runaways regardless of pricing.

Set a cap to `0` to opt out of that dimension.

## Format on write
A `PostToolUse` hook formats/lints each file the generator writes **before** the evaluator exercises it, so trivial formatting never costs an evaluator round. Greenfield defaults to a prettier-style formatter by file type; existing repos auto-detect from `CODEBASE_MAP.md` (e.g. `swiftformat`/`swiftlint`). Missing formatter → no-op + warning, never a failure. Configure via `format` (see [configuration](configuration.md)).

## Cross-run memory
`.sparra/memory.md` is a durable, append-only log of short learnings (what was tried, and whether it passed / failed / pivoted / ran out of budget). Every autonomous role reads it at the start of each item so prior failures inform new work; `sparra reflect` appends to it. It's capped — oldest entries collapse into a one-line summary so it never grows unbounded.

## Calibration (matching your taste)
Drop reference files into `.sparra/calibration/good/` (aim for this) and `.sparra/calibration/slop/` (avoid this). With `rubric.useCalibration` on, the evaluator reads them before scoring originality/craft.
