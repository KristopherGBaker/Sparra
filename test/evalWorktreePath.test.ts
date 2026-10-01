import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  runRole,
  runRoleInTempWorktree,
  runRoleInUnitWorktree,
  type RoleRunRequest,
  type RoleRunResult,
} from "../src/build/roleRun.ts";
import { defaultUnitWorktreeDir } from "../src/build/unitWorktree.ts";
import type { UnitWorktreeDeps } from "../src/build/unitWorktree.ts";
import { isLinkedWorktree } from "../src/util/git.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

// U4 — relative-`workspace` path handling for the worktree'd role-run paths. Everything here uses a
// THROWAWAY temp git repo + injected fakes (fake inner runner / session / git seams) — no live
// model, no recursive real evaluation, and never a real dep copy. Tests that create a real snapshot
// (the relative-workspace and unit-wrapper cases) carry explicit headroom for full-suite load.
const GIT_IT = { timeout: 20_000 };

function g(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

/** A throwaway git repo with a committed base + a small WIP delta on top. */
function makeWipRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-u4wt-"));
  g(dir, ["init"]);
  fs.writeFileSync(path.join(dir, "tracked.txt"), "original\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".sparra/\n");
  g(dir, ["add", "-A"]);
  g(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "base"]);
  fs.writeFileSync(path.join(dir, "tracked.txt"), "modified\n");
  return dir;
}

async function makeCtx(root: string): Promise<Ctx> {
  const paths = new Paths(root);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  return { root, paths, config: defaultConfig(), store };
}

/** realpath both sides (macOS tmpdir is /var → /private/var) before comparing paths. */
function real(p: string): string {
  return fs.realpathSync(p);
}

function fakeProvision() {
  return vi.fn(() => ({ copied: [], skipped: [], failed: [], pruned: [], unprovisioned: [] }));
}

function fakeResult(over: Partial<RoleRunResult> = {}): RoleRunResult {
  return {
    ok: true,
    roleKind: "evaluator",
    backend: "claude",
    model: "m",
    resultText: "done",
    traceDir: "/t",
    sessionId: "s",
    costUsd: 0,
    tokens: 1,
    errors: [],
    ...over,
  };
}

/** What the injected inner runner observes about the request the wrapper delegated to it. */
interface Seen {
  workspace?: string;
  depSourceDir?: string;
  linked?: boolean;
}

function observer(seen: Seen) {
  return async (r: RoleRunRequest): Promise<RoleRunResult> => {
    seen.workspace = r.workspace;
    seen.depSourceDir = r.depSourceDir;
    seen.linked = isLinkedWorktree(r.workspace!);
    return fakeResult();
  };
}

