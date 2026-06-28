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

/** Absolute paths of files changed (vs HEAD + untracked) in a repo, via `git status --porcelain`. */
export function changedFiles(root: string): string[] {
  if (!isGitRepo(root)) return [];
  const r = git(root, ["status", "--porcelain", "--untracked-files=all"]);
  if (!r.ok) return [];
  const out: string[] = [];
  for (const line of r.out.split("\n")) {
    const rest = line.slice(3).trim(); // strip the 2-char status code + space
    if (!rest) continue;
    const rel = rest.includes(" -> ") ? rest.split(" -> ")[1]!.trim() : rest; // handle renames
    out.push(path.resolve(root, rel.replace(/^"|"$/g, "")));
  }
  return out;
}

/**
 * Stage everything and create one commit with `message`. No-op (ok:false) if the dir
 * isn't a git repo or there's nothing to commit. The caller gates this on autoCommit +
 * being on a Sparra-created branch, so it never lands on the user's main branch.
 */
export function commitAll(root: string, message: string): { ok: boolean; out: string } {
  if (!isGitRepo(root)) return { ok: false, out: "not a git repo" };
  const add = git(root, ["add", "-A"]);
  if (!add.ok) return { ok: false, out: `git add failed: ${add.out.trim()}` };
  if (git(root, ["status", "--porcelain"]).out.trim() === "") return { ok: false, out: "nothing to commit" };
  const r = spawnSync("git", ["commit", "-F", "-"], { cwd: root, encoding: "utf8", input: message });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

/** A unified diff of the current changes (tracked vs HEAD) plus the list of untracked files —
 *  enough context for a committer to group changes into commits. `exclude` paths (repo-relative)
 *  are kept out via pathspec (used to keep the holdout out of the committer's view). Capped. */
export function workingDiff(root: string, max = 12000, exclude: string[] = []): string {
  if (!isGitRepo(root)) return "";
  const ex = exclude.map((p) => `:(exclude)${p}`);
  const tracked =
    git(root, ["diff", "HEAD", "--stat", "--", ".", ...ex]).out + "\n" + git(root, ["diff", "HEAD", "--", ".", ...ex]).out;
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "--", ".", ...ex]).out.trim();
  const u = untracked ? `\n\n# Untracked (new) files:\n${untracked}` : "";
  const full = tracked + u;
  return full.length > max ? full.slice(0, max) + `\n…(diff truncated at ${max} chars)` : full;
}

/** Commit EXACTLY `files` with `message` — atomic: the commit is restricted to those pathspecs,
 *  so anything else staged/changed is left untouched. No-op (ok:false) if none of `files` changed. */
export function commitPaths(root: string, files: string[], message: string): { ok: boolean; out: string } {
  if (!isGitRepo(root)) return { ok: false, out: "not a git repo" };
  if (!files.length) return { ok: false, out: "no files" };
  const add = git(root, ["add", "--", ...files]); // stage (incl. new files / deletions) for these paths
  if (!add.ok) return { ok: false, out: `git add failed: ${add.out.trim()}` };
  if (git(root, ["diff", "--cached", "--quiet", "--", ...files]).ok) return { ok: false, out: "nothing to commit" };
  // `-- <files>` restricts the commit to these paths regardless of what else is in the index.
  const r = spawnSync("git", ["commit", "-F", "-", "--", ...files], { cwd: root, encoding: "utf8", input: message });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
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
