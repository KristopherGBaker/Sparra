import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadCtxForRole, type Ctx } from "../src/context.ts";
import {
  runConduct,
  resumeConduct,
  type ConductDeps,
  type ConductOptions,
} from "../src/conduct/run.ts";
import {
  ConductLearningWriter,
  composeUnitLearning,
  composeDecisionLearning,
  unitLearningDedup,
} from "../src/conduct/learnings.ts";
import {
  appendLearning,
  DEFAULT_CAPS,
  type Learning,
  type MemoryCaps,
} from "../src/memory.ts";
import { runRole } from "../src/build/roleRun.ts";
import { conductRunDir, runStatePath } from "../src/conduct/runState.ts";
import { type Brain, type DriveContext } from "../src/conduct/brain.ts";
import { type BrainDecision, type DecisionRequest, type DecisionRecord } from "../src/conduct/decision.ts";
import { toParentSummary, type ParentSummary, type RunRoleSpec } from "../conductors/core/index.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";
import type { ConductRunState, UnitOutcome, UnitStateEntry } from "../src/conduct/types.ts";
import type { RunRolePayload } from "../src/roleEnvelope.ts";

// NOTE: every test here runs with INJECTED deps (fake runRole / brain / appendLearning) — zero live
// model calls and NO real-CLI spawn, so `test/helpers/judgeEnv.ts` is deliberately NOT imported
// (assertion 13: import it iff spawning the real CLI; none do).

const noProbe = async (): Promise<void> => {};
function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sparra-conduct-mem-"));
}
async function makeCtx(dir: string): Promise<Ctx> {
  return loadCtxForRole(dir, { probeAuto: noProbe });
}
function summary(o: Partial<ParentSummary>): ParentSummary {
  return { roleKind: "generator", backend: "stub", model: "stub-1", ok: true, errors: [], tokens: 0, costUsd: 0, ...o };
}
function kindOf(args: string[]): string {
  const i = args.indexOf("--kind");
  return i >= 0 ? args[i + 1]! : args[0] === "eval" ? "evaluator" : "?";
}
function argVal(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
interface FakeRunner {
  runRole: (spec: RunRoleSpec) => Promise<ParentSummary>;
  specs: RunRoleSpec[];
}
function fakeRunner(handler: (c: { kind: string; unit?: string; spec: RunRoleSpec }) => Promise<ParentSummary> | ParentSummary): FakeRunner {
  const specs: RunRoleSpec[] = [];
  return {
    specs,
    runRole: async (spec: RunRoleSpec) => {
      specs.push(spec);
      return handler({ kind: kindOf(spec.args), unit: spec.env?.SPARRA_CONDUCT_UNIT as string | undefined, spec });
    },
  };
}
function decomposerFn(n: number): (p: RunSessionParams) => Promise<RunResult> {
  return async () => ({
    ok: true,
    subtype: "success",
    resultText: "```json\n" + JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `unit-${String(i + 1).padStart(3, "0")}`, title: `Title ${i + 1}`, summary: "s", rationale: "r" }))) + "\n```",
    sessionId: "d",
    costUsd: 0,
    tokens: 1,
    numTurns: 1,
    hitMaxTurns: false,
    hitBudget: false,
    errors: [],
    tracePath: "",
  });
}
/** Contract phase: generator drafts a file, evaluator AGREES round 1. */
function contractAgree(kind: string, spec: RunRoleSpec): ParentSummary | undefined {
  if (kind === "contract-generator") {
    fs.writeFileSync(argVal(spec.args, "--contract")!, "C");
    return summary({ roleKind: "contract-generator", outPath: argVal(spec.args, "--contract") });
  }
  if (kind === "contract-evaluator") return summary({ roleKind: "contract-evaluator", contractAgreed: true });
  return undefined;
}
function hybridRunner(
  evalFn: (unit: string, round: number) => ParentSummary,
  genFn?: (unit: string, round: number) => ParentSummary,
): FakeRunner {
  const evalRounds: Record<string, number> = {};
  const genRounds: Record<string, number> = {};
  return fakeRunner(({ kind, unit, spec }) => {
    const c = contractAgree(kind, spec);
    if (c) return c;
    if (kind === "generator") {
      const gr = (genRounds[unit!] = (genRounds[unit!] ?? 0) + 1);
      return genFn ? genFn(unit!, gr) : summary({ roleKind: "generator", filesChanged: 1 });
    }
    const er = (evalRounds[unit!] = (evalRounds[unit!] ?? 0) + 1);
    return evalFn(unit!, er);
  });
}
function fakeBrain(
  judgeFn: (r: DecisionRequest) => BrainDecision | undefined,
  driveFn?: (c: DriveContext) => BrainDecision | undefined,
): { brain: Brain; judgeCalls: DecisionRequest[]; driveCalls: DriveContext[] } {
  const judgeCalls: DecisionRequest[] = [];
  const driveCalls: DriveContext[] = [];
  return {
    judgeCalls,
    driveCalls,
    brain: {
      async judge(r) {
        judgeCalls.push(r);
        return judgeFn(r);
      },
      async drive(c) {
        driveCalls.push(c);
        return driveFn ? driveFn(c) : undefined;
      },
    },
  };
}
const OPTS = (o: Partial<ConductOptions> = {}): ConductOptions => ({ prompt: "build a thing", maxUnits: 4, concurrency: 2, dryRun: false, ...o });
const AUTO = (o: Partial<ConductOptions> = {}): ConductOptions => OPTS({ brain: "hybrid", surface: "auto", timeoutSec: 1800, ...o });

