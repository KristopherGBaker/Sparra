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

/** Default tight USD cap for a cap-death report re-ask (role-runner). Small on purpose — a report
 *  re-emit is one short turn — and clamped below the original run's cap by the caller so it stays
 *  materially tighter than the run that just died. */
export const REPORT_REASK_MAX_BUDGET_USD = 0.5;

/**
 * Session-request overrides for the one-shot report re-ask: resume the dying session with the
 * report-only prompt. Spread over the caller's base request. `tightCap` (used by BOTH the
 * autonomous generator's turn-cap recovery AND the interactive role-runner's budget/turn-cap
 * recovery) additionally PINS the re-ask to one turn + a small USD budget AND makes the resumed
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
 * autonomous generator passes `tightCap` on the turn-cap path; a base re-ask without it is a
 * separate path and stays unchanged).
 *
 * `prompt` overrides the default report-only prompt — the interactive EVALUATOR cap-death re-ask
 * passes `VERDICT_REASK_PROMPT` (re-emit the verdict block, not a generator report) so both the
 * writer and evaluator resumes share this ONE overrides builder and keep every re-ask prompt
 * literal in this module. Defaults to `REPORT_REASK_PROMPT` (writer/generator path unchanged).
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
