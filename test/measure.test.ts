import { describe, it, expect } from "vitest";
import {
  parseMetrics,
  computeDeltas,
  loadBaseline,
  runMeasure,
  renderMeasureLearning,
  type Metrics,
  type Baseline,
  type MeasureDeps,
} from "../src/build/measure.ts";
import type { ExecOutcome } from "../src/build/exec.ts";
import { cmdMeasure } from "../src/phases/measure.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";

// ── parseMetrics ──────────────────────────────────────────────────────────────
describe("parseMetrics", () => {
  it("map form: object metrics with explicit goal/unit", () => {
    const out = parseMetrics(`{"metrics": {"accuracy": {"value": 0.94, "goal": "max", "unit": "ratio"}}}`, "min");
    expect(out).toEqual({ accuracy: { value: 0.94, goal: "max", unit: "ratio" } });
  });

  it("bare-number metric uses defaultGoal", () => {
    expect(parseMetrics(`{"metrics": {"p50_ms": 12.3}}`, "min")).toEqual({ p50_ms: { value: 12.3, goal: "min" } });
    expect(parseMetrics(`{"metrics": {"throughput": 900}}`, "max")).toEqual({ throughput: { value: 900, goal: "max" } });
  });

  it("tolerates leading log lines and picks the LAST metrics object", () => {
    const stdout = [
      "> qa:metrics",
      "loading fixtures...",
      `{"note": "not metrics"}`,
      `{"metrics": {"p50_ms": 99}}`,
      "final run:",
      `{"metrics": {"p50_ms": 12.3, "accuracy": {"value": 0.9, "goal": "max"}}}`,
    ].join("\n");
    expect(parseMetrics(stdout, "min")).toEqual({
      p50_ms: { value: 12.3, goal: "min" },
      accuracy: { value: 0.9, goal: "max" },
    });
  });

  it("no-metrics / malformed stdout → null (not a throw)", () => {
    expect(parseMetrics("just logs, no json here", "min")).toBeNull();
    expect(parseMetrics(`{"other": 1}`, "min")).toBeNull();
    expect(parseMetrics(`{"metrics": {}}`, "min")).toBeNull(); // empty metrics = no usable metrics
    expect(parseMetrics(`{"metrics": {"broken": {"value": "NaN"}}}`, "min")).toBeNull(); // unusable entry dropped
    expect(parseMetrics("{ not valid json", "min")).toBeNull();
  });
});

// ── computeDeltas ─────────────────────────────────────────────────────────────
describe("computeDeltas", () => {
  const base: Baseline = {
    p50_ms: { value: 100, goal: "min" },
    accuracy: { value: 0.9, goal: "max" },
    zero: { value: 0, goal: "min" },
  };

  it("min goal: worsening past threshold is a regression", () => {
    const cur: Metrics = { p50_ms: { value: 120, goal: "min" } }; // +20% > 5%
    const d = computeDeltas(cur, base, 0.05)[0]!;
    expect(d.regressed).toBe(true);
    expect(d.isNew).toBe(false);
    expect(d.baseline).toBe(100);
    expect(Math.round(d.pct! * 100)).toBe(20);
  });

  it("max goal: worsening past threshold is a regression", () => {
    const cur: Metrics = { accuracy: { value: 0.8, goal: "max" } }; // dropped ~11% > 5%
    const d = computeDeltas(cur, base, 0.05)[0]!;
    expect(d.regressed).toBe(true);
    expect(d.pct!).toBeGreaterThan(0.05);
  });

  it("within ±threshold (either direction) is NOT a regression", () => {
    // min: small increase inside threshold
    expect(computeDeltas({ p50_ms: { value: 103, goal: "min" } }, base, 0.05)[0]!.regressed).toBe(false);
    // min: an improvement (lower) is never a regression
    expect(computeDeltas({ p50_ms: { value: 50, goal: "min" } }, base, 0.05)[0]!.regressed).toBe(false);
    // max: a small drop inside threshold
    expect(computeDeltas({ accuracy: { value: 0.88, goal: "max" } }, base, 0.05)[0]!.regressed).toBe(false);
  });

  it("a metric absent from the baseline is isNew and never regressed", () => {
    const d = computeDeltas({ brand_new: { value: 5, goal: "min" } }, base, 0.05)[0]!;
    expect(d.isNew).toBe(true);
    expect(d.regressed).toBe(false);
    expect(d.baseline).toBeUndefined();
  });

  it("baseline value of 0 is treated as new (no percentage, no regression)", () => {
    const d = computeDeltas({ zero: { value: 999, goal: "min" } }, base, 0.05)[0]!;
    expect(d.isNew).toBe(true);
    expect(d.regressed).toBe(false);
    expect(d.pct).toBeUndefined();
  });
});

