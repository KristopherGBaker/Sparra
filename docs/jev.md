# Jev judgments (TypeSafe)

Sparra can ask TypeSafe's **Jev** model (a fast, calibrated classifier over typed Noul / Choice / Score
questions; JS SDK `@typesafe-ai/sdk`) for small **judgment calls** — a cheap, ~0.5 s second opinion on a
narrow question where ordinary code would need semantic understanding. Every use is **opt-in, off by
default, and fail-open**: with the flag off, the key unset, or the service erroring, Sparra behaves
exactly as it would without Jev. Jev **never grades an artifact** and never decides anything by itself.

## What uses it

| Knob | Where it asks | What Jev's answer does | Sent to TypeSafe |
|---|---|---|---|
| [`reflect.dedupe`](configuration.md) | each finding routed to the upstream reflect inbox, paired with each live entry | top band (≥ `autoThreshold`, 0.9) auto-merges as a recurrence; the middle band is printed as a suggestion | holdout-redacted finding text |
| [`reflect.shippedCheck`](configuration.md) (`reflect --upstream --check-shipped`) | each live inbox finding × each recent non-merge commit | prints ready-to-run `--done` suggestions; never triages | finding text + commit subject/body |
| [`evaluator.envBlockJudge`](configuration.md) | each FAILED runnable assertion in a verdict | the strict `auto` band freezes pivot / per-assertion streaks and surfaces `envBlockedAssertionIds` to the conductor; the verdict is **never** changed | redacted evidence for that one assertion (holdout-marked evidence is skipped) |
| [`conduct.shadowJudge`](conduct.md#shadow-mode-jev-judgment) | every `sparra conduct` judgment point | recorded as `shadow` beside the real resolution in `run.json` — calibration data only, never obeyed | the decision's holdout-safe question + scalar context |

Full knob semantics are in [configuration.md](configuration.md); failure signatures are in the skill's
`subskills/diagnose.md`.

## Setup

- Put the key in your shell environment (e.g. `export TYPESAFE_API_KEY=…` in `~/.zshenv`). Each knob's
  `apiKeyEnv` **names** the variable (default `TYPESAFE_API_KEY`). Never put the key in
  `.sparra/config.yaml`.
- `model` is a pinned version ID (`jev-1.13.0`), not the moving `jev-latest` alias, so a model update
  can't silently shift the thresholds below.
- Enabling a knob **is** the consent to send the text listed above to TypeSafe.

## Design rules (what every Jev seam follows)

- **One comparison per request, minimal named state** — e.g. `{verdict_item}` or `{finding_a, finding_b}`.
  Packing many candidates into one state inflates scores.
- **Pair a Noul with a Choice that names the tempting near-miss** (`both_blocked_and_defect`,
  `same_area_distinct_defect`). Act automatically only on the strict top band; surface the middle band.
- **Only reversible or informational actions.** Jev follows the framing of the text it reads — an
  evaluator that calls a missing fixture "environment-blocked" fools it — so an answer may freeze a
  streak, suggest, or annotate, but never pass, fail, strike, or delete.
- **Never send holdout material.** Only redacted verdict text; evidence carrying the holdout redaction
  marker is skipped. Jev never does arithmetic or date comparison — that stays in code.
- **Untrusted responses.** Every answer is validated (known choice, probabilities in `[0, 1]`); an
  invalid answer counts as no answer. At most one warning per call / verdict / run.
- **Injectable client factory** so tests never make live calls.

## Evidence behind the thresholds

Every seam started as an offline experiment: a dataset built from existing `.sparra/` artifacts across
projects, blind labels from a separate model on a stratified sample, precision / recall per threshold,
calibration by bucket, and a keyword-regex baseline — then a full-population scan for the dangerous class.

- **Reflect dedupe** (180 labeled pairs): Noul ≥ 0.9 → 100% precision; exact-title matching found 0 of
  38 duplicates.
- **Env-blocked** (240 labeled failed assertions): Noul ≥ 0.5 → 99% precision / 86% recall; the strict
  `auto` rule → 100% / 53%. The regex baseline had 53% precision with 61 harmful false positives.

### Evaluated and not adopted (2026-09-30 / 10-01)

The first two were built from 671 role-run verdicts paired with their agreed contracts (7,873 non-holdout assertions).

- **Contract overreach** — "does this failed assertion fault something the contract doesn't require?",
  meant to give `detectContractDefect` a semantic signal against the generalize-spec trap. Only ~11% of
  failed assertions were overreach, and most of those were the evaluator's own adversarial probe of an
  unlisted case (often a real bug). Jev followed the evaluator's framing: best 30–38% precision; a
  Choice naming `grader_added_case` reached 67% precision at 26% recall. The reverse direction ("a case
  the assertion describes fails") was 100% precise at its strictest band, but only against an 84% base
  rate, so a strike-veto guard would add little.
- **Rubber-stamp passes** — "does each PASSED assertion's evidence actually show it?" About a quarter
  of passes are only partially evidenced, but Jev (Noul ≥ 0.9: 67% precision / 60% recall) barely beat
  an evidence-length heuristic. Its `contradicts` answer misread `rc=1, no matches` — the success of a
  negative `rg` sweep — as a failure.

- **Conductor next-action (interactive `/sparra-loop`)** — reconstructed 512 interactive decisions from
  role-run timelines (units keyed by contract heading/worktree; the next role-runs after each verdict
  show what the conductor did) and asked Jev, from the holdout-redacted verdict summary, which of
  *fix the artifact / amend the contract / accept the blockers and re-grade* fits each of 234
  unambiguous failed-verdict decisions. Jev answered `fix_artifact` 225 times, mostly at confidence
  ≥ 0.8 — 28% agreement, below the 47% majority-class baseline; a "does an item blame the contract?"
  Noul ≥ 0.5 was 79% precise but caught only 10% of amendments. The decision depends on context the
  verdict doesn't carry (the contract's intent, the unit's history, cost), so a Jev decision strategy
  for interactive conducting is not worth a `record_decision` seam.

**Lesson:** Jev works when the answer is local and literal in the text it sees (couldn't-run vs failed,
same defect vs different). It fails when the answer depends on the contract's intent or on context
outside the state (scope, sufficiency).

## Candidates not yet tried

Run the offline experiment above before building any of these.

- **Contract preflight lint** — per-assertion Nouls before generator spend: does it gate on a
  harness-owned lifecycle step (commit / branch / merge)? does it need something the evaluator sandbox
  can't do? is it checkable at all? Fed back into contract negotiation as warnings. These are more
  literal questions than overreach; ground-truth labels ("later proved unsatisfiable") are thin.
- **Critique triage** — classify contract-evaluator critique points as substantive / out-of-scope /
  style nit / unsatisfiable. Most persisted critiques are short "AGREED" notes today, and nothing acts
  on the class yet.
- **Smaller ideas** — stall detection on non-evaluator traces; per-item skill selection; a
  materiality filter for reflect findings.
- **A confidence-gated Jev conduct strategy** — a `JudgmentStrategy` that lets Jev resolve headless
  `sparra conduct` decisions directly, falling back to the brain or a park below a confidence gate.
  The interactive next-action experiment above argues against it; only revisit if `shadow` records in
  `.sparra/conduct/*/run.json` (none on 2026-10-01) show high agreement on the narrow decision kinds.
- **Real-world check of `envBlockJudge`** — once new verdicts carry `envBlock` annotations, measure the
  strict band outside the original sample.
