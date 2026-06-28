import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmdClean, type CleanDeps } from "../src/phases/clean.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";

async function project(): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-clean-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  await store.save();
  // branchPrefix defaults to "sparra/" — exactly the prune target.
  return { ctx: { root: dir, paths, config: defaultConfig(), store } as unknown as Ctx, dir };
}

/** A CleanDeps that records calls and makes NO live git calls. */
function fakeDeps(over: Partial<CleanDeps> = {}): CleanDeps {
  return {
    listWorktrees: vi.fn(() => []),
    listBranches: vi.fn(() => []),
    isBranchMerged: vi.fn(() => true),
    removeWorktree: vi.fn(() => ({ ok: true, out: "" })),
    deleteBranch: vi.fn(() => ({ ok: true, out: "" })),
    defaultBranch: vi.fn(() => "main"),
    currentBranch: vi.fn(() => "main"),
    ...over,
  };
}

describe("cmdClean", () => {
  it("dry-run by default: lists candidates but removes/deletes NOTHING", async () => {
    const { ctx, dir } = await project();
    const deps = fakeDeps({
      listWorktrees: vi.fn(() => [
        { path: dir, branch: "main" }, // the main checkout — never a candidate
        { path: "/tmp/wt-a", branch: "sparra/build-a" },
      ]),
      listBranches: vi.fn(() => ["main", "sparra/build-a", "sparra/build-b"]),
    });

    const r = await cmdClean(ctx, {}, deps);

    expect(r.dryRun).toBe(true);
    expect(r.worktrees).toEqual(["/tmp/wt-a"]);
    expect(r.mergedBranches).toEqual(["sparra/build-a", "sparra/build-b"]);
    // Preview touches nothing.
    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(deps.deleteBranch).not.toHaveBeenCalled();
    expect(r.removedWorktrees).toEqual([]);
    expect(r.deletedBranches).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("--yes removes matching worktrees and deletes MERGED branches with -d", async () => {
    const { ctx, dir } = await project();
    const deps = fakeDeps({
      listWorktrees: vi.fn(() => [{ path: "/tmp/wt-a", branch: "sparra/build-a" }]),
      listBranches: vi.fn(() => ["sparra/build-a"]),
      isBranchMerged: vi.fn(() => true),
    });

    const r = await cmdClean(ctx, { yes: true }, deps);

    expect(r.dryRun).toBe(false);
    expect(deps.removeWorktree).toHaveBeenCalledWith(dir, "/tmp/wt-a");
    // merged ⇒ -d (force=false)
    expect(deps.deleteBranch).toHaveBeenCalledWith(dir, "sparra/build-a", false);
    expect(r.removedWorktrees).toEqual(["/tmp/wt-a"]);
    expect(r.deletedBranches).toEqual(["sparra/build-a"]);
    expect(r.skipped).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an UNMERGED branch is SKIPPED without --force", async () => {
    const { ctx, dir } = await project();
    const deps = fakeDeps({
      listBranches: vi.fn(() => ["sparra/build-x"]),
      isBranchMerged: vi.fn(() => false),
    });

    const r = await cmdClean(ctx, { yes: true }, deps);

    expect(r.unmergedBranches).toEqual(["sparra/build-x"]);
    expect(r.skipped).toEqual(["sparra/build-x"]);
    expect(deps.deleteBranch).not.toHaveBeenCalled();
    expect(r.deletedBranches).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an UNMERGED branch is DELETED with -D under --force", async () => {
    const { ctx, dir } = await project();
    const deps = fakeDeps({
      listBranches: vi.fn(() => ["sparra/build-x"]),
      isBranchMerged: vi.fn(() => false),
    });

    const r = await cmdClean(ctx, { yes: true, force: true }, deps);

    // unmerged + --force ⇒ -D (force=true)
    expect(deps.deleteBranch).toHaveBeenCalledWith(dir, "sparra/build-x", true);
    expect(r.deletedBranches).toEqual(["sparra/build-x"]);
    expect(r.skipped).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("NEVER removes the main checkout, the default branch, or the current branch — even if prefixed", async () => {
    const { ctx, dir } = await project();
    const deps = fakeDeps({
      // The main checkout itself is on a sparra-prefixed branch (branch-in-place).
      listWorktrees: vi.fn(() => [{ path: dir, branch: "sparra/current" }]),
      listBranches: vi.fn(() => ["sparra/current", "sparra/default", "sparra/other"]),
      defaultBranch: vi.fn(() => "sparra/default"),
      currentBranch: vi.fn(() => "sparra/current"),
    });

    const r = await cmdClean(ctx, { yes: true, force: true }, deps);

    // ctx.root is never a worktree candidate.
    expect(r.worktrees).toEqual([]);
    expect(deps.removeWorktree).not.toHaveBeenCalled();
    // The default + current branches are excluded; only the unrelated one is touched.
    expect(r.mergedBranches.concat(r.unmergedBranches)).toEqual(["sparra/other"]);
    expect(deps.deleteBranch).not.toHaveBeenCalledWith(dir, "sparra/default", expect.anything());
    expect(deps.deleteBranch).not.toHaveBeenCalledWith(dir, "sparra/current", expect.anything());
    expect(r.deletedBranches).toEqual(["sparra/other"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ignores branches/worktrees that do NOT carry the sparra prefix", async () => {
    const { ctx, dir } = await project();
    const deps = fakeDeps({
      listWorktrees: vi.fn(() => [
        { path: "/tmp/feature-wt", branch: "feature/foo" },
        { path: "/tmp/detached", branch: null },
        { path: "/tmp/sparra-wt", branch: "sparra/build-a" },
      ]),
      listBranches: vi.fn(() => ["main", "feature/foo", "sparra/build-a"]),
    });

    const r = await cmdClean(ctx, {}, deps);

    expect(r.worktrees).toEqual(["/tmp/sparra-wt"]);
    expect(r.mergedBranches).toEqual(["sparra/build-a"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("removes worktrees BEFORE deleting branches (a worktree pins its branch)", async () => {
    const { ctx, dir } = await project();
    const calls: string[] = [];
    const deps = fakeDeps({
      listWorktrees: vi.fn(() => [{ path: "/tmp/wt-a", branch: "sparra/build-a" }]),
      listBranches: vi.fn(() => ["sparra/build-a"]),
      removeWorktree: vi.fn(() => {
        calls.push("removeWorktree");
        return { ok: true, out: "" };
      }),
      deleteBranch: vi.fn(() => {
        calls.push("deleteBranch");
        return { ok: true, out: "" };
      }),
    });

    await cmdClean(ctx, { yes: true }, deps);

    expect(calls).toEqual(["removeWorktree", "deleteBranch"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports nothing-to-do cleanly when there are no candidates", async () => {
    const { ctx, dir } = await project();
    const deps = fakeDeps(); // empty lists
    const r = await cmdClean(ctx, {}, deps);

    expect(r.worktrees).toEqual([]);
    expect(r.mergedBranches).toEqual([]);
    expect(r.unmergedBranches).toEqual([]);
    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(deps.deleteBranch).not.toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
