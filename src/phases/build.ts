import path from "node:path";
import type { Ctx } from "../context.ts";
import { newRunId } from "../context.ts";
import type { ItemState } from "../state.ts";
import { banner, color, detail, info, ok, step, warn } from "../util/log.ts";
import { exists, readText } from "../util/io.ts";
import { prepareWorkspace } from "../util/git.ts";
import { ensureAutoProbed } from "../sdk/guard.ts";
import { decompose } from "../build/decompose.ts";
import { negotiateContract } from "../build/contract.ts";
import { generateItem } from "../build/generate.ts";
import { evaluateItem } from "../build/evaluate.ts";
import { updateStreaksAndDecide } from "../build/pivot.ts";
import { recordDeviations, reconcilePlan } from "../build/reconcile.ts";
import type { WorkItem } from "../build/types.ts";

function freshItemState(): ItemState {
  return { status: "pending", round: 0, pivots: 0, criterionFailStreak: {} };
}

export async function cmdBuild(
  ctx: Ctx,
  opts: { fresh?: boolean; only?: string; workspaceOverride?: string; quiet?: boolean } = {}
): Promise<{ passed: number; failed: number; total: number; runId: string }> {
  banner("Phase C · AUTONOMOUS BUILD");
  const b = ctx.store.data;

  if (b.phase !== "frozen" && b.phase !== "build" && b.phase !== "done") {
    warn(`Build requires a frozen plan. Current phase: ${b.phase}. Run \`sparra freeze\` first.`);
    return { passed: 0, failed: 0, total: 0, runId: "" };
  }
  if (!exists(ctx.paths.frozenPlan) && !exists(ctx.paths.plan)) {
    warn("No plan found to build from.");
    return { passed: 0, failed: 0, total: 0, runId: "" };
  }

  // Run id + workspace (resumable).
  if (opts.fresh || !b.build.runId) {
    b.build.runId = newRunId("build");
    b.build.traceSeq = 0;
    b.build.items = {};
    b.build.workspaceDir = undefined;
  }
  const runId = b.build.runId!;
  const traceDir = ctx.paths.traceDir(runId);
  await ctx.store.transition("build", true);
  await ensureAutoProbed(ctx);

  if (!b.build.workspaceDir) {
    if (opts.workspaceOverride) {
      b.build.workspaceDir = opts.workspaceOverride;
      b.build.workspaceNote = `isolated workspace ${path.relative(ctx.root, opts.workspaceOverride)}`;
    } else {
      const ws = prepareWorkspace(ctx.root, ctx.config.git.strategy, ctx.config.git.branchPrefix, runId);
      b.build.workspaceDir = ws.dir;
      b.build.branch = ws.branch;
      b.build.workspaceNote = ws.note;
    }
    await ctx.store.save();
  }
  const workspaceDir = b.build.workspaceDir!;
  info(`run: ${runId}`);
  detail(`workspace: ${b.build.workspaceNote}`);
  detail(`exercise mechanism: ${ctx.config.exercise.mechanism} · deviation: ${ctx.store.data.mode}/${ctx.config.deviation.strictness}`);

  // Decompose (idempotent).
  const allItems = await decompose(ctx, traceDir, opts.fresh);
  if (allItems.length === 0) {
    await ctx.store.transition("done", true);
    return { passed: 0, failed: 0, total: 0, runId };
  }
  const items = opts.only ? allItems.filter((i) => i.id === opts.only) : allItems;

  const nextSeq = () => {
    b.build.traceSeq = (b.build.traceSeq ?? 0) + 1;
    return b.build.traceSeq;
  };

  let totalCost = 0;

  for (const item of items) {
    const st = (b.build.items[item.id] ??= freshItemState());
    if (st.status === "passed" || st.status === "abandoned") {
      detail(`${item.id} already ${st.status} — skipping.`);
      continue;
    }
    b.build.currentItem = item.id;

    step(`${item.id}: ${item.title}`);
    if (!depsSatisfied(item, b.build.items)) {
      warn(`${item.id} has unmet dependencies (${item.dependsOn.join(", ")}); attempting anyway.`);
    }

    // 1) Negotiate the "done" contract.
    st.status = "contracting";
    await ctx.store.save();
    const contract = await negotiateContract(ctx, item, traceDir, nextSeq());
    // negotiateContract advanced the global seq via its own writes; bump our counter past it.
    b.build.traceSeq = (b.build.traceSeq ?? 0) + contract.tracesUsed;

    // 2) Generate ↔ evaluate loop with GAN pivots.
    st.status = "building";
    let feedback: string | undefined;
    let fresh = false;
    let resumeSessionId = st.generatorSessionId;

    while (st.round < ctx.config.build.maxRoundsPerItem) {
      st.round += 1;
      const gen = await generateItem({
        ctx,
        item,
        contractText: contract.text,
        workspaceDir,
        traceDir,
        traceSeq: nextSeq(),
        feedback,
        resumeSessionId: fresh ? undefined : resumeSessionId,
        fresh,
      });
      totalCost += gen.costUsd;
      st.generatorSessionId = gen.sessionId;
      resumeSessionId = gen.sessionId;
      await ctx.store.save();

      const dev = await recordDeviations(ctx, item, gen.deviations);

      const ev = await evaluateItem({
        ctx,
        item,
        contractText: contract.text,
        workspaceDir,
        round: st.round,
        traceDir,
        traceSeq: nextSeq(),
      });
      totalCost += ev.costUsd;
      st.lastScore = ev.verdict.weightedTotal;

      if (ev.verdict.verdict === "pass") {
        st.status = "passed";
        await ctx.store.save();
        await reconcilePlan(ctx, item, gen.deviations, traceDir, nextSeq());
        ok(`${item.id} accepted in round ${st.round} (score ${ev.verdict.weightedTotal}). cumulative $${totalCost.toFixed(3)}`);
        break;
      }

      const decision = updateStreaksAndDecide(st, ev.verdict, ctx.config);
      st.criterionFailStreak = decision.streaks;
      await ctx.store.save();

      if (st.round >= ctx.config.build.maxRoundsPerItem) break;

      if (decision.pivot) {
        st.pivots += 1;
        st.criterionFailStreak = {};
        fresh = true;
        resumeSessionId = undefined;
        feedback = `GAN PIVOT: this item stayed below ${ctx.config.pivot.threshold} on "${decision.criterion}" for ${ctx.config.pivot.N} rounds. Discard the previous approach entirely and rebuild from scratch with a fundamentally different design. Latest blocking issues: ${ev.verdict.blocking.join("; ") || ev.verdict.notes}`;
        warn(`${item.id}: GAN pivot on "${decision.criterion}" → restarting from scratch (pivot #${st.pivots}).`);
      } else {
        fresh = false;
        feedback = `Address these blocking issues from the evaluator:\n${ev.verdict.blocking.map((x) => `- ${x}`).join("\n")}\nFailed assertions: ${ev.verdict.assertions.filter((a) => !a.pass).map((a) => `#${a.id}`).join(", ") || "(see verdict)"}`;
        detail(`${item.id}: patching for round ${st.round + 1}.`);
      }
      void dev;
    }

    if (st.status !== "passed") {
      st.status = "failed";
      warn(`${item.id} did not pass within ${ctx.config.build.maxRoundsPerItem} rounds (best score ${st.lastScore ?? 0}).`);
    }
    await ctx.store.save();
  }

  // Summary.
  const states = Object.values(b.build.items);
  const passed = states.filter((s) => s.status === "passed").length;
  const failed = states.filter((s) => s.status === "failed").length;
  b.build.currentItem = undefined;
  await ctx.store.transition("done", true);

  banner("BUILD COMPLETE");
  ok(`${passed}/${items.length} items passed${failed ? `, ${failed} failed` : ""}. cumulative $${totalCost.toFixed(3)}`);
  for (const item of items) {
    const s = b.build.items[item.id];
    const mark = s?.status === "passed" ? color.green("✓") : s?.status === "failed" ? color.red("✗") : color.yellow("•");
    detail(`${mark} ${item.id} ${item.title} — ${s?.status} (rounds ${s?.round}, pivots ${s?.pivots}, score ${s?.lastScore ?? "-"})`);
  }
  info(`traces:    ${path.relative(ctx.root, traceDir)}`);
  info(`changelog: ${path.relative(ctx.root, ctx.paths.changelog)}`);
  if (exists(ctx.paths.proposals)) info(`proposals: ${path.relative(ctx.root, ctx.paths.proposals)} (out-of-scope items for you)`);
  if (b.build.branch) {
    info(`Work is on branch ${color.bold(b.build.branch)} — Sparra did NOT commit to your main branch.`);
    detail(b.build.workspaceNote ?? "");
  }
  info("Review the work, then `sparra reflect` to improve the prompts from this run's traces.");

  return { passed, failed, total: items.length, runId };
}

function depsSatisfied(item: WorkItem, items: Record<string, ItemState>): boolean {
  return item.dependsOn.every((d) => items[d]?.status === "passed");
}

/** Read frozen plan for callers that want a quick sanity check. */
export async function frozenPlanExists(ctx: Ctx): Promise<boolean> {
  return (await readText(ctx.paths.frozenPlan)) != null;
}
