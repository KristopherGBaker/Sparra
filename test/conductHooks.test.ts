import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadCtxForRole, type Ctx } from "../src/context.ts";
import { runConduct, type ConductOptions } from "../src/conduct/run.ts";
import type { ParentSummary, RunRoleSpec } from "../conductors/core/index.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";
import type { runScriptHooks, ScriptHookContext, ScriptHookEvent, ScriptHookOutcome } from "../src/scriptHooks.ts";
import type { Brain, DriveContext } from "../src/conduct/brain.ts";
import type { BrainDecision, DecisionRequest } from "../src/conduct/decision.ts";

/**
 * U2: `runConduct` fire-point WIRING (onRunStart/onRunComplete/onUnitStart/onUnitComplete), and its
 * gate-abort precision. Every test injects `runScriptHooksFn` — a pure in-process recorder — never
 * the real runner, never a real spawn. Follows the `test/conductCore.test.ts` fixture patterns
 * (fakeRunner/decomposerFn/summary/OPTS) so the two suites read consistently.
 */

const noProbe = async (): Promise<void> => {};
function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sparra-conduct-hooks-"));
}
async function makeCtx(dir: string): Promise<Ctx> {
  return loadCtxForRole(dir, { probeAuto: noProbe });
}

function summary(overrides: Partial<ParentSummary>): ParentSummary {
  return { roleKind: "generator", backend: "stub", model: "stub-1", ok: true, errors: [], tokens: 0, costUsd: 0, ...overrides };
}

function decomposerFn(n: number): (p: RunSessionParams) => Promise<RunResult> {
  return async () => {
    const units = Array.from({ length: n }, (_, i) => ({
      id: `unit-${String(i + 1).padStart(3, "0")}`,
      title: `Unit ${i + 1}`,
      summary: `Do thing ${i + 1}.`,
      rationale: "because",
    }));
    return {
      ok: true,
      subtype: "success",
      resultText: "```json\n" + JSON.stringify(units) + "\n```",
      sessionId: "d",
      costUsd: 0,
      tokens: 1,
      numTurns: 1,
      hitMaxTurns: false,
      hitBudget: false,
      errors: [],
      tracePath: "",
    };
  };
}
/** A decomposer that yields ZERO units (drives the "no-units error" terminal return). */
function emptyDecomposerFn(): (p: RunSessionParams) => Promise<RunResult> {
  return async () => ({
    ok: true,
    subtype: "success",
    resultText: "```json\n[]\n```",
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
  calls: RunRoleSpec[];
}
function fakeRunner(handler: (c: { kind: string; unit?: string; spec: RunRoleSpec }) => ParentSummary): FakeRunner {
  const calls: RunRoleSpec[] = [];
  return {
    calls,
    runRole: async (spec: RunRoleSpec) => {
      calls.push(spec);
      const kind = kindOf(spec.args);
      const unit = spec.env?.SPARRA_CONDUCT_UNIT as string | undefined;
      return handler({ kind, unit, spec });
    },
  };
}
/** Contract phase: generator drafts, evaluator AGREES (round 1). Undefined for other kinds. */
function contractAgree(kind: string, spec: RunRoleSpec): ParentSummary | undefined {
  if (kind === "contract-generator") {
    fs.writeFileSync(argVal(spec.args, "--out")!, "C");
    return summary({ roleKind: "contract-generator", outPath: argVal(spec.args, "--out") });
  }
  if (kind === "contract-evaluator") return summary({ roleKind: "contract-evaluator", contractAgreed: true });
  return undefined;
}
/** A hybrid fake runner: agreed contract, then a PASS every round (for brain-path fixtures). */
function passingHybridRunner(): FakeRunner {
  return fakeRunner(({ kind, spec }) => {
    const c = contractAgree(kind, spec);
    if (c) return c;
    if (kind === "generator") return summary({ roleKind: "generator", filesChanged: 1 });
    return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false });
  });
}

function fakeBrain(judgeFn: (r: DecisionRequest) => BrainDecision | undefined): { brain: Brain } {
  return {
    brain: {
      async judge(r) {
        return judgeFn(r);
      },
      async drive(_c: DriveContext) {
        return undefined;
      },
    },
  };
}

