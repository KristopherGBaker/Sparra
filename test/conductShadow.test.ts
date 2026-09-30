import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadCtxForRole, type Ctx } from "../src/context.ts";
import { defaultConfig, loadConfig } from "../src/config.ts";
import { runConduct, resumeConduct, type ConductDeps, type ConductOptions } from "../src/conduct/run.ts";
import { conductRunDir, runStatePath } from "../src/conduct/runState.ts";
import type { ConductRunState, UnitOutcome, UnitStateEntry } from "../src/conduct/types.ts";
import {
  buildDecisionRequest,
  JUDGMENT_OPTIONS,
  type DecisionRecord,
  type DecisionRequest,
  type JudgmentKind,
} from "../src/conduct/decision.ts";
import { resolveDecision, type DecisionEngineDeps } from "../src/conduct/decisionEngine.ts";
import {
  createShadowJudge,
  normalizeShadowJudgeConfig,
  parseShadowVerdict,
  SHADOW_OPTION_DESCRIPTIONS,
  shadowEngineDeps,
  type ShadowClient,
  type ShadowClientFactory,
  type ShadowJudge,
  type ShadowVerdict,
} from "../src/conduct/shadowJudge.ts";
import type { EnsureUnitWorktreeResult } from "../src/build/unitWorktree.ts";
import type { ParentSummary, RunRoleSpec } from "../conductors/core/index.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

/**
 * Shadow-mode Jev judgment on `sparra conduct` decisions. All offline: fake Jev clients / judges,
 * injected clocks + sleeps (no real timers), temp dirs, fake git seams — no network, no live model.
 */

const noProbe = async (): Promise<void> => {};
function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sparra-shadow-"));
}
async function makeCtx(dir: string): Promise<Ctx> {
  return loadCtxForRole(dir, { probeAuto: noProbe });
}
function summary(o: Partial<ParentSummary>): ParentSummary {
  return { roleKind: "generator", backend: "stub", model: "stub-1", ok: true, errors: [], tokens: 0, costUsd: 0, ...o };
}

/** Capture stdout lines (the logger is silenced under vitest unless SPARRA_LOG_IN_TESTS is set). */
function captureLog(): { lines: () => string[]; restore: () => void } {
  const prior = process.env.SPARRA_LOG_IN_TESTS;
  process.env.SPARRA_LOG_IN_TESTS = "1";
  let buf = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
  return {
    lines: () => buf.split("\n").filter(Boolean),
    restore: () => {
      spy.mockRestore();
      if (prior === undefined) delete process.env.SPARRA_LOG_IN_TESTS;
      else process.env.SPARRA_LOG_IN_TESTS = prior;
    },
  };
}
const shadowWarns = (lines: string[]): string[] => lines.filter((l) => /shadowJudge/i.test(l));

/** A well-formed Choice answer over `options` (first option wins by default). */
function goodAnswer(options: string[], over: Record<string, unknown> = {}): Record<string, unknown> {
  const probabilities = Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.7 : 0.3 / Math.max(1, options.length - 1)]));
  return { type: "choice", choice: options[0], probabilities, confidence: 0.8, ...over };
}
const wrap = (decision: unknown): unknown => ({ model: "jev-test", answers: { decision }, usage: { input_tokens: 1, output_tokens: 1 } });

interface FakeClient {
  client: ShadowClient;
  calls: Array<Parameters<ShadowClient["systemOne"]>[0]>;
}
function fakeClient(respond: (req: Parameters<ShadowClient["systemOne"]>[0]) => unknown | Promise<unknown>): FakeClient {
  const calls: FakeClient["calls"] = [];
  return {
    calls,
    client: {
      systemOne: async (req) => {
        calls.push(req);
        return respond(req);
      },
    },
  };
}
function recordingFactory(fc: FakeClient): { factory: ShadowClientFactory; inits: Array<{ apiKey: string; model: string }> } {
  const inits: Array<{ apiKey: string; model: string }> = [];
  return {
    inits,
    factory: (init) => {
      inits.push(init);
      return fc.client;
    },
  };
}

const KEY_ENV = "SPARRA_TEST_TS_KEY";
const SECRET = "sk-test-secret-value-123";
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const prior: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prior[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of Object.keys(vars)) {
        if (prior[k] === undefined) delete process.env[k];
        else process.env[k] = prior[k];
      }
    });
}

function req(kind: JudgmentKind = "unit-exhausted", over: Partial<Parameters<typeof buildDecisionRequest>[0]> = {}): DecisionRequest {
  return buildDecisionRequest({
    seq: 1,
    unit: "unit-001",
    kind,
    nowMs: 0,
    timeoutSec: 10,
    summary: summary({ verdict: "fail", weightedTotal: 61 }),
    passThreshold: 80,
    ...over,
  });
}

/** A ShadowJudge over a plain function (engine/run-level tests). */
function fakeShadow(
  judge: (r: DecisionRequest) => Promise<ShadowVerdict>,
  over: Partial<ShadowJudge> = {},
): ShadowJudge & { failures: string[] } {
  const failures: string[] = [];
  return { model: "jev-test", timeoutMs: 5000, judge, noteFailure: (e) => failures.push(e), failures, ...over };
}
const verdictFor = (r: DecisionRequest, choice = r.options[r.options.length - 1]!): ShadowVerdict => ({
  choice,
  probabilities: Object.fromEntries(r.options.map((o) => [o, o === choice ? 0.9 : 0.1 / Math.max(1, r.options.length - 1)])),
  confidence: 0.95,
});

