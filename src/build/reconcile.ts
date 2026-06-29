import path from "node:path";
import type { Ctx } from "../context.ts";
import { fill, loadPrompt } from "../prompts.ts";
import { runSession, type RunResult, type RunSessionParams } from "../sdk/session.ts";
import { plannerWriteScope } from "../sdk/permissions.ts";
import { makeHoldoutReadDecider } from "./holdout.ts";
import { appendText, writeText } from "../util/io.ts";
import { detail, info } from "../util/log.ts";
import type { Deviation } from "./generate.ts";
import type { WorkItem } from "./types.ts";

/**
 * Persist deviations deterministically:
 *  - in-scope    → appended to CHANGELOG.md with rationale
 *  - out-of-scope → written as a proposal for the human (NOT done autonomously)
 */
export async function recordDeviations(ctx: Ctx, item: WorkItem, deviations: Deviation[]): Promise<{ changelog: number; proposals: number }> {
  let changelog = 0;
  let proposals = 0;
  const date = new Date().toISOString().slice(0, 10);

  const inScope = deviations.filter((d) => d.scope !== "out-of-scope");
  const outScope = deviations.filter((d) => d.scope === "out-of-scope");

  if (inScope.length) {
    const lines = inScope.map((d) => `- **${item.id}** (${date}): ${d.summary}\n  - _rationale:_ ${d.rationale}`).join("\n");
    await appendText(ctx.paths.changelog, `\n### ${item.id} — ${item.title}\n${lines}\n`);
    changelog = inScope.length;
  }

  for (const [i, d] of outScope.entries()) {
    const file = path.join(ctx.paths.proposals, `${item.id}-${i + 1}.md`);
    await writeText(
      file,
      `# Proposal (from ${item.id}) — ${d.summary}\n\n_Generated ${date}. This is OUT OF SCOPE for the current item and was NOT done autonomously. Your call._\n\n## What\n${d.summary}\n\n## Why\n${d.rationale}\n\n## Decision\n- [ ] accept (fold into a future item / plan)\n- [ ] reject\n`
    );
    proposals++;
  }

  if (changelog) detail(`recorded ${changelog} deviation(s) → CHANGELOG.md`);
  if (proposals) detail(`logged ${proposals} out-of-scope proposal(s) → .sparra/proposals/`);
  return { changelog, proposals };
}

/**
 * Keep PLAN.md from going stale: after an item is accepted, fold what was actually
 * built (and any deviations) back into the plan. Runs only when there were
 * deviations (otherwise the plan still matches reality). Writes PLAN.md only.
 */
export async function reconcilePlan(
  ctx: Ctx,
  item: WorkItem,
  deviations: Deviation[],
  traceDir: string,
  traceSeq: number,
  opts: { runSessionFn?: (p: RunSessionParams) => Promise<RunResult> } = {}
): Promise<void> {
  if (deviations.length === 0) return;
  const run = opts.runSessionFn ?? runSession;
  const role = ctx.config.roles.planner;
  const system = fill(await loadPrompt(ctx.paths, "planner"), { MODE: ctx.store.data.mode });

  const task = `Work item ${item.id} (${item.title}) was just built and accepted, with deviations from the original plan. WITHOUT asking questions, reconcile PLAN.md (${ctx.paths.plan}) so it reflects reality: update Approach / Constraints / Risks / Open questions as warranted so the plan does not go stale. Keep it high-level. Edit only PLAN.md.

DEVIATIONS:
${deviations.map((d) => `- [${d.scope}] ${d.summary} — ${d.rationale}`).join("\n")}`;

  info(`Reconciling PLAN.md after ${item.id}…`);
  await run({
    role: `reconcile-${item.id}`,
    prompt: task,
    systemPrompt: system,
    backend: role.backend,
    model: role.model,
    effort: role.effort,
    cwd: ctx.root,
    tools: ["Read", "Edit", "Write"],
    permissionMode: "default",
    // Forbid role in the repo root: it edits PLAN.md (read by the builder), so deny on-disk holdout
    // reads — a read here could otherwise be laundered into PLAN.md and reach the generator.
    canUseTool: plannerWriteScope(ctx.paths.plan, ctx.config.permission.denyBashContains, makeHoldoutReadDecider(ctx, ctx.root)),
    maxTurns: 20,
    traceDir,
    traceSeq,
  });
}