const OPTS = (o: Partial<ConductOptions> = {}): ConductOptions => ({
  prompt: "build a thing",
  maxUnits: 4,
  concurrency: 2,
  dryRun: false,
  ...o,
});

/** Records every `runScriptHooks` call; `behavior` decides the outcome per event (default: ok). */
type FakeHookCall = { event: ScriptHookEvent; ctx: ScriptHookContext };
function hookRecorder(
  behavior?: (event: ScriptHookEvent, ctx: ScriptHookContext) => ScriptHookOutcome,
): { fn: typeof runScriptHooks; calls: FakeHookCall[] } {
  const calls: FakeHookCall[] = [];
  const fn: typeof runScriptHooks = async (event, ctx) => {
    calls.push({ event, ctx });
    return behavior ? behavior(event, ctx) : { ok: true, ran: 1 };
  };
  return { fn, calls };
}

describe("runConduct — onRunStart/onRunComplete (assertions 4, 5, 10)", () => {
  it("assertion 4: normal run fires onRunStart ONCE before decompose, then onRunComplete status:completed", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runner = passingHybridRunner();
      const order: string[] = [];
      const { fn, calls } = hookRecorder((event) => {
        order.push(event);
        return { ok: true, ran: 1 };
      });
      const decomposer = decomposerFn(1);
      const trackedDecomposer: typeof decomposer = async (p) => {
        order.push("decompose");
        return decomposer(p);
      };
      const res = await runConduct(ctx, OPTS(), {
        runRole: runner.runRole,
        runSessionFn: trackedDecomposer,
        runScriptHooksFn: fn,
      });
      expect(res.state.status).toBe("completed");
      const runStartCalls = calls.filter((c) => c.event === "onRunStart");
      expect(runStartCalls).toHaveLength(1);
      expect(runStartCalls[0]!.ctx).toMatchObject({ runId: res.runId, runDir: res.runDir });
      expect(order[0]).toBe("onRunStart");
      expect(order.indexOf("onRunStart")).toBeLessThan(order.indexOf("decompose"));
      const runCompleteCalls = calls.filter((c) => c.event === "onRunComplete");
      expect(runCompleteCalls).toHaveLength(1);
      expect(runCompleteCalls[0]!.ctx).toMatchObject({ runId: res.runId, runDir: res.runDir, status: "completed" });
      // onDecisionParked is OUT of scope for this unit — never fired by any seam.
      expect(calls.some((c) => c.event === "onDecisionParked")).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 5: --dry-run fires onRunStart then onRunComplete status:dry-run", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const { fn, calls } = hookRecorder();
      let roleCalls = 0;
      const res = await runConduct(ctx, OPTS({ dryRun: true }), {
        runRole: async () => {
          roleCalls++;
          return summary({});
        },
        runSessionFn: decomposerFn(2),
        runScriptHooksFn: fn,
      });
      expect(roleCalls).toBe(0);
      expect(res.state.status).toBe("dry-run");
      expect(calls.filter((c) => c.event === "onRunStart")).toHaveLength(1);
      const complete = calls.filter((c) => c.event === "onRunComplete");
      expect(complete).toHaveLength(1);
      expect(complete[0]!.ctx.status).toBe("dry-run");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 5: no-units decompose fires onRunComplete status:error (third CONTRASTING terminal return)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const { fn, calls } = hookRecorder();
      const res = await runConduct(ctx, OPTS(), {
        runRole: async () => summary({}),
        runSessionFn: emptyDecomposerFn(),
        runScriptHooksFn: fn,
      });
      expect(res.state.status).toBe("error");
      expect(calls.filter((c) => c.event === "onRunStart")).toHaveLength(1);
      const complete = calls.filter((c) => c.event === "onRunComplete");
      expect(complete).toHaveLength(1);
      expect(complete[0]!.ctx.status).toBe("error");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runConduct — onRunStart gate (assertion 6)", () => {
  it("required onRunStart failure → early return, persisted run.json status:error, decompose/units never run", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      let decomposeCalls = 0;
      let roleCalls = 0;
      const { fn, calls } = hookRecorder((event) =>
        event === "onRunStart"
          ? { ok: false, ran: 1, gateFailure: { event, command: "failer", exitCode: 1, signal: null, timedOut: false } }
          : { ok: true, ran: 1 },
      );
      const res = await runConduct(ctx, OPTS(), {
        runRole: async () => {
          roleCalls++;
          return summary({});
        },
        runSessionFn: async (p) => {
          decomposeCalls++;
          return decomposerFn(1)(p);
        },
        runScriptHooksFn: fn,
      });
      expect(res.state.status).toBe("error");
      expect(decomposeCalls).toBe(0);
      expect(roleCalls).toBe(0);
      expect(res.state.units).toHaveLength(0); // decompose never even ran — no unit entries seeded
      // onRunComplete is NOT fired on an onRunStart gate failure (the run never truly started).
      expect(calls.some((c) => c.event === "onRunComplete")).toBe(false);
      // Persisted to disk, not just in-memory.
      const rj = JSON.parse(fs.readFileSync(path.join(res.runDir, "run.json"), "utf8"));
      expect(rj.status).toBe("error");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runConduct — deterministic path per-unit hooks (assertion 7)", () => {
  it("2 units: onUnitStart then onUnitComplete fire per unit with correct id; ordering start-before-complete; status reflects DIFFERENT real terminal outcomes", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      // unit-002's contract-generator THROWS → that unit rejects → runUnitsConcurrently reports it
      // as an `{id, error}` result → outcome "error" (contrasts unit-001's "accepted").
      const runner = fakeRunner(({ kind, unit, spec }) => {
        if (unit === "unit-002" && kind === "contract-generator") {
          throw new Error("boom");
        }
        const c = contractAgree(kind, spec);
        if (c) return c;
        if (kind === "generator") return summary({ roleKind: "generator", filesChanged: 1 });
        return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false });
      });
      const { fn, calls } = hookRecorder();
      const res = await runConduct(ctx, OPTS({ concurrency: 2 }), {
        runRole: runner.runRole,
        runSessionFn: decomposerFn(2),
        runScriptHooksFn: fn,
      });
      const a = res.state.units.find((u) => u.id === "unit-001")!;
      const b = res.state.units.find((u) => u.id === "unit-002")!;
      expect(a.outcome).toBe("accepted");
      expect(b.outcome).toBe("error");
      expect(a.outcome).not.toBe(b.outcome); // genuinely DIFFERENT outcomes, not a constant

      const startEvents = calls.filter((c) => c.event === "onUnitStart");
      const completeEvents = calls.filter((c) => c.event === "onUnitComplete");
      expect(startEvents.map((c) => c.ctx.unit).sort()).toEqual(["unit-001", "unit-002"]);
      expect(completeEvents.map((c) => c.ctx.unit).sort()).toEqual(["unit-001", "unit-002"]);
      // status on completion matches the REAL terminal outcome for each unit.
      const completeByUnit = new Map(completeEvents.map((c) => [c.ctx.unit, c.ctx.status]));
      expect(completeByUnit.get("unit-001")).toBe("accepted");
      expect(completeByUnit.get("unit-002")).toBe("error");

      // Per-unit ordering: start strictly before complete for EACH unit (index within the full call log).
      const idx = (event: ScriptHookEvent, unit: string) => calls.findIndex((c) => c.event === event && c.ctx.unit === unit);
      expect(idx("onUnitStart", "unit-001")).toBeLessThan(idx("onUnitComplete", "unit-001"));
      expect(idx("onUnitStart", "unit-002")).toBeLessThan(idx("onUnitComplete", "unit-002"));

      // The deterministic path fires ALL onUnitStart calls up front (before the batch), so BOTH
      // onUnitStart events precede BOTH onUnitComplete events.
      const lastStart = Math.max(idx("onUnitStart", "unit-001"), idx("onUnitStart", "unit-002"));
      const firstComplete = Math.min(idx("onUnitComplete", "unit-001"), idx("onUnitComplete", "unit-002"));
      expect(lastStart).toBeLessThan(firstComplete);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runConduct — onUnitStart gate terminal path (assertion 8)", () => {
  it("required onUnitStart failure aborts the run immediately: persisted status:error, offending unit error, onRunComplete fired ONCE with status:error, unit batch never runs, never reaches completed", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      let roleCalls = 0;
      const { fn, calls } = hookRecorder((event) =>
        event === "onUnitStart"
          ? { ok: false, ran: 1, gateFailure: { event, command: "guard", exitCode: 3, signal: null, timedOut: false } }
          : { ok: true, ran: 1 },
      );
      const res = await runConduct(ctx, OPTS({ concurrency: 2 }), {
        runRole: async () => {
          roleCalls++;
          return summary({});
        },
        runSessionFn: decomposerFn(2),
        runScriptHooksFn: fn,
      });
      expect(res.state.status).toBe("error");
      expect(res.state.status).not.toBe("completed");
      expect(roleCalls).toBe(0); // the unit batch (runUnitsConcurrently) never ran
      const offending = res.state.units.find((u) => u.id === "unit-001")!;
      expect(offending.outcome).toBe("error");
      const runCompleteCalls = calls.filter((c) => c.event === "onRunComplete");
      expect(runCompleteCalls).toHaveLength(1); // fired EXACTLY once
      expect(runCompleteCalls[0]!.ctx.status).toBe("error");
      // Persisted, not just in-memory.
      const rj = JSON.parse(fs.readFileSync(path.join(res.runDir, "run.json"), "utf8"));
      expect(rj.status).toBe("error");
      expect(rj.status).not.toBe("completed");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runConduct — brain path per-unit hooks (assertion 9)", () => {
  it("brain-mode (hybrid) run fires onUnitStart/onUnitComplete for its unit", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runner = passingHybridRunner();
      const fb = fakeBrain(() => undefined); // never consulted for a clean pass — deterministic policy wins
      const { fn, calls } = hookRecorder();
      const res = await runConduct(ctx, OPTS({ brain: "hybrid", surface: "auto", timeoutSec: 30 }), {
        runRole: runner.runRole,
        runSessionFn: decomposerFn(1),
        brain: fb.brain,
        runScriptHooksFn: fn,
      });
      expect(res.state.units[0]!.outcome).toBe("accepted");
      const startEvents = calls.filter((c) => c.event === "onUnitStart");
      const completeEvents = calls.filter((c) => c.event === "onUnitComplete");
      expect(startEvents.map((c) => c.ctx.unit)).toEqual(["unit-001"]);
      expect(completeEvents.map((c) => c.ctx.unit)).toEqual(["unit-001"]);
      expect(completeEvents[0]!.ctx.status).toBe("accepted");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("required onUnitStart gate failure in brain mode marks the unit error and aborts the run (persisted, never completed)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runner = passingHybridRunner();
      const fb = fakeBrain(() => undefined);
      const { fn, calls } = hookRecorder((event) =>
        event === "onUnitStart"
          ? { ok: false, ran: 1, gateFailure: { event, command: "guard", exitCode: 2, signal: null, timedOut: false } }
          : { ok: true, ran: 1 },
      );
      const res = await runConduct(ctx, OPTS({ brain: "hybrid", surface: "auto", timeoutSec: 30 }), {
        runRole: runner.runRole,
        runSessionFn: decomposerFn(1),
        brain: fb.brain,
        runScriptHooksFn: fn,
      });
      expect(res.state.status).toBe("error");
      expect(res.state.status).not.toBe("completed");
      expect(res.state.units[0]!.outcome).toBe("error");
      // The unit never entered the build cycle — no contract/generator/evaluator role-run happened.
      expect(runner.calls).toHaveLength(0);
      expect(calls.filter((c) => c.event === "onUnitComplete")).toHaveLength(0);
      expect(calls.filter((c) => c.event === "onRunComplete")).toHaveLength(1);
      const rj = JSON.parse(fs.readFileSync(path.join(res.runDir, "run.json"), "utf8"));
      expect(rj.status).toBe("error");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runConduct — empty scriptHooks stays byte-identical (assertion 11)", () => {
  it("default config (scriptHooks: {}) through the REAL runScriptHooks completes exactly as before — no deps override needed", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      expect(ctx.config.scriptHooks).toEqual({});
      const runner = passingHybridRunner();
      // No `runScriptHooksFn` injected — the REAL runner is used, and a config-less `scriptHooks: {}`
      // is a strict no-op per U1 (0 spawns, `ran: 0`), so this must complete identically to the
      // pre-U2 behavior asserted throughout `conductCore.test.ts`.
      const res = await runConduct(ctx, OPTS(), { runRole: runner.runRole, runSessionFn: decomposerFn(1) });
      expect(res.state.status).toBe("completed");
      expect(res.state.units[0]!.outcome).toBe("accepted");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
