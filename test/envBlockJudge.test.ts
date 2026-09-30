import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../src/util/log.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/util/log.ts")>()),
  warn: vi.fn(),
}));

import { warn } from "../src/util/log.ts";
import {
  annotateEnvBlock,
  autoEnvBlockedIds,
  classifyBand,
  clipEvidence,
  MAX_EVIDENCE_CHARS,
  parseEnvBlockAnswer,
  renderEnvBlockSection,
  type EnvBlockClient,
  type EnvBlockClientFactory,
  type EnvBlockDeps,
  type EnvBlockTimer,
} from "../src/build/envBlockJudge.ts";
import { evaluateItem } from "../src/build/evaluate.ts";
import { runRole } from "../src/build/roleRun.ts";
import { buildRunRolePayload } from "../src/mcp/runRoleServer.ts";
import { toParentSummary } from "../conductors/core/summary.ts";
import { defaultConfig, type EnvBlockJudgeConfig } from "../src/config.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import type { Ctx } from "../src/context.ts";
import type { IntegrityDeps } from "../src/build/integrity.ts";
import type { Verdict, WorkItem } from "../src/build/types.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

/**
 * Jev "couldn't run vs ran-and-failed" annotation. Everything is offline: fake clients, an injected
 * timeout clock, fake sessions — no network, no real timers, no live model.
 */

const KEY_ENV = "ENVBLOCK_TEST_KEY";
const SECRET = "sk-envblock-secret-value";
const warns = () => vi.mocked(warn).mock.calls.map((c) => String(c[0]));
const envBlockWarns = () => warns().filter((m) => m.includes("envBlockJudge"));

