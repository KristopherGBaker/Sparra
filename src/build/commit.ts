import path from "node:path";
import type { Ctx } from "../context.ts";
import type { WorkItem } from "./types.ts";
import type { Deviation } from "./generate.ts";
import { runSession, type RunSessionParams } from "../sdk/session.ts";
import type { RunResult } from "../sdk/session.ts";
import { loadPrompt } from "../prompts.ts";
import { readOnlyGuard } from "../sdk/guard.ts";
import { extractJsonWhere } from "../util/extract.ts";
import { changedFiles, workingDiff, commitPaths } from "../util/git.ts";
import { mergedBuildEnv } from "./env.ts";

/**
 * Commit an accepted item onto the Sparra branch. Two modes (config `git.agentCommits`):
 *  - "template" → one deterministic Conventional-Commit from the item's title/summary (no model).
 *  - "agent"    → the cheap `committer` role reads the diff and proposes one or more atomic
 *                 commits (split by logical change); the harness EXECUTES the plan (the model
 *                 never runs git) and appends a tracking trailer. Anything the plan misses is
 *                 swept into a final template commit, and any failure falls back to "template".
 * The committer is read-only and confined to the workspace — it never sees the holdout.
 */

const trailer = (item: WorkItem, runId: string): string => `Sparra-Item: ${item.id} · build ${runId}`;

/** A deterministic Conventional-Commit from the item metadata (no model). */
export function templateCommitMessage(item: WorkItem, deviations: Deviation[], runId: string): string {
  const subject = `feat: ${item.title.charAt(0).toLowerCase()}${item.title.slice(1)}`.replace(/\.\s*$/, "");
  const inScope = deviations.filter((d) => d.scope !== "out-of-scope");
  const lines = [item.summary.trim(), ...(inScope.length ? ["", ...inScope.map((d) => `- ${d.summary}`)] : [])].filter(Boolean);
  return `${subject}\n\n${lines.join("\n")}\n\n${trailer(item, runId)}\n`;
}

const withTrailer = (message: string, item: WorkItem, runId: string): string => {
  const t = trailer(item, runId);
  return message.includes(t) ? message.trim() + "\n" : `${message.trim()}\n\n${t}\n`;
};

/** Injectable git seam (real git by default; fakes in tests). */
export interface CommitGit {
  changedFiles: typeof changedFiles;
  workingDiff: typeof workingDiff;
  commitPaths: typeof commitPaths;
}
const realGit: CommitGit = { changedFiles, workingDiff, commitPaths };

export interface CommitItemArgs {
  item: WorkItem;
  deviations: Deviation[];
  runId: string;
  workspaceDir: string;
  traceDir: string;
  traceSeq: number;
  runSessionFn?: (p: RunSessionParams) => Promise<RunResult>;
  git?: Partial<CommitGit>;
}

export async function commitItem(ctx: Ctx, args: CommitItemArgs): Promise<{ ok: boolean; commits: number }> {
  const { item, deviations, runId, workspaceDir, traceDir, traceSeq } = args;
  const gi: CommitGit = { ...realGit, ...args.git };
  const run = args.runSessionFn ?? runSession;

  // Never include the holdout in the diff, the plan, or any commit — even if it's a changed
  // tracked file in the workspace (branch/inplace strategy). It's evaluator-only machinery.
  const holdoutRel = [ctx.paths.holdout, ctx.paths.frozenHoldout]
    .map((p) => path.relative(workspaceDir, p))
    .filter((p) => p && !p.startsWith(".."));
  const changed = gi
    .changedFiles(workspaceDir)
    .map((p) => path.relative(workspaceDir, p))
    .filter((f) => !holdoutRel.includes(f));
  if (!changed.length) return { ok: false, commits: 0 };

  // Single commit of all (non-holdout) changes from the item metadata — template mode + fallback.
  const commitAllChanged = (): { ok: boolean; commits: number } => {
    const cr = gi.commitPaths(workspaceDir, changed, templateCommitMessage(item, deviations, runId));
    return { ok: cr.ok, commits: cr.ok ? 1 : 0 };
  };

  if (ctx.config.git.agentCommits !== "agent") return commitAllChanged();

  // Ask the committer for a plan (read-only, confined to the workspace — no holdout, no git writes).
  let plan: { commits?: { message?: unknown; files?: unknown }[] } | null = null;
  try {
    const role = ctx.config.roles.committer;
    const task =
      `Item ${item.id}: ${item.title}\n${item.summary ? `Summary: ${item.summary}\n` : ""}` +
      `Changed files (${changed.length}):\n${changed.map((f) => `- ${f}`).join("\n")}\n\nDIFF:\n${gi.workingDiff(workspaceDir, 12000, holdoutRel)}\n\nProduce the commit plan now.`;
    const res = await run({
      role: "committer",
      systemPrompt: await loadPrompt(ctx.paths, "committer"),
      prompt: task,
      backend: role.backend,
      model: role.model,
      effort: role.effort,
      baseUrl: role.baseUrl,
      apiKey: role.apiKey,
      cwd: workspaceDir,
      env: mergedBuildEnv(ctx.config),
      // No tools: the diff is supplied inline, so the committer can't read anything off disk
      // (closes any .sparra/holdout read vector even when the workspace IS the repo root).
      tools: [],
      readOnly: true,
      ...readOnlyGuard(ctx),
      maxTurns: ctx.config.build.maxTurnsPerSession,
      maxBudgetUsd: ctx.config.build.maxBudgetUsdPerItem,
      traceDir,
      traceSeq,
    });
    plan = extractJsonWhere(res.resultText, (v) => v && Array.isArray((v as { commits?: unknown }).commits));
  } catch {
    plan = null;
  }

  const groups = (plan?.commits ?? []).filter(
    (c): c is { message: string; files: string[] } =>
      !!c && typeof c.message === "string" && Array.isArray(c.files) && (c.files as unknown[]).every((f) => typeof f === "string")
  );
  if (!groups.length) return commitAllChanged();

  // Execute the plan deterministically — only files that actually changed, each once.
  const changedSet = new Set(changed);
  const committed = new Set<string>();
  let n = 0;
  for (const g of groups) {
    const files = g.files.filter((f) => changedSet.has(f) && !committed.has(f));
    if (!files.length) continue;
    const cr = gi.commitPaths(workspaceDir, files, withTrailer(g.message, item, runId));
    if (cr.ok) {
      n++;
      files.forEach((f) => committed.add(f));
    }
  }

  // Sweep anything the plan missed or failed to commit into a final template commit (lose nothing).
  const leftover = changed.filter((f) => !committed.has(f));
  if (leftover.length) {
    const cr = gi.commitPaths(workspaceDir, leftover, templateCommitMessage(item, deviations, runId));
    if (cr.ok) n++;
  }
  return { ok: n > 0, commits: n };
}