/** A clock + sleep pair: `sleep(ms)` advances the clock and resolves (never a real timer). */
function fakeClock(): { nowMs: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  let t = 0;
  const sleeps: number[] = [];
  return {
    nowMs: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}
const NEVER = (): Promise<never> => new Promise<never>(() => undefined);

// ───────────────────────── A9 config ─────────────────────────

describe("conduct.shadowJudge config (A9)", () => {
  it("defaultConfig ships the disabled block", () => {
    expect(defaultConfig().conduct.shadowJudge).toEqual({
      enabled: false,
      model: "jev-1.13.0",
      apiKeyEnv: "TYPESAFE_API_KEY",
      timeoutMs: 5000,
    });
  });

  it("a config without the block deep-merges to the defaults; a partial block keeps unspecified defaults", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      fs.mkdirSync(path.dirname(ctx.paths.config), { recursive: true });
      fs.writeFileSync(ctx.paths.config, "conduct:\n  brain: llm\n");
      const cfg = await loadConfig(ctx.paths);
      expect(cfg.conduct.brain).toBe("llm");
      expect(cfg.conduct.shadowJudge).toEqual(defaultConfig().conduct.shadowJudge);

      fs.writeFileSync(ctx.paths.config, "conduct:\n  shadowJudge:\n    enabled: true\n    timeoutMs: 1234\n");
      const cfg2 = await loadConfig(ctx.paths);
      expect(cfg2.conduct.shadowJudge).toEqual({ ...defaultConfig().conduct.shadowJudge, enabled: true, timeoutMs: 1234 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invalid values normalize to defaults with exactly ONE warn; valid values pass through with none", () => {
    const def = defaultConfig().conduct.shadowJudge;
    for (const bad of [0, -5, 1.5, "5000", NaN, null]) {
      const cap = captureLog();
      try {
        const out = normalizeShadowJudgeConfig({ enabled: true, timeoutMs: bad as never });
        expect(out.timeoutMs, String(bad)).toBe(def.timeoutMs);
        expect(shadowWarns(cap.lines()), String(bad)).toHaveLength(1);
      } finally {
        cap.restore();
      }
    }
    const cap = captureLog();
    try {
      const out = normalizeShadowJudgeConfig({ enabled: true, model: "", apiKeyEnv: 7 as never, timeoutMs: 0 });
      expect(out).toEqual({ ...def, enabled: true });
      expect(shadowWarns(cap.lines())).toHaveLength(1); // several bad values → still one warn
      cap.restore();
      const cap2 = captureLog();
      const ok = normalizeShadowJudgeConfig({ enabled: true, model: "jev-x", apiKeyEnv: "K", timeoutMs: 1 });
      expect(ok).toEqual({ enabled: true, model: "jev-x", apiKeyEnv: "K", timeoutMs: 1 });
      expect(shadowWarns(cap2.lines())).toHaveLength(0);
      cap2.restore();
    } finally {
      cap.restore();
    }
  });
});

// ───────────────────────── A3 request shape + A10 holdout wall ─────────────────────────

describe("shadow request shape (A3) + holdout wall (A10)", () => {
  it("the static description table covers EVERY option of EVERY judgment kind (non-empty, one sentence)", () => {
    for (const kind of Object.keys(JUDGMENT_OPTIONS) as JudgmentKind[]) {
      const table = SHADOW_OPTION_DESCRIPTIONS[kind];
      expect(table, kind).toBeDefined();
      for (const option of JUDGMENT_OPTIONS[kind].options) {
        expect(table![option]?.trim().length ?? 0, `${kind}/${option}`).toBeGreaterThan(0);
      }
      // No stale extras either: the table's keys are exactly the kind's options.
      expect(Object.keys(table!).sort(), kind).toEqual([...JUDGMENT_OPTIONS[kind].options].sort());
    }
  });

  it("one decision → exactly ONE systemOne call: state {kind, question, context}, one Choice keyed by the options, configured model", async () => {
    const fc = fakeClient((r) => wrap(goodAnswer(Object.keys((r.questions.decision as { criteria: object }).criteria))));
    const { factory, inits } = recordingFactory(fc);
    await withEnv({ [KEY_ENV]: SECRET }, async () => {
      const judge = createShadowJudge({ enabled: true, model: "jev-custom", apiKeyEnv: KEY_ENV, timeoutMs: 100 }, factory)!;
      for (const kind of Object.keys(JUDGMENT_OPTIONS) as JudgmentKind[]) {
        fc.calls.length = 0;
        const r = req(kind);
        const v = await judge.judge(r);
        expect(fc.calls, kind).toHaveLength(1);
        const call = fc.calls[0]!;
        expect(Object.keys(call.state).sort()).toEqual(["context", "kind", "question"]);
        expect(call.state).toEqual({ kind: r.kind, question: r.question, context: r.context ?? {} });
        expect(Object.keys(call.questions)).toHaveLength(1);
        const q = call.questions.decision as unknown as { type: string; criteria: Record<string, string> };
        expect(q.type).toBe("choice");
        expect(Object.keys(q.criteria)).toEqual(r.options);
        for (const d of Object.values(q.criteria)) expect(d.length).toBeGreaterThan(0);
        expect(call.model).toBe("jev-custom");
        expect(v.choice).toBe(r.options[0]);
      }
      expect(inits).toEqual([{ apiKey: SECRET, model: "jev-custom" }]);
    });
  });

  it("context is {} when the request has none", async () => {
    const fc = fakeClient((r) => wrap(goodAnswer(Object.keys((r.questions.decision as { criteria: object }).criteria))));
    await withEnv({ [KEY_ENV]: SECRET }, async () => {
      const judge = createShadowJudge({ enabled: true, apiKeyEnv: KEY_ENV }, recordingFactory(fc).factory)!;
      const r = buildDecisionRequest({ seq: 1, unit: "u", kind: "land-blocked", nowMs: 0, timeoutSec: 1 });
      expect(r.context).toBeUndefined();
      await judge.judge(r);
      expect(fc.calls[0]!.state.context).toEqual({});
    });
  });

  it("holdout wall: a request built from a ParentSummary yields a serialized shadow request with ONLY kind/question/context — nothing else leaks", async () => {
    const CANARY = "HOLDOUT-CANARY-DO-NOT-LEAK";
    // A ParentSummary carrying fields a leak would come from (evidence-like strings, paths, blocking text).
    const leaky = summary({
      verdict: "fail",
      weightedTotal: 55,
      blocking: [CANARY],
      outPath: `/x/${CANARY}/verdict.md`,
      failedAssertions: [{ id: 4, title: CANARY }] as never,
      filesChanged: 3,
    });
    const r = buildDecisionRequest({ seq: 2, unit: "unit-009", kind: "contract-defect", nowMs: 0, timeoutSec: 5, summary: leaky, passThreshold: 80 });
    const fc = fakeClient((q) => wrap(goodAnswer(Object.keys((q.questions.decision as { criteria: object }).criteria))));
    await withEnv({ [KEY_ENV]: SECRET }, async () => {
      const judge = createShadowJudge({ enabled: true, apiKeyEnv: KEY_ENV }, recordingFactory(fc).factory)!;
      await judge.judge(r);
    });
    const sent = fc.calls[0]!;
    expect(Object.keys(sent.state).sort()).toEqual(["context", "kind", "question"]);
    const wire = JSON.stringify(sent);
    expect(wire).not.toContain(CANARY);
    expect(wire).not.toContain(r.id); // id / unit / seq / expiresAt / default are never sent
    expect(wire).not.toContain(r.expiresAt);
    expect(wire).not.toContain(SECRET);
    for (const v of Object.values(sent.state.context)) expect(["string", "number", "boolean"].includes(typeof v) || v === null).toBe(true);
  });
});

// ───────────────────────── A6 validation ─────────────────────────

describe("shadow response validation (A6)", () => {
  const options = ["finalize", "revise-brief", "abandon"];
  const good = (): Record<string, unknown> => goodAnswer(options);

  async function judgeWith(response: unknown | Error | (() => Promise<unknown>), r = req("contract-nonconvergence")) {
    const fc = fakeClient(async () => {
      if (typeof response === "function") return (response as () => Promise<unknown>)();
      if (response instanceof Error) throw response;
      return response;
    });
    return withEnv({ [KEY_ENV]: SECRET }, async () => {
      const shadow = createShadowJudge({ enabled: true, apiKeyEnv: KEY_ENV }, recordingFactory(fc).factory)!;
      const clock = fakeClock();
      return resolveDecision(r, { surface: "auto", runDir: "/nonexistent", nowMs: clock.nowMs, sleep: clock.sleep, ...shadowEngineDeps(shadow) });
    });
  }

  const cases: Array<[string, unknown]> = [
    ["missing choice", wrap({ ...good(), choice: undefined })],
    ["choice not in options", wrap({ ...good(), choice: "explode" })],
    ["non-string choice", wrap({ ...good(), choice: 3 })],
    ["missing probabilities", wrap({ ...good(), probabilities: undefined })],
    ["probabilities not an object (string)", wrap({ ...good(), probabilities: "0.5" })],
    ["probabilities is an array", wrap({ ...good(), probabilities: [0.3, 0.3, 0.4] })],
    ["probabilities null", wrap({ ...good(), probabilities: null })],
    ["missing option key", wrap({ ...good(), probabilities: { finalize: 0.5, "revise-brief": 0.5 } })],
    ["extra key", wrap({ ...good(), probabilities: { finalize: 0.4, "revise-brief": 0.3, abandon: 0.2, bogus: 0.1 } })],
    ["swapped-in wrong key (same count)", wrap({ ...good(), probabilities: { finalize: 0.4, "revise-brief": 0.3, bogus: 0.3 } })],
    ["NaN probability", wrap({ ...good(), probabilities: { finalize: NaN, "revise-brief": 0.3, abandon: 0.3 } })],
    ["string probability", wrap({ ...good(), probabilities: { finalize: "0.5", "revise-brief": 0.3, abandon: 0.2 } })],
    ["probability 1.2", wrap({ ...good(), probabilities: { finalize: 1.2, "revise-brief": 0, abandon: 0 } })],
    ["negative probability", wrap({ ...good(), probabilities: { finalize: -0.1, "revise-brief": 0.6, abandon: 0.5 } })],
    ["Infinity probability", wrap({ ...good(), probabilities: { finalize: Infinity, "revise-brief": 0, abandon: 0 } })],
    ["missing confidence", wrap({ ...good(), confidence: undefined })],
    ["NaN confidence", wrap({ ...good(), confidence: NaN })],
    ["string confidence", wrap({ ...good(), confidence: "0.9" })],
    ["confidence -0.1", wrap({ ...good(), confidence: -0.1 })],
    ["confidence 1.01", wrap({ ...good(), confidence: 1.01 })],
    ["no answer at all", wrap(undefined)],
    ["null response", null],
    ["no answers key", { model: "x" }],
  ];
  for (const [label, response] of cases) {
    it(`invalid-response: ${label}`, async () => {
      const res = await judgeWith(response);
      expect(res.shadow).toEqual({ model: "jev-1.13.0", error: "invalid-response" });
      expect(res.shadow).not.toHaveProperty("choice");
      expect(res.answer).toBe("finalize"); // the decision itself is untouched
    });
  }

  it("boundary values: probabilities of exactly 0 and 1 with confidence 1 are VALID", async () => {
    const res = await judgeWith(wrap({ type: "choice", choice: "abandon", probabilities: { finalize: 0, "revise-brief": 0, abandon: 1 }, confidence: 1 }));
    expect(res.shadow).toEqual({
      model: "jev-1.13.0",
      choice: "abandon",
      probabilities: { finalize: 0, "revise-brief": 0, abandon: 1 },
      confidence: 1,
      agreed: false,
    });
    const zero = await judgeWith(wrap({ type: "choice", choice: "finalize", probabilities: { finalize: 1, "revise-brief": 0, abandon: 0 }, confidence: 0 }));
    expect(zero.shadow?.error).toBeUndefined();
    expect(zero.shadow?.agreed).toBe(true); // finalize is the deterministic default answer
  });

  it("a rejected promise → request-failed (never throws)", async () => {
    const res = await judgeWith(new Error("HTTP 500 boom"));
    expect(res.shadow).toEqual({ model: "jev-1.13.0", error: "request-failed" });
    expect(JSON.stringify(res.shadow)).not.toContain("boom"); // error text never persisted
  });

  it("parseShadowVerdict is pure + strict about prototype-ish keys", () => {
    expect(() => parseShadowVerdict(["a", "b"], wrap({ choice: "a", probabilities: Object.create({ a: 0.5, b: 0.5 }), confidence: 0.5 }))).toThrow();
    expect(parseShadowVerdict(["a", "b"], wrap({ choice: "a", probabilities: { a: 0.5, b: 0.5 }, confidence: 0.5 })).choice).toBe("a");
  });
});

// ───────────────────────── A4 never changes the decision + A5 never delays ─────────────────────────

describe("engine seam — shadow never changes or delays a decision (A4/A5)", () => {
  const disagree = (r: DecisionRequest): Promise<ShadowVerdict> =>
    Promise.resolve({ ...verdictFor(r, "abandon"), confidence: 1 });

  it("auto + brain: identical answer/source/via/rationale vs no shadow; agreed reflects choice === answer", async () => {
    const r = req("unit-exhausted");
    const clock = fakeClock();
    const base: DecisionEngineDeps = {
      surface: "auto",
      runDir: "/nonexistent",
      nowMs: clock.nowMs,
      sleep: clock.sleep,
      brainJudge: async () => ({ answer: "generalize-spec", rationale: "brain says" }),
    };
    const plain = await resolveDecision(r, base);
    expect(plain).not.toHaveProperty("shadow");
    const withShadow = await resolveDecision(r, { ...base, ...shadowEngineDeps(fakeShadow(disagree)) });
    const { shadow, ...rest } = withShadow;
    expect(rest).toEqual(plain);
    expect(shadow).toMatchObject({ model: "jev-test", choice: "abandon", confidence: 1, agreed: false });
    // agreement
    const agreeing = await resolveDecision(r, {
      ...base,
      ...shadowEngineDeps(fakeShadow(async (q) => verdictFor(q, "generalize-spec"))),
    });
    expect(agreeing.shadow?.agreed).toBe(true);
    expect(agreeing.answer).toBe("generalize-spec");
  });

  it("auto WITHOUT a brain: deterministic default untouched (also brain-fallback path)", async () => {
    const r = req("gate-collapse");
    const clock = fakeClock();
    const base: DecisionEngineDeps = { surface: "auto", runDir: "/nonexistent", nowMs: clock.nowMs, sleep: clock.sleep };
    const plain = await resolveDecision(r, base);
    const shadowed = await resolveDecision(r, { ...base, ...shadowEngineDeps(fakeShadow(disagree)) });
    expect({ ...shadowed, shadow: undefined }).toEqual({ ...plain, shadow: undefined });
    expect(shadowed.answer).toBe("abandon");
    expect(shadowed.shadow?.agreed).toBe(true); // Jev happened to choose abandon too

    const fallbackBase = { ...base, brainJudge: async () => undefined };
    const plainFb = await resolveDecision(r, fallbackBase);
    const shadowedFb = await resolveDecision(r, { ...fallbackBase, ...shadowEngineDeps(fakeShadow(async (q) => verdictFor(q, "retry"))) });
    expect(shadowedFb.source).toBe("brain-fallback");
    expect({ ...shadowedFb, shadow: undefined }).toEqual({ ...plainFb, shadow: undefined });
    expect(shadowedFb.shadow?.agreed).toBe(false);
  });

  it("park (file answer): identical resolution vs no shadow; shadow recorded", async () => {
    const dir = tmpdir();
    try {
      const r = req("unit-exhausted");
      const run = async (withShadow: boolean, sub: string) => {
        const runDir = path.join(dir, sub);
        fs.mkdirSync(path.join(runDir, "decisions"), { recursive: true });
        fs.writeFileSync(path.join(runDir, "decisions", `${r.seq}.decision.json`), JSON.stringify({ answer: "pivot", note: "human" }));
        const clock = fakeClock();
        return resolveDecision(r, {
          surface: "park",
          runDir,
          nowMs: clock.nowMs,
          sleep: clock.sleep,
          pollMs: 0,
          ...(withShadow ? shadowEngineDeps(fakeShadow(disagree)) : {}),
        });
      };
      const plain = await run(false, "a");
      const shadowed = await run(true, "b");
      expect({ ...shadowed, shadow: undefined }).toEqual({ ...plain, shadow: undefined });
      expect(shadowed).toMatchObject({ answer: "pivot", source: "file", via: "park", note: "human" });
      expect(shadowed.shadow).toMatchObject({ choice: "abandon", agreed: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("park-timeout + TTY paths are unchanged too (tty answer wins; timeout → brain)", async () => {
    const dir = tmpdir();
    try {
      const r = req("borderline-accept");
      const clock = fakeClock();
      let cancelled = 0;
      const tty = { question: async () => "revise", cancel: () => void cancelled++ };
      const viaTty = await resolveDecision(r, {
        surface: "park",
        runDir: path.join(dir, "t"),
        nowMs: clock.nowMs,
        sleep: clock.sleep,
        pollMs: 0,
        tty,
        ...shadowEngineDeps(fakeShadow(disagree)),
      });
      expect(viaTty).toMatchObject({ answer: "revise", source: "tty", via: "park" });
      expect(viaTty.shadow?.choice).toBe("abandon");

      const viaTimeout = await resolveDecision(r, {
        surface: "park-timeout",
        runDir: path.join(dir, "u"),
        nowMs: clock.nowMs,
        sleep: clock.sleep,
        pollMs: 1000,
        brainJudge: async () => ({ answer: "abandon", rationale: "r" }),
        ...shadowEngineDeps(fakeShadow(disagree)),
      });
      expect(viaTimeout).toMatchObject({ answer: "abandon", source: "brain", via: "timeout", rationale: "r" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CONCURRENT: the shadow is started before the brain / before the park request is written, and never awaited by them", async () => {
    const order: string[] = [];
    const r = req("unit-exhausted");
    const clock = fakeClock();
    await resolveDecision(r, {
      surface: "auto",
      runDir: "/nonexistent",
      nowMs: clock.nowMs,
      sleep: clock.sleep,
      brainJudge: async () => {
        order.push("brain");
        return { answer: "pivot" };
      },
      ...shadowEngineDeps(fakeShadow(async (q) => { order.push("shadow"); return NEVER(); })),
    });
    expect(order).toEqual(["shadow", "brain"]); // shadow started first; brain completed although the shadow never settles

    const dir = tmpdir();
    try {
      const order2: string[] = [];
      fs.mkdirSync(path.join(dir, "decisions"), { recursive: true });
      fs.writeFileSync(path.join(dir, "decisions", "1.decision.json"), JSON.stringify({ answer: "pivot" }));
      await resolveDecision(r, {
        surface: "park",
        runDir: dir,
        nowMs: clock.nowMs,
        sleep: clock.sleep,
        pollMs: 0,
        onRequestWritten: () => order2.push("park"),
        ...shadowEngineDeps(fakeShadow(async () => { order2.push("shadow"); return NEVER(); })),
      });
      expect(order2).toEqual(["shadow", "park"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A5: a never-resolving shadow → auto returns once the INJECTED clock passes timeoutMs; error 'timeout'; no real waiting", async () => {
    const r = req("unit-exhausted");
    const clock = fakeClock();
    const shadow = fakeShadow(NEVER, { timeoutMs: 4321 });
    const t0 = Date.now();
    const res = await resolveDecision(r, { surface: "auto", runDir: "/nonexistent", nowMs: clock.nowMs, sleep: clock.sleep, ...shadowEngineDeps(shadow) });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res.shadow).toEqual({ model: "jev-test", error: "timeout" });
    expect(res.answer).toBe("pivot");
    expect(clock.sleeps).toEqual([4321]); // waited exactly timeoutMs on the injected sleep, once
    expect(clock.nowMs()).toBe(4321);
    expect(shadow.failures).toEqual(["timeout"]);
  });

  it("A5: a park answered by file waits at most timeoutMs more for a never-resolving shadow", async () => {
    const dir = tmpdir();
    try {
      const r = req("unit-exhausted");
      let t = 0;
      const sleeps: number[] = [];
      const sleep = async (ms: number) => {
        sleeps.push(ms);
        t += ms;
        // the human answers on the first poll tick
        fs.mkdirSync(path.join(dir, "decisions"), { recursive: true });
        fs.writeFileSync(path.join(dir, "decisions", "1.decision.json"), JSON.stringify({ answer: "abandon" }));
      };
      const res = await resolveDecision(r, {
        surface: "park",
        runDir: dir,
        nowMs: () => t,
        sleep,
        pollMs: 250,
        ...shadowEngineDeps(fakeShadow(NEVER, { timeoutMs: 900 })),
      });
      expect(res).toMatchObject({ answer: "abandon", source: "file", via: "park", shadow: { error: "timeout" } });
      // one 250ms poll sleep, then AT MOST the 900ms shadow wait — bounded by timeoutMs.
      expect(sleeps).toEqual([250, 900]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an already-settled shadow creates NO timer (park took longer than the shadow)", async () => {
    const r = req("unit-exhausted");
    const clock = fakeClock();
    let brainDone = false;
    const res = await resolveDecision(r, {
      surface: "auto",
      runDir: "/nonexistent",
      nowMs: clock.nowMs,
      sleep: clock.sleep,
      brainJudge: async () => {
        for (let i = 0; i < 20; i++) await Promise.resolve(); // brain is slower than the shadow
        brainDone = true;
        return { answer: "pivot" };
      },
      ...shadowEngineDeps(fakeShadow(async (q) => verdictFor(q))),
    });
    expect(brainDone).toBe(true);
    expect(clock.sleeps).toEqual([]);
    expect(res.shadow?.error).toBeUndefined();
  });

  it("fail-open: sync throw, rejection, undefined / garbage result and a failing sleep never throw or alter the answer", async () => {
    const r = req("unit-exhausted");
    const base = (clock = fakeClock()): DecisionEngineDeps => ({ surface: "auto", runDir: "/nonexistent", nowMs: clock.nowMs, sleep: clock.sleep });
    const sync = await resolveDecision(r, { ...base(), shadowModel: "m", shadowJudge: () => { throw new Error("sync"); } });
    expect(sync.shadow).toEqual({ model: "m", error: "request-failed" });
    const rej = await resolveDecision(r, { ...base(), shadowModel: "m", shadowJudge: () => Promise.reject(new Error("rej")) });
    expect(rej.shadow).toEqual({ model: "m", error: "request-failed" });
    const undef = await resolveDecision(r, { ...base(), shadowModel: "m", shadowJudge: (async () => undefined) as never });
    expect(undef.shadow).toEqual({ model: "m", error: "invalid-response" });
    const junk = await resolveDecision(r, { ...base(), shadowModel: "m", shadowJudge: (async () => ({ choice: "nope", probabilities: {}, confidence: 5 })) as never });
    expect(junk.shadow).toEqual({ model: "m", error: "invalid-response" });
    const badSleep = await resolveDecision(r, {
      ...base(),
      shadowModel: "m",
      sleep: () => Promise.reject(new Error("sleep broke")),
      shadowJudge: NEVER,
    });
    expect(badSleep.shadow).toEqual({ model: "m", error: "timeout" });
    for (const x of [sync, rej, undef, junk, badSleep]) expect(x).toMatchObject({ answer: "pivot", source: "auto-deterministic", via: "auto" });
  });

  it("a THROWING brain falls back to the deterministic default (brain-fallback) under auto and park-timeout, and the shadow is still recorded; same without a shadow judge", async () => {
    const dir = tmpdir();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => void unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const r = req("unit-exhausted"); // default: pivot
      const boom = async (): Promise<never> => {
        throw new Error("brain exploded");
      };
      const surfaces: Array<{ surface: "auto" | "park-timeout"; via: string }> = [
        { surface: "auto", via: "auto" },
        { surface: "park-timeout", via: "timeout" },
      ];
      for (const { surface, via } of surfaces) {
        const mk = (extra: Partial<DecisionEngineDeps>, sub: string): DecisionEngineDeps => {
          const clock = fakeClock();
          return { surface, runDir: path.join(dir, `${surface}-${sub}`), nowMs: clock.nowMs, sleep: clock.sleep, pollMs: 4000, brainJudge: boom, ...extra };
        };
        const plain = await resolveDecision(r, mk({}, "plain"));
        expect(plain).toMatchObject({ answer: r.default, source: "brain-fallback", via });
        expect(plain.rationale).toContain("brain threw");
        expect(plain).not.toHaveProperty("shadow");

        const shadowed = await resolveDecision(r, mk(shadowEngineDeps(fakeShadow(async (q) => verdictFor(q, "abandon"))), "shadow"));
        expect({ ...shadowed, shadow: undefined }).toEqual({ ...plain, shadow: undefined });
        expect(shadowed.shadow).toMatchObject({ model: "jev-test", choice: "abandon", agreed: false });

        // A never-settling shadow is bounded by timeoutMs even when the brain threw.
        const slow = await resolveDecision(r, mk(shadowEngineDeps(fakeShadow(NEVER, { timeoutMs: 777 })), "slow"));
        expect(slow).toMatchObject({ answer: r.default, source: "brain-fallback", shadow: { error: "timeout" } });

        // A REJECTING shadow beside a throwing brain leaves no unhandled rejection.
        const both = await resolveDecision(r, mk(shadowEngineDeps(fakeShadow(() => Promise.reject(new Error("jev down")))), "both"));
        expect(both).toMatchObject({ answer: r.default, source: "brain-fallback", shadow: { error: "request-failed" } });
      }
      await new Promise((res) => setImmediate(res));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a real-path failure (park cannot write its request) leaves no unhandled shadow rejection", async () => {
    const dir = tmpdir();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => void unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const blocked = path.join(dir, "file-not-dir");
      fs.writeFileSync(blocked, "x"); // decisions/ cannot be created under a file
      const clock = fakeClock();
      await expect(
        resolveDecision(req(), {
          surface: "park",
          runDir: blocked,
          nowMs: clock.nowMs,
          sleep: clock.sleep,
          ...shadowEngineDeps(fakeShadow(() => Promise.reject(new Error("jev down")))),
        }),
      ).rejects.toThrow();
      await new Promise((res) => setImmediate(res));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no judge → no `shadow` key at all (byte-identical resolution)", async () => {
    const clock = fakeClock();
    const res = await resolveDecision(req(), { surface: "auto", runDir: "/nonexistent", nowMs: clock.nowMs, sleep: clock.sleep });
    expect(Object.keys(res)).not.toContain('"shadow"');
    expect(shadowEngineDeps(undefined)).toEqual({});
  });

  it("warns at most ONCE per shadow judge across many failed decisions, never naming a key value", async () => {
    const fc = fakeClient(() => {
      throw new Error(`upstream said key ${SECRET} is bad`);
    });
    const cap = captureLog();
    try {
      await withEnv({ [KEY_ENV]: SECRET }, async () => {
        const shadow = createShadowJudge({ enabled: true, apiKeyEnv: KEY_ENV }, recordingFactory(fc).factory)!;
        const clock = fakeClock();
        for (let i = 0; i < 4; i++) {
          const res = await resolveDecision(req(), { surface: "auto", runDir: "/x", nowMs: clock.nowMs, sleep: clock.sleep, ...shadowEngineDeps(shadow) });
          expect(res.shadow?.error).toBe("request-failed");
        }
      });
      expect(shadowWarns(cap.lines())).toHaveLength(1);
      expect(cap.lines().join("\n")).not.toContain(SECRET);
    } finally {
      cap.restore();
    }
  });
});

// ───────────────────────── A8 wiring and key ─────────────────────────

describe("shadow wiring (A8)", () => {
  const OPTS = (o: Partial<ConductOptions> = {}): ConductOptions => ({ prompt: "build a thing", maxUnits: 4, concurrency: 2, dryRun: false, ...o });
  function kindOf(args: string[]): string {
    const i = args.indexOf("--kind");
    return i >= 0 ? args[i + 1]! : args[0] === "eval" ? "evaluator" : "?";
  }
  function argVal(args: string[], flag: string): string | undefined {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  }
  const decomposer =
    (n: number) =>
    async (_p: RunSessionParams): Promise<RunResult> => ({
      ok: true,
      subtype: "success",
      resultText: "```json\n" + JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `unit-${String(i + 1).padStart(3, "0")}`, title: `U${i + 1}`, summary: "s", rationale: "r" }))) + "\n```",
      sessionId: "d",
      costUsd: 0,
      tokens: 1,
      numTurns: 1,
      hitMaxTurns: false,
      hitBudget: false,
      errors: [],
      tracePath: "",
    });
  /** Agreed contract; the evaluator PASSES but same-model → a gate-collapse judgment point. */
  const gateCollapseRunner = async (spec: RunRoleSpec): Promise<ParentSummary> => {
    const kind = kindOf(spec.args);
    if (kind === "contract-generator") {
      fs.writeFileSync(argVal(spec.args, "--contract")!, "C");
      return summary({ roleKind: "contract-generator", outPath: argVal(spec.args, "--contract") });
    }
    if (kind === "contract-evaluator") return summary({ roleKind: "contract-evaluator", contractAgreed: true });
    if (kind === "generator") return summary({ roleKind: "generator", filesChanged: 1 });
    return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: true });
  };

  async function run(dir: string, cfg: Partial<ReturnType<typeof defaultConfig>["conduct"]["shadowJudge"]>, deps: Partial<ConductDeps>) {
    const ctx = await makeCtx(dir);
    Object.assign(ctx.config.conduct.shadowJudge, cfg);
    return runConduct(ctx, OPTS({ brain: "hybrid", surface: "auto", timeoutSec: 1800 }), {
      runRole: gateCollapseRunner,
      runSessionFn: decomposer(1),
      brain: null,
      now: () => 0,
      sleep: async () => {},
      ...deps,
    });
  }

  it("enabled + non-default apiKeyEnv: the factory receives THAT env value; TYPESAFE_API_KEY is neither read nor mutated; run.json carries shadow; key never logged", async () => {
    const dir = tmpdir();
    const cap = captureLog();
    try {
      const fc = fakeClient((r) => wrap(goodAnswer(Object.keys((r.questions.decision as { criteria: object }).criteria))));
      const { factory, inits } = recordingFactory(fc);
      const envBefore = { ...process.env };
      // A getter-trap on the DEFAULT var name would fire if anything read it.
      await withEnv({ [KEY_ENV]: SECRET, TYPESAFE_API_KEY: "default-key-must-not-be-used" }, async () => {
        const res = await run(dir, { enabled: true, apiKeyEnv: KEY_ENV }, { shadowClientFactory: factory });
        expect(inits).toHaveLength(1);
        expect(inits[0]).toEqual({ apiKey: SECRET, model: "jev-1.13.0" });
        expect(process.env.TYPESAFE_API_KEY).toBe("default-key-must-not-be-used");
        expect(process.env[KEY_ENV]).toBe(SECRET);
        const gate = (res.state.units[0]!.decisions ?? []).find((d) => d.kind === "gate-collapse")!;
        expect(gate.shadow).toMatchObject({ model: "jev-1.13.0", choice: "abandon" });
        const disk = fs.readFileSync(runStatePath(res.runDir), "utf8");
        expect(disk).toContain('"shadow"');
        expect(disk).not.toContain(SECRET);
        expect(disk).not.toContain("default-key-must-not-be-used");
      });
      for (const k of Object.keys(process.env)) if (!(k in envBefore)) throw new Error(`env var ${k} leaked`);
      expect(cap.lines().join("\n")).not.toContain(SECRET);
    } finally {
      cap.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disabled: zero factory constructions, ZERO shadow warns, no `shadow` key anywhere in run.json", async () => {
    const dir = tmpdir();
    const cap = captureLog();
    try {
      const fc = fakeClient(() => wrap(undefined));
      const { factory, inits } = recordingFactory(fc);
      await withEnv({ [KEY_ENV]: SECRET }, async () => {
        const res = await run(dir, { enabled: false, apiKeyEnv: KEY_ENV }, { shadowClientFactory: factory });
        expect(inits).toHaveLength(0);
        expect(fc.calls).toHaveLength(0);
        expect(shadowWarns(cap.lines())).toHaveLength(0);
        expect((res.state.units[0]!.decisions ?? []).length).toBeGreaterThan(0);
        expect(fs.readFileSync(runStatePath(res.runDir), "utf8")).not.toContain('"shadow"');
      });
    } finally {
      cap.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enabled but the key is unset (or empty): zero constructions and EXACTLY ONE warn naming the env var, not a value", async () => {
    for (const value of [undefined, ""]) {
      const dir = tmpdir();
      const cap = captureLog();
      try {
        const fc = fakeClient(() => wrap(undefined));
        const { factory, inits } = recordingFactory(fc);
        await withEnv({ [KEY_ENV]: value, TYPESAFE_API_KEY: SECRET }, async () => {
          const res = await run(dir, { enabled: true, apiKeyEnv: KEY_ENV }, { shadowClientFactory: factory });
          expect(inits).toHaveLength(0);
          const warns = shadowWarns(cap.lines());
          expect(warns, String(value)).toHaveLength(1);
          expect(warns[0]).toContain(KEY_ENV);
          expect(cap.lines().join("\n")).not.toContain(SECRET);
          expect(fs.readFileSync(runStatePath(res.runDir), "utf8")).not.toContain('"shadow"');
        });
      } finally {
        cap.restore();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("a failing shadow never fails the run and warns ONCE for the whole run (many decisions)", async () => {
    const dir = tmpdir();
    const cap = captureLog();
    try {
      const fc = fakeClient(() => {
        throw new Error("network down");
      });
      const { factory } = recordingFactory(fc);
      await withEnv({ [KEY_ENV]: SECRET }, async () => {
        const res = await run(dir, { enabled: true, apiKeyEnv: KEY_ENV }, { shadowClientFactory: factory });
        expect(res.state.units[0]!.outcome).toBe("grade-not-independent"); // same outcome as without a shadow
        const gate = (res.state.units[0]!.decisions ?? []).find((d) => d.kind === "gate-collapse")!;
        expect(gate.shadow).toEqual({ model: "jev-1.13.0", error: "request-failed" });
        expect(shadowWarns(cap.lines())).toHaveLength(1);
      });
    } finally {
      cap.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────── A7 persistence ─────────────────────────

describe("shadow persistence at every resolveDecision consumer (A7)", () => {
  const OPTS = (o: Partial<ConductOptions> = {}): ConductOptions => ({ prompt: "build a thing", maxUnits: 4, concurrency: 1, dryRun: false, ...o });
  function kindOf(args: string[]): string {
    const i = args.indexOf("--kind");
    return i >= 0 ? args[i + 1]! : args[0] === "eval" ? "evaluator" : "?";
  }
  function argVal(args: string[], flag: string): string | undefined {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  }
  const decomposer =
    (n: number) =>
    async (_p: RunSessionParams): Promise<RunResult> => ({
      ok: true,
      subtype: "success",
      resultText: "```json\n" + JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `unit-${String(i + 1).padStart(3, "0")}`, title: `U${i + 1}`, summary: "s", rationale: "r" }))) + "\n```",
      sessionId: "d",
      costUsd: 0,
      tokens: 1,
      numTurns: 1,
      hitMaxTurns: false,
      hitBudget: false,
      errors: [],
      tracePath: "",
    });
  /** Agreed contract, generator with a unit worktree, then an evaluator verdict. */
  const runner =
    (evalSummary: Partial<ParentSummary>) =>
    async (spec: RunRoleSpec): Promise<ParentSummary> => {
      const kind = kindOf(spec.args);
      if (kind === "contract-generator") {
        fs.writeFileSync(argVal(spec.args, "--contract")!, "C");
        return summary({ roleKind: "contract-generator", outPath: argVal(spec.args, "--contract") });
      }
      if (kind === "contract-evaluator") return summary({ roleKind: "contract-evaluator", contractAgreed: true });
      if (kind === "generator") {
        const name = argVal(spec.args, "--unit-worktree") ?? "wt-unit";
        return summary({
          roleKind: "generator",
          filesChanged: 1,
          unitWorktree: { name, dir: `/wt/${name}`, branch: `sparra/${name}`, created: true },
        });
      }
      return summary({ roleKind: "evaluator", ...evalSummary });
    };
  const chooser = (choice?: string) =>
    fakeShadow(async (r) => verdictFor(r, choice ?? r.options[0]!));
  const baseDeps = (over: Partial<ConductDeps> = {}): ConductDeps => ({
    runSessionFn: decomposer(1),
    brain: null,
    now: () => 0,
    sleep: async () => {},
    ...over,
  });
  const onDisk = (runDir: string): ConductRunState => JSON.parse(fs.readFileSync(runStatePath(runDir), "utf8"));

  it("live unit judgment point: the pending→resolved record carries shadow; identical run WITHOUT a judge has no `shadow` key", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const opts = OPTS({ brain: "hybrid", surface: "auto", timeoutSec: 1800 });
      const shadow = chooser("retry");
      const res = await runConduct(ctx, opts, baseDeps({ runRole: runner({ verdict: "pass", sameModelGrade: true }), shadowJudge: shadow }));
      const rec = onDisk(res.runDir).units[0]!.decisions!.find((d) => d.kind === "gate-collapse")!;
      expect(rec.status).toBe("resolved");
      expect(rec.chosen).toBe("abandon");
      expect(rec.shadow).toMatchObject({ model: "jev-test", choice: "retry", agreed: false, confidence: 0.95 });
      expect(Object.keys(rec.shadow!.probabilities!).sort()).toEqual(["abandon", "accept-anyway", "retry"]);

      const ctx2 = await makeCtx(tmpdir());
      const plain = await runConduct(ctx2, opts, baseDeps({ runRole: runner({ verdict: "pass", sameModelGrade: true }), shadowJudge: null }));
      const plainRec = onDisk(plain.runDir).units[0]!.decisions!.find((d) => d.kind === "gate-collapse")!;
      expect(plainRec).not.toHaveProperty("shadow");
      expect(fs.readFileSync(runStatePath(plain.runDir), "utf8")).not.toContain('"shadow"');
      // The shadow never changed the run: same outcome and same decision fields.
      expect(res.state.units[0]!.outcome).toBe(plain.state.units[0]!.outcome);
      expect({ ...rec, shadow: undefined, requestedAt: "", resolvedAt: "" }).toEqual({ ...plainRec, shadow: undefined, requestedAt: "", resolvedAt: "" });
      fs.rmSync(ctx2.root, { recursive: true, force: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovered / re-surfaced parked decision on resume carries shadow; without a judge it has none", async () => {
    for (const withShadow of [true, false]) {
      const dir = tmpdir();
      try {
        const ctx = await makeCtx(dir);
        const runId = "conduct-SHADOW";
        const runDir = conductRunDir(ctx.paths.dir, runId);
        const unitDir = path.join(runDir, "unit-001");
        fs.mkdirSync(unitDir, { recursive: true });
        fs.writeFileSync(path.join(unitDir, "brief.md"), "# U\n\nbrief\n");
        fs.writeFileSync(path.join(unitDir, "contract.md"), "AGREED");
        const parked: DecisionRecord = {
          seq: 3,
          unit: "unit-001",
          kind: "borderline-accept",
          question: "q",
          options: ["accept", "revise", "abandon"],
          default: "accept",
          status: "pending",
          requestedAt: "2026-07-13T00:00:00.000Z",
        };
        const entry: UnitStateEntry = {
          id: "unit-001",
          title: "U",
          outcome: "error" as UnitOutcome,
          briefPath: path.join(unitDir, "brief.md"),
          contractPath: path.join(unitDir, "contract.md"),
          contractAgreed: true,
          decisions: [parked],
        };
        const state: ConductRunState = {
          runId,
          prompt: "p",
          status: "running",
          createdAt: "2026-07-13T00:00:00.000Z",
          updatedAt: "2026-07-13T00:00:00.000Z",
          maxUnits: 4,
          concurrency: 1,
          dryRun: false,
          brain: "hybrid",
          units: [entry],
        };
        fs.writeFileSync(runStatePath(runDir), JSON.stringify(state, null, 2));
        const wt = async (_c: Ctx, name: string, src: string): Promise<EnsureUnitWorktreeResult> => ({ dir: `/wt/${name}`, branch: `sparra/${name}`, src, created: false });
        const res = await resumeConduct(ctx, runId, { surface: "auto" }, {
          runRole: runner({ verdict: "pass", sameModelGrade: false, weightedTotal: 90 }),
          ensureUnitWorktreeFn: wt as NonNullable<ConductDeps["ensureUnitWorktreeFn"]>,
          brain: null,
          now: () => 0,
          sleep: async () => {},
          ...(withShadow ? { shadowJudge: chooser("abandon") } : { shadowJudge: null }),
        });
        expect(res.status).toBe("resumed");
        const decisions = onDisk(runDir).units[0]!.decisions ?? [];
        const recovered = decisions.find((d) => d.seq > 3 && d.kind === "borderline-accept")!;
        expect(recovered.status).toBe("resolved");
        expect(recovered.chosen).toBe("accept"); // deterministic default — shadow's "abandon" never applied
        if (withShadow) {
          expect(recovered.shadow).toMatchObject({ model: "jev-test", choice: "abandon", agreed: false });
        } else {
          expect(recovered).not.toHaveProperty("shadow");
          expect(fs.readFileSync(runStatePath(runDir), "utf8")).not.toContain('"shadow"');
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  /** commit + landing fakes: a unit WIP "commits" to a valid sha; no real git anywhere. */
  const commitGit = {
    changedFiles: () => ["/wt/a.txt"],
    workingDiff: () => "",
    commitPaths: () => ({ ok: true, out: "" }),
    revParse: () => "a".repeat(40),
  } as unknown as NonNullable<ConductDeps["commitGit"]>;

  it("merge-blocked (dirty target) carries shadow on the unit's record; none without a judge", async () => {
    for (const withShadow of [true, false]) {
      const dir = tmpdir();
      try {
        const ctx = await makeCtx(dir);
        const res = await runConduct(ctx, OPTS({ merge: true, surface: "auto", timeoutSec: 1800 }), baseDeps({
          runRole: runner({ verdict: "pass", sameModelGrade: false, weightedTotal: 90 }),
          commitGit,
          landingGit: {
            currentBranch: () => "feature",
            defaultBranch: () => "main",
            isDirty: () => true,
          } as never,
          shadowJudge: withShadow ? chooser("abort-merge") : null,
        }));
        const rec = onDisk(res.runDir).units[0]!.decisions!.find((d) => d.kind === "merge-blocked")!;
        expect(rec, "merge-blocked record").toBeDefined();
        expect(rec.status).toBe("resolved");
        expect(rec.chosen).toBe("skip-unit"); // deterministic default; shadow's abort-merge not applied
        if (withShadow) expect(rec.shadow).toMatchObject({ model: "jev-test", choice: "abort-merge", agreed: false });
        else {
          expect(rec).not.toHaveProperty("shadow");
          expect(fs.readFileSync(runStatePath(res.runDir), "utf8")).not.toContain('"shadow"');
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("land-blocked (run-level landDecisions) carries shadow; none without a judge", async () => {
    for (const withShadow of [true, false]) {
      const dir = tmpdir();
      try {
        const ctx = await makeCtx(dir);
        // No resolvable current/default branch → no merge target → `--land` parks a land-blocked decision.
        const res = await runConduct(ctx, OPTS({ merge: true, land: true, surface: "auto", timeoutSec: 1800 }), baseDeps({
          runRole: runner({ verdict: "pass", sameModelGrade: false, weightedTotal: 90 }),
          commitGit,
          landingGit: { currentBranch: () => null, defaultBranch: () => null } as never,
          shadowJudge: withShadow ? chooser("skip-land") : null,
        }));
        const rec = onDisk(res.runDir).landDecisions?.find((d) => d.kind === "land-blocked");
        expect(rec, "land-blocked record").toBeDefined();
        expect(rec!.status).toBe("resolved");
        expect(rec!.chosen).toBe("skip-land");
        if (withShadow) expect(rec!.shadow).toMatchObject({ model: "jev-test", choice: "skip-land", agreed: true });
        else {
          expect(rec).not.toHaveProperty("shadow");
          expect(fs.readFileSync(runStatePath(res.runDir), "utf8")).not.toContain('"shadow"');
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
