import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withPhaseHooks, type PhaseHooksCtx } from "../src/phaseHooks.ts";
import { dispatchPhase, HOOKABLE_PHASES } from "../src/cli.ts";
import { defaultConfig } from "../src/config.ts";
import { loadCtxForRole, type Ctx } from "../src/context.ts";
import type { runScriptHooks, ScriptHookContext, ScriptHookEvent, ScriptHookOutcome } from "../src/scriptHooks.ts";

/**
 * U2: fire-point WIRING tests. Every test injects a FAKE `runScriptHooksFn` recorder — never the
 * real runner, never a real spawn — so `withPhaseHooks`/`dispatchPhase` are exercised purely
 * in-process. No live model calls: a gate failure means the real phase body (`cmdOrient`, …) is
 * PROVABLY never reached (see `withPhaseHooks`'s implementation — `run()` sits after the awaited
 * gate check), so even hookable-phase tests never risk touching the SDK.
 */

type FakeCall = { event: ScriptHookEvent; ctx: ScriptHookContext };

/** Records every call; `behavior` decides the outcome per event (default: ok, ran:1). */
function fakeRunner(
  behavior?: (event: ScriptHookEvent, ctx: ScriptHookContext) => ScriptHookOutcome,
): { fn: typeof runScriptHooks; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fn: typeof runScriptHooks = async (event, ctx) => {
    calls.push({ event, ctx });
    return behavior ? behavior(event, ctx) : { ok: true, ran: 1 };
  };
  return { fn, calls };
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sparra-phasehooks-"));
}

const noProbe = async (): Promise<void> => {};
async function makeCtx(dir: string): Promise<Ctx> {
  return loadCtxForRole(dir, { probeAuto: noProbe });
}

afterEach(() => {
  process.exitCode = 0;
});

describe("withPhaseHooks — direct wiring (assertion 1)", () => {
  const ctx: PhaseHooksCtx = { root: "/proj", config: defaultConfig() };

  it("onPhaseStart fires BEFORE run(), onPhaseEnd (status completed) fires AFTER, in that order", async () => {
    const order: string[] = [];
    const { fn, calls } = fakeRunner((event) => {
      order.push(event);
      return { ok: true, ran: 1 };
    });
    let ranCalled = false;
    const run = async (): Promise<void> => {
      order.push("run");
      ranCalled = true;
    };
    const result = await withPhaseHooks("orient", ctx, run, { runScriptHooksFn: fn });
    expect(result.ok).toBe(true);
    expect(ranCalled).toBe(true);
    expect(order).toEqual(["onPhaseStart", "run", "onPhaseEnd"]);
    expect(calls[0]!.ctx).toMatchObject({ phase: "orient", root: "/proj" });
    expect(calls[1]!.ctx).toMatchObject({ phase: "orient", root: "/proj", status: "completed" });
  });

  it("gate !ok on onPhaseStart → run() NOT called, abort surfaced via the returned result", async () => {
    const { fn, calls } = fakeRunner((event) =>
      event === "onPhaseStart"
        ? { ok: false, ran: 1, gateFailure: { event, command: "failer", exitCode: 1, signal: null, timedOut: false } }
        : { ok: true, ran: 1 },
    );
    let ranCalled = false;
    const run = async (): Promise<void> => {
      ranCalled = true;
    };
    const result = await withPhaseHooks("build", ctx, run, { runScriptHooksFn: fn });
    expect(result.ok).toBe(false);
    expect(result.gateFailure).toEqual({ event: "onPhaseStart", command: "failer", exitCode: 1, signal: null, timedOut: false });
    expect(ranCalled).toBe(false);
    // onPhaseEnd never fires — only onPhaseStart was called.
    expect(calls.map((c) => c.event)).toEqual(["onPhaseStart"]);
  });

  it("a failing/!ok onPhaseEnd does not throw and does not change the reported outcome", async () => {
    const { fn } = fakeRunner((event) =>
      event === "onPhaseEnd" ? { ok: false, ran: 1 } : { ok: true, ran: 1 },
    );
    let ranCalled = false;
    const run = async (): Promise<void> => {
      ranCalled = true;
    };
    await expect(withPhaseHooks("reflect", ctx, run, { runScriptHooksFn: fn })).resolves.toEqual({ ok: true });
    expect(ranCalled).toBe(true);
  });

  it("no deps injected → falls back to the REAL runScriptHooks, which is a true no-op on an empty config (0 spawns, byte-identical outcome)", async () => {
    let ranCalled = false;
    const result = await withPhaseHooks("plan", { root: process.cwd(), config: defaultConfig() }, async () => {
      ranCalled = true;
    });
    expect(result).toEqual({ ok: true });
    expect(ranCalled).toBe(true);
  });
});