/** A fake backend session that records every assembled prompt and returns a benign result — lets a
 *  test drive the REAL `runRole` prompt-assembly path (src/build/roleRun.ts) with zero live calls and
 *  inspect the actually-assembled prompt (incl. the PRIOR LEARNINGS block). */
function sessionRecorder(): { calls: RunSessionParams[]; fn: (p: RunSessionParams) => Promise<RunResult> } {
  const calls: RunSessionParams[] = [];
  const fn = async (p: RunSessionParams): Promise<RunResult> => {
    calls.push(p);
    return { ok: true, subtype: "success", resultText: "done", sessionId: "r", costUsd: 0, tokens: 1, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "" };
  };
  return { calls, fn };
}

/** The live memory.md entry lines (post-header). */
function memEntries(ctx: Ctx): string[] {
  const text = fs.existsSync(ctx.paths.memory) ? fs.readFileSync(ctx.paths.memory, "utf8") : "";
  return text.split("\n").filter((l) => l.startsWith("- "));
}

/** Seed a persisted conduct run (mirrors conductResume.test.ts). */
function seedRun(ctx: Ctx, runId: string, opts: { status: ConductRunState["status"]; brain?: "hybrid" | "llm"; units: Array<{ id: string; title?: string; outcome: UnitOutcome; contract?: string; contractAgreed?: boolean; decisions?: DecisionRecord[] }> }): { runDir: string } {
  const runDir = conductRunDir(ctx.paths.dir, runId);
  const units: UnitStateEntry[] = opts.units.map((u) => {
    const unitDir = path.join(runDir, u.id);
    fs.mkdirSync(unitDir, { recursive: true });
    const briefPath = path.join(unitDir, "brief.md");
    fs.writeFileSync(briefPath, `# ${u.title ?? u.id}\n\nbrief text for ${u.id}\n`);
    const contractPath = path.join(unitDir, "contract.md");
    if (u.contract !== undefined) fs.writeFileSync(contractPath, u.contract);
    return {
      id: u.id,
      title: u.title ?? u.id,
      outcome: u.outcome,
      briefPath,
      contractPath,
      ...(u.contractAgreed !== undefined ? { contractAgreed: u.contractAgreed } : {}),
      ...(u.decisions ? { decisions: u.decisions } : {}),
    };
  });
  const state: ConductRunState = {
    runId,
    prompt: "the original prompt",
    status: opts.status,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    maxUnits: 4,
    concurrency: 2,
    dryRun: false,
    ...(opts.brain ? { brain: opts.brain } : {}),
    units,
  };
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(runStatePath(runDir), JSON.stringify(state, null, 2));
  return { runDir };
}

