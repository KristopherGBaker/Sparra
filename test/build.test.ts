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
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      prepareWorkspace: () => ({ dir: wt, branch: "sparra/test", note: "t" }),
      provisionWorkspaceDeps: (root, ws, cfg) => {
        calls.push({ root, ws, cfg });
        return { copied: [], skipped: [], failed: [] };
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
