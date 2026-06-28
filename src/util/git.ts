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

// ── Cycle-finish seam (land + teardown). Real implementations behind `FinishDeps`. ──

/** True if the working tree at `dir` has uncommitted changes (tracked or untracked). */
export function isDirty(dir: string): boolean {
  if (!isGitRepo(dir)) return false;
  return git(dir, ["status", "--porcelain", "--untracked-files=all"]).out.trim() !== "";
}

/** True if a local branch `refs/heads/<branch>` exists (used to resolve/validate `finish --branch`). */
export function branchExists(root: string, branch: string): boolean {
  if (!isGitRepo(root)) return false;
  return git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

/** Absolute path of the worktree that has `branch` checked out, or null if none/in-place. */
export function worktreeForBranch(root: string, branch: string): string | null {
  if (!isGitRepo(root)) return null;
  const r = git(root, ["worktree", "list", "--porcelain"]);
  if (!r.ok) return null;
  let curPath: string | null = null;
  for (const line of r.out.split("\n")) {
    if (line.startsWith("worktree ")) curPath = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch ") && line.slice("branch ".length).trim() === `refs/heads/${branch}`) return curPath;
  }
  return null;
}

/**
 * The repo's integration/default branch, resolved INDEPENDENTLY of the current branch (under
 * branch-in-place the current branch IS the Sparra branch, so falling back to it would let a
 * `--merge` merge the branch into itself — a silent no-op). Resolution order:
 *   1. `origin/HEAD`            (e.g. `origin/main` → `main`)
 *   2. a local `main`          (`refs/heads/main`)
 *   3. a local `master`        (`refs/heads/master`)
 * Returns "" when none resolves — callers must REFUSE rather than guess. NEVER `currentBranch()`.
 *
 * `run` is an injectable git runner (default = real `git`) so the resolution is unit-testable.
 */
export function defaultBranch(
  root: string,
  run: (root: string, args: string[]) => { ok: boolean; out: string } = git
): string {
  const head = run(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok && head.out.trim()) return head.out.trim().replace(/^origin\//, "");
  if (run(root, ["show-ref", "--verify", "--quiet", "refs/heads/main"]).ok) return "main";
  if (run(root, ["show-ref", "--verify", "--quiet", "refs/heads/master"]).ok) return "master";
  return "";
}

/** Check out an existing branch (used by teardown to vacate a branch checked out in place). */
export function checkout(root: string, branch: string): { ok: boolean; out: string } {
  return git(root, ["checkout", branch]);
}

/**
 * Fast-forward-only merge of `source` into the explicit `target` (default) branch.
 *
 * Fast-forwardability is determined BEFORE any checkout state changes: if `target` is not an
 * ancestor of `source` (i.e. `target` has diverged), we abort WITHOUT having touched the
 * working checkout — leaving it exactly as we found it. Only when it will fast-forward do we
 * `git checkout <target>` and `git merge --ff-only <source>`. Never `--no-ff`, never force.
 *
 * `run` is an injectable git runner (default = real `git`) so the seam is unit-testable.
 */
export function mergeFfOnly(
  root: string,
  target: string,
  source: string,
  run: (root: string, args: string[]) => { ok: boolean; out: string } = git
): { ok: boolean; out: string } {
  // Cheap, read-only check first — does NOT mutate checkout state. Exit code 0 ⇒ ancestor.
  const ancestor = run(root, ["merge-base", "--is-ancestor", target, source]);
  if (!ancestor.ok) {
    return { ok: false, out: `${target} has diverged from ${source}; not a fast-forward (checkout left unchanged)` };
  }
  const co = run(root, ["checkout", target]);
  if (!co.ok) return co;
  return run(root, ["merge", "--ff-only", source]);
}

/** Remove a git worktree (the build's isolated checkout). */
export function removeWorktree(root: string, dir: string): { ok: boolean; out: string } {
  return git(root, ["worktree", "remove", dir]);
}

/** Delete a branch. `force` uses `-D` (allows unmerged); otherwise `-d` (merged-only, refuses unmerged). */
export function deleteBranch(root: string, branch: string, force: boolean): { ok: boolean; out: string } {
  return git(root, ["branch", force ? "-D" : "-d", branch]);
}

/** True if `file` (absolute or repo-relative path) is tracked by git. */
export function isTracked(root: string, file: string): boolean {
  if (!isGitRepo(root)) return false;
  return git(root, ["ls-files", "--error-unmatch", "--", file]).ok;
}

/** Whether the `gh` CLI is installed and runnable. */
export function ghAvailable(): boolean {
  return spawnSync("gh", ["--version"], { encoding: "utf8" }).status === 0;
}

/** Open a PR from `branch` into `base` via `gh pr create` (no holdout content involved). */
export function ghPrCreate(root: string, branch: string, base: string, title: string): { ok: boolean; out: string } {
  const r = spawnSync("gh", ["pr", "create", "--head", branch, "--base", base, "--title", title, "--fill"], {
    cwd: root,
    encoding: "utf8",
  });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}