// ─────────────────────────────── composer unit tests ───────────────────────────────

describe("composeUnitLearning — kinds, fields, score, reason (assertions 2, 3)", () => {
  it("accepted → PASSED with runId/unitId/title/outcome/rounds/score", () => {
    const l = composeUnitLearning({ runId: "conduct-R1", unitId: "unit-001", title: "Add a widget", outcome: "accepted", rounds: 2, summary: summary({ weightedTotal: 88 }) });
    expect(l.kind).toBe("passed");
    expect(l.item).toBe("unit-001");
    expect(l.detail).toContain("conduct-R1");
    expect(l.detail).toContain("Add a widget");
    expect(l.detail).toContain("accepted");
    expect(l.detail).toContain("2 rounds");
    expect(l.detail).toContain("score 88");
  });
  it("acceptance with NO evaluator score → literal `score n/a`", () => {
    const l = composeUnitLearning({ runId: "r", unitId: "unit-001", title: "T", outcome: "accepted", rounds: 0 });
    expect(l.detail).toContain("score n/a");
    expect(l.detail).not.toMatch(/score \d/);
  });
  it("exhausted → FAILED, never PASSED, carries the blocking reason", () => {
    const l = composeUnitLearning({ runId: "r", unitId: "u", title: "T", outcome: "exhausted", rounds: 5, summary: summary({ blocking: ["missing FOO-123 test coverage"] }) });
    expect(l.kind).toBe("failed");
    expect(l.kind).not.toBe("passed");
    expect(l.detail).toContain("missing FOO-123 test coverage");
  });
  it("budget/limit terminal → BUDGET_EXCEEDED", () => {
    expect(composeUnitLearning({ runId: "r", unitId: "u", title: "T", outcome: "exhausted", rounds: 5, summary: summary({ hitBudget: true }) }).kind).toBe("budget_exceeded");
    expect(composeUnitLearning({ runId: "r", unitId: "u", title: "T", outcome: "exhausted", rounds: 5, summary: summary({ limitHit: { kind: "usage", raw: "usage limit" } }) }).kind).toBe("budget_exceeded");
  });
  it("error with NO blocking → FAILED, reason from the error message (precedence)", () => {
    const l = composeUnitLearning({ runId: "r", unitId: "u", title: "T", outcome: "error", rounds: 0, error: "boom: role threw at spawn" });
    expect(l.kind).toBe("failed");
    expect(l.detail).toContain("boom: role threw at spawn");
  });
  it("blocking takes precedence over error message when both present", () => {
    const l = composeUnitLearning({ runId: "r", unitId: "u", title: "T", outcome: "error", rounds: 1, summary: summary({ blocking: ["the real reason"] }), error: "generic error" });
    expect(l.detail).toContain("the real reason");
    expect(l.detail).not.toContain("generic error");
  });
  it("grade-not-independent and inconclusive → non-PASSED kind, outcome token present", () => {
    const gni = composeUnitLearning({ runId: "r", unitId: "u", title: "T", outcome: "grade-not-independent", rounds: 3, summary: summary({ sameModelGrade: true }) });
    expect(gni.kind).not.toBe("passed");
    expect(gni.detail).toContain("grade-not-independent");
    const inc = composeUnitLearning({ runId: "r", unitId: "u", title: "T", outcome: "inconclusive", rounds: 1 });
    expect(inc.kind).not.toBe("passed");
    expect(inc.detail).toContain("inconclusive");
  });
});

