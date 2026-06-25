import path from "node:path";
import { createHash } from "node:crypto";
import type { Ctx } from "../context.ts";
import { newRunId } from "../context.ts";
import type { ItemState } from "../state.ts";
import { banner, color, detail, info, ok, step, warn } from "../util/log.ts";
import { exists, readText } from "../util/io.ts";
import { prepareWorkspace, changedFiles, commitAll } from "../util/git.ts";
import { writeScopeViolations } from "../sdk/scoping.ts";
import { ensureAutoProbed } from "../sdk/guard.ts";
import { decompose } from "../build/decompose.ts";
import { negotiateContract } from "../build/contract.ts";
import { generateItem } from "../build/generate.ts";
import { evaluateItem } from "../build/evaluate.ts";
import { reviewItem } from "../build/review.ts";
import type { ReviewOutput } from "../build/review.ts";
import type { Deviation } from "../build/generate.ts";
import { updateStreaksAndDecide } from "../build/pivot.ts";
import { budgetExceeded, tokensExceeded, remainingBudget } from "../build/budget.ts";
import { recordDeviations, reconcilePlan } from "../build/reconcile.ts";
import { appendLearning, readMemory } from "../memory.ts";
import type { WorkItem } from "../build/types.ts";

/** Injectable seams so the build orchestration is testable without the SDK/git. */
export interface BuildDeps {
  ensureAutoProbed: typeof ensureAutoProbed;
  prepareWorkspace: typeof prepareWorkspace;
  decompose: typeof decompose;
  negotiateContract: typeof negotiateContract;
  generateItem: typeof generateItem;
  evaluateItem: typeof evaluateItem;
  reviewItem: typeof reviewItem;
  recordDeviations: typeof recordDeviations;
  reconcilePlan: typeof reconcilePlan;
  appendLearning: typeof appendLearning;
  readMemory: typeof readMemory;
  commitWork: typeof commitAll;
}

const defaultDeps: BuildDeps = {
  ensureAutoProbed,
  prepareWorkspace,
  decompose,
  negotiateContract,
  generateItem,
  evaluateItem,
  reviewItem,
  recordDeviations,
  reconcilePlan,
  appendLearning,
  readMemory,
  commitWork: commitAll,
};

/** Build a conventional commit message for an accepted item (deterministic, no LLM call). */
function commitMessage(item: WorkItem, deviations: Deviation[], runId: string): string {
  const subject = `feat: ${item.title.charAt(0).toLowerCase()}${item.title.slice(1)}`.replace(/\.\s*$/, "");
  const inScope = deviations.filter((d) => d.scope !== "out-of-scope");
  const lines = [item.summary.trim(), ...(inScope.length ? ["", ...inScope.map((d) => `- ${d.summary}`)] : [])].filter(Boolean);
  return `${subject}\n\n${lines.join("\n")}\n\nSparra-Item: ${item.id} · build ${runId}\n`;
}

function freshItemState(): ItemState {
  return { status: "pending", round: 0, pivots: 0, criterionFailStreak: {}, costUsd: 0, tokensUsed: 0 };
}

