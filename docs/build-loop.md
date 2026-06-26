# The autonomous build loop (Phase C)

`sparra build` runs a long-horizon loop against the frozen plan. Per work item:

1. **Decompose** — the plan is split into coarse work items (count scales to plan size; a one-screen app is ~1 item, not a dozen). Decomposition is a *planning* act and runs on its own [`decomposer` role](backends.md). It never makes a standalone "scaffold" or "verify it" item — setup folds into the first feature item, and verification is the loop's job. When a [local generator is configured](backends.md#hybrid-local-for-some-items-cloud-for-others) (`roles.generatorLocal`), the decomposer may tag trivially-simple items `gen: "local"` so they build on the local model; you can edit the tags in `items.json` before building.

2. **Contract negotiation** — *before any code*, the generator proposes a "done" contract (*"I'll build X, verify by Y"*) with a **handful of concrete, individually-checkable assertions** (default 6–20, **scaled down** for small items — no padding). A separate **adversarial** evaluator critiques it and they iterate until both agree; the whole negotiation is saved to `.sparra/contracts/<id>.contract.md`.
   - **Proportionality both ways.** A weak contract fails review; so does an over-specified one. The evaluator rejects assertions that gate "done" on incidental trivia (build-setting forensics, code-signing internals, hashes) or on impossible/environment-controlled properties.
   - **Ungameable, runnable verification.** The contract evaluator also rejects discrimination/negative fixtures that don't actually exhibit the property (a "non-match face" with no detectable face), and requires every command in *"I will verify by"* to be confirmed runnable against the real CLI/source/fixtures — a broken verify command both false-fails *and* tends to get copied into the shipped test harness.
   - **Existing projects** must include *"does not regress existing behavior"* and *"conforms to CODEBASE_MAP.md."*

3. **Generate** — the generator implements the item against the **contract** (not the plan prose), writing only inside the work scope. On Apple projects it's also handed the [house Swift conventions](ios.md). Files are formatted on write (below).

4. **Exercise & grade** — the evaluator is adversarial and **actually runs the artifact** — it does not read diffs. The [exerciser is pluggable](#exercisers). It marks every contract assertion PASS/FAIL **with evidence**, scores the **rubric**, and writes a structured verdict to `.sparra/verdicts/`. Grading is against the **contract + rubric**, judged on **product impact** — a working, plan-satisfying artifact isn't failed over incidental contract nits, but an assertion satisfied by a **degenerate/gamed input** (a combine step fed identical copies, a structurally-wrong fixture, a stub) is a FAIL, not a pass-with-notes. The evaluator runs the **shipped/contracted verification as-is** — if an item's own committed tests or contracted verify commands crash as delivered, it won't be laundered into a pass by hand-correcting the invocation. Existing projects also run the repo's own test suite; new failures are a hard fail.

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

Need the build to read a large asset (e.g. a model) that shouldn't be in git? List its directory in [`build.extraReadDirs`](configuration.md) — it's added to the generator's and evaluator's read scope (`additionalDirectories`), so the asset is readable without committing it or opening network access.

Build agents also can't reach your **personal cloud**: `settingSources: []` doesn't suppress auto-fetched claude.ai connectors (Drive/Gmail/Calendar), so every guard's deny-hook rejects any ambient MCP call (`denyAmbientMcp`) — only Sparra's own `mcp__exercise__*` tools are allowed.

## Bounded by default (budgets)
The loop "starts closed". Each item is capped by **cost and/or tokens**; crossing either halts the item as **`BUDGET_EXCEEDED`** and the run moves to the next item (it doesn't crash).

- `build.maxBudgetUsdPerItem` — default **5**. Note `total_cost_usd` is *notional* (tokens × list price); on a subscription you're billed in tokens, so this is a proxy.
- `build.maxTokensPerItem` — a **direct token ceiling**, the meaningful lever on a subscription / with Codex (which reports tokens, not USD). Default `0` (off).
- `maxTurnsPerSession` / `maxRoundsPerItem` bound runaways regardless of pricing.

Set a cap to `0` to opt out of that dimension.

## Auto-restart / model fallback on provider limits
The budgets above are *your* caps. A different thing can stop a long unattended build: the **provider's** own rate / usage / session limit (e.g. Claude's 5-hour or 7-day plan window, an HTTP 429, a Codex quota). Without handling, a limit produces a dead session that the loop would misread as a failed round.

With **`build.autoRestart.enabled`** (off by default), when the generator or evaluator hits a real provider limit the loop:

1. **falls back** — if that role has a **`fallback`** model on a backend that *isn't* limited, it switches to it and continues immediately (no wait), switching back once the primary's window reopens; else
2. **waits** — it sleeps until the window reopens (the backend's reset time when known — Claude provides one via a structured `rate_limit_event`; otherwise it rechecks every `pollSec`), capped per wait by `maxWaitSec`; then
3. **retries the same round** — a limit isn't a failed attempt, so the round is *not* charged against `maxRoundsPerItem`.

Limits are tracked per **backend** (a plan window is account-wide across that provider's models), so a fallback only helps when it's on a *different* provider — e.g. primary `gpt-5-codex` on Codex with `fallback: { backend: claude, model: opus }`. The generator session is **not** resumed across a backend switch (a session id isn't portable); the fallback starts fresh.

Two stop conditions keep it sane (the loop must never run forever): each wait is bounded by `maxWaitSec`, and the whole run gives up after `maxRestarts` wait cycles — stopping **cleanly** (phase stays `build`, the item is left mid-flight, nothing marked failed). State is checkpointed to disk *before* each sleep, so a process kill mid-wait loses nothing: re-run `sparra build` to resume. `sparra status` shows a paused build as *paused on a provider limit — resumes ~HH:MM* rather than looking hung.

## Format on write
A `PostToolUse` hook formats/lints each file the generator writes **before** the evaluator exercises it, so trivial formatting never costs an evaluator round. Greenfield defaults to a prettier-style formatter by file type; existing repos auto-detect from `CODEBASE_MAP.md` (e.g. `swiftformat`/`swiftlint`). Missing formatter → no-op + warning, never a failure. Configure via `format` (see [configuration](configuration.md)).

## Cross-run memory
`.sparra/memory.md` is a durable, append-only log of short learnings (what was tried, and whether it passed / failed / pivoted / ran out of budget). Every autonomous role reads it at the start of each item so prior failures inform new work; `sparra reflect` appends to it. It's capped — oldest entries collapse into a one-line summary so it never grows unbounded.

## Calibration (matching your taste)
Drop reference files into `.sparra/calibration/good/` (aim for this) and `.sparra/calibration/slop/` (avoid this). With `rubric.useCalibration` on, the evaluator reads them before scoring originality/craft.