describe("composeDecisionLearning — pivot/generalize-spec markers (assertion 4)", () => {
  it("pivot → kind pivot", () => {
    const l = composeDecisionLearning({ runId: "r", unitId: "u", decision: "pivot", round: 2, summary: summary({ blocking: ["still failing"] }) });
    expect(l.kind).toBe("pivot");
    expect(l.detail).toContain("still failing");
  });
  it("generalize-spec → kind note carrying the literal `generalize-spec` marker", () => {
    const l = composeDecisionLearning({ runId: "r", unitId: "u", decision: "generalize-spec", round: 3 });
    expect(l.kind).toBe("note");
    expect(l.detail).toContain("generalize-spec");
  });
});

describe("holdout canary (assertion 6)", () => {
  it("a canary in resultText/holdout-bearing fields is absent after toParentSummary + composition", () => {
    const CANARY = "CANARY-HOLDOUT-9f3a";
    const payload = {
      roleKind: "evaluator",
      backend: "stub",
      model: "m",
      ok: true,
      verdict: "fail",
      weightedTotal: 40,
      blocking: ["a normal blocking line"],
      resultText: `secret leak ${CANARY}`,
      resultDigest: CANARY,
      traceDir: `/trace/${CANARY}`,
      errors: [],
      tokens: 0,
      costUsd: 0,
    } as unknown as RunRolePayload;
    const parentSummary = toParentSummary(payload);
    expect(JSON.stringify(parentSummary)).not.toContain(CANARY);
    const l = composeUnitLearning({ runId: "r", unitId: "u", title: "T", outcome: "exhausted", rounds: 2, summary: parentSummary });
    expect(l.detail).not.toContain(CANARY);
    expect(l.detail).toContain("a normal blocking line");
    // Type-level: the composer signature demands a ParentSummary (see the call above compiles), never
    // a raw RunRolePayload — a holdout-bearing field can't be threaded in.
    const _typecheck: (s: ParentSummary) => Learning = (s) => composeUnitLearning({ runId: "r", unitId: "u", title: "T", outcome: "accepted", rounds: 1, summary: s });
    void _typecheck;
  });
});

// ─────────────────────────────── writer tests ───────────────────────────────

