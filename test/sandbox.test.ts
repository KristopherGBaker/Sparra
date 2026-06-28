import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gateSandbox } from "../src/build/sandbox.ts";
import { codexSandboxMode } from "../src/sdk/backends/codex.ts";
import { generateItem } from "../src/build/generate.ts";
import { runRole } from "../src/build/roleRun.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

async function makeCtx(): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-sandbox-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  const ctx: Ctx = { root: dir, paths, config: defaultConfig(), store };
  return { ctx, dir };
}

const item = { id: "item-001", title: "thing", summary: "", dependsOn: [], rationale: "" };

function fakeRun(capture: (p: RunSessionParams) => void): (p: RunSessionParams) => Promise<RunResult> {
  return async (p) => {
    capture(p);
    return {
      ok: true, subtype: "success", resultText: "done", sessionId: "s",
      costUsd: 0, tokens: 0, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
    };
  };
}

/** Capture stdout (where `warn` writes its loud line) so we can assert the gate warns visibly. */
function captureStdout(): { lines: () => string; restore: () => void } {
  let buf = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
  return { lines: () => buf, restore: () => spy.mockRestore() };
}

describe("gateSandbox (worktree safety gate, pure)", () => {
  it("passes workspace-write through on any build state", () => {
    expect(gateSandbox({ requested: "workspace-write", hasBranch: false, roleLabel: "r" })).toBe("workspace-write");
    expect(gateSandbox({ requested: "workspace-write", hasBranch: true, roleLabel: "r" })).toBe("workspace-write");
  });

  it("leaves the unset knob undefined (→ backend default, unchanged from today)", () => {
    expect(gateSandbox({ requested: undefined, hasBranch: false, roleLabel: "r" })).toBeUndefined();
    expect(gateSandbox({ requested: undefined, hasBranch: true, roleLabel: "r" })).toBeUndefined();
  });

  it("honors danger-full-access ONLY on a git worktree/branch boundary", () => {
    expect(gateSandbox({ requested: "danger-full-access", hasBranch: true, roleLabel: "r" })).toBe("danger-full-access");
  });

  it("downgrades danger-full-access LOUDLY when there is no branch boundary", () => {
    const out = captureStdout();
    const eff = gateSandbox({ requested: "danger-full-access", hasBranch: false, roleLabel: "generator-x" });
    out.restore();
    expect(eff).toBe("workspace-write"); // safe, never silently full-access
    expect(out.lines()).toMatch(/danger-full-access/); // and loud
    expect(out.lines()).toMatch(/generator-x/);
  });
});

describe("generateItem — sandbox intent threaded from role config + gated", () => {
  it("default (knob unset): no sandbox set → backend stays workspace-write (unchanged)", async () => {
    const { ctx, dir } = await makeCtx();
    let sandbox: unknown = "untouched";
    await generateItem({
      ctx, item, contractText: "c", workspaceDir: dir, traceDir: dir, traceSeq: 1,
      runSessionFn: fakeRun((p) => (sandbox = p.sandbox)),
    });
    expect(sandbox).toBeUndefined();
    expect(codexSandboxMode({ sandbox: sandbox as undefined })).toBe("workspace-write");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("passes danger-full-access through when the build is on a branch", async () => {
    const { ctx, dir } = await makeCtx();
    ctx.config.roles.generator.sandbox = "danger-full-access";
    ctx.store.data.build.branch = "sparra/feature";
    let sandbox: unknown;
    await generateItem({
      ctx, item, contractText: "c", workspaceDir: dir, traceDir: dir, traceSeq: 1,
      runSessionFn: fakeRun((p) => (sandbox = p.sandbox)),
    });
    expect(sandbox).toBe("danger-full-access");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("downgrades danger-full-access to workspace-write on an in-place run (no branch)", async () => {
    const out = captureStdout();
    const { ctx, dir } = await makeCtx();
    ctx.config.roles.generator.sandbox = "danger-full-access";
    // No build.branch set → in-place / greenfield-no-git.
    let sandbox: unknown;
    await generateItem({
      ctx, item, contractText: "c", workspaceDir: dir, traceDir: dir, traceSeq: 1,
      runSessionFn: fakeRun((p) => (sandbox = p.sandbox)),
    });
    out.restore();
    expect(sandbox).toBe("workspace-write");
    expect(out.lines()).toMatch(/danger-full-access/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("runRole — sandbox intent for the writer role only", () => {
  it("write (generator) role threads + gates the sandbox; danger downgraded without a branch", async () => {
    const out = captureStdout();
    const { ctx, dir } = await makeCtx();
    ctx.config.roles.generator.sandbox = "danger-full-access";
    let p: RunSessionParams | undefined;
    await runRole({
      ctx, roleKind: "generator", brief: "do the thing", workspace: dir,
      runSessionFn: fakeRun((req) => (p = req)),
    });
    out.restore();
    expect(p?.readOnly).toBeUndefined();
    expect(p?.sandbox).toBe("workspace-write"); // gated down: no branch
    expect(out.lines()).toMatch(/danger-full-access/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("read-only role never carries a sandbox knob (readOnly wins downstream)", async () => {
    const { ctx, dir } = await makeCtx();
    // Even if someone set the knob on a read role config, it must not leak onto the request.
    ctx.config.roles.reviewer.sandbox = "danger-full-access";
    let p: RunSessionParams | undefined;
    await runRole({
      ctx, roleKind: "reviewer", brief: "review the thing", workspace: dir,
      runSessionFn: fakeRun((req) => (p = req)),
    });
    expect(p?.readOnly).toBe(true);
    expect(p?.sandbox).toBeUndefined();
    expect(codexSandboxMode({ readOnly: p!.readOnly, sandbox: p!.sandbox })).toBe("read-only");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
