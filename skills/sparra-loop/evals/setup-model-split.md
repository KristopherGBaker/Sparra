# Setup and model split

## Scenario

Configure a customized Claude-conducted loop whose generator and evaluator use different backend
families, whose project-specific verification commands are allowlisted, and whose optional holdout
is passed only to the evaluator.

## Prompt

> Set up Sparra in this existing project. Use Claude Opus at high effort to generate, Codex
> `gpt-5.5` at high effort to evaluate, and Codex `gpt-5.5` to review. Configure the repository's
> typecheck and test commands as generator verification gates, then prepare a hidden evaluator-only
> acceptance file.

## Objective assertions

- The setup says `sparra init` is optional and runs it only when customization or the full loop is
  wanted and no `.sparra/` directory exists.
- The setup names `sparra init --docs docs` as the command that keeps planning files under `docs`.
- The setup edits `.sparra/config.yaml` under `roles.generator`, `roles.evaluator`, and
  `roles.reviewer` rather than changing role prompts.
- The configured split contains `generator: { backend: claude, model: opus, effort: high }` and
  `evaluator: { backend: codex, model: gpt-5.5, effort: high }`.
- The setup verifies Claude authentication and verifies both the authenticated `codex` CLI and
  `@openai/codex-sdk` before relying on the Codex evaluator.
- If Codex is unavailable, the stated fallback is a Claude evaluator and is identified as
  same-family rather than cross-model.
- The setup writes `npm run typecheck` and `npm test` as separate entries in
  `.sparra/config.yaml` `build.verifyCommands`; it does not combine them with `&&`, a pipe, or an
  environment prefix.
- The generator guidance states that `unitWorktree` enables self-verification automatically and
  does not require `allowVerify: true`.
- The in-place generator guidance passes `allowVerify: true` through `run_role`, or `--verify`
  through `sparra role run`, when contract gates name `build.verifyCommands` entries.
- If the returned payload contains `verifyGateWarning`, the next action is to re-run with
  `allowVerify: true` or `--verify` before spending more turns; the warning's named blocked
  commands are not treated as verified.
- The hidden checks are written to `.sparra/HOLDOUT.md`, are never read into conductor context,
  and are later supplied to an evaluator as `holdoutPath: ".sparra/HOLDOUT.md"`.