describe("runRoleInTempWorktree — relative workspace resolves to an absolute sibling snapshot", () => {
  it(
    "a RELATIVE workspace snapshots as an ABSOLUTE sibling (not under src), delegate sees it, torn down, no nested leak",
    GIT_IT,
    async () => {
      const repo = makeWipRepo();
      const ctx = await makeCtx(repo);
      const prevCwd = process.cwd();
      const seen: Seen = {};
      try {
        // Drive with a RELATIVE workspace resolved against the process cwd (the temp parent).
        process.chdir(path.dirname(repo));
        const relWorkspace = path.basename(repo);
        const resolvedSrc = path.resolve(relWorkspace); // absolute, against the new cwd

        const res = await runRoleInTempWorktree(
          { ctx, roleKind: "evaluator", workspace: relWorkspace, brief: "grade", provisionFn: fakeProvision() },
          { runRoleFn: observer(seen) }
        );
        expect(res.ok).toBe(true);

        // Assertion 1: the delegate received an ABSOLUTE workspace that is a SIBLING of the resolved
        // source (parent dir === parent of resolved src) and is NOT inside the source tree — and it
        // is a real linked worktree. (No realpath: the snapshot is already torn down here, and both
        // paths derive from the SAME `path.resolve(relWorkspace)` so they share a form.)
        expect(seen.workspace).toBeDefined();
        expect(path.isAbsolute(seen.workspace!)).toBe(true);
        expect(path.dirname(seen.workspace!)).toBe(path.dirname(resolvedSrc)); // sibling
        expect(path.relative(resolvedSrc, seen.workspace!).startsWith("..")).toBe(true); // not under src
        expect(seen.linked).toBe(true);

        // Assertion 3: depSourceDir is the RESOLVED absolute source (the string the snapshot was cut from).
        expect(seen.depSourceDir).toBe(resolvedSrc);

        // Assertion 2: after the run the snapshot dir is gone AND no *-eval-* entry leaked INSIDE the repo.
        expect(fs.existsSync(seen.workspace!)).toBe(false);
        expect(fs.readdirSync(repo).some((e) => e.includes("-eval-"))).toBe(false);
      } finally {
        process.chdir(prevCwd);
        fs.rmSync(repo, { recursive: true, force: true });
      }
    }
  );

  it("absolute-workspace snapshot placement is UNCHANGED (sibling, not under src, torn down)", GIT_IT, async () => {
    const repo = makeWipRepo();
    const ctx = await makeCtx(repo);
    const seen: Seen = {};
    try {
      const res = await runRoleInTempWorktree(
        { ctx, roleKind: "evaluator", workspace: repo, brief: "grade", provisionFn: fakeProvision() },
        { runRoleFn: observer(seen) }
      );
      expect(res.ok).toBe(true);
      expect(path.isAbsolute(seen.workspace!)).toBe(true);
      expect(real(path.dirname(seen.workspace!))).toBe(real(path.dirname(repo))); // sibling, byte-identical placement
      expect(real(seen.depSourceDir!)).toBe(real(repo));
      expect(fs.existsSync(seen.workspace!)).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("worktree wrappers — pre-launch guards (no worktree created / no session launched)", () => {
  it("nonexistent workspace (temp wrapper) rejects BEFORE worktree creation, naming the resolved abs path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-u4ctx-"));
    try {
      const ctx = await makeCtx(dir);
      const rel = "no-such-workspace-u4-xyz";
      const resolved = path.resolve(rel);
      const addWorktreeFn = vi.fn(() => ({ ok: true, out: "" }));
      await expect(
        runRoleInTempWorktree(
          { ctx, roleKind: "evaluator", workspace: rel, brief: "grade" },
          { addWorktreeFn, runRoleFn: async () => fakeResult() }
        )
      ).rejects.toThrow(resolved);
      expect(addWorktreeFn).not.toHaveBeenCalled(); // rejected before any worktree add
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("nonexistent workspace (unit wrapper) rejects, naming the resolved abs path — no fakes / no session invoked", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-u4ctx-"));
    try {
      const ctx = await makeCtx(dir);
      const rel = "no-such-unit-workspace-u4-xyz";
      const resolved = path.resolve(rel);
      const worktreeDirFn = vi.fn((s: string, name: string) => defaultUnitWorktreeDir(s, name));
      const addWorktreeFn = vi.fn(() => ({ ok: true, out: "" }));
      const runSessionFn = vi.fn(async () => {
        throw new Error("session must not launch");
      });
      await expect(
        runRoleInUnitWorktree({
          ctx,
          roleKind: "generator",
          unitWorktree: "u1",
          workspace: rel,
          brief: "build",
          unitWorktreeDeps: { worktreeDirFn, addWorktreeFn },
          runSessionFn: runSessionFn as unknown as (p: RunSessionParams) => Promise<RunResult>,
        })
      ).rejects.toThrow(resolved);
      expect(worktreeDirFn).not.toHaveBeenCalled();
      expect(addWorktreeFn).not.toHaveBeenCalled();
      expect(runSessionFn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("nested-snapshot guard: a worktreeDirFn returning a path UNDER src refuses before creating the snapshot", async () => {
    const repo = makeWipRepo();
    try {
      const ctx = await makeCtx(repo);
      const addWorktreeFn = vi.fn(() => ({ ok: true, out: "" }));
      const nested = path.join(path.resolve(repo), "inside-eval-snap");
      await expect(
        runRoleInTempWorktree(
          { ctx, roleKind: "evaluator", workspace: repo, brief: "grade" },
          { worktreeDirFn: () => nested, addWorktreeFn, runRoleFn: async () => fakeResult() }
        )
      ).rejects.toThrow(/under source|inside the source tree/i);
      expect(addWorktreeFn).not.toHaveBeenCalled(); // refused before the worktree add
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("runRoleInUnitWorktree — relative workspace passes an ABSOLUTE source to ensureUnitWorktree", () => {
  it("a RELATIVE workspace resolves to an absolute source dir handed to ensureUnitWorktree", GIT_IT, async () => {
    const repo = makeWipRepo();
    g(repo, ["branch", "-M", "main"]);
    const ctx = await makeCtx(repo);
    const prevCwd = process.cwd();
    let capturedSrc: string | undefined;
    let created: RoleRunResult["unitWorktree"] | undefined;
    try {
      process.chdir(path.dirname(repo));
      const relWorkspace = path.basename(repo);
      const resolvedSrc = path.resolve(relWorkspace);
      const rec: RunSessionParams[] = [];
      const runSessionFn = async (p: RunSessionParams): Promise<RunResult> => {
        rec.push(p);
        return {
          ok: true, subtype: "success", resultText: "done", sessionId: "r", costUsd: 0, tokens: 3,
          numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
        };
      };
      const deps: UnitWorktreeDeps = {
        worktreeDirFn: (s, name) => {
          capturedSrc = s; // the src ensureUnitWorktree received
          return defaultUnitWorktreeDir(s, name);
        },
      };
      const res = await runRoleInUnitWorktree({
        ctx,
        roleKind: "generator",
        unitWorktree: "u1",
        workspace: relWorkspace,
        brief: "build",
        unitWorktreeDeps: deps,
        provisionFn: fakeProvision(),
        runSessionFn,
      });
      created = res.unitWorktree;
      expect(capturedSrc).toBeDefined();
      expect(path.isAbsolute(capturedSrc!)).toBe(true);
      expect(real(capturedSrc!)).toBe(real(resolvedSrc));
      // The generator ran in the persistent unit worktree (a real sibling, absolute).
      expect(path.isAbsolute(res.unitWorktree!.dir)).toBe(true);
      expect(path.resolve(rec[0]!.cwd!)).toBe(path.resolve(res.unitWorktree!.dir));
    } finally {
      process.chdir(prevCwd);
      if (created?.dir) {
        try { g(repo, ["worktree", "remove", "--force", created.dir]); } catch { /* best effort */ }
        try { g(repo, ["branch", "-D", created.branch]); } catch { /* best effort */ }
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("runRole (evaluator) — infra ≠ verdict classification", () => {
  const EVAL_GARBAGE = "no verdict here, just prose";

  async function evalCtx(): Promise<Ctx> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-u4eval-"));
    return makeCtx(dir);
  }

  function session(over: Partial<RunResult>): (p: RunSessionParams) => Promise<RunResult> {
    return async () => ({
      ok: true, subtype: "success", resultText: "", sessionId: "r", costUsd: 0, tokens: 0,
      numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "", ...over,
    });
  }

  it("launch ENOENT (no model output) → infra error, NO verdict", async () => {
    const ctx = await evalCtx();
    try {
      const res = await runRole({
        ctx,
        roleKind: "evaluator",
        brief: "grade",
        runSessionFn: session({
          ok: false,
          subtype: "error",
          resultText: "",
          tokens: 0,
          errors: ["Codex run failed: No such file or directory (os error 2)"],
        }),
      });
      expect(res.ok).toBe(false);
      expect(res.errors.length).toBeGreaterThan(0);
      expect(res.errors.join(" ")).toMatch(/INFRASTRUCTURE failure/i);
      expect(res.verdict).toBeUndefined(); // NOT a synthetic weightedTotal-0 verdict
    } finally {
      fs.rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("session RAN but returned non-JSON garbage → today's forced-fail verdict (not reclassified)", async () => {
    const ctx = await evalCtx();
    try {
      const res = await runRole({
        ctx,
        roleKind: "evaluator",
        brief: "grade",
        runSessionFn: session({ ok: true, resultText: EVAL_GARBAGE, tokens: 7 }),
      });
      expect(res.verdict).toBeDefined();
      expect(res.verdict!.verdict).toBe("fail");
    } finally {
      fs.rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("session RAN but produced EMPTY output via a non-ENOENT failure → forced-fail verdict (empty alone is not infra)", async () => {
    const ctx = await evalCtx();
    try {
      const res = await runRole({
        ctx,
        roleKind: "evaluator",
        brief: "grade",
        runSessionFn: session({
          ok: false,
          subtype: "error",
          resultText: "",
          tokens: 0,
          errors: ["the model returned nothing (turn produced no output)"],
        }),
      });
      expect(res.verdict).toBeDefined(); // empty output alone is NOT reclassified as infra
      expect(res.verdict!.verdict).toBe("fail");
    } finally {
      fs.rmSync(ctx.root, { recursive: true, force: true });
    }
  });
});

describe("runRoleInTempWorktree — teardown failure warns naming the resolved abs wtDir", () => {
  it("a failing removeWorktreeFn still completes the run and warns with the resolved wtDir", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-u4tear-"));
    const ctx = await makeCtx(dir);
    const wtDir = path.join(path.dirname(real(dir)), "u4-fake-eval-snap");
    const prior = process.env.SPARRA_LOG_IN_TESTS;
    process.env.SPARRA_LOG_IN_TESTS = "1";
    let buf = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    });
    try {
      const res = await runRoleInTempWorktree(
        { ctx, roleKind: "evaluator", workspace: dir, brief: "grade" },
        {
          worktreeDirFn: () => wtDir,
          addWorktreeFn: () => ({ ok: true, out: "" }),
          removeWorktreeFn: () => ({ ok: false, out: "boom" }),
          runRoleFn: async () => fakeResult(),
        }
      );
      expect(res.ok).toBe(true); // the run still completed despite the teardown failure
    } finally {
      spy.mockRestore();
      if (prior === undefined) delete process.env.SPARRA_LOG_IN_TESTS;
      else process.env.SPARRA_LOG_IN_TESTS = prior;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(path.isAbsolute(wtDir)).toBe(true);
    expect(buf).toContain(wtDir); // the warning names the resolved absolute wtDir
    expect(buf).toMatch(/teardown failed/i);
  });
});