// ── loadBaseline ──────────────────────────────────────────────────────────────
describe("loadBaseline", () => {
  it("missing file → empty baseline (no throw)", async () => {
    expect(await loadBaseline("/x", async () => null)).toEqual({});
    expect(await loadBaseline("/x", async () => "")).toEqual({});
  });
  it("malformed JSON → empty baseline (no throw)", async () => {
    expect(await loadBaseline("/x", async () => "{ not json")).toEqual({});
  });
  it("round-trips a well-formed baseline keyed by name", async () => {
    const json = JSON.stringify({ p50_ms: { value: 10, goal: "min" }, acc: { value: 0.9, goal: "max", unit: "ratio" } });
    expect(await loadBaseline("/x", async () => json)).toEqual({
      p50_ms: { value: 10, goal: "min" },
      acc: { value: 0.9, goal: "max", unit: "ratio" },
    });
  });
});

// ── runMeasure (injected deps — no process, no disk) ─────────────────────────────
describe("runMeasure", () => {
  /** A fake exec that returns scripted stdout/exit; captures the allowPrefixes it was handed. */
  const okExec = (stdout: string, exitCode = 0) => {
    const calls: { command: string; allow?: string[] }[] = [];
    const fn = async (_ws: string, command: string, opts?: { allowPrefixes?: string[] }): Promise<ExecOutcome> => {
      calls.push({ command, allow: opts?.allowPrefixes });
      return { ran: true, command, exitCode, stdout, stderr: "", timedOut: false };
    };
    return { calls, fn };
  };
  /** In-memory file store standing in for read/write. */
  const memFs = (seed: Record<string, string> = {}) => {
    const store: Record<string, string> = { ...seed };
    const deps = (exec: MeasureDeps["exec"]): MeasureDeps => ({
      exec,
      readFile: async (f) => store[f] ?? null,
      writeFile: async (f, c) => {
        store[f] = c;
      },
    });
    return { store, deps };
  };
  const baseOpts = {
    command: "npm run qa:metrics",
    cwd: "/ws",
    baselineFile: "/main/.sparra/measure/baseline.json",
    reportDir: "/main/.sparra/measure",
    threshold: 0.05,
    defaultGoal: "min" as const,
    now: () => new Date("2026-07-02T00:00:00Z"),
  };

  it("writes an artifact, updates the baseline by default, and passes the command as its own allow-prefix", async () => {
    const exec = okExec(`{"metrics": {"p50_ms": 12.3}}`);
    const { store, deps } = memFs();
    const res = await runMeasure(baseOpts, deps(exec.fn));
    expect(res.ran).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.metrics).toEqual({ p50_ms: { value: 12.3, goal: "min" } });
    expect(res.baselineUpdated).toBe(true);
    // baseline written to the MAIN-repo path, keyed by name
    expect(JSON.parse(store[baseOpts.baselineFile]!)).toEqual({ p50_ms: { value: 12.3, goal: "min" } });
    // artifact written to the report dir
    expect(res.reportPath).toBeTruthy();
    expect(store[res.reportPath!]).toMatch(/Measure report/);
    // the command is the explicit executor opt-in
    expect(exec.calls[0]!.allow).toEqual(["npm run qa:metrics"]);
    expect(exec.calls[0]!.command).toBe("npm run qa:metrics");
  });

  it("compare-only: does NOT write the baseline", async () => {
    const exec = okExec(`{"metrics": {"p50_ms": 12.3}}`);
    const { store, deps } = memFs();
    const res = await runMeasure({ ...baseOpts, compareOnly: true }, deps(exec.fn));
    expect(res.ok).toBe(true);
    expect(res.baselineUpdated).toBe(false);
    expect(store[baseOpts.baselineFile]).toBeUndefined(); // untouched
  });

  it("flags a regression against the stored baseline (still ok, baseline updated)", async () => {
    const exec = okExec(`{"metrics": {"p50_ms": 300}}`); // 3x slower than baseline 100
    const { deps } = memFs({ [baseOpts.baselineFile]: JSON.stringify({ p50_ms: { value: 100, goal: "min" } }) });
    const res = await runMeasure(baseOpts, deps(exec.fn));
    expect(res.ok).toBe(true);
    expect(res.regressions.map((d) => d.name)).toEqual(["p50_ms"]);
    expect(res.regressions[0]!.regressed).toBe(true);
    expect(renderMeasureLearning(res)).toMatch(/regression/);
  });

  it("PARSE FAILURE → ok:false AND the baseline file is NOT written/overwritten (guard)", async () => {
    const exec = okExec("garbage, no metrics json");
    const good = JSON.stringify({ p50_ms: { value: 100, goal: "min" } });
    const { store, deps } = memFs({ [baseOpts.baselineFile]: good });
    const res = await runMeasure(baseOpts, deps(exec.fn));
    expect(res.ran).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.baselineUpdated).toBe(false);
    expect(store[baseOpts.baselineFile]).toBe(good); // the good baseline was NOT clobbered
    expect(renderMeasureLearning(res)).toMatch(/no usable metrics/);
  });

  it("non-zero exit → non-fatal ok:false with the exit captured, no baseline write", async () => {
    const exec = okExec("", 1);
    const good = JSON.stringify({ p50_ms: { value: 100, goal: "min" } });
    const { store, deps } = memFs({ [baseOpts.baselineFile]: good });
    const res = await runMeasure(baseOpts, deps(exec.fn));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/exited 1/);
    expect(store[baseOpts.baselineFile]).toBe(good);
  });

  it("unsafe command (never ran) → ran:false, ok:false, no baseline write", async () => {
    const unsafeExec = async (_ws: string, command: string): Promise<ExecOutcome> => ({
      ran: false,
      command,
      unsafeReason: "chained command (&&) — single self-contained commands only",
    });
    const good = JSON.stringify({ p50_ms: { value: 100, goal: "min" } });
    const { store, deps } = memFs({ [baseOpts.baselineFile]: good });
    const res = await runMeasure(baseOpts, deps(unsafeExec));
    expect(res.ran).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/unsafe/);
    expect(store[baseOpts.baselineFile]).toBe(good);
  });
});

