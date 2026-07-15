import path from "node:path";
import type { Ctx } from "../context.ts";
import { newRunId } from "../context.ts";
import { fill, loadPrompt } from "../prompts.ts";
import { runSession } from "../sdk/session.ts";
import type { RunResult, RunSessionParams } from "../sdk/session.ts";
import { plannerWriteScope } from "../sdk/permissions.ts";
import { scopedWriterGuard, ensureAutoProbed } from "../sdk/guard.ts";
import { skillsForRole } from "../sdk/skills.ts";
import { banner, info, ok, warn, detail } from "../util/log.ts";
import { ensureDir, exists, readText } from "../util/io.ts";
import { isGitRepo, hasCommits, prepareWorkspace, pullUpstream } from "../util/git.ts";
import { mergedBuildEnv } from "../build/env.ts";
import { environmentNotesSection } from "../environment.ts";

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "proto";
}

export async function cmdPrototype(
  ctx: Ctx,
  idea: string,
  opts: {
    runSessionFn?: (p: RunSessionParams) => Promise<RunResult>;
    /** Injectable seam (real `pullUpstream` by default), mirroring `BuildDeps.pullUpstream`. */
    pullUpstream?: typeof pullUpstream;
  } = {}
): Promise<void> {
  banner("Phase B · PROTOTYPE (throwaway, for learning)");
  if (!idea.trim()) {
    warn('Describe what to explore, e.g. `sparra prototype "try SQLite vs JSON file for storage"`');
    return;
  }
  await ensureAutoProbed(ctx);
  const name = `${slug(idea)}-${newRunId("").replace(/^-/, "")}`;
  const isExisting = ctx.store.data.mode === "existing";

  // Isolation: greenfield → prototypes/<name>; existing+git → sibling worktree.
  let protoDir: string;
  let note: string;
  if (isExisting && isGitRepo(ctx.root) && hasCommits(ctx.root)) {
    // Opt-in (`git.pullBeforeWork`): ff-only sync BEFORE cutting the prototype worktree. Non-fatal.
    if (ctx.config.git.pullBeforeWork) {
      const pull = (opts.pullUpstream ?? pullUpstream)(ctx.root);
      detail(`upstream pull: ${pull.note}`);
    }
    const ws = prepareWorkspace(ctx.root, "worktree", "sparra-proto/", name);
    protoDir = ws.dir;
    note = ws.note;
  } else {
    protoDir = path.join(ctx.paths.prototypes, name);
    await ensureDir(protoDir);
    note = `isolated prototype dir ${path.relative(ctx.root, protoDir)}`;
  }
  info(note);

  const role = ctx.config.roles.prototyper;
  const system = await loadPrompt(ctx.paths, "prototyper");
  const runId = newRunId("prototype");
  const traceDir = ctx.paths.traceDir(runId);

  const planText = (await readText(ctx.paths.plan)) ?? "";
  const environment = await environmentNotesSection(ctx.paths);
  const task = `Explore this question with a throwaway prototype: "${idea}"

Work ONLY inside: ${protoDir}
${environment}
${isExisting ? `This is an existing project; you may read the real repo at ${ctx.root} for reference, but write only inside the prototype workspace.\n` : ""}
Current PLAN.md (context, for orientation):
---
${planText.slice(0, 4000)}
---
Build the smallest thing that answers the question, then write FINDINGS.md in the prototype directory.`;

  info(`Prototyping with ${role.model}…`);
  const run = opts.runSessionFn ?? runSession;
  const res = await run({
    role: "prototyper",
    prompt: task,
    systemPrompt: system,
    backend: role.backend,
    model: role.model,
    effort: role.effort,
    cwd: protoDir,
    additionalDirectories: isExisting ? [ctx.root] : undefined,
    tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
    env: mergedBuildEnv(ctx.config),
    skills: skillsForRole(ctx, "prototyper"),
    ...scopedWriterGuard(ctx, [protoDir]),
    maxTurns: ctx.config.build.maxTurnsPerSession,
    traceDir,
    traceSeq: 1,
  });
  await ctx.store.recordSession("prototyper", res.sessionId);
  if (ctx.store.canTransition("prototype")) await ctx.store.transition("prototype").catch(() => {});

  const findings = path.join(protoDir, "FINDINGS.md");
  ok(`Prototype done. (cost $${res.costUsd.toFixed(4)})`);
  if (exists(findings)) {
    info(`Findings: ${path.relative(ctx.root, findings)}`);
    detail(`Log into the plan with: sparra log-finding "${path.relative(ctx.root, findings)}"`);
  } else {
    warn("No FINDINGS.md was written — check the trace: " + path.relative(ctx.root, res.tracePath));
  }
  info("Prototypes are discarded by default; promoting code into the real build is a deliberate step.");
}

/** Integrate prototype findings back into PLAN.md (writes only PLAN.md). */
export async function cmdLogFinding(ctx: Ctx, findingPath?: string): Promise<void> {
  banner("Log prototype findings → PLAN.md");
  let fp = findingPath;
  if (fp && !path.isAbsolute(fp)) fp = path.resolve(ctx.root, fp);
  const findings = fp ? await readText(fp) : null;
  if (!findings) {
    warn(`Could not read findings file${fp ? ` at ${fp}` : ""}. Pass the path: sparra log-finding <FINDINGS.md>`);
    return;
  }

  const role = ctx.config.roles.planner;
  const system = fill(await loadPrompt(ctx.paths, "planner"), { MODE: ctx.store.data.mode });
  const runId = newRunId("logfinding");
  const traceDir = ctx.paths.traceDir(runId);

  const task = `New prototype findings are available. WITHOUT asking me any questions, integrate the LEARNINGS into PLAN.md at ${ctx.paths.plan}: update Approach / Risks & unknowns / Open questions / Constraints as warranted. Do not paste the prototype code; capture the decisions and what we learned. Edit only PLAN.md.

FINDINGS:
---
${findings.slice(0, 8000)}
---`;

  info("Integrating findings (planner, no questions)…");
  const res = await runSession({
    role: "planner",
    prompt: task,
    systemPrompt: system,
    backend: role.backend,
    model: role.model,
    effort: role.effort,
    cwd: ctx.root,
    tools: ["Read", "Edit", "Write"],
    permissionMode: "default",
    canUseTool: plannerWriteScope(ctx.paths.plan, ctx.config.permission.denyBashContains),
    maxTurns: ctx.config.build.maxTurnsPerSession,
    traceDir,
    traceSeq: 1,
  });
  ok(`PLAN.md updated with findings. (cost $${res.costUsd.toFixed(4)})`);
  info("Continue refining with `sparra plan`, or `sparra freeze` when satisfied.");
}
