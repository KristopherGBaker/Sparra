# Diagnosing a Sparra run

Sparra debugging is *reading the filesystem*. The whole run is on disk under `.sparra/`;
nothing important is hidden in memory. Work from the symptom to the artifact that explains
it, then to the fix.

- [Read the artifacts in order](#read-the-artifacts-in-order)
- [Item statuses](#item-statuses)
- [Failure signatures → cause → fix](#failure-signatures)
- [Clean re-runs](#clean-re-runs)

## Read the artifacts in order

From the project root (the dir you ran `sparra` in):

1. **`.sparra/state.json`** — the phase machine + per-item state. Start here.
   ```bash
   node -e "const s=require('./.sparra/state.json');console.log('phase:',s.phase,'mode:',s.mode);console.log('workspace:',s.build.workspaceNote||'-');if(s.build.waitingUntil)console.log('PAUSED on limit until',new Date(s.build.waitingUntil).toLocaleString());if(s.build.limitedRoles&&Object.keys(s.build.limitedRoles).length)console.log('limited backends:',s.build.limitedRoles);for(const[k,v]of Object.entries(s.build.items||{}))console.log(' ',k,JSON.stringify({status:v.status,round:v.round,pivots:v.pivots,lastScore:v.lastScore,cost:+(v.costUsd||0).toFixed(3),tok:v.tokensUsed}))"
   ```
   `costUsd` is `$0` for Codex roles (it reports tokens) — look at `tokensUsed`. `waitingUntil`/`limitedRoles` appear when `build.autoRestart` paused the run on a provider limit (see signatures).

2. **`.sparra/workitems/items.json`** — the decomposition. Check the *shape*: how many items,
   and whether any are setup/verification-only (a smell — see signatures).
   ```bash
   node -e "const a=require('./.sparra/workitems/items.json');console.log('count',a.length);a.forEach(i=>console.log(' -',i.id,'|',i.title,'| deps',JSON.stringify(i.dependsOn)))"
   ```

3. **`.sparra/contracts/<id>.contract.md`** — the full generator↔evaluator negotiation for
   an item, with the agreed (or force-converged) contract at the bottom (`## AGREED CONTRACT`).
   Count rounds and whether it actually agreed:
   ```bash
   grep -c '^### Round' .sparra/contracts/<id>.contract.md   # 2 lines per round (proposal+critique)
   grep -c 'CONTRACT: AGREED' .sparra/contracts/<id>.contract.md
   ```
   Read the **last critique** to see what the evaluator was unhappy with — substantive
   critiques (verification holes, gameable assertions) are healthy; nitpicking toolchain
   trivia is not (and the prompt is meant to prevent it).

4. **`.sparra/verdicts/<id>.r<n>.verdict.md`** — per-round grade: weighted total vs threshold,
   per-criterion scores, **failed assertions with evidence**, blocking issues, and a
   `<details>` block with the raw evaluator output. This tells you *why* an item failed a round.

   **`.sparra/reviews/<id>.r<n>.review.md`** — if `review.enabled`, the code-review findings
   (blocking vs advisory, with `blockOn`). An item that passes the exercise but isn't accepted
   was blocked here.

5. **`.sparra/traces/<run>/NN-<role>.md`** — the full transcript of every role session as
   markdown. The most recent file (by mtime) shows current activity. Read these when the
   verdict/contract summary isn't enough — e.g. to see what the generator actually did, or
   how the evaluator exercised the artifact. `ls -lt .sparra/traces/*/ | head`.

6. **`.sparra/memory.md`** — durable cross-run learnings (pivots, budget halts, pass/fail).
   Roles read this each item; a wrong/misleading entry can bias new work.

7. **`CHANGELOG.md`** / **`.sparra/proposals/`** — recorded deviations (in-scope) and
   out-of-scope ideas logged for the human (brownfield).

## Item statuses

`pending` → `contracting` → `building` → `passed` | `failed` | `budget_exceeded` | `abandoned`.
A run that "died" usually leaves an item stuck at `contracting` or `building` with no verdict —
check the latest trace and the contract file for an error (often a session-level failure).

## Failure signatures

| Symptom | Likely cause | Fix |
|---|---|---|
| **Decomposition is huge** (8–12 items for a small app; a standalone "scaffold" or "generate/build/verify" item) | Decomposer over-splitting — usually because it's running on Codex, which doesn't follow the decompose prompt as tightly as Claude | Set `roles.decomposer: { backend: claude, model: opus }`. Re-decompose (`sparra build --fresh` or clear `workitems/`). Decomposition is a *planning* act; keep it on Claude. |
| **Evaluator rejects the contract as "the wrong project" / quotes an unrelated plan** | The work dir is **nested inside another Sparra project**; a read-only role read the parent's `PLAN.md`/`.sparra/` up the tree | Run the project in its **own directory**, not nested. Remove stray parent `PLAN.md`/`.sparra/`. (Recent prompts anchor the evaluator on the in-message plan, but a clean dir is the real fix.) |
| **Contract never reaches AGREED / many rounds, run dies mid-`contracting`** | Either genuine, substantive critiques (healthy — it force-converges after `maxNegotiationRounds`) OR the session hit a turn cap | Read the last critique. If it's finding real holes, optionally raise `contract.maxNegotiationRounds`. If sessions are starving, ensure `build.maxTurnsPerSession` is generous (contract sessions use it). |
| **"verify-probe found N broken verify command(s) — re-opening negotiation"** | The harness probe dry-ran the agreed contract's "I will verify by" commands and hit a USAGE error (not found / unknown flag / usage text) or an UNSAFE command (safety-rule-rejected — chaining/redirect/network/mutation; the harness can never run it) — the contract was bounced, not shipped broken | Working as intended. Read the `verify-probe (harness)` section in `.sparra/contracts/<id>.contract.md`. If the probe misfires (e.g. env-missing tool that IS legit), set `contract.probeVerifyCommands: false`. |
| **"pass demoted by the rerun gate" / item fails despite a passing verdict** | The contract's verify commands did not all stay runnable-and-green — mixed exits = FLAKY artifact, all-nonzero = failing-as-shipped, UNSAFE = safety-rule-rejected (never ran, so it can never be witnessed exiting 0) | Fix the flakiness/failure/unsafe command (the blocking feedback names the command + output) — rerun-to-green never passes. `build.flakinessReruns: 0` disables the gate. |
| **Clean, working artifact scores just under threshold / fails on a weird assertion** | Over-specified or impossible contract assertion (toolchain trivia, "prove not-X", environment-controlled property) | Read the contract's assertions and the failed one's evidence in the verdict. Proportionality is enforced in the prompts; if it slipped through, it's a prompt-tuning target (`sparra reflect`). |
| **Item passed, but `reconcile` then marks a plan behavior "pending / not satisfied"** | Gamed/degenerate pass: an assertion met by a no-op input (a combine step fed identical copies, a structurally-wrong fixture, a stub, or a literal term reinterpreted loosely) — the core behavior never ran on real data | Read the verdict's assertion evidence and the contract. The anti-gaming guards (distinct fixtures, contrasting negative case, structurally-correct stand-ins) live in the contract-generator/contract-evaluator/evaluator prompts; if it slipped through, `sparra reflect` and harden them. |
| **Item passed, but its own committed tests / contracted verify commands crash as shipped** (wrong flag, bad field, import error) | Evaluator laundered a broken verification harness: it hand-corrected the invocation to get a green instead of failing the as-shipped path. Often the bad command survived contract negotiation and got copied into the committed tests | Read the verdict — does it note running a hand-substituted command? The fix lives in the prompts: contract-(generator/evaluator) require every verify command to be confirmed runnable against the real CLI; the evaluator must run shipped verification as-is and not launder it. `sparra reflect` if it recurs. |
| **Codex evaluator never runs the tests / `EPERM` writing `node_modules/.vite-temp` (or any in-repo scratch); eval silently degrades to code-review-only** | The Codex evaluator's OS sandbox was `read-only`, so test/build tools can't write the scratch they need | Default is now `exercise.sandbox: workspace-write` — the exercising evaluator gets writable scratch (network stays off; a source-integrity guard reverts+fails any artifact-source write) **on a worktree/branch boundary**. If it's still read-only, you're on an in-place run (no branch) or set `exercise.sandbox: read-only`. Build on a worktree (`git.strategy: worktree`). The **Claude** evaluator exercises via the in-process runner and was never affected. When the exercise genuinely *still* can't run, the evaluator marks the verdict `exerciseStatus: blocked` (**inconclusive**) — the loop no longer treats that as a behavioral fail or GAN-pivots on it; it's surfaced for you as needs-attention rather than failing correct work. |
| **Verdict fails with "Unobserved pass: no mcp__exercise__ activity backed this pass"** (pass demoted because the exercise was not observed) | Observed-run gate (`exercise.requireObservedRun`, default on): the evaluator reported a PASS but routed **zero** commands through `mcp__exercise__run_command`/`http_request`, so the harness saw nothing backing it — on mechanisms `cli`/`web` an unobserved pass is pure self-report and is demoted to fail | Working as intended — the evaluator must exercise via **`run_command`** (not raw Bash) so the harness observes real exit codes; the blocking note feeds that back and the next round should re-run gating commands through the tool. `ios`/`computer-use`/`custom` are exempt. If a `cli`/`web` project genuinely can't route its exercise through the tools, set `exercise.requireObservedRun: false`. |
| **Verdict fails with "Integrity violation: the evaluator wrote N artifact file(s) during exercise (reverted)"** | The evaluator modified the artifact source it was grading (e.g. "fixed" the code to pass) while exercising under `workspace-write` — the source-integrity guard reverted those writes and failed the verdict | Working as intended: the verdict can't be trusted when the grader edited the code. Read the named files; the evaluator prompt should exercise, not edit. If it recurs, `sparra reflect` to harden the evaluator prompt. Gitignored scratch (caches, build temp) is never flagged — only the artifact surface. |
| **Generator reports it couldn't run `tsc`/`npm test`, "verified by inspection" — ships uncompiled/untested code** | The writer's Bash wasn't auto-approved (permission mode doesn't auto-accept Bash), so it wrote blind | The generator now **self-verifies** on a worktree boundary: it auto-runs `build.verifyCommands` (typecheck/test/build) and fixes what it broke. An **interactive in-place** `run_role` (no worktree) used to be unable to self-verify — so the conductor had to run every gate out-of-band — but it now **can** when opted in: pass `allowVerify: true` (MCP `run_role`) / `--verify` (`sparra role run`) to enable the same strict allow-hook in place. If it still can't, check you're on a worktree (`git.strategy: worktree`) or passed the opt-in, and that the command starts with a `verifyCommands` entry and has no chaining/redirect/network/commit (those are disqualified). **Only the exact allow-listed forms are approved** — package-runner / path-qualified variants (`npx tsc`, `./node_modules/.bin/vitest`) are NOT, so the generator must run `npm run typecheck` / `npm test` etc. as written (it's told this). Add the project's command to `build.verifyCommands`. (Codex confines these to its sandbox; for Claude they run unsandboxed like the evaluator's exercise.) |
| **iOS app letterboxed (320×480, black bars); UI taps "succeed" but miss** | Missing launch screen → iOS compatibility mode shrinks the logical screen | Add `INFOPLIST_KEY_UILaunchScreen_Generation: "YES"` (or `UILaunchScreen: {}`) to `project.yml`, `xcodegen generate`, rebuild. This is an **app defect**, not tooling. |
| **macOS app: evaluator can't screenshot/drive the UI; UI assertions fail "no evidence"** | A Mac app has no simulator and xcodebuildmcp's screenshot/ui-automation is simulator-only | Set `exercise.ios.platform: macos`. The UI is then verified via an **XCUITest** target (`macos test`) + `xcresulttool`-extracted screenshots + `screencapture`; ensure the generator built a UI-test target (it's told to on `platform: macos`). See `docs/ios.md` → macOS apps. |
| **macOS/XcodeGen build never compiles — `xcodebuild` burns 100%+ CPU, no `swift-frontend`/`clang` workers, zero `.o` files, "hangs" for many minutes** | `project.yml` references a local SwiftPM package in the project's own directory (e.g. an engine package at the repo root) with `path: ./` — the trailing slash makes XcodeGen resolve it to the filesystem root `/`, emitting a folder reference, so Xcode recursively scans the whole disk on project load (stuck in `IDEContainer _locateFileReferencesRecursively`) and never starts compiling | Use `path: .` (no trailing slash) in `project.yml`, `xcodegen generate`, rebuild — builds in seconds. The generator is now told this; `sparra reflect` if it recurs. |
| **Budget never halts a Codex item / `costUsd` is $0** | Codex reports tokens, not USD; the USD cap only bounds Claude roles | Set `build.maxTokensPerItem` for a real ceiling on Codex/subscription runs. |
| **An item tagged `gen: "local"` keeps failing / thrashing rounds** | Hybrid routing sent it to a local model (`roles.generatorLocal`, e.g. LM Studio) too weak for that item | Check the trace header for `endpoint: … (local)`. Remove the `gen` tag in `items.json` (→ main generator), or stop tagging by unsetting `roles.generatorLocal`. Keep local routing for trivial/mechanical items only. |
| **`gen: "local"` item ran on the main generator anyway (warning in log)** | `roles.generatorLocal` isn't configured, so the build fell back | Add `roles.generatorLocal: { backend: codex, model: <local-id>, baseUrl: http://localhost:1234/v1 }`, or drop the tag. |
| **`BUDGET_EXCEEDED` on an item** | Accumulated cost/tokens crossed the per-item cap | Expected — the run continues to the next item. Raise `maxBudgetUsdPerItem`/`maxTokensPerItem` if premature; check `memory.md` for the halt note. |
| **Build "hangs" mid-item with no output for a long time; `sparra status` says "paused on a provider limit — resumes ~HH:MM"** | `build.autoRestart` is on and a role hit a provider rate/usage window with no available fallback — it's *sleeping* until the window reopens, not stuck | Expected. Let it resume on its own, or re-run `sparra build` to retry now. State is on disk (`state.json`: `build.waitingUntil`, `build.limitedRoles`), so a kill loses nothing. Add a cross-provider `roles.<role>.fallback` to keep working instead of waiting. |
| **`BUILD PAUSED — provider limit`, phase stays `build`** | `build.autoRestart.maxRestarts` wait cycles exhausted — the run stopped cleanly, the in-flight item is left mid-build (not failed) | Re-run `sparra build` to resume from where it stopped (completed items skip). Raise `maxRestarts`/`maxWaitSec`, or configure a `fallback` model so it doesn't depend on waiting. |
| **A limit fires but the build keeps going on a different model** (log: "switching to a fallback model" / "generating with fallback …") | Working as intended: `roles.<role>.fallback` is set and the primary's backend is in a limit window | No action. It switches back once the primary's window reopens. If the fallback is also limited (same provider), it can't help — point it at a *different* backend. |
| **Interactive `run_role`/`/sparra-loop`: a role returns nothing useful / a verdict scored 0 with "no parseable verdict", often on Codex mid-session** | The backend hit a provider limit OR returned a **silent empty completion** (`tokens: 0`) — now classified as a `limitHit`, NOT a real result | `run_role` auto-falls-back to `roles.<role>.fallback` first; if the whole chain is limited the result carries `limitHit` — switch that role to another backend (`--backend claude`) or retry later. Never feed a `limitHit` result back to the generator as a FAIL. Configure `roles.<role>.fallback` on a *different* backend to make this automatic. |
| **Interactive `run_role`/`/sparra-loop`: a generator returns `noProgress: true` and changed no files** (often after burning tokens) | The writer had nothing actionable to do, or its reads/Bash were blocked. A role can ALWAYS read its in-scope workspace now (guard-level allow), so a genuine no-progress almost always means an empty/unactionable brief — not a permission wall | Don't feed it back as a behavioral FAIL. Check the brief actually asks for a file change and points at the right `workspace`; re-run with a sharper brief. If reads truly seem blocked, confirm the workspace/`additionalDirectories` cover the files (the in-scope read allow is keyed to those). |
| **Interactive `run_role`/`/sparra-loop`: a role returns `hitMaxTurns: true` with a partial artifact** | The role stopped at the per-session turn cap (`build.maxTurnsPerSession`), unfinished — not a failure | RESUME the same session: re-call `run_role` for the same role with `resumeSessionId` + `resumeBackend` = the result's `sessionId`/`backend` and a short "continue where you left off" brief (don't re-read the workspace, don't pivot). Raise `build.maxTurnsPerSession` if items routinely need more turns per session. |
| **Item keeps failing the same criterion, then restarts from scratch** | GAN pivot: same rubric criterion below `pivot.threshold` for `pivot.N` rounds | Expected behavior. If it pivots forever, the contract or rubric expectations may be miscalibrated for the item. |
| **Build output / screenshots litter the project root** | Older guidance; the evaluator should use a temp derivedDataPath + scratch dir | Current guidance handles this; if seen, it's a prompt-tuning target. |
| **"no parseable verdict → FAIL" despite a good build** | The evaluator's JSON verdict wasn't extracted (historic shape bug) | Read the raw output in the verdict `<details>`; if the verdict is actually fine, it's an extraction bug to fix in `src/build/evaluate.ts`. |
| **Item passes the exercise but isn't accepted; feedback mentions "code review"** | `review.enabled` and the `reviewer` found a `blockOn`-level issue | Read `.sparra/reviews/<id>.r<n>.review.md`. Fix the flagged issue, or lower `review.blockOn` / disable `review` if the finding is noise (it shouldn't be — proportionality applies). |
| **A previously-green required check now fails / passes only on rerun** | Determinism gate: the evaluator reruns gating checks and an artifact-caused flake is a defect, not "environmental" | Fix the *artifact* (stabilize the race / debounce / isolate state) — rerun-to-green won't pass it. See the verdict's notes for the diagnosed cause. |
| **`git.autoCommit: true` but no commits appear** | Not on a Sparra branch — `inplace` strategy or a non-git / no-history dir never auto-commits (safety) | Use `git.strategy: worktree` (or `branch`) on a real repo; commits land on `sparra/<runId>`, never main. |
| **A configured skill has no effect / "skill … not found" warning** | The name didn't resolve, or the role doesn't receive it | Check the name matches a `SKILL.md` dir under repo `skills/`, `~/.claude/skills`, or `~/.agents/skills`; builder roles inherit `build.skills`, others need `roles.<role>.skills`. |
| **A Sparra prompt fix you expected isn't taking effect** (build still does the old behavior); or build logs "N role prompt(s) differ from the built-in defaults" | `.sparra/prompts/` was seeded at `init` and is now **stale** vs the improved defaults (the build reads the local copies). Or the drift is your/`reflect`'s intentional edits | `sparra prompts status` to see which drifted; `sparra prompts sync` (or `--role <r>`) to adopt the current defaults. Skip if the drift is intentional. Mid-run is fine — prompts are read per role invocation. |

## Clean re-runs

Cached state is reused on purpose (resumability), which can mask a fix. To force a genuinely
fresh build:

- **Re-decompose + re-contract**: clear the cached pieces, then `sparra build --fresh`
  (resets items/decomposition for the run). To also pick up updated **prompts**, remove the
  seeded copies so they fall back to the latest defaults:
  ```bash
  rm -rf .sparra/contracts .sparra/workitems .sparra/verdicts .sparra/prompts
  sparra build --fresh
  ```
- **Total reset** of a throwaway project: `rm -rf .sparra <generated-files>` then
  `sparra init && (cp your-config .sparra/config.yaml) && sparra freeze && sparra build`.
- Prompt/config changes only reach an **already-initialized** project on re-seed (delete
  `.sparra/prompts/`) or re-init; the example `run.sh` does a fresh `init` each time.

## Watching a live run

```bash
ls -lt .sparra/traces/*/ | head          # newest trace = current activity
tail -f .sparra/traces/<run>/NN-<role>.md # follow a role as it works
```
The role filename tells you the phase: `decomposer`, `contract-generator`/`contract-evaluator`,
`generator-<id>`, `evaluator-<id>-r<n>`, `reviewer-<id>-r<n>`, `reconcile-<id>`, `reflector`.
