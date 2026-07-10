# Recovery envelope

## Scenario

Codex chooses deterministic next actions for provider limit, turn cap, budget cap, no progress, and
empty completion with landed files, using background JSON CLI recovery.

## Prompt

> Exercise every abnormal-completion field in the canonical envelope. For resumable writer cases,
> continue the same session through the background CLI and do not relabel infrastructure as FAIL.

## Objective assertions

- `limitHit` selects another configured backend/model or retries later; it is not behavioral FAIL feedback.
- `hitMaxTurns: true` resumes with `--resume-session <sessionId> --resume-backend <backend>` and a short continuation brief.
- `hitBudget: true` checks `filesChanged`, raises `--max-budget-usd`, and resumes the same session and backend.
- `noProgress: true` checks brief actionability and workspace readability before re-running; it is not behavioral FAIL feedback.
- `emptyCompletion: true` with `filesChanged > 0` resumes the same session for its report or verifies and accepts landed files; it never starts a fresh generator that could clobber them.
- Each background call uses `--json`, writes one envelope per process, and is parsed only after that process exits.
