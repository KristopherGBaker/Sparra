import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmdBuild, type BuildDeps } from "../src/phases/build.ts";
import { pauseDir } from "../src/build/interactive.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig, type SparraConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import type { WorkItem, Verdict } from "../src/build/types.ts";
import type { GenerateOutput } from "../src/build/generate.ts";
import type { EvalOutput } from "../src/build/evaluate.ts";

function makeVerdict(pass: boolean): Verdict {
  return {
    assertions: [{ id: 1, pass, evidence: "e" }],
    scores: { design: 80, originality: 80, craft: 80, functionality: 80 },
    weightedTotal: pass ? 90 : 30,
    verdict: pass ? "pass" : "fail",
    blocking: pass ? [] : ["something is wrong"],
    notes: "n",
  };
}
const genOut = (over: Partial<GenerateOutput> = {}): GenerateOutput => ({ report: "", deviations: [], sessionId: "g", hitMaxTurns: false, costUsd: 0.001, tokens: 100, ...over });
const evalOut = (pass: boolean): EvalOutput => ({ verdict: makeVerdict(pass), raw: "", sessionId: "e", costUsd: 0.001, tokens: 100 });

async function makeCtx(buildOver: Partial<SparraConfig["build"]> = {}): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-interactive-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  fs.writeFileSync(paths.frozenPlan, "# Plan\nBuild some things.\n");
  const store = StateStore.create(paths, "greenfield");
  store.data.phase = "frozen";
  const config = defaultConfig();
  config.build = { ...config.build, maxBudgetUsdPerItem: 0, maxRoundsPerItem: 6, ...buildOver };
  return { ctx: { root: dir, paths, config, store }, dir };
}

function baseDeps(): Partial<BuildDeps> {
  return {
    ensureAutoProbed: async () => {},
    negotiateContract: async () => ({ text: "contract", agreed: true, tracesUsed: 0 }),
    recordDeviations: async () => ({ changelog: 0, proposals: 0 }),
    reconcilePlan: async () => {},
  };
}

const item: WorkItem = { id: "item-001", title: "first", summary: "", dependsOn: [], rationale: "" };

function setDecision(ctx: Ctx, decision: string, reason = "", feedback?: string): void {
  const runId = ctx.store.data.build.runId!;
  const dir = pauseDir(ctx, runId, "item-001");
  fs.writeFileSync(path.join(dir, "decision.json"), JSON.stringify({ decision, reason }));
  if (feedback != null) fs.writeFileSync(path.join(dir, "feedback.md"), feedback);
}
const status = (ctx: Ctx) => ctx.store.data.build.items["item-001"]!.status;