export async function cmdBuild(
  ctx: Ctx,
  opts: { fresh?: boolean; only?: string; workspaceOverride?: string; quiet?: boolean } = {},
  depOverrides: Partial<BuildDeps> = {}
): Promise<{ passed: number; failed: number; budgetExceeded: number; total: number; runId: string }> {
  const d: BuildDeps = { ...defaultDeps, ...depOverrides };
  banner("Phase C · AUTONOMOUS BUILD");
  const b = ctx.store.data;

  if (b.phase !== "frozen" && b.phase !== "build" && b.phase !== "done") {
    warn(`Build requires a frozen plan. Current phase: ${b.phase}. Run \`sparra freeze\` first.`);
    return { passed: 0, failed: 0, budgetExceeded: 0, total: 0, runId: "" };
  }
  if (!exists(ctx.paths.frozenPlan) && !exists(ctx.paths.plan)) {
    warn("No plan found to build from.");
    return { passed: 0, failed: 0, budgetExceeded: 0, total: 0, runId: "" };
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
  await d.ensureAutoProbed(ctx);

  if (!b.build.workspaceDir) {
    if (opts.workspaceOverride) {
      b.build.workspaceDir = opts.workspaceOverride;
      b.build.workspaceNote = `isolated workspace ${path.relative(ctx.root, opts.workspaceOverride)}`;
    } else {
      const ws = d.prepareWorkspace(ctx.root, ctx.config.git.strategy, ctx.config.git.branchPrefix, runId);
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

  // Warn on the classic "I re-froze but build did nothing" trap: the frozen plan changed,
  // but the run isn't being re-decomposed, so the old (already-passed) items are reused.
  const planText = (await readText(ctx.paths.frozenPlan)) ?? (await readText(ctx.paths.plan)) ?? "";
  const planHash = createHash("sha1").update(planText).digest("hex").slice(0, 12);
  if (!opts.fresh && exists(ctx.paths.workitemsFile) && b.build.lastBuiltPlanHash && b.build.lastBuiltPlanHash !== planHash) {
    warn("The frozen plan changed since these work items were decomposed.");
    info("Re-run with `sparra build --fresh` to rebuild from the new plan, or `sparra new` to start a fresh cycle. (Continuing with the existing items for now.)");
  }

  // Decompose (idempotent).
  const allItems = await d.decompose(ctx, traceDir, opts.fresh);
  b.build.lastBuiltPlanHash = planHash;
  await ctx.store.save();
  if (allItems.length === 0) {
    await ctx.store.transition("done", true);
    return { passed: 0, failed: 0, budgetExceeded: 0, total: 0, runId };
  }
  const items = opts.only ? allItems.filter((i) => i.id === opts.only) : allItems;

  const nextSeq = () => {
    b.build.traceSeq = (b.build.traceSeq ?? 0) + 1;
    return b.build.traceSeq;
  };

  let totalCost = 0;
  const cap = ctx.config.build.maxBudgetUsdPerItem; // 0 = unlimited (opt-out)
  const tokenCap = ctx.config.build.maxTokensPerItem; // 0 = unlimited (opt-out)
  const overBudget = (s: ItemState) => budgetExceeded(cap, s.costUsd ?? 0) || tokensExceeded(tokenCap, s.tokensUsed ?? 0);
  const stamp = () => new Date().toISOString();

  for (const item of items) {
    const st = (b.build.items[item.id] ??= freshItemState());
    if (st.costUsd == null) st.costUsd = 0;
    if (st.tokensUsed == null) st.tokensUsed = 0;
    if (st.status === "passed" || st.status === "abandoned" || st.status === "budget_exceeded") {
      detail(`${item.id} already ${st.status} — skipping.`);
      continue;
    }
    b.build.currentItem = item.id;

    step(`${item.id}: ${item.title}`);
    if (!depsSatisfied(item, b.build.items)) {
      warn(`${item.id} has unmet dependencies (${item.dependsOn.join(", ")}); attempting anyway.`);
    }

    // Prior cross-run learnings — read once per item, threaded into every role.
    const priorLearnings = await d.readMemory(ctx.paths);

    // Halt this item (not the run) when its accumulated cost OR tokens cross the cap.
    const haltOnBudget = async (phase: string): Promise<void> => {
      st.status = "budget_exceeded";
      await ctx.store.save();
      const which = tokensExceeded(tokenCap, st.tokensUsed ?? 0)
        ? `${st.tokensUsed} tokens ≥ cap ${tokenCap}`
        : `$${(st.costUsd ?? 0).toFixed(3)} ≥ cap $${cap}`;
      warn(`${item.id} halted on budget: ${which} (during ${phase}).`);
      await d.appendLearning(ctx.paths, {
        item: item.id,
        kind: "budget_exceeded",
        detail: `halted (${phase}) at ${which}; spent $${(st.costUsd ?? 0).toFixed(3)} / ${st.tokensUsed ?? 0} tokens; best score ${st.lastScore ?? 0} in ${st.round} round(s).`,
        at: stamp(),
      });
    };

    // 1) Negotiate the "done" contract.
    st.status = "contracting";
    await ctx.store.save();
    const contract = await d.negotiateContract(ctx, item, traceDir, nextSeq(), priorLearnings);
    // negotiateContract advanced the global seq via its own writes; bump our counter past it.
    b.build.traceSeq = (b.build.traceSeq ?? 0) + contract.tracesUsed;

    // 2) Generate ↔ evaluate loop with GAN pivots, bounded by the per-item budget.
    st.status = "building";
    let feedback: string | undefined;
    let fresh = false;
    let resumeSessionId = st.generatorSessionId;

    while (st.round < ctx.config.build.maxRoundsPerItem) {
      if (overBudget(st)) {
        await haltOnBudget("pre-round");
        break;
      }
      st.round += 1;
      const gen = await d.generateItem({
        ctx,
        item,
        contractText: contract.text,
        workspaceDir,
        traceDir,
        traceSeq: nextSeq(),
        feedback,
        resumeSessionId: fresh ? undefined : resumeSessionId,
        fresh,
        priorLearnings,
        maxBudgetUsd: remainingBudget(cap, st.costUsd ?? 0),
      });
      totalCost += gen.costUsd;
      st.costUsd = (st.costUsd ?? 0) + gen.costUsd;
      st.tokensUsed = (st.tokensUsed ?? 0) + gen.tokens;
      st.generatorSessionId = gen.sessionId;
      resumeSessionId = gen.sessionId;
      await ctx.store.save();

      // Sandbox-first backstop: whatever scoped the writes (Claude hooks / Codex
      // sandbox), verify nothing escaped the work scope into the repo. Harness-managed
      // paths are allowed; anything else is a real escape.
      const escapes = writeScopeViolations(changedFiles(ctx.root), [
        workspaceDir,
        ctx.paths.dir,
        ctx.paths.plan,
        ctx.paths.changelog,
        ctx.paths.proposals,
        ctx.paths.codebaseMap,
        ctx.paths.prototypes,
      ]);
      if (escapes.length) {
        warn(
          `${item.id}: ${escapes.length} write(s) ESCAPED the work scope: ${escapes.slice(0, 5).map((p) => path.relative(ctx.root, p)).join(", ")}${escapes.length > 5 ? ` …(+${escapes.length - 5})` : ""}`
        );
      }

      if (overBudget(st)) {
        await haltOnBudget("generate");
        break;
      }

      const dev = await d.recordDeviations(ctx, item, gen.deviations);

      const ev = await d.evaluateItem({
        ctx,
        item,
        contractText: contract.text,
        workspaceDir,
        round: st.round,
        traceDir,
        traceSeq: nextSeq(),
        priorLearnings,
        maxBudgetUsd: remainingBudget(cap, st.costUsd ?? 0),
      });
      totalCost += ev.costUsd;
      st.costUsd = (st.costUsd ?? 0) + ev.costUsd;
      st.tokensUsed = (st.tokensUsed ?? 0) + ev.tokens;
      st.lastScore = ev.verdict.weightedTotal;

      if (ev.verdict.verdict === "pass") {
        // Optional independent code-review gate on the (behaviorally passing) change.
        const review: ReviewOutput | null = ctx.config.review.enabled
          ? await d.reviewItem({
              ctx,
              item,
              contractText: contract.text,
              workspaceDir,
              round: st.round,
              traceDir,
              traceSeq: nextSeq(),
              maxBudgetUsd: remainingBudget(cap, st.costUsd ?? 0),
            })
          : null;
        if (review) {
          totalCost += review.costUsd;
          st.costUsd = (st.costUsd ?? 0) + review.costUsd;
          st.tokensUsed = (st.tokensUsed ?? 0) + review.tokens;
          await ctx.store.save();
        }

        if (!review || review.blocking.length === 0) {
          st.status = "passed";
          await ctx.store.save();
          await d.reconcilePlan(ctx, item, gen.deviations, traceDir, nextSeq());
          // Conventional commit of the accepted item — only onto the Sparra-created
          // branch/worktree (never your main branch), and only when opted in.
          if (ctx.config.git.autoCommit && b.build.branch) {
            const cr = d.commitWork(workspaceDir, commitMessage(item, gen.deviations, runId));
            detail(cr.ok ? `committed ${item.id} → ${b.build.branch}` : `commit skipped (${item.id}): ${cr.out.split("\n")[0]}`);
          }
          await d.appendLearning(ctx.paths, {
            item: item.id,
            kind: "passed",
            detail: `accepted in round ${st.round} (score ${ev.verdict.weightedTotal}${review ? ", code review clean" : ""}); $${(st.costUsd ?? 0).toFixed(3)} spent${st.pivots ? `, ${st.pivots} pivot(s)` : ""}.`,
            at: stamp(),
          });
          ok(`${item.id} accepted in round ${st.round} (score ${ev.verdict.weightedTotal}${review ? " + code review" : ""}). cumulative $${totalCost.toFixed(3)}`);
          break;
        }

        // Behaviorally passing but code review blocked → fail the round with review feedback.
        warn(`${item.id}: exercise passed but code review found ${review.blocking.length} blocking issue(s) in round ${st.round}.`);
        await d.appendLearning(ctx.paths, {
          item: item.id,
          kind: "failed",
          detail: `round ${st.round}: code review blocked — ${review.blocking.slice(0, 3).join("; ").slice(0, 200)}`,
          at: stamp(),
        });
        if (overBudget(st)) {
          await haltOnBudget("review");
          break;
        }
        if (st.round >= ctx.config.build.maxRoundsPerItem) break;
        feedback = `Your implementation runs and meets the contract, but an independent CODE REVIEW found blocking issues that must be fixed before it's accepted:\n${review.blocking.map((b) => `- ${b}`).join("\n")}`;
        fresh = false;
        continue;
      }

      const decision = updateStreaksAndDecide(st, ev.verdict, ctx.config);
      st.criterionFailStreak = decision.streaks;
      await ctx.store.save();

      if (overBudget(st)) {
        await haltOnBudget("evaluate");
        break;
      }
      if (st.round >= ctx.config.build.maxRoundsPerItem) break;

      if (decision.pivot) {
        st.pivots += 1;
        st.criterionFailStreak = {};
        fresh = true;
        resumeSessionId = undefined;
        feedback = `GAN PIVOT: this item stayed below ${ctx.config.pivot.threshold} on "${decision.criterion}" for ${ctx.config.pivot.N} rounds. Discard the previous approach entirely and rebuild from scratch with a fundamentally different design. Latest blocking issues: ${ev.verdict.blocking.join("; ") || ev.verdict.notes}`;
        warn(`${item.id}: GAN pivot on "${decision.criterion}" → restarting from scratch (pivot #${st.pivots}).`);
        await d.appendLearning(ctx.paths, {
          item: item.id,
          kind: "pivot",
          detail: `criterion "${decision.criterion}" stayed <${ctx.config.pivot.threshold} for ${ctx.config.pivot.N} rounds → rebuilt from scratch (pivot #${st.pivots}). Blocking: ${(ev.verdict.blocking.join("; ") || ev.verdict.notes || "n/a").slice(0, 200)}`,
          at: stamp(),
        });
      } else {
        fresh = false;
        feedback = `Address these blocking issues from the evaluator:\n${ev.verdict.blocking.map((x) => `- ${x}`).join("\n")}\nFailed assertions: ${ev.verdict.assertions.filter((a) => !a.pass).map((a) => `#${a.id}`).join(", ") || "(see verdict)"}`;
        detail(`${item.id}: patching for round ${st.round + 1}.`);
      }
      void dev;
    }

    // `haltOnBudget`/pass mutate st.status through a closure, which defeats TS's
    // flow narrowing here — read it back through the declared union.
    const finalStatus = st.status as ItemState["status"];
    if (finalStatus !== "passed" && finalStatus !== "budget_exceeded") {
      st.status = "failed";
      warn(`${item.id} did not pass within ${ctx.config.build.maxRoundsPerItem} rounds (best score ${st.lastScore ?? 0}).`);
      await d.appendLearning(ctx.paths, {
        item: item.id,
        kind: "failed",
        detail: `did not pass in ${ctx.config.build.maxRoundsPerItem} rounds; best score ${st.lastScore ?? 0}, ${st.pivots} pivot(s), $${(st.costUsd ?? 0).toFixed(3)} spent.`,
        at: stamp(),
      });
    }
    await ctx.store.save();
  }

  // Summary.
  const states = Object.values(b.build.items);
  const passed = states.filter((s) => s.status === "passed").length;
  const failed = states.filter((s) => s.status === "failed").length;
  const budgetHalted = states.filter((s) => s.status === "budget_exceeded").length;
  b.build.currentItem = undefined;
  await ctx.store.transition("done", true);

  banner("BUILD COMPLETE");
  ok(
    `${passed}/${items.length} items passed${failed ? `, ${failed} failed` : ""}${budgetHalted ? `, ${budgetHalted} over budget` : ""}. cumulative $${totalCost.toFixed(3)}`
  );
  for (const item of items) {
    const s = b.build.items[item.id];
    const mark =
      s?.status === "passed"
        ? color.green("✓")
        : s?.status === "failed"
        ? color.red("✗")
        : s?.status === "budget_exceeded"
        ? color.yellow("$")
        : color.yellow("•");
    detail(
      `${mark} ${item.id} ${item.title} — ${s?.status} (rounds ${s?.round}, pivots ${s?.pivots}, score ${s?.lastScore ?? "-"}, $${(s?.costUsd ?? 0).toFixed(3)}, ${s?.tokensUsed ?? 0} tok)`
    );
  }
  info(`traces:    ${path.relative(ctx.root, traceDir)}`);
  info(`changelog: ${path.relative(ctx.root, ctx.paths.changelog)}`);
  if (exists(ctx.paths.proposals)) info(`proposals: ${path.relative(ctx.root, ctx.paths.proposals)} (out-of-scope items for you)`);
  if (b.build.branch) {
    info(`Work is on branch ${color.bold(b.build.branch)} — Sparra did NOT commit to your main branch.`);
    detail(b.build.workspaceNote ?? "");
  }
  info("Review the work, then `sparra reflect` to improve the prompts from this run's traces.");

  return { passed, failed, budgetExceeded: budgetHalted, total: items.length, runId };
}

function depsSatisfied(item: WorkItem, items: Record<string, ItemState>): boolean {
  return item.dependsOn.every((d) => items[d]?.status === "passed");
}

/** Read frozen plan for callers that want a quick sanity check. */
export async function frozenPlanExists(ctx: Ctx): Promise<boolean> {
  return (await readText(ctx.paths.frozenPlan)) != null;
}
