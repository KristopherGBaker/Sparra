import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import { cmdRoleRun, cmdRoleRemoveWorktree, roleRequestFromFlags } from "../src/phases/role.ts";
import type { RoleRunResult } from "../src/build/roleRun.ts";

async function makeCtx(): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-role-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  const ctx: Ctx = { root: dir, paths, config: defaultConfig(), store };
  return { ctx, dir };
}

describe("roleRequestFromFlags — CLI --verify → allowVerify (H7 assertion 7d)", () => {
  it("--verify present as a real boolean → allowVerify: true", async () => {
    const { ctx, dir } = await makeCtx();
    const req = roleRequestFromFlags(ctx, "generator", { verify: true }, { briefText: "build" });
    expect(req.allowVerify).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("--verify absent → allowVerify falsy (today's default)", async () => {
    const { ctx, dir } = await makeCtx();
    const req = roleRequestFromFlags(ctx, "generator", {}, { briefText: "build" });
    expect(req.allowVerify).toBeFalsy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a stray --verify string (not a parsed boolean) does NOT set it true", async () => {
    const { ctx, dir } = await makeCtx();
    const req = roleRequestFromFlags(ctx, "generator", { verify: "true" }, { briefText: "build" });
    expect(req.allowVerify).toBeFalsy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("threads the other flags through (sanity — not just allowVerify)", async () => {
    const { ctx, dir } = await makeCtx();
    const req = roleRequestFromFlags(
      ctx,
      "generator",
      { workspace: "/ws", backend: "codex", model: "m" },
      { briefText: "build" }
    );
    expect(req.roleKind).toBe("generator");
    expect(req.workspace).toBe("/ws");
    expect(req.backend).toBe("codex");
    expect(req.model).toBe("m");
    expect(req.brief).toBe("build");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("roleRequestFromFlags — CLI --unit-worktree → unitWorktree (U-W)", () => {
  it("--unit-worktree <name> (string) → unitWorktree: name", async () => {
    const { ctx, dir } = await makeCtx();
    const req = roleRequestFromFlags(ctx, "generator", { "unit-worktree": "u1" }, { briefText: "build" });
    expect(req.unitWorktree).toBe("u1");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a bare/absent --unit-worktree contributes no name", async () => {
    const { ctx, dir } = await makeCtx();
    expect(roleRequestFromFlags(ctx, "generator", {}, { briefText: "build" }).unitWorktree).toBeUndefined();
    expect(roleRequestFromFlags(ctx, "generator", { "unit-worktree": true }, { briefText: "build" }).unitWorktree).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdRoleRemoveWorktree — CLI role rm-worktree", () => {
  it("requires --name (errors without it, never calls the remover)", async () => {
    const { ctx, dir } = await makeCtx();
    const remove = vi.fn();
    const prior = process.exitCode;
    await cmdRoleRemoveWorktree(ctx, {}, remove as never);
    expect(remove).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("forwards --name and --force to removeUnitWorktree", async () => {
    const { ctx, dir } = await makeCtx();
    const remove = vi.fn(async () => ({ ok: true, message: "removed" }));
    await cmdRoleRemoveWorktree(ctx, { name: "u1", force: true }, remove as never);
    expect(remove).toHaveBeenCalledWith(ctx, "u1", { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sets exit code 1 when the removal is refused (dirty/unmerged/unknown)", async () => {
    const { ctx, dir } = await makeCtx();
    const remove = vi.fn(async () => ({ ok: false, message: "refusing: dirty" }));
    const prior = process.exitCode;
    await cmdRoleRemoveWorktree(ctx, { name: "u1" }, remove as never);
    expect(process.exitCode).toBe(1);
    process.exitCode = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// U3: repeatable `--prior-critique <path>` → priorCritiquePaths (order preserved).
describe("roleRequestFromFlags — --prior-critique → priorCritiquePaths (U3)", () => {
  it("a single --prior-critique (parser yields a string) → a one-element array", async () => {
    const { ctx, dir } = await makeCtx();
    const req = roleRequestFromFlags(ctx, "contract-evaluator", { "prior-critique": "a.md" }, {});
    expect(req.priorCritiquePaths).toEqual(["a.md"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("repeated --prior-critique (parser yields a string[]) → paths in the GIVEN order", async () => {
    const { ctx, dir } = await makeCtx();
    const req = roleRequestFromFlags(ctx, "contract-evaluator", { "prior-critique": ["a.md", "b.md"] }, {});
    expect(req.priorCritiquePaths).toEqual(["a.md", "b.md"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("absent → undefined; a value-less boolean --prior-critique contributes no path", async () => {
    const { ctx, dir } = await makeCtx();
    expect(roleRequestFromFlags(ctx, "contract-evaluator", {}, {}).priorCritiquePaths).toBeUndefined();
    expect(roleRequestFromFlags(ctx, "contract-evaluator", { "prior-critique": true }, {}).priorCritiquePaths).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// U4: repeatable `--prior-blocking <path>` → priorBlockingPaths (order preserved).
describe("roleRequestFromFlags — --prior-blocking → priorBlockingPaths (U4)", () => {
  it("a single --prior-blocking (parser yields a string) → a one-element array", async () => {
    const { ctx, dir } = await makeCtx();
    const req = roleRequestFromFlags(ctx, "evaluator", { "prior-blocking": "b1.md" }, {});
    expect(req.priorBlockingPaths).toEqual(["b1.md"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("repeated --prior-blocking (parser yields a string[]) → paths in the GIVEN order", async () => {
    const { ctx, dir } = await makeCtx();
    const req = roleRequestFromFlags(ctx, "evaluator", { "prior-blocking": ["b1.md", "b2.md"] }, {});
    expect(req.priorBlockingPaths).toEqual(["b1.md", "b2.md"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("absent → undefined; a value-less boolean --prior-blocking contributes no path", async () => {
    const { ctx, dir } = await makeCtx();
    expect(roleRequestFromFlags(ctx, "evaluator", {}, {}).priorBlockingPaths).toBeUndefined();
    expect(roleRequestFromFlags(ctx, "evaluator", { "prior-blocking": true }, {}).priorBlockingPaths).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// Item D: `--worktree` / `--keep-worktree` → the request's INTENT flags (useWorktree/keepWorktree).
// Pure mapping only — whether the run actually lands in a worktree is runtime (evalWorktree.test.ts).
describe("roleRequestFromFlags — --worktree / --keep-worktree (Item D)", () => {
  it("--worktree present as a real boolean → useWorktree: true", async () => {
    const { ctx, dir } = await makeCtx();
    const req = roleRequestFromFlags(ctx, "evaluator", { worktree: true }, {});
    expect(req.useWorktree).toBe(true);
    expect(req.keepWorktree).toBeFalsy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("--keep-worktree present as a real boolean → keepWorktree: true", async () => {
    const { ctx, dir } = await makeCtx();
    const req = roleRequestFromFlags(ctx, "evaluator", { worktree: true, "keep-worktree": true }, {});
    expect(req.useWorktree).toBe(true);
    expect(req.keepWorktree).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("both absent → both falsy (in-place default, backward compatible)", async () => {
    const { ctx, dir } = await makeCtx();
    const req = roleRequestFromFlags(ctx, "evaluator", {}, {});
    expect(req.useWorktree).toBeFalsy();
    expect(req.keepWorktree).toBeFalsy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stray string values (not parsed booleans) do NOT set them", async () => {
    const { ctx, dir } = await makeCtx();
    const req = roleRequestFromFlags(ctx, "evaluator", { worktree: "yes", "keep-worktree": "true" }, {});
    expect(req.useWorktree).toBeFalsy();
    expect(req.keepWorktree).toBeFalsy();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// U-P: `--expected-head <sha>` / `--eval-base <ref>` → the request's eval-provenance controls.
describe("roleRequestFromFlags — --expected-head / --eval-base (U-P)", () => {
  it("string values map to expectedHead / evalBaseRef", async () => {
    const { ctx, dir } = await makeCtx();
    const req = roleRequestFromFlags(ctx, "evaluator", { "expected-head": "09cb754", "eval-base": "HEAD~1" }, {});
    expect(req.expectedHead).toBe("09cb754");
    expect(req.evalBaseRef).toBe("HEAD~1");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("absent → both undefined (backward compatible)", async () => {
    const { ctx, dir } = await makeCtx();
    const req = roleRequestFromFlags(ctx, "evaluator", {}, {});
    expect(req.expectedHead).toBeUndefined();
    expect(req.evalBaseRef).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a value-less boolean flag does NOT set a bogus string", async () => {
    const { ctx, dir } = await makeCtx();
    const req = roleRequestFromFlags(ctx, "evaluator", { "expected-head": true, "eval-base": true }, {});
    expect(req.expectedHead).toBeUndefined();
    expect(req.evalBaseRef).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// U-P fix round 2: the CLI/loader path must abort a bad --expected-head BEFORE the auto-permission
// probe (a live SDK query = model tokens). Regression for the round-1 leak where loadCtxForRole
// fired the probe before cmdRoleRun validated. Uses a REAL git repo workspace + injected spies.
describe("cmdRoleRun — provenance validation precedes the auto probe (U-P fix)", () => {
  function g(dir: string, args: string[]): string {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  }
  /** A committed git repo whose HEAD we can pass (or deliberately mismatch). */
  async function gitCtx(): Promise<{ ctx: Ctx; dir: string; head: string }> {
    const { ctx, dir } = await makeCtx();
    g(dir, ["init"]);
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    g(dir, ["add", "-A"]);
    g(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "base"]);
    return { ctx, dir, head: g(dir, ["rev-parse", "HEAD"]).trim() };
  }

  function evalResult(): RoleRunResult {
    return { ok: true, roleKind: "evaluator", backend: "claude", model: "m", resultText: "ok", traceDir: "/t", sessionId: "s", costUsd: 0, tokens: 1, errors: [] };
  }

  it("a MISMATCHING --expected-head aborts WITHOUT calling the auto probe or runRole", async () => {
    const { ctx, dir, head } = await gitCtx();
    const probe = vi.fn(async () => {});
    const runRoleFn = vi.fn(async () => evalResult());
    await cmdRoleRun(ctx, { kind: "evaluator", workspace: dir, "expected-head": "deadbeef" }, runRoleFn as never, probe as never);
    expect(probe).not.toHaveBeenCalled(); // ZERO model tokens: the probe never fired
    expect(runRoleFn).not.toHaveBeenCalled(); // and no session
    expect(process.exitCode).toBe(1);
    expect(head).not.toBe("deadbeef"); // sanity: it really was a mismatch
    process.exitCode = 0;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a MATCHING --expected-head runs the probe THEN the role (probe before run)", async () => {
    const { ctx, dir, head } = await gitCtx();
    const order: string[] = [];
    const probe = vi.fn(async () => { order.push("probe"); });
    const runRoleFn = vi.fn(async () => { order.push("run"); return evalResult(); });
    await cmdRoleRun(ctx, { kind: "evaluator", workspace: dir, "expected-head": head }, runRoleFn as never, probe as never);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(runRoleFn).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["probe", "run"]); // probe precedes the run for a valid request
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("no provenance params → probe + run as before (behavior preserved)", async () => {
    const { ctx, dir } = await gitCtx();
    const probe = vi.fn(async () => {});
    const runRoleFn = vi.fn(async () => evalResult());
    await cmdRoleRun(ctx, { kind: "evaluator", workspace: dir }, runRoleFn as never, probe as never);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(runRoleFn).toHaveBeenCalledTimes(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// Item A: the `sparra role run` CLI must EMIT the new not-a-fail signals (names + values) —
// an MCP-only surfacing would leave a scripted CLI conductor blind to "the work landed".
describe("cmdRoleRun — prints emptyCompletion / filesChanged / hitBudget (Item A)", () => {
  function fakeResult(over: Partial<RoleRunResult>): RoleRunResult {
    return {
      ok: false,
      roleKind: "generator",
      backend: "codex",
      model: "gpt",
      resultText: "",
      traceDir: "/t",
      sessionId: "sess-cli",
      costUsd: 0,
      tokens: 0,
      errors: [],
      ...over,
    };
  }

  async function captureRun(res: RoleRunResult): Promise<string> {
    const { ctx, dir } = await makeCtx();
    // The logger is silenced under vitest; lift the gate via the documented escape hatch while capturing.
    const priorLogInTests = process.env.SPARRA_LOG_IN_TESTS;
    process.env.SPARRA_LOG_IN_TESTS = "1";
    let buf = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    });
    try {
      // Inject a no-op auto-probe: cmdRoleRun runs the auto-permission probe (a LIVE SDK query) for
      // a valid request, which must never fire in a unit test (offline + no 30s hang under load).
      await cmdRoleRun(ctx, { kind: "generator", "brief-text": "build" }, async () => res, async () => {});
    } finally {
      spy.mockRestore();
      if (priorLogInTests === undefined) delete process.env.SPARRA_LOG_IN_TESTS;
      else process.env.SPARRA_LOG_IN_TESTS = priorLogInTests;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return buf;
  }

  it("an emptyCompletion result prints the flag, the filesChanged count, and the resumable sessionId", async () => {
    const out = await captureRun(fakeResult({ emptyCompletion: true, filesChanged: 2 }));
    expect(out).toContain("emptyCompletion: true");
    expect(out).toContain("filesChanged: 2");
    expect(out).toContain("sess-cli"); // the id the conductor resumes with
    expect(out).toMatch(/NOT a behavioral fail/i);
  });

  it("a hitBudget result prints the flag with the resumable sessionId", async () => {
    const out = await captureRun(fakeResult({ hitBudget: true, filesChanged: 0 }));
    expect(out).toContain("hitBudget: true");
    expect(out).toContain("filesChanged: 0");
    expect(out).toContain("sess-cli");
  });

  it("a plain result prints none of the new signals", async () => {
    const out = await captureRun(fakeResult({ ok: true, resultText: "done" }));
    expect(out).not.toContain("emptyCompletion");
    expect(out).not.toContain("hitBudget");
    expect(out).not.toContain("filesChanged");
  });

  it("prints the auto-persisted verdictPath, separately from a caller --out (outPath)", async () => {
    const out = await captureRun(
      fakeResult({
        ok: true,
        roleKind: "evaluator",
        verdictPath: "/proj/.sparra/verdicts/role-run-evaluator-x.verdict.md",
        outPath: "/proj/out.md",
      })
    );
    expect(out).toContain("verdict persisted: /proj/.sparra/verdicts/role-run-evaluator-x.verdict.md");
    expect(out).toContain("wrote: /proj/out.md");
  });
});
