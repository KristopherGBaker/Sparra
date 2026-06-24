import type { Ctx } from "../context.ts";
import { fill, loadPrompt } from "../prompts.ts";
import { runSession } from "../sdk/session.ts";
import type { RunResult, RunSessionParams } from "../sdk/session.ts";
import { scopedWriterGuard } from "../sdk/guard.ts";
import { extractJsonWhere } from "../util/extract.ts";
import { readText } from "../util/io.ts";
import { info } from "../util/log.ts";
import { readMemory, memorySection } from "../memory.ts";
import { deviationPolicy } from "./modeText.ts";
import type { WorkItem } from "./types.ts";

export interface Deviation {
  summary: string;
  rationale: string;
  scope: "in-scope" | "out-of-scope";
}
export interface GenerateOutput {
  report: string;
  deviations: Deviation[];
  sessionId: string;
  hitMaxTurns: boolean;
  costUsd: number;
  tokens: number;
}

/**
 * Run the generator on one item against the agreed contract, building into
 * workspaceDir. `feedback` carries the evaluator's blocking notes when patching;
 * `resumeSessionId` continues a session that hit the turn cap.
 */
export async function generateItem(args: {
  ctx: Ctx;
  item: WorkItem;
  contractText: string;
  workspaceDir: string;
  traceDir: string;
  traceSeq: number;
  feedback?: string;
  resumeSessionId?: string;
  fresh?: boolean; // GAN restart: start a new session ignoring prior context
  /** Prior learnings to inject (from .sparra/memory.md). Falls back to reading the file. */
  priorLearnings?: string;
  /** Per-session USD budget (remaining item budget). Defaults to the per-item cap. */
  maxBudgetUsd?: number;
  /** Injectable for tests; defaults to the real SDK session. */
  runSessionFn?: (p: RunSessionParams) => Promise<RunResult>;
}): Promise<GenerateOutput> {
  const { ctx, item, contractText, workspaceDir } = args;
  const role = ctx.config.roles.generator;
  const run = args.runSessionFn ?? runSession;
  const system = fill(await loadPrompt(ctx.paths, "generator"), {
    MODE: ctx.store.data.mode,
    DEVIATION: ctx.config.deviation.strictness,
    DEVIATION_POLICY: deviationPolicy(ctx),
  });
  const map = await readText(ctx.paths.frozenMap);
  const memory = memorySection(args.priorLearnings ?? (await readMemory(ctx.paths)));

  const task = `Implement work item ${item.id}: ${item.title}

Build into: ${workspaceDir}

AGREED CONTRACT (your spec — satisfy every assertion):
---
${contractText}
---
${map ? `CODEBASE_MAP (conform to these conventions; do not regress existing behavior):\n---\n${map.slice(0, 5000)}\n---\n` : ""}${memory}${args.feedback ? `\nThe adversarial evaluator REJECTED the previous attempt. Fix exactly these blocking issues:\n${args.feedback}\n` : ""}${args.fresh ? `\nThis item is being RESTARTED FROM SCRATCH after repeated failures on the same criterion. Take a genuinely different approach; do not just patch the old one.\n` : ""}`;

  info(`Generating ${item.id} with ${role.model}${args.fresh ? " (fresh restart)" : args.resumeSessionId ? " (resumed)" : ""}…`);
  const res = await run({
    role: `generator-${item.id}`,
    prompt: task,
    systemPrompt: system,
    model: role.model,
    effort: role.effort,
    cwd: workspaceDir,
    additionalDirectories: workspaceDir !== ctx.root ? [ctx.root] : undefined,
    tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
    ...scopedWriterGuard(ctx, [workspaceDir], { format: true }),
    resume: args.fresh ? undefined : args.resumeSessionId,
    maxTurns: ctx.config.build.maxTurnsPerSession,
    maxBudgetUsd: args.maxBudgetUsd ?? ctx.config.build.maxBudgetUsdPerItem,
    traceDir: args.traceDir,
    traceSeq: args.traceSeq,
  });

  const parsed =
    extractJsonWhere<{ report?: string; deviations?: Deviation[] }>(
      res.resultText,
      (v) => v && typeof v === "object" && ("report" in v || "deviations" in v)
    ) ?? {};
  const deviations = Array.isArray(parsed.deviations) ? parsed.deviations : [];
  return {
    report: parsed.report ?? res.resultText.slice(0, 500),
    deviations,
    sessionId: res.sessionId,
    hitMaxTurns: res.hitMaxTurns,
    costUsd: res.costUsd,
    tokens: res.tokens,
  };
}
