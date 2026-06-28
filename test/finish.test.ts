import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmdFinish, type FinishDeps } from "../src/phases/finish.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import type { ItemState } from "../src/state.ts";

function item(status: ItemState["status"]): ItemState {
  return { status, round: 1, pivots: 0, criterionFailStreak: {} };
}

async function project(
  opts: { itemStatus?: ItemState["status"]; branch?: string; workspaceDir?: string } = {}
): Promise<{ ctx: Ctx; dir: string; paths: Paths }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-finish-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  store.data.phase = "done";
  store.data.build.runId = "build-x";
  store.data.build.branch = opts.branch ?? "sparra/build-x";
  store.data.build.workspaceDir = opts.workspaceDir ?? dir;
  store.data.build.items = { "item-001": item(opts.itemStatus ?? "passed") };
  store.data.freeze = { frozenAt: "2026-06-25T00:00:00Z" };
  await store.save();

  fs.writeFileSync(paths.plan, "# Plan: First Feature\n\nold plan content");
  fs.writeFileSync(paths.frozenPlan, "frozen first feature");
  fs.writeFileSync(paths.workitemsFile, JSON.stringify([{ id: "item-001", title: "t" }]));
  fs.writeFileSync(paths.contractFile("item-001"), "contract");
  fs.writeFileSync(paths.verdictFile("item-001", 1), "verdict");
  fs.writeFileSync(paths.reviewFile("item-001", 1), "review");
  fs.writeFileSync(paths.holdout, "secret acceptance checks");
  fs.writeFileSync(paths.memory, "# memory\n- learned");

  return { ctx: { root: dir, paths, config: defaultConfig(), store } as unknown as Ctx, dir, paths };
}

/** A FinishDeps that records calls and makes NO live git/gh/network calls. */
function fakeDeps(over: Partial<FinishDeps> = {}): FinishDeps {
  return {
    isDirty: vi.fn(() => false),
    worktreeForBranch: vi.fn(() => null),
    defaultBranch: vi.fn(() => "main"),
    mergeFfOnly: vi.fn(() => ({ ok: true, out: "" })),
    removeWorktree: vi.fn(() => ({ ok: true, out: "" })),
    deleteBranch: vi.fn(() => ({ ok: true, out: "" })),
    checkout: vi.fn(() => ({ ok: true, out: "" })),
    isTracked: vi.fn(() => false),
    ghAvailable: vi.fn(() => false),
    ghPrCreate: vi.fn(() => ({ ok: true, out: "" })),
    branchExists: vi.fn(() => true),
    currentBranch: vi.fn(() => null),
    confirm: vi.fn(() => false),
    ...over,
  };
}

