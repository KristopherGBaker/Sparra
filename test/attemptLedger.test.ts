import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendAttempt,
  readAttemptLedger,
  recordAttemptLedger,
  renderAttemptLine,
  buildAttemptLedgerPath,
  conductAttemptLedgerPath,
  ATTEMPT_LEDGER_BASENAME,
  REASON_CAP,
  type AttemptInput,
} from "../src/build/attemptLedger.ts";
import { cmdBuild, type BuildDeps } from "../src/phases/build.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig, type SparraConfig, type RoleConfig } from "../src/config.ts";
import { cmdStatus } from "../src/phases/status.ts";
import { parseConductReport } from "../src/phases/conduct.ts";
import { runUnitHybrid, runUnitLlm, type ConductUnitDeps } from "../src/conduct/unitRunner.ts";
import type { ParentSummary, RunRoleSpec } from "../conductors/core/index.ts";
import type { Ctx } from "../src/context.ts";
import type { WorkItem, Verdict } from "../src/build/types.ts";
import type { GenerateOutput } from "../src/build/generate.ts";
import type { EvalOutput } from "../src/build/evaluate.ts";

// ── build fixtures (mirror test/build.test.ts) ──
function makeVerdict(pass: boolean, over: Partial<Verdict> = {}): Verdict {
  return {
    assertions: [],
    scores: { design: 80, originality: 80, craft: 80, functionality: 80 },
    weightedTotal: pass ? 90 : 30,
    verdict: pass ? "pass" : "fail",
    blocking: pass ? [] : ["something is wrong"],
    notes: "n",
    ...over,
  };
}
function genOut(over: Partial<GenerateOutput> = {}): GenerateOutput {
  return { report: "", deviations: [], sessionId: "g", hitMaxTurns: false, costUsd: 0.001, tokens: 100, ...over };
}
function evalOut(v: Verdict, over: Partial<EvalOutput> = {}): EvalOutput {
  return { verdict: v, raw: "", sessionId: "e", costUsd: 0.001, tokens: 100, ...over };
}
async function makeCtx(buildOver: Partial<SparraConfig["build"]> = {}): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-ledger-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  fs.writeFileSync(paths.frozenPlan, "# Plan\nBuild things.\n");
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
    appendLearning: async () => {},
    readMemory: async () => "",
    commitItem: async () => ({ ok: true, commits: 0 }),
  };
}
const oneItem: WorkItem[] = [{ id: "item-001", title: "first", summary: "", dependsOn: [], rationale: "" }];

