import path from "node:path";
import type { Ctx } from "../context.ts";
import { exists } from "../util/io.ts";
import {
  addExistingBranchWorktree,
  addNamedWorktree,
  branchExists,
  defaultBranch,
  deleteBranch,
  isBranchMerged,
  isDirty,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
} from "../util/git.ts";

/**
 * Persistent per-unit WRITER worktrees (U-W, reflect finding U8).
 *
 * `useWorktree` (see roleRun.ts) is a JUDGE-only, THROWAWAY WIP snapshot: created and torn down
 * within one run, registered nowhere. A GENERATOR that iterates a unit across rounds wants the
 * opposite — a NAMED, durable tree whose WIP survives round N → N+1, provisioned once, torn down
 * explicitly on accept/abandon. This module owns that registry (persisted in the build store so
 * reuse survives a process restart) and the create/reuse/dispose lifecycle. The role-runner
 * (`runRoleInUnitWorktree`) wires a generator's `unitWorktree` request through here, then delegates
 * to the ordinary in-place run with the worktree as its workspace — so the existing linked-worktree
 * paths (dep provisioning, the writer guard scoped to the tree, holdout exclusion) all apply
 * unchanged, and the boundary is that tree.
 */

/** The `sparra/` branch prefix a unit worktree's branch is cut on — keeps every unit tree on a
 *  Sparra branch (never the user's main), matching the build loop's own branch convention. */
export const UNIT_WORKTREE_BRANCH_PREFIX = "sparra/";

/** The branch a unit worktree named `name` lives on. */
export function unitWorktreeBranch(name: string): string {
  return `${UNIT_WORKTREE_BRANCH_PREFIX}${name}`;
}

/**
 * Validate a `unitWorktree` name BEFORE any git/fs action. Returns a clear error message, or `null`
 * when the name is safe to turn into a `sparra/<name>` branch + a sibling dir. Rejects: empty /
 * whitespace-only, embedded whitespace, path separators (`/`, `\`), `..` (path traversal AND an
 * illegal git-ref token), absolute paths, a leading `-` (arg-injection into git), a leading/trailing
 * `.` (an illegal git-ref component), and any character outside `[A-Za-z0-9._-]` (which also covers
 * the git-ref-invalid `~^:?*[` and control chars). Deliberately an allowlist — default-deny.
 */
export function validateUnitWorktreeName(name: unknown): string | null {
  if (typeof name !== "string" || name.length === 0) return "name is empty";
  if (name.trim().length === 0) return "name is only whitespace";
  if (/\s/.test(name)) return "name contains whitespace";
  if (name.includes("/") || name.includes("\\")) return "name contains a path separator";
  if (name.includes("..")) return "name contains '..' (path traversal / invalid git ref)";
  if (path.isAbsolute(name)) return "name is an absolute path";
  if (name.startsWith("-")) return "name starts with '-' (would be read as a git flag)";
  if (name.startsWith(".") || name.endsWith(".")) return "name starts or ends with '.' (invalid git ref)";
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return "name has invalid characters (allowed: letters, digits, '.', '_', '-')";
  return null;
}

/** Deterministic sibling dir for a unit worktree (same volume as the source, so COW dep copies stay
 *  cheap). Name-based (no random token) so two DIFFERENT names get DIFFERENT dirs (distinct write
 *  boundaries) and the same name recomputes the same path. */
export function defaultUnitWorktreeDir(src: string, name: string): string {
  return path.join(path.dirname(src), `${path.basename(src)}-unit-${name}`);
}

