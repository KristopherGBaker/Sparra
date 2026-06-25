import type { Ctx } from "../context.ts";
import { loadPrompt } from "../prompts.ts";
import { runSession } from "../sdk/session.ts";
import type { RunResult, RunSessionParams } from "../sdk/session.ts";
import { readOnlyGuard } from "../sdk/guard.ts";
import { extractJsonWhere } from "../util/extract.ts";
import { readText, writeText } from "../util/io.ts";
import { info, ok, warn } from "../util/log.ts";
import { appleConventions, isApplePlatform } from "./swiftConventions.ts";
import type { WorkItem } from "./types.ts";

export interface Finding {
  severity: "blocking" | "advisory";
  file: string;
  line?: number;
  issue: string;
  why: string;
  fix?: string;
}

export interface ReviewOutput {
  findings: Finding[];
  /** Findings that BLOCK acceptance, per config.review.blockOn (formatted one-liners). */
  blocking: string[];
  /** Non-blocking findings (formatted one-liners). */
  advisory: string[];
  raw: string;
  sessionId: string;
  costUsd: number;
  tokens: number;
}

/** Does this finding block acceptance under the configured policy? */
function enforced(f: Finding, blockOn: Ctx["config"]["review"]["blockOn"]): boolean {
  if (blockOn === "none") return false;
  if (blockOn === "all") return true;
  return f.severity === "blocking";
}

function oneLine(f: Finding): string {
  const loc = f.line ? `${f.file}:${f.line}` : f.file;
  return `${loc} — ${f.issue}${f.fix ? ` → ${f.fix}` : ""}`;
}

/**
 * The independent code-review gate. Runs AFTER an item passes the behavioral evaluator,
 * reading the diff/source for what the exerciser can't see — security, dead code,
 * structure, convention conformance. Read-only; a separate role (ideally a different
 * backend than the generator) for genuine second eyes. Opt-in via config.review.enabled.
 */
export async function reviewItem(args: {
  ctx: Ctx;
  item: WorkItem;
  contractText: string;
  workspaceDir: string;
  round: number;
  traceDir: string;
  traceSeq: number;
  maxBudgetUsd?: number;
  runSessionFn?: (p: RunSessionParams) => Promise<RunResult>;
}): Promise<ReviewOutput> {
  const { ctx, item, contractText, workspaceDir, round } = args;
  const role = ctx.config.roles.reviewer;
  const run = args.runSessionFn ?? runSession;
  const system = await loadPrompt(ctx.paths, "reviewer");
  const map = await readText(ctx.paths.frozenMap);

  const conventions =
    (map ? `CONVENTIONS (CODEBASE_MAP — the change must conform to these):\n---\n${map.slice(0, 5000)}\n---\n` : "") +
    (isApplePlatform(ctx) ? `APPLE/SWIFT HOUSE CONVENTIONS the code should follow:\n---\n${appleConventions()}\n---\n` : "");

  const task = `Code-review work item ${item.id}: ${item.title} (round ${round}).

The change is in: ${workspaceDir}
Review the diff (\`git diff\` if it's a repo) or the generated source there.

It already PASSED behavioral evaluation against this contract (context, not a re-test):
---
${contractText}
---
${conventions}Review for substance per your instructions and emit the JSON findings block. Clean code → empty findings.`;

  info(`Code-reviewing ${item.id} (round ${round}) with ${role.model}…`);
  const res = await run({
    role: `reviewer-${item.id}-r${round}`,
    prompt: task,
    systemPrompt: system,
    backend: role.backend,
    model: role.model,
    effort: role.effort,
    cwd: workspaceDir,
    additionalDirectories: workspaceDir !== ctx.root ? [ctx.root] : undefined,
    tools: ["Read", "Glob", "Grep", "Bash"],
    ...readOnlyGuard(ctx),
    maxTurns: ctx.config.build.maxTurnsPerSession,
    maxBudgetUsd: args.maxBudgetUsd ?? ctx.config.build.maxBudgetUsdPerItem,
    traceDir: args.traceDir,
    traceSeq: args.traceSeq,
  });

  const parsed = extractJsonWhere<{ findings?: Finding[] }>(
    res.resultText,
    (v) => v && typeof v === "object" && "findings" in v
  );
  const findings: Finding[] = Array.isArray(parsed?.findings)
    ? parsed!.findings.filter((f) => f && typeof f === "object" && f.issue)
    : [];

  const blockOn = ctx.config.review.blockOn;
  const blocking = findings.filter((f) => enforced(f, blockOn)).map(oneLine);
  const advisory = findings.filter((f) => !enforced(f, blockOn)).map(oneLine);

  await writeText(
    ctx.paths.reviewFile(item.id, round),
    `# Code review — ${item.id} round ${round}\n\n- findings: **${findings.length}** (blocking: ${blocking.length}, advisory: ${advisory.length}); blockOn=${blockOn}\n\n## Blocking\n${blocking.map((b) => `- ${b}`).join("\n") || "_none_"}\n\n## Advisory\n${advisory.map((a) => `- ${a}`).join("\n") || "_none_"}\n\n---\n\n<details><summary>raw reviewer output</summary>\n\n${res.resultText}\n\n</details>\n`
  );

  if (blocking.length) warn(`${item.id} code review: ${blocking.length} blocking, ${advisory.length} advisory.`);
  else ok(`${item.id} code review clean${advisory.length ? ` (${advisory.length} advisory)` : ""}.`);

  return { findings, blocking, advisory, raw: res.resultText, sessionId: res.sessionId, costUsd: res.costUsd, tokens: res.tokens };
}
