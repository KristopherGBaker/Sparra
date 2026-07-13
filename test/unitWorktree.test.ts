import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  validateUnitWorktreeName,
  unitWorktreeBranch,
  defaultUnitWorktreeDir,
  ensureUnitWorktree,
  removeUnitWorktree,
} from "../src/build/unitWorktree.ts";
import { branchExists, isDirty, isLinkedWorktree, listWorktrees } from "../src/util/git.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";

// Persistent per-unit WRITER worktrees (U-W). Real git ops run in a THROWAWAY temp repo (one per
// test that mutates it — unique dirs, no shared state); the validator + foreign-adoption guard use
// pure fakes. This file lives in vitest.config.ts's "real-git" project (sequence.groupOrder: 1),
// which Vitest's scheduler dispatches only once every group-0 project ("unit", holding the rest of
// the suite) has fully drained — verified by instrumenting both projects' start/end timestamps, the
// real-git file's first test starts only after the last group-0 file's teardown completes, so its
// git subprocesses never contend with the parallel suite for CPU. The bounded per-test timeout below
// still guards against a genuinely hung subprocess; it is not what buys the isolation.
const GIT_IT = { timeout: 20_000 };

function g(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

/** A throwaway git repo on branch `main` with one commit. */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-unitwt-"));
  g(dir, ["init"]);
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".sparra/\n");
  g(dir, ["add", "-A"]);
  g(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "base"]);
  g(dir, ["branch", "-M", "main"]); // deterministic default branch for the merged check
  return dir;
}

async function makeCtx(root: string): Promise<Ctx> {
  const paths = new Paths(root);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  return { root, paths, config: defaultConfig(), store };
}

function real(p: string): string {
  return fs.realpathSync(p);
}

describe("validateUnitWorktreeName", () => {
  it("accepts safe single-segment names", () => {
    for (const ok of ["u1", "unit-a", "U_2", "a.b", "feature123"]) {
      expect(validateUnitWorktreeName(ok)).toBeNull();
    }
  });

  it.each([
    ["", "empty"],
    ["   ", "whitespace"],
    ["a b", "embedded whitespace"],
    ["a/b", "slash separator"],
    ["a\\b", "backslash separator"],
    ["..", "dotdot"],
    ["a..b", "embedded dotdot"],
    ["/abs", "absolute"],
    ["-flag", "leading dash"],
    [".hidden", "leading dot"],
    ["trailing.", "trailing dot"],
    ["a~b", "tilde (git-ref-invalid)"],
    ["a:b", "colon (git-ref-invalid)"],
    ["a?b", "question (git-ref-invalid)"],
    ["a*b", "star (git-ref-invalid)"],
    ["a b\tc", "tab"],
  ])("rejects %s (%s) with a clear message", (name) => {
    const err = validateUnitWorktreeName(name);
    expect(err).toBeTruthy();
    expect(typeof err).toBe("string");
  });

  it("rejects non-strings", () => {
    expect(validateUnitWorktreeName(undefined as unknown as string)).toBeTruthy();
    expect(validateUnitWorktreeName(42 as unknown as string)).toBeTruthy();
  });

  it("branch + dir helpers are name-derived and distinct per name", () => {
    expect(unitWorktreeBranch("u1")).toBe("sparra/u1");
    expect(defaultUnitWorktreeDir("/x/proj", "u1")).toBe(path.join("/x", "proj-unit-u1"));
    expect(defaultUnitWorktreeDir("/x/proj", "u2")).not.toBe(defaultUnitWorktreeDir("/x/proj", "u1"));
  });
});

