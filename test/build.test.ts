import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmdBuild, type BuildDeps } from "../src/phases/build.ts";
import { decompose } from "../src/build/decompose.ts";
import { diffClaims } from "../src/build/claims.ts";
import { DEFAULT_PROMPTS } from "../src/prompts.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { maybeResetWorkspace, type ResetDeps } from "../src/build/reset.ts";
import { APPROACH_CAP, FAILURE_CAP } from "../src/build/attempts.ts";
import { TRUNCATION_MARKER } from "../src/build/feedback.ts";
import { defaultConfig, type SparraConfig } from "../src/config.ts";
import { TECHNIQUE_MARKER } from "../src/memory.ts";
import type { Ctx } from "../src/context.ts";
import type { WorkItem, Verdict } from "../src/build/types.ts";
import { generateItem, type GenerateOutput } from "../src/build/generate.ts";
import type { EvalOutput } from "../src/build/evaluate.ts";
import type { CommandExecutor, ExecOutcome } from "../src/build/exec.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";
import type { LimitHit } from "../src/sdk/backend.ts";

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

function captureStdout() {
  // The logger is silenced under vitest; lift the gate via the documented escape hatch while capturing.
  const priorLogInTests = process.env.SPARRA_LOG_IN_TESTS;
  process.env.SPARRA_LOG_IN_TESTS = "1";
  let buf = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
  return {
    lines: () => buf,
    restore: () => {
      spy.mockRestore();
      if (priorLogInTests === undefined) delete process.env.SPARRA_LOG_IN_TESTS;
      else process.env.SPARRA_LOG_IN_TESTS = priorLogInTests;
    },
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

  it("halts on build.zeroCostTokenCap when the USD cap is active but reported cost is zero", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 5, maxTokensPerItem: 0, zeroCostTokenCap: 1000, maxRoundsPerItem: 6 });
    const out = captureStdout();
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [items[0]!],
      generateItem: async () => genOut({ costUsd: 0, tokens: 1000 }),
      evaluateItem: async () => evalOut(true),
    };

    const res = await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    out.restore();

    expect(ctx.store.data.build.items["item-001"]!.status).toBe("budget_exceeded");
    expect(res.budgetExceeded).toBe(1);
    expect(out.lines()).toMatch(/build\.zeroCostTokenCap 1000/i);
    expect(out.lines()).toMatch(/USD cap did not bind because reported cost was zero or unknown/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("treats missing costUsd as zero for the fallback cap and keeps item cost finite", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 5, maxTokensPerItem: 0, zeroCostTokenCap: 1000, maxRoundsPerItem: 6 });
    const out = captureStdout();
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [items[0]!],
      generateItem: async () => ({ ...genOut({ tokens: 1000 }), costUsd: undefined as unknown as number }),
      evaluateItem: async () => evalOut(true),
    };

    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    out.restore();

    const st = ctx.store.data.build.items["item-001"]!;
    expect(st.status).toBe("budget_exceeded");
    expect(Number.isFinite(st.costUsd)).toBe(true);
    expect(st.costUsd).toBe(0);
    expect(out.lines()).toMatch(/zero or unknown/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not halt on the zero-cost fallback when build.zeroCostTokenCap is 0", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 5, maxTokensPerItem: 0, zeroCostTokenCap: 0, maxRoundsPerItem: 2 });
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [items[0]!],
      generateItem: async () => genOut({ costUsd: 0, tokens: 10_000_000 }),
      evaluateItem: async () => evalOut(true, { costUsd: 0, tokens: 10_000_000 }),
    };

    const res = await cmdBuild(ctx, { workspaceOverride: dir }, deps);

    expect(res.budgetExceeded).toBe(0);
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("names explicit maxTokensPerItem as the effective cap when it overrides zeroCostTokenCap", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 5, maxTokensPerItem: 50_000, zeroCostTokenCap: 1000, maxRoundsPerItem: 2 });
    const out = captureStdout();
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [items[0]!],
      generateItem: async () => genOut({ costUsd: 0, tokens: 10 }),
      evaluateItem: async () => evalOut(true, { costUsd: 0, tokens: 10 }),
    };

    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    out.restore();

    expect(out.lines()).toMatch(/build\.maxTokensPerItem \(50000 tokens\)/);
    expect(out.lines()).not.toMatch(/effective token bound: build\.zeroCostTokenCap/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not warn or fallback-halt when reported cost is nonzero", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 5, maxTokensPerItem: 0, zeroCostTokenCap: 1000, maxRoundsPerItem: 2 });
    const out = captureStdout();
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [items[0]!],
      generateItem: async () => genOut({ costUsd: 0.001, tokens: 10_000 }),
      evaluateItem: async () => evalOut(true, { costUsd: 0.001, tokens: 10_000 }),
    };

    const res = await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    out.restore();

    expect(res.budgetExceeded).toBe(0);
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed");
    expect(out.lines()).not.toMatch(/zero or unknown/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdBuild — per-assertion escalation register (U2)", () => {
  const longEvidence = "diagnostic detail ".repeat(30) + "TRAILING-ROOT-CAUSE"; // > EVIDENCE_CAP
  function patchFailEval(): EvalOutput {
    return {
      verdict: {
        assertions: [{ id: 2, pass: false, evidence: longEvidence }],
        scores: { design: 60, originality: 60, craft: 60, functionality: 60 }, // all >= pivot threshold → patch, not pivot
        weightedTotal: 40,
        verdict: "fail",
        blocking: ["assertion 2 keeps failing"],
        notes: "n",
      },
      raw: "",
      sessionId: "e",
      costUsd: 0.001,
      tokens: 100,
    };
  }

  it("escalates after K same-assertion fails: round-3 feedback uncaps #2's evidence + diagnose-first; earlier round not escalated", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 3, assertionEscalateAfter: 2 });
    const feedbacks: (string | undefined)[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [items[0]!],
      generateItem: async (args) => {
        feedbacks.push(args.feedback);
        return genOut();
      },
      evaluateItem: async () => patchFailEval(),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    const st = ctx.store.data.build.items["item-001"]!;
    expect(st.assertionFailStreak?.["2"]).toBeGreaterThanOrEqual(2);
    // Feedback delivered into round 3's generate was computed once #2's streak hit K=2.
    expect(feedbacks[2]).toContain("DIAGNOSE FIRST");
    expect(feedbacks[2]).toContain("#2");
    expect(feedbacks[2]).toContain(longEvidence); // uncapped
    // Round 2's feedback (streak only 1) is a plain, capped patch.
    expect(feedbacks[1]).not.toContain("DIAGNOSE FIRST");
    expect(feedbacks[1]).not.toContain(longEvidence);
    expect(feedbacks[1]).toContain(TRUNCATION_MARKER);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("disabled (assertionEscalateAfter:0): never escalates even after repeated same-assertion fails", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 3, assertionEscalateAfter: 0 });
    const feedbacks: (string | undefined)[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [items[0]!],
      generateItem: async (args) => {
        feedbacks.push(args.feedback);
        return genOut();
      },
      evaluateItem: async () => patchFailEval(),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    for (const fb of feedbacks) {
      if (!fb) continue;
      expect(fb).not.toContain("DIAGNOSE FIRST");
      expect(fb).not.toContain(longEvidence);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reset on GAN pivot: the generate right after the pivot sees an empty assertionFailStreak (cleared with criterionFailStreak)", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 4, assertionEscalateAfter: 2 });
    const streaksAtGen: Record<string, number>[] = [];
    const critAtGen: Record<string, number>[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [items[0]!],
      generateItem: async () => {
        const s = ctx.store.data.build.items["item-001"];
        streaksAtGen.push({ ...(s?.assertionFailStreak ?? {}) });
        critAtGen.push({ ...(s?.criterionFailStreak ?? {}) });
        return genOut();
      },
      // Same criterion (craft) below threshold every round → GAN pivot at N=3; #2 fails every round.
      evaluateItem: async () => ({
        verdict: {
          assertions: [{ id: 2, pass: false, evidence: "still broken" }],
          scores: { design: 80, originality: 80, craft: 10, functionality: 80 },
          weightedTotal: 40,
          verdict: "fail",
          blocking: ["b"],
          notes: "n",
        },
        raw: "",
        sessionId: "e",
        costUsd: 0.001,
        tokens: 100,
      }),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    const st = ctx.store.data.build.items["item-001"]!;
    expect(st.pivots).toBeGreaterThanOrEqual(1);
    // Round 3's generate saw a growing streak; round 4's (right after the pivot) saw both maps reset.
    expect(streaksAtGen[2]).toEqual({ "2": 2 });
    expect(streaksAtGen[3]).toEqual({});
    expect(critAtGen[3]).toEqual({});
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

describe("cmdBuild — commit gating (opt-in, branch-only)", () => {
  it("commits each accepted item onto the Sparra branch when autoCommit is on", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    ctx.config.git.autoCommit = true;
    const committed: string[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      prepareWorkspace: () => ({ dir, branch: "sparra/test", note: "test worktree" }),
      decompose: async () => [items[0]!],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
      commitItem: async (_ctx, a) => {
        committed.push(a.item.id);
        return { ok: true, commits: 1 };
      },
    };
    await cmdBuild(ctx, {}, deps); // no workspaceOverride → prepareWorkspace sets the branch
    expect(committed).toEqual(["item-001"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not commit when autoCommit is off (default)", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    let called = false;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      prepareWorkspace: () => ({ dir, branch: "sparra/test", note: "t" }),
      decompose: async () => [items[0]!],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
      commitItem: async () => {
        called = true;
        return { ok: true, commits: 1 };
      },
    };
    await cmdBuild(ctx, {}, deps);
    expect(called).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not commit in-place (no Sparra branch) even when autoCommit is on", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    ctx.config.git.autoCommit = true;
    let called = false;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      prepareWorkspace: () => ({ dir, branch: undefined, note: "running in place" }),
      decompose: async () => [items[0]!],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
      commitItem: async () => {
        called = true;
        return { ok: true, commits: 1 };
      },
    };
    await cmdBuild(ctx, {}, deps);
    expect(called).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdBuild — worktree dep provisioning (CHANGE D)", () => {
  it("calls provisionWorkspaceDeps once with (root, workspaceDir, cfg) when workspaceDir !== root", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    const wt = dir + "-wt"; // a worktree path distinct from the repo root
    const calls: Array<{ root: string; ws: string; cfg: unknown }> = [];
    const prewarmCalls: Array<{ root: string; ws: string; cfg: unknown }> = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      prepareWorkspace: () => ({ dir: wt, branch: "sparra/test", note: "t" }),
      provisionWorkspaceDeps: (root, ws, cfg) => {
        calls.push({ root, ws, cfg });
        return { copied: [], skipped: [], failed: [] };
      },
      // U-X: the SwiftPM prewarm runs at PROVISIONING time (before any generate/evaluate).
      prewarmSwiftPackages: (root, ws, cfg) => {
        prewarmCalls.push({ root, ws, cfg });
        return { ran: false, ok: false, skipped: "not-a-swift-package" };
      },
      decompose: async () => [items[0]!],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, {}, deps); // no override → prepareWorkspace yields the (distinct) worktree
    expect(calls.length).toBe(1);
    expect(calls[0]!.root).toBe(ctx.root);
    expect(calls[0]!.ws).toBe(wt);
    expect(calls[0]!.cfg).toEqual(ctx.config.git.provisionDeps); // exact config threaded through
    // U-X: prewarm invoked once at provisioning with the SAME (root, worktree, cfg).
    expect(prewarmCalls.length).toBe(1);
    expect(prewarmCalls[0]!.root).toBe(ctx.root);
    expect(prewarmCalls[0]!.ws).toBe(wt);
    expect(prewarmCalls[0]!.cfg).toEqual(ctx.config.git.provisionDeps);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT provision when workspaceDir === root (in-place / override === root)", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    let called = false;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      provisionWorkspaceDeps: () => {
        called = true;
        return { copied: [], skipped: [], failed: [] };
      },
      decompose: async () => [items[0]!],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps); // override === ctx.root
    expect(called).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdBuild — hybrid generation routing (gen: local)", () => {
  it("routes items tagged gen:'local' to roles.generatorLocal and others to roles.generator", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    ctx.config.roles.generatorLocal = { backend: "codex", model: "local-qwen", baseUrl: "http://localhost:1234/v1" };
    const routed: WorkItem[] = [
      { id: "item-001", title: "trivial", summary: "", dependsOn: [], rationale: "", gen: "local" },
      { id: "item-002", title: "hard", summary: "", dependsOn: [], rationale: "" },
    ];
    const seenModel: Record<string, string | undefined> = {};
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => routed,
      generateItem: async (args) => {
        seenModel[args.item.id] = args.role?.model;
        return genOut();
      },
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(seenModel["item-001"]).toBe("local-qwen"); // tagged → local generator
    expect(seenModel["item-002"]).toBe(ctx.config.roles.generator.model); // default → main generator
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the main generator when gen:'local' but no generatorLocal is configured", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    const routed: WorkItem[] = [
      { id: "item-001", title: "trivial", summary: "", dependsOn: [], rationale: "", gen: "local" },
    ];
    let seen: string | undefined;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => routed,
      generateItem: async (args) => {
        seen = args.role?.model;
        return genOut();
      },
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(seen).toBe(ctx.config.roles.generator.model);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdBuild — flakiness RERUN gate (Q3)", () => {
  /** A contract whose "I will verify by" section carries ONE runnable command. */
  const contractWithVerify = async () => ({
    text: "## Item\nthing\n## I will verify by\n- `npm test` → exit 0\n## Assertions\n1. works",
    agreed: true,
    tracesUsed: 0,
  });
  const one: WorkItem[] = [{ id: "item-001", title: "only", summary: "", dependsOn: [], rationale: "" }];
  /** Fake executor: dequeues scripted exit codes; never spawns anything. */
  const scriptedExec = (exits: number[]) => {
    const calls: string[] = [];
    const fn = async (_ws: string, command: string) => {
      calls.push(command);
      const exitCode = exits.shift() ?? 0;
      return { ran: true as const, command, exitCode, stdout: "", stderr: exitCode ? "1 test failed" : "", timedOut: false };
    };
    return { calls, fn };
  };

  it("(a) mixed exits across reruns → demoted to fail, blocking feedback names the flaky command", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    const exec = scriptedExec([0, 1, 0, 0]); // round 1 gate: flaky (0 then 1); round 2 gate: clean
    const feedbacks: (string | undefined)[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      negotiateContract: contractWithVerify,
      decompose: async () => one,
      generateItem: async (args) => {
        feedbacks.push(args.feedback);
        return genOut();
      },
      evaluateItem: async () => evalOut(true), // evaluator says pass EVERY round
      execVerifyCommand: exec.fn,
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);

    const st = ctx.store.data.build.items["item-001"]!;
    expect(st.status).toBe("passed"); // round 2's clean reruns kept the pass
    expect(st.round).toBe(2); // …but round 1's pass WAS demoted (a second round happened)
    expect(feedbacks[1]).toMatch(/RERUN GATE/);
    expect(feedbacks[1]).toContain("npm test"); // blocking feedback names the flaky command
    expect(feedbacks[1]).toMatch(/FLAKY/);
    const mem = fs.readFileSync(ctx.paths.memory, "utf8");
    expect(mem).toMatch(/demoted by rerun gate/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(b) deterministic nonzero across ALL reruns → demoted as failing-as-shipped", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 1 });
    const exec = scriptedExec([1, 1]);
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      negotiateContract: contractWithVerify,
      decompose: async () => one,
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
      execVerifyCommand: exec.fn,
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("failed"); // pass verdict did NOT survive
    const mem = fs.readFileSync(ctx.paths.memory, "utf8");
    expect(mem).toMatch(/rerun gate/);
    expect(mem).toMatch(/failing/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(d) an UNSAFE contracted command (never ran) demotes the pass; blocking feedback names it", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    // The contract shipped with a chained command the safety rules reject — the executor
    // (mirroring the real one) reports it unsafe WITHOUT running it, every round.
    const calls: string[] = [];
    const unsafeExec = async (_ws: string, command: string) => {
      calls.push(command);
      return { ran: false as const, command, unsafeReason: "chained command (&&) — single self-contained commands only" };
    };
    const feedbacks: (string | undefined)[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      negotiateContract: async () => ({
        text: "## Item\nthing\n## I will verify by\n- `npm test && true` → exit 0\n## Assertions\n1. works",
        agreed: true,
        tracesUsed: 0,
      }),
      decompose: async () => one,
      generateItem: async (args) => {
        feedbacks.push(args.feedback);
        return genOut();
      },
      evaluateItem: async () => evalOut(true), // evaluator says pass EVERY round
      execVerifyCommand: unsafeExec,
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);

    // The pass never survives: the contracted command was never witnessed exiting 0.
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("failed");
    expect(feedbacks[1]).toMatch(/RERUN GATE/);
    expect(feedbacks[1]).toContain("npm test && true"); // blocking feedback names the unsafe command
    expect(feedbacks[1]).toMatch(/UNSAFE/);
    expect(calls).toEqual(["npm test && true", "npm test && true"]); // once per round — unsafe is not retried within a gate
    const mem = fs.readFileSync(ctx.paths.memory, "utf8");
    expect(mem).toMatch(/demoted by rerun gate/);
    expect(mem).toMatch(/unsafe/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(c) deterministic exit 0 across K runs → pass unchanged (gate ran exactly K times)", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    const exec = scriptedExec([0, 0]);
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      negotiateContract: contractWithVerify,
      decompose: async () => one,
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
      execVerifyCommand: exec.fn,
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    const st = ctx.store.data.build.items["item-001"]!;
    expect(st.status).toBe("passed");
    expect(st.round).toBe(1); // no demotion — accepted on the first pass verdict
    expect(exec.calls).toEqual(["npm test", "npm test"]); // K=2 reruns of the ONE contract command
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("build.flakinessReruns=0 disables the gate (executor never called)", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2, flakinessReruns: 0 });
    const exec = scriptedExec([1, 1]); // would demote if it ran
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      negotiateContract: contractWithVerify,
      decompose: async () => one,
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
      execVerifyCommand: exec.fn,
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed");
    expect(exec.calls).toEqual([]); // gate is OFF — no reruns at all
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a contract with no verify commands leaves the pass untouched (nothing to rerun)", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    const exec = scriptedExec([1]);
    const deps: Partial<BuildDeps> = {
      ...baseDeps(), // baseDeps' contract has NO "I will verify by" section
      decompose: async () => one,
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
      execVerifyCommand: exec.fn,
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed");
    expect(exec.calls).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdBuild — quality escalation routing (Q5)", () => {
  /** Per-SDK-call capture through the REAL generateItem: model/backend/resume as actually sent. */
  type Call = { role: string; model?: string; backend?: string; resume?: string };
  const makeRun =
    (calls: Call[], limitWhen?: (p: RunSessionParams, n: number) => LimitHit | undefined) =>
    async (p: RunSessionParams): Promise<RunResult> => {
      calls.push({ role: p.role, model: p.model, backend: p.backend, resume: p.resume });
      return {
        ok: true, subtype: "success", resultText: "{}", sessionId: `s${calls.length}`,
        costUsd: 0, tokens: 10, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
        limitHit: limitWhen?.(p, calls.length),
      };
    };
  /** BuildDeps.generateItem that runs the real generator with an injected runSessionFn. */
  const realGen = (
    calls: Call[],
    limitWhen?: (p: RunSessionParams, n: number) => LimitHit | undefined
  ): BuildDeps["generateItem"] => {
    const run = makeRun(calls, limitWhen);
    return (args) => generateItem({ ...args, runSessionFn: run });
  };
  const one: WorkItem[] = [{ id: "item-001", title: "only", summary: "", dependsOn: [], rationale: "" }];
  const RATE: LimitHit = { kind: "rate", raw: "429" };

  it("defaults OFF: defaultConfig sets build.escalateAfterRounds to 0", () => {
    expect(defaultConfig().build.escalateAfterRounds).toBe(0);
  });

  it("escalates after N FAILED rounds: rounds 1-2 on the primary, 3+ on the escalation role; memory notes the switch", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 4, escalateAfterRounds: 2 });
    ctx.config.roles.generator = { model: "mid-model", escalation: { model: "strong-model" } };
    const calls: Call[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: realGen(calls),
      evaluateItem: async () => evalOut(false), // fails every round
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(calls.map((c) => c.model)).toEqual(["mid-model", "mid-model", "strong-model", "strong-model"]);
    const mem = fs.readFileSync(ctx.paths.memory, "utf8");
    expect(mem).toMatch(/NOTE: escalated generator to strong-model after 2 failed round/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("contrast: a pass before the threshold means the escalation model is never used", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 4, escalateAfterRounds: 2 });
    ctx.config.roles.generator = { model: "mid-model", escalation: { model: "strong-model" } };
    const calls: Call[] = [];
    let evals = 0;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: realGen(calls),
      evaluateItem: async () => evalOut(++evals >= 2), // fail round 1, pass round 2
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(calls.map((c) => c.model)).toEqual(["mid-model", "mid-model"]); // no strong-model, ever
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed");
    expect(fs.readFileSync(ctx.paths.memory, "utf8")).not.toMatch(/escalated/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("blocked rounds don't count: fail, BLOCKED, fail → escalation fires after the second FAIL (round 4), not round 3", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 4, escalateAfterRounds: 2 });
    ctx.config.roles.generator = { model: "mid-model", escalation: { model: "strong-model" } };
    const calls: Call[] = [];
    let evals = 0;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: realGen(calls),
      evaluateItem: async () =>
        ++evals === 2
          ? evalOut(false, { verdict: { ...makeVerdict(false), exerciseStatus: "blocked" } }) // round 2: inconclusive
          : evalOut(false),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    // Round 3 is still on the primary (the blocked round 2 did NOT advance the counter);
    // round 3's FAIL is the second counted failure, so round 4 escalates.
    expect(calls.map((c) => c.model)).toEqual(["mid-model", "mid-model", "mid-model", "strong-model"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("per-item reset: after item-1 escalates, item-2's first generate is back on the primary", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2, escalateAfterRounds: 1 });
    ctx.config.roles.generator = { model: "mid-model", escalation: { model: "strong-model" } };
    const calls: Call[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => items, // item-001 + item-002
      generateItem: realGen(calls),
      evaluateItem: async (args) => evalOut(args.item.id === "item-002"), // item-001 always fails
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    const byItem = (id: string) => calls.filter((c) => c.role === `generator-${id}`).map((c) => c.model);
    expect(byItem("item-001")).toEqual(["mid-model", "strong-model"]); // escalated
    expect(byItem("item-002")).toEqual(["mid-model"]); // next item starts on the primary
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("no-resume-on-switch: pre-switch rounds resume; the first escalated call starts a NEW session; later escalated rounds resume it", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 4, escalateAfterRounds: 2 });
    ctx.config.roles.generator = { model: "mid-model", escalation: { model: "strong-model" } };
    const calls: Call[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: realGen(calls),
      evaluateItem: async () => evalOut(false),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(calls.map((c) => c.resume)).toEqual([
      undefined, // round 1: first session
      "s1", // round 2: pre-switch patch round resumes as today
      undefined, // round 3: escalation switch → NEW session (no resume)
      "s3", // round 4: the escalated session resumes normally
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("escalateAfterRounds: 0 never switches even with an escalation configured (existing routing/resume unchanged)", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 3, escalateAfterRounds: 0 });
    ctx.config.roles.generator = { model: "mid-model", escalation: { model: "strong-model" } };
    const calls: Call[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: realGen(calls),
      evaluateItem: async () => evalOut(false),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(calls.map((c) => c.model)).toEqual(["mid-model", "mid-model", "mid-model"]);
    expect(calls.map((c) => c.resume)).toEqual([undefined, "s1", "s2"]); // plain resume chain, no reset
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a missing role.escalation never switches even with a threshold set", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 3, escalateAfterRounds: 1 });
    ctx.config.roles.generator = { model: "mid-model" }; // no escalation configured
    const calls: Call[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: realGen(calls),
      evaluateItem: async () => evalOut(false),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(calls.map((c) => c.model)).toEqual(["mid-model", "mid-model", "mid-model"]);
    expect(calls.map((c) => c.resume)).toEqual([undefined, "s1", "s2"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("generatorLocal items escalate via THEIR role's escalation", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2, escalateAfterRounds: 1 });
    ctx.config.roles.generatorLocal = { backend: "codex", model: "local-qwen", escalation: { model: "strong-model" } };
    const local: WorkItem[] = [{ id: "item-001", title: "t", summary: "", dependsOn: [], rationale: "", gen: "local" }];
    const calls: Call[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => local,
      generateItem: realGen(calls),
      evaluateItem: async () => evalOut(false),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(calls.map((c) => c.model)).toEqual(["local-qwen", "strong-model"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("limit interplay: a limitHit on the ESCALATED role still routes through its own fallback chain", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 6, escalateAfterRounds: 1 });
    ctx.config.build.autoRestart = { enabled: true, maxWaitSec: 3600, pollSec: 300, maxRestarts: 20 };
    ctx.config.roles.generator = {
      backend: "codex", model: "mid-model",
      escalation: { backend: "codex", model: "strong-model", fallback: { backend: "claude", model: "opus" } },
    };
    const calls: Call[] = [];
    let evals = 0;
    let waited = 0;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: realGen(calls, (p) => (p.model === "strong-model" ? RATE : undefined)),
      evaluateItem: async () => evalOut(++evals >= 2), // round 1 fails (→ escalate), then passes
      waitForLimit: async () => {
        waited++;
      },
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    // mid fails → escalate to strong; strong hits a limit → the ESCALATED role's fallback (opus).
    expect(calls.map((c) => c.model)).toEqual(["mid-model", "strong-model", "opus"]);
    expect(waited).toBe(0); // fell back, never slept
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("limit interplay: a limit-triggered fallback round does NOT advance the escalation counter", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 4, escalateAfterRounds: 2 });
    ctx.config.build.autoRestart = { enabled: true, maxWaitSec: 3600, pollSec: 300, maxRestarts: 20 };
    ctx.config.roles.generator = {
      backend: "codex", model: "mid-model",
      fallback: { backend: "claude", model: "fb-model" },
      escalation: { model: "strong-model" },
    };
    const calls: Call[] = [];
    let midCalls = 0;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      // The SECOND primary call hits a limit (the first fails normally → counter = 1).
      generateItem: realGen(calls, (p) => (p.model === "mid-model" && ++midCalls === 2 ? RATE : undefined)),
      evaluateItem: async () => evalOut(false), // every evaluated round fails
      waitForLimit: async () => {},
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    // Rounds 2-4 ran on the limit-fallback (fb-model) and their fails did NOT count, so the
    // threshold (2) is never crossed: strong-model never appears.
    expect(calls.map((c) => c.model)).toEqual(["mid-model", "mid-model", "fb-model", "fb-model", "fb-model"]);
    expect(ctx.store.data.build.items["item-001"]!.failedRounds).toBe(1); // only round 1's primary fail counted
    expect(fs.readFileSync(ctx.paths.memory, "utf8")).not.toMatch(/escalated/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdBuild — pivot workspace reset + attempt ledger (Q6)", () => {
  const one: WorkItem[] = [{ id: "item-001", title: "only", summary: "", dependsOn: [], rationale: "" }];
  /** Evaluator that fails craft every round → GAN pivot at N=3 (rounds 3, 6, …). */
  const failCraft = async () => evalOut(false, { verdict: makeVerdict(false, { craft: 10 }) });
  /** Fake ResetDeps whose probes pass but whose reset OPS count (the "no reset invocation" proof). */
  const countingResetDeps = () => {
    const calls = { restore: 0, clean: 0 };
    const deps: ResetDeps = {
      isGitRepo: () => true,
      hasHead: () => true,
      currentBranch: () => "sparra/test",
      restoreTracked: () => { calls.restore++; },
      cleanUntracked: () => { calls.clean++; },
    };
    return { calls, deps };
  };

  it("ordering: the reset completes BEFORE the fresh generateItem (and only for the fresh round); gate inputs are threaded from config/state", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 4 });
    ctx.config.git.autoCommit = true;
    const events: string[] = [];
    const seenArgs: Parameters<typeof maybeResetWorkspace>[0][] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      prepareWorkspace: () => ({ dir, branch: "sparra/test", note: "t" }),
      commitItem: async () => ({ ok: true, commits: 0 }),
      decompose: async () => one,
      maybeResetWorkspace: (args) => {
        events.push("reset");
        seenArgs.push(args);
        return { reset: true };
      },
      generateItem: async (args) => {
        events.push(`gen:${!!args.fresh}`);
        return genOut();
      },
      evaluateItem: failCraft,
    };
    await cmdBuild(ctx, {}, deps);
    // Rounds 1-3 patch (no reset); the pivot's fresh round 4 resets FIRST, then generates fresh.
    expect(events).toEqual(["gen:false", "gen:false", "gen:false", "reset", "gen:true"]);
    expect(seenArgs[0]).toEqual({
      workspaceDir: dir,
      persistedWorkspaceDir: dir,
      recordedBranch: "sparra/test",
      branchPrefix: "sparra/", // ownership gate threaded from ctx.config.git.branchPrefix
      resetWorkspaceEnabled: true,
      autoCommit: true,
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gate (a) + ledger-without-reset: in-place (no branch) pivot records + injects the ledger but NEVER calls a reset op", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 4 });
    ctx.config.git.autoCommit = true; // even with autoCommit on, no branch → refuse
    const { calls, deps: resetDeps } = countingResetDeps();
    const prompts: string[] = [];
    const run = async (p: RunSessionParams): Promise<RunResult> => {
      prompts.push(p.prompt);
      return {
        ok: true, subtype: "success", resultText: `{"report":"approach-${prompts.length}","deviations":[]}`,
        sessionId: `s${prompts.length}`, costUsd: 0, tokens: 10, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
      };
    };
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      maybeResetWorkspace: (args) => maybeResetWorkspace(args, resetDeps), // REAL gates, fake git
      generateItem: (args) => generateItem({ ...args, runSessionFn: run }),
      evaluateItem: failCraft,
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps); // in-place: no Sparra branch
    const st = ctx.store.data.build.items["item-001"]!;
    expect(st.attempts?.length).toBe(1); // pivot at round 3 recorded
    expect(st.attempts![0]!.approach).toContain("approach-3");
    expect(prompts[3]).toContain("PRIOR ATTEMPTS"); // round 4 (fresh) injects the ledger…
    expect(prompts[3]).toContain("approach-3");
    expect(calls).toEqual({ restore: 0, clean: 0 }); // …while the reset ops never ran
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gate (b): autoCommit off → pivot happens with NO reset op", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 4 });
    ctx.config.git.autoCommit = false;
    const { calls, deps: resetDeps } = countingResetDeps();
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      prepareWorkspace: () => ({ dir, branch: "sparra/test", note: "t" }),
      decompose: async () => one,
      maybeResetWorkspace: (args) => maybeResetWorkspace(args, resetDeps),
      generateItem: async () => genOut(),
      evaluateItem: failCraft,
    };
    await cmdBuild(ctx, {}, deps);
    expect(ctx.store.data.build.items["item-001"]!.pivots).toBe(1); // the pivot DID fire
    expect(calls).toEqual({ restore: 0, clean: 0 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gate (c): pivot.resetWorkspace: false → pivot happens with NO reset op", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 4 });
    ctx.config.git.autoCommit = true;
    ctx.config.pivot.resetWorkspace = false;
    const { calls, deps: resetDeps } = countingResetDeps();
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      prepareWorkspace: () => ({ dir, branch: "sparra/test", note: "t" }),
      commitItem: async () => ({ ok: true, commits: 0 }),
      decompose: async () => one,
      maybeResetWorkspace: (args) => maybeResetWorkspace(args, resetDeps),
      generateItem: async () => genOut(),
      evaluateItem: failCraft,
    };
    await cmdBuild(ctx, {}, deps);
    expect(ctx.store.data.build.items["item-001"]!.pivots).toBe(1);
    expect(calls).toEqual({ restore: 0, clean: 0 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gate (d): ordinary failed rounds (no pivot) never invoke the reset path at all", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 3 });
    ctx.config.git.autoCommit = true;
    let invoked = 0;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      prepareWorkspace: () => ({ dir, branch: "sparra/test", note: "t" }),
      decompose: async () => one,
      maybeResetWorkspace: () => {
        invoked++;
        return { reset: true };
      },
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(false), // fails, but all criteria ≥ threshold → never pivots
    };
    await cmdBuild(ctx, {}, deps);
    expect(ctx.store.data.build.items["item-001"]!.pivots).toBe(0);
    expect(invoked).toBe(0); // no pivot → the reset seam is never even consulted
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("4b: a throwing reset dep halts the round — the error surfaces + is recorded, and generateItem(fresh) is NOT called", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 6 });
    ctx.config.git.autoCommit = true;
    const freshFlags: boolean[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      prepareWorkspace: () => ({ dir, branch: "sparra/test", note: "t" }),
      decompose: async () => one,
      maybeResetWorkspace: () => {
        throw new Error("git clean -fd failed in /ws: disk error");
      },
      generateItem: async (args) => {
        freshFlags.push(!!args.fresh);
        return genOut();
      },
      evaluateItem: failCraft,
    };
    await expect(cmdBuild(ctx, {}, deps)).rejects.toThrow(/reset failed.*dirty tree/);
    expect(freshFlags).toEqual([false, false, false]); // rounds 1-3 only; the fresh generate never ran
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("failed");
    expect(fs.readFileSync(ctx.paths.memory, "utf8")).toMatch(/pivot workspace reset FAILED/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ledger recording: two consecutive pivots → two entries with round, approach (from the report) and failure (from blocking), caps enforced", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 7 });
    let n = 0;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: async () => genOut({ report: `approach-${++n} ${"A".repeat(600)}` }), // oversized
      evaluateItem: async () =>
        evalOut(false, { verdict: { ...makeVerdict(false, { craft: 10 }), blocking: ["B".repeat(600)] } }),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    const st = ctx.store.data.build.items["item-001"]!;
    expect(st.attempts?.length).toBe(2); // pivots at rounds 3 and 6
    expect(st.attempts!.map((a) => a.round)).toEqual([3, 6]);
    expect(st.attempts![0]!.approach).toContain("approach-3");
    expect(st.attempts![1]!.approach).toContain("approach-6");
    for (const a of st.attempts!) {
      expect(a.approach.length).toBe(APPROACH_CAP + TRUNCATION_MARKER.length); // truncated + marked
      expect(a.approach.endsWith(TRUNCATION_MARKER)).toBe(true);
      expect(a.failure.length).toBe(FAILURE_CAP + TRUNCATION_MARKER.length);
      expect(a.failure.endsWith(TRUNCATION_MARKER)).toBe(true);
      expect(a.failure).toContain("BBB"); // from the verdict's blocking items
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ledger injection: the fresh prompts carry PRIOR ATTEMPTS (2nd fresh carries BOTH entries); patch-round prompts don't (runSessionFn proof)", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 7 });
    const prompts: string[] = [];
    const run = async (p: RunSessionParams): Promise<RunResult> => {
      prompts.push(p.prompt);
      return {
        ok: true, subtype: "success", resultText: `{"report":"approach-${prompts.length}","deviations":[]}`,
        sessionId: `s${prompts.length}`, costUsd: 0, tokens: 10, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
      };
    };
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: (args) => generateItem({ ...args, runSessionFn: run }),
      evaluateItem: failCraft,
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(prompts.length).toBe(7);
    expect(prompts[1]).not.toContain("PRIOR ATTEMPTS"); // round 2: ordinary patch round
    expect(prompts[3]).toContain("PRIOR ATTEMPTS"); // round 4: fresh after pivot 1
    expect(prompts[3]).toContain("approach-3");
    expect(prompts[6]).toContain("PRIOR ATTEMPTS"); // round 7: fresh after pivot 2 — BOTH entries
    expect(prompts[6]).toContain("approach-3");
    expect(prompts[6]).toContain("approach-6");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("durability: the ledger survives a state save/load round-trip; `cmdBuild --fresh` clears it with the per-item state", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    // Seed a prior run whose item carries a ledger.
    ctx.store.data.build.runId = "build-old";
    ctx.store.data.build.items["item-001"] = {
      status: "failed", round: 4, pivots: 1, criterionFailStreak: {},
      attempts: [{ round: 3, approach: "old approach", failure: "old failure" }],
    };
    await ctx.store.save();
    const reloaded = await StateStore.load(ctx.paths);
    expect(reloaded!.data.build.items["item-001"]!.attempts).toEqual([
      { round: 3, approach: "old approach", failure: "old failure" },
    ]); // durable across save/load
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, { fresh: true, workspaceOverride: dir }, deps);
    const st = ctx.store.data.build.items["item-001"]!;
    expect(st.status).toBe("passed");
    expect(st.attempts).toBeUndefined(); // --fresh cleared the ledger with the item state
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ───────────────────────────── post-accept MEASURE step (non-blocking, config-gated) ─────────────────────────────

describe("cmdBuild — post-accept measure step", () => {
  const one: WorkItem[] = [{ id: "item-001", title: "only", summary: "", dependsOn: [], rationale: "" }];
  const okMeasure = (regressions = 0) => ({
    ran: true as const,
    ok: true as const,
    metrics: { p50_ms: { value: 12.3, goal: "min" as const } },
    deltas: [],
    regressions: Array.from({ length: regressions }, (_, i) => ({
      name: `m${i}`,
      current: 2,
      baseline: 1,
      goal: "min" as const,
      isNew: false,
      regressed: true,
      pct: 1,
    })),
    baselineUpdated: true,
  });

  it("(a) runs the measure hook between reconcile and commit when enabled", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    ctx.config.measure = { ...ctx.config.measure, enabled: true, command: "npm run qa:metrics" };
    ctx.config.git.autoCommit = true;
    const order: string[] = [];
    let measuredWith: string | undefined;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      prepareWorkspace: () => ({ dir, branch: "sparra/test", note: "t" }),
      reconcilePlan: async () => {
        order.push("reconcile");
      },
      measureAccepted: async (_ctx, workspaceDir) => {
        order.push("measure");
        measuredWith = workspaceDir;
        return okMeasure();
      },
      commitItem: async () => {
        order.push("commit");
        return { ok: true, commits: 1 };
      },
      decompose: async () => one,
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, {}, deps); // prepareWorkspace → branch set, so autoCommit commits
    expect(order).toEqual(["reconcile", "measure", "commit"]);
    expect(measuredWith).toBe(dir); // cwd = the workspace holding the accepted artifact
    expect(ctx.store.data.build.items["item-001"]!.acceptance!.measured).toBe(true);
    // a measure learning line landed in memory
    expect(fs.readFileSync(ctx.paths.memory, "utf8")).toMatch(/MEASURE:/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(b) skips the measure hook when disabled (default)", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    let called = false;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      measureAccepted: async () => {
        called = true;
        return okMeasure();
      },
      decompose: async () => one,
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(called).toBe(false);
    expect(ctx.store.data.build.items["item-001"]!.acceptance!.measured).toBeUndefined();
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(c) is idempotent via acc.measured — a resumed acceptance does not re-measure", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    ctx.config.measure = { ...ctx.config.measure, enabled: true, command: "npm run qa:metrics" };
    // Seed a passed item whose acceptance already measured + reconciled, but memory not appended.
    ctx.store.data.build.runId = "build-x";
    ctx.store.data.build.workspaceDir = dir;
    ctx.store.data.build.items["item-001"] = {
      status: "passed",
      round: 1,
      pivots: 0,
      criterionFailStreak: {},
      acceptance: { reconciled: true, measured: true, committed: true, memoryAppended: false },
    };
    await ctx.store.save();
    let measureCalls = 0;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      measureAccepted: async () => {
        measureCalls++;
        return okMeasure();
      },
      decompose: async () => one,
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, {}, deps);
    expect(measureCalls).toBe(0); // acc.measured already set → never re-run
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(d) still commits (non-blocking) when a regression is reported", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    ctx.config.measure = { ...ctx.config.measure, enabled: true, command: "npm run qa:metrics" };
    ctx.config.git.autoCommit = true;
    let committed = false;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      prepareWorkspace: () => ({ dir, branch: "sparra/test", note: "t" }),
      measureAccepted: async () => okMeasure(3), // 3 regressions
      commitItem: async () => {
        committed = true;
        return { ok: true, commits: 1 };
      },
      decompose: async () => one,
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, {}, deps);
    expect(committed).toBe(true); // a regression NEVER blocks the commit
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed"); // stays passed
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(e) a measure hook that THROWS is non-fatal — item stays passed and the commit proceeds", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    ctx.config.measure = { ...ctx.config.measure, enabled: true, command: "npm run qa:metrics" };
    ctx.config.git.autoCommit = true;
    let committed = false;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      prepareWorkspace: () => ({ dir, branch: "sparra/test", note: "t" }),
      measureAccepted: async () => {
        throw new Error("measure blew up");
      },
      commitItem: async () => {
        committed = true;
        return { ok: true, commits: 1 };
      },
      decompose: async () => one,
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, {}, deps);
    expect(committed).toBe(true);
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed");
    expect(ctx.store.data.build.items["item-001"]!.acceptance!.measured).toBe(true); // flag still flips
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ───────────────────────────── Q7a: decompose — prompt via loadPrompt + build.maxItems clamp ─────────────────────────────

describe("decompose — DEFAULT_PROMPTS prompt + build.maxItems clamp (Q7a)", () => {
  const itemsJson = (n: number) =>
    "```json\n" +
    JSON.stringify(
      Array.from({ length: n }, (_, i) => ({
        id: `item-${String(i + 1).padStart(3, "0")}`,
        title: `t${i + 1}`,
        summary: "",
        dependsOn: [],
        rationale: "",
      }))
    ) +
    "\n```";

  function decomposeRun(n: number) {
    const calls: RunSessionParams[] = [];
    const fn = async (p: RunSessionParams): Promise<RunResult> => {
      calls.push(p);
      return {
        ok: true, subtype: "success", resultText: itemsJson(n), sessionId: "d",
        costUsd: 0, tokens: 0, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
      };
    };
    return { calls, fn };
  }

  function captureStdout(): { lines: () => string; restore: () => void } {
    // The logger is silenced under vitest; lift the gate via the documented escape hatch while capturing.
    const priorLogInTests = process.env.SPARRA_LOG_IN_TESTS;
    process.env.SPARRA_LOG_IN_TESTS = "1";
    let buf = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    });
    return {
      lines: () => buf,
      restore: () => {
        spy.mockRestore();
        if (priorLogInTests === undefined) delete process.env.SPARRA_LOG_IN_TESTS;
        else process.env.SPARRA_LOG_IN_TESTS = priorLogInTests;
      },
    };
  }

  it("clamps a 20-item decomposition to build.maxItems (default 12), keeps the head, and warns", async () => {
    const { ctx, dir } = await makeCtx();
    expect(ctx.config.build.maxItems).toBe(12); // the default lives in defaultConfig
    const rec = decomposeRun(20);
    const out = captureStdout();
    const result = await decompose(ctx, path.join(dir, "trace"), true, dir, rec.fn);
    out.restore();
    expect(result).toHaveLength(12);
    expect(result[0]!.id).toBe("item-001"); // order preserved — the head is kept
    expect(result[11]!.id).toBe("item-012");
    expect(out.lines()).toContain("clamping to build.maxItems (12)");
    // The persisted items.json is clamped too.
    expect(JSON.parse(fs.readFileSync(ctx.paths.workitemsFile, "utf8"))).toHaveLength(12);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("contrast: a count ≤ the cap passes through unclamped with no warning", async () => {
    const { ctx, dir } = await makeCtx();
    const rec = decomposeRun(5);
    const out = captureStdout();
    const result = await decompose(ctx, path.join(dir, "trace"), true, dir, rec.fn);
    out.restore();
    expect(result).toHaveLength(5);
    expect(out.lines()).not.toContain("clamping");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("loads the system prompt via loadPrompt — the default text absent a file, an edited prompts/decomposer.md when present", async () => {
    const { ctx, dir } = await makeCtx();
    const rec = decomposeRun(2);
    await decompose(ctx, path.join(dir, "trace"), true, dir, rec.fn);
    expect(rec.calls[0]!.systemPrompt).toBe(DEFAULT_PROMPTS.decomposer);
    // An on-disk edit wins — proves there is no hard-coded const left in decompose.ts.
    fs.writeFileSync(ctx.paths.promptFile("decomposer"), "CUSTOM DECOMPOSER PROMPT\n");
    const rec2 = decomposeRun(2);
    await decompose(ctx, path.join(dir, "trace"), true, dir, rec2.fn);
    expect(rec2.calls[0]!.systemPrompt).toBe("CUSTOM DECOMPOSER PROMPT\n");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Decomposer emitting an arbitrary item shape (to exercise relevantPaths normalization, U5). */
  function decomposeItems(rawItems: unknown[]) {
    const calls: RunSessionParams[] = [];
    const fn = async (p: RunSessionParams): Promise<RunResult> => {
      calls.push(p);
      return {
        ok: true, subtype: "success", resultText: "```json\n" + JSON.stringify(rawItems) + "\n```", sessionId: "d",
        costUsd: 0, tokens: 0, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
      };
    };
    return { calls, fn };
  }

  it("documents relevantPaths as an OPTIONAL field in the decomposer prompt", async () => {
    const { ctx, dir } = await makeCtx();
    const rec = decomposeItems([{ id: "item-001", title: "t", summary: "", dependsOn: [], rationale: "" }]);
    await decompose(ctx, path.join(dir, "trace"), true, dir, rec.fn);
    expect(rec.calls[0]!.prompt).toContain("relevantPaths (OPTIONAL");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("preserves a valid non-empty relevantPaths array on the normalized item (mirrors gen)", async () => {
    const { ctx, dir } = await makeCtx();
    const rec = decomposeItems([
      { id: "item-001", title: "t", summary: "", dependsOn: [], rationale: "", relevantPaths: ["src/a.ts", "src/b.ts"] },
    ]);
    const result = await decompose(ctx, path.join(dir, "trace"), true, dir, rec.fn);
    expect(result[0]!.relevantPaths).toEqual(["src/a.ts", "src/b.ts"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("omits relevantPaths when absent, empty, or non-array (never invents it)", async () => {
    const { ctx, dir } = await makeCtx();
    const rec = decomposeItems([
      { id: "item-001", title: "absent", summary: "", dependsOn: [], rationale: "" },
      { id: "item-002", title: "empty", summary: "", dependsOn: [], rationale: "", relevantPaths: [] },
      { id: "item-003", title: "nonarray", summary: "", dependsOn: [], rationale: "", relevantPaths: "src/a.ts" },
      { id: "item-004", title: "nonstring", summary: "", dependsOn: [], rationale: "", relevantPaths: [1, 2] },
    ]);
    const result = await decompose(ctx, path.join(dir, "trace"), true, dir, rec.fn);
    for (const it of result) expect(it).not.toHaveProperty("relevantPaths");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ───────────────────────────── Q7c: assertionsClaimed → calibration gap ─────────────────────────────

describe("diffClaims — pure claims-vs-verdict diff (Q7c)", () => {
  const asserts = [
    { id: 1, pass: true, evidence: "ok" },
    { id: 2, pass: false, evidence: "broken" },
  ];

  it("claims {1: pass, 2: pass} vs verdict 1 pass / 2 fail → count 1, naming id 2", () => {
    expect(diffClaims([{ id: 1, claim: "pass" }, { id: 2, claim: "pass" }], asserts)).toEqual({ count: 1, ids: [2] });
  });

  it("omitted or empty claims → complete no-op", () => {
    expect(diffClaims(undefined, asserts)).toEqual({ count: 0, ids: [] });
    expect(diffClaims([], asserts)).toEqual({ count: 0, ids: [] });
  });

  it("agreeing claims, unknown ids, and junk claim values never count; a wrong fail-claim does", () => {
    expect(diffClaims([{ id: 1, claim: "pass" }, { id: 2, claim: "fail" }], asserts)).toEqual({ count: 0, ids: [] });
    expect(diffClaims([{ id: 9, claim: "pass" }, { id: 2, claim: "dunno" }], asserts)).toEqual({ count: 0, ids: [] });
    expect(diffClaims([{ id: 1, claim: "fail" }], asserts)).toEqual({ count: 1, ids: [1] });
  });
});

describe("cmdBuild — assertionsClaimed calibration gap surfaced (Q7c)", () => {
  const mixedVerdict = (): Verdict => {
    const v = makeVerdict(true);
    v.assertions = [
      { id: 1, pass: true, evidence: "ok" },
      { id: 2, pass: false, evidence: "broken" },
    ];
    return v;
  };

  it("a claims-vs-verdict mismatch lands in the round's verdict artifact AND a memory note on completion", async () => {
    const { ctx, dir } = await makeCtx({ maxRoundsPerItem: 2 });
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [items[0]!],
      generateItem: async () =>
        genOut({ assertionsClaimed: [{ id: 1, claim: "pass", how: "ran" }, { id: 2, claim: "pass", how: "ran" }] }),
      evaluateItem: async () => ({ verdict: mixedVerdict(), raw: "", sessionId: "e", costUsd: 0.001, tokens: 100 }),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed");
    // Run-scoped: the gap append lands under verdicts/<runId>/ (collision-free across build runs).
    const vf = fs.readFileSync(ctx.paths.verdictFile("item-001", 1, ctx.store.data.build.runId), "utf8");
    expect(vf).toContain("Calibration gap");
    expect(vf).toContain("1 claimed assertion(s) contradicted by the evaluator: ids 2");
    const mem = fs.readFileSync(ctx.paths.memory, "utf8");
    expect(mem).toContain("calibration gap");
    expect(mem).toContain("ids 2");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("zero mismatches → no verdict gap entry and no memory note", async () => {
    const { ctx, dir } = await makeCtx({ maxRoundsPerItem: 2 });
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [items[0]!],
      generateItem: async () =>
        genOut({ assertionsClaimed: [{ id: 1, claim: "pass" }, { id: 2, claim: "fail" }] }), // matches the verdict
      evaluateItem: async () => ({ verdict: mixedVerdict(), raw: "", sessionId: "e", costUsd: 0.001, tokens: 100 }),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    // The faked evaluateItem never writes a verdict file, so only a gap-append could create it.
    expect(fs.existsSync(ctx.paths.verdictFile("item-001", 1, ctx.store.data.build.runId))).toBe(false);
    const mem = fs.existsSync(ctx.paths.memory) ? fs.readFileSync(ctx.paths.memory, "utf8") : "";
    expect(mem).not.toContain("calibration gap");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("generator omitted the field entirely → no-op: no crash, no gap entry, no note", async () => {
    const { ctx, dir } = await makeCtx({ maxRoundsPerItem: 2 });
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [items[0]!],
      generateItem: async () => genOut(), // no assertionsClaimed at all
      evaluateItem: async () => ({ verdict: mixedVerdict(), raw: "", sessionId: "e", costUsd: 0.001, tokens: 100 }),
    };
    const res = await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(res.passed).toBe(1);
    expect(fs.existsSync(ctx.paths.verdictFile("item-001", 1, ctx.store.data.build.runId))).toBe(false);
    const mem = fs.existsSync(ctx.paths.memory) ? fs.readFileSync(ctx.paths.memory, "utf8") : "";
    expect(mem).not.toContain("calibration gap");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdBuild — pre-evaluator preflight gate (build.preflightVerify)", () => {
  // A contract whose "I will verify by" section yields exactly one runnable command.
  const CONTRACT = "# Contract\n\n## I will verify by\n- `npm test`\n";
  const contractDeps = (): Partial<BuildDeps> => ({
    ...baseDeps(),
    negotiateContract: async () => ({ text: CONTRACT, agreed: true, tracesUsed: 0 }),
    decompose: async () => [items[0]!],
  });
  // Outcome factories for the injected executor spy.
  const behavioral = (command: string): ExecOutcome => ({ ran: true, command, exitCode: 1, stdout: "", stderr: "1 failing test", timedOut: false });
  const okOutcome = (command: string): ExecOutcome => ({ ran: true, command, exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
  const usage = (command: string): ExecOutcome => ({ ran: true, command, exitCode: 127, stdout: "", stderr: "npm: command not found", timedOut: false });
  const unsafe = (command: string): ExecOutcome => ({ ran: false, command, unsafeReason: "argv[0] is not a known build/test runner" });
  const execSpy = (calls: string[], out: (c: string) => ExecOutcome): CommandExecutor =>
    async (_ws, command) => { calls.push(command); return out(command); };

  it("disabled by default: ZERO preflight executor calls, evaluateItem runs normally (mutation: forcing the branch on breaks this)", async () => {
    const { ctx, dir } = await makeCtx({ maxRoundsPerItem: 2, flakinessReruns: 0 }); // preflightVerify defaults false
    const execCalls: string[] = [];
    let evalCalls = 0;
    const deps: Partial<BuildDeps> = {
      ...contractDeps(),
      execVerifyCommand: execSpy(execCalls, behavioral),
      generateItem: async () => genOut(),
      evaluateItem: async () => { evalCalls++; return evalOut(true); },
    };
    const res = await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(execCalls).toEqual([]); // no preflight (and rerun gate off) → zero executor calls
    expect(evalCalls).toBe(1);
    expect(res.passed).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("enabled + behavioral fail: SKIPS evaluateItem this round and bounces with the exec output as the NEXT round's feedback", async () => {
    const { ctx, dir } = await makeCtx({ maxRoundsPerItem: 2, flakinessReruns: 0, preflightVerify: true });
    const execCalls: string[] = [];
    let evalCalls = 0;
    const genFeedback: (string | undefined)[] = [];
    const evalCountAtGen: number[] = [];
    const deps: Partial<BuildDeps> = {
      ...contractDeps(),
      execVerifyCommand: execSpy(execCalls, behavioral),
      generateItem: async (args) => { genFeedback.push(args.feedback); evalCountAtGen.push(evalCalls); return genOut(); },
      evaluateItem: async () => { evalCalls++; return evalOut(true); },
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    // Round 1 bounced: the evaluator had NOT run by the time round 2 generated.
    expect(evalCountAtGen).toEqual([0, 0]);
    expect(execCalls).toContain("npm test");
    // Round 2's generator feedback carries the failing command's rendered output.
    expect(genFeedback[1]).toContain("npm test");
    expect(genFeedback[1]).toContain("exit 1");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("enabled + all-ok: proceeds to evaluateItem (no bounce)", async () => {
    const { ctx, dir } = await makeCtx({ maxRoundsPerItem: 2, flakinessReruns: 0, preflightVerify: true });
    const execCalls: string[] = [];
    let evalCalls = 0;
    const deps: Partial<BuildDeps> = {
      ...contractDeps(),
      execVerifyCommand: execSpy(execCalls, okOutcome),
      generateItem: async () => genOut(),
      evaluateItem: async () => { evalCalls++; return evalOut(true); },
    };
    const res = await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(execCalls).toEqual(["npm test"]); // preflight ran once
    expect(evalCalls).toBe(1); // then evaluated (no bounce)
    expect(res.passed).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("enabled + usage outcome does NOT bounce (broken command is not a gate fail) → evaluateItem still runs", async () => {
    const { ctx, dir } = await makeCtx({ maxRoundsPerItem: 2, flakinessReruns: 0, preflightVerify: true });
    let evalCalls = 0;
    const deps: Partial<BuildDeps> = {
      ...contractDeps(),
      execVerifyCommand: execSpy([], usage),
      generateItem: async () => genOut(),
      evaluateItem: async () => { evalCalls++; return evalOut(true); },
    };
    const res = await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(evalCalls).toBe(1);
    expect(res.passed).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("enabled + unsafe/never-ran outcome does NOT bounce → evaluateItem still runs", async () => {
    const { ctx, dir } = await makeCtx({ maxRoundsPerItem: 2, flakinessReruns: 0, preflightVerify: true });
    let evalCalls = 0;
    const deps: Partial<BuildDeps> = {
      ...contractDeps(),
      execVerifyCommand: execSpy([], unsafe),
      generateItem: async () => genOut(),
      evaluateItem: async () => { evalCalls++; return evalOut(true); },
    };
    const res = await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(evalCalls).toBe(1);
    expect(res.passed).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("cap: an ALWAYS-failing preflight bounces ONCE then the next generation proceeds to evaluateItem (mutation: no cap → bounces forever, eval never runs)", async () => {
    const { ctx, dir } = await makeCtx({ maxRoundsPerItem: 2, flakinessReruns: 0, preflightVerify: true });
    let evalCalls = 0;
    let genCalls = 0;
    const deps: Partial<BuildDeps> = {
      ...contractDeps(),
      execVerifyCommand: execSpy([], behavioral), // ALWAYS behavioral-fails
      generateItem: async () => { genCalls++; return genOut(); },
      evaluateItem: async () => { evalCalls++; return evalOut(false); },
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(genCalls).toBe(2); // both rounds generated
    expect(evalCalls).toBe(1); // round 1 bounced, round 2 forced to the evaluator by the cap
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("cap is durable across resume: seeded with a recorded bounce, a resumed still-failing preflight proceeds to evaluateItem (no re-bounce)", async () => {
    const { ctx, dir } = await makeCtx({ maxRoundsPerItem: 3, flakinessReruns: 0, preflightVerify: true });
    // Seed the post-bounce durable state a prior process would have persisted. A preset runId
    // marks this as a RESUME (not a fresh run), so the seeded item state is not wiped.
    ctx.store.data.build.runId = "build-resume";
    ctx.store.data.build.items["item-001"] = {
      status: "building", round: 1, pivots: 0, criterionFailStreak: {}, costUsd: 0, tokensUsed: 0, preflightBounces: 1,
    };
    let evalCalls = 0;
    let genCalls = 0;
    const deps: Partial<BuildDeps> = {
      ...contractDeps(),
      execVerifyCommand: execSpy([], behavioral), // preflight still failing
      generateItem: async () => { genCalls++; return genOut(); },
      evaluateItem: async () => { evalCalls++; return evalOut(true); },
    };
    const res = await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(genCalls).toBe(1); // the resumed generation
    expect(evalCalls).toBe(1); // went straight to the evaluator (did NOT bounce again)
    expect(res.passed).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("holdout redaction: the bounced feedback is passed through redactHoldout (holdout text absent, redaction marker present)", async () => {
    const { ctx, dir } = await makeCtx({ maxRoundsPerItem: 2, flakinessReruns: 0, preflightVerify: true });
    const HOLDOUT_LINE = "The secret acceptance probe expects sentinel-XYZ output";
    fs.writeFileSync(ctx.paths.holdout, `# Holdout\n- ${HOLDOUT_LINE}\n`);
    const leaky = (command: string): ExecOutcome => ({ ran: true, command, exitCode: 1, stdout: "", stderr: `assertion failed: ${HOLDOUT_LINE}`, timedOut: false });
    const genFeedback: (string | undefined)[] = [];
    const deps: Partial<BuildDeps> = {
      ...contractDeps(),
      execVerifyCommand: execSpy([], leaky),
      generateItem: async (args) => { genFeedback.push(args.feedback); return genOut(); },
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(genFeedback[1]).toBeTruthy();
    expect(genFeedback[1]).not.toContain(HOLDOUT_LINE);
    expect(genFeedback[1]).toContain("[redacted: holdout]");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("framing: the bounced feedback names a PREFLIGHT failure, not an evaluator verdict", async () => {
    const { ctx, dir } = await makeCtx({ maxRoundsPerItem: 2, flakinessReruns: 0, preflightVerify: true });
    const genFeedback: (string | undefined)[] = [];
    const deps: Partial<BuildDeps> = {
      ...contractDeps(),
      execVerifyCommand: execSpy([], behavioral),
      generateItem: async (args) => { genFeedback.push(args.feedback); return genOut(); },
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(genFeedback[1]).toMatch(/PREFLIGHT/);
    expect(genFeedback[1]).toMatch(/your OWN verify commands failed/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdBuild — terminal technique distillation (build.distillTechnique)", () => {
  const one: WorkItem[] = [{ id: "item-001", title: "only", summary: "", dependsOn: [], rationale: "" }];
  const TECH_REPORT = "Fixed the flaky UI read by adding @MainActor to the assertion so it runs on the main actor.";
  // Count the distilled-technique NOTE lines in memory.md (marker-keyed, so unrelated notes don't count).
  const countTechniqueNotes = (mem: string): number =>
    mem.split("\n").filter((l) => l.includes("· NOTE:") && l.includes(TECHNIQUE_MARKER)).length;

  // Assertion 6 — OFF (default): the terminal memory equals baseline; NO technique note appears.
  it("off (default): no technique note is appended, memory carries only the usual passed line", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    expect(ctx.config.build.distillTechnique).toBe(false); // default
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: async () => genOut({ report: TECH_REPORT }),
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    const mem = fs.readFileSync(ctx.paths.memory, "utf8");
    expect(mem).toMatch(/PASSED:/); // the usual accepted line is still there
    expect(mem).not.toContain(TECHNIQUE_MARKER); // …and NO technique note
    expect(countTechniqueNotes(mem)).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Assertion 7 (passed path) — ON: exactly ONE marked technique note, preserving the technique.
  it("on: a PASSED item appends exactly one marked technique note that preserves the technique", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2, distillTechnique: true });
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: async () => genOut({ report: TECH_REPORT }),
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    const mem = fs.readFileSync(ctx.paths.memory, "utf8");
    expect(countTechniqueNotes(mem)).toBe(1);
    expect(mem).toContain("@MainActor"); // the distinctive technique survived
    expect(mem).not.toMatch(/NOTE: technique:[^\n]*\bscore\b/i); // never the score
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Assertion 7 (failed path) — ON: a FAILED item also appends exactly ONE marked technique note.
  it("on: a FAILED item appends exactly one marked technique note", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2, distillTechnique: true });
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: async () => genOut({ report: TECH_REPORT }),
      evaluateItem: async () => evalOut(false), // never passes → terminal FAILED
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    const st = ctx.store.data.build.items["item-001"]!;
    expect(st.status).toBe("failed");
    const mem = fs.readFileSync(ctx.paths.memory, "utf8");
    expect(mem).toMatch(/FAILED:/); // the usual failed line is still there
    expect(countTechniqueNotes(mem)).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Assertion 7 (resume) — a resumed PASSED terminal with the technique note already present
  // does not double-append (the marker dedup, not `hasLearning(item,"note")`).
  it("on: a resumed passed acceptance does not double-append the technique note", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2, distillTechnique: true });
    ctx.store.data.build.runId = "build-resume";
    ctx.store.data.build.workspaceDir = dir;
    // Seed a passed item whose acceptance is mid-finish (memory step not yet done)…
    ctx.store.data.build.items["item-001"] = {
      status: "passed",
      round: 1,
      pivots: 0,
      criterionFailStreak: {},
      lastReport: TECH_REPORT,
      acceptance: { reconciled: true, committed: true, memoryAppended: false },
    };
    // …and pre-seed BOTH the passed line and the technique note (as a prior, crashed attempt would have).
    fs.writeFileSync(
      ctx.paths.memory,
      `# Sparra memory\n\n- [2026-06-24] item-001 · PASSED: accepted in round 1.\n- [2026-06-24] item-001 · NOTE: ${TECHNIQUE_MARKER} add @MainActor to the assertion.\n`
    );
    await ctx.store.save();
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: async () => genOut({ report: TECH_REPORT }),
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, {}, deps);
    const mem = fs.readFileSync(ctx.paths.memory, "utf8");
    expect(countTechniqueNotes(mem)).toBe(1); // still exactly one — the resume did not re-append
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Assertion 8 — dedup keys on the MARKER, not the kind: an unrelated pre-existing NOTE for the
  // same item neither suppresses the technique note nor lets it duplicate on a re-run.
  it("on: an unrelated pre-existing note does not suppress the technique note (marker-keyed dedup)", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2, distillTechnique: true });
    // An unrelated NOTE for the SAME item already in memory (would fool a hasLearning(item,"note") guard).
    fs.writeFileSync(
      ctx.paths.memory,
      "# Sparra memory\n\n- [2026-06-24] item-001 · NOTE: some unrelated calibration note.\n"
    );
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: async () => genOut({ report: TECH_REPORT }),
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    const mem = fs.readFileSync(ctx.paths.memory, "utf8");
    expect(mem).toContain("some unrelated calibration note"); // the unrelated note is preserved
    expect(countTechniqueNotes(mem)).toBe(1); // and the technique note WAS appended (not suppressed)
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Assertion 9 — the appended technique note is holdout-redacted (holdout text absent).
  it("on: the technique note is passed through redactHoldout (holdout text absent)", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2, distillTechnique: true });
    const HOLDOUT_LINE = "The sentinel token ABC appears in the output stream";
    fs.writeFileSync(ctx.paths.holdout, `# Holdout\n- ${HOLDOUT_LINE}\n`);
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      // The generator's own report happens to echo the holdout wording.
      generateItem: async () => genOut({ report: `${HOLDOUT_LINE} after wiring the check.` }),
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    const mem = fs.readFileSync(ctx.paths.memory, "utf8");
    expect(countTechniqueNotes(mem)).toBe(1);
    expect(mem).not.toContain(HOLDOUT_LINE); // holdout text scrubbed…
    expect(mem).toContain("[redacted: holdout]"); // …via redactHoldout
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdBuild — second-opinion gate (opt-in)", () => {
  const one: WorkItem[] = [{ id: "item-001", title: "first", summary: "", dependsOn: [], rationale: "" }];
  // A second-opinion EvalOutput with an overridable verdict (defaults to a fail).
  const secondEval = (over: Partial<Verdict> = {}, evalOver: Partial<EvalOutput> = {}): EvalOutput => ({
    verdict: { ...makeVerdict(false), ...over },
    raw: "",
    sessionId: "e2",
    costUsd: 0.001,
    tokens: 100,
    ...evalOver,
  });
  // Distinguish the primary evaluator (default opus/claude) from the injected second (codex/gpt-5.5).
  const isSecond = (role?: { backend?: string; model?: string }) => role?.model === "gpt-5.5";

  it("(A2) on a PASS, invokes a SECOND evaluateItem with evaluatorSecond against the same inputs", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 3 });
    ctx.config.evaluator.secondOpinion.enabled = true;
    ctx.config.roles.evaluatorSecond = { backend: "codex", model: "gpt-5.5" };
    const calls: Array<{ role: unknown; item: string; contractText: string; workspaceDir: string; round: number }> = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: async () => genOut(),
      evaluateItem: async (args) => {
        calls.push({ role: args.role, item: args.item.id, contractText: args.contractText, workspaceDir: args.workspaceDir, round: args.round });
        return isSecond(args.role) ? secondEval({ verdict: "pass", blocking: [] }) : evalOut(true);
      },
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);

    const primary = calls.find((c) => !isSecond(c.role as { model?: string }))!;
    const second = calls.find((c) => isSecond(c.role as { model?: string }))!;
    expect(second).toBeTruthy();
    expect(second.role).toEqual({ backend: "codex", model: "gpt-5.5" }); // full RoleConfig threaded through
    // Same item / contract / workspace / round as the primary grade.
    expect(second.item).toBe(primary.item);
    expect(second.contractText).toBe(primary.contractText);
    expect(second.workspaceDir).toBe(primary.workspaceDir);
    expect(second.round).toBe(primary.round);
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed"); // agreeing pass → accepted
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(A3a) NO-OPs with a warning when evaluatorSecond is unset", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    ctx.config.evaluator.secondOpinion.enabled = true; // enabled but no roles.evaluatorSecond
    let evalCount = 0;
    const cap = captureStdout();
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: async () => genOut(),
      evaluateItem: async () => { evalCount++; return evalOut(true); },
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    cap.restore();
    expect(evalCount).toBe(1); // only the primary grade ran — no second
    expect(cap.lines()).toContain("second-opinion gate is a no-op");
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(A3b) NO-OPs when evaluatorSecond equals the configured primary backend+model", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    ctx.config.evaluator.secondOpinion.enabled = true;
    // Same effective backend+model as the default primary evaluator (opus/claude).
    ctx.config.roles.evaluatorSecond = { model: "opus", effort: "high" };
    let evalCount = 0;
    const cap = captureStdout();
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: async () => genOut(),
      evaluateItem: async () => { evalCount++; return evalOut(true); },
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    cap.restore();
    expect(evalCount).toBe(1);
    expect(cap.lines()).toContain("second-opinion gate is a no-op");
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(A3c) NO-OPs when the primary FALLS BACK to a role matching evaluatorSecond (post-pickRole)", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    ctx.config.build.autoRestart = { ...ctx.config.build.autoRestart, enabled: true };
    // Primary evaluator's backend (claude) is in a limit window → pickRole selects its fallback…
    ctx.config.roles.evaluator = { model: "opus", effort: "high", fallback: { backend: "codex", model: "gpt-5.5" } };
    ctx.store.data.build.limitedRoles = { claude: Date.now() + 60 * 60 * 1000 };
    // …which is the SAME effective backend+model as evaluatorSecond → independence guard no-ops.
    ctx.config.evaluator.secondOpinion.enabled = true;
    ctx.config.roles.evaluatorSecond = { backend: "codex", model: "gpt-5.5" };
    let evalCount = 0;
    const cap = captureStdout();
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: async () => genOut(),
      evaluateItem: async () => { evalCount++; return evalOut(true); },
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    cap.restore();
    expect(evalCount).toBe(1); // only the (fallback) primary grade — the gate no-opped
    expect(cap.lines()).toContain("second-opinion gate is a no-op");
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(A4) a second-opinion FAIL demotes the round; feedback carries the redacted blocking, holdout-scrubbed", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    ctx.config.evaluator.secondOpinion.enabled = true;
    ctx.config.roles.evaluatorSecond = { backend: "codex", model: "gpt-5.5" };
    const HOLDOUT_LINE = "the secret flag SPARRA_XYZ must equal 42 exactly";
    fs.writeFileSync(ctx.paths.holdout, `# Holdout\n- ${HOLDOUT_LINE}\n`);
    const genFeedbacks: Array<string | undefined> = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: async (args) => { genFeedbacks.push(args.feedback); return genOut(); },
      // The (unredacted) second-opinion verdict quotes holdout text in its blocking.
      evaluateItem: async (args) =>
        isSecond(args.role)
          ? secondEval({ verdict: "fail", blocking: [`Assertion 3 fails: ${HOLDOUT_LINE} was not honored`] })
          : evalOut(true),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);

    const round2 = genFeedbacks[1]!; // the demote set feedback for the next round
    expect(round2).toBeTruthy();
    expect(round2).toContain("SECOND-OPINION");
    expect(round2).toContain("[redacted: holdout]");
    expect(round2).not.toContain(HOLDOUT_LINE); // raw holdout never reaches the generator
    expect(ctx.store.data.build.items["item-001"]!.status).not.toBe("passed"); // demoted, not accepted
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(A5a) a second fail with NO parseable verdict (non-empty, non-limit) DEMOTES", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    ctx.config.evaluator.secondOpinion.enabled = true;
    ctx.config.roles.evaluatorSecond = { backend: "codex", model: "gpt-5.5" };
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: async () => genOut(),
      // Mirrors evaluateItem's forced-FAIL fallback: fail verdict, no limitHit, ran, no assertions.
      evaluateItem: async (args) =>
        isSecond(args.role)
          ? secondEval({ verdict: "fail", exerciseStatus: "ran", blocking: ["Evaluator did not produce a parseable JSON verdict; re-run."] })
          : evalOut(true),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(ctx.store.data.build.items["item-001"]!.status).not.toBe("passed"); // fail-closed demote
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(A5b) a second fail carrying limitHit / empty completion does NOT demote — accept proceeds", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    ctx.config.evaluator.secondOpinion.enabled = true;
    ctx.config.roles.evaluatorSecond = { backend: "codex", model: "gpt-5.5" };
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: async () => genOut(),
      evaluateItem: async (args) =>
        isSecond(args.role)
          ? secondEval({ verdict: "fail" }, { limitHit: { kind: "usage" } as LimitHit })
          : evalOut(true),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed"); // no second opinion → accept
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(A5c) a second fail that is only environment-BLOCKED or ALL-UN-RUN does NOT demote", async () => {
    for (const variant of ["blocked", "allUnrun"] as const) {
      const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
      ctx.config.evaluator.secondOpinion.enabled = true;
      ctx.config.roles.evaluatorSecond = { backend: "codex", model: "gpt-5.5" };
      const over: Partial<Verdict> =
        variant === "blocked"
          ? { verdict: "fail", exerciseStatus: "blocked" }
          : { verdict: "fail", assertions: [{ id: 1, pass: false, evidence: "x" }], unrunAssertionIds: [1] };
      const deps: Partial<BuildDeps> = {
        ...baseDeps(),
        decompose: async () => one,
        generateItem: async () => genOut(),
        evaluateItem: async (args) => (isSecond(args.role) ? secondEval(over) : evalOut(true)),
      };
      await cmdBuild(ctx, { workspaceOverride: dir }, deps);
      expect(ctx.store.data.build.items["item-001"]!.status, `variant ${variant}`).toBe("passed");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(A6) a second-opinion PASS lets acceptance proceed exactly as today", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    ctx.config.evaluator.secondOpinion.enabled = true;
    ctx.config.roles.evaluatorSecond = { backend: "codex", model: "gpt-5.5" };
    let secondCalls = 0;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: async () => genOut(),
      evaluateItem: async (args) => {
        if (isSecond(args.role)) { secondCalls++; return secondEval({ verdict: "pass", blocking: [] }); }
        return evalOut(true);
      },
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(secondCalls).toBe(1);
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(A7) bounded to PASS: no second grade runs on a primary FAIL", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    ctx.config.evaluator.secondOpinion.enabled = true;
    ctx.config.roles.evaluatorSecond = { backend: "codex", model: "gpt-5.5" };
    let secondCalls = 0;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: async () => genOut(),
      evaluateItem: async (args) => {
        if (isSecond(args.role)) secondCalls++;
        return evalOut(false); // primary always fails → gate never reached
      },
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(secondCalls).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(A8) the second grade's cost/tokens fold into the item's spend", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    ctx.config.evaluator.secondOpinion.enabled = true;
    ctx.config.roles.evaluatorSecond = { backend: "codex", model: "gpt-5.5" };
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: async () => genOut({ costUsd: 0.001, tokens: 100 }),
      evaluateItem: async (args) =>
        isSecond(args.role)
          ? secondEval({ verdict: "pass", blocking: [] }, { costUsd: 0.5, tokens: 1000 })
          : evalOut(true, { costUsd: 0.001, tokens: 100 }),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    const st = ctx.store.data.build.items["item-001"]!;
    expect(st.costUsd).toBeGreaterThanOrEqual(0.5); // floor: includes the second-opinion cost
    expect(st.tokensUsed).toBeGreaterThanOrEqual(1000);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(A9) DISABLED by default: no second grade runs", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    // secondOpinion.enabled defaults to false; evaluatorSecond set but ignored.
    ctx.config.roles.evaluatorSecond = { backend: "codex", model: "gpt-5.5" };
    let secondCalls = 0;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => one,
      generateItem: async () => genOut(),
      evaluateItem: async (args) => {
        if (isSecond(args.role)) secondCalls++;
        return evalOut(true);
      },
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(secondCalls).toBe(0);
    expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(A1) default config carries evaluator.secondOpinion.enabled=false and no evaluatorSecond", () => {
    const cfg = defaultConfig();
    expect(cfg.evaluator.secondOpinion.enabled).toBe(false);
    expect(cfg.roles.evaluatorSecond).toBeUndefined();
  });
});
