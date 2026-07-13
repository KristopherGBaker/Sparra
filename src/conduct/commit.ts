import path from "node:path";

import type { Ctx } from "../context.ts";
import { runSession, type RunResult, type RunSessionParams } from "../sdk/session.ts";
import { loadPrompt } from "../prompts.ts";
import { readOnlyGuard } from "../sdk/guard.ts";
import { extractJsonWhere } from "../util/extract.ts";
import { changedFiles, workingDiff, commitPaths, revParse } from "../util/git.ts";
import { mergedBuildEnv } from "../build/env.ts";

/**
 * `src/conduct/commit.ts` — commit an ACCEPTED conduct unit's worktree WIP onto its own
 * `sparra/<name>` unit branch, MIRRORING `src/build/commit.ts` `commitItem`:
 *  - `git.agentCommits: "template"` → one deterministic Conventional-Commit from the unit's
 *    title/summary (NO model — a fake role-runner proves no committer session runs).
 *  - `git.agentCommits: "agent"`    → the cheap `committer` role reads the diff (supplied inline,
 *    no disk tools) and proposes atomic commits; the harness EXECUTES the plan (the model never
 *    runs git), and anything the plan misses is swept into a final template commit; any failure
 *    falls back to `template`.
 *
 * The commit message carries the unit's SCORE and the conduct `runId` (provenance), and the holdout
 * path is excluded from the diff/plan/commit exactly as `commitItem` does. The committer is
 * read-only and confined to the unit worktree — it never sees the holdout.
 */

/** The unit metadata a commit is authored from (a subset of `UnitStateEntry`, so callers pass the
 *  entry directly). */
export interface CommitUnitMeta {
  id: string;
  title: string;
  /** Final evaluator weighted score (embedded in the message + trailer). Absent → omitted. */
  score?: number;
  /** Optional one-line summary (the unit's brief title line); shown in the commit body. */
  summary?: string;
}

/** The conduct commit trailer: unit id + conduct run + score (distinct from build's `Sparra-Item`). */
export function conductTrailer(unit: CommitUnitMeta, runId: string): string {
  const score = unit.score !== undefined ? ` · score ${unit.score}` : "";
  return `Sparra-Unit: ${unit.id} · conduct ${runId}${score}`;
}

/** A deterministic Conventional-Commit message from the unit metadata (no model). */
export function templateUnitCommitMessage(unit: CommitUnitMeta, runId: string): string {
  const subject = `feat: ${unit.title.charAt(0).toLowerCase()}${unit.title.slice(1)}`.replace(/\.\s*$/, "");
  const body = (unit.summary ?? "").trim();
  const lines = [subject, "", ...(body ? [body, ""] : []), conductTrailer(unit, runId)].filter(
    (l, i, a) => !(l === "" && a[i - 1] === ""),
  );
  return lines.join("\n") + "\n";
}

/** Ensure `message` ends with the conduct trailer (agent-authored messages may omit it). */
function withConductTrailer(message: string, unit: CommitUnitMeta, runId: string): string {
  const t = conductTrailer(unit, runId);
  return message.includes(`Sparra-Unit: ${unit.id}`) ? message.trim() + "\n" : `${message.trim()}\n\n${t}\n`;
}

/** Injectable git seam (real git by default; fakes in tests). */
export interface ConductCommitGit {
  changedFiles: typeof changedFiles;
  workingDiff: typeof workingDiff;
  commitPaths: typeof commitPaths;
  revParse: typeof revParse;
}
const realGit: ConductCommitGit = { changedFiles, workingDiff, commitPaths, revParse };

export interface CommitUnitArgs {
  unit: CommitUnitMeta;
  runId: string;
  /** The unit worktree where the WIP lives (its `sparra/<name>` branch is checked out here). */
  worktreeDir: string;
  /** Absolute holdout path(s) to keep out of the diff/plan/commit (evaluator-only machinery). */
  holdoutPaths?: string[];
  /** `agent` → committer-plan flow; `template` → deterministic single commit (from `git.agentCommits`). */
  agentCommits: "agent" | "template";
  traceDir: string;
  runSessionFn?: (p: RunSessionParams) => Promise<RunResult>;
  git?: Partial<ConductCommitGit>;
}

export interface CommitUnitResult {
  /** True when at least one commit landed. */
  ok: boolean;
  /** Number of commits created. */
  commits: number;
  /** The `sparra/<name>` branch tip AFTER committing (40-hex), or undefined when nothing committed. */
  sha?: string;
}

