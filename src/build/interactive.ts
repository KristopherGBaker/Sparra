import path from "node:path";
import type { Ctx } from "../context.ts";
import type { Verdict } from "./types.ts";
import { redactHoldout } from "./holdout.ts";
import { ensureDir, exists, readText, writeText } from "../util/io.ts";

/**
 * Interactive ("human-in-the-loop") build support for `sparra build --step`.
 *
 * The pause model is **checkpoint-and-exit + resume-from-disk** (the same model the
 * provider-limit pause already uses): at a checkpoint the build writes a steering
 * folder under `.sparra/interactive/<run>/<item>/`, records the pause in state, and
 * exits; the human edits the files there and re-runs `sparra build` to continue.
 * Humans edit FILES, not state.json. Holdout never reaches these notes (redacted).
 */

export type Step = "contract" | "round";
export type Decision = "continue" | "pivot" | "accept" | "abandon";

/** Parse `--step=contract,round` (or `--step round`) into a deduped list. */
export function parseSteps(raw: string | boolean | undefined): Step[] {
  if (raw === true) return ["contract", "round"]; // bare --step → both
  if (typeof raw !== "string") return [];
  const valid = new Set<Step>(["contract", "round"]);
  return [...new Set(raw.split(",").map((s) => s.trim()).filter((s): s is Step => valid.has(s as Step)))];
}

/** The steering folder for one item's pause. */
export function pauseDir(ctx: Ctx, runId: string, itemId: string): string {
  return path.join(ctx.paths.dir, "interactive", runId, itemId);
}

/** Relative-to-root display of the pause dir (for the console hint). */
export function pauseDirRel(ctx: Ctx, runId: string, itemId: string): string {
  return path.relative(ctx.root, pauseDir(ctx, runId, itemId));
}

/** Pause at the contract checkpoint: the proposed contract is written; the human may edit
 *  the canonical contract file, then resume. */
export async function writeContractPause(
  ctx: Ctx,
  args: { runId: string; itemId: string; itemTitle: string; contractFile: string }
): Promise<void> {
  const dir = pauseDir(ctx, args.runId, args.itemId);
  await ensureDir(dir);
  await writeText(
    path.join(dir, "pause.md"),
    `# Paused at the CONTRACT for ${args.itemId} — ${args.itemTitle}\n\n` +
      `A "done" contract has been negotiated. Review and (optionally) edit it, then resume.\n\n` +
      `- **Contract file:** \`${path.relative(ctx.root, args.contractFile)}\` — edit the text under the AGREED CONTRACT marker.\n` +
      `- Do NOT paste holdout/acceptance secrets here (they're evaluator-only; a leak is rejected).\n\n` +
      `Then run \`sparra build\` to generate against it. (Delete this folder to discard the pause.)\n`
  );
}

/** Pause at a round checkpoint: write a REDACTED verdict summary + an editable decision +
 *  default feedback the next generator round will receive. */
export async function writeRoundPause(
  ctx: Ctx,
  args: {
    runId: string;
    itemId: string;
    itemTitle: string;
    round: number;
    verdict: Verdict;
    holdoutText: string;
    defaultDecision: Decision;
    defaultFeedback: string;
  }
): Promise<void> {
  const dir = pauseDir(ctx, args.runId, args.itemId);
  await ensureDir(dir);
  const v = args.verdict;
  const failed = v.assertions.filter((a) => !a.pass);
  const summary =
    `# Paused after round ${args.round} for ${args.itemId} — ${args.itemTitle}\n\n` +
    `- verdict: **${v.verdict}**  ·  weighted **${v.weightedTotal}** / ${ctx.config.rubric.passThreshold}\n` +
    `- scores: design ${v.scores.design}, originality ${v.scores.originality}, craft ${v.scores.craft}, functionality ${v.scores.functionality}\n\n` +
    `## Failed assertions (${failed.length}/${v.assertions.length})\n${failed.map((a) => `- #${a.id}: ${a.evidence}`).join("\n") || "_none_"}\n\n` +
    `## Blocking\n${v.blocking.map((b) => `- ${b}`).join("\n") || "_none_"}\n\n## Notes\n${v.notes || "_none_"}\n\n` +
    `## Your move — edit \`decision.json\`, then run \`sparra build\`\n` +
    `- \`continue\` — patch & re-evaluate (edit \`feedback.md\` to steer the next round)\n` +
    `- \`pivot\` — discard this approach and rebuild from scratch (edit \`feedback.md\` for direction)\n` +
    `- \`accept\` — accept the item now (if overriding a FAIL, put WHY in \`reason\`; it's recorded)\n` +
    `- \`abandon\` — give up on this item\n`;
  // Everything human-facing is holdout-redacted (the evaluator may quote holdout).
  await writeText(path.join(dir, "pause.md"), redactHoldout(summary, args.holdoutText));
  await writeText(path.join(dir, "decision.json"), JSON.stringify({ decision: args.defaultDecision, reason: "" }, null, 2) + "\n");
  await writeText(path.join(dir, "feedback.md"), redactHoldout(args.defaultFeedback, args.holdoutText));
}

export interface RoundResolution {
  decision: Decision;
  reason: string;
  feedback: string;
}

/** Read the human's decision + (edited) feedback for a paused round. Defaults to `continue`
 *  if the decision file is missing/unparseable. */
export async function readRoundDecision(ctx: Ctx, runId: string, itemId: string): Promise<RoundResolution> {
  const dir = pauseDir(ctx, runId, itemId);
  let decision: Decision = "continue";
  let reason = "";
  const raw = await readText(path.join(dir, "decision.json"));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { decision?: string; reason?: string };
      const valid: Decision[] = ["continue", "pivot", "accept", "abandon"];
      if (parsed.decision && valid.includes(parsed.decision as Decision)) decision = parsed.decision as Decision;
      reason = String(parsed.reason ?? "");
    } catch {
      /* keep defaults */
    }
  }
  const fb = exists(path.join(dir, "feedback.md")) ? (await readText(path.join(dir, "feedback.md"))) ?? "" : "";
  return { decision, reason, feedback: fb };
}