const priorEnv = { key: process.env[KEY_ENV], ts: process.env.TYPESAFE_API_KEY };
afterEach(() => {
  vi.mocked(warn).mockClear();
  if (priorEnv.key === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = priorEnv.key;
  if (priorEnv.ts === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = priorEnv.ts;
});

const cfg = (over: Partial<EnvBlockJudgeConfig> = {}): EnvBlockJudgeConfig => ({
  ...defaultConfig().evaluator.envBlockJudge,
  enabled: true,
  apiKeyEnv: KEY_ENV,
  ...over,
});

type Req = Parameters<EnvBlockClient["systemOne"]>[0];
type Handler = (req: Req, n: number) => PromiseLike<unknown> | unknown;

function fakeClient(handler: Handler) {
  const calls: Req[] = [];
  const inits: { apiKey: string; model: string }[] = [];
  const client: EnvBlockClient = {
    systemOne(req) {
      calls.push(req);
      try {
        return Promise.resolve(handler(req, calls.length - 1));
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };
  const factory: EnvBlockClientFactory = (init) => {
    inits.push(init);
    return client;
  };
  return { calls, inits, factory };
}

const answer = (noulScore: unknown, choice: unknown, confidence: unknown) => ({
  answers: { env_only: { noul: noulScore }, kind: { choice, confidence } },
});
const AUTO = answer(0.95, "environment_blocked", 0.9);
const NOT_ENV = answer(0.02, "artifact_defect", 0.95);

/** A clock whose timers only fire when the test says so. */
function fakeTimer() {
  const pending = new Map<number, () => void>();
  let seq = 0;
  const cleared: number[] = [];
  const timer: EnvBlockTimer = {
    set: (fn) => {
      pending.set(++seq, fn);
      return seq;
    },
    clear: (h) => {
      cleared.push(h as number);
      pending.delete(h as number);
    },
  };
  return { timer, fire: () => [...pending.values()].forEach((f) => f()), pending, cleared };
}

const EPERM = "EPERM: operation not permitted, mkdir '/private/var'";
function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    assertions: [
      { id: 1, pass: false, evidence: EPERM },
      { id: 2, pass: false, evidence: "expected 4, got 3 in add()" },
      { id: 3, pass: true, evidence: "ok" },
      { id: 4, pass: false, evidence: "simulator unavailable" },
    ],
    unrunAssertionIds: [4],
    scores: { design: 50, originality: 50, craft: 50, functionality: 50 },
    weightedTotal: 50,
    verdict: "fail",
    exerciseStatus: "ran",
    blocking: [],
    notes: "n",
    ...over,
  };
}

const ids = (v: Verdict | undefined) => v?.envBlock?.assertions.map((a) => `${a.id}:${a.band}`);

describe("request shape (A3)", () => {
  it("sends exactly one systemOne per failed RUNNABLE assertion with the verbatim questions", async () => {
    process.env[KEY_ENV] = SECRET;
    const fc = fakeClient(() => NOT_ENV);
    const out = await annotateEnvBlock(verdict(), cfg({ model: "jev-custom" }), { clientFactory: fc.factory });
    expect(fc.calls).toHaveLength(2); // #1, #2 — not the pass (#3), not the un-run (#4)
    expect(fc.inits).toEqual([{ apiKey: SECRET, model: "jev-custom" }]);
    expect(fc.calls.map((c) => c.state)).toEqual([{ verdict_item: `#1: ${EPERM}` }, { verdict_item: "#2: expected 4, got 3 in add()" }]);
    for (const call of fc.calls) {
      expect(Object.keys(call.state)).toEqual(["verdict_item"]);
      expect(call.model).toBe("jev-custom");
      expect(Object.keys(call.questions)).toEqual(["env_only", "kind"]);
      const q = call.questions as unknown as Record<string, { type: string; instructions: string; criteria: Record<string, string> }>;
      expect(q.env_only!.type).toBe("noul");
      expect(q.env_only!.instructions).toBe(
        "Does `verdict_item` say only that a check could not execute or be observed in the grader's environment, without reporting any defect in the artifact being graded?",
      );
      expect(q.env_only!.criteria).toEqual({
        true: "The item reports that a check was blocked or could not run in the grader's environment (sandbox denial, EPERM, read-only filesystem, missing tool, no simulator, network, tooling timeout) and claims nothing is wrong with the artifact itself.",
        false: "The item reports a defect, missing behavior, wrong output, or a check that failed because of the artifact's own code, or asks for a change to the artifact — even if it also mentions an environment limitation.",
      });
      expect(q.kind!.type).toBe("choice");
      expect(q.kind!.instructions).toBe("What does `verdict_item` report?");
      expect(q.kind!.criteria).toEqual({
        environment_blocked:
          "A check could not execute or be observed in the grader's environment (sandbox, permissions, missing tool or simulator, network, tooling timeout); no artifact defect is claimed.",
        artifact_defect: "The check ran, or the code was inspected, and the artifact is wrong, incomplete, or fails a command because of its own code.",
        both_blocked_and_defect: "It reports an environment limitation AND a separate defect or missing behavior in the artifact.",
        process_or_wording: "A process, contract, or wording complaint with no artifact defect and no environment limitation.",
      });
    }
    expect(out).toEqual({ model: "jev-custom", assertions: [] });
  });

  it("clips long evidence to 1500 chars without leaving a lone surrogate at the cut", async () => {
    process.env[KEY_ENV] = SECRET;
    // The 😀 pair straddles the boundary: high surrogate is char 1499 of the evidence.
    const evidence = "a".repeat(MAX_EVIDENCE_CHARS - 1) + "😀" + "tail";
    const fc = fakeClient(() => NOT_ENV);
    await annotateEnvBlock(verdict({ assertions: [{ id: 1, pass: false, evidence }], unrunAssertionIds: [] }), cfg(), { clientFactory: fc.factory });
    const sent = fc.calls[0]!.state.verdict_item;
    expect(sent.startsWith("#1: ")).toBe(true);
    expect(sent.length).toBeLessThanOrEqual("#1: ".length + MAX_EVIDENCE_CHARS);
    expect(sent.length).toBeGreaterThan(MAX_EVIDENCE_CHARS); // it WAS clipped, not dropped
    for (let i = 0; i < sent.length; i++) {
      const c = sent.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = sent.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff, `lone high surrogate at ${i}`).toBe(true);
        i++;
      } else {
        expect(c >= 0xdc00 && c <= 0xdfff, `lone low surrogate at ${i}`).toBe(false);
      }
    }
    expect(clipEvidence("x".repeat(1500))).toHaveLength(1500);
    expect(clipEvidence("x".repeat(1501))).toHaveLength(1500);
    expect(clipEvidence("é".repeat(10))).toBe("é".repeat(10));
  });
});