/** Injectable git/fs seams — tests use a throwaway repo + fakes; no live model, no real deps. */
export interface UnitWorktreeDeps {
  addWorktreeFn?: typeof addNamedWorktree;
  addExistingBranchWorktreeFn?: typeof addExistingBranchWorktree;
  pruneWorktreesFn?: typeof pruneWorktrees;
  branchExistsFn?: typeof branchExists;
  existsFn?: (p: string) => boolean;
  worktreeDirFn?: (src: string, name: string) => string;
  listWorktreesFn?: typeof listWorktrees;
  /** RESUME opt-in: VERIFY a registered reuse entry is still a live worktree on the expected branch
   *  before handing it back. A stale entry (dir removed, or checked out on another branch) is
   *  repaired/recreated under the same identity instead of returned as `created:false`. Default
   *  (false) keeps the fast registry-hit reuse the generator role relies on (no extra fs/git probe). */
  reverifyReuse?: boolean;
}

export interface EnsureUnitWorktreeResult {
  /** The worktree's cwd (where the generator runs). */
  dir: string;
  /** The `sparra/<name>` branch it lives on. */
  branch: string;
  /** The source checkout it was cut from (`req.workspace ?? ctx.root`). */
  src: string;
  /** True the FIRST time (created now); false on a reuse. */
  created: boolean;
}

/**
 * Ensure the persistent unit worktree `name` exists, creating it on first use and reusing the
 * registered one thereafter. Validates the name first (throws on any invalid name), REFUSES to
 * adopt a foreign dir/branch (a target dir or `sparra/<name>` branch that already exists but is NOT
 * in the registry throws), then on first use `git worktree add -b`s the tree and registers it in the
 * build store (persisted so reuse survives a restart). Dep provisioning is NOT done here — the
 * delegate (`runRoleInPlace`) provisions the linked worktree via the existing path. Never mutates
 * unrelated build state (branch/workspaceDir/etc.).
 *
 * SELF-HEAL: when the target dir already exists but `name` isn't in the registry (the registry
 * write is a full `state.json` read-modify-write, so concurrent `--unit-worktree` generators can
 * race and the last writer's save clobbers an earlier writer's entry — see the module doc), we
 * don't blindly refuse. We ask git ground truth (`listWorktreesFn`, default `listWorktrees`)
 * whether the dir is a LIVE linked worktree checked out on EXACTLY `sparra/<name>`. If so, the dir
 * is unambiguously ours — a registry entry a racing writer dropped, not foreign state — so we
 * ADOPT it: repair the registry entry, persist, and return `{ created: false }` instead of
 * throwing. Anything short of that exact match (a plain directory, or a worktree on some OTHER
 * branch) still throws — the refuse-to-adopt-foreign-state guard is narrowed, never removed.
 *
 * REVERIFY (opt-in via `deps.reverifyReuse`, used by `conduct --resume`): a REGISTERED reuse entry is
 * normally handed back on a cheap registry hit (the generator role reuses its tree across rounds with
 * no fs/git probe). But a resume may run long after the tree was created — the dir could have been
 * removed, or the branch re-checked-out elsewhere. With `reverifyReuse`, the registry hit is VERIFIED
 * against git ground truth (dir exists AND is a live worktree on exactly `sparra/<name>`); a stale
 * entry is dropped + pruned and the tree RECREATED under the same identity (re-attaching a surviving
 * branch if one is present, so committed WIP is preserved) rather than returned pointing at nothing.
 */
