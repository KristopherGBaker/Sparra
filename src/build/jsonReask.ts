import type { RunSessionParams } from "../sdk/session.ts";

/**
 * The shared JSON re-ask: resume a session ONCE to re-emit only the final report/verdict JSON
 * block when a run produced no parseable report but the work is (or the reply nearly was) there.
 * Both the autonomous generator (`generate.ts`) and the interactive role-runner (`roleRun.ts`)
 * build their resume request from this one place, so the report-only prompt reads identically and
 * neither copy-pastes the paragraph.
 */
export const REPORT_REASK_PROMPT =
  "Your previous reply had no parseable report JSON. Re-emit ONLY the JSON block per your instructions — nothing else.";

/**
 * The EVALUATOR's cap-death verdict re-ask prompt: a session killed by our budget/turn cap left no
 * verdict-shaped JSON at all (no block, or only incidental non-verdict JSON). Names the *verdict*
 * block specifically — the evaluator analogue of `REPORT_REASK_PROMPT` — so the tight-capped resume
 * (`roleRun.ts`'s cap-death recovery) re-emits ONLY the JSON verdict block, not more grading work.
 * Lives here so the interactive evaluator re-ask shares the one prompt paragraph and `roleRun.ts`
 * never copy-pastes a re-ask literal of its own.
 */
export const VERDICT_REASK_PROMPT =
  "Your previous reply had no parseable JSON verdict. Re-emit ONLY the JSON verdict block per your instructions — nothing else.";

/**
 * The evaluator's WRONG-SHAPE verdict re-ask: a JSON block WAS emitted but it fails `isVerdict`
 * (e.g. missing/non-object `scores`, missing `verdict`/`weightedTotal`). A generic "re-emit the
 * block" can't fix a block that was already emitted, so this NAMES the specific required fields
 * the best verdict-like candidate is missing/invalid (computed by the caller) — while still
 * instructing "re-emit ONLY the JSON block". Kept here so the paragraph lives in one place.
 */
export function verdictReaskPrompt(missingFields: string[]): string {
  const fields = missingFields.length ? missingFields.join(", ") : "scores, verdict";
  return `Your previous reply had a JSON block but of the wrong shape — the verdict is missing or has an invalid value for: ${fields}. Re-emit ONLY the JSON verdict block per your instructions, with the required field(s) present and valid — nothing else.`;
}

/** A report re-ask needs exactly ONE turn: enough to re-emit the block, not enough to re-enter
 *  work. The role-runner's cap-death re-ask pins this so a session resumed after a cap can't
 *  quietly keep building past the cap it just hit. */
export const REPORT_REASK_MAX_TURNS = 1;

/**
 * Minimum USD floor for a re-ask, independent of the dying run's own observed cost: enough to
 * cover one turn on an EXPENSIVE model. Real-world evidence (trace 2026-07-13T07-52-03): a single
 * opus turn cost $1.5775 — well above the old blind, hard-coded per-re-ask budget this helper
 * replaces (previously a flat half-dollar), so an opus re-ask died with `error_max_budget_usd`
 * before ever emitting the JSON block, making the whole cap-death recovery inert on exactly the
 * role (opus fallback) most likely to need it. This floor sits with headroom above that observed
 * cost.
 */
const REASK_MIN_BUDGET_USD = 2;

/** Headroom multiplier over the dying run's own `observedCostUsd`: a resumed turn re-emitting the
 *  same report/verdict tends to cost roughly what the dying turn cost, so give it margin rather
 *  than a bare 1x (which could clip on a session that ran slightly hotter than usual). */
const REASK_OBSERVED_MARGIN = 1.25;

/**
 * Derive the one-shot re-ask's USD budget cap from the run that just died, replacing the old
 * blind, hard-coded per-re-ask budget constant this module used to export. Both documented design
 * intents from that constant are preserved, just computed instead of hard-coded:
 *   1. **Covers one turn on an expensive model** — floored at `REASK_MIN_BUDGET_USD` (with margin
 *      over `observedCostUsd`, in case the dying run itself ran hotter than that floor), so the
 *      resumed turn isn't killed by `error_max_budget_usd` before it can emit JSON.
 *   2. **Never authorizes MORE spend than the run it's recovering from** — when `runCapUsd` is a
 *      real (positive) limit, the derived value is clamped to it. `runCapUsd <= 0` means unlimited
 *      (existing Sparra budget semantics — see `budgetExceeded`), so no clamp applies.
 *      NOTE this is a ceiling, NOT the old constant's "materially tighter than the dying run"
 *      guarantee, and deliberately so: the two intents conflict when the cap is small (a flat
 *      fraction of a $1 cap reintroduces the very `error_max_budget_usd` death this fixes). On a
 *      BUDGET-cap death `observedCostUsd ≈ runCapUsd`, so the clamp returns the run's FULL cap —
 *      reached today only by `roleRun.ts`'s evaluator `hitBudget` re-ask (`generate.ts` and
 *      `evaluate.ts` gate theirs behind `budgetExceeded`, so they only ever fire below the cap).
 *      Tightness is enforced STRUCTURALLY instead, by `reportReaskOverrides`' `tightCap`: ONE turn,
 *      text-only, no tools — which bounds real spend to a single turn whatever this number says.
 *      Don't "fix" this by shrinking the USD value; the turn pin is the control that matters.
 * All four re-ask call sites — the autonomous generator's turn-cap recovery (`generate.ts`), the
 * interactive role-runner's writer cap-death AND evaluator verdict re-ask (`roleRun.ts`), and the
 * evaluator verdict re-ask (`evaluate.ts`) — derive their `maxBudgetUsd` through this ONE helper so
 * the cap can't silently drift out of sync between them; no caller should keep its own cap literal.
 */
