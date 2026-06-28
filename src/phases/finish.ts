import path from "node:path";
import process from "node:process";
import type { Ctx } from "../context.ts";
import { exists } from "../util/io.ts";
import { banner, detail, info, ok, warn, err } from "../util/log.ts";
import { archiveCycle, cmdNew } from "./new.ts";
import {
  isDirty,
  worktreeForBranch,
  defaultBranch,
  mergeFfOnly,
  removeWorktree,
  deleteBranch,
  checkout,
  isTracked,
  ghAvailable,
  ghPrCreate,
} from "../util/git.ts";

/** Side-effecting git/gh/fs seam so `finish` is testable with NO live git/gh/network calls. */
export interface FinishDeps {
  isDirty: typeof isDirty;
  worktreeForBranch: typeof worktreeForBranch;
  defaultBranch: typeof defaultBranch;
  mergeFfOnly: typeof mergeFfOnly;
  removeWorktree: typeof removeWorktree;
  deleteBranch: typeof deleteBranch;
  checkout: typeof checkout;
  isTracked: typeof isTracked;
  ghAvailable: typeof ghAvailable;
  ghPrCreate: typeof ghPrCreate;
  /** Interactive confirmation for the irreversible `--merge` land. Default refuses (require `--yes`). */
  confirm: () => boolean;
}

const defaultDeps: FinishDeps = {
  isDirty,
  worktreeForBranch,
  defaultBranch,
  mergeFfOnly,
  removeWorktree,
  deleteBranch,
  checkout,
  isTracked,
  ghAvailable,
  ghPrCreate,
  confirm: () => false,
};

export interface FinishOpts {
  pr?: boolean;
  merge?: boolean;
  yes?: boolean;
  teardown?: boolean;
  force?: boolean;
  /** Title for a chained fresh cycle (`--new "<title>"`); "" means `--new` with no title. */
  new?: string;
}

export interface FinishResult {
  /** Set (with a message) when finish refused before any side effect. */
  refused?: string;
  landed: "pr" | "merge" | "none";
  /** PR could not be opened automatically (gh absent) — the manual command was printed. */
  prManual?: boolean;
  /** `--merge` aborted because main had diverged (no fast-forward). */
  diverged?: boolean;
  tornDown?: boolean;
  archived?: boolean;
  archiveName?: string;
  chained?: boolean;
}

const MID_FLIGHT = new Set(["pending", "contracting", "building"]);

/**
 * Close out a completed build cycle: PR-first landing of the Sparra branch, worktree/branch
 * teardown, and cycle archiving — without ever silently touching the user's main branch.
 *
 * Safety invariants: refuses on mid-flight/dirty state; never mutates main without `--merge`
 * + a confirmation + a clean fast-forward; aborts `--merge` on divergence; never force-pushes
 * or hard-resets; never deletes an unmerged branch without `--force`; the holdout is archived
 * privately and never rides into a PR/merge.
 */
