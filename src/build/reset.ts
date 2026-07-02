import { spawnSync } from "node:child_process";

/**
 * Pivot workspace reset (Q6). A GAN pivot promises "restart from scratch with a different
 * approach", but the workspace still carries the failed attempt's files — the fresh generator
 * re-anchors on them. This module discards the failed attempt (tracked modifications + new
 * non-ignored untracked files) so the fresh session really does start from the item-start state.
 *
 * DESTRUCTIVE BY DESIGN, so it only fires when an EXACT, Sparra-owned anchor exists — every
 * gate below must hold (config AND runtime-verified), otherwise it refuses and the loop keeps
 * today's no-reset behavior:
 *   - `pivot.resetWorkspace` (config, default true)
 *   - `git.autoCommit` on — accepted prior items are committed, so HEAD == item-start exactly
 *   - a recorded Sparra branch (`state.build.branch`) — never an in-place run
 *   - the recorded branch is SPARRA-OWNED — it carries the project's `git.branchPrefix`
 *     (default "sparra/"). A corrupted/hand-edited state.json recording `main` must never
 *     aim the destructive reset at a user's branch, even when the live branch "matches"
 *   - the workspace IS the persisted build workspace
 *   - a live git anchor at reset time: the workspace is a git tree with a HEAD, and its
 *     CURRENT branch matches the recorded Sparra branch (no-git, detached-HEAD,
 *     branch-mismatch and a stale recorded branch all refuse)
 *
 * The reset itself: `git restore --source=HEAD --staged --worktree` (tracked changes) +
 * `git clean -fd` — deliberately WITHOUT `-x`, so gitignored scratch (node_modules, caches)
 * survives. Every git op is scoped to the workspace dir via `git -C`.
 *
 * Git ops go through injectable deps (the `integrity.ts` realIntegrityDeps pattern) so unit
 * tests never touch a real tree.
 */

export interface ResetDeps {
  /** True when `dir` is inside a git worktree (main or linked). */
  isGitRepo: (dir: string) => boolean;
  /** True when the workspace has a resolvable HEAD commit. */
  hasHead: (dir: string) => boolean;
  /** Current branch short-name, or null when unresolvable. Detached HEAD yields "HEAD". */
  currentBranch: (dir: string) => string | null;
  /** Revert tracked changes (index + worktree) to HEAD. Throws on failure. */
  restoreTracked: (dir: string) => void;
  /** Remove non-ignored untracked files/dirs (`clean -fd`, NEVER `-x`). Throws on failure. */
  cleanUntracked: (dir: string) => void;
}

export interface ResetGateInput {
  /** The workspace the build loop is about to generate into. */
  workspaceDir: string | undefined;
  /** The PERSISTED build workspace (`state.build.workspaceDir`) — must match `workspaceDir`. */
  persistedWorkspaceDir: string | undefined;
  /** The recorded Sparra branch (`state.build.branch`); unset on in-place runs. */
  recordedBranch: string | undefined;
  /**
   * The project's Sparra branch prefix (`git.branchPrefix`, default "sparra/"). Ownership
   * gate: both the recorded and the live branch must START WITH this — never a hardcoded
   * literal, so non-default prefixes keep working.
   */
  branchPrefix: string;
  /** `pivot.resetWorkspace` (config). */
  resetWorkspaceEnabled: boolean;
  /** `git.autoCommit` (config) — required so HEAD is exactly the item-start state. */
  autoCommit: boolean;
}

export type ResetResult = { reset: true } | { reset: false; reason: string };

/**
 * Gate-check, then reset the workspace to the item-start state. Any gate false → `{reset:false}`
 * with the refusing gate named (the caller logs it and proceeds without a reset — today's
 * behavior). A FAILING reset op THROWS — the caller must surface it and must NOT run the fresh
 * generator against the dirty tree.
 */
export function maybeResetWorkspace(input: ResetGateInput, deps: ResetDeps = realResetDeps()): ResetResult {
  if (!input.resetWorkspaceEnabled) return { reset: false, reason: "pivot.resetWorkspace is off" };
  if (!input.autoCommit) return { reset: false, reason: "git.autoCommit is off (HEAD is not the item-start state)" };
  if (!input.recordedBranch) return { reset: false, reason: "no recorded Sparra branch (in-place run)" };
  // Ownership: the recorded branch must be Sparra's own (git.branchPrefix). A matching live
  // branch is NOT enough — a corrupted state.json recording "main" would otherwise pass every
  // other gate and reset the user's branch.
  if (!input.branchPrefix) return { reset: false, reason: "no Sparra branch prefix configured (cannot verify branch ownership)" };
  if (!input.recordedBranch.startsWith(input.branchPrefix)) {
    return {
      reset: false,
      reason: `recorded branch "${input.recordedBranch}" is not Sparra-owned (missing branch prefix "${input.branchPrefix}")`,
    };
  }
  const ws = input.workspaceDir;
  if (!ws || ws !== input.persistedWorkspaceDir) {
    return { reset: false, reason: "workspace is not the persisted build workspace" };
  }
  // Live anchor, verified at reset time (config/state alone is not enough — the tree may have
  // been switched, detached, or torn down since the branch was recorded).
  if (!deps.isGitRepo(ws)) return { reset: false, reason: "workspace is not a git tree" };
  if (!deps.hasHead(ws)) return { reset: false, reason: "workspace has no HEAD" };
  const cur = deps.currentBranch(ws);
  if (cur === null || cur === "HEAD") return { reset: false, reason: "workspace HEAD is detached" };
  // Belt-and-braces ownership on the LIVE branch too (the equality check below makes this
  // implied by the recorded-branch gate, but the destructive path states it explicitly).
  if (!cur.startsWith(input.branchPrefix)) {
    return { reset: false, reason: `workspace branch "${cur}" is not Sparra-owned (missing branch prefix "${input.branchPrefix}")` };
  }
  if (cur !== input.recordedBranch) {
    return { reset: false, reason: `workspace branch "${cur}" ≠ recorded Sparra branch "${input.recordedBranch}"` };
  }

  deps.restoreTracked(ws); // throws on failure — caller halts, never generates on a dirty tree
  deps.cleanUntracked(ws);
  return { reset: true };
}

/** Run git scoped to `dir` via `-C` (never the process cwd). */
function git(dir: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

/** Wire the real git, every op scoped to the workspace dir. */
export function realResetDeps(): ResetDeps {
  return {
    isGitRepo: (dir) => git(dir, ["rev-parse", "--git-dir"]).ok,
    hasHead: (dir) => git(dir, ["rev-parse", "--verify", "HEAD"]).ok,
    currentBranch: (dir) => {
      const r = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
      return r.ok ? r.out.trim() : null;
    },
    restoreTracked: (dir) => {
      const r = git(dir, ["restore", "--source=HEAD", "--staged", "--worktree", "--", "."]);
      if (!r.ok) throw new Error(`git restore failed in ${dir}: ${r.out.trim()}`);
    },
    cleanUntracked: (dir) => {
      // -fd only — NEVER -x: gitignored scratch (node_modules, build caches) must survive.
      const r = git(dir, ["clean", "-fd"]);
      if (!r.ok) throw new Error(`git clean -fd failed in ${dir}: ${r.out.trim()}`);
    },
  };
}