describe("skips (A4)", () => {
  const cases: [string, Verdict][] = [
    ["a blocked exercise", verdict({ exerciseStatus: "blocked" })],
    ["a passing verdict", verdict({ verdict: "pass" })],
    ["no failed runnable assertion", verdict({ assertions: [{ id: 1, pass: true, evidence: "ok" }], unrunAssertionIds: [] })],
    ["only un-run failures", verdict({ assertions: [{ id: 4, pass: false, evidence: "x" }], unrunAssertionIds: [4] })],
    ["no assertions at all", verdict({ assertions: [], unrunAssertionIds: [] })],
  ];
  it.each(cases)("%s → zero requests, no annotation, verdict untouched", async (_n, v) => {
    process.env[KEY_ENV] = SECRET;
    const before = JSON.stringify(v);
    const fc = fakeClient(() => AUTO);
    expect(await annotateEnvBlock(v, cfg(), { clientFactory: fc.factory })).toBeUndefined();
    expect(fc.calls).toHaveLength(0);
    expect(JSON.stringify(v)).toBe(before);
  });

  it("a holdout-redacted assertion is not sent; the other failed assertions still are", async () => {
    process.env[KEY_ENV] = SECRET;
    const v = verdict({
      assertions: [
        { id: 1, pass: false, evidence: "could not run: [redacted: holdout] EPERM" },
        { id: 2, pass: false, evidence: EPERM },
      ],
      unrunAssertionIds: [],
    });
    const fc = fakeClient(() => AUTO);
    const out = await annotateEnvBlock(v, cfg(), { clientFactory: fc.factory });
    expect(fc.calls.map((c) => c.state.verdict_item)).toEqual([`#2: ${EPERM}`]);
    expect(out!.assertions.map((a) => a.id)).toEqual([2]);
  });

  it("holdout-only: zero requests, envBlock present with assertions [] and no error", async () => {
    process.env[KEY_ENV] = SECRET;
    const v = verdict({ assertions: [{ id: 1, pass: false, evidence: "[redacted: holdout]" }], unrunAssertionIds: [] });
    const fc = fakeClient(() => AUTO);
    expect(await annotateEnvBlock(v, cfg(), { clientFactory: fc.factory })).toEqual({ model: "jev-1.13.0", assertions: [] });
    expect(fc.calls).toHaveLength(0);
  });
});

describe("bands (A5)", () => {
  const D = { autoNoul: 0.8, autoConfidence: 0.8, suspectNoul: 0.5 };
  it.each([
    [0.8, "environment_blocked", 0.8, "auto"], // exact boundaries
    [1, "environment_blocked", 1, "auto"],
    [0.79, "environment_blocked", 0.95, "suspect"],
    [0.95, "environment_blocked", 0.79, "suspect"], // confidence gate
    [0.95, "artifact_defect", 0.95, "suspect"], // choice gate
    [0.95, "both_blocked_and_defect", 0.95, "suspect"],
    [0.95, "process_or_wording", 0.95, "suspect"],
    [0.5, "environment_blocked", 0.9, "suspect"], // exact suspect boundary
    [0.5, "artifact_defect", 0, "suspect"],
    [0.49, "environment_blocked", 0.99, undefined],
    [0, "environment_blocked", 1, undefined],
  ])("noul %s / %s / conf %s → %s", (n, c, conf, band) => {
    expect(classifyBand({ noul: n, choice: c, confidence: conf }, D)).toBe(band);
  });

  it("honors custom thresholds from config", async () => {
    process.env[KEY_ENV] = SECRET;
    const fc = fakeClient(() => answer(0.6, "environment_blocked", 0.6));
    const v = verdict({ assertions: [{ id: 1, pass: false, evidence: EPERM }], unrunAssertionIds: [] });
    const strict = await annotateEnvBlock(v, cfg(), { clientFactory: fc.factory });
    expect(ids({ ...v, envBlock: strict })).toEqual(["1:suspect"]);
    const loose = await annotateEnvBlock(v, cfg({ autoNoul: 0.6, autoConfidence: 0.6, suspectNoul: 0.1 }), { clientFactory: fc.factory });
    expect(ids({ ...v, envBlock: loose })).toEqual(["1:auto"]);
    const off = await annotateEnvBlock(v, cfg({ suspectNoul: 0.7, autoNoul: 0.9 }), { clientFactory: fc.factory });
    expect(off!.assertions).toEqual([]);
  });

  it("records noul/choice/confidence and only the flagged assertions", async () => {
    process.env[KEY_ENV] = SECRET;
    const fc = fakeClient((r) => (r.state.verdict_item.startsWith("#1") ? AUTO : NOT_ENV));
    const out = await annotateEnvBlock(verdict(), cfg(), { clientFactory: fc.factory });
    expect(out).toEqual({
      model: "jev-1.13.0",
      assertions: [{ id: 1, noul: 0.95, choice: "environment_blocked", confidence: 0.9, band: "auto" }],
    });
    expect(autoEnvBlockedIds({ envBlock: out })).toEqual([1]);
  });
});

