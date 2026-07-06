import type { HookCallback, PostToolUseHookSpecificOutput } from "@anthropic-ai/claude-agent-sdk";
import type { HookConfig } from "./hooks.ts";

/**
 * Turns-remaining warning for the report-emitting generator (Claude only).
 *
 * The generator prompt says "emit the report JSON as soon as your gates verify," but the model has
 * no visibility into turns used/left, so the clause is not actionable — runs burn a whole
 * continuation round dying at the per-session turn cap with landed work but no forfeited report.
 * This injects a ONE-TIME in-session nudge, at ~80% of the request's `maxTurns`, telling the model
 * to emit its completion report JSON now and polish after.
 *
 * SDK reality (scoping-confirmed): the only mid-session injection seam is a hook returning
 * `hookSpecificOutput.additionalContext`, and it MUST be a PostToolUse hook (PreToolUse is the
 * permission guard). Session progress is observed via the `onAssistantText` seam (the real
 * per-turn boundary the backend already surfaces); the count it produces is an APPROXIMATION of
 * turns used. Codex has no turn cap, no injection, and `capabilities.hooks === false`, so this is
 * Claude-only — on Codex it never attaches (the hook rides the Claude hooks path).
 */

/** Fire the warning once progress first crosses this fraction of `maxTurns` (~80%). */
export const TURN_WARNING_RATIO = 0.8;

/**
 * Floor: don't warn when `maxTurns` is below this. With too few turns a "polish after" split
 * doesn't help — the report should just come first — so the warning is disabled entirely.
 */
export const MIN_TURNS_FOR_WARNING = 10;

/** Marker stamped on the warning hook callback so the assembled hook set is identifiable in tests
 *  (the format hook is ALSO a PostToolUse hook, so event presence alone can't distinguish it). */
const TURN_WARNING_MARK = "__sparraReportTurnWarning";

/** The PostToolUse hook + a wrapped `onAssistantText` sharing one progress counter. */
export interface TurnWarningSeam {
  /** PostToolUse hook config to MERGE into the writer hook set. Empty when the warning is disabled. */
  hooks: HookConfig;
  /** Advances the progress counter on each assistant-text boundary; still invokes any caller hook. */
  onAssistantText: (text: string) => void;
}

/** The actionable nudge text, naming the remaining-turn estimate. */
export function reportTurnWarningText(remaining: number): string {
  return (
    `⏳ Turn budget: about ${remaining} turn${remaining === 1 ? "" : "s"} left before this session hits its ` +
    `cap. Emit your completion report JSON NOW — the fenced \`\`\`json block with report / ` +
    `assertionsClaimed / deviations — then keep polishing. Do NOT save the report for the end: ` +
    `hitting the cap without it forfeits the round.`
  );
}

/**
 * Build the turns-remaining warning seam. The returned `onAssistantText` advances an internal
 * progress counter (and still calls any `opts.onAssistantText`, so the caller's hook is wrapped,
 * not replaced). The PostToolUse hook fires AT MOST ONCE — the first time progress reaches
 * `floor(maxTurns * TURN_WARNING_RATIO)` — returning `hookSpecificOutput.additionalContext`.
 *
 * Disabled (no hook attached, warning never fires) when `maxTurns` is unset/0 or below
 * `MIN_TURNS_FOR_WARNING`; the `onAssistantText` wrapper is still returned so wiring is uniform.
 */
export function makeReportTurnWarningHook(opts: {
  maxTurns?: number;
  onAssistantText?: (text: string) => void;
}): TurnWarningSeam {
  const caller = opts.onAssistantText;
  const maxTurns = opts.maxTurns;
  const enabled = typeof maxTurns === "number" && maxTurns >= MIN_TURNS_FOR_WARNING;
  const threshold = enabled ? Math.floor(maxTurns! * TURN_WARNING_RATIO) : Number.POSITIVE_INFINITY;

  let progress = 0;
  let fired = false;

  const onAssistantText = (text: string) => {
    progress++;
    caller?.(text);
  };

  if (!enabled) return { hooks: {}, onAssistantText };

  const hookFn: HookCallback = async () => {
    if (fired || progress < threshold) return {};
    fired = true;
    const remaining = Math.max(0, maxTurns! - progress);
    const out: PostToolUseHookSpecificOutput = {
      hookEventName: "PostToolUse",
      additionalContext: reportTurnWarningText(remaining),
    };
    return { hookSpecificOutput: out };
  };
  (hookFn as unknown as Record<string, unknown>)[TURN_WARNING_MARK] = true;

  return { hooks: { PostToolUse: [{ hooks: [hookFn] }] }, onAssistantText };
}

/** True iff `hooks` contains the report turns-remaining warning hook (identified by its marker). */
export function hasReportTurnWarningHook(hooks: HookConfig): boolean {
  return (hooks.PostToolUse ?? []).some((m) =>
    m.hooks.some((h) => (h as unknown as Record<string, unknown>)[TURN_WARNING_MARK] === true)
  );
}
