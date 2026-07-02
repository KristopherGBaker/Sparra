import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmdBuild, type BuildDeps } from "../src/phases/build.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { maybeResetWorkspace, type ResetDeps } from "../src/build/reset.ts";
import { APPROACH_CAP, FAILURE_CAP } from "../src/build/attempts.ts";
import { TRUNCATION_MARKER } from "../src/build/feedback.ts";
import { defaultConfig, type SparraConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import type { WorkItem, Verdict } from "../src/build/types.ts";
import { generateItem, type GenerateOutput } from "../src/build/generate.ts";
import type { EvalOutput } from "../src/build/evaluate.ts";
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