export async function cmdFinish(
  ctx: Ctx,
  opts: FinishOpts = {},
  depOverrides: Partial<FinishDeps> = {}
): Promise<FinishResult> {
  const d: FinishDeps = { ...defaultDeps, ...depOverrides };
  banner("FINISH CYCLE");
  const { paths, store } = ctx;
  const b = store.data;

  // ── a. Preconditions — refuse (no side effects) on mid-flight or dirty state. ──
  const midFlight = Object.entries(b.build.items).find(([, s]) => MID_FLIGHT.has(s.status));
  if (midFlight) {
    const msg = `Build is mid-flight (item ${midFlight[0]} is ${midFlight[1].status}). Let it reach a terminal state first.`;
    err(msg);
    process.exitCode = 1;
    return { refused: msg, landed: "none" };
  }
  const branch = b.build.branch;
  const workspaceDir = b.build.workspaceDir && b.build.workspaceDir !== ctx.root ? b.build.workspaceDir : null;
  const checkDir = workspaceDir ?? ctx.root;
  if (d.isDirty(checkDir)) {
    const msg = `Working tree is dirty (uncommitted changes in ${path.relative(ctx.root, checkDir) || "."}). Commit or stash first.`;
    err(msg);
    process.exitCode = 1;
    return { refused: msg, landed: "none" };
  }

  const result: FinishResult = { landed: "none" };

  // Resolve the Sparra branch + its worktree. With no branch, land/teardown are no-ops.
  const worktreeDir = branch ? d.worktreeForBranch(ctx.root, branch) ?? workspaceDir : null;

  // ── Holdout safety: it must never ride into a PR/merge. It is gitignored under .sparra/
  //    in the normal case. If a tracked HOLDOUT.md would be carried by the land, HARD-STOP the
  //    land path BEFORE any PR/merge so the holdout can never leak — but still archive it
  //    privately below (that is the whole point of close-out). ──
  const holdoutTracked =
    (opts.merge || opts.pr) && exists(paths.holdout) && d.isTracked(ctx.root, paths.holdout);
  if (holdoutTracked) {
    err(`Refusing to land: HOLDOUT.md is TRACKED by git and would be exposed in the PR/merge.`);
    detail(`Untrack it first: \`git rm --cached ${path.relative(ctx.root, paths.holdout)}\` and add it to .gitignore (it is gitignored under .sparra/ by default), then re-run.`);
    detail(`The cycle will still be archived (the holdout is moved privately into the cycle dir).`);
    process.exitCode = 1;
  }

  // ── b. Land — opt-in; the default touches nothing. (Skipped entirely if the holdout is tracked.) ──
  if (holdoutTracked) {
    // Hard-stop: no land path may proceed past a tracked-holdout check.
  } else if (!branch) {
    info("No Sparra branch on record — nothing to land or tear down.");
  } else if (opts.merge) {
    const base = d.defaultBranch(ctx.root);
    // Guard against self-merge: if we can't resolve an integration branch DISTINCT from the
    // Sparra branch (e.g. branch-in-place where the current branch is the Sparra branch), a
    // `--merge` would merge the branch into itself — a silent no-op that never lands to main.
    if (!base || base === branch) {
      const msg = `Can't determine a distinct default branch to land into (resolved "${base || "<none>"}"; source is ${branch}). Refusing to merge a branch into itself.`;
      err(msg);
      process.exitCode = 1;
      return { ...result, refused: msg };
    }
    // An explicitly-requested merge that can't proceed ABORTS before teardown/archive, so the
    // user can fix it and retry — finish never archives a half-landed cycle out from under them.
    if (!(opts.yes || d.confirm())) {
      const msg = `--merge into ${base} needs confirmation. Re-run with --yes (or confirm). Nothing merged.`;
      warn(msg);
      process.exitCode = 1;
      return { ...result, refused: msg };
    }
    // Explicitly fast-forward the configured default branch to the Sparra branch (never the
    // current HEAD): mergeFfOnly checks out `base` then `git merge --ff-only <branch>` into it.
    const m = d.mergeFfOnly(ctx.root, base, branch);
    if (!m.ok) {
      const msg = `Aborted: ${base} has diverged — ${branch} does not fast-forward cleanly. Rebase the branch, then retry. (${m.out.trim()})`;
      err(msg);
      process.exitCode = 1;
      return { ...result, diverged: true };
    }
    result.landed = "merge";
    ok(`Fast-forwarded ${base} → ${branch}.`);
  } else if (opts.pr) {
    const base = d.defaultBranch(ctx.root);
    if (d.ghAvailable()) {
      const pr = d.ghPrCreate(ctx.root, branch, base, `Sparra cycle: ${branch}`);
      if (pr.ok) {
        result.landed = "pr";
        ok(`Opened PR ${branch} → ${base}.`);
      } else {
        result.prManual = true;
        warn(`gh pr create failed (${pr.out.trim()}). Open it manually:`);
        detail(`git push -u origin ${branch} && gh pr create --base ${base} --head ${branch}`);
      }
    } else {
      result.prManual = true;
      warn("gh not found — open the PR manually:");
      detail(`git push -u origin ${branch} && gh pr create --base ${base} --head ${branch}`);
    }
  } else {
    info(`Branch ${branch} is ready. Land it with \`sparra finish --pr\` (PR) or \`--merge --yes\` (ff-only into ${d.defaultBranch(ctx.root)}).`);
  }

  // ── c. Teardown — after a successful merge-land, or on explicit --teardown. Worktree first. ──
  const doTeardown = branch && !holdoutTracked && (result.landed === "merge" || opts.teardown);
  if (doTeardown && branch) {
    // A genuine SEPARATE worktree is a checkout dir DISTINCT from the main checkout. Under
    // branch-in-place the Sparra branch lives in `ctx.root` itself (worktreeForBranch returns
    // `ctx.root`, or nothing) — there is NO worktree to remove, and `git worktree remove` on the
    // main checkout would be wrong. Only `git worktree remove` a distinct, real worktree dir.
    const separateWorktree = worktreeDir && worktreeDir !== ctx.root ? worktreeDir : null;
    let worktreeRemoved = true;
    if (separateWorktree && exists(separateWorktree)) {
      const rm = d.removeWorktree(ctx.root, separateWorktree);
      if (rm.ok) {
        ok(`Removed worktree ${path.relative(ctx.root, separateWorktree)}.`);
      } else {
        worktreeRemoved = false;
        warn(`Could not remove worktree ${separateWorktree} (${rm.out.trim()}).`);
      }
    }
    // Only attempt the branch delete once any separate worktree is gone (it pins the branch).
    let branchDeleted = false;
    if (worktreeRemoved) {
      // Branch-in-place: the Sparra branch is the current HEAD of the main checkout and can't be
      // deleted while checked out — vacate it onto the resolved default branch (FIX: never the
      // current branch, i.e. itself) before `git branch -d`.
      let canDelete = true;
      if (!separateWorktree) {
        const base = d.defaultBranch(ctx.root);
        if (!base || base === branch) {
          canDelete = false;
          warn(`Can't determine a distinct default branch to switch to before deleting ${branch} — leaving it checked out in place.`);
        } else {
          const co = d.checkout(ctx.root, base);
          if (co.ok) {
            ok(`Checked out ${base} to vacate ${branch}.`);
          } else {
            canDelete = false;
            warn(`Could not check out ${base} to vacate ${branch} (${co.out.trim()}).`);
          }
        }
      }
      if (canDelete) {
        const del = d.deleteBranch(ctx.root, branch, !!opts.force);
        if (del.ok) {
          branchDeleted = true;
          ok(`Deleted branch ${branch}.`);
        } else if (!opts.force) {
          warn(`Branch ${branch} is not fully merged — refusing to delete it. Re-run with --force to delete anyway.`);
        } else {
          warn(`Could not delete branch ${branch} (${del.out.trim()}).`);
        }
      }
    }
    // Clear branch/workspace state ONLY when teardown fully succeeded — otherwise the branch
    // still exists and the state must keep pointing at it so the user can cleanly retry.
    if (worktreeRemoved && branchDeleted) {
      result.tornDown = true;
      b.build.branch = undefined;
      b.build.workspaceDir = undefined;
      b.build.workspaceNote = undefined;
      await store.save();
    } else {
      warn(`Teardown incomplete — leaving build.branch/workspaceDir intact so you can safely retry (e.g. with --force).`);
    }
  }

  // ── d. Archive — move the working set (incl. the live HOLDOUT.md) into the cycle dir. ──
  if (opts.new !== undefined) {
    // Chain into a fresh cycle (cmdNew archives + re-scaffolds — do NOT double-archive).
    await cmdNew(ctx, opts.new);
    result.archived = true;
    result.chained = true;
  } else {
    const arch = await archiveCycle(ctx, "");
    await paths.ensureScaffold(); // recreate empty working dirs; state/plan untouched
    result.archived = true;
    result.archiveName = arch.name;
    ok(`Cycle ${arch.n} archived → ${path.relative(ctx.root, arch.dest)} (${arch.archived} artifact group(s)).`);
    info(`Start the next feature with \`sparra new "<title>"\`.`);
  }

  return result;
}
