import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmdBuild, type BuildDeps } from "../src/phases/build.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig, type SparraConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import type { WorkItem, Verdict } from "../src/build/types.ts";
import type { GenerateOutput } from "../src/build/generate.ts";
import type { EvalOutput } from "../src/build/evaluate.ts";

function makeVerdict(pass: boolean, scores: Partial<Verdict["scores"]> = {}): Verdict {
  return {
    assertions: [],
    scores: { design: 80, originality: 80, craft: 80, functionality: 80, ...scores },
    weightedTotal: pass ? 90 : 30,
    verdict: pass ? "pass" : "fail",
    blocking: pass ? [] : ["something is wrong"],
    notes: "n",
  };
}

function genOut(over: Partial<GenerateOutput> = {}): GenerateOutput {
  return { report: "", deviations: [], sessionId: "g", hitMaxTurns: false, costUsd: 0.001, tokens: 100, ...over };
}
function evalOut(pass: boolean, over: Partial<EvalOutput> = {}): EvalOutput {
  return { verdict: makeVerdict(pass), raw: "", sessionId: "e", costUsd: 0.001, tokens: 100, ...over };
}

async function makeCtx(buildOver: Partial<SparraConfig["build"]> = {}): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-build-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  fs.writeFileSync(paths.frozenPlan, "# Plan\nBuild some things.\n");
  const store = StateStore.create(paths, "greenfield");
  store.data.phase = "frozen";
  const config = defaultConfig();
  config.build = { ...config.build, ...buildOver };
  return { ctx: { root: dir, paths, config, store }, dir };
}

/** Deps that never touch the SDK/git; per-test overrides supply generate/evaluate. */
function baseDeps(): Partial<BuildDeps> {
  return {
    ensureAutoProbed: async () => {},
    negotiateContract: async () => ({ text: "contract", agreed: true, tracesUsed: 0 }),
    recordDeviations: async () => ({ changelog: 0, proposals: 0 }),
    reconcilePlan: async () => {},
  };
}

const items: WorkItem[] = [
  { id: "item-001", title: "first", summary: "", dependsOn: [], rationale: "" },
  { id: "item-002", title: "second", summary: "", dependsOn: [], rationale: "" },
];

