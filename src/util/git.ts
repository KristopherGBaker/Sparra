import { spawnSync } from "node:child_process";
import path from "node:path";
import { exists } from "./io.ts";

export function isGitRepo(root: string): boolean {
  return exists(path.join(root, ".git"));
}

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

export function currentBranch(root: string): string | null {
  const r = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.ok ? r.out.trim() : null;
}

export function hasCommits(root: string): boolean {
  return git(root, ["rev-parse", "HEAD"]).ok;
}

/**
 * Prepare an isolated working location for the build per gitStrategy.
 * Returns the directory the build should run in.
 *   - worktree: create a sibling git worktree on a new branch
 *   - branch:   create+checkout a new branch in place
 *   - inplace:  no isolation (still never commits autonomously)
 * Never commits to or mutates the user's main branch history.
 */
export function prepareWorkspace(
  root: string,
  strategy: "worktree" | "branch" | "inplace",
  branchPrefix: string,
  runId: string
): { dir: string; branch?: string; note: string } {
  if (strategy === "inplace" || !isGitRepo(root) || !hasCommits(root)) {
    return { dir: root, note: strategy !== "inplace" ? "no git history → running in place (no autonomous commits)" : "running in place" };
  }
  const branch = `${branchPrefix}${runId}`;
  if (strategy === "branch") {
    const r = git(root, ["checkout", "-b", branch]);
    return { dir: root, branch, note: r.ok ? `checked out new branch ${branch}` : `branch create failed: ${r.out.trim()}` };
  }
  // worktree
  const wtDir = path.join(path.dirname(root), `${path.basename(root)}-${runId}`);
  const r = git(root, ["worktree", "add", "-b", branch, wtDir, "HEAD"]);
  if (!r.ok) {
    return { dir: root, note: `worktree create failed (${r.out.trim()}); falling back to in place` };
  }
  return { dir: wtDir, branch, note: `created worktree ${wtDir} on branch ${branch}` };
}
