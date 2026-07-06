import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import { cmdRoleRun, roleRequestFromFlags } from "../src/phases/role.ts";
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
      await cmdRoleRun(ctx, { kind: "generator", "brief-text": "build" }, async () => res);
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