describe("validation + failure modes (A6)", () => {
  it.each([
    ["noul NaN", answer(Number.NaN, "environment_blocked", 0.9)],
    ["noul 1.2", answer(1.2, "environment_blocked", 0.9)],
    ["noul '0.9'", answer("0.9", "environment_blocked", 0.9)],
    ["noul -0.1", answer(-0.1, "environment_blocked", 0.9)],
    ["choice outside the four", answer(0.95, "maybe", 0.9)],
    ["choice missing", answer(0.95, undefined, 0.9)],
    ["confidence -0.1", answer(0.95, "environment_blocked", -0.1)],
    ["confidence missing", answer(0.95, "environment_blocked", undefined)],
    ["confidence 1.5", answer(0.95, "environment_blocked", 1.5)],
    ["no answers", {}],
    ["null response", null],
    ["kind missing", { answers: { env_only: { noul: 0.95 } } }],
  ])("%s → unflagged + invalid-response, nothing thrown", async (_n, res) => {
    process.env[KEY_ENV] = SECRET;
    const fc = fakeClient(() => res);
    const v = verdict({ assertions: [{ id: 1, pass: false, evidence: EPERM }], unrunAssertionIds: [] });
    const out = await annotateEnvBlock(v, cfg(), { clientFactory: fc.factory });
    expect(out).toEqual({ model: "jev-1.13.0", assertions: [], error: "invalid-response" });
    expect(envBlockWarns()).toHaveLength(1);
    expect(parseEnvBlockAnswer(res)).toBeUndefined();
  });

  it("a rejected request → request-failed; the other assertions keep their results", async () => {
    process.env[KEY_ENV] = SECRET;
    const fc = fakeClient((r) => {
      if (r.state.verdict_item.startsWith("#1")) throw new Error(`boom ${SECRET}`);
      return AUTO;
    });
    const out = await annotateEnvBlock(verdict(), cfg(), { clientFactory: fc.factory });
    expect(out).toMatchObject({ error: "request-failed" });
    expect(out!.assertions.map((a) => a.id)).toEqual([2]);
    expect(envBlockWarns()).toHaveLength(1);
    expect(warns().join("\n")).not.toContain(SECRET);
  });

  it("a factory that throws is fail-open (request-failed)", async () => {
    process.env[KEY_ENV] = SECRET;
    const out = await annotateEnvBlock(verdict(), cfg(), {
      clientFactory: () => {
        throw new Error("nope");
      },
    });
    expect(out).toEqual({ model: "jev-1.13.0", assertions: [], error: "request-failed" });
  });

  it("a never-resolving request → timeout via the injected clock; finished ones keep their results", async () => {
    process.env[KEY_ENV] = SECRET;
    const clock = fakeTimer();
    const fc = fakeClient((r) => (r.state.verdict_item.startsWith("#1") ? new Promise(() => {}) : AUTO));
    const pending = annotateEnvBlock(verdict(), cfg(), { clientFactory: fc.factory, timer: clock.timer });
    await new Promise((r) => setImmediate(r)); // let the fast request settle, the hung one still pending
    clock.fire();
    const out = await pending;
    expect(out!.error).toBe("timeout");
    expect(out!.assertions.map((a) => a.id)).toEqual([2]);
    expect(clock.pending.size).toBe(0); // timer cleared
  });

  it("clears the timer and never fires a timeout when everything finishes", async () => {
    process.env[KEY_ENV] = SECRET;
    const clock = fakeTimer();
    const fc = fakeClient(() => AUTO);
    const out = await annotateEnvBlock(verdict(), cfg(), { clientFactory: fc.factory, timer: clock.timer });
    expect(out!.error).toBeUndefined();
    expect(clock.cleared).toHaveLength(1);
  });

  const threeFailed = (): Verdict =>
    verdict({
      assertions: [
        { id: 1, pass: false, evidence: "one" },
        { id: 2, pass: false, evidence: "two" },
        { id: 3, pass: false, evidence: "three" },
      ],
      unrunAssertionIds: [],
    });

  it("mixed errors: `timeout` wins in EVERY completion order; without it `request-failed` wins", async () => {
    process.env[KEY_ENV] = SECRET;
    // Which id hangs / rejects / returns garbage, across all six permutations.
    const perms: [number, number, number][] = [[1, 2, 3], [1, 3, 2], [2, 1, 3], [2, 3, 1], [3, 1, 2], [3, 2, 1]];
    for (const [hang, rejectId, garbage] of perms) {
      for (const settleOrder of perms) {
        const clock = fakeTimer();
        const releases = new Map<number, () => void>();
        const fc = fakeClient((r) => {
          const id = Number(/^#(\d+)/.exec(r.state.verdict_item)![1]);
          if (id === hang) return new Promise(() => {});
          return new Promise((resolve, reject) => {
            releases.set(id, () => (id === rejectId ? reject(new Error("x")) : resolve(id === garbage ? { answers: "junk" } : AUTO)));
          });
        });
        const pending = annotateEnvBlock(threeFailed(), cfg(), { clientFactory: fc.factory, timer: clock.timer });
        await new Promise((r) => setImmediate(r));
        for (const id of settleOrder) releases.get(id)?.();
        await new Promise((r) => setImmediate(r));
        clock.fire();
        expect((await pending)!.error, `hang ${hang} order ${settleOrder}`).toBe("timeout");
      }
    }
    for (const [reject, garbage] of [[1, 2], [2, 1], [3, 1], [1, 3]] as const) {
      const fc = fakeClient((r) => {
        const id = Number(/^#(\d+)/.exec(r.state.verdict_item)![1]);
        if (id === reject) return Promise.reject(new Error("x"));
        if (id === garbage) return { answers: {} };
        return AUTO;
      });
      const out = await annotateEnvBlock(threeFailed(), cfg(), { clientFactory: fc.factory });
      expect(out!.error).toBe("request-failed");
    }
  });

  it("respects the configured concurrency bound", async () => {
    process.env[KEY_ENV] = SECRET;
    let active = 0;
    let peak = 0;
    const fc = fakeClient(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setImmediate(r));
      active--;
      return NOT_ENV;
    });
    const many = verdict({ assertions: Array.from({ length: 7 }, (_, i) => ({ id: i + 1, pass: false, evidence: "e" })), unrunAssertionIds: [] });
    await annotateEnvBlock(many, cfg({ concurrency: 2 }), { clientFactory: fc.factory });
    expect(fc.calls).toHaveLength(7);
    expect(peak).toBe(2);
  });
});