describe("ConductLearningWriter — serialization, dedup, best-effort (assertions 7, 8, 11, 12)", () => {
  it("concurrency: ≥3 units through the real writer via Promise.all → all present, file well-formed", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const w = new ConductLearningWriter(ctx.paths);
      const ids = ["unit-001", "unit-002", "unit-003", "unit-004"];
      await Promise.all(
        ids.map((id) =>
          w.write(
            composeUnitLearning({ runId: "conduct-CONC", unitId: id, title: `Title ${id}`, outcome: "accepted", rounds: 1, summary: summary({ weightedTotal: 90 }) }),
            unitLearningDedup({ runId: "conduct-CONC", unitId: id, outcome: "accepted" }),
          ),
        ),
      );
      await w.drain();
      const entries = memEntries(ctx);
      // Header intact.
      expect(fs.readFileSync(ctx.paths.memory, "utf8")).toContain("# Sparra memory");
      for (const id of ids) expect(entries.some((e) => e.includes(id) && e.includes("conduct-CONC"))).toBe(true);
      // Every entry parses as `- [date] <id> · KIND: …`.
      for (const e of entries) expect(e).toMatch(/^- \[\d{4}-\d{2}-\d{2}\] \S+ · [A-Z_]+: /);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dedup identity (a-d): different runs both append; same transition once; shared-kind different outcomes both; replayed decisions once", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const w = new ConductLearningWriter(ctx.paths);
      const term = (runId: string, outcome: UnitOutcome, over: Partial<ParentSummary> = {}) =>
        w.write(
          composeUnitLearning({ runId, unitId: "unit-001", title: "T", outcome, rounds: 1, summary: summary(over) }),
          unitLearningDedup({ runId, unitId: "unit-001", outcome }),
        );
      // (a) two DIFFERENT runs, same unit + outcome → BOTH append.
      await term("conduct-A", "accepted", { weightedTotal: 90 });
      await term("conduct-B", "accepted", { weightedTotal: 91 });
      // (b) resume replaying the SAME terminal transition → no duplicate.
      await term("conduct-A", "accepted", { weightedTotal: 90 });
      // (c) two DIFFERENT outcomes for one unit sharing the `note` kind → both append.
      await term("conduct-A", "grade-not-independent", { sameModelGrade: true });
      await term("conduct-A", "inconclusive");
      // (d) replayed pivot/generalize-spec decision (same runId+unitId+decision+round) → no duplicate.
      const pivot = () =>
        w.write(
          composeDecisionLearning({ runId: "conduct-A", unitId: "unit-001", decision: "pivot", round: 2 }),
          ["unit-001 ·", "run conduct-A · pivot @ unit-001 round 2"],
        );
      await pivot();
      await pivot();
      await w.drain();
      const entries = memEntries(ctx);
      expect(entries.filter((e) => e.includes("conduct-A") && e.includes("accepted")).length).toBe(1);
      expect(entries.filter((e) => e.includes("conduct-B") && e.includes("accepted")).length).toBe(1);
      expect(entries.filter((e) => e.includes("conduct-A") && e.includes("grade-not-independent")).length).toBe(1);
      expect(entries.filter((e) => e.includes("conduct-A") && e.includes("inconclusive")).length).toBe(1);
      expect(entries.filter((e) => e.includes("pivot @ unit-001 round 2")).length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("best-effort: one appendLearning rejection mid-queue does NOT poison — a later write still appends (assertion 11)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      let calls = 0;
      const flaky: typeof appendLearning = async (paths, l, caps) => {
        calls += 1;
        if (calls === 1) throw new Error("disk full");
        await appendLearning(paths, l, caps);
      };
      const w = new ConductLearningWriter(ctx.paths, { appendLearningFn: flaky });
      // First write rejects (swallowed); second must still land.
      await w.write(composeUnitLearning({ runId: "r", unitId: "unit-001", title: "T", outcome: "accepted", rounds: 1 }), unitLearningDedup({ runId: "r", unitId: "unit-001", outcome: "accepted" }));
      await w.write(composeUnitLearning({ runId: "r", unitId: "unit-002", title: "T", outcome: "accepted", rounds: 1 }), unitLearningDedup({ runId: "r", unitId: "unit-002", outcome: "accepted" }));
      await w.drain();
      const entries = memEntries(ctx);
      expect(entries.some((e) => e.includes("unit-002"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps: every append routes through appendLearning with DEFAULT_CAPS (assertion 12)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const seen: MemoryCaps[] = [];
      const capture: typeof appendLearning = async (_p, _l, caps) => {
        seen.push(caps!);
      };
      const w = new ConductLearningWriter(ctx.paths, { appendLearningFn: capture });
      await w.write(composeUnitLearning({ runId: "r", unitId: "u", title: "T", outcome: "accepted", rounds: 1 }), ["u ·", "run r · accepted ·"]);
      await w.drain();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual(DEFAULT_CAPS);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────── route coverage (assertion 1) ───────────────────────────────

describe("route coverage — every completion route emits its terminal line (assertion 1)", () => {
  it("(a) deterministic runConduct: accepted → PASSED line", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, weightedTotal: 92 }));
      const res = await runConduct(ctx, OPTS({ concurrency: 1 }), { runRole: runner.runRole, runSessionFn: decomposerFn(1) });
      const entries = memEntries(ctx);
      const line = entries.find((e) => e.includes(res.runId) && e.includes("unit-001"));
      expect(line).toBeDefined();
      expect(line).toContain("· PASSED:");
      expect(line).toContain("accepted");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(d) scheduler-level unit exception → error line (deterministic path)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runner = fakeRunner(({ kind, spec }) => {
        const c = contractAgree(kind, spec);
        if (c) return c;
        throw new Error("kaboom in the build cycle");
      });
      const res = await runConduct(ctx, OPTS({ concurrency: 1 }), { runRole: runner.runRole, runSessionFn: decomposerFn(1) });
      expect(res.state.units[0]!.outcome).toBe("error");
      const line = memEntries(ctx).find((e) => e.includes(res.runId) && e.includes("unit-001"));
      expect(line).toBeDefined();
      expect(line).toContain("error");
      expect(line).toContain("kaboom in the build cycle");
      expect(line).not.toContain("· PASSED:");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(b) hybrid brain: accepted → PASSED; (c) llm brain: accepted → PASSED score n/a", async () => {
    // (b) hybrid.
    const dirH = tmpdir();
    try {
      const ctx = await makeCtx(dirH);
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, weightedTotal: 95 }));
      const res = await runConduct(ctx, AUTO({ concurrency: 1 }), { runRole: runner.runRole, runSessionFn: decomposerFn(1), brain: null });
      const line = memEntries(ctx).find((e) => e.includes(res.runId));
      expect(line).toContain("· PASSED:");
    } finally {
      fs.rmSync(dirH, { recursive: true, force: true });
    }
    // (c) llm: the brain accepts on turn 1 before any evaluator round → score n/a.
    const dirL = tmpdir();
    try {
      const ctx = await makeCtx(dirL);
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, weightedTotal: 80 }));
      const fb = fakeBrain(() => undefined, () => ({ answer: "accept" }));
      const res = await runConduct(ctx, AUTO({ brain: "llm", concurrency: 1 }), { runRole: runner.runRole, runSessionFn: decomposerFn(1), brain: fb.brain });
      const line = memEntries(ctx).find((e) => e.includes(res.runId));
      expect(line).toContain("· PASSED:");
      expect(line).toContain("score n/a");
    } finally {
      fs.rmSync(dirL, { recursive: true, force: true });
    }
  });

  it("(e) resumeConduct completing a pending unit → line", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runId = "conduct-RESUME-MEM";
      seedRun(ctx, runId, { status: "running", brain: "hybrid", units: [{ id: "unit-001", title: "Resumed unit", outcome: "pending", contract: "AGREED", contractAgreed: true }] });
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, weightedTotal: 90 }));
      await resumeConduct(ctx, runId, { surface: "auto" }, { runRole: runner.runRole, brain: null, ensureUnitWorktreeFn: (async (_c, name, src) => ({ dir: `/wt/${name}`, branch: `sparra/${name}`, src, created: false })) as NonNullable<ConductDeps["ensureUnitWorktreeFn"]> });
      const line = memEntries(ctx).find((e) => e.includes(runId) && e.includes("unit-001"));
      expect(line).toBeDefined();
      expect(line).toContain("· PASSED:");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(f) recovered terminal decision (recovered abandon) → line", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runId = "conduct-RECOVER-MEM";
      const parked: DecisionRecord = { seq: 4, unit: "unit-001", kind: "gate-collapse", question: "q", options: ["abandon", "accept-anyway", "retry"], default: "abandon", status: "pending", requestedAt: "2026-07-13T00:00:00.000Z" };
      seedRun(ctx, runId, { status: "running", brain: "hybrid", units: [{ id: "unit-001", title: "Recovered unit", outcome: "error", contract: "AGREED", contractAgreed: true, decisions: [parked] }] });
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, weightedTotal: 90 }));
      const res = await resumeConduct(ctx, runId, { surface: "auto" }, { runRole: runner.runRole, brain: null, now: () => Date.now(), sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 1))), pollMs: 1, ensureUnitWorktreeFn: (async (_c, name, src) => ({ dir: `/wt/${name}`, branch: `sparra/${name}`, src, created: false })) as NonNullable<ConductDeps["ensureUnitWorktreeFn"]> });
      const st = res.status === "resumed" ? res.state : undefined;
      expect(st!.units[0]!.outcome).toBe("abandoned");
      const line = memEntries(ctx).find((e) => e.includes(runId) && e.includes("unit-001"));
      expect(line).toBeDefined();
      expect(line).toContain("abandoned");
      expect(line).not.toContain("· PASSED:");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────── contrast + decisions + noise (assertions 3, 4, 5) ───────────────────────────────

