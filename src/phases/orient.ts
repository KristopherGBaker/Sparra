import path from "node:path";
import type { Ctx } from "../context.ts";
import { newRunId } from "../context.ts";
import { loadPrompt } from "../prompts.ts";
import { runSession } from "../sdk/session.ts";
import type { RunResult, RunSessionParams } from "../sdk/session.ts";
import { singleFileGuard, ensureAutoProbed } from "../sdk/guard.ts";
import { banner, info, ok, warn } from "../util/log.ts";
import { exists } from "../util/io.ts";

export async function cmdOrient(
  ctx: Ctx,
  opts: { light?: boolean; runSessionFn?: (p: RunSessionParams) => Promise<RunResult> } = {}
): Promise<void> {
  banner("Phase 0 · ORIENT");
  if (ctx.store.data.mode === "greenfield" && !opts.light) {
    warn("Greenfield project — orient is normally skipped. Running a light pass over any scaffolding.");
    opts.light = true;
  }

  await ensureAutoProbed(ctx);
  const runId = newRunId("orient");
  const traceDir = ctx.paths.traceDir(runId);
  const role = ctx.config.roles.orienter;
  const system = await loadPrompt(ctx.paths, "orienter");

  const task = opts.light
    ? `This project is greenfield or lightly scaffolded. Do a LIGHT orientation: note any existing scaffolding, chosen tooling/manifests, and partial structure. Write CODEBASE_MAP.md at ${ctx.paths.codebaseMap} with a brief "Scaffolding present" summary. Keep it short; do not invent architecture that isn't there.`
    : `Map this existing codebase thoroughly and write the result to CODEBASE_MAP.md at ${ctx.paths.codebaseMap}. Root is ${ctx.root}. Follow the structure in your instructions exactly, cite file paths, and include the exact test command(s).`;

  info(`Mapping repository with ${role.model}…`);
  // The orienter reads the repo but must WRITE exactly one file (CODEBASE_MAP.md), so it runs under a
  // single-file writer guard (not read-only) with the Write/Edit tools scoped to that path — every
  // other write and any Bash mutation stays blocked.
  const run = opts.runSessionFn ?? runSession;
  const res = await run({
    role: "orienter",
    prompt: task,
    systemPrompt: system,
    backend: role.backend,
    model: role.model,
    effort: role.effort,
    cwd: ctx.root,
    tools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit"],
    ...singleFileGuard(ctx, ctx.paths.codebaseMap),
    maxTurns: ctx.config.build.maxTurnsPerSession,
    traceDir,
    traceSeq: 1,
  });

  await ctx.store.recordSession("orienter", res.sessionId);

  if (!exists(ctx.paths.codebaseMap)) {
    warn("Orienter finished but CODEBASE_MAP.md was not written. Check the trace:");
    info(path.relative(ctx.root, res.tracePath));
    return;
  }

  await ctx.store.transition("plan");
  ok(`CODEBASE_MAP.md written. (cost $${res.costUsd.toFixed(4)})`);
  info(`Trace: ${path.relative(ctx.root, res.tracePath)}`);
  info("Next: `sparra plan` — the interview will draw on CODEBASE_MAP.md.");
}
