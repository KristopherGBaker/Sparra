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
   node -e "const s=require('./.sparra/state.json');console.log('phase:',s.phase,'mode:',s.mode);console.log('workspace:',s.build.workspaceNote||'-');for(const[k,v]of Object.entries(s.build.items||{}))console.log(' ',k,JSON.stringify({status:v.status,round:v.round,pivots:v.pivots,lastScore:v.lastScore,cost:+(v.costUsd||0).toFixed(3),tok:v.tokensUsed}))"
   ```
   `costUsd` is `$0` for Codex roles (it reports tokens) — look at `tokensUsed`.

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
| **Clean, working artifact scores just under threshold / fails on a weird assertion** | Over-specified or impossible contract assertion (toolchain trivia, "prove not-X", environment-controlled property) | Read the contract's assertions and the failed one's evidence in the verdict. Proportionality is enforced in the prompts; if it slipped through, it's a prompt-tuning target (`sparra reflect`). |
| **iOS app letterboxed (320×480, black bars); UI taps "succeed" but miss** | Missing launch screen → iOS compatibility mode shrinks the logical screen | Add `INFOPLIST_KEY_UILaunchScreen_Generation: "YES"` (or `UILaunchScreen: {}`) to `project.yml`, `xcodegen generate`, rebuild. This is an **app defect**, not tooling. |
| **Budget never halts a Codex item / `costUsd` is $0** | Codex reports tokens, not USD; the USD cap only bounds Claude roles | Set `build.maxTokensPerItem` for a real ceiling on Codex/subscription runs. |
| **`BUDGET_EXCEEDED` on an item** | Accumulated cost/tokens crossed the per-item cap | Expected — the run continues to the next item. Raise `maxBudgetUsdPerItem`/`maxTokensPerItem` if premature; check `memory.md` for the halt note. |
| **Item keeps failing the same criterion, then restarts from scratch** | GAN pivot: same rubric criterion below `pivot.threshold` for `pivot.N` rounds | Expected behavior. If it pivots forever, the contract or rubric expectations may be miscalibrated for the item. |
| **Build output / screenshots litter the project root** | Older guidance; the evaluator should use a temp derivedDataPath + scratch dir | Current guidance handles this; if seen, it's a prompt-tuning target. |
| **"no parseable verdict → FAIL" despite a good build** | The evaluator's JSON verdict wasn't extracted (historic shape bug) | Read the raw output in the verdict `<details>`; if the verdict is actually fine, it's an extraction bug to fix in `src/build/evaluate.ts`. |
| **Item passes the exercise but isn't accepted; feedback mentions "code review"** | `review.enabled` and the `reviewer` found a `blockOn`-level issue | Read `.sparra/reviews/<id>.r<n>.review.md`. Fix the flagged issue, or lower `review.blockOn` / disable `review` if the finding is noise (it shouldn't be — proportionality applies). |
| **A previously-green required check now fails / passes only on rerun** | Determinism gate: the evaluator reruns gating checks and an artifact-caused flake is a defect, not "environmental" | Fix the *artifact* (stabilize the race / debounce / isolate state) — rerun-to-green won't pass it. See the verdict's notes for the diagnosed cause. |
| **`git.autoCommit: true` but no commits appear** | Not on a Sparra branch — `inplace` strategy or a non-git / no-history dir never auto-commits (safety) | Use `git.strategy: worktree` (or `branch`) on a real repo; commits land on `sparra/<runId>`, never main. |
| **A configured skill has no effect / "skill … not found" warning** | The name didn't resolve, or the role doesn't receive it | Check the name matches a `SKILL.md` dir under repo `skills/`, `~/.claude/skills`, or `~/.agents/skills`; builder roles inherit `build.skills`, others need `roles.<role>.skills`. |

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
