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
  it("halts an item as budget_exceeded when its cost crosses the cap, and continues to the next item", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0.01, maxRoundsPerItem: 6 });
    const genCalls: string[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => items,
      generateItem: async (args) => {
        genCalls.push(args.item.id);
        // item-001 immediately blows the tiny cap; item-002 is cheap.
        const costUsd = args.item.id === "item-001" ? 5 : 0.001;
        return { report: "", deviations: [], sessionId: "g", hitMaxTurns: false, costUsd };
      },
      evaluateItem: async (args) => ({
        verdict: makeVerdict(args.item.id === "item-002"),
        raw: "",
        sessionId: "e",
        costUsd: 0.001,
      }),
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

  it("does not cap when maxBudgetUsdPerItem is 0 (explicit opt-out)", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [items[0]!],
      generateItem: async () => ({ report: "", deviations: [], sessionId: "g", hitMaxTurns: false, costUsd: 1000 }),
      evaluateItem: async () => ({ verdict: makeVerdict(true), raw: "", sessionId: "e", costUsd: 1000 }),
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
        return { report: "", deviations: [], sessionId: "g", hitMaxTurns: false, costUsd: 0.001 };
      },
      evaluateItem: async (args) => {
        // item-001 keeps failing on the SAME criterion (craft) → GAN pivot at N=3.
        if (args.item.id === "item-002") return { verdict: makeVerdict(true), raw: "", sessionId: "e", costUsd: 0.001 };
        return { verdict: makeVerdict(false, { craft: 10 }), raw: "", sessionId: "e", costUsd: 0.001 };
      },
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