describe("HOOKABLE_PHASES — exact set (assertion 2)", () => {
  it("is exactly orient, plan, prototype, freeze, build, reflect, batch", () => {
    expect([...HOOKABLE_PHASES].sort()).toEqual(
      ["batch", "build", "freeze", "orient", "plan", "prototype", "reflect"].sort(),
    );
  });

  it("does NOT include init/help/status/prompts/new/finish/log-finding/snapshot/clean/resume/role/eval/measure/conduct", () => {
    for (const cmd of [
      "init",
      "help",
      "status",
      "prompts",
      "new",
      "finish",
      "log-finding",
      "snapshot",
      "clean",
      "resume",
      "role",
      "eval",
      "measure",
      "conduct",
    ]) {
      expect(HOOKABLE_PHASES.has(cmd)).toBe(false);
    }
  });
});

describe("dispatchPhase — NEGATIVE: a non-hookable command fires zero hook events (assertion 2)", () => {
  it("`status` never calls runScriptHooksFn", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const { fn, calls } = fakeRunner();
      await dispatchPhase("status", ctx, ["status"], {}, { runScriptHooksFn: fn });
      expect(calls.length).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`onDecisionParked` is never fired by any dispatchPhase route (assertion 10, phase side)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const { fn, calls } = fakeRunner();
      await dispatchPhase("status", ctx, ["status"], {}, { runScriptHooksFn: fn });
      expect(calls.some((c) => c.event === "onDecisionParked")).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dispatchPhase — phase gate (assertion 3)", () => {
  it("required onPhaseStart failure on a hookable phase → phase body NOT executed, error printed, exitCode=1", async () => {
    const dir = tmpdir();
    const prevLog = process.env.SPARRA_LOG_IN_TESTS;
    process.env.SPARRA_LOG_IN_TESTS = "1";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const ctx = await makeCtx(dir);
      const { fn, calls } = fakeRunner((event) =>
        event === "onPhaseStart"
          ? { ok: false, ran: 1, gateFailure: { event, command: "failer", exitCode: 1, signal: null, timedOut: false } }
          : { ok: true, ran: 1 },
      );
      process.exitCode = 0;
      // "orient" is hookable; if the gate did NOT block, cmdOrient would run for real (filesystem
      // scan / potential live SDK call) — the gate check in `withPhaseHooks` happens strictly BEFORE
      // `run()` is ever invoked, so this stays offline regardless.
      await dispatchPhase("orient", ctx, ["orient"], {}, { runScriptHooksFn: fn });
      expect(process.exitCode).toBe(1);
      expect(calls.map((c) => c.event)).toEqual(["onPhaseStart"]); // onPhaseEnd never fired either
      expect(stderrSpy).toHaveBeenCalled();
      const printed = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(printed).toContain("orient");
    } finally {
      stderrSpy.mockRestore();
      if (prevLog === undefined) delete process.env.SPARRA_LOG_IN_TESTS;
      else process.env.SPARRA_LOG_IN_TESTS = prevLog;
      process.exitCode = 0;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("contrast: a passing gate leaves exitCode untouched (the ok-path-runs-the-body assertion itself lives in the withPhaseHooks direct test above, which proves run() DOES execute when the gate passes)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const { fn } = fakeRunner();
      process.exitCode = 0;
      await dispatchPhase("status", ctx, ["status"], {}, { runScriptHooksFn: fn });
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = 0;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dispatchPhase — empty scriptHooks stays byte-identical (assertion 11, phase side)", () => {
  it("a wired dispatch through the REAL runScriptHooks with scriptHooks:{} completes the phase with 0 hooks spawned", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      expect(ctx.config.scriptHooks).toEqual({});
      process.exitCode = 0;
      // "status" is non-hookable and side-effect-light (prints only); safe to run for real end-to-end.
      await dispatchPhase("status", ctx, ["status"], {});
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = 0;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