describe("ensureUnitWorktree — create / reuse / restart / foreign guard", () => {
  it("first use creates a linked worktree on a sparra/ branch cut from HEAD + registers it", GIT_IT, async () => {
    const repo = makeRepo();
    try {
      const ctx = await makeCtx(repo);
      const wt = await ensureUnitWorktree(ctx, "u1", repo);
      expect(wt.created).toBe(true);
      expect(wt.branch).toBe("sparra/u1");
      expect(path.resolve(wt.dir)).not.toBe(path.resolve(repo)); // sibling, outside the source tree
      expect(path.relative(repo, wt.dir).startsWith("..")).toBe(true);
      expect(isLinkedWorktree(wt.dir)).toBe(true);
      expect(branchExists(repo, "sparra/u1")).toBe(true);
      // Registered + persisted; no unrelated build state touched.
      expect(ctx.store.data.build.unitWorktrees!.u1).toEqual({ dir: wt.dir, branch: "sparra/u1", src: repo });
      expect(ctx.store.data.build.branch).toBeUndefined();
      expect(ctx.store.data.build.workspaceDir).toBeUndefined();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("second call REUSES: same dir/branch, no duplicate registry/worktree/branch, WIP survives; state survives restart", GIT_IT, async () => {
    const repo = makeRepo();
    try {
      const ctx = await makeCtx(repo);
      const first = await ensureUnitWorktree(ctx, "u1", repo);
      // WIP the generator would leave between rounds.
      const wip = path.join(first.dir, "wip.txt");
      fs.writeFileSync(wip, "round-1 work\n");
      const worktreesBefore = listWorktrees(repo).length;

      // Simulated process restart: fresh ctx/store re-read from disk.
      const paths = new Paths(repo);
      const store = (await StateStore.load(paths))!;
      const ctx2: Ctx = { root: repo, paths, config: defaultConfig(), store };
      expect(store.data.build.unitWorktrees!.u1).toBeDefined(); // registry persisted to disk

      const second = await ensureUnitWorktree(ctx2, "u1", repo);
      expect(second.created).toBe(false);
      expect(second.dir).toBe(first.dir);
      expect(second.branch).toBe(first.branch);
      // No duplicate anything.
      expect(Object.keys(store.data.build.unitWorktrees!)).toEqual(["u1"]);
      expect(listWorktrees(repo).length).toBe(worktreesBefore);
      expect(g(repo, ["for-each-ref", "refs/heads/sparra/u1"]).trim()).not.toBe("");
      // WIP survives byte-identical.
      expect(fs.readFileSync(wip, "utf8")).toBe("round-1 work\n");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("throws on an invalid name BEFORE any git/fs action", GIT_IT, async () => {
    const repo = makeRepo();
    try {
      const ctx = await makeCtx(repo);
      await expect(ensureUnitWorktree(ctx, "../escape", repo)).rejects.toThrow(/invalid unitWorktree name/i);
      await expect(ensureUnitWorktree(ctx, "", repo)).rejects.toThrow(/invalid unitWorktree name/i);
      // Nothing was registered or created.
      expect(ctx.store.data.build.unitWorktrees).toBeUndefined();
      expect(listWorktrees(repo).map((w) => real(w.path))).toEqual([real(repo)]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses to ADOPT a foreign dir not in the registry", GIT_IT, async () => {
    const repo = makeRepo();
    try {
      const ctx = await makeCtx(repo);
      await expect(
        ensureUnitWorktree(ctx, "u1", repo, { existsFn: () => true })
      ).rejects.toThrow(/already exists and is not a registered unit worktree/i);
      expect(ctx.store.data.build.unitWorktrees).toBeUndefined();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses to ADOPT a foreign branch not in the registry", GIT_IT, async () => {
    const repo = makeRepo();
    try {
      const ctx = await makeCtx(repo);
      await expect(
        ensureUnitWorktree(ctx, "u1", repo, { existsFn: () => false, branchExistsFn: () => true })
      ).rejects.toThrow(/branch sparra\/u1 already exists and is not a registered/i);
      expect(ctx.store.data.build.unitWorktrees).toBeUndefined();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("ensureUnitWorktree — self-heal (registry-race adoption)", () => {
  const wtDir = "/x/proj-unit-u1"; // fixed, fake path — the fakes below mean no real fs/git touches it

  // These cases exercise the adopt/reconcile DECISION only (pure fakes for the git/fs seams); the
  // ctx just needs a real, writable `.sparra` scaffold for `store.save()` to land in — a throwaway
  // temp dir, not the fake `wtDir` above, which is never actually created on disk.
  async function makeSelfHealCtx(): Promise<{ ctx: Ctx; root: string }> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-unitwt-selfheal-"));
    return { ctx: await makeCtx(root), root };
  }

  it("SELF-HEALS: adopts a dir git confirms is a live worktree on exactly sparra/<name>", async () => {
    const { ctx, root } = await makeSelfHealCtx();
    try {
      const listCalls: string[] = [];
      const wt = await ensureUnitWorktree(ctx, "u1", root, {
        existsFn: (p) => p === wtDir,
        worktreeDirFn: () => wtDir,
        listWorktreesFn: (src) => {
          listCalls.push(src);
          return [{ path: wtDir, branch: "sparra/u1" }];
        },
        // If adoption were reached without repairing the state, these would blow up the test —
        // neither should ever be called on the adopt path.
        addWorktreeFn: () => {
          throw new Error("must not create — should adopt instead");
        },
        branchExistsFn: () => {
          throw new Error("must not probe branchExists on the adopt path");
        },
      });
      expect(wt).toEqual({ dir: wtDir, branch: "sparra/u1", src: root, created: false });
      expect(listCalls).toEqual([root]); // git ground truth WAS consulted
      // Registry entry repaired + persisted (this is the self-heal).
      expect(ctx.store.data.build.unitWorktrees!.u1).toEqual({ dir: wtDir, branch: "sparra/u1", src: root });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("is IDEMPOTENT after a self-heal: the next call hits the registry fast-path, no second git probe", async () => {
    const { ctx, root } = await makeSelfHealCtx();
    try {
      const first = await ensureUnitWorktree(ctx, "u1", root, {
        existsFn: (p) => p === wtDir,
        worktreeDirFn: () => wtDir,
        listWorktreesFn: () => [{ path: wtDir, branch: "sparra/u1" }],
      });
      expect(first.created).toBe(false);

      const second = await ensureUnitWorktree(ctx, "u1", root, {
        existsFn: () => {
          throw new Error("fast-path must not touch fs");
        },
        listWorktreesFn: () => {
          throw new Error("fast-path must not re-probe git after a self-heal");
        },
      });
      expect(second).toEqual({ dir: wtDir, branch: "sparra/u1", src: root, created: false });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("MUTATION GUARD — still THROWS when the dir is a worktree but on the WRONG branch (not sparra/u1)", async () => {
    const { ctx, root } = await makeSelfHealCtx();
    try {
      await expect(
        ensureUnitWorktree(ctx, "u1", root, {
          existsFn: (p) => p === wtDir,
          worktreeDirFn: () => wtDir,
          // Same dir IS a live worktree — but checked out on a DIFFERENT branch. A guard loosened to
          // "any worktree at that path" (dropping the exact-branch check) would wrongly adopt this.
          listWorktreesFn: () => [{ path: wtDir, branch: "sparra/some-other-unit" }],
        })
      ).rejects.toThrow(/already exists and is not a registered unit worktree/i);
      expect(ctx.store.data.build.unitWorktrees).toBeUndefined(); // nothing adopted/registered
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("MUTATION GUARD — still THROWS when the dir exists but git reports NO worktree there (plain dir)", async () => {
    const { ctx, root } = await makeSelfHealCtx();
    try {
      await expect(
        ensureUnitWorktree(ctx, "u1", root, {
          existsFn: (p) => p === wtDir,
          worktreeDirFn: () => wtDir,
          // git ground truth has NOTHING at this path — a guard loosened to "existsFn alone is enough
          // to adopt" (dropping the git-confirmation check entirely) would wrongly adopt this.
          listWorktreesFn: () => [],
        })
      ).rejects.toThrow(/already exists and is not a registered unit worktree/i);
      expect(ctx.store.data.build.unitWorktrees).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("still THROWS the branch-collision error when branchExists is true but there's no worktree at the target dir", async () => {
    const { ctx, root } = await makeSelfHealCtx();
    try {
      await expect(
        ensureUnitWorktree(ctx, "u1", root, {
          existsFn: () => false, // no dir at the target path
          branchExistsFn: () => true, // but the branch exists, unregistered
          listWorktreesFn: () => {
            throw new Error("must not probe git worktree list when the dir doesn't even exist");
          },
        })
      ).rejects.toThrow(/branch sparra\/u1 already exists and is not a registered/i);
      expect(ctx.store.data.build.unitWorktrees).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ensureUnitWorktree — reverifyReuse (resume reuse-or-recreate)", () => {
  const wtDir = "/x/proj-unit-u1"; // fixed fake path — fakes below mean no real fs/git touches it

  async function makeCtx2(): Promise<{ ctx: Ctx; root: string }> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-unitwt-reverify-"));
    return { ctx: await makeCtx(root), root };
  }

  it("REUSES a registered entry that git confirms is a LIVE worktree on the expected branch (no recreate)", async () => {
    const { ctx, root } = await makeCtx2();
    try {
      // Pre-seed the registry as if a prior run created the tree.
      ctx.store.data.build.unitWorktrees = { u1: { dir: wtDir, branch: "sparra/u1", src: root } };
      const wt = await ensureUnitWorktree(ctx, "u1", root, {
        reverifyReuse: true,
        existsFn: (p) => p === wtDir,
        worktreeDirFn: () => wtDir,
        listWorktreesFn: () => [{ path: wtDir, branch: "sparra/u1" }],
        addWorktreeFn: () => {
          throw new Error("must NOT recreate a live worktree");
        },
        addExistingBranchWorktreeFn: () => {
          throw new Error("must NOT re-attach a live worktree");
        },
      });
      expect(wt).toEqual({ dir: wtDir, branch: "sparra/u1", src: root, created: false });
      expect(ctx.store.data.build.unitWorktrees!.u1).toEqual({ dir: wtDir, branch: "sparra/u1", src: root });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("RECREATES when the registered directory no longer exists (stale entry, branch also gone)", async () => {
    const { ctx, root } = await makeCtx2();
    try {
      ctx.store.data.build.unitWorktrees = { u1: { dir: wtDir, branch: "sparra/u1", src: root } };
      const created: Array<{ dir: string; branch: string }> = [];
      let pruned = 0;
      const wt = await ensureUnitWorktree(ctx, "u1", root, {
        reverifyReuse: true,
        existsFn: () => false, // dir gone
        worktreeDirFn: () => wtDir,
        listWorktreesFn: () => [], // git has no live worktree there
        branchExistsFn: () => false, // branch gone too → fresh -b create
        pruneWorktreesFn: () => { pruned += 1; return { ok: true, out: "" }; },
        addWorktreeFn: (_s, dir, branch) => { created.push({ dir, branch }); return { ok: true, out: "" }; },
        addExistingBranchWorktreeFn: () => { throw new Error("branch gone → must not re-attach"); },
      });
      expect(wt.created).toBe(true); // RECREATED, not returned as created:false for a nonexistent dir
      expect(created).toEqual([{ dir: wtDir, branch: "sparra/u1" }]);
      expect(pruned).toBe(1);
      expect(ctx.store.data.build.unitWorktrees!.u1).toEqual({ dir: wtDir, branch: "sparra/u1", src: root });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("REPAIRS by re-attaching the SURVIVING branch when the dir vanished but the branch (with WIP) lived", async () => {
    const { ctx, root } = await makeCtx2();
    try {
      ctx.store.data.build.unitWorktrees = { u1: { dir: wtDir, branch: "sparra/u1", src: root } };
      const attached: Array<{ dir: string; branch: string }> = [];
      const wt = await ensureUnitWorktree(ctx, "u1", root, {
        reverifyReuse: true,
        existsFn: () => false, // dir gone
        worktreeDirFn: () => wtDir,
        listWorktreesFn: () => [],
        branchExistsFn: () => true, // branch SURVIVED (committed WIP) → re-attach, don't -b
        pruneWorktreesFn: () => ({ ok: true, out: "" }),
        addWorktreeFn: () => { throw new Error("branch survived → must re-attach, not create a new branch"); },
        addExistingBranchWorktreeFn: (_s, dir, branch) => { attached.push({ dir, branch }); return { ok: true, out: "" }; },
      });
      expect(wt.created).toBe(true);
      expect(attached).toEqual([{ dir: wtDir, branch: "sparra/u1" }]); // branch tip preserved
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("RECREATES when the registered dir is now a worktree on a DIFFERENT branch (stale reuse must not adopt)", async () => {
    const { ctx, root } = await makeCtx2();
    try {
      ctx.store.data.build.unitWorktrees = { u1: { dir: wtDir, branch: "sparra/u1", src: root } };
      // The dir exists but git reports it checked out on some OTHER branch → NOT a valid reuse.
      // With the dir occupied, the recreate path must refuse to adopt foreign state (throws).
      await expect(
        ensureUnitWorktree(ctx, "u1", root, {
          reverifyReuse: true,
          existsFn: (p) => p === wtDir,
          worktreeDirFn: () => wtDir,
          listWorktreesFn: () => [{ path: wtDir, branch: "sparra/some-other" }],
        })
      ).rejects.toThrow(/already exists and is not a registered unit worktree/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("removeUnitWorktree — WIP-safe teardown", () => {
  it("refuses a DIRTY tree by default, force removes it, deregisters", GIT_IT, async () => {
    const repo = makeRepo();
    try {
      const ctx = await makeCtx(repo);
      const wt = await ensureUnitWorktree(ctx, "u1", repo);
      fs.writeFileSync(path.join(wt.dir, "dirty.txt"), "uncommitted\n"); // dirty
      expect(isDirty(wt.dir)).toBe(true);

      const refused = await removeUnitWorktree(ctx, "u1");
      expect(refused.ok).toBe(false);
      expect(refused.message).toMatch(/uncommitted changes/i);
      expect(ctx.store.data.build.unitWorktrees!.u1).toBeDefined(); // still registered
      expect(fs.existsSync(wt.dir)).toBe(true);

      const forced = await removeUnitWorktree(ctx, "u1", { force: true });
      expect(forced.ok).toBe(true);
      expect(fs.existsSync(wt.dir)).toBe(false);
      expect(branchExists(repo, "sparra/u1")).toBe(false);
      expect(ctx.store.data.build.unitWorktrees!.u1).toBeUndefined();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses an UNMERGED branch by default, force removes it", GIT_IT, async () => {
    const repo = makeRepo();
    try {
      const ctx = await makeCtx(repo);
      const wt = await ensureUnitWorktree(ctx, "u1", repo);
      // Commit on the unit branch so its tip diverges from main → unmerged.
      fs.writeFileSync(path.join(wt.dir, "feature.txt"), "committed feature\n");
      g(wt.dir, ["add", "-A"]);
      g(wt.dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "feature"]);

      const refused = await removeUnitWorktree(ctx, "u1");
      expect(refused.ok).toBe(false);
      expect(refused.message).toMatch(/not merged/i);
      expect(fs.existsSync(wt.dir)).toBe(true);
      expect(branchExists(repo, "sparra/u1")).toBe(true);

      const forced = await removeUnitWorktree(ctx, "u1", { force: true });
      expect(forced.ok).toBe(true);
      expect(fs.existsSync(wt.dir)).toBe(false);
      expect(branchExists(repo, "sparra/u1")).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("CLEAN removal (merged, not dirty) succeeds by default", GIT_IT, async () => {
    const repo = makeRepo();
    try {
      const ctx = await makeCtx(repo);
      const wt = await ensureUnitWorktree(ctx, "u1", repo);
      const res = await removeUnitWorktree(ctx, "u1");
      expect(res.ok).toBe(true);
      expect(res.removedDir).toBe(wt.dir);
      expect(res.removedBranch).toBe("sparra/u1");
      expect(fs.existsSync(wt.dir)).toBe(false);
      expect(branchExists(repo, "sparra/u1")).toBe(false);
      expect(listWorktrees(repo).map((w) => real(w.path))).toEqual([real(repo)]);
      expect(ctx.store.data.build.unitWorktrees!.u1).toBeUndefined();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("an UNKNOWN name is a clear error listing the known names (nothing removed)", GIT_IT, async () => {
    const repo = makeRepo();
    try {
      const ctx = await makeCtx(repo);
      await ensureUnitWorktree(ctx, "u1", repo);
      const res = await removeUnitWorktree(ctx, "nope");
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/unknown unit worktree/i);
      expect(res.message).toContain("u1"); // lists the known name
      expect(ctx.store.data.build.unitWorktrees!.u1).toBeDefined(); // untouched
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
