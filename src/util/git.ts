import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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

/** Resolve a git ref (`HEAD`, a branch, a short/long SHA) to its full commit SHA in `dir`, or
 *  `null` when it can't be resolved (not a repo, unknown/ambiguous ref). Used by the eval-provenance
 *  seam to verify `expectedHead` and to anchor `evalBaseRef` before a judge session is launched. */
export function revParse(dir: string, ref: string): string | null {
  if (!isGitRepo(dir)) return null;
  const r = git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = r.out.trim();
  return r.ok && sha ? sha : null;
}

/** Absolute paths of files that differ between `base` and HEAD (`git diff --name-only base..HEAD`,
 *  new paths for renames), or `null` when the diff can't be computed (not a repo, bad base). Used to
 *  scope a judge's changed-files judgment to a single unit's commits. */
export function diffNames(dir: string, base: string): string[] | null {
  if (!isGitRepo(dir)) return null;
  const r = git(dir, ["diff", "--name-only", `${base}..HEAD`]);
  if (!r.ok) return null;
  return r.out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((rel) => path.resolve(dir, rel.replace(/^"|"$/g, "")));
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

/** Content marker for a path that can't be read (a staged/working deletion, or an unreadable
 *  file). Two absent paths compare equal, so a file deleted BEFORE and still deleted AFTER a run
 *  counts as unchanged. Chosen to never collide with a real hex sha-256 digest. */
export const ABSENT_CONTENT = "\0absent";

/**
 * SHA-256 (hex) of a file's raw bytes, or `ABSENT_CONTENT` when the path can't be read. This is the
 * content-comparison primitive behind writer progress detection: comparing the pre-run digest of a
 * changed file to its post-run digest distinguishes a real edit to a file already dirty at run
 * start (the normal continuation/fix-round case) from no work — which path-set membership cannot.
 * Reads bytes (not utf8) so binary artifacts hash correctly.
 */
export function fileContentHash(file: string): string {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return ABSENT_CONTENT;
  }
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
 * True iff `root` is a LINKED git worktree (an isolated checkout created by `git worktree add`),
 * as opposed to the main worktree, a non-repo, or a path where git errors.
 *
 * A linked worktree's `git rev-parse --git-dir` resolves to `<main>/.git/worktrees/<name>` while
 * `--git-common-dir` resolves to `<main>/.git` — so the two differ. In the main worktree both
 * resolve to `<root>/.git`, so they match. Git may return either relative (`.git`) or absolute
 * paths depending on cwd, so we resolve BOTH against `root` before comparing.
 *
 * The exercising evaluator uses this as the real safety boundary for writable scratch: an isolated
 * checkout (not specifically `state.build.branch`) is what makes a write-then-revert exercise safe.
 *
 * `run` is an injectable git runner (default = real `git`) so the check is unit-testable.
 */
export function isLinkedWorktree(
  root: string,
  run: (root: string, args: string[]) => { ok: boolean; out: string } = git
): boolean {
  const gitDir = run(root, ["rev-parse", "--git-dir"]);
  const commonDir = run(root, ["rev-parse", "--git-common-dir"]);
  if (!gitDir.ok || !commonDir.ok) return false;
  return path.resolve(root, gitDir.out.trim()) !== path.resolve(root, commonDir.out.trim());
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

/**
 * Rebase the branch checked out in `worktreeDir` onto `onto` (`git rebase <onto>`), so the branch's
 * commits replay linearly on top of `onto`'s tip. Only the branch checked out in `worktreeDir` is
 * moved; `onto` is read as a ref (shared object store), so it may be checked out in another worktree.
 * On a conflict (or any failure) git leaves the rebase mid-flight — callers MUST `abortRebase` to
 * restore the branch. Used by the conduct `--merge` path (rebase+ff preferred).
 *
 * `run` is an injectable git runner (default = real `git`) so the seam is unit-testable.
 */
export function rebaseBranch(
  worktreeDir: string,
  onto: string,
  run: (root: string, args: string[]) => { ok: boolean; out: string } = git
): { ok: boolean; out: string } {
  return run(worktreeDir, ["rebase", onto]);
}

/** Abort an in-progress rebase in `worktreeDir` (`git rebase --abort`), restoring the branch to its
 *  pre-rebase state. Best-effort: a no-op error (no rebase in progress) is harmless. */
export function abortRebase(
  worktreeDir: string,
  run: (root: string, args: string[]) => { ok: boolean; out: string } = git
): { ok: boolean; out: string } {
  return run(worktreeDir, ["rebase", "--abort"]);
}

/**
 * Merge `source` into the branch ALREADY checked out in `targetDir`. `noFf` forces a merge commit
 * (`--no-ff`); otherwise a fast-forward-only merge (`--ff-only`) is attempted (used after a rebase
 * made `source` a strict descendant of the target). On a conflict git leaves the merge mid-flight —
 * callers MUST `abortMerge` to restore the target. Never force, never `--allow-unrelated-histories`.
 *
 * `run` is an injectable git runner (default = real `git`) so the seam is unit-testable.
 */
export function mergeCheckedOut(
  targetDir: string,
  source: string,
  opts: { noFf?: boolean; message?: string } = {},
  run: (root: string, args: string[]) => { ok: boolean; out: string } = git
): { ok: boolean; out: string } {
  const args = ["merge"];
  if (opts.noFf) args.push("--no-ff");
  else args.push("--ff-only");
  if (opts.message) args.push("-m", opts.message);
  args.push(source);
  return run(targetDir, args);
}

/** Abort an in-progress merge in `targetDir` (`git merge --abort`), restoring the target's tip,
 *  index, and working tree. Best-effort: a no-op error (no merge in progress) is harmless. */
export function abortMerge(
  targetDir: string,
  run: (root: string, args: string[]) => { ok: boolean; out: string } = git
): { ok: boolean; out: string } {
  return run(targetDir, ["merge", "--abort"]);
}

/**
 * True iff `dir` has an in-progress rebase or merge (a mid-operation git state): a `.git/MERGE_HEAD`,
 * or a `rebase-merge/` / `rebase-apply/` state dir under the resolved git dir. Used by the conduct
 * merge path's post-resolution cleanliness checks (and available to callers verifying no operation
 * was left mid-flight). Resolves the real git dir first so it works in a linked worktree too.
 */
export function mergeOrRebaseInProgress(dir: string): boolean {
  if (!isGitRepo(dir) && !isLinkedWorktree(dir)) {
    // fall through — rev-parse below still works for linked worktrees whose `.git` is a file
  }
  const gd = git(dir, ["rev-parse", "--git-dir"]);
  if (!gd.ok) return false;
  const gitDir = path.resolve(dir, gd.out.trim());
  if (exists(path.join(gitDir, "MERGE_HEAD"))) return true;
  if (exists(path.join(gitDir, "rebase-merge"))) return true;
  if (exists(path.join(gitDir, "rebase-apply"))) return true;
  return false;
}

// ── Clean seam (prune stale Sparra worktrees/branches). Read-only listers + a merge check. ──

/**
 * All registered worktrees of the repo, parsed from `git worktree list --porcelain`:
 * a `worktree <path>` line starts each record, with an optional `branch refs/heads/<b>`
 * (absent for a detached HEAD). Returns `[]` when not a git repo or the command fails.
 */
export function listWorktrees(root: string): { path: string; branch: string | null }[] {
  if (!isGitRepo(root)) return [];
  const r = git(root, ["worktree", "list", "--porcelain"]);
  if (!r.ok) return [];
  const out: { path: string; branch: string | null }[] = [];
  let cur: { path: string; branch: string | null } | null = null;
  for (const line of r.out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: line.slice("worktree ".length).trim(), branch: null };
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Local branch short-names via `git for-each-ref`. Returns `[]` when not a repo / on failure. */
export function listBranches(root: string): string[] {
  if (!isGitRepo(root)) return [];
  const r = git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  if (!r.ok) return [];
  return r.out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** True iff `branch`'s tip is an ancestor of `base` (merged ⇒ safe to delete with `-d`). */
export function isBranchMerged(root: string, branch: string, base: string): boolean {
  if (!isGitRepo(root) || !branch || !base) return false;
  return git(root, ["merge-base", "--is-ancestor", branch, base]).ok;
}

/** Remove a git worktree (the build's isolated checkout). `force` (`--force`) removes even a dirty
 *  worktree — used by the WIP-safe teardown ONLY after the dirty-tree refusal has been overridden. */
export function removeWorktree(root: string, dir: string, force = false): { ok: boolean; out: string } {
  return git(root, ["worktree", "remove", ...(force ? ["--force"] : []), dir]);
}

/**
 * Create a THROWAWAY DETACHED linked worktree at `wtDir` checked out at the exact commit `ref`
 * resolves to (`git worktree add --detach <wtDir> <ref>`). Unlike `addWipWorktree` (which creates a
 * temporary WIP-snapshot commit) and `addNamedWorktree` (which branches from HEAD), this checks out
 * the exact historical commit — used by `computeVerifiedBaseline` to run a command at the base ref
 * in an isolated tree. Refuses if the target dir already exists. Teardown: `removeWipWorktree` or
 * `removeWorktree` (force).
 */
export function addDetachedWorktreeAt(srcDir: string, wtDir: string, ref: string): { ok: boolean; out: string } {
  if (!isGitRepo(srcDir) || !hasCommits(srcDir)) return { ok: false, out: `${srcDir} is not a git repo with commits` };
  if (exists(wtDir)) return { ok: false, out: `worktree target already exists: ${wtDir}` };
  return git(srcDir, ["worktree", "add", "--detach", wtDir, ref]);
}

/**
 * Create a PERSISTENT linked worktree at `wtDir` on a NEW branch cut from `srcDir`'s HEAD
 * (`git worktree add -b <branch> <wtDir> HEAD`) — the same primitive the build loop's
 * `prepareWorkspace` uses. Unlike `addWipWorktree` (a DETACHED, throwaway WIP-snapshot commit), this
 * is a durable named branch a generator's WIP lives on ACROSS rounds. Refuses if the target dir
 * already exists (never adopts a foreign dir). The user's HEAD/index/working tree are untouched — a
 * `worktree add` only reads the source repo and checks out into the sibling dir.
 */
export function addNamedWorktree(srcDir: string, wtDir: string, branch: string): { ok: boolean; out: string } {
  if (!isGitRepo(srcDir) || !hasCommits(srcDir)) return { ok: false, out: `${srcDir} is not a git repo with commits` };
  if (exists(wtDir)) return { ok: false, out: `worktree target already exists: ${wtDir}` };
  return git(srcDir, ["worktree", "add", "-b", branch, wtDir, "HEAD"]);
}

/**
 * Re-attach a linked worktree at `wtDir` to an ALREADY-EXISTING branch (`git worktree add <wtDir>
 * <branch>`, NO `-b`). Used to REPAIR a unit worktree whose directory was removed out from under us
 * (e.g. `rm -rf`) while its `sparra/<name>` branch — carrying the generator's committed WIP — survived:
 * we recreate the tree checked out on that same branch, preserving the branch tip. Refuses if the
 * target dir already exists (never adopts a foreign dir).
 */
export function addExistingBranchWorktree(srcDir: string, wtDir: string, branch: string): { ok: boolean; out: string } {
  if (!isGitRepo(srcDir) || !hasCommits(srcDir)) return { ok: false, out: `${srcDir} is not a git repo with commits` };
  if (exists(wtDir)) return { ok: false, out: `worktree target already exists: ${wtDir}` };
  return git(srcDir, ["worktree", "add", wtDir, branch]);
}

/** Prune git's registry of worktrees whose working directories have disappeared (`git worktree
 *  prune`). Best-effort — a stale registration otherwise blocks re-adding at the same path. */
export function pruneWorktrees(root: string): { ok: boolean; out: string } {
  if (!isGitRepo(root)) return { ok: false, out: `${root} is not a git repo` };
  return git(root, ["worktree", "prune"]);
}

// ── Temp WIP-snapshot worktrees (the `sparra eval --worktree` isolation seam). ──

/**
 * Create a TEMPORARY linked worktree at `wtDir` reflecting the CURRENT working tree of `srcDir` —
 * uncommitted tracked modifications, untracked non-ignored files, AND tracked deletions — so a
 * standalone eval grades exactly what the user is building, not just the last commit.
 *
 * The snapshot is taken through a THROWAWAY index (`GIT_INDEX_FILE`): seed it from HEAD (so
 * tracked-but-ignored files survive and deletions diff correctly), `git add -A` the working tree
 * into it, then `write-tree` + `commit-tree` a DANGLING snapshot commit. The user's real index,
 * HEAD, and working tree are never touched, and no branch/ref is created — the worktree is added
 * DETACHED at the snapshot commit, so teardown is just `removeWipWorktree` (the unreferenced
 * commit is garbage for git gc).
 */
export function addWipWorktree(srcDir: string, wtDir: string): { ok: boolean; out: string } {
  if (!isGitRepo(srcDir) || !hasCommits(srcDir)) return { ok: false, out: `${srcDir} is not a git repo with commits` };
  if (exists(wtDir)) return { ok: false, out: `worktree target already exists: ${wtDir}` };
  const tmpIndex = path.join(os.tmpdir(), `sparra-wip-index-${randomUUID().slice(0, 8)}`);
  // Identity env so commit-tree works in a repo with no user.name/email configured.
  const env = {
    ...process.env,
    GIT_INDEX_FILE: tmpIndex,
    GIT_AUTHOR_NAME: "sparra",
    GIT_AUTHOR_EMAIL: "sparra@localhost",
    GIT_COMMITTER_NAME: "sparra",
    GIT_COMMITTER_EMAIL: "sparra@localhost",
  };
  const g = (args: string[]): { ok: boolean; out: string } => {
    const r = spawnSync("git", args, { cwd: srcDir, encoding: "utf8", env });
    return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
  };
  try {
    const seed = g(["read-tree", "HEAD"]);
    if (!seed.ok) return { ok: false, out: `snapshot read-tree failed: ${seed.out.trim()}` };
    const add = g(["add", "-A"]);
    if (!add.ok) return { ok: false, out: `snapshot add failed: ${add.out.trim()}` };
    const tree = g(["write-tree"]);
    if (!tree.ok) return { ok: false, out: `snapshot write-tree failed: ${tree.out.trim()}` };
    const commit = g(["commit-tree", tree.out.trim(), "-p", "HEAD", "-m", "sparra: temporary WIP eval snapshot"]);
    if (!commit.ok) return { ok: false, out: `snapshot commit-tree failed: ${commit.out.trim()}` };
    // The worktree add runs WITHOUT the throwaway index (plain `git()`), detached at the snapshot.
    return git(srcDir, ["worktree", "add", "--detach", wtDir, commit.out.trim()]);
  } finally {
    try {
      fs.rmSync(tmpIndex, { force: true });
    } catch {
      /* a leaked temp index file is harmless */
    }
  }
}

/**
 * Remove a TEMPORARY linked worktree created by `addWipWorktree`. SCOPED HARD to the temp dir so
 * it can never delete uncommitted work in the MAIN tree: it REFUSES unless `wtDir` is a LINKED
 * worktree distinct from `srcDir`. `--force` because an eval run legitimately dirties the worktree
 * (provisioned node_modules, exercise scratch); if git's removal fails (e.g. a stray file lock),
 * the dir is deleted directly and the stale registration pruned.
 */
export function removeWipWorktree(srcDir: string, wtDir: string): { ok: boolean; out: string } {
  if (path.resolve(wtDir) === path.resolve(srcDir)) return { ok: false, out: `refusing to remove: ${wtDir} is the source dir` };
  if (!isLinkedWorktree(wtDir)) return { ok: false, out: `refusing to remove: ${wtDir} is not a linked worktree` };
  const r = git(srcDir, ["worktree", "remove", "--force", wtDir]);
  if (r.ok) return r;
  try {
    fs.rmSync(wtDir, { recursive: true, force: true });
  } catch {
    /* fall through to the exists() verdict below */
  }
  git(srcDir, ["worktree", "prune"]);
  return { ok: !exists(wtDir), out: r.out };
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