describe("contrast, decisions, noise (assertions 3, 4, 5)", () => {
  it("exhausted with distinct blocking → FAILED line carrying that blocking (assertion 3)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      ctx.config.build.maxRoundsPerItem = 2;
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "fail", sameModelGrade: false, blocking: ["DISTINCT-BLOCK: the parser drops trailing commas"] }));
      const res = await runConduct(ctx, AUTO({ concurrency: 1 }), { runRole: runner.runRole, runSessionFn: decomposerFn(1), brain: null });
      expect(res.state.units[0]!.outcome).toBe("exhausted");
      const line = memEntries(ctx).find((e) => e.includes(res.runId));
      expect(line).toContain("· FAILED:");
      expect(line).not.toContain("· PASSED:");
      expect(line).toContain("DISTINCT-BLOCK: the parser drops trailing commas");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // HYBRID decision call site (`src/conduct/unitRunner.ts` runUnitHybrid): the ACTUAL deterministic
  // pivot + 2nd-pivot generalize-spec branches, driven through the real unit runner (not the composer).
  // NOTE: the llm brain's DRIVE_ACTIONS exposes NO generalize-spec action — generalize-spec can only
  // genuinely occur on the hybrid path (the 2nd-pivot deterministic branch), so this hybrid case is the
  // COMPLETE real-call-site coverage for generalize-spec. (The llm pivot call site is covered below.)
  it("HYBRID pivot decision → PIVOT line; generalize-spec decision → NOTE line with `generalize-spec` marker (assertion 4)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      ctx.config.build.maxRoundsPerItem = 6;
      ctx.config.pivot.N = 2;
      // Always fail → pivots accumulate; the generator role has no escalation → 2nd pivot generalizes.
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "fail", sameModelGrade: false, blocking: ["still broken"] }));
      const res = await runConduct(ctx, AUTO({ concurrency: 1 }), { runRole: runner.runRole, runSessionFn: decomposerFn(1), brain: null });
      const entries = memEntries(ctx);
      const pivotLine = entries.find((e) => e.includes(res.runId) && e.includes("· PIVOT:"));
      expect(pivotLine).toBeDefined();
      const genLine = entries.find((e) => e.includes(res.runId) && e.includes("generalize-spec"));
      expect(genLine).toBeDefined();
      expect(genLine).toContain("· NOTE:");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // LLM decision call site (`src/conduct/unitRunner.ts` runUnitLlm): the ACTUAL `action === "pivot"`
  // branch, exercised by driving the real llm brain through the real unit runner + decision path (not
  // the composer). The brain drives `pivot` every turn; llm mode never auto-accepts a passing verdict,
  // so it pivots each round until the round budget exhausts → each pivot emits a PIVOT line.
  it("LLM pivot decision (real brain-driven llm path) → PIVOT line (assertion 4)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      ctx.config.build.maxRoundsPerItem = 2;
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, weightedTotal: 90 }));
      const fb = fakeBrain(() => undefined, () => ({ answer: "pivot" }));
      const res = await runConduct(ctx, AUTO({ brain: "llm", concurrency: 1 }), { runRole: runner.runRole, runSessionFn: decomposerFn(1), brain: fb.brain });
      // The brain's drive was actually consulted (real llm path), and a PIVOT learning was emitted.
      expect(fb.driveCalls.map((c) => c.round)).toContain(1);
      const pivotLine = memEntries(ctx).find((e) => e.includes(res.runId) && e.includes("· PIVOT:"));
      expect(pivotLine).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("noise negative: a unit that passes without pivot produces EXACTLY 1 memory line (assertion 5)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, weightedTotal: 95 }));
      const res = await runConduct(ctx, AUTO({ concurrency: 1 }), { runRole: runner.runRole, runSessionFn: decomposerFn(1), brain: null });
      const forUnit = memEntries(ctx).filter((e) => e.includes(res.runId) && e.includes("unit-001"));
      expect(forUnit).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("plain revise rounds append nothing extra: a 2-round revise→pass unit still has 1 terminal line + no pivot/revise chatter (assertion 5)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      ctx.config.build.maxRoundsPerItem = 4;
      ctx.config.pivot.N = 3; // fail once → revise (not pivot), then pass
      let round = 0;
      const runner = hybridRunner(() => {
        round += 1;
        return round < 2
          ? summary({ roleKind: "evaluator", verdict: "fail", sameModelGrade: false, blocking: ["once"] })
          : summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, weightedTotal: 90 });
      });
      const res = await runConduct(ctx, AUTO({ concurrency: 1 }), { runRole: runner.runRole, runSessionFn: decomposerFn(1), brain: null });
      expect(res.state.units[0]!.outcome).toBe("accepted");
      const entries = memEntries(ctx).filter((e) => e.includes(res.runId));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toContain("· PASSED:");
      expect(entries.some((e) => e.includes("· PIVOT:"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────── injection effect (assertions 9, 10) ───────────────────────────────

describe("PRIOR LEARNINGS injection effect (assertions 9, 10)", () => {
  it("same-run: unit A's learning appears under PRIOR LEARNINGS in unit B's REAL assembled prompt (concurrency 1)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      // When unit-002's FIRST build role runs, drive the REAL prompt-assembly path in
      // src/build/roleRun.ts (runRole with an injected session that captures the actually-assembled
      // prompt) — NOT a memorySection(readMemory) reimplementation — and record what unit B's prompt
      // carries. By then unit A (concurrency 1, terminal emit awaited) has published its learning.
      let unit2Prompt: string | undefined;
      const runner = fakeRunner(async ({ kind, unit, spec }) => {
        const c = contractAgree(kind, spec);
        if (c) return c;
        if (unit === "unit-002" && unit2Prompt === undefined) {
          const cap = sessionRecorder();
          await runRole({ ctx, roleKind: "generator", brief: "Build unit B.", runSessionFn: cap.fn });
          unit2Prompt = cap.calls[0]!.prompt;
        }
        if (kind === "generator") return summary({ roleKind: "generator", filesChanged: 1 });
        return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, weightedTotal: 90 });
      });
      const res = await runConduct(ctx, AUTO({ concurrency: 1 }), { runRole: runner.runRole, runSessionFn: decomposerFn(2), brain: null });
      expect(unit2Prompt).toBeDefined();
      expect(unit2Prompt).toContain("PRIOR LEARNINGS");
      // unit-001 completed (and its learning was written) before unit-002's roles ran.
      expect(unit2Prompt).toContain(res.runId);
      expect(unit2Prompt).toContain("unit-001");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("future-run: a conduct-written line is assembled into a later run's REAL role prompt under PRIOR LEARNINGS (assertion 10)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      // A conduct line from a PAST run sits in the project's memory.md.
      const w = new ConductLearningWriter(ctx.paths);
      await w.write(composeUnitLearning({ runId: "conduct-PAST", unitId: "unit-007", title: "Prior work", outcome: "accepted", rounds: 2, summary: summary({ weightedTotal: 88 }) }), unitLearningDedup({ runId: "conduct-PAST", unitId: "unit-007", outcome: "accepted" }));
      await w.drain();
      // Drive the REAL prompt-assembly path (runRole → assembled prompt), not readMemory+memorySection.
      const cap = sessionRecorder();
      await runRole({ ctx, roleKind: "generator", brief: "A fresh future item.", runSessionFn: cap.fn });
      const prompt = cap.calls[0]!.prompt;
      expect(prompt).toContain("PRIOR LEARNINGS");
      expect(prompt).toContain("conduct-PAST");
      expect(prompt).toContain("unit-007");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("backward compat (assertion 11)", () => {
  it("conduct against a project with no memory.md → file is created, run completes", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      expect(fs.existsSync(ctx.paths.memory)).toBe(false);
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, weightedTotal: 90 }));
      const res = await runConduct(ctx, OPTS({ concurrency: 1 }), { runRole: runner.runRole, runSessionFn: decomposerFn(1) });
      expect(res.state.status).toBe("completed");
      expect(fs.existsSync(ctx.paths.memory)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