describe("key handling + gating (A11)", () => {
  it("passes process.env[apiKeyEnv] to the factory; TYPESAFE_API_KEY is neither read nor mutated", async () => {
    process.env[KEY_ENV] = SECRET;
    process.env.TYPESAFE_API_KEY = "default-key-must-not-be-used";
    const fc = fakeClient(() => AUTO);
    await annotateEnvBlock(verdict(), cfg(), { clientFactory: fc.factory });
    expect(fc.inits).toEqual([{ apiKey: SECRET, model: "jev-1.13.0" }]);
    expect(process.env.TYPESAFE_API_KEY).toBe("default-key-must-not-be-used");
    expect(process.env[KEY_ENV]).toBe(SECRET);
    expect(warns().join("\n")).not.toContain(SECRET);
  });

  it("disabled → zero constructions, zero warns, no annotation (even keyless / missing block)", async () => {
    const fc = fakeClient(() => AUTO);
    delete process.env[KEY_ENV];
    for (const c of [cfg({ enabled: false }), undefined, null, {}]) {
      expect(await annotateEnvBlock(verdict(), c as never, { clientFactory: fc.factory })).toBeUndefined();
    }
    expect(fc.inits).toHaveLength(0);
    expect(fc.calls).toHaveLength(0);
    expect(warns()).toHaveLength(0);
  });

  it("enabled but the key is unset/empty → zero constructions, exactly one warn naming the variable, no annotation", async () => {
    const fc = fakeClient(() => AUTO);
    for (const value of [undefined, ""]) {
      vi.mocked(warn).mockClear();
      if (value === undefined) delete process.env[KEY_ENV];
      else process.env[KEY_ENV] = value;
      expect(await annotateEnvBlock(verdict(), cfg(), { clientFactory: fc.factory })).toBeUndefined();
      expect(envBlockWarns()).toHaveLength(1);
      expect(envBlockWarns()[0]).toContain(`$${KEY_ENV}`);
    }
    expect(fc.inits).toHaveLength(0);
  });
});