export async function ensureUnitWorktree(
  ctx: Ctx,
  name: string,
  src: string,
  deps: UnitWorktreeDeps = {}
): Promise<EnsureUnitWorktreeResult> {
  const err = validateUnitWorktreeName(name);
  if (err) throw new Error(`invalid unitWorktree name ${JSON.stringify(name)}: ${err}.`);

  const branch = unitWorktreeBranch(name);
  const existsFn = deps.existsFn ?? exists;
  const branchExistsFn = deps.branchExistsFn ?? branchExists;
  const addWorktreeFn = deps.addWorktreeFn ?? addNamedWorktree;
  const addExistingBranchWorktreeFn = deps.addExistingBranchWorktreeFn ?? addExistingBranchWorktree;
  const pruneWorktreesFn = deps.pruneWorktreesFn ?? pruneWorktrees;
  const listWorktreesFn = deps.listWorktreesFn ?? listWorktrees;
  const wtDir = (deps.worktreeDirFn ?? defaultUnitWorktreeDir)(src, name);

  /** True when `dir` is a LIVE linked worktree of `from` checked out on EXACTLY our `branch`. */
  const isLiveOnBranch = (dir: string, from: string): boolean =>
    existsFn(dir) &&
    listWorktreesFn(from).some((w) => path.resolve(w.path) === path.resolve(dir) && w.branch === branch);

  const registry = ctx.store.data.build.unitWorktrees ?? {};
  const existing = registry[name];
  let repairing = false;
  if (existing) {
    if (!deps.reverifyReuse) {
      // Fast registry-hit reuse: same dir, same branch — the generator's prior WIP is still there.
      // (No fs/git probe — the generator role relies on this cheap path across rounds.)
      return { dir: existing.dir, branch: existing.branch, src: existing.src, created: false };
    }
    // RESUME reuse: VERIFY the registered tree is still live on the expected branch before reusing.
    if (existing.branch === branch && isLiveOnBranch(existing.dir, existing.src ?? src)) {
      return { dir: existing.dir, branch: existing.branch, src: existing.src, created: false };
    }
    // Stale entry (dir removed, or now on another branch): drop it, prune git's dangling registration,
    // and fall through to recreate under the SAME name/branch (reusing a surviving branch if present).
    repairing = true;
    const dropped = { ...registry };
    delete dropped[name];
    ctx.store.data.build.unitWorktrees = dropped;
    pruneWorktreesFn(existing.src ?? src);
  }

  const currentRegistry = ctx.store.data.build.unitWorktrees ?? {};

  // No adopting foreign state: a pre-existing dir not in OUR registry is someone else's — UNLESS
  // git ground truth confirms it's a live worktree on EXACTLY our branch, in which case it's OUR
  // own tree whose registry entry a racing writer dropped (see the doc comment above). Self-heal by
  // adopting: repair + persist the entry, return created:false. Anything less exact (no worktree at
  // that path, or a worktree on some other branch) falls through to the original refusal.
  if (existsFn(wtDir)) {
    if (isLiveOnBranch(wtDir, src)) {
      ctx.store.data.build.unitWorktrees = { ...currentRegistry, [name]: { dir: wtDir, branch, src } };
      await ctx.store.save();
      return { dir: wtDir, branch, src, created: false };
    }
    throw new Error(
      `unitWorktree ${JSON.stringify(name)}: target path already exists and is not a registered unit worktree: ${wtDir}. ` +
        `Refusing to adopt it — remove it, or pick another name.`
    );
  }
  // A surviving `sparra/<name>` branch is foreign on a FRESH create (refuse), but on a REPAIR it's our
  // own — the worktree dir vanished while the branch (with committed WIP) lived; re-attach a tree to it.
  const branchLives = branchExistsFn(src, branch);
  let added: { ok: boolean; out: string };
  if (branchLives && !repairing) {
    throw new Error(
      `unitWorktree ${JSON.stringify(name)}: branch ${branch} already exists and is not a registered unit worktree. ` +
        `Refusing to adopt it — delete it, or pick another name.`
    );
  }
  added = branchLives ? addExistingBranchWorktreeFn(src, wtDir, branch) : addWorktreeFn(src, wtDir, branch);
  if (!added.ok) {
    throw new Error(`unitWorktree ${JSON.stringify(name)}: could not create the worktree at ${wtDir} on ${branch}: ${added.out.trim()}`);
  }
  ctx.store.data.build.unitWorktrees = { ...currentRegistry, [name]: { dir: wtDir, branch, src } };
  await ctx.store.save();
  return { dir: wtDir, branch, src, created: true };
}