// ────────────────────────────── module: lineage semantics (A2) ──────────────────────────────
describe("attemptLedger — lineage semantics", () => {
  it("computes attemptId/lineage/parent for initial → patch → pivot", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "led-"));
    const file = path.join(dir, ATTEMPT_LEDGER_BASENAME);
    const r1 = await appendAttempt(file, { round: 1, kind: "initial", decision: "continue-patch", reason: "a" });
    const r2 = await appendAttempt(file, { round: 2, kind: "patch", decision: "pivot", reason: "b" });
    const r3 = await appendAttempt(file, { round: 3, kind: "pivot", decision: "accept", reason: "c" });

    expect(r1).toMatchObject({ attemptId: "a1", kind: "initial", lineage: 0, parentAttemptId: null, decision: "continue-patch" });
    expect(r2).toMatchObject({ attemptId: "a2", kind: "patch", lineage: 0, parentAttemptId: "a1", decision: "pivot" });
    expect(r3).toMatchObject({ attemptId: "a3", kind: "pivot", lineage: 1, parentAttemptId: null, decision: "accept" });
    // kind and decision are independent per record.
    expect(r2.kind).not.toBe(r2.decision);
    // patch vs pivot lineage shapes are structurally distinct.
    expect(r2.lineage).toBe(0);
    expect(r3.lineage).toBe(1);
    // attemptIds unique + ordinal
    const ids = readAttemptLedger(file).map((r) => r.attemptId);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(["a1", "a2", "a3"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("caps reason at REASON_CAP and never emits an empty reason", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "led-"));
    const file = path.join(dir, ATTEMPT_LEDGER_BASENAME);
    const long = await appendAttempt(file, { round: 1, kind: "initial", decision: "accept", reason: "x".repeat(1000) });
    expect(long.reason.length).toBeLessThanOrEqual(REASON_CAP);
    const empty = await appendAttempt(file, { round: 2, kind: "patch", decision: "accept", reason: "   " });
    expect(empty.reason.trim().length).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("nullable eval fields are preserved as null (never fabricated)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "led-"));
    const file = path.join(dir, ATTEMPT_LEDGER_BASENAME);
    const r = await appendAttempt(file, { round: 1, kind: "initial", decision: "budget-halt", reason: "halt" });
    expect(r.score).toBeNull();
    expect(r.verdict).toBeNull();
    expect(r.verdictPath).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ────────────────────────── module: append-only + crash/replay (A8) ──────────────────────────
describe("attemptLedger — append-only + crash/replay dedup", () => {
  it("byte prefix unchanged after a later append; replay is a no-op; conflicting round left unchanged", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "led-"));
    const file = path.join(dir, ATTEMPT_LEDGER_BASENAME);
    await appendAttempt(file, { round: 1, kind: "initial", decision: "continue-patch", reason: "first" });
    const before = fs.readFileSync(file, "utf8");
    await appendAttempt(file, { round: 2, kind: "patch", decision: "accept", reason: "second" });
    const after = fs.readFileSync(file, "utf8");
    expect(after.startsWith(before)).toBe(true); // (a) earlier bytes intact

    // (b) replay the identical round-1 decision after a "crash" → no duplicate
    await appendAttempt(file, { round: 1, kind: "initial", decision: "continue-patch", reason: "first" });
    expect(readAttemptLedger(file).filter((r) => r.round === 1)).toHaveLength(1);

    // (c) a CONFLICTING record for round 1 is left unchanged, never overwritten
    await appendAttempt(file, { round: 1, kind: "pivot", decision: "abandon", reason: "different" });
    const r1 = readAttemptLedger(file).find((r) => r.round === 1)!;
    expect(r1.decision).toBe("continue-patch");
    expect(r1.reason).toBe("first");
    expect(readAttemptLedger(file).filter((r) => r.round === 1)).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("attemptLedger — rendering + missing-file", () => {
  it("renders an unevaluated marker when score/verdict are null; missing ledger reads []", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "led-"));
    expect(readAttemptLedger(path.join(dir, "nope.jsonl"))).toEqual([]);
    const line = renderAttemptLine({
      attemptId: "a1", parentAttemptId: null, lineage: 0, round: 1, kind: "initial",
      decision: "budget-halt", score: null, verdict: null, verdictPath: null, reason: "halt", cost: null, at: "t",
    });
    expect(line).toMatch(/unevaluated/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ─────────────────────── build loop: per-round records + cost + reasons (A1) ───────────────────────
describe("cmdBuild — attempt ledger", () => {
  it("records one record per decided round with cost, seeded-token reasons, decision, score (A1)", async () => {
    const { ctx, dir } = await makeCtx({ maxRoundsPerItem: 4, flakinessReruns: 0 });
    let round = 0;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => oneItem,
      generateItem: async () => genOut({ costUsd: 0.001, tokens: 100 }),
      evaluateItem: async () => {
        round += 1;
        return round === 1
          ? evalOut(makeVerdict(false, { blocking: ["ALPHATOKEN missing guard"] }))
          : evalOut(makeVerdict(true, { notes: "BRAVOTOKEN clean pass" }));
      },
    };
    const res = await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    const records = readAttemptLedger(buildAttemptLedgerPath(ctx.paths, res.runId, "item-001"));
    expect(records).toHaveLength(2);

    const [r1, r2] = records;
    expect(r1).toMatchObject({ round: 1, kind: "initial", decision: "continue-patch", verdict: "fail", score: 30 });
    expect(r1!.verdictPath).toBeTruthy();
    expect(r1!.reason).toContain("ALPHATOKEN");
    expect(r1!.cost).toBeCloseTo(0.002, 6); // cumulative gen+eval after round 1

    expect(r2).toMatchObject({ round: 2, kind: "patch", decision: "accept", verdict: "pass", score: 90 });
    expect(r2!.reason).toContain("BRAVOTOKEN");
    expect(r2!.cost).toBeCloseTo(0.004, 6);

    // reasons differ (not hardcoded)
    expect(r1!.reason).not.toBe(r2!.reason);
    for (const r of records) {
      expect(r.reason.length).toBeGreaterThan(0);
      expect(r.reason.length).toBeLessThanOrEqual(REASON_CAP);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("budget halts: post-eval halt carries score+verdict; pre-eval halt has null eval (A3)", async () => {
    // POST-eval halt: eval runs (fail), then budget halts on the evaluate phase.
    const post = await makeCtx({ maxBudgetUsdPerItem: 0.01, maxRoundsPerItem: 6, flakinessReruns: 0 });
    const postDeps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => oneItem,
      generateItem: async () => genOut({ costUsd: 0.001 }),
      evaluateItem: async () => evalOut(makeVerdict(false), { costUsd: 5 }), // eval blows the cap
    };
    const rPost = await cmdBuild(post.ctx, { workspaceOverride: post.dir }, postDeps);
    const postRec = readAttemptLedger(buildAttemptLedgerPath(post.ctx.paths, rPost.runId, "item-001")).find((r) => r.decision === "budget-halt")!;
    expect(postRec).toBeTruthy();
    expect(postRec.score).not.toBeNull();
    expect(postRec.verdict).not.toBeNull();
    expect(postRec.cost).not.toBeNull();
    fs.rmSync(post.dir, { recursive: true, force: true });

    // PRE-eval halt: generation blows the cap BEFORE grading.
    const pre = await makeCtx({ maxBudgetUsdPerItem: 0.01, maxRoundsPerItem: 6 });
    let evalRan = false;
    const preDeps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => oneItem,
      generateItem: async () => genOut({ costUsd: 5 }), // generation blows the cap
      evaluateItem: async () => { evalRan = true; return evalOut(makeVerdict(false)); },
    };
    const rPre = await cmdBuild(pre.ctx, { workspaceOverride: pre.dir }, preDeps);
    const preRec = readAttemptLedger(buildAttemptLedgerPath(pre.ctx.paths, rPre.runId, "item-001")).find((r) => r.decision === "budget-halt")!;
    expect(preRec).toBeTruthy();
    expect(preRec.score).toBeNull();
    expect(preRec.verdict).toBeNull();
    expect(preRec.verdictPath).toBeNull();
    expect(evalRan).toBe(false);
    fs.rmSync(pre.dir, { recursive: true, force: true });
  });

  it("terminal inconclusive (all-un-run) → terminal-inconclusive with null verdict (A5)", async () => {
    const { ctx, dir } = await makeCtx({ maxRoundsPerItem: 2, flakinessReruns: 0 });
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => oneItem,
      generateItem: async () => genOut(),
      evaluateItem: async () =>
        evalOut(makeVerdict(false, { assertions: [{ id: 1, pass: false, evidence: "" }], unrunAssertionIds: [1] })),
    };
    const res = await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    const records = readAttemptLedger(buildAttemptLedgerPath(ctx.paths, res.runId, "item-001"));
    const terminal = records[records.length - 1]!;
    expect(terminal.decision).toBe("terminal-inconclusive");
    expect(terminal.verdict).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("preflight bounce → continue-patch with null eval, evaluator not called, next round descends (A17)", async () => {
    const { ctx, dir } = await makeCtx({ maxRoundsPerItem: 3, preflightVerify: true, verifyCommands: ["npm"] });
    const evalRounds: number[] = [];
    let execCalls = 0;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => oneItem,
      negotiateContract: async () => ({ text: "## I will verify by\n1. `npm test`\n", agreed: true, tracesUsed: 0 }),
      generateItem: async () => genOut(),
      evaluateItem: async (args) => { evalRounds.push(args.round); return evalOut(makeVerdict(true)); },
      // deterministic behavioral failure on the FIRST preflight run only; the recovered round passes.
      execVerifyCommand: async () => {
        execCalls += 1;
        return execCalls === 1
          ? { ran: true, command: "npm test", exitCode: 1, stdout: "PREFLIGHTTOKEN failed", stderr: "", timedOut: false }
          : { ran: true, command: "npm test", exitCode: 0, stdout: "ok", stderr: "", timedOut: false };
      },
    };
    const res = await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    const records = readAttemptLedger(buildAttemptLedgerPath(ctx.paths, res.runId, "item-001"));
    const preflight = records.find((r) => r.round === 1)!;
    expect(preflight.decision).toBe("continue-patch");
    expect(preflight.score).toBeNull();
    expect(preflight.verdict).toBeNull();
    expect(preflight.reason).toContain("PREFLIGHTTOKEN");
    // The evaluator was NOT invoked for round 1 (the preflight bounce short-circuited it).
    expect(evalRounds).not.toContain(1);
    // the recovered round descends from the preflight round, same lineage
    const next = records.find((r) => r.round === 2)!;
    expect(next.parentAttemptId).toBe(preflight.attemptId);
    expect(next.lineage).toBe(preflight.lineage);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("redaction: a sentinel in the RAW evaluator output never lands in the ledger (A7)", async () => {
    const { ctx, dir } = await makeCtx({ maxRoundsPerItem: 3, flakinessReruns: 0 });
    // The distinctive sentinels live ONLY in raw evaluator/session output and in HOLDOUT.md — NOT in
    // the redacted Verdict fields the ledger is allowed to read. A correct redaction wall keeps both
    // out of every ledger artifact even though the fake evaluator's raw transcript carries the sentinel.
    const RAW_SENTINEL = "SENTINEL_RAW_EVAL_LEAK_9f4b6c2d";
    const HOLDOUT_SENTINEL = "SENTINEL_HOLDOUT_SECRET_a1b2c3d4";
    fs.writeFileSync(ctx.paths.holdout, HOLDOUT_SENTINEL + "\n");
    let round = 0;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => oneItem,
      // Raw generator report also carries the sentinel (raw session text) — the ledger must ignore it.
      generateItem: async () => genOut({ report: `gen session transcript ${RAW_SENTINEL}` }),
      evaluateItem: async () => {
        round += 1;
        return evalOut(
          round === 1
            ? makeVerdict(false, { blocking: ["SAFE_BLOCKING_TOKEN"], notes: "safe redacted note" })
            : makeVerdict(true, { blocking: [], notes: "safe pass note" }),
          // The RAW evaluator transcript carries the sentinel; the redacted Verdict fields do NOT.
          { raw: `raw evaluator transcript ${RAW_SENTINEL} + ${HOLDOUT_SENTINEL} trailing` },
        );
      },
    };
    const res = await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    const file = buildAttemptLedgerPath(ctx.paths, res.runId, "item-001");
    const text = fs.readFileSync(file, "utf8");
    // Non-degenerate: the ledger genuinely recorded rounds with real reason content (so the guard has
    // something to redact), yet neither the raw-evaluator nor the holdout sentinel appears anywhere.
    expect(readAttemptLedger(file).length).toBeGreaterThanOrEqual(2);
    expect(text).toContain("SAFE_BLOCKING_TOKEN");
    expect(text).not.toContain(RAW_SENTINEL);
    expect(text).not.toContain(HOLDOUT_SENTINEL);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ─────────────────────────── status surfacing (A11) ───────────────────────────
describe("cmdStatus --attempts", () => {
  it("dumps per-round lines only with --attempts; flagless stays compact", async () => {
    const { ctx, dir } = await makeCtx({ maxRoundsPerItem: 4, flakinessReruns: 0 });
    ctx.store.data.build.runId = "run-x";
    ctx.store.data.build.items = { "item-001": { status: "passed", round: 2, pivots: 0, criterionFailStreak: {}, lastScore: 90 } };
    const file = buildAttemptLedgerPath(ctx.paths, "run-x", "item-001");
    await recordAttemptLedger(file, { round: 1, kind: "initial", decision: "continue-patch", reason: "r1", score: 30, verdict: "fail" });
    await recordAttemptLedger(file, { round: 2, kind: "pivot", decision: "accept", reason: "r2", score: 90, verdict: "pass" });

    const prior = process.env.SPARRA_LOG_IN_TESTS;
    process.env.SPARRA_LOG_IN_TESTS = "1";
    let buf = "";
    const spy = { write: process.stdout.write.bind(process.stdout) };
    const orig = process.stdout.write;
    (process.stdout as unknown as { write: (c: string) => boolean }).write = (c: string) => { buf += c; return true; };
    try {
      cmdStatus(ctx, { attempts: true });
      const withFlag = buf;
      buf = "";
      cmdStatus(ctx);
      const compact = buf;
      expect(withFlag).toMatch(/r1 initial/);
      expect(withFlag).toMatch(/accept/);
      expect(compact).not.toMatch(/r1 initial/);
    } finally {
      (process.stdout as unknown as { write: typeof orig }).write = orig;
      void spy;
      if (prior === undefined) delete process.env.SPARRA_LOG_IN_TESTS; else process.env.SPARRA_LOG_IN_TESTS = prior;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ─────────────────────────── conduct closed-flag rule (A12) ───────────────────────────
describe("parseConductReport — --attempts closed flag rule", () => {
  it("accepts --attempts with --status; rejects an out-of-set flag; rejects valued --attempts", () => {
    const ok = parseConductReport(["conduct"], { status: "run-1", attempts: true });
    expect(ok.kind).toBe("status");
    expect((ok as { attempts: boolean }).attempts).toBe(true);

    const bad = parseConductReport(["conduct"], { status: "run-1", commit: true });
    expect(bad.kind).toBe("usage-error");

    const valued = parseConductReport(["conduct"], { status: "run-1", attempts: "x" });
    expect(valued.kind).toBe("usage-error");

    const onList = parseConductReport(["conduct"], { list: true, attempts: true });
    expect(onList.kind).toBe("usage-error");
  });
});

// ─────────────────────────── conduct engines (A10) ───────────────────────────
function summary(over: Partial<ParentSummary> = {}): ParentSummary {
  return { roleKind: "evaluator", verdict: "fail", weightedTotal: 40, blocking: ["needs work"], costUsd: 0.01, verdictPath: "/v.md", ...over } as ParentSummary;
}
function conductDeps(over: Partial<ConductUnitDeps>, sink: AttemptInput[]): ConductUnitDeps {
  const role = defaultConfig().roles.generator as RoleConfig;
  const evalSpec = { kind: "eval" } as unknown as RunRoleSpec;
  const genSpec = { kind: "gen" } as unknown as RunRoleSpec;
  return {
    runRole: async (spec) => ((spec as unknown as { kind: string }).kind === "eval" ? summary() : summary({ roleKind: "generator", verdict: "fail" })),
    specs: {
      generatorSpecFor: () => genSpec,
      evaluatorSpec: () => evalSpec,
      contractGeneratorSpec: {} as RunRoleSpec,
      contractEvaluatorSpec: {} as RunRoleSpec,
    } as unknown as ConductUnitDeps["specs"],
    decide: () => "revise",
    judge: async () => ({ answer: "abandon", source: "auto-deterministic", via: "auto" }),
    noteDecision: () => {},
    writeGeneralizedBrief: async () => "/g.md",
    recordRound: (input) => { sink.push(input); },
    recoveryCaps: { role },
    generatorRole: role,
    unit: "unit-001",
    contractMaxRounds: 2,
    maxRounds: 2,
    pivotAfterFailures: 2,
    requireCrossModel: true,
    passThreshold: 70,
    borderlineMargin: 5,
    resumeContract: { agreed: true, forced: false },
    ...over,
  };
}

describe("conduct runUnitHybrid / runUnitLlm — per-round ledger (A10)", () => {
  // Persist the emitted inputs through the real sink to a file so lineage (computed by the sink) is
  // exercised too — the file path is what run.ts wires in production.
  async function persist(sink: AttemptInput[], unit = "unit-001") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "led-c-"));
    const file = conductAttemptLedgerPath(dir, unit);
    for (const input of sink) await appendAttempt(file, input);
    const records = readAttemptLedger(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return records;
  }

  it("hybrid: accept path — records ONLY the two executed rounds (no phantom), final=accept", async () => {
    const sink: AttemptInput[] = [];
    let n = 0;
    const deps = conductDeps(
      {
        runRole: async (spec) => {
          const kind = (spec as unknown as { kind: string }).kind;
          if (kind === "eval") { n += 1; return summary({ verdict: n >= 2 ? "pass" : "fail", weightedTotal: n >= 2 ? 90 : 40 }); }
          return summary({ roleKind: "generator" });
        },
        decide: () => (n >= 2 ? "accept" : "revise"),
      },
      sink,
    );
    const res = await runUnitHybrid(deps);
    expect(res.outcome).toBe("accepted");
    const records = await persist(sink);
    // Exactly two EXECUTED rounds — never a fabricated third round.
    expect(records.map((r) => r.round)).toEqual([1, 2]);
    expect(records[0]).toMatchObject({ round: 1, kind: "initial", decision: "continue-patch", lineage: 0, parentAttemptId: null });
    expect(records[1]).toMatchObject({ round: 2, kind: "patch", decision: "accept", lineage: 0, parentAttemptId: "a1" });
  });

  it("hybrid: abandon-on-exhaustion — final executed round carries the terminal outcome, no phantom", async () => {
    const sink: AttemptInput[] = [];
    const deps = conductDeps(
      { decide: () => "revise", judge: async () => ({ answer: "abandon", source: "auto-deterministic", via: "auto" }) },
      sink,
    );
    const res = await runUnitHybrid(deps);
    expect(res.outcome).toBe("abandoned");
    const records = await persist(sink);
    // maxRounds=2 → exactly rounds 1 and 2 (no fabricated round 3 for the exhaustion decision).
    expect(records.map((r) => r.round)).toEqual([1, 2]);
    expect(records[1]).toMatchObject({ round: 2, decision: "abandon" });
    // Every record corresponds to a round that actually generated+evaluated (has a score).
    for (const r of records) expect(r.score).not.toBeNull();
  });

  it("llm: a brain accept AFTER an executed round records ONLY the executed round (no phantom)", async () => {
    const sink: AttemptInput[] = [];
    let turn = 0;
    const deps = conductDeps(
      {
        brain: {
          // turn 1 → run (executes round 1); turn 2 → accept (post-evaluation brain decision)
          drive: async () => { turn += 1; return turn >= 2 ? { answer: "accept" } : { answer: "run" }; },
          judge: async () => ({ answer: "abandon", source: "brain", via: "auto" }),
        } as unknown as ConductUnitDeps["brain"],
      },
      sink,
    );
    const res = await runUnitLlm(deps);
    expect(res.outcome).toBe("accepted");
    const records = await persist(sink);
    // EXACTLY one record — for the one executed round — never a phantom round 2 with copied eval fields.
    expect(records.map((r) => r.round)).toEqual([1]);
    expect(records[0]).toMatchObject({ round: 1, kind: "initial", decision: "accept", lineage: 0, parentAttemptId: null });
    expect(records[0]!.score).not.toBeNull();
  });

  it("llm: two executed rounds then accept — records rounds [1,2], no phantom third", async () => {
    const sink: AttemptInput[] = [];
    let turn = 0;
    const deps = conductDeps(
      {
        brain: {
          drive: async () => { turn += 1; return turn >= 3 ? { answer: "accept" } : { answer: "run" }; },
          judge: async () => ({ answer: "abandon", source: "brain", via: "auto" }),
        } as unknown as ConductUnitDeps["brain"],
        maxRounds: 5,
      },
      sink,
    );
    const res = await runUnitLlm(deps);
    expect(res.outcome).toBe("accepted");
    const records = await persist(sink);
    expect(records.map((r) => r.round)).toEqual([1, 2]);
    expect(records[0]!.decision).toBe("continue-patch");
    expect(records[1]!.decision).toBe("accept");
  });

  it("llm: exhaustion records the terminal on the LAST executed round, no phantom past it", async () => {
    const sink: AttemptInput[] = [];
    const deps = conductDeps(
      {
        brain: { drive: async () => ({ answer: "run" }), judge: async () => ({ answer: "abandon", source: "brain", via: "auto" }) } as unknown as ConductUnitDeps["brain"],
        maxRounds: 2,
      },
      sink,
    );
    const res = await runUnitLlm(deps);
    expect(res.outcome).toBe("exhausted");
    const records = await persist(sink);
    // rounds 1 and 2 executed; the exhaustion terminal lands on round 2 — never a round 3.
    expect(records.map((r) => r.round)).toEqual([1, 2]);
    expect(records[1]).toMatchObject({ round: 2, decision: "terminal-fail" });
  });
});