describe("markdown section", () => {
  it("lists flagged ids, `_none_` when empty, and nothing when absent", () => {
    expect(renderEnvBlockSection(undefined)).toBe("");
    expect(renderEnvBlockSection({ model: "m", assertions: [] })).toBe("\n\n## Likely environment-blocked (Jev, informational)\n_none_");
    expect(
      renderEnvBlockSection({
        model: "m",
        assertions: [
          { id: 3, noul: 0.93, choice: "environment_blocked", confidence: 0.9, band: "auto" },
          { id: "6b", noul: 0.6, choice: "artifact_defect", confidence: 0.7, band: "suspect" },
        ],
      }),
    ).toBe("\n\n## Likely environment-blocked (Jev, informational)\n- #3 (auto, noul 0.93)\n- #6b (suspect, noul 0.6)");
  });
});

// ── Wiring: autonomous evaluator (evaluate.ts) and interactive evaluator (roleRun.ts) ──

const ITEM: WorkItem = { id: "item-001", title: "t", summary: "", dependsOn: [], rationale: "" };
const HOLDOUT_LINE = "The export must produce a byte-identical copy of the original file.";
const cleanIntegrity: IntegrityDeps = { listArtifactFiles: () => [], readFile: () => null, writeFile: () => {}, removeFile: () => {} };

async function makeCtx(holdout?: string): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-envblock-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  const ctx: Ctx = { root: dir, paths, config: defaultConfig(), store: StateStore.create(paths, "greenfield") };
  if (holdout) fs.writeFileSync(paths.holdout, `# HOLDOUT\n\n- ${holdout}\n`);
  return { ctx, dir };
}

function evalJson(assertions: { id: number | string; pass: boolean; evidence: string }[], extra: Record<string, unknown> = {}): string {
  return (
    "```json\n" +
    JSON.stringify({
      assertions,
      scores: { design: 40, originality: 40, craft: 40, functionality: 40 },
      verdict: "fail",
      blocking: ["a gate failed"],
      notes: "n",
      ...extra,
    }) +
    "\n```"
  );
}

function session(resultText: string) {
  return async (_p: RunSessionParams): Promise<RunResult> => ({
    ok: true,
    subtype: "success",
    resultText,
    sessionId: "e",
    costUsd: 0,
    tokens: 5,
    numTurns: 1,
    hitMaxTurns: false,
    hitBudget: false,
    errors: [],
    tracePath: "",
  });
}

const ALL_ENV = [
  { id: 1, pass: false, evidence: EPERM },
  { id: 2, pass: false, evidence: "tsx IPC socket: listen EPERM" },
  { id: 3, pass: true, evidence: "ok" },
];

