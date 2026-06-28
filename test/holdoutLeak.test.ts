import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateItem } from "../src/build/generate.ts";
import { reviewItem } from "../src/build/review.ts";
import { makeHoldoutReadDecider } from "../src/build/holdout.ts";
import { readOnlyGuard } from "../src/sdk/guard.ts";
import { plannerWriteScope } from "../src/sdk/permissions.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import type { HookConfig } from "../src/sdk/hooks.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

/**
 * Holdout-leak audit (Item C): the AUTONOMOUS build-loop forbid roles must enforce the holdout
 * wall on disk — not just via the prompt-leak check — exactly like the interactive role-runner.
 * A forbid role running with Read tools (and, on a worktree, the repo root granted) could
 * otherwise `Read`/`cat` .sparra/HOLDOUT.md.
 */

async function makeCtx(): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-leak-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  const ctx: Ctx = { root: dir, paths, config: defaultConfig(), store };
  fs.writeFileSync(paths.holdout, "# Holdout\n\n- The output must be byte-identical to the source.\n");
  return { ctx, dir };
}

const item = { id: "item-001", title: "thing", summary: "", dependsOn: [], rationale: "" };

function fakeRun(capture: (p: RunSessionParams) => void): (p: RunSessionParams) => Promise<RunResult> {
  return async (p) => {
    capture(p);
    return {
      ok: true, subtype: "success", resultText: '{"findings":[]}', sessionId: "s",
      costUsd: 0, tokens: 0, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
    };
  };
}

/** True if ANY of the captured PreToolUse hooks denies the tool call. */
async function hooksDeny(hooks: HookConfig | undefined, tool_name: string, tool_input: unknown): Promise<boolean> {
  for (const matcher of hooks?.PreToolUse ?? []) {
    for (const cb of matcher.hooks) {
      const out: any = await cb({ hook_event_name: "PreToolUse", tool_name, tool_input } as any, "id", {} as any);
      if (out?.hookSpecificOutput?.permissionDecision === "deny") return true;
    }
  }
  return false;
}

describe("Item C — build-loop generator enforces the holdout wall on disk", () => {
  it("denies a Read/Bash of the holdout and drops the repo root from the read scope", async () => {
    const { ctx, dir } = await makeCtx();
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-wt-"));
    let p!: RunSessionParams;
    await generateItem({ ctx, item, contractText: "c", workspaceDir: wt, traceDir: wt, traceSeq: 1, runSessionFn: fakeRun((x) => (p = x)) });

    expect(await hooksDeny(p.hooks, "Read", { file_path: ctx.paths.holdout })).toBe(true);
    expect(await hooksDeny(p.hooks, "Bash", { command: "cat .sparra/HOLDOUT.md" })).toBe(true);
    // An ordinary in-scope source read is NOT denied.
    expect(await hooksDeny(p.hooks, "Read", { file_path: path.join(wt, "src/a.ts") })).toBe(false);
    // The holdout-bearing repo root is excluded from the granted read dirs.
    expect(p.additionalDirectories ?? []).not.toContain(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });
});

describe("Item C — build-loop reviewer enforces the holdout wall on disk", () => {
  it("denies a holdout read and does not grant the raw repo root", async () => {
    const { ctx, dir } = await makeCtx();
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-wt-"));
    let p!: RunSessionParams;
    await reviewItem({ ctx, item, contractText: "c", workspaceDir: wt, round: 1, traceDir: wt, traceSeq: 1, runSessionFn: fakeRun((x) => (p = x)) });

    expect(await hooksDeny(p.hooks, "Read", { file_path: ctx.paths.holdout })).toBe(true);
    expect(await hooksDeny(p.hooks, "Grep", { path: path.join(dir, ".sparra") })).toBe(true);
    expect(p.additionalDirectories ?? []).not.toContain(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });
});

describe("Item C — the guard/permission mechanisms the contract/decompose/reconcile roles use", () => {
  it("readOnlyGuard with the holdout extraDeny (contract-*/decomposer, cwd=root) blocks holdout reads AND pathless searches of root", async () => {
    const { ctx, dir } = await makeCtx();
    // contract/decompose run with cwd = ctx.root (which holds .sparra/HOLDOUT.md).
    const guard = readOnlyGuard(ctx, { extraDeny: [makeHoldoutReadDecider(ctx, ctx.root)] });
    expect(await hooksDeny(guard.hooks, "Read", { file_path: ctx.paths.holdout })).toBe(true);
    expect(await hooksDeny(guard.hooks, "Bash", { command: "grep -r secret .sparra" })).toBe(true);
    // The pathless-search leak Codex found: a Grep/Glob with no path searches the holdout-bearing cwd.
    expect(await hooksDeny(guard.hooks, "Grep", { pattern: "byte-identical" })).toBe(true);
    expect(await hooksDeny(guard.hooks, "Glob", { pattern: "**/HOLDOUT.md" })).toBe(true);
    expect(await hooksDeny(guard.hooks, "Grep", { path: ".", pattern: "x" })).toBe(true);
    // Ordinary reads and subdir-scoped searches still work.
    expect(await hooksDeny(guard.hooks, "Read", { file_path: path.join(dir, "src/a.ts") })).toBe(false);
    expect(await hooksDeny(guard.hooks, "Grep", { path: path.join(dir, "src"), pattern: "x" })).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("plannerWriteScope with the holdout extraDeny (reconcile) denies a holdout read but allows other reads", async () => {
    const { ctx, dir } = await makeCtx();
    const canUse = plannerWriteScope(ctx.paths.plan, [], makeHoldoutReadDecider(ctx, ctx.root));
    const readHoldout = await canUse("Read", { file_path: ctx.paths.holdout } as any, {} as any);
    expect(readHoldout.behavior).toBe("deny");
    const readSrc = await canUse("Read", { file_path: path.join(dir, "src/a.ts") } as any, {} as any);
    expect(readSrc.behavior).toBe("allow");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