// ── cmdMeasure (standalone command, in-place, injected deps — no worktree/network) ─────────────
describe("cmdMeasure — standalone command", () => {
  const makeCtx = (): Ctx => {
    const paths = new Paths("/proj");
    const config = defaultConfig();
    config.measure = { ...config.measure, enabled: true, command: "npm run qa:metrics" };
    const store = StateStore.create(paths, "greenfield");
    return { root: "/proj", paths, config, store };
  };
  const memDeps = (exec: MeasureDeps["exec"], seed: Record<string, string> = {}) => {
    const store: Record<string, string> = { ...seed };
    const deps: MeasureDeps = {
      exec,
      readFile: async (f) => store[f] ?? null,
      writeFile: async (f, c) => {
        store[f] = c;
      },
    };
    return { store, deps };
  };
  const execOut = (stdout: string) => async (_ws: string, command: string, opts?: { allowPrefixes?: string[] }): Promise<ExecOutcome> => {
    void opts;
    return { ran: true, command, exitCode: 0, stdout, stderr: "", timedOut: false };
  };

  it("default is COMPARE-ONLY: runs the command, reports metrics, does NOT write the baseline", async () => {
    const ctx = makeCtx();
    const { store, deps } = memDeps(execOut(`{"metrics": {"p50_ms": 12.3}}`));
    const res = await cmdMeasure(ctx, {}, { measureDeps: deps });
    expect(res?.ok).toBe(true);
    expect(res?.baselineUpdated).toBe(false);
    expect(store[ctx.paths.measureBaseline]).toBeUndefined(); // compare-only never writes the baseline
    expect(res?.reportPath).toBeTruthy();
  });

  it("--set-baseline updates the baseline under the MAIN repo .sparra", async () => {
    const ctx = makeCtx();
    const { store, deps } = memDeps(execOut(`{"metrics": {"p50_ms": 12.3}}`));
    const res = await cmdMeasure(ctx, { setBaseline: true }, { measureDeps: deps });
    expect(res?.baselineUpdated).toBe(true);
    expect(store[ctx.paths.measureBaseline]).toBeTruthy();
    expect(JSON.parse(store[ctx.paths.measureBaseline]!)).toEqual({ p50_ms: { value: 12.3, goal: "min" } });
  });

  it("no measure.command → warns and returns undefined without running anything", async () => {
    const ctx = makeCtx();
    ctx.config.measure.command = "";
    let ran = false;
    const deps: MeasureDeps = {
      exec: async (_ws, command) => {
        ran = true;
        return { ran: true, command, exitCode: 0, stdout: "", stderr: "", timedOut: false };
      },
      readFile: async () => null,
      writeFile: async () => {},
    };
    const res = await cmdMeasure(ctx, {}, { measureDeps: deps });
    expect(res).toBeUndefined();
    expect(ran).toBe(false);
  });
});