export function reaskBudgetUsd(observedCostUsd: number, runCapUsd: number): number {
  const observed = Number.isFinite(observedCostUsd) && observedCostUsd > 0 ? observedCostUsd : 0;
  const desired = Math.max(REASK_MIN_BUDGET_USD, observed * REASK_OBSERVED_MARGIN);
  return runCapUsd > 0 ? Math.min(desired, runCapUsd) : desired;
}

/**
 * Session-request overrides for the one-shot report re-ask: resume the dying session with the
 * report-only prompt. Spread over the caller's base request. `tightCap` (used by all four re-ask
 * call sites — the autonomous generator's turn-cap recovery, the interactive role-runner's
 * budget/turn-cap recovery for both writer and evaluator, and the evaluator verdict re-ask)
 * additionally PINS the re-ask to one turn + a `reaskBudgetUsd`-derived USD cap AND makes the resumed
 * turn genuinely TEXT-ONLY so it can only re-emit the report — it can't re-enter work:
 *   • `tools: []` — the Claude backend maps `req.tools → options.tools`; an empty array means NO
 *     built-in tools are available, so nothing (Write/Edit/Bash) can be induced or invoked.
 *   • `permissionMode: "default"` (NOT "plan") — plan mode was dropped because plan mode's own
 *     system prompt induces the model to Write a plan file; the read-only sandbox then BLOCKS that
 *     Write and the single turn is consumed → error_max_turns with no JSON. Tool-stripping is the
 *     correct write-block for the Claude path; plan mode is no longer needed.
 *   • `readOnly: true` — keeps the Codex read-only sandbox intent (Codex ignores `tools`/
 *     `permissionMode` but reads `readOnly` for its sandbox mode).
 *   • `hooks: undefined` — present so it wins over an inherited writer `hooks`.
 *   • `mcpServers: undefined`, `allowedTools: undefined` — a text-only re-emit needs no MCP tools;
 *     clearing these prevents any inherited tool-enabling fields from reaching the resumed turn.
 * Spread AFTER `commonReq`, these win. No `tightCap` → exactly `{role, prompt, resume}` (the
 * autonomous generator's own clean-end no-JSON path — the run ended normally, so re-entering a
 * turn without the tight cap is fine — is the one re-ask path that omits `tightCap`; every other
 * caller, including `evaluate.ts`'s verdict re-ask, passes it).
 *
 * `prompt` overrides the default report-only prompt — the interactive EVALUATOR cap-death re-ask
 * passes `VERDICT_REASK_PROMPT`, and both it and the `evaluate.ts` verdict re-ask pass a
 * field-targeted `verdictReaskPrompt(...)` on a wrong-shape block (re-emit the verdict, not a
 * generator report), so every writer and evaluator resume shares this ONE overrides builder and
 * every re-ask *prompt-building* literal stays here (or in the caller's own no-JSON verdict prompt,
 * which pre-dates this module and is intentionally a separate short literal). Defaults to
 * `REPORT_REASK_PROMPT` (writer/generator path unchanged).
 */
export function reportReaskOverrides(opts: {
  role: string;
  sessionId: string;
  tightCap?: { maxBudgetUsd: number };
  prompt?: string;
}): Partial<RunSessionParams> {
  return {
    role: opts.role,
    prompt: opts.prompt ?? REPORT_REASK_PROMPT,
    resume: opts.sessionId,
    ...(opts.tightCap
      ? {
          maxTurns: REPORT_REASK_MAX_TURNS,
          maxBudgetUsd: opts.tightCap.maxBudgetUsd,
          // Strip all tool surface: empty tools array → nothing can be invoked on the Claude
          // path; cleared MCP/allowedTools so no inherited writer tool-enablers leak through.
          tools: [] as string[],
          mcpServers: undefined,
          allowedTools: undefined,
          // Use default permission mode (not plan — plan mode's own prompt invites a plan-file
          // Write that the sandbox then blocks, burning the single turn with no JSON emitted).
          permissionMode: "default" as const,
          // Read-only sandbox for Codex; cleared hooks so the Claude backend derives RO hooks.
          readOnly: true,
          hooks: undefined,
        }
      : {}),
  };
}
