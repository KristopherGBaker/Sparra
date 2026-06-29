# The autonomous build loop (Phase C)

`sparra build` runs a long-horizon loop against the frozen plan. Per work item:

> Prefer to stay in the loop? The same contract → generate → exercise → pivot/accept cycle can be driven by hand from a Claude Code session via the [role-runner](role-runner.md) (the `/sparra-loop` skill). This page describes the autonomous version; the mechanics below apply to both.

1. **Decompose** — the plan is split into coarse work items (count scales to plan size; a one-screen app is ~1 item, not a dozen). Decomposition is a *planning* act and runs on its own [`decomposer` role](backends.md). It never makes a standalone "scaffold" or "verify it" item — setup folds into the first feature item, and verification is the loop's job. When a [local generator is configured](backends.md#hybrid-local-for-some-items-cloud-for-others) (`roles.generatorLocal`), the decomposer may tag trivially-simple items `gen: "local"` so they build on the local model; you can edit the tags in `items.json` before building.

2. **Contract negotiation** — *before any code*, the generator proposes a "done" contract (*"I'll build X, verify by Y"*) with a **handful of concrete, individually-checkable assertions** (default 6–20, **scaled down** for small items — no padding). A separate **adversarial** evaluator critiques it and they iterate until both agree; the whole negotiation is saved to `.sparra/contracts/<id>.contract.md`.
   - **Proportionality both ways.** A weak contract fails review; so does an over-specified one. The evaluator rejects assertions that gate "done" on incidental trivia (build-setting forensics, code-signing internals, hashes, **internal invocation counts**) or on impossible/environment-controlled properties — assertions should pin **observable net-effects/invariants** (e.g. "no duplicate commit", not "commit called once").
   - **Ungameable, runnable verification.** The contract evaluator also rejects discrimination/negative fixtures that don't actually exhibit the property (a "non-match face" with no detectable face), and requires every command in *"I will verify by"* to be confirmed runnable against the real CLI/source/fixtures — a broken verify command both false-fails *and* tends to get copied into the shipped test harness.
   - **Existing projects** must include *"does not regress existing behavior"* and *"conforms to CODEBASE_MAP.md."*

3. **Generate** — the generator implements the item against the **contract** (not the plan prose), writing only inside the work scope. On Apple projects it's also handed the [house Swift conventions](ios.md). Files are formatted on write (below). On a worktree boundary the generator can **self-verify** — it auto-runs the project's `build.verifyCommands` (typecheck/test/build) and fixes what it broke instead of writing blind; only single, self-contained verification commands are auto-approved (no chaining/redirect/network/mutation/commit).

