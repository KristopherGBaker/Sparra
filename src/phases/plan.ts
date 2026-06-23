import path from "node:path";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Ctx } from "../context.ts";
import { newRunId } from "../context.ts";
import { fill, loadPrompt } from "../prompts.ts";
import { runSession } from "../sdk/session.ts";
import { resolvePermissionMode, plannerWriteScope } from "../sdk/permissions.ts";
import { banner, color, info, ok, detail } from "../util/log.ts";
import { exists } from "../util/io.ts";
import { cmdSnapshot } from "./freeze.ts";

const HELP = `Planning commands:
  (type normally)   answer the planner / give direction
  /snapshot         checkpoint PLAN.md to .sparra/snapshots/
  /freeze           freeze the plan as build input (then run \`sparra build\`)
  /exit  /quit      leave the interview (resume later with \`sparra plan\`)
  /help             show this`;

export async function cmdPlan(ctx: Ctx): Promise<void> {
  banner("Phase A · COLLABORATIVE PLANNING");
  if (ctx.store.data.phase === "orient") {
    info("Orientation not yet run; planning anyway. (Run `sparra orient` for a codebase map.)");
  }
  if (ctx.store.canTransition("plan")) await ctx.store.transition("plan").catch(() => {});

  const role = ctx.config.roles.planner;
  const system = fill(await loadPrompt(ctx.paths, "planner"), { MODE: ctx.store.data.mode });
  const runId = newRunId("plan");
  const traceDir = ctx.paths.traceDir(runId);
  const canUse = plannerWriteScope(ctx.paths.plan, ctx.config.permission.denyBashContains);

  const resuming = !!ctx.store.data.planning.sessionId;
  info(`Planner: ${color.bold(role.model)}${role.effort ? ` (effort ${role.effort})` : ""}`);
  detail(resuming ? "Resuming previous planning session." : "Starting a new planning session.");
  detail(HELP);
  process.stdout.write("\n");

  const rl = readline.createInterface({ input: stdin, output: stdout });
  let seq = ctx.store.data.planning.turns;
  let sessionId = ctx.store.data.planning.sessionId;

  // The first turn auto-kicks the interview; subsequent turns are human-led.
  let pending: string | null = resuming
    ? null
    : `Begin the planning interview. Read PLAN.md${exists(ctx.paths.codebaseMap) ? " and CODEBASE_MAP.md" : ""} first, then ask me your single most important opening question — with your recommended answer.`;

  try {
    while (true) {
      if (pending == null) {
        const answer = (await rl.question(color.green("you › "))).trim();
        if (answer === "") continue;
        if (answer === "/help") {
          detail(HELP);
          continue;
        }
        if (answer === "/exit" || answer === "/quit") {
          info("Leaving the interview. Plan is preserved; resume with `sparra plan`.");
          break;
        }
        if (answer === "/snapshot") {
          await cmdSnapshot(ctx);
          continue;
        }
        if (answer === "/freeze") {
          rl.close();
          const { cmdFreeze } = await import("./freeze.ts");
          await cmdFreeze(ctx);
          return;
        }
        pending = answer;
      }

      seq += 1;
      process.stdout.write(color.cyan("\nplanner › "));
      const res = await runSession({
        role: "planner",
        prompt: pending,
        systemPrompt: system,
        model: role.model,
        effort: role.effort,
        cwd: ctx.root,
        tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
        permissionMode: resolvePermissionMode("default"),
        canUseTool: canUse,
        resume: sessionId,
        maxTurns: ctx.config.build.maxTurnsPerSession,
        traceDir,
        traceSeq: seq,
        onAssistantText: (t) => process.stdout.write(t),
      });
      process.stdout.write("\n\n");

      sessionId = res.sessionId || sessionId;
      ctx.store.data.planning.sessionId = sessionId;
      ctx.store.data.planning.turns = seq;
      await ctx.store.save();
      pending = null;

      if (!res.ok && res.errors.length) detail(color.gray(`(session ${res.subtype}; you can keep going)`));
    }
  } finally {
    rl.close();
  }

  ok("Planning session saved.");
  info("When satisfied: `sparra snapshot` to checkpoint, `sparra freeze` to lock in build input.");
}
