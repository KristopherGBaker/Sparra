---
name: sparra-loop
description: >-
  Run Sparra's adversarial build loop INSIDE an interactive Claude Code session:
  set up the project (`sparra init` + per-role backend/model config), then drive a
  contract → generate → cross-model adversarial evaluate (e.g. a Codex evaluator
  grading Claude's work) → pivot/accept loop using the `run_role` MCP tool (or
  `sparra role run`), with the holdout wall enforced by the runner. Use when the
  user wants Sparra-style rigor on tap, to configure which model builds vs judges,
  a cross-model second opinion on generated work, or to grade an artifact against a
  contract/holdout.
---

# sparra-loop — Sparra's loop, interactively

You are the **conductor**. You drive the loop; the **rigor lives in the runner**
(`run_role`), not in this playbook. Roles run on a chosen backend (claude/codex/…)
through Sparra's existing seam, so you can pit models against each other.

## Setup (first run) — init + pick the model split
The runner reuses the project's `.sparra/` (config, prompts, rubric) when present, so set
it up once. **`sparra init` is OPTIONAL:** ad-hoc `sparra eval` / `run_role` / `role run`
work config-less (default backends + built-in prompts) with no `.sparra/` — skip init for
a quick cross-model second opinion. Run init for a customized or full plan→build loop:

1. **Initialize** (only for customization or the full loop) if there's no `.sparra/` dir:
   run `sparra init` (greenfield/existing is auto-detected; add `--docs docs` to keep
   planning files in a subfolder). This scaffolds `.sparra/config.yaml` + role prompts. For
   a one-off eval you can skip this and pass `--backend`/`--model` per call instead.
2. **Pick who builds vs judges** with the user, then edit `.sparra/config.yaml` `roles.*`
   (each role: `backend` claude|codex, `model`, optional `effort`). The high-value default
   is **cross-model**: one family builds, another judges. Example:
   ```yaml
   roles:
     generator: { backend: claude, model: opus, effort: high }
     evaluator: { backend: codex,  model: gpt-5.5, effort: high }
     reviewer:  { backend: codex,  model: gpt-5.5 }
   ```
3. **Verify the chosen backends are usable** before relying on them: Codex needs the
   `codex` CLI authed (`~/.codex`) and `@openai/codex-sdk` installed in the Sparra repo —
   if either is missing, say so and fall back to a Claude evaluator (still useful, just
   same-family). Confirm Claude auth (CC login / `ANTHROPIC_API_KEY`).
4. **Self-verify gates:** before relying on generator self-verify (`allowVerify` /
   `--verify`), set the project's own gates in `.sparra/config.yaml`
   `build.verifyCommands` — a config-less run only gets the defaults, so custom gates
   (`make seed`, a project script) won't be auto-approved. Each entry must be a SINGLE
   matchable command: chained/subshell/piped forms (`(cd X && swift test)`, `a && b`)
   never match the allowlist.
   **`unitWorktree` generators get self-verify automatically** — a `unitWorktree` generator
   runs in a persistent linked git worktree, so the runner detects the boundary and enables
   self-verify (the same strict `allowVerifyBash` allow-hook) without `allowVerify`. You do
   NOT need to pass `allowVerify: true` for a `unitWorktree` generator run.
   **Pass `allowVerify: true` for in-place generators** whose contract gates on commands: if
   you launch a generator in-place (no `unitWorktree`, no `build.branch`) and the contract's
   "I will verify by" section references a `build.verifyCommands` entry (e.g. `npm test`,
   `npm run typecheck`), those commands are approval-blocked without `allowVerify: true`. The
   runner **warns you at launch** via a `verifyGateWarning` field on the `run_role` result
   (and in the phase log): if you see it, **re-run with `allowVerify: true`** (MCP) /
   **`--verify`** (CLI) before spending more turns, or accept that the assertions will be
   unverified. The warning names the exact blocked commands.
5. **Holdout (optional but recommended):** if the user wants a second, hidden gate, create
   `.sparra/HOLDOUT.md` with acceptance checks **the generator must not see** — you (the
   conductor) write it but DON'T keep it in context after; pass it to the evaluator by path.

You can re-run `sparra init` later (it preserves existing config/PLAN), and tweak
`roles.*` per project anytime — changes are picked up on the next role run.