4. **Exercise & grade** — the evaluator is adversarial and **actually runs the artifact** — it does not read diffs. The [exerciser is pluggable](#exercisers). It marks every contract assertion PASS/FAIL **with evidence**, scores the **rubric**, and writes a structured verdict to `.sparra/verdicts/`. Grading is against the **contract + rubric**, judged on **product impact** — a working, plan-satisfying artifact isn't failed over incidental contract nits, but an assertion satisfied by a **degenerate/gamed input** (a combine step fed identical copies, a structurally-wrong fixture, a stub) is a FAIL, not a pass-with-notes. The evaluator runs the **shipped/contracted verification as-is** — if an item's own committed tests or contracted verify commands crash as delivered, it won't be laundered into a pass by hand-correcting the invocation. Existing projects also run the repo's own test suite; new failures are a hard fail.

5. **GAN-style pivot** — if an item stays below threshold on the **same rubric criterion** for `N` rounds, Sparra **discards and restarts it from scratch** with a different approach instead of patching forever (`N` and threshold configurable). The pivot is logged to memory. A **BLOCKED** exercise (the verdict's `exerciseStatus` — the exercise couldn't *run* due to the environment, e.g. a missing tool, not the artifact) is **inconclusive**: it is *not* counted as a behavioral fail, never advances a pivot streak, and keeps its score — it's surfaced for the human instead. (Item 1's writable-scratch sandbox makes this rare; this is the safety net for when the exercise still can't run.)

6. **Accept → reconcile → commit** — on pass, deviations are reconciled into `PLAN.md` so the plan never goes stale, and a learning is appended to memory. If `git.autoCommit` is on (and the build is on a Sparra-created branch/worktree), the item is committed — incremental, revertable history, never on your main branch. In-place / non-git builds are never auto-committed. Two authoring modes (`git.agentCommits`):
   - **`agent`** (default) — the cheap **`committer`** role reads the diff and proposes **one or more atomic Conventional Commits**, split by logical change (a refactor, the feature, a docs tweak become separate commits). The harness *executes* the plan (the model never runs git), appends a `Sparra-Item: <id>` trailer to each, and sweeps anything the plan misses into a final commit so nothing is lost. On any failure it falls back to `template`. The committer is read-only, confined to the workspace, and never sees the holdout. Configure its model/backend via `roles.committer` (defaults to a cheap model — e.g. Haiku).
   - **`template`** — one deterministic commit per item from the item title/summary (`feat: <item> … Sparra-Item: <id>`), no model call.

   **Durable acceptance (crash-safe & idempotent).** Acceptance runs three side effects in order — **reconcile → commit → memory** — through a single finisher guarded by a durable ledger on the item (`acceptance: { reconciled, committed, memoryAppended }`). The item is marked `passed` and the ledger opened in **one atomic save**, and each flag is persisted the instant its step completes. So a process kill *anywhere* between "mark passed" and the side effects loses nothing and doubles nothing: on the next `sparra build`, a `passed` item with an incomplete ledger is detected at the top of the item loop (before the passed-skip) and the finisher re-drives **only the unfinished steps** — `commitItem` runs at most once, the `passed` memory line is appended at most once. `committed` records the commit *step* as resolved whether it actually committed, was human-skipped at the `commit` gate, or was N/A (autoCommit off / no Sparra branch), so it neither repeats nor is silently dropped. Both accept paths — the autonomous pass and the interactive `accept` (`--step`) — funnel through this one finisher; a `commit`-gate pause is just the finisher parking at the commit step and resuming there. `--fresh` clears the ledger with the rest of the per-item state.

---

## Exercisers
How the evaluator exercises the artifact, set by `exercise.mechanism`:

- **`cli`** *(default)* — run the built tool with real args; assert on stdout/stderr/exit codes.
- **`web`** — start the app, probe over HTTP; wire in Playwright/Chrome MCP for richer flows.
- **`ios`** — Apple-platform apps via the `xcodebuildmcp` CLI; the multimodal evaluator screenshots the running UI and reads it, plus the `describe-ui` hierarchy for deterministic checks. See **[the iOS/macOS guide](ios.md)**.
- **`computer-use`** — exercise end-to-end as a user would.
- **`custom`** — your own shell recipe.

The evaluator gets an in-process MCP server (`mcp__exercise__run_command`, plus `http_request` for web) so every exercise is structured and logged.

**`exerciseStatus` is harness-determined, not self-reported.** The harness classifies the real exit code of every `mcp__exercise__run_command`/`http_request` invocation (`classifyExerciseExit` in `src/sdk/exercise.ts`) — `127`/spawn errors and a small block-signature set (`command not found`, `EPERM`, `operation not permitted`, `permission denied`, `requires approval`) ⇒ **blocked**; an executed-but-failed command (exit 1/2, a timeout) ⇒ **ran** — and aggregates them: blocked if any was blocked, else ran. This harness verdict **overrides** the model's self-reported `exerciseStatus` whenever the evaluator used the tools, so a model can't launder a sandbox-blocked command into a pass (a blocked exercise can never be a pass — `roleRun.ts`/`evaluate.ts`/`pivot.ts`/`build.ts`), and even a no-parseable-verdict run carries `blocked` rather than the old hardcoded `"ran"`. **Scope:** this covers verifications routed through `run_command`/`http_request` only — the evaluator's raw `Bash` is **not** observed, so those fall back to the model's self-report (the evaluator is nudged to verify via `run_command`). The model self-report remains the fallback when no exercise tool was used.

On the **Codex** backend (which has no in-process runner, only its OS sandbox), the exercise runs with **writable scratch** (`exercise.sandbox: workspace-write`, network off) so test/build tools can write the scratch they need — but the **artifact surface is integrity-guarded**: any write the evaluator makes to tracked/new source is reverted and **forces the round to `fail`** (see [backends](backends.md#codex-evaluator-exercising-under-workspace-write-source-integrity-guarded)).

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
Author acceptance checks in **`HOLDOUT.md`** and **only the evaluator** ever sees them — the generator and the contract negotiation never do. The wall is **enforced in code several ways**: a holdout leak into a forbid role's *prompt* throws (`assertNoHoldoutLeak`); every build-loop forbid role (generator, reviewer, contract-generator/-evaluator, decomposer, plan reconcile) **drops holdout-bearing dirs from its read scope** so the `Read`/`Glob`/`Grep` tool can't reach `HOLDOUT.md` or anything under `.sparra` (verdicts and evaluator traces are holdout-derived too); and the verdict that flows back as generator feedback is holdout-**redacted** first. A PreToolUse deny-hook also blocks `Read`/`Glob`/`Grep`/`Bash` references to the holdout. The tool-scope exclusion + prompt wall + redaction are the **authoritative** guarantees; the **Bash** deny is *best-effort* — a shell on a backend with no FS sandbox can read an arbitrary absolute path (or assemble it via string concatenation / an interpreter), so a determined Bash read of a holdout that sits outside the role's cwd is a residual (the hook still blocks the literal and glob-evasion cases, and a cooperative generator has no reason to seek it). This residual is the same on Codex (which ignores hooks entirely) and Claude (raw Bash isn't FS-sandboxed); a holdout in the role's *cwd* is likewise reachable there. To shrink it, the build-loop forbid roles that carry a *cwd* — the **decomposer** and **contract-generator/-evaluator** — run in a **holdout-free cwd** when building isolated: the git **worktree** (`.sparra` is gitignored, so the worktree is a full source checkout *without* the holdout), removing the holdout from their cwd tree entirely so a pathless `Glob`/`Grep` no longer resolves into `.sparra`. Their deny-hook tracks that cwd (not a hardcoded root) so worktree searches resolve correctly while absolute/pattern holdout reads stay denied; in-place (`workspaceDir === ctx.root`) runs keep `cwd=ctx.root` and the Bash residual. The builder can't overfit to checks it can't read, so holdouts are an independent gate on real behavior; any holdout failure is blocking. Strongest combined with a **different backend grading than building** (see [backends](backends.md)). The file is frozen alongside the plan at `freeze`.

## Sandbox-first safety
Whatever scoped the writes — Claude PreToolUse hooks or Codex's OS sandbox — Sparra verifies **post-hoc** that nothing escaped the work scope into the repo (`writeScopeViolations`), warning on genuine escapes. Backend-independent. On existing repos the **git worktree** is the hard outer boundary; the build's cwd is the worktree.

Need the build to read a large asset (e.g. a model) that shouldn't be in git? List its directory in [`build.extraReadDirs`](configuration.md) — it's added to the generator's and evaluator's read scope (`additionalDirectories`), so the asset is readable without committing it or opening network access.

A fresh worktree is a bare checkout with no `node_modules`, so the generator's verify commands and the evaluator's `npm test` would otherwise have nothing to run against. Sparra **provisions the repo's deps into the worktree** once it's created — see [`git.provisionDeps`](configuration.md). The dirs are **copied** (copy-on-write where the filesystem supports it), never symlinked, so nothing points outside the worktree to break the workspace-write scratch sandbox; it's a no-op in place and skippable. The standalone `sparra eval`/`role run` path provisions the same way when its workspace is a linked worktree, so a worktree eval doesn't have to fall back to a slow network `npm install`.

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

## Interactive / human-in-the-loop (`sparra build --step`)
The loop is autonomous by default. Pass **`--step=contract,round,commit,item`** (any subset; a bare `--step` enables all four) to insert **human checkpoints** — using the same checkpoint-and-exit + resume-from-disk model as the provider-limit pause, *not* blocking prompts. With no `--step` the build is byte-for-byte the autonomous loop (every interactive branch is skipped).

At a checkpoint the build writes a steering folder under **`.sparra/interactive/<run>/<item>/`**, records the pause in state (`build.paused`), and exits; you edit the files and re-run `sparra build` to continue (`--step` is remembered across the resume).

- **`contract`** — pauses right after the "done" contract is negotiated, before any generation. Review/edit the contract file (the text under the `AGREED CONTRACT` marker); resume builds against your edits. A holdout leak in the edited contract is rejected on resume.
- **`round`** — pauses after each evaluator verdict, before the accept/pivot decision. `pause.md` is a **holdout-redacted** verdict summary; set `decision.json` to one of:
  - **`continue`** — patch & re-evaluate; edit `feedback.md` to steer the next round (the default).
  - **`pivot`** — discard this approach and rebuild from scratch (bumps the pivot count).
  - **`accept`** — accept the item now. Overriding a **failed** verdict requires a `reason` (recorded to `memory.md` as an audit trail); accepting a pass needs none.
  - **`abandon`** — give up on the item.
  `feedback.md` is leak-checked before it reaches the generator, so holdout can't slip in via your edits.
- **`commit`** — when `git.autoCommit` is on (and the build is on a Sparra branch), pauses *after* an item is accepted (it's already marked **passed**) but *before* the commit lands. `pause.md` lists the file set to be committed (holdout excluded); set `decision.json` to **`commit`** (the default — commit onto the Sparra branch) or **`skip`** (leave the change uncommitted; the item still counts as passed). With `autoCommit` off / no branch, this gate is inert and commit behavior is unchanged.
- **`item`** — pauses *after* an item reaches a terminal status (passed / failed / abandoned / budget-exceeded) and *before* the next item starts (never after the final item). Set `decision.json` to **`continue`** (move to the next item — the default) or **`stop`** (end the run cleanly; a later `sparra build` resumes from the *next* item).

Interactive mode is **remembered** so a plain `sparra build` resumes a pause — to leave it, start a new run with `sparra build --fresh` (or `sparra new`), which clears the mode and any pause. Only one item is paused at a time; a `--step` build refuses a `--only` that would skip the paused item (resume it first). A human `accept` marks the item passed *before* the reconcile/commit/memory side effects, and goes through the **same durable acceptance finisher as the autonomous loop**, so a process kill anywhere in that window loses nothing and double-applies nothing — see [durable acceptance](#durable-acceptance--resume) below.

The conductor in the `/sparra-loop` skill drives this for you. Today's steps are `contract`, `round`, `commit`, and `item`.

### Inline prompts in the TUI
The plain CLI keeps the checkpoint-and-exit model above (edit files in `.sparra/interactive/…`, re-run `sparra build`). The Ink TUI (`sparra-tui`) instead surfaces a pause **inline**, so you never leave the app:

- Press **`B`** (shift-b) to start a **stepped build** (`sparra build --step=contract,round,commit,item`). Plain **`b`** is unchanged — fully autonomous.
- When the build pauses, the TUI reads the same holdout-redacted `pause.md`, shows it, and offers the **decision menu** for that pause kind (↑/↓ to choose, Enter to select). For a `round` pause it then collects optional **feedback** (continue/pivot) or a **reason** (accept) in a text field.
- On submit it writes `decision.json` (+ `feedback.md`) exactly like a hand edit, then resumes with a plain `sparra build` (interactive mode is remembered in state). The TUI never reads the holdout, and the feedback it writes is still leak-checked at resume time — the redaction/leak wall stays in `build.ts`/`interactive.ts`.

A `contract` pause's inline option is just **`resume`** (you edit the contract file in your own editor, as the summary notes). If a decision write fails it's logged rather than crashing the app.

## Format on write
A `PostToolUse` hook formats/lints each file the generator writes **before** the evaluator exercises it, so trivial formatting never costs an evaluator round. Greenfield defaults to a prettier-style formatter by file type; existing repos auto-detect from `CODEBASE_MAP.md` (e.g. `swiftformat`/`swiftlint`). Missing formatter → no-op + warning, never a failure. Configure via `format` (see [configuration](configuration.md)).

## Cross-run memory
`.sparra/memory.md` is a durable, append-only log of short learnings (what was tried, and whether it passed / failed / pivoted / ran out of budget). Every autonomous role reads it at the start of each item so prior failures inform new work; `sparra reflect` appends to it. It's capped — oldest entries collapse into a one-line summary so it never grows unbounded.

## Durable acceptance / resume
Accepting an item runs three side effects — **reconcile** PLAN.md, **commit**, append the `passed`
**memory** learning — and Sparra guarantees each happens **exactly once**, even if the process is
killed mid-acceptance. Both accept paths (the autonomous pass and an interactive `accept`) funnel
through a single idempotent finisher backed by a durable ledger on the item state
(`acceptance: { reconciled, committed, memoryAppended }`):

- The item is marked **`passed`** and its deviations persisted **before** any side effect runs, so a
  resume always has the deviation context the reconcile/commit need.
- Each step flips its ledger flag and persists it **immediately** after the step resolves; on resume
  a passed item with an incomplete ledger re-drives only the *unfinished* steps at the top of the
  item loop, before the passed-skip — nothing is lost.
- A flag-save can itself be lost (crash *after* a side effect, *before* its flag persists), so the
  side effects are also **idempotent**: `commitItem` finds nothing left to stage and no-ops on a
  re-run; the `passed` memory append is **deduped** against memory.md by item id (skipped if already
  present); reconcile rewrites PLAN.md to reflect reality rather than appending. The flag prevents the
  normal double-run; idempotency closes the lost-flag window — together they make acceptance
  exactly-once.

The `committed` flag marks the commit **step** resolved — actually committed, human-skipped (commit
gate), or N/A (`autoCommit` off / no branch) — so it neither repeats nor is silently dropped.
`--fresh` clears the ledger along with the rest of the run state.

## Calibration (matching your taste)
Drop reference files into `.sparra/calibration/good/` (aim for this) and `.sparra/calibration/slop/` (avoid this). With `rubric.useCalibration` on, the evaluator reads them before scoring originality/craft.
