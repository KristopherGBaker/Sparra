import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decompose } from "../src/build/decompose.ts";
import { negotiateContract } from "../src/build/contract.ts";
import { holdoutFreeCwd } from "../src/build/readscope.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import type { HookConfig } from "../src/sdk/hooks.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

/**
 * Item G: the build-loop FORBID roles (decomposer, contract-generator/-evaluator) run in a
 * holdout-free cwd (the worktree when building isolated; else ctx.root), and their deny-decider
 * tracks THAT cwd. Offline — a recorder runSessionFn captures the cwd/hooks; no live model.
 */

async function makeCtx(): Promise<{ ctx: Ctx; root: string; wt: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-cwd-root-"));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-cwd-wt-"));
  const paths = new Paths(root);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  const ctx: Ctx = { root, paths, config: defaultConfig(), store };
  fs.writeFileSync(paths.holdout, "# Holdout\n\n- The output must be byte-identical to the source.\n");
  return { ctx, root, wt };
}

const item = { id: "item-001", title: "thing", summary: "s", dependsOn: [], rationale: "" };

/** A recorder that captures every runSession param and returns a fixed result. */
function recorder(text: string): { calls: RunSessionParams[]; fn: (p: RunSessionParams) => Promise<RunResult> } {
  const calls: RunSessionParams[] = [];
  const fn = async (p: RunSessionParams): Promise<RunResult> => {
    calls.push(p);
    return {
      ok: true, subtype: "success", resultText: text, sessionId: "s",
      costUsd: 0, tokens: 0, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
    };
  };
  return { calls, fn };
}

async function hooksDeny(hooks: HookConfig | undefined, tool_name: string, tool_input: unknown): Promise<boolean> {
  for (const matcher of hooks?.PreToolUse ?? []) {
    for (const cb of matcher.hooks) {
      const out: any = await cb({ hook_event_name: "PreToolUse", tool_name, tool_input } as any, "id", {} as any);
      if (out?.hookSpecificOutput?.permissionDecision === "deny") return true;
    }
  }
  return false;
}

describe("holdoutFreeCwd helper", () => {
  it("returns a sibling worktree (no holdout within) unchanged", async () => {
    const { ctx, wt, root } = await makeCtx();
    expect(holdoutFreeCwd(ctx, wt)).toBe(wt);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it("returns ctx.root when workspaceDir === ctx.root", async () => {
    const { ctx, root, wt } = await makeCtx();
    expect(holdoutFreeCwd(ctx, ctx.root)).toBe(ctx.root);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it("falls back to ctx.root for a dir that CONTAINS a holdout artifact (an ancestor of root)", async () => {
    const { ctx, root, wt } = await makeCtx();
    const ancestor = path.dirname(ctx.root); // contains <root>/.sparra → not holdout-free
    expect(holdoutFreeCwd(ctx, ancestor)).toBe(ctx.root);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });
});

describe("decompose runs in a holdout-free cwd", () => {
  it("uses the worktree cwd for a holdout-free workspaceDir", async () => {
    const { ctx, root, wt } = await makeCtx();
    const rec = recorder('[{"id":"item-001","title":"t","summary":"","dependsOn":[],"rationale":""}]');
    await decompose(ctx, wt, true, wt, rec.fn);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.cwd).toBe(wt);
    expect(rec.calls[0]!.cwd).not.toBe(ctx.root);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it("keeps cwd === ctx.root for an in-place build (workspaceDir === ctx.root)", async () => {
    const { ctx, root, wt } = await makeCtx();
    const rec = recorder('[{"id":"item-001","title":"t","summary":"","dependsOn":[],"rationale":""}]');
    await decompose(ctx, ctx.root, true, ctx.root, rec.fn);
    expect(rec.calls[0]!.cwd).toBe(ctx.root);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });
});

describe("negotiateContract runs in a holdout-free cwd", () => {
  it("uses the worktree cwd for BOTH the generator and evaluator calls", async () => {
    const { ctx, root, wt } = await makeCtx();
    // Fresh ctx: no existing contractFile, so the agreed-contract resume doesn't short-circuit.
    // Fake emits CONTRACT: AGREED so the evaluator stops at round 1 (2 calls total).
    const rec = recorder("Proposed.\nCONTRACT: AGREED");
    const res = await negotiateContract(ctx, item, wt, 1, "", wt, rec.fn);
    expect(res.agreed).toBe(true);
    expect(rec.calls).toHaveLength(2); // generator + evaluator
    expect(rec.calls[0]!.role).toBe("contract-generator");
    expect(rec.calls[1]!.role).toBe("contract-evaluator");
    for (const c of rec.calls) {
      expect(c.cwd).toBe(wt);
      expect(c.cwd).not.toBe(ctx.root);
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it("keeps cwd === ctx.root for an in-place build", async () => {
    const { ctx, root, wt } = await makeCtx();
    const rec = recorder("Proposed.\nCONTRACT: AGREED");
    await negotiateContract(ctx, item, ctx.root, 1, "", ctx.root, rec.fn);
    for (const c of rec.calls) expect(c.cwd).toBe(ctx.root);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });
});

describe("the forbid-role deny-decider tracks the holdout-free cwd", () => {
  it("denies the holdout (absolute + pattern) yet allows a pathless search rooted in the worktree", async () => {
    const { ctx, root, wt } = await makeCtx();
    const rec = recorder('[{"id":"item-001","title":"t","summary":"","dependsOn":[],"rationale":""}]');
    await decompose(ctx, wt, true, wt, rec.fn);
    const hooks = rec.calls[0]!.hooks;

    // Absolute path to the holdout is still DENIED (protected regardless of cwd).
    expect(await hooksDeny(hooks, "Read", { file_path: ctx.paths.holdout })).toBe(true);
    // A pattern naming the holdout is DENIED wherever it's rooted.
    expect(await hooksDeny(hooks, "Glob", { pattern: "**/HOLDOUT.md" })).toBe(true);
    // A pathless search now resolves into the holdout-FREE worktree → NOT denied
    // (with the old cwd=ctx.root this WAS denied — proving the decider tracks the new cwd).
    expect(await hooksDeny(hooks, "Grep", { pattern: "byte-identical" })).toBe(false);
    expect(await hooksDeny(hooks, "Grep", { path: ".", pattern: "x" })).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });
});