type Path = "autonomous" | "interactive";
async function gradeWith(which: Path, ctx: Ctx, dir: string, text: string, envBlockDeps?: EnvBlockDeps) {
  if (which === "autonomous") {
    const out = await evaluateItem({
      ctx,
      item: ITEM,
      contractText: "contract",
      workspaceDir: dir,
      round: 1,
      traceDir: path.join(dir, "trace"),
      traceSeq: 1,
      runSessionFn: session(text),
      integrityDeps: cleanIntegrity,
      envBlockDeps,
    });
    return { verdict: out.verdict, markdown: fs.readFileSync(ctx.paths.verdictFile(ITEM.id, 1), "utf8") };
  }
  const r = await runRole({ ctx, roleKind: "evaluator", brief: "grade", runSessionFn: session(text), integrityDeps: cleanIntegrity, envBlockDeps });
  return { verdict: r.verdict!, markdown: fs.readFileSync(r.verdictPath!, "utf8"), result: r };
}

const SECTION = "## Likely environment-blocked (Jev, informational)";
/** The persisted markdown minus the annotation section (and the raw evaluator output, which is identical anyway). */
const withoutSection = (md: string) => md.replace(/\n\n## Likely environment-blocked \(Jev, informational\)\n[\s\S]*?(?=\n\n## )/, "");

describe.each<Path>(["autonomous", "interactive"])("%s evaluator wiring", (which) => {
  it("verdict untouched (A7): only envBlock + the new markdown section differ from the judge-off run", async () => {
    const text = evalJson(ALL_ENV, { unrunAssertionIds: [] });
    const off = await makeCtx();
    const base = await gradeWith(which, off.ctx, off.dir, text);
    expect(base.verdict.envBlock).toBeUndefined();
    expect(base.markdown).not.toContain(SECTION);

    process.env[KEY_ENV] = SECRET;
    const on = await makeCtx();
    on.ctx.config.evaluator.envBlockJudge = cfg();
    const fc = fakeClient(() => AUTO);
    const got = await gradeWith(which, on.ctx, on.dir, text, { clientFactory: fc.factory });

    expect(fc.calls).toHaveLength(2);
    expect(ids(got.verdict)).toEqual(["1:auto", "2:auto"]);
    const { envBlock, ...rest } = got.verdict;
    expect(envBlock).toBeDefined();
    expect(rest).toEqual(base.verdict);
    expect(got.verdict.verdict).toBe("fail");
    expect(got.verdict.assertions.map((a) => a.pass)).toEqual([false, false, true]);
    expect(got.markdown).toContain(`${SECTION}\n- #1 (auto, noul 0.95)\n- #2 (auto, noul 0.95)`);
    // The Failed section (and everything else) is byte-identical once the new section is removed.
    // (Interactive verdicts carry a per-run token in no rendered field, so the whole file compares.)
    expect(withoutSection(got.markdown)).toBe(base.markdown);
    fs.rmSync(off.dir, { recursive: true, force: true });
    fs.rmSync(on.dir, { recursive: true, force: true });
  });

  it("enabled but keyless: no client, one warn, byte-identical verdict + markdown (A14)", async () => {
    const text = evalJson(ALL_ENV);
    const off = await makeCtx();
    const base = await gradeWith(which, off.ctx, off.dir, text);
    delete process.env[KEY_ENV];
    const on = await makeCtx();
    on.ctx.config.evaluator.envBlockJudge = cfg();
    const fc = fakeClient(() => AUTO);
    vi.mocked(warn).mockClear();
    const got = await gradeWith(which, on.ctx, on.dir, text, { clientFactory: fc.factory });
    expect(fc.inits).toHaveLength(0);
    expect(envBlockWarns()).toHaveLength(1);
    expect(got.verdict).toEqual(base.verdict);
    expect("envBlock" in got.verdict).toBe(false);
    expect(got.markdown).toBe(base.markdown);
    fs.rmSync(off.dir, { recursive: true, force: true });
    fs.rmSync(on.dir, { recursive: true, force: true });
  });

  it("a Jev outage never throws out of the evaluator nor changes the verdict", async () => {
    process.env[KEY_ENV] = SECRET;
    const text = evalJson(ALL_ENV);
    const off = await makeCtx();
    const base = await gradeWith(which, off.ctx, off.dir, text);
    const on = await makeCtx();
    on.ctx.config.evaluator.envBlockJudge = cfg();
    const fc = fakeClient(() => {
      throw new Error("503");
    });
    const got = await gradeWith(which, on.ctx, on.dir, text, { clientFactory: fc.factory });
    expect(got.verdict.envBlock).toEqual({ model: "jev-1.13.0", assertions: [], error: "request-failed" });
    const { envBlock: _ignored, ...rest } = got.verdict;
    expect(rest).toEqual(base.verdict);
    fs.rmSync(off.dir, { recursive: true, force: true });
    fs.rmSync(on.dir, { recursive: true, force: true });
  });

  it("holdout wall (A13): a quoted holdout line never reaches Jev; only `verdict_item` is sent", async () => {
    process.env[KEY_ENV] = SECRET;
    const { ctx, dir } = await makeCtx(HOLDOUT_LINE);
    ctx.config.evaluator.envBlockJudge = cfg();
    const text = evalJson(
      [
        { id: 1, pass: false, evidence: `holdout check failed: ${HOLDOUT_LINE}` },
        { id: 2, pass: false, evidence: `${EPERM} (see: ${HOLDOUT_LINE})` },
        { id: 3, pass: false, evidence: "the widget renders wrong" },
      ],
      { blocking: [HOLDOUT_LINE], notes: `because ${HOLDOUT_LINE}` },
    );
    const fc = fakeClient(() => AUTO);
    const got = await gradeWith(which, ctx, dir, text, { clientFactory: fc.factory });
    // Only #3 survives redaction unmarked; #1 and #2 quoted holdout, so they are skipped entirely.
    expect(fc.calls.map((c) => c.state.verdict_item)).toEqual(["#3: the widget renders wrong"]);
    for (const call of fc.calls) {
      expect(Object.keys(call.state)).toEqual(["verdict_item"]);
      expect(JSON.stringify(call)).not.toContain("byte-identical");
      expect(JSON.stringify(call)).not.toContain("HOLDOUT");
    }
    expect(JSON.stringify(got.verdict)).not.toContain("byte-identical");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("holdout-only (A13): zero requests; envBlock present with assertions [] and no error", async () => {
    process.env[KEY_ENV] = SECRET;
    const { ctx, dir } = await makeCtx(HOLDOUT_LINE);
    ctx.config.evaluator.envBlockJudge = cfg();
    const text = evalJson([{ id: 1, pass: false, evidence: `failed: ${HOLDOUT_LINE}` }, { id: 2, pass: true, evidence: "ok" }]);
    const fc = fakeClient(() => AUTO);
    const got = await gradeWith(which, ctx, dir, text, { clientFactory: fc.factory });
    expect(fc.calls).toHaveLength(0);
    expect(got.verdict.envBlock).toEqual({ model: "jev-1.13.0", assertions: [] });
    expect(got.markdown).toContain(`${SECTION}\n_none_`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("conductor routing (A10)", () => {
  it("interactive evaluator → envBlockedAssertionIds in the envelope, through toParentSummary; absent when judge is off", async () => {
    process.env[KEY_ENV] = SECRET;
    const text = evalJson(ALL_ENV);
    const on = await makeCtx();
    on.ctx.config.evaluator.envBlockJudge = cfg();
    const fc = fakeClient((r) => (r.state.verdict_item.startsWith("#1") ? AUTO : NOT_ENV));
    const got = await gradeWith("interactive", on.ctx, on.dir, text, { clientFactory: fc.factory });
    const payload = buildRunRolePayload(got.result!, 75);
    expect(payload.envBlockedAssertionIds).toEqual([1]);
    expect(payload.failedAssertions!.map((a) => a.id)).toEqual([1, 2]); // still failed — annotation only
    expect(toParentSummary(payload).envBlockedAssertionIds).toEqual([1]);

    const off = await makeCtx();
    const base = await gradeWith("interactive", off.ctx, off.dir, text);
    const offPayload = buildRunRolePayload(base.result!, 75);
    expect("envBlockedAssertionIds" in offPayload).toBe(false);
    expect("envBlockedAssertionIds" in toParentSummary(offPayload)).toBe(false);
    fs.rmSync(on.dir, { recursive: true, force: true });
    fs.rmSync(off.dir, { recursive: true, force: true });
  });
});
