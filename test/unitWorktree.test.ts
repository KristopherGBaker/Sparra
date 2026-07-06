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
// pure fakes. Headroom for spawn contention under full-suite load, NOT a retry.
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
