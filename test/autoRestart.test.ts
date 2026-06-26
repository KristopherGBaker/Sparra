import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmdBuild, type BuildDeps } from "../src/phases/build.ts";
import { waitMsFor, type AutoRestartConfig } from "../src/build/autoRestart.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig, type SparraConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import type { WorkItem, Verdict } from "../src/build/types.ts";
import type { GenerateOutput } from "../src/build/generate.ts";
import type { EvalOutput } from "../src/build/evaluate.ts";
import type { LimitHit } from "../src/sdk/backend.ts";

function makeVerdict(pass: boolean): Verdict {
  return {
    assertions: [],
    scores: { design: 80, originality: 80, craft: 80, functionality: 80 },
    weightedTotal: pass ? 90 : 30,
    verdict: pass ? "pass" : "fail",
    blocking: pass ? [] : ["nope"],
    notes: "n",
  };
}
function genOut(over: Partial<GenerateOutput> = {}): GenerateOutput {
  return { report: "", deviations: [], sessionId: "g", hitMaxTurns: false, costUsd: 0, tokens: 10, ...over };
}
function evalOut(pass: boolean, over: Partial<EvalOutput> = {}): EvalOutput {
  return { verdict: makeVerdict(pass), raw: "", sessionId: "e", costUsd: 0, tokens: 10, ...over };
}
const RATE: LimitHit = { kind: "rate", raw: "429" };

async function makeCtx(buildOver: Partial<SparraConfig["build"]> = {}): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-ar-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  fs.writeFileSync(paths.frozenPlan, "# Plan\n");
  const store = StateStore.create(paths, "greenfield");
  store.data.phase = "frozen";
  const config = defaultConfig();
  config.build = { ...config.build, ...buildOver };
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
const oneItem: WorkItem[] = [{ id: "item-001", title: "first", summary: "", dependsOn: [], rationale: "" }];

describe("waitMsFor", () => {
  const cfg: AutoRestartConfig = { enabled: true, maxWaitSec: 3600, pollSec: 300, maxRestarts: 20 };
  it("sleeps until a known reset (+5s cushion), capped by maxWaitSec", () => {
    const now = 1_000_000;
    expect(waitMsFor({ kind: "usage", resetAt: now + 60_000, raw: "" }, cfg, now)).toBe(65_000);
    // a reset far past the cap clamps to maxWaitSec
    expect(waitMsFor({ kind: "usage", resetAt: now + 10 * 3600_000, raw: "" }, cfg, now)).toBe(3600_000);
  });
  it("falls back to one poll interval when there is no reset time", () => {
    expect(waitMsFor({ kind: "rate", raw: "" }, cfg, 1_000_000)).toBe(300_000);
  });
});

describe("cmdBuild — auto-restart on provider limit", () => {
  it("waits for the window then retries the SAME round (no fallback configured)", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 6 });
    ctx.config.build.autoRestart = { enabled: true, maxWaitSec: 3600, pollSec: 300, maxRestarts: 20 };
    let waited = 0;
    const genModels: string[] = [];
    let call = 0;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => oneItem,
      generateItem: async (a) => {
        genModels.push(a.role!.model);
        return ++call === 1 ? genOut({ limitHit: RATE }) : genOut(); // limit once, then succeed
      },
      evaluateItem: async () => evalOut(true),
      waitForLimit: async () => {
        waited++;
      },
    };
    const res = await cmdBuild(ctx, { workspaceOverride: dir }, deps);

    expect(waited).toBe(1);
    expect(ctx.store.data.build.restarts).toBe(1);
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed");
    expect(res.passed).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("switches to a fallback model on a DIFFERENT backend instead of waiting", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 6 });
    ctx.config.build.autoRestart = { enabled: true, maxWaitSec: 3600, pollSec: 300, maxRestarts: 20 };
    ctx.config.roles.generator = { backend: "codex", model: "gpt", fallback: { backend: "claude", model: "opus" } };
    let waited = 0;
    const genModels: string[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => oneItem,
      generateItem: async (a) => {
        genModels.push(a.role!.model);
        return a.role!.model === "gpt" ? genOut({ limitHit: RATE }) : genOut(); // codex limited, claude ok
      },
      evaluateItem: async () => evalOut(true),
      waitForLimit: async () => {
        waited++;
      },
    };
    const res = await cmdBuild(ctx, { workspaceOverride: dir }, deps);

    expect(waited).toBe(0); // fell back, never slept
    expect(genModels).toEqual(["gpt", "opus"]); // primary then fallback
    expect(ctx.store.data.build.limitedRoles).toHaveProperty("codex");
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed");
    expect(res.passed).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("halts the run (resumable) when maxRestarts is reached, leaving the item mid-flight", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 6 });
    ctx.config.build.autoRestart = { enabled: true, maxWaitSec: 3600, pollSec: 300, maxRestarts: 1 };
    let waited = 0;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => oneItem,
      generateItem: async () => genOut({ limitHit: RATE }), // always limited, no fallback
      evaluateItem: async () => evalOut(true),
      waitForLimit: async () => {
        waited++;
      },
    };
    const res = await cmdBuild(ctx, { workspaceOverride: dir }, deps);

    expect(waited).toBe(1); // one wait, then the second limit exceeds maxRestarts
    expect(res.passed).toBe(0);
    expect(ctx.store.data.phase).toBe("build"); // NOT "done" — paused, resumable
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("building"); // not marked failed
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ignores limits when auto-restart is disabled (limitHit treated as a normal round)", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    ctx.config.build.autoRestart = { enabled: false, maxWaitSec: 3600, pollSec: 300, maxRestarts: 20 };
    let waited = 0;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => oneItem,
      generateItem: async () => genOut({ limitHit: RATE }),
      evaluateItem: async () => evalOut(false), // never passes
      waitForLimit: async () => {
        waited++;
      },
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(waited).toBe(0);
    // ran the rounds normally and gave up as failed (no waiting, no halt)
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("failed");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