/**
 * Commit the unit worktree's WIP onto its branch. Returns the new branch-tip SHA. No-op (ok:false)
 * when there's nothing to commit. Mirrors `commitItem` (template vs agent, holdout exclusion).
 */
export async function commitUnit(ctx: Ctx, args: CommitUnitArgs): Promise<CommitUnitResult> {
  const { unit, runId, worktreeDir } = args;
  const gi: ConductCommitGit = { ...realGit, ...args.git };
  const run = args.runSessionFn ?? runSession;

  // Never include the holdout in the diff, the plan, or any commit — even if it's a changed tracked
  // file in the worktree. It's evaluator-only machinery (mirrors `commitItem`).
  const holdoutRel = (args.holdoutPaths ?? [])
    .map((p) => path.relative(worktreeDir, p))
    .filter((p) => p && !p.startsWith(".."));
  const changed = gi
    .changedFiles(worktreeDir)
    .map((p) => path.relative(worktreeDir, p))
    .filter((f) => !holdoutRel.includes(f));
  if (!changed.length) return { ok: false, commits: 0 };

  const tip = (): string | undefined => gi.revParse(worktreeDir, "HEAD") ?? undefined;

  // Single commit of all (non-holdout) changes from the unit metadata — template mode + fallback.
  const commitAllChanged = (): CommitUnitResult => {
    const cr = gi.commitPaths(worktreeDir, changed, templateUnitCommitMessage(unit, runId));
    return cr.ok ? { ok: true, commits: 1, ...(tip() ? { sha: tip() } : {}) } : { ok: false, commits: 0 };
  };

  if (args.agentCommits !== "agent") return commitAllChanged();

  // Ask the committer for a plan (read-only, confined to the worktree — no holdout, no git writes).
  let plan: { commits?: { message?: unknown; files?: unknown }[] } | null = null;
  try {
    const role = ctx.config.roles.committer;
    const task =
      `Unit ${unit.id}: ${unit.title}\n${unit.summary ? `Summary: ${unit.summary}\n` : ""}` +
      `Changed files (${changed.length}):\n${changed.map((f) => `- ${f}`).join("\n")}\n\nDIFF:\n${gi.workingDiff(worktreeDir, 12000, holdoutRel)}\n\nProduce the commit plan now.`;
    const res = await run({
      role: "committer",
      systemPrompt: await loadPrompt(ctx.paths, "committer"),
      prompt: task,
      backend: role.backend,
      model: role.model,
      effort: role.effort,
      baseUrl: role.baseUrl,
      apiKey: role.apiKey,
      cwd: worktreeDir,
      env: mergedBuildEnv(ctx.config),
      // No tools: the diff is supplied inline, so the committer can't read anything off disk.
      tools: [],
      readOnly: true,
      ...readOnlyGuard(ctx),
      maxTurns: ctx.config.build.maxTurnsPerSession,
      maxBudgetUsd: ctx.config.build.maxBudgetUsdPerItem,
      traceDir: args.traceDir,
      traceSeq: 0,
    });
    plan = extractJsonWhere(res.resultText, (v) => v && Array.isArray((v as { commits?: unknown }).commits));
  } catch {
    plan = null;
  }

  const groups = (plan?.commits ?? []).filter(
    (c): c is { message: string; files: string[] } =>
      !!c &&
      typeof c.message === "string" &&
      Array.isArray(c.files) &&
      (c.files as unknown[]).every((f) => typeof f === "string"),
  );
  if (!groups.length) return commitAllChanged();

  // Execute the plan deterministically — only files that actually changed, each once.
  const changedSet = new Set(changed);
  const committed = new Set<string>();
  let n = 0;
  for (const g of groups) {
    const files = g.files.filter((f) => changedSet.has(f) && !committed.has(f));
    if (!files.length) continue;
    const cr = gi.commitPaths(worktreeDir, files, withConductTrailer(g.message, unit, runId));
    if (cr.ok) {
      n++;
      files.forEach((f) => committed.add(f));
    }
  }

  // Sweep anything the plan missed or failed to commit into a final template commit (lose nothing).
  const leftover = changed.filter((f) => !committed.has(f));
  if (leftover.length) {
    const cr = gi.commitPaths(worktreeDir, leftover, templateUnitCommitMessage(unit, runId));
    if (cr.ok) n++;
  }
  return n > 0 ? { ok: true, commits: n, ...(tip() ? { sha: tip() } : {}) } : { ok: false, commits: 0 };
}