describe("cmdBuild — per-item budget guard (CHANGE 1)", () => {
  it("halts an item as budget_exceeded when its USD cost crosses the cap, and continues to the next item", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0.01, maxRoundsPerItem: 6 });
    const genCalls: string[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => items,
      generateItem: async (args) => {
        genCalls.push(args.item.id);
        // item-001 immediately blows the tiny cap; item-002 is cheap.
        return genOut({ costUsd: args.item.id === "item-001" ? 5 : 0.001 });
      },
      evaluateItem: async (args) => evalOut(args.item.id === "item-002"),
    };

    const res = await cmdBuild(ctx, { workspaceOverride: dir }, deps);

    expect(ctx.store.data.build.items["item-001"]!.status).toBe("budget_exceeded");
    expect(ctx.store.data.build.items["item-002"]!.status).toBe("passed");
    expect(res.budgetExceeded).toBe(1);
    expect(res.passed).toBe(1);
    // The run did not crash — it moved on and exercised item-002.
    expect(genCalls).toContain("item-002");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("halts on the TOKEN cap (the subscription lever) and continues the run", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxTokensPerItem: 1000, maxRoundsPerItem: 6 });
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => items,
      generateItem: async (args) =>
        // item-001 blows the token cap on the first round; item-002 stays small.
        genOut({ tokens: args.item.id === "item-001" ? 5000 : 50, costUsd: 0 }),
      evaluateItem: async (args) => evalOut(args.item.id === "item-002", { tokens: 50, costUsd: 0 }),
    };

    const res = await cmdBuild(ctx, { workspaceOverride: dir }, deps);

    expect(ctx.store.data.build.items["item-001"]!.status).toBe("budget_exceeded");
    expect(ctx.store.data.build.items["item-001"]!.tokensUsed).toBeGreaterThanOrEqual(1000);
    expect(ctx.store.data.build.items["item-002"]!.status).toBe("passed");
    expect(res.budgetExceeded).toBe(1);
    expect(res.passed).toBe(1);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not cap when both budgets are 0 (explicit opt-out)", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxTokensPerItem: 0, maxRoundsPerItem: 2 });
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [items[0]!],
      generateItem: async () => genOut({ costUsd: 1000, tokens: 10_000_000 }),
      evaluateItem: async () => evalOut(true, { costUsd: 1000, tokens: 10_000_000 }),
    };
    const res = await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(res.budgetExceeded).toBe(0);
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdBuild — cross-run memory on pivot (CHANGE 3)", () => {
  it("writes a pivot learning to memory.md and injects prior learnings into the next item's prompt input", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 4 });
    const injected: Record<string, string> = {};
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => items,
      generateItem: async (args) => {
        injected[args.item.id] = args.priorLearnings ?? "";
        return genOut();
      },
      evaluateItem: async (args) =>
        // item-001 keeps failing on the SAME criterion (craft) → GAN pivot at N=3.
        args.item.id === "item-002" ? evalOut(true) : evalOut(false, { verdict: makeVerdict(false, { craft: 10 }) }),
    };

    await cmdBuild(ctx, { workspaceOverride: dir }, deps);

    // A pivot learning was persisted to memory.md.
    const mem = fs.readFileSync(ctx.paths.memory, "utf8");
    expect(mem).toMatch(/PIVOT/);
    expect(mem).toContain("item-001");
    expect(ctx.store.data.build.items["item-001"]!.pivots).toBeGreaterThanOrEqual(1);

    // The NEXT item received that memory in its session prompt input.
    expect(injected["item-002"]).toMatch(/PIVOT/);
    expect(injected["item-002"]).toContain("item-001");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdBuild — code review gate (opt-in)", () => {
  it("blocks a behaviorally-passing item until code review is clean", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 3 });
    ctx.config.review.enabled = true;
    const reviewRounds: number[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [items[0]!],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true), // always passes the exercise
      reviewItem: async (args) => {
        reviewRounds.push(args.round);
        const blocking = args.round === 1 ? ["App.swift:5 — committed API key"] : [];
        return { findings: [], blocking, advisory: [], raw: "", sessionId: "rv", costUsd: 0, tokens: 5 };
      },
    };

    const res = await cmdBuild(ctx, { workspaceOverride: dir }, deps);

    // Blocked on round 1, re-reviewed on round 2, then accepted.
    expect(reviewRounds).toEqual([1, 2]);
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed");
    expect(res.passed).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not run code review when disabled (default)", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    let reviewed = false;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [items[0]!],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
      reviewItem: async () => {
        reviewed = true;
        return { findings: [], blocking: [], advisory: [], raw: "", sessionId: "rv", costUsd: 0, tokens: 0 };
      },
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(reviewed).toBe(false);
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdBuild — conventional commits (opt-in, branch-only)", () => {
  it("commits each accepted item onto the Sparra branch when autoCommit is on", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    ctx.config.git.autoCommit = true;
    const commits: string[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      prepareWorkspace: () => ({ dir, branch: "sparra/test", note: "test worktree" }),
      decompose: async () => [items[0]!],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
      commitWork: (_cwd, message) => {
        commits.push(message);
        return { ok: true, out: "" };
      },
    };
    await cmdBuild(ctx, {}, deps); // no workspaceOverride → prepareWorkspace sets the branch
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatch(/^feat: /);
    expect(commits[0]).toContain("Sparra-Item: item-001");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not commit when autoCommit is off (default)", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    let committed = false;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      prepareWorkspace: () => ({ dir, branch: "sparra/test", note: "t" }),
      decompose: async () => [items[0]!],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
      commitWork: () => {
        committed = true;
        return { ok: true, out: "" };
      },
    };
    await cmdBuild(ctx, {}, deps);
    expect(committed).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not commit in-place (no Sparra branch) even when autoCommit is on", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    ctx.config.git.autoCommit = true;
    let committed = false;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      prepareWorkspace: () => ({ dir, branch: undefined, note: "running in place" }),
      decompose: async () => [items[0]!],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
      commitWork: () => {
        committed = true;
        return { ok: true, out: "" };
      },
    };
    await cmdBuild(ctx, {}, deps);
    expect(committed).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
