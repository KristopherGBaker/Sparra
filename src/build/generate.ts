import type { Ctx } from "../context.ts";
import { fill, loadPrompt } from "../prompts.ts";
import { runSession } from "../sdk/session.ts";
import type { RunResult, RunSessionParams } from "../sdk/session.ts";
import type { LimitHit } from "../sdk/backend.ts";
import { scopedWriterGuard } from "../sdk/guard.ts";
import { skillsForRole } from "../sdk/skills.ts";
import { budgetExceeded } from "./budget.ts";
import type { AssertionClaim } from "./claims.ts";
import { extractAllJson, extractJsonWhere } from "../util/extract.ts";
import { readText } from "../util/io.ts";
import { info, warn } from "../util/log.ts";
import { readMemory, memorySection } from "../memory.ts";
import { readHoldout, assertNoHoldoutLeak, makeHoldoutReadDecider } from "./holdout.ts";
import { appleConventions, isApplePlatform } from "./swiftConventions.ts";
import { deviationPolicy, selfVerifyGuidance } from "./modeText.ts";
import type { WorkItem } from "./types.ts";
import type { RoleConfig } from "../config.ts";
import { buildReadDirs } from "./readscope.ts";
import { gateSandbox } from "./sandbox.ts";

export interface Deviation {
  summary: string;
  rationale: string;
  scope: "in-scope" | "out-of-scope";
}
export interface GenerateOutput {
  report: string;
  deviations: Deviation[];
  /** Per-assertion self-claims from the report JSON; diffed against the evaluator's verdict
   *  (build/claims.ts) to surface the generator's calibration gap. Absent when omitted. */
  assertionsClaimed?: AssertionClaim[];
  sessionId: string;
  hitMaxTurns: boolean;
  /** Set when the session failed on a provider rate/usage limit — the build loop waits + retries. */
  limitHit?: LimitHit;
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
  /** Rendered "PRIOR ATTEMPTS" ledger section (build/attempts.ts) — injected into the task
   *  ONLY on a fresh (pivot) restart, so the new approach can't repeat a failed one. Built
   *  solely from redacted Verdict fields + the generator's own reports (no holdout path). */
  priorAttempts?: string;
  /** Prior learnings to inject (from .sparra/memory.md). Falls back to reading the file. */
  priorLearnings?: string;
  /** Per-session USD budget (remaining item budget). Defaults to the per-item cap. */
  maxBudgetUsd?: number;
  /** Generator role to use; defaults to `roles.generator`. The build loop passes
   * `roles.generatorLocal` for items tagged `gen: "local"` (hybrid builds). */
  role?: RoleConfig;
  /** Injectable for tests; defaults to the real SDK session. */
  runSessionFn?: (p: RunSessionParams) => Promise<RunResult>;
}): Promise<GenerateOutput> {
  const { ctx, item, contractText, workspaceDir } = args;
  const role = args.role ?? ctx.config.roles.generator;
  const run = args.runSessionFn ?? runSession;
  const system = fill(await loadPrompt(ctx.paths, "generator"), {
    MODE: ctx.store.data.mode,
    DEVIATION: ctx.config.deviation.strictness,
    DEVIATION_POLICY: deviationPolicy(ctx),
    SELF_VERIFY: selfVerifyGuidance(ctx),
  });
  const map = await readText(ctx.paths.frozenMap);
  const memory = memorySection(args.priorLearnings ?? (await readMemory(ctx.paths)));
  const conventions = isApplePlatform(ctx) ? `\n${appleConventions(ctx.config.exercise.ios.platform)}\n` : "";

  const task = `Implement work item ${item.id}: ${item.title}

Build into: ${workspaceDir}

AGREED CONTRACT (your spec — satisfy every assertion):
---
${contractText}
---
${map ? `CODEBASE_MAP (conform to these conventions; do not regress existing behavior):\n---\n${map.slice(0, 5000)}\n---\n` : ""}${conventions}${memory}${args.feedback ? `\nThe adversarial evaluator REJECTED the previous attempt. Fix exactly these blocking issues:\n${args.feedback}\n` : ""}${args.fresh ? `\nThis item is being RESTARTED FROM SCRATCH after repeated failures on the same criterion. Take a genuinely different approach; do not just patch the old one.\n${args.priorAttempts ? `\n${args.priorAttempts}\n` : ""}` : ""}`;

  // Isolation wall: the builder must never see the evaluator's holdout checks — not in its prompt
  // (assertNoHoldoutLeak) NOR off disk. The read-scope drops any holdout-bearing dir and the
  // deny-hook blocks a Read/Bash of the holdout/.sparra, matching the interactive role-runner.
  assertNoHoldoutLeak("generator", task, await readHoldout(ctx));
  const genReadDirs = buildReadDirs(ctx, workspaceDir, { excludeHoldoutScope: true });

  info(`Generating ${item.id} with ${role.model}${args.fresh ? " (fresh restart)" : args.resumeSessionId ? " (resumed)" : ""}…`);
  const baseReq: RunSessionParams = {
    role: `generator-${item.id}`,
    prompt: task,
    systemPrompt: system,
    backend: role.backend,
    model: role.model,
    effort: role.effort,
    baseUrl: role.baseUrl,
    apiKey: role.apiKey,
    cwd: workspaceDir,
    additionalDirectories: genReadDirs,
    tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
    skills: skillsForRole(ctx, "generator"),
    // Native-sandbox intent (Codex honors it; Claude ignores it). danger-full-access is
    // gated to a git worktree/branch boundary — the only safety wall on an autonomous run.
    sandbox: gateSandbox({
      requested: role.sandbox,
      hasBranch: !!ctx.store.data.build.branch,
      roleLabel: `generator-${item.id}`,
    }),
    ...scopedWriterGuard(ctx, [workspaceDir], {
      format: true,
      verify: true,
      readScopes: [workspaceDir, ...(genReadDirs ?? [])],
      extraDeny: [makeHoldoutReadDecider(ctx, workspaceDir)],
    }),
    resume: args.fresh ? undefined : args.resumeSessionId,
    maxTurns: ctx.config.build.maxTurnsPerSession,
    maxBudgetUsd: args.maxBudgetUsd ?? ctx.config.build.maxBudgetUsdPerItem,
    traceDir: args.traceDir,
    traceSeq: args.traceSeq,
  };
  const res = await run(baseReq);
  let costUsd = res.costUsd;
  let tokens = res.tokens;

  type Report = { report?: string; deviations?: Deviation[]; assertionsClaimed?: AssertionClaim[] };
  const isReport = (v: any) => v && typeof v === "object" && ("report" in v || "deviations" in v);
  let parsed = extractJsonWhere<Report>(res.resultText, isReport);

  // JSON re-ask (build.jsonReask): ONLY when the reply has no parseable JSON at all — a JSON
  // block of the wrong shape goes straight to today's degraded fallback ("re-emit the JSON
  // block" can't fix a block that was already emitted). ONE resumed re-emit call inside this
  // step; never on a provider-limit reply (the round loop's fallback chain owns those), and
  // skipped when this session already exhausted the item budget.
  const itemBudget = args.maxBudgetUsd ?? ctx.config.build.maxBudgetUsdPerItem;
  const noJson = extractAllJson(res.resultText).length === 0;
  if (!parsed && noJson && !res.limitHit && ctx.config.build.jsonReask && !budgetExceeded(itemBudget, costUsd)) {
    warn(`Generator for ${item.id} returned no parseable report JSON — re-asking once for the JSON block.`);
    const retry = await run({
      ...baseReq,
      role: `generator-${item.id}-reask`,
      prompt: "Your previous reply had no parseable report JSON. Re-emit ONLY the JSON block per your instructions — nothing else.",
      resume: res.sessionId,
    });
    costUsd += retry.costUsd;
    tokens += retry.tokens;
    parsed = extractJsonWhere<Report>(retry.resultText, isReport);
  }

  const p = parsed ?? {};
  const deviations = Array.isArray(p.deviations) ? p.deviations : [];
  return {
    report: p.report ?? res.resultText.slice(0, 500),
    deviations,
    assertionsClaimed: Array.isArray(p.assertionsClaimed) ? p.assertionsClaimed : undefined,
    sessionId: res.sessionId,
    hitMaxTurns: res.hitMaxTurns,
    limitHit: res.limitHit,
    costUsd,
    tokens,
  };
}
