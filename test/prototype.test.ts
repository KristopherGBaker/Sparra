import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { cmdPrototype } from "../src/phases/prototype.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

/**
 * `cmdPrototype` — `git.pullBeforeWork` (opt-in ff-only upstream sync before the prototype
 * worktree is cut). Only exercised on an EXISTING project with a real git repo (the branch that
 * actually calls `prepareWorkspace`); a greenfield/no-git project never reaches the pull seam.
 */

function g(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

/** A real git repo (existing project) with one commit, so `isGitRepo && hasCommits` holds. */
async function makeExistingCtx(): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-proto-"));
  g(dir, ["init", "-b", "main"]);
  g(dir, ["config", "user.email", "t@t"]);
  g(dir, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  g(dir, ["add", "-A"]);
  g(dir, ["commit", "-m", "base"]);

  const paths = new Paths(dir);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "existing");
  // Skip the live 'auto' permission probe entirely (offline test): a known boolean short-circuits
  // ensureAutoProbed before it ever reaches the real SDK.
  store.data.autoSupported = true;
  const config = defaultConfig();
  return { ctx: { root: dir, paths, config, store }, dir };
}

function fakeRun(): (p: RunSessionParams) => Promise<RunResult> {
  return async () => ({
    ok: true,
    subtype: "success",
    resultText: "done",
    sessionId: "s",
    costUsd: 0,
    tokens: 1,
    numTurns: 1,
    hitMaxTurns: false,
    hitBudget: false,
    errors: [],
    tracePath: "",
  });
}

describe("cmdPrototype — git.pullBeforeWork", () => {
  it("knob ON: injected pullUpstream is called once with ctx.root BEFORE prepareWorkspace runs", async () => {
    const { ctx, dir } = await makeExistingCtx();
    try {
      ctx.config.git.pullBeforeWork = true;
      const calls: string[] = [];
      // Throwing here proves ORDER: if pullUpstream ran AFTER prepareWorkspace, the worktree would
      // already exist on disk by the time this throws and aborts cmdPrototype.
      await expect(
        cmdPrototype(ctx, "try an idea", {
          runSessionFn: fakeRun(),
          pullUpstream: (root) => {
            calls.push(root);
            throw new Error("boom");
          },
        })
      ).rejects.toThrow("boom");
      expect(calls).toEqual([ctx.root]);
      // No sibling worktree was created — prepareWorkspace never ran.
      const siblings = fs.readdirSync(path.dirname(dir)).filter((n) => n.startsWith(path.basename(dir) + "-"));
      expect(siblings).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("knob ON, successful pull: called once with ctx.root, note logged, worktree still created", async () => {
    const { ctx, dir } = await makeExistingCtx();
    try {
      ctx.config.git.pullBeforeWork = true;
      const calls: string[] = [];
      await cmdPrototype(ctx, "try an idea", {
        runSessionFn: fakeRun(),
        pullUpstream: (root) => {
          calls.push(root);
          return { ok: true, updated: false, note: "already up to date" };
        },
      });
      expect(calls).toEqual([ctx.root]);
      const siblings = fs.readdirSync(path.dirname(dir)).filter((n) => n.startsWith(path.basename(dir) + "-"));
      expect(siblings.length).toBe(1); // the prototype worktree WAS created
      for (const s of siblings) fs.rmSync(path.join(path.dirname(dir), s), { recursive: true, force: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("knob OFF (default): injected pullUpstream is never called; existing flow unchanged", async () => {
    const { ctx, dir } = await makeExistingCtx();
    try {
      expect(ctx.config.git.pullBeforeWork).toBe(false); // default
      let called = false;
      await cmdPrototype(ctx, "try an idea", {
        runSessionFn: fakeRun(),
        pullUpstream: () => {
          called = true;
          return { ok: true, updated: false, note: "n/a" };
        },
      });
      expect(called).toBe(false);
      const siblings = fs.readdirSync(path.dirname(dir)).filter((n) => n.startsWith(path.basename(dir) + "-"));
      expect(siblings.length).toBe(1); // prepareWorkspace still ran normally
      for (const s of siblings) fs.rmSync(path.join(path.dirname(dir), s), { recursive: true, force: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failed pull (ok:false) never blocks prototype workspace creation", async () => {
    const { ctx, dir } = await makeExistingCtx();
    try {
      ctx.config.git.pullBeforeWork = true;
      await cmdPrototype(ctx, "try an idea", {
        runSessionFn: fakeRun(),
        pullUpstream: () => ({ ok: false, updated: false, note: "offline — skipping" }),
      });
      const siblings = fs.readdirSync(path.dirname(dir)).filter((n) => n.startsWith(path.basename(dir) + "-"));
      expect(siblings.length).toBe(1); // the prototype still got its worktree despite the failed pull
      for (const s of siblings) fs.rmSync(path.join(path.dirname(dir), s), { recursive: true, force: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
