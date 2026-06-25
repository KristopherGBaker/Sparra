import path from "node:path";
import type { Ctx } from "../context.ts";
import { banner, info, ok, warn } from "../util/log.ts";
import { exists, readText, writeText, stampFromDate } from "../util/io.ts";

/** Checkpoint PLAN.md (and CODEBASE_MAP.md) into a timestamped snapshot dir. */
export async function cmdSnapshot(ctx: Ctx): Promise<string> {
  const stamp = stampFromDate(new Date());
  const dir = path.join(ctx.paths.snapshots, stamp);
  const plan = await readText(ctx.paths.plan);
  if (plan != null) await writeText(path.join(dir, "PLAN.md"), plan);
  const map = await readText(ctx.paths.codebaseMap);
  if (map != null) await writeText(path.join(dir, "CODEBASE_MAP.md"), map);
  ok(`Snapshot saved: ${path.relative(ctx.root, dir)}`);
  return stamp;
}

/**
 * THE FREEZE GATE. This is the human's decision — there is no automated "plan is
 * done" check. It snapshots PLAN.md (+ CODEBASE_MAP.md) and copies them as the
 * frozen build input. The plan remains a strong PRIOR, not a literal contract.
 */
export async function cmdFreeze(ctx: Ctx): Promise<void> {
  banner("FREEZE GATE");
  if (!exists(ctx.paths.plan)) {
    warn("No PLAN.md to freeze. Run `sparra plan` first.");
    return;
  }
  const plan = await readText(ctx.paths.plan);
  if (!plan || plan.includes("_TBD") || plan.length < 200) {
    warn("PLAN.md looks thin (still has _TBD_ placeholders or is very short).");
    info("Freezing anyway — the plan is a prior, not a contract. (Ctrl-C now if that wasn't intended.)");
  }

  const snapshot = await cmdSnapshot(ctx);
  await writeText(ctx.paths.frozenPlan, plan ?? "");
  const map = await readText(ctx.paths.codebaseMap);
  if (map != null) await writeText(ctx.paths.frozenMap, map);
  // Evaluator-only holdout (isolation wall) — frozen alongside the plan if present.
  const holdout = await readText(ctx.paths.holdout);
  if (holdout != null) await writeText(ctx.paths.frozenHoldout, holdout);

  ctx.store.data.freeze = { frozenAt: new Date().toISOString(), snapshot };
  await ctx.store.transition("frozen", true);
  await ctx.store.save();

  ok(`Plan frozen as build input.`);
  info(`frozen plan: ${path.relative(ctx.root, ctx.paths.frozenPlan)}`);
  if (map != null) info(`frozen map:  ${path.relative(ctx.root, ctx.paths.frozenMap)}`);
  if (holdout != null) info(`frozen holdout: ${path.relative(ctx.root, ctx.paths.frozenHoldout)} (evaluator-only)`);
  info("Next: `sparra build` to start the autonomous generator/evaluator loop.");
}
