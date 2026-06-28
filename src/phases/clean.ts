import path from "node:path";
import type { Ctx } from "../context.ts";
import { banner, detail, info, ok, warn } from "../util/log.ts";
import {
  listWorktrees,
  listBranches,
  isBranchMerged,
  removeWorktree,
  deleteBranch,
  defaultBranch,
  currentBranch,
} from "../util/git.ts";

/** Read+side-effecting git seam so `clean` is testable with NO live git calls. */
export interface CleanDeps {
  listWorktrees: typeof listWorktrees;
  listBranches: typeof listBranches;
  isBranchMerged: typeof isBranchMerged;
  removeWorktree: typeof removeWorktree;
  deleteBranch: typeof deleteBranch;
  defaultBranch: typeof defaultBranch;
  currentBranch: typeof currentBranch;
}

const defaultDeps: CleanDeps = {
  listWorktrees,
  listBranches,
  isBranchMerged,
  removeWorktree,
  deleteBranch,
  defaultBranch,
  currentBranch,
};

export interface CleanOpts {
  /** Execute (remove worktrees + delete branches). Without it, clean only PREVIEWS (dry-run). */
  yes?: boolean;
  /** Also delete UNMERGED candidate branches (`-D`); without it they are SKIPPED. */
  force?: boolean;
}

export interface CleanResult {
  /** True when nothing was removed/deleted (default preview, no `--yes`). */
  dryRun: boolean;
  /** Candidate worktree paths (prefixed branch, not the main checkout). */
  worktrees: string[];
  /** Candidate branches whose tip is an ancestor of the default branch (safe `-d`). */
  mergedBranches: string[];
  /** Candidate branches that are NOT merged into the default branch. */
  unmergedBranches: string[];
  /** Worktrees actually removed (only in `--yes` mode). */
  removedWorktrees: string[];
  /** Branches actually deleted (only in `--yes` mode). */
  deletedBranches: string[];
  /** Unmerged candidate branches skipped because `--force` was absent. */
  skipped: string[];
}

/**
 * Prune stale Sparra git worktrees + branches left behind by finished/abandoned runs.
 *
 * Safety invariants (enforced in code, not just docs): never removes the main checkout
 * (`ctx.root`); never deletes the default branch or the currently checked-out branch; never
 * deletes an unmerged branch without `--force`. The default is a DRY RUN — it previews and
 * touches nothing until `--yes`. Worktrees are removed BEFORE branches (a worktree pins its
 * branch), so a branch becomes deletable once its worktree is gone.
 */
export async function cmdClean(
  ctx: Ctx,
  opts: CleanOpts = {},
  depOverrides: Partial<CleanDeps> = {}
): Promise<CleanResult> {
  const d: CleanDeps = { ...defaultDeps, ...depOverrides };
  banner("CLEAN");
  const prefix = ctx.config.git.branchPrefix;
  const base = d.defaultBranch(ctx.root);
  const current = d.currentBranch(ctx.root);

  // ── Candidate worktrees: a real, separate checkout (never ctx.root) on a Sparra-prefixed branch. ──
  const worktrees = d
    .listWorktrees(ctx.root)
    .filter((w) => w.path !== ctx.root && w.branch !== null && w.branch.startsWith(prefix))
    .map((w) => w.path);

  // ── Candidate branches: Sparra-prefixed, never the default branch or the current checkout. ──
  const candidateBranches = d
    .listBranches(ctx.root)
    .filter((b) => b.startsWith(prefix) && b !== base && b !== current);

  const mergedBranches: string[] = [];
  const unmergedBranches: string[] = [];
  for (const b of candidateBranches) {
    if (d.isBranchMerged(ctx.root, b, base)) mergedBranches.push(b);
    else unmergedBranches.push(b);
  }
  // Unmerged branches are deletable ONLY with --force; otherwise they are skipped.
  const skipped = opts.force ? [] : [...unmergedBranches];

  const result: CleanResult = {
    dryRun: !opts.yes,
    worktrees,
    mergedBranches,
    unmergedBranches,
    removedWorktrees: [],
    deletedBranches: [],
    skipped,
  };

  // ── Preview (default): report what WOULD happen and touch nothing. ──
  if (!opts.yes) {
    if (!worktrees.length && !mergedBranches.length && !unmergedBranches.length) {
      info("No stale Sparra worktrees or branches to prune.");
      return result;
    }
    info("Dry run — nothing removed. Re-run with --yes to act.");
    for (const w of worktrees) detail(`would remove worktree ${path.relative(ctx.root, w) || w}`);
    for (const b of mergedBranches) detail(`would delete branch ${b} (merged)`);
    for (const b of unmergedBranches) {
      if (opts.force) detail(`would delete branch ${b} (unmerged, --force)`);
      else warn(`would SKIP branch ${b} (unmerged — re-run with --force to delete)`);
    }
    return result;
  }

  // ── Act: remove worktrees FIRST (a worktree pins its branch), then delete branches. ──
  for (const w of worktrees) {
    const rm = d.removeWorktree(ctx.root, w);
    if (rm.ok) {
      result.removedWorktrees.push(w);
      ok(`Removed worktree ${path.relative(ctx.root, w) || w}.`);
    } else {
      warn(`Could not remove worktree ${w} (${rm.out.trim()}).`);
    }
  }

  for (const b of mergedBranches) {
    const del = d.deleteBranch(ctx.root, b, false); // merged ⇒ -d
    if (del.ok) {
      result.deletedBranches.push(b);
      ok(`Deleted branch ${b}.`);
    } else {
      warn(`Could not delete branch ${b} (${del.out.trim()}).`);
    }
  }
  for (const b of unmergedBranches) {
    if (!opts.force) {
      warn(`Skipped unmerged branch ${b} — re-run with --force to delete it.`);
      continue;
    }
    const del = d.deleteBranch(ctx.root, b, true); // unmerged + --force ⇒ -D
    if (del.ok) {
      result.deletedBranches.push(b);
      ok(`Force-deleted unmerged branch ${b}.`);
    } else {
      warn(`Could not delete branch ${b} (${del.out.trim()}).`);
    }
  }

  if (!result.removedWorktrees.length && !result.deletedBranches.length) {
    info("Nothing to prune.");
  }
  return result;
}
