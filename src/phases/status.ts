import path from "node:path";
import type { Ctx } from "../context.ts";
import { banner, color, detail, info } from "../util/log.ts";
import { exists } from "../util/io.ts";

const NEXT: Record<string, string> = {
  init: "sparra orient   (existing) or   sparra plan   (greenfield)",
  orient: "sparra orient   → maps the codebase to CODEBASE_MAP.md",
  plan: "sparra plan   → collaborative interview; then  sparra freeze",
  prototype: "sparra plan / sparra prototype / sparra freeze",
  frozen: "sparra build   → start the autonomous generator/evaluator loop",
  build: "sparra build   → resume the autonomous build",
  done: "sparra reflect   → improve prompts;  or  sparra batch -k N",
};

export function cmdStatus(ctx: Ctx): void {
  const s = ctx.store.data;
  banner("sparra status");
  info(`mode:  ${color.bold(s.mode)}`);
  info(`phase: ${color.bold(s.phase)}`);
  detail(`created ${s.createdAt}  ·  updated ${s.updatedAt}`);

  detail(`CODEBASE_MAP.md: ${exists(ctx.paths.codebaseMap) ? "yes" : "—"}   PLAN.md: ${exists(ctx.paths.plan) ? "yes" : "—"}   frozen: ${s.freeze.frozenAt ? s.freeze.frozenAt : "—"}`);
  if (s.planning.turns) detail(`planning turns: ${s.planning.turns}`);

  const items = Object.entries(s.build.items);
  if (items.length) {
    process.stdout.write(`\n${color.bold("work items:")}\n`);
    for (const [id, it] of items) {
      const mark =
        it.status === "passed" ? color.green("✓") : it.status === "failed" ? color.red("✗") : it.status === "abandoned" ? color.gray("⊘") : color.yellow("•");
      detail(`${mark} ${id} — ${it.status} (round ${it.round}, pivots ${it.pivots}, score ${it.lastScore ?? "-"})`);
    }
    if (s.build.runId) detail(`run: ${s.build.runId}  traces: ${path.relative(ctx.root, ctx.paths.traceDir(s.build.runId))}`);
    if (s.build.branch) detail(`branch: ${s.build.branch}`);
  }

  process.stdout.write(`\n${color.bold("next:")} ${NEXT[s.phase] ?? "—"}\n`);
}