## The one rule that matters: the holdout wall
- **Never read `HOLDOUT.md`** (or `.sparra/frozen/HOLDOUT.frozen.md`). Pass it to the
  evaluator **by path** (`holdoutPath`). The runner is the only thing that reads it,
  and only for the evaluator. If you read it, you contaminate the generator through
  shared context.
- Read **verdicts**, never the evaluator's raw output. The MCP tool returns only the
  verdict for the evaluator role. Every evaluator run **auto-persists** its holdout-redacted
  verdict under `.sparra/verdicts/role-run-evaluator-<stamp>.verdict.md` (surfaced as
  `verdictPath`) even when you pass no `out`, so `sparra reflect` has evaluator-side evidence.

## The loop
Drive the loop as a **scheduler turn**, not a sequential recipe: every conductor reply re-plans
the whole board, launches all work that can run now in one shot, and only then does its own
thinking. The numbered stages further down define each *step* (contract → generate → evaluate →
decide → review → reflect); the scheduler turn decides which stages run this turn and which run
together. Run **every** `run_role` call inside a subagent that returns only a summary — see
[How to invoke a role](#how-to-invoke-a-role--delegate-to-a-subagent).

**Each reply, do these in order:**

1. **Update the tracker table** — one row per unit: its current stage, status, and what it waits
   on. Maintain it in every reply so the board state is explicit before you schedule:

   | Unit | Stage    | Status        | Waiting on         |
   | ---- | -------- | ------------- | ------------------ |
   | U-A  | evaluate | launched (bg) | evaluator verdict  |
   | U-B  | generate | runnable      | —                  |
   | U-C  | contract | runnable      | —                  |

2. **Compute the runnable set** from the mechanical **parallel-safety matrix** — apply it, don't
   judgement-call it:
   - **contract-generator / contract-evaluator:** always safe to run concurrently across units
     (read-only critique, or their own scratch).
   - **evaluator / reviewer with `worktree: true`:** likewise safe across units — each grades in
     its own throwaway WIP-snapshot worktree, so no two collide.
   - **generators (writers):** safe **iff** they target **distinct workspaces / `unitWorktree`
     names** — two writers must never share one workspace concurrently.
   - **within one unit, stages are sequential** — a unit's contract → generate → evaluate → decide
     never overlap with each other.

   A stage joins the runnable set when its unit isn't blocked on an earlier stage of its own and it
   doesn't collide with an in-flight run under the matrix.

3. **Launch every runnable role-run in ONE message** as background subagents
   (`run_in_background: true` — see [How to invoke a role](#how-to-invoke-a-role--delegate-to-a-subagent)).
   A single message with N spawns *is* the parallel launch; don't launch one, wait for it, then
   launch the next.

4. **Do conductor-local work last** — only after the launches: fold a returned verdict into the
   next brief, commit an accepted unit, update memory, talk to the user. Never spend the turn on
   local work while runnable role-runs sit unlaunched.

**Under-scheduling tripwire:** if two or more units are pending but you just launched only one
subagent this turn, you **under-scheduled** — recompute the runnable set and launch the rest before
ending the turn.

**Worked example — one conductor message, three independent launches:**
```
(single conductor message — all three spawned together, run_in_background: true)
→ Task sparra-role: U-A evaluator, worktree:true, workspace=wt-A
      evaluate stage · own WIP-snapshot worktree ⇒ safe across units
→ Task sparra-role: U-B generator, unitWorktree="ub", workspace=wt-B
      generate stage · distinct unitWorktree ⇒ no writer collision
→ Task sparra-role: U-C contract-evaluator, contractPath=.sparra/uc.contract.md
      contract stage · read-only critique ⇒ matrix-safe
(then, conductor-local, AFTER the three launches:)
   fold U-D's just-returned verdict into its next generator brief.
```
Each writer sits on its own `unitWorktree` and the evaluator on a throwaway snapshot, so nothing
shares a workspace — all three role-runs proceed at once, and the conductor's own work happens only
once they're launched.

### Stages — what each step does (the scheduler turn decides *when*)

1. **Contract — negotiate it through the evaluator BEFORE locking it.** Don't lock a
   contract you wrote (or the user wrote) without an adversarial pass — that's how a
   loose/gameable "done" slips through. Mirror the CLI's `negotiateContract`: draft the
   contract (a short list of checkable assertions), then **`run_role(contract-evaluator,
   contractPath=…)`** to critique it adversarially; revise to address every point and
   re-run the evaluator; repeat (a few rounds) until it agrees (emits `CONTRACT: AGREED`)
   or rounds run out, then **save the agreed text** to a file (e.g. `.sparra/contract.md`)
   and only then proceed to generate. Use `run_role(contract-generator)` for the drafting
   step too when you want a model to propose rather than write it yourself. Skipping the
   contract-evaluator gate is allowed only for a throwaway one-off the user explicitly
   wants quick — say so when you skip it.
   **Fold the MANDATORY clauses into the FIRST draft** (mirror `contractModeClauses`,
   `src/build/modeText.ts`) so round 1 isn't spent re-adding boilerplate the autonomous path
   already carries — for an existing project:
   - a no-regression assertion naming the existing tests/flows that must still pass;
   - a conventions assertion — "Conforms to the conventions in CODEBASE_MAP.md" citing the
     specific patterns when that file exists, else cite the actual source (CLAUDE.md /
     surrounding code) and do NOT require conformance to a CODEBASE_MAP.md that isn't there;
   - "the existing test suite passes with no NEW failures".
   - *Greenfield instead:* the assertions fully define "done" for the item; there is no prior
     behavior to preserve.
   **Re-critique rounds are DELTA reviews, not fresh reviews.** A fresh contract-evaluator
   session re-reviews from scratch each round — reversing its own prior positions and
   promoting nits to blockers — so past round 1 the evaluator MUST see its **prior-round
   critiques** plus a delta instruction (*"verify each prior point is resolved; raise nothing new
   outside the changed text unless correctness-critical; don't reverse a prior-round position
   without naming the round and why; style/conciseness nits are non-blocking"*). Round 1 stays
   full-scope adversarial (that's where every blocking issue belongs). **Pass the prior critiques
   with `priorCritiquePaths`** — an array of the prior-round critique files in round order (Round 1
   first): the **runner reads them itself and inlines them** (labeled `--- Round N critique ---`,
   prefixed with the shared RE-CRITIQUE instruction) ahead of the contract, so you don't hand-write
   the delta framing. Because the *runner* does the read (it's trusted; the role is not), **files
   under `.sparra/` work** — e.g. `priorCritiquePaths: [".sparra/loop-x/ua.contract.eval.md"]` (CLI:
   repeat `--prior-critique <path>`). A missing path fails the run; passing the option to any other
   role is an error. *Fallback for an older Sparra without the option:* manually **inline** the
   prior critique text into the brief, or keep the critique file(s) **outside** any holdout-bearing
   dir and reference those — never hand a forbid role a `.sparra/…` path to read itself (its
   readscope excludes `.sparra/`, so the read is blocked).
2. **Generate.** `run_role(roleKind="generator", briefPath=…, contractPath=…,
   workspace=…)`. Writes are scoped to the workspace.
3. **Adversarially evaluate — cross-model.** `run_role(roleKind="evaluator",
   backend="codex", contractPath=…, holdoutPath=".sparra/HOLDOUT.md", workspace=…,
   worktree=true)`. The evaluator exercises the artifact for
   real and grades it against the contract + holdout. Using a *different* backend than the
   generator is the point — an independent second opinion. The redacted verdict **auto-persists**
   to a uniquely-named `.sparra/verdicts/role-run-evaluator-<stamp>.verdict.md` (returned as
   `verdictPath`) with no `out` needed; pass `out=…` only if you also want a second caller-chosen
   copy at a fixed path. **Pass `worktree=true` whenever the
   evaluator will run tests/builds** — it snapshots the WIP into a temporary linked worktree
   with writable scratch + provisioned deps; without it an in-place eval is read-only and
   false-blocks on scratch writes (EPERM on `node_modules/.vite-temp` → a bogus "tests failed").
   **Pin what the judge grades with `expectedHead`/`evalBaseRef` — don't rely on prose.** When the
   brief cites a specific commit, pass `expectedHead=<sha>`: the runner verifies it against the
   source checkout's HEAD (worktree run) or the workspace HEAD (in place) **before spending any
   tokens** and aborts naming both SHAs on a mismatch, so a judge never grades the wrong tree
   (and, on a worktree run, is told its in-workspace `git rev-parse HEAD` is the snapshot commit
   whose parent is the verified HEAD — not tampering). When you're grading ONE unit while another
   unit's WIP sits uncommitted, pass `evalBaseRef=<base>`: the runner scopes the changed-files list
   to `<base>..HEAD` + WIP and tells the judge to exclude foreign files from SCOPE/DEVIATION
   judgments — instead of hoping prose keeps it from bouncing on someone else's WIP.
4. **Decide.** Act on the subagent's returned summary (verdict + blocking points) —
   not a raw re-read of the verdict file. If it passes, accept (commit if the user
   wants). If it fails, feed the blocking issues plus each failed assertion's
   `#<id>: <evidence>` line (what the evaluator observed — the same shape as the
   autonomous loop's round feedback) back into the generator brief and repeat. Pivot
   to a fresh approach after repeated failures on the same point.
   **Limit ≠ fail:** if the summary carries a `limitHit` (a provider rate/usage/session
   limit, or a Codex empty completion with NO landed work), the role never really ran.
   Do NOT treat it as a behavioral FAIL or feed it back to the generator. `run_role`
   auto-falls-back to `roles.<role>.fallback` first; if the whole chain was limited it
   surfaces `limitHit` — then switch that role to another backend/model
   (`--backend`/`backend`) or retry later. (This is the interactive analogue of the CLI
   loop's auto-restart/fallback.)
   **No verdict ≠ fail — never replay the full brief:** if an eval round dies with NO verdict
   (a limit/cap/empty completion on the evaluator), the artifact was never graded. Two cases:
   with the artifact **UNCHANGED** since the last generator run, **skip regeneration** (or resume
   the generator report-only) and just re-run the evaluator; with **landed or ambiguous** generator
   changes, **resume the generator with a report-only instruction** to re-emit its report, then
   re-evaluate. NEVER re-run the generator on the original full brief — a fresh full-brief resume
   makes it re-verify intact work and re-emit the same report (a pure wasted round: full test
   re-run, no change).
   **Empty completion + work landed ≠ fail — RESUME or ACCEPT:** if a generator summary
   carries `emptyCompletion: true` (always with `filesChanged > 0`), the work LANDED on
   disk and only the completion report failed to emit. The runner **already re-asks
   automatically first:** with `build.jsonReask` on, a budget-cap death gets ONE tightly-
   capped (1-turn) report-only re-ask on the same session before you see it — so a
   recovered report rides in `resultText` (an `errors` note says "recovered … via a
   one-shot re-ask") and `emptyCompletion` clears. If `emptyCompletion` STILL surfaces
   (re-ask disabled/failed, or a provider-limit empty completion), do NOT re-run the item
   (a second generator would clobber the landed work — the fallback chain already refuses
   to) and do NOT feed it back as a FAIL: resume the session (`resumeSessionId`/`resumeBackend`
   = the result's `sessionId`/`backend`) to re-emit the report, or verify the tree
   (typecheck/test) and accept the landed work, then evaluate as normal. `filesChanged`
   is always populated for a generator — the count of files whose **content** changed vs. a
   pre-run snapshot (content-based, so an edit to a file already dirty at run start on a
   continuation/fix round counts — no longer a false signal there); `>0` means work landed,
   whatever the flags say.
   **Budget cap ≠ fail — RESUME:** if a summary carries `hitBudget: true`, the run
   stopped on OUR per-call USD cap (not a provider limit). Resume the same session via
   `resumeSessionId` (+ a raised `maxBudgetUsd`) to finish; if `filesChanged > 0`, the
   work may already be complete — check before spending more.
   **No progress ≠ fail:** if a generator summary carries `noProgress: true`, the writer
   changed no file's **content** (content-compared against a pre-run snapshot, so an edit to a
   file already dirty at run start on a continuation/fix round DOES count — no longer a false
   signal there) — a blocked brief or a starved permission path, not "the work is
   wrong." Don't feed it back as a behavioral FAIL; check the brief is actionable and the
   workspace readable, then re-run (a writer can always read its workspace, so a real
   no-progress almost always means the brief had nothing to do).
   **Turn cap ≠ fail — RESUME:** if a summary carries `hitMaxTurns: true`, the role stopped
   at the per-session turn cap with work unfinished (a partial artifact), not a failure.
   Re-call `run_role` for the SAME role with `resumeSessionId` + `resumeBackend` set to that
   result's `sessionId`/`backend` (and a short "continue where you left off" brief) so it
   picks up its own context instead of re-reading the workspace — exactly how the build loop
   continues a turn-capped generator. Don't pivot or feed it back as a FAIL. **Report
   auto-recovery:** if a generator hit the turn cap with work landed (`filesChanged > 0`) but
   forfeited its completion report, the runner **already re-asks automatically** — with
   `build.jsonReask` on it fires ONE tightly-capped (1-turn, text-only) report-only re-ask on
   the same session, so a recovered report rides in `resultText` (an `errors` note says
   "recovered … via a one-shot re-ask") while `hitMaxTurns` STAYS true (recovery never launders
   a capped run as complete). You still RESUME to finish the unfinished work.
5. **Review (optional).** `run_role(roleKind="reviewer")` for a code-review gate.
6. **Reflect (recommended after a run).** Before moving on, run `sparra reflect` to capture what
   the run taught you. It auto-discovers `.sparra/traces/role-run-*` traces newer than the last
   reflect output (or all role-run traces if none exists); pass `--traces <glob-or-dir>` for an
   explicit selection. Evaluator trace bodies are excluded before reflection because they may carry
   holdout content. **Split findings two ways:**
   - **Project-local** (a loose contract assertion, a weak fixture, a prompt that under-specified
     "done") → fix this project's contract/brief/`.sparra/prompts` (or run `sparra reflect
     --apply` after reviewing the proposal).
   - **Harness-level** (a Sparra config knob, a guard/holdout gap, a phase/role bug, a backend
     limit) → these aren't this project's prompts; route them UPSTREAM to the Sparra repo so the
     harness itself improves. `sparra reflect` does this for you: it drops harness-level findings into
     a shared user-level inbox `~/.sparra/reflections/` (`SPARRA_HOME` overrides) as a uniquely-named
     file per run, each finding under its own `###` heading. Later, from the Sparra repo, `sparra reflect
     --upstream` lists every finding with a global index; triage them individually with `--done <ids>` /
     `--wontdo <ids>` (`--reason "…"` optional) — only un-triaged findings resurface next run — or
     `--clear` to archive ALL at once. Nothing is applied automatically, you triage.

## Two ways to be interactive — pick by scope
- **Ad-hoc choreography (this skill):** you drive `run_role` calls with the user between
  them — for a standalone eval, a one-off contract/generate/evaluate, or a quick
  cross-model second opinion. Use this for everything that ISN'T a full multi-item build.
- **The full engine, with human gates:** when the user wants Sparra's real loop
  (decompose, deps, budget, pivots, review, reconcile, commit, resume) but with steering,
  use **`sparra build --step=contract,round,commit,item`** — don't re-implement the loop here.

### Standalone eval on a WIP tree
`sparra eval [dir] --worktree --contract contract.md [--backend codex] [--holdout .sparra/HOLDOUT.md] [--out v.md] [--keep-worktree] [--expected-head <sha>] [--eval-base <ref>]`
— grade whatever the user has been building, no full process. (Alias for `role run --kind evaluator`.)
Add `--expected-head <sha>` when the brief names a commit (aborts before launch if the graded HEAD
isn't it) and `--eval-base <ref>` to scope SCOPE/DEVIATION judgment to `<ref>..HEAD` + WIP so a
snapshot carrying another unit's uncommitted WIP doesn't bounce the run on foreign files.
**Use `--worktree` when the evaluator will exercise the tree** (run tests/builds): it snapshots the
WIP — uncommitted edits, untracked files, deletions — into a TEMPORARY linked worktree, runs the
eval there (writable exercise scratch, deps auto-provisioned; no manual `git worktree add` +
`node_modules` copying), and tears it down after (`--keep-worktree` retains it and prints the path).
An in-place eval without it stays read-only and can false-block on scratch writes (EPERM).

### Driving `sparra build --step` (checkpoint-and-resume)
The build pauses at each checkpoint by writing a steering folder and exiting; you help the
user act on it, then re-run `sparra build` to continue. At each pause:
- `--step=contract` → review/edit the proposed contract file, then resume.
- `--step=round` → read `.sparra/interactive/<run>/<item>/pause.md` (a holdout-redacted
  verdict summary), then set `decision.json` to **continue** (edit `feedback.md` to steer),
  **pivot** (rebuild fresh), **accept** (overriding a FAIL needs a `reason` — it's recorded
  to memory), or **abandon**. Then `sparra build` resumes.
- `--step=commit` → the item is already accepted (**passed**); `pause.md` lists the files to be
  committed. Set `decision.json` to **commit** (land it on the Sparra branch — the default) or
  **skip** (leave it uncommitted; still passed). Only active when `git.autoCommit` is on.
- `--step=item` → after an item finishes, set `decision.json` to **continue** (next item — the
  default) or **stop** (end the run; a later `sparra build` resumes from the next item).
Never read the holdout to write feedback — the summary is already redacted; pasting holdout
into `feedback.md` is rejected on resume.

## How to invoke a role — delegate to a subagent
Run **every** role-run (generator, evaluator, contract-*, reviewer) inside a
**subagent**, not from this main session. The subagent invokes the role, reads the
already-redacted result, and returns ONLY a concise, decision-relevant summary. This
keeps the main thread lean over a long loop and stacks context isolation on top of
the runner's holdout wall. The model work does **not** move onto Claude — the role's
backend stays whatever `roles.*`/your `backend` arg says (a Claude subagent can still
launch a Codex evaluator via `run_role`/`--backend codex`).

- **Spawn the `sparra-role` subagent** (shipped in this plugin) via the Task tool,
  telling it the role and the exact args (`roleKind`, `brief`/`briefPath`,
  `contractPath`, `workspace`, `holdoutPath`, `backend`, `model`, `effort`, `out`,
  `maxBudgetUsd`, `worktree`/`keepWorktree`, `unitWorktree`, `expectedHead`/`evalBaseRef`). `worktree=true` (evaluator/reviewer) runs the role
  in a temp, throwaway WIP-snapshot worktree so an exercising eval gets writable scratch + provisioned deps —
  pass it whenever the role runs tests/builds (an in-place eval false-blocks on scratch writes). `unitWorktree="<name>"`
  (generator-only, mutually exclusive with `worktree`) runs the writer in a **persistent** named per-unit worktree reused
  across rounds — tear it down with `remove_unit_worktree(name=…)` on accept/abandon.
  `maxBudgetUsd` (CLI: `--budget <usd>`) overrides `build.maxBudgetUsdPerItem`
  for that one call (`0` = unlimited; omit for the config cap). If that
  agent isn't available, spawn a general subagent and instruct it to call the
  `run_role` MCP tool with the same args and these same holdout rules.
- **Run role-subagents in the BACKGROUND (`run_in_background: true`) by default.** Role
  runs (especially a cross-model Codex evaluation) take minutes; a foreground subagent
  blocks the whole session so the user can't talk to the conductor until it returns. A
  background subagent runs async and notifies the conductor on completion — the user keeps
  talking to you while it works, and you act on the summary when it lands. Foreground is
  only worth it for a quick role run you'll immediately block on anyway.
- **How the subagent reaches the role:** a subagent **inherits the session's MCP
  tools by default**, so it can call **`mcp__sparra-run__run_role`** from the
  `sparra-run` server (the `sparra-role` agent also lists it explicitly; a general
  subagent needs `mcp__sparra-run__run_role` or `mcp__sparra-run`). **CLI fallback**
  when MCP isn't reachable: `sparra role run --kind evaluator --backend codex --brief
  brief.md --contract contract.md --holdout .sparra/HOLDOUT.md --out v.md` (or
  `sparra eval …`) via Bash.
- **Dogfooding the runner itself?** The `sparra-run` MCP server is a **persistent process that
  loads Sparra's code once at startup** — so a fix you just made to `run_role`/`src/` will NOT be
  live for `run_role` calls until that server restarts (a new session). If this cycle EDITS the
  harness runner and you want to validate the change live, **use the CLI path** (`sparra eval …` /
  `sparra role run …` via Bash) — it spawns a fresh process per call and runs your current code;
  the MCP tool would keep exhibiting the pre-fix behavior and mislead you.
- **What comes back to you (summary only):** evaluator → the **verdict** (pass/fail,
  total vs. threshold, blocking points to feed back as the next brief);
  generator/reviewer/contract-* → a **one-paragraph digest**. The raw diff, the full
  verdict dump, and any role output must **NOT** be pasted into this main session —
  it lives and dies in the subagent.
- **Newer default prompts (`promptDrift`):** any `run_role` payload may carry a
  holdout-safe `promptDrift` field (present only when actionable) — the project's
  on-disk role prompts have gone stale against Sparra's improved built-in defaults.
  The subagent passes it through; when you see it, tell the user which role(s) have a
  `stale` (adoptable) newer default and that `sparra prompts sync` adopts them (it
  leaves local edits / conflicts untouched). Informational, not a failure.
- **Holdout carries over:** the subagent inherits the rules below — never read
  `HOLDOUT.md`, pass it by path, read the redacted verdict (not raw output/traces),
  and return no holdout text. The conductor never receives holdout.

### Per-unit worktrees for parallel generators
The scheduler turn's matrix makes generators run in parallel **iff they use distinct workspaces /
`unitWorktree` names**; the clean way to get that is to give each unit its own
**`unitWorktree="<name>"`** (generator-only): first use creates a **persistent, named per-unit
worktree** on a `sparra/<name>` branch (deps provisioned), and every later round with the same
name **reuses** it so that unit's WIP survives round→round — no hand-rolled `git worktree add` +
`node_modules` copying, no serializing. It's distinct from the evaluator's throwaway
`worktree=true` snapshot and mutually exclusive with it; the result's `unitWorktree` field carries
the `{name,dir,branch}`. Tear each one down on accept/abandon with
**`remove_unit_worktree(name=…)`** (or `sparra role rm-worktree --name <name>`) — WIP-safe: it
refuses a dirty tree / unmerged branch unless `force`.

When a writer and an eval must both touch **one shared workspace**, don't stagger them with sleeps
(a backgrounded subagent sleep can stall and need a manual nudge): commit the unit first, pass the
evaluator `expectedHead=<sha>` (+ `evalBaseRef` to scope the changed-files judgment), and tell it
to ignore foreign WIP — the runner pins what it grades without a timing race.

### Live progress while a role runs (optional)
A backgrounded role streams its transcript to disk *as it works* (the runner's
`TraceWriter` appends per step to `.sparra/traces/role-run-<kind>-*/NN-*.md`). So
between the spawn and the completion notification you can surface **small** status
updates to the user — a pulse, on demand ("how's it going?"), not a tight poll loop.
Two rules keep it cheap and safe:
- **Filter, never dump.** The trace is verbose (tool inputs, results, thinking) —
  reading the whole file re-imports the exact context bloat the summary-only design
  exists to prevent. The non-evaluator result/payload carries **`traceDir`** (use it;
  fall back to globbing the newest `role-run-<kind>-*` dir if you don't have it). Tail
  only the tool-call *headers*:
  ```bash
  f=$(ls -t "$traceDir"/*.md 2>/dev/null | head -1)   # $traceDir from the run_role result
  printf '%s tool calls; recent: ' "$(grep -cE '^\*\*→ tool:' "$f")"
  grep -E '^\*\*→ tool:' "$f" | tail -6 | sed 's/.*`\(.*\)`.*/\1/' | paste -sd' ' -
  ```
  That returns tool *names* + a count — a heartbeat, a few tokens, no artifact
  content.
- **Non-evaluator roles ONLY — never tail the evaluator.** The runner **omits the
  evaluator's `traceDir` from the payload** on purpose: its trace contains holdout by
  design (it's the one role allowed to see it), and your conductor context feeds forward
  into the next generator brief — tailing it would bypass the verdict redaction that
  keeps the wall intact. For the evaluator, wait for the redacted verdict summary; that
  *is* the progress signal. The generator (and other writer/read-only roles) are
  holdout-free by scope, so their `traceDir` is returned and safe to watch.

## Backends
Defaults come from `roles.*` (see Setup). Override per call with `backend`/`model`/`effort`
(`low|medium|high|xhigh|max`) — handy for a one-off second opinion from a different model, or
to raise an adversarial pass (e.g. `effort: "xhigh"`) without editing config. Useful when a
backend is rate-limited: switch the evaluator to `backend:"claude", model:"opus",
effort:"xhigh"` per call. **Cost split:** round-1 contract critiques at high effort have run
200k–480k tokens — put the contract-evaluator on a cheaper model / lower effort
(`roles.contractEvaluator`, its `fallback`, or per-call `model`/`effort`) and reserve the
strong high-effort model for the artifact evaluator.

## Don't
- Don't reimplement grading yourself in this session — call the evaluator role (it has
  the rubric + holdout + the exerciser).
- Don't paste holdout/contract acceptance secrets into a generator brief — the runner
  will reject a leak, but don't rely on it; keep them in files referenced by path.