describe("cmdFinish", () => {
  it("refuses on a dirty tree with no side effects", async () => {
    const { ctx, dir, paths } = await project();
    const deps = fakeDeps({ isDirty: vi.fn(() => true) });
    const r = await cmdFinish(ctx, { merge: true, yes: true, teardown: true }, deps);

    expect(r.refused).toBeTruthy();
    expect(deps.mergeFfOnly).not.toHaveBeenCalled();
    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(deps.deleteBranch).not.toHaveBeenCalled();
    // No archive happened.
    expect(fs.existsSync(paths.plan)).toBe(true);
    expect(fs.existsSync(paths.cycleDir("0001-first-feature"))).toBe(false);
    process.exitCode = 0;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses on a mid-flight item with no side effects", async () => {
    const { ctx, dir, paths } = await project({ itemStatus: "building" });
    const deps = fakeDeps();
    const r = await cmdFinish(ctx, { teardown: true }, deps);

    expect(r.refused).toBeTruthy();
    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.plan)).toBe(true);
    process.exitCode = 0;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("archiveCycle moves the working set INCLUDING HOLDOUT.md into the cycle dir", async () => {
    const { ctx, dir, paths } = await project();
    const deps = fakeDeps();
    const r = await cmdFinish(ctx, {}, deps);

    const cd = paths.cycleDir("0001-first-feature");
    expect(r.archived).toBe(true);
    expect(fs.existsSync(path.join(cd, "PLAN.md"))).toBe(true);
    expect(fs.existsSync(path.join(cd, "HOLDOUT.md"))).toBe(true);
    expect(fs.existsSync(path.join(cd, "frozen", "PLAN.frozen.md"))).toBe(true);
    expect(fs.existsSync(path.join(cd, "contracts", "item-001.contract.md"))).toBe(true);
    // The live holdout no longer bleeds into the next cycle.
    expect(fs.existsSync(paths.holdout)).toBe(false);
    expect(fs.existsSync(paths.plan)).toBe(false);
    // Default touches nothing in git.
    expect(deps.mergeFfOnly).not.toHaveBeenCalled();
    expect(deps.ghPrCreate).not.toHaveBeenCalled();
    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(deps.deleteBranch).not.toHaveBeenCalled();
    expect(r.landed).toBe("none");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("--merge takes the ff-only path then tears down (merged branch deletes with -d)", async () => {
    // exists(worktreeDir) must be true for removeWorktree to fire — point at a real dir.
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-wt-"));
    const { ctx, dir, paths } = await project();
    const deps = fakeDeps({ worktreeForBranch: vi.fn(() => real) });

    const r = await cmdFinish(ctx, { merge: true, yes: true }, deps);

    // ff-only must explicitly target the default branch (main), not the current HEAD.
    expect(deps.mergeFfOnly).toHaveBeenCalledWith(dir, "main", "sparra/build-x");
    expect(r.landed).toBe("merge");
    expect(deps.removeWorktree).toHaveBeenCalledWith(dir, real);
    // merged-only delete: force=false
    expect(deps.deleteBranch).toHaveBeenCalledWith(dir, "sparra/build-x", false);
    expect(r.tornDown).toBe(true);
    // Branch cleared from state, then archived.
    expect(ctx.store.data.build.branch).toBeUndefined();
    expect(fs.existsSync(paths.cycleDir("0001-first-feature"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
  });

  it("--merge refuses (no self-merge) when the resolved default branch equals the source branch", async () => {
    // Branch-in-place: defaultBranch resolves to the Sparra branch itself — merging it would be a
    // silent no-op. finish must REFUSE before touching git, teardown, or archive.
    const { ctx, dir, paths } = await project();
    const deps = fakeDeps({ defaultBranch: vi.fn(() => "sparra/build-x") });
    const r = await cmdFinish(ctx, { merge: true, yes: true }, deps);

    expect(r.refused).toBeTruthy();
    expect(r.landed).toBe("none");
    expect(deps.mergeFfOnly).not.toHaveBeenCalled();
    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(deps.deleteBranch).not.toHaveBeenCalled();
    // Nothing archived — the refusal is a hard stop with no side effects.
    expect(fs.existsSync(paths.cycleDir("0001-first-feature"))).toBe(false);
    process.exitCode = 0;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("branch-in-place teardown: never `git worktree remove`s the main checkout; deletes after checking out default", async () => {
    // worktreeForBranch returns ctx.root itself (the Sparra branch is checked out in place).
    const { ctx, dir } = await project();
    const deps = fakeDeps({ worktreeForBranch: vi.fn(() => dir) });
    const r = await cmdFinish(ctx, { teardown: true }, deps);

    // The main checkout is NOT a separate worktree — `git worktree remove` must never fire on it.
    expect(deps.removeWorktree).not.toHaveBeenCalled();
    // The in-place branch is vacated onto the resolved default branch before being deleted.
    expect(deps.checkout).toHaveBeenCalledWith(dir, "main");
    expect(deps.deleteBranch).toHaveBeenCalledWith(dir, "sparra/build-x", false);
    expect(r.tornDown).toBe(true);
    expect(ctx.store.data.build.branch).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("branch-in-place teardown preserves state when the default branch can't be resolved distinctly", async () => {
    const { ctx, dir } = await project();
    const deps = fakeDeps({ worktreeForBranch: vi.fn(() => dir), defaultBranch: vi.fn(() => "") });
    const r = await cmdFinish(ctx, { teardown: true }, deps);

    // Can't vacate the in-place branch ⇒ refuse to delete; never touch the main checkout.
    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(deps.checkout).not.toHaveBeenCalled();
    expect(deps.deleteBranch).not.toHaveBeenCalled();
    expect(r.tornDown).toBeFalsy();
    expect(ctx.store.data.build.branch).toBe("sparra/build-x");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("--merge aborts (no teardown) when main has diverged", async () => {
    const { ctx, dir } = await project();
    const deps = fakeDeps({ mergeFfOnly: vi.fn(() => ({ ok: false, out: "not possible to fast-forward" })) });
    const r = await cmdFinish(ctx, { merge: true, yes: true }, deps);

    // Even on abort, the merge must have explicitly targeted the default branch, not HEAD.
    expect(deps.mergeFfOnly).toHaveBeenCalledWith(dir, "main", "sparra/build-x");
    expect(r.diverged).toBe(true);
    expect(r.landed).toBe("none");
    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(deps.deleteBranch).not.toHaveBeenCalled();
    process.exitCode = 0;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("--merge without confirmation does not merge", async () => {
    const { ctx, dir } = await project();
    const deps = fakeDeps(); // confirm() => false, no --yes
    const r = await cmdFinish(ctx, { merge: true }, deps);
    expect(deps.mergeFfOnly).not.toHaveBeenCalled();
    expect(r.landed).toBe("none");
    process.exitCode = 0;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("teardown refuses to delete an UNMERGED branch without --force", async () => {
    const { ctx, dir } = await project();
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-wt-"));
    const deps = fakeDeps({
      worktreeForBranch: vi.fn(() => real),
      deleteBranch: vi.fn(() => ({ ok: false, out: "not fully merged" })),
    });
    const r = await cmdFinish(ctx, { teardown: true }, deps);

    // Worktree removed before the (refused) branch delete.
    expect(deps.removeWorktree).toHaveBeenCalledWith(dir, real);
    expect(deps.deleteBranch).toHaveBeenCalledWith(dir, "sparra/build-x", false);
    expect(r.tornDown).toBeFalsy();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
  });

  it("teardown on an UNMERGED branch without --force preserves build state for retry", async () => {
    const { ctx, dir } = await project();
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-wt-"));
    const deps = fakeDeps({
      worktreeForBranch: vi.fn(() => real),
      // `git branch -d` refuses an unmerged branch without --force.
      deleteBranch: vi.fn(() => ({ ok: false, out: "not fully merged" })),
    });
    const r = await cmdFinish(ctx, { teardown: true }, deps);

    // The delete is refused (merged-only, force=false) and teardown does NOT complete…
    expect(deps.deleteBranch).toHaveBeenCalledWith(dir, "sparra/build-x", false);
    expect(r.tornDown).toBeFalsy();
    // …so the branch/workspace state is PRESERVED — the user can re-run with --force.
    expect(ctx.store.data.build.branch).toBe("sparra/build-x");
    expect(ctx.store.data.build.workspaceDir).toBe(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
  });

  it("teardown --force deletes an unmerged branch with -D", async () => {
    const { ctx, dir } = await project();
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-wt-"));
    const deps = fakeDeps({ worktreeForBranch: vi.fn(() => real) });
    const r = await cmdFinish(ctx, { teardown: true, force: true }, deps);

    expect(deps.deleteBranch).toHaveBeenCalledWith(dir, "sparra/build-x", true);
    expect(r.tornDown).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
  });

  it("--pr degrades to a manual command when gh is absent (does not fail)", async () => {
    const { ctx, dir } = await project();
    const deps = fakeDeps({ ghAvailable: vi.fn(() => false) });
    const r = await cmdFinish(ctx, { pr: true }, deps);

    expect(deps.ghPrCreate).not.toHaveBeenCalled();
    expect(r.prManual).toBe(true);
    expect(r.landed).toBe("none");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("--new chains into a fresh cycle (archives + resets to plan, no double-archive)", async () => {
    const { ctx, dir, paths } = await project();
    const deps = fakeDeps();
    const r = await cmdFinish(ctx, { new: "Second Feature" }, deps);

    expect(r.chained).toBe(true);
    // cmdNew slugs the archive from the NEW title (existing `new` behavior); only ONE cycle
    // is archived — no double-archive from finish + cmdNew.
    expect(fs.existsSync(paths.cycleDir("0001-second-feature"))).toBe(true);
    expect(fs.existsSync(paths.cycleDir("0002-second-feature"))).toBe(false);
    expect(fs.existsSync(paths.cycleDir("0002-first-feature"))).toBe(false);
    expect(ctx.store.data.phase).toBe("plan");
    expect(fs.readFileSync(paths.plan, "utf8")).toContain("# Plan: Second Feature");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("HARD-STOPS the land path when HOLDOUT.md is tracked, but still archives it privately", async () => {
    const { ctx, dir, paths } = await project();
    const deps = fakeDeps({ isTracked: vi.fn(() => true), ghAvailable: vi.fn(() => true) });
    const r = await cmdFinish(ctx, { pr: true }, deps);
    expect(deps.isTracked).toHaveBeenCalled();
    // No PR opened — the tracked holdout would have leaked.
    expect(deps.ghPrCreate).not.toHaveBeenCalled();
    expect(r.landed).toBe("none");
    // Holdout archived into the cycle dir, never left in the tree.
    expect(fs.existsSync(path.join(paths.cycleDir("0001-first-feature"), "HOLDOUT.md"))).toBe(true);
    expect(fs.existsSync(paths.holdout)).toBe(false);
    process.exitCode = 0;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("--branch lets finish land/teardown when build.branch is unset", async () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-wt-"));
    const { ctx, dir } = await project();
    ctx.store.data.build.branch = undefined; // no recorded branch
    const deps = fakeDeps({ worktreeForBranch: vi.fn(() => real) });

    const r = await cmdFinish(ctx, { branch: "sparra/manual", merge: true, yes: true }, deps);

    // The explicit branch flows to the land + teardown deps.
    expect(deps.mergeFfOnly).toHaveBeenCalledWith(dir, "main", "sparra/manual");
    expect(r.landed).toBe("merge");
    expect(deps.removeWorktree).toHaveBeenCalledWith(dir, real);
    expect(deps.deleteBranch).toHaveBeenCalledWith(dir, "sparra/manual", false);
    expect(r.tornDown).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
  });

  it("auto-detects a sparra/* current branch when build.branch is unset", async () => {
    const { ctx, dir } = await project();
    ctx.store.data.build.branch = undefined;
    const deps = fakeDeps({ currentBranch: vi.fn(() => "sparra/auto") });

    const r = await cmdFinish(ctx, { merge: true, yes: true }, deps);

    expect(deps.mergeFfOnly).toHaveBeenCalledWith(dir, "main", "sparra/auto");
    expect(r.landed).toBe("merge");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT auto-detect a non-sparra (main) current branch", async () => {
    const { ctx, dir } = await project();
    ctx.store.data.build.branch = undefined;
    const deps = fakeDeps({ currentBranch: vi.fn(() => "main") });

    const r = await cmdFinish(ctx, { merge: true, yes: true, teardown: true }, deps);

    // main is never auto-selected — nothing to land or tear down.
    expect(deps.mergeFfOnly).not.toHaveBeenCalled();
    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(deps.deleteBranch).not.toHaveBeenCalled();
    expect(r.landed).toBe("none");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a non-existent --branch before any side effect", async () => {
    const { ctx, dir, paths } = await project();
    const deps = fakeDeps({ branchExists: vi.fn(() => false) });

    const r = await cmdFinish(ctx, { branch: "sparra/nope", merge: true, yes: true, teardown: true }, deps);

    expect(r.refused).toBeTruthy();
    expect(r.landed).toBe("none");
    expect(deps.mergeFfOnly).not.toHaveBeenCalled();
    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(deps.deleteBranch).not.toHaveBeenCalled();
    // Hard stop: nothing archived.
    expect(fs.existsSync(paths.cycleDir("0001-first-feature"))).toBe(false);
    process.exitCode = 0;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an explicit --branch overrides a different build.branch in state", async () => {
    const { ctx, dir } = await project({ branch: "sparra/recorded" });
    const deps = fakeDeps();

    const r = await cmdFinish(ctx, { branch: "sparra/explicit", merge: true, yes: true }, deps);

    expect(deps.mergeFfOnly).toHaveBeenCalledWith(dir, "main", "sparra/explicit");
    expect(r.landed).toBe("merge");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("HARD-STOPS a --merge land (and teardown) when HOLDOUT.md is tracked", async () => {
    const { ctx, dir, paths } = await project();
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-wt-"));
    const deps = fakeDeps({ isTracked: vi.fn(() => true), worktreeForBranch: vi.fn(() => real) });
    const r = await cmdFinish(ctx, { merge: true, yes: true, teardown: true }, deps);

    // Neither merge nor teardown may proceed past the tracked-holdout check.
    expect(deps.mergeFfOnly).not.toHaveBeenCalled();
    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(deps.deleteBranch).not.toHaveBeenCalled();
    expect(r.landed).toBe("none");
    expect(r.tornDown).toBeFalsy();
    // Branch is preserved (not torn down) so the user can fix + retry.
    expect(ctx.store.data.build.branch).toBe("sparra/build-x");
    // Still archived privately.
    expect(fs.existsSync(path.join(paths.cycleDir("0001-first-feature"), "HOLDOUT.md"))).toBe(true);
    process.exitCode = 0;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
  });
});