describe("cmdBuild --step=round — pause after evaluate", () => {
  it("pauses after the round, writing a steering folder; the item stays mid-flight", async () => {
    const { ctx, dir } = await makeCtx();
    const genCalls: unknown[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async () => { genCalls.push(1); return genOut(); },
      evaluateItem: async () => evalOut(false),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["round"] }, deps);

    expect(genCalls).toHaveLength(1); // generated once, then paused — no second round
    expect(ctx.store.data.build.paused).toMatchObject({ kind: "round", itemId: "item-001", round: 1 });
    expect(status(ctx)).toBe("building"); // NOT marked failed
    const pd = pauseDir(ctx, ctx.store.data.build.runId!, "item-001");
    expect(fs.existsSync(path.join(pd, "pause.md"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(pd, "decision.json"), "utf8")).decision).toBe("continue");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdBuild --step=round — resume decisions", () => {
  it("continue: feeds the edited feedback into the next round", async () => {
    const { ctx, dir } = await makeCtx();
    const feedbacks: (string | undefined)[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async (a) => { feedbacks.push(a.feedback); return genOut(); },
      evaluateItem: async () => evalOut(false),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["round"] }, deps); // pause @ round 1
    setDecision(ctx, "continue", "", "FOCUS: fix the parser");
    await cmdBuild(ctx, { workspaceOverride: dir }, deps); // resume → round 2, pause again

    expect(feedbacks[0]).toBeUndefined(); // round 1 had no feedback
    expect(feedbacks[1]).toContain("FOCUS: fix the parser"); // round 2 got the human's edit
    expect(ctx.store.data.build.paused?.round).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("pivot: restarts fresh and bumps the pivot count", async () => {
    const { ctx, dir } = await makeCtx();
    const freshFlags: boolean[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async (a) => { freshFlags.push(!!a.fresh); return genOut(); },
      evaluateItem: async () => evalOut(false),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["round"] }, deps);
    setDecision(ctx, "pivot", "", "try a different design");
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);

    expect(freshFlags[1]).toBe(true); // round 2 generated fresh
    expect(ctx.store.data.build.items["item-001"]!.pivots).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accept on a pass: reconciles and marks the item passed", async () => {
    const { ctx, dir } = await makeCtx();
    let reconciled = false;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true), // passing → default decision "accept"
      reconcilePlan: async () => { reconciled = true; },
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["round"] }, deps); // pause @ round 1 (pass)
    await cmdBuild(ctx, { workspaceOverride: dir }, deps); // resume with default accept

    expect(status(ctx)).toBe("passed");
    expect(reconciled).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accept override on a FAIL: requires a reason, then records it", async () => {
    const { ctx, dir } = await makeCtx();
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(false),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["round"] }, deps); // pause @ round 1 (fail)

    setDecision(ctx, "accept", ""); // override a FAIL with no reason → stays paused
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(status(ctx)).toBe("building");
    expect(ctx.store.data.build.paused?.kind).toBe("round");

    setDecision(ctx, "accept", "ship it — the failing assertion is out of scope");
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(status(ctx)).toBe("passed");
    expect(ctx.store.data.build.items["item-001"]!.overrideReason).toMatch(/out of scope/);
    expect(fs.readFileSync(ctx.paths.memory, "utf8")).toMatch(/OVERRIDING/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("abandon: marks the item abandoned", async () => {
    const { ctx, dir } = await makeCtx();
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(false),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["round"] }, deps);
    setDecision(ctx, "abandon");
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(status(ctx)).toBe("abandoned");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an accept reason that leaks the holdout (it would reach memory→generators)", async () => {
    const { ctx, dir } = await makeCtx();
    fs.writeFileSync(ctx.paths.holdout, "# Holdout\n- The exact byte-for-byte output must equal the golden file.\n");
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(false),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["round"] }, deps);
    setDecision(ctx, "accept", "ok because The exact byte-for-byte output must equal the golden file.");
    await expect(cmdBuild(ctx, { workspaceOverride: dir }, deps)).rejects.toThrow(/holdout/i);
    expect(status(ctx)).toBe("building"); // not accepted
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects feedback.md that leaks the holdout", async () => {
    const { ctx, dir } = await makeCtx();
    fs.writeFileSync(ctx.paths.holdout, "# Holdout\n- The exact byte-for-byte output must equal the golden file.\n");
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(false),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["round"] }, deps);
    setDecision(ctx, "continue", "", "The exact byte-for-byte output must equal the golden file.");
    await expect(cmdBuild(ctx, { workspaceOverride: dir }, deps)).rejects.toThrow(/holdout/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdBuild --step — resume safety", () => {
  it("--fresh clears a prior interactive mode + pause (a fresh run is autonomous)", async () => {
    const { ctx, dir } = await makeCtx();
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["round"] }, deps); // pause @ round 1
    expect(ctx.store.data.build.paused).toBeTruthy();

    await cmdBuild(ctx, { workspaceOverride: dir, fresh: true }, deps); // fresh → autonomous
    expect(ctx.store.data.build.step).toBeUndefined();
    expect(ctx.store.data.build.paused).toBeUndefined();
    expect(status(ctx)).toBe("passed"); // ran to completion without pausing
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a --only that would skip the paused item", async () => {
    const { ctx, dir } = await makeCtx();
    const two = [item, { id: "item-002", title: "second", summary: "", dependsOn: [], rationale: "" }];
    const calls: string[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => two,
      generateItem: async (a) => { calls.push(a.item.id); return genOut(); },
      evaluateItem: async () => evalOut(false),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["round"] }, deps); // pause @ item-001
    calls.length = 0;
    await cmdBuild(ctx, { workspaceOverride: dir, only: "item-002" }, deps); // should refuse
    expect(calls).toHaveLength(0); // nothing generated — refused
    expect(ctx.store.data.build.paused?.itemId).toBe("item-001"); // pause intact
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdBuild --step=contract — pause before generation", () => {
  it("pauses after negotiation (before generating), then resumes into the build", async () => {
    const { ctx, dir } = await makeCtx();
    const genCalls: unknown[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async () => { genCalls.push(1); return genOut(); },
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["contract"] }, deps);
    expect(genCalls).toHaveLength(0); // paused BEFORE generation
    expect(ctx.store.data.build.paused).toMatchObject({ kind: "contract", itemId: "item-001" });
    expect(fs.existsSync(path.join(pauseDir(ctx, ctx.store.data.build.runId!, "item-001"), "pause.md"))).toBe(true);

    await cmdBuild(ctx, { workspaceOverride: dir }, deps); // resume → contract acked → builds (passes)
    expect(genCalls).toHaveLength(1);
    expect(status(ctx)).toBe("passed");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