/** Injectable git seams for disposal — tests inject fakes so no real repo is required. */
export interface RemoveUnitWorktreeDeps {
  isDirtyFn?: typeof isDirty;
  defaultBranchFn?: typeof defaultBranch;
  isBranchMergedFn?: typeof isBranchMerged;
  removeWorktreeFn?: typeof removeWorktree;
  deleteBranchFn?: typeof deleteBranch;
}

export interface RemoveUnitWorktreeResult {
  ok: boolean;
  message: string;
  removedDir?: string;
  removedBranch?: string;
}

/**
 * WIP-safe teardown of the unit worktree `name`: removes the worktree, deletes its branch, and drops
 * the registry entry. By DEFAULT it REFUSES a dirty tree (uncommitted changes) and an unmerged
 * branch (git's own `-d` safety), each overridable ONLY by `force`. An unknown name is a clear error
 * listing the known names (nothing is removed, the registry is untouched). On `force` the worktree
 * is force-removed and the branch `-D`-deleted. The registry entry is dropped whenever a removal was
 * attempted, so a partially-failed teardown doesn't leave a dangling registration.
 */
export async function removeUnitWorktree(
  ctx: Ctx,
  name: string,
  opts: { force?: boolean } = {},
  deps: RemoveUnitWorktreeDeps = {}
): Promise<RemoveUnitWorktreeResult> {
  const registry = ctx.store.data.build.unitWorktrees ?? {};
  const rec = registry[name];
  if (!rec) {
    const known = Object.keys(registry);
    return {
      ok: false,
      message: `unknown unit worktree ${JSON.stringify(name)}. Known: ${known.length ? known.join(", ") : "(none)"}.`,
    };
  }

  const force = !!opts.force;
  const isDirtyFn = deps.isDirtyFn ?? isDirty;
  const defaultBranchFn = deps.defaultBranchFn ?? defaultBranch;
  const isBranchMergedFn = deps.isBranchMergedFn ?? isBranchMerged;
  const removeWorktreeFn = deps.removeWorktreeFn ?? removeWorktree;
  const deleteBranchFn = deps.deleteBranchFn ?? deleteBranch;

  // Refuse a dirty tree unless forced — never silently discard uncommitted WIP.
  if (!force && isDirtyFn(rec.dir)) {
    return {
      ok: false,
      message: `unit worktree ${JSON.stringify(name)} has uncommitted changes (${rec.dir}); refusing to remove. Commit/stash the work, or pass force.`,
    };
  }
  // Refuse an unmerged branch unless forced (the `git branch -d` safety) — never lose unmerged commits.
  const base = defaultBranchFn(rec.src);
  if (!force && !(base && isBranchMergedFn(rec.src, rec.branch, base))) {
    return {
      ok: false,
      message:
        `unit worktree ${JSON.stringify(name)} branch ${rec.branch} is not merged into ${base || "the default branch"}; ` +
        `refusing to remove. Merge it first, or pass force.`,
    };
  }

  const rmWt = removeWorktreeFn(rec.src, rec.dir, force);
  const delBr = deleteBranchFn(rec.src, rec.branch, force);
  // Drop the registration regardless — a lingering entry for a removed tree is worse than a
  // best-effort git failure the message surfaces.
  const next = { ...registry };
  delete next[name];
  ctx.store.data.build.unitWorktrees = next;
  await ctx.store.save();

  const problems: string[] = [];
  if (!rmWt.ok) problems.push(`worktree remove: ${rmWt.out.trim()}`);
  if (!delBr.ok) problems.push(`branch delete: ${delBr.out.trim()}`);
  return {
    ok: rmWt.ok && delBr.ok,
    message: problems.length
      ? `unit worktree ${JSON.stringify(name)} removed with warnings (registration dropped): ${problems.join("; ")}.`
      : `removed unit worktree ${JSON.stringify(name)} (${rec.dir}) and its branch ${rec.branch}.`,
    removedDir: rec.dir,
    removedBranch: rec.branch,
  };
}
