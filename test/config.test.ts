import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The logger is a no-op under vitest; replace `warn` with a spy so the normalization warns can be counted.
vi.mock("../src/util/log.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/util/log.ts")>()),
  warn: vi.fn(),
}));

import { warn } from "../src/util/log.ts";
import { normalizeEnvBlockJudgeConfig } from "../src/build/envBlockJudge.ts";
import { deepMerge, defaultConfig, loadConfig, writeDefaultConfig, type SparraConfig } from "../src/config.ts";
import { allowVerifyBash } from "../src/sdk/scoping.ts";
import { Paths } from "../src/paths.ts";

describe("deepMerge", () => {
  it("scalar override: {a:1} + {a:2} → {a:2}", () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it("nested object merge: {a:{b:1}} + {a:{c:2}} → {a:{b:1,c:2}}", () => {
    expect(deepMerge({ a: { b: 1 } }, { a: { c: 2 } })).toEqual({ a: { b: 1, c: 2 } });
  });

  it("array replacement (not merge): {a:[1,2]} + {a:[3]} → {a:[3]}", () => {
    expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });

  it("keys absent in over are preserved from base", () => {
    expect(deepMerge({ a: 1, b: 2 }, { a: 99 })).toEqual({ a: 99, b: 2 });
  });

  it("over=null returns base unchanged", () => {
    expect(deepMerge({ a: 1 }, null)).toEqual({ a: 1 });
  });

  it("deeply nested merge preserves sibling keys", () => {
    const base = { x: { y: { z: 1, w: 2 } } };
    const over = { x: { y: { z: 9 } } };
    expect(deepMerge(base, over)).toEqual({ x: { y: { z: 9, w: 2 } } });
  });
});

describe("exercise.sandbox knob", () => {
  it("defaults to workspace-write", () => {
    expect(defaultConfig().exercise.sandbox).toBe("workspace-write");
  });

  it("a YAML override of exercise.sandbox loads as read-only (deepMerge over defaults)", () => {
    const merged = deepMerge<SparraConfig>(defaultConfig(), { exercise: { sandbox: "read-only" } });
    expect(merged.exercise.sandbox).toBe("read-only");
    // Sibling exercise.* knobs survive the partial merge.
    expect(merged.exercise.mechanism).toBe("cli");
    expect(merged.exercise.runExistingTests).toBe(true);
  });

  it("accepts the opt-in danger-full-access exercise sandbox (the iOS/CoreSimulatorService mode)", () => {
    const merged = deepMerge<SparraConfig>(defaultConfig(), { exercise: { sandbox: "danger-full-access" } });
    expect(merged.exercise.sandbox).toBe("danger-full-access");
  });
});

describe("build.distillTechnique knob", () => {
  it("defaults to false", () => {
    expect(defaultConfig().build.distillTechnique).toBe(false);
  });

  it("a partial YAML override to true is respected and keeps sibling build.* knobs", () => {
    const merged = deepMerge<SparraConfig>(defaultConfig(), { build: { distillTechnique: true } });
    expect(merged.build.distillTechnique).toBe(true);
    // Sibling build.* knobs survive the partial merge.
    expect(merged.build.maxRoundsPerItem).toBe(defaultConfig().build.maxRoundsPerItem);
    expect(merged.build.preflightVerify).toBe(false);
  });

  it("is loaded from a YAML config file (loadConfig parses + respects the override)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-config-"));
    const paths = new Paths(dir);
    await paths.ensureScaffold();
    fs.writeFileSync(paths.config, "build:\n  distillTechnique: true\n");
    const cfg = await loadConfig(paths);
    expect(cfg.build.distillTechnique).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("exercise.ios.visual knob", () => {
  it("defaults to true", () => {
    expect(defaultConfig().exercise.ios.visual).toBe(true);
  });

  it("a partial YAML override to false keeps sibling ios.* knobs", () => {
    const merged = deepMerge<SparraConfig>(defaultConfig(), { exercise: { ios: { visual: false } } });
    expect(merged.exercise.ios.visual).toBe(false);
    expect(merged.exercise.ios.cli).toBe("xcodebuildmcp"); // sibling ios.* knob survives the partial merge
    expect(merged.exercise.ios.platform).toBe("ios");
    expect(merged.exercise.mechanism).toBe("cli"); // sibling exercise.* knob survives
  });

  it("appears in the seeded config output (writeDefaultConfig YAML)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-config-"));
    const paths = new Paths(dir);
    await paths.ensureScaffold();
    await writeDefaultConfig(paths, "existing");
    const yaml = fs.readFileSync(paths.config, "utf8");
    expect(yaml).toMatch(/visual: true/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("git.provisionDeps knob", () => {
  it("defaults to { enabled: true, dirs: ['node_modules'], swiftPackages: true }", () => {
    expect(defaultConfig().git.provisionDeps).toEqual({ enabled: true, dirs: ["node_modules"], swiftPackages: true });
  });

  it("a partial YAML override of enabled keeps dirs, swiftPackages AND sibling git knobs", () => {
    const merged = deepMerge<SparraConfig>(defaultConfig(), { git: { provisionDeps: { enabled: false } } });
    expect(merged.git.provisionDeps.enabled).toBe(false);
    expect(merged.git.provisionDeps.dirs).toEqual(["node_modules"]); // sibling key survives the partial merge
    expect(merged.git.provisionDeps.swiftPackages).toBe(true); // sibling key survives the partial merge
    expect(merged.git.strategy).toBe("worktree"); // sibling git.* knob survives
  });
});

describe("build.verifyCommands knob", () => {
  it("defaults to a non-empty list including npm test + tsc", () => {
    const v = defaultConfig().build.verifyCommands;
    expect(v.length).toBeGreaterThan(0);
    expect(v).toContain("npm test");
    expect(v).toContain("tsc");
  });

  it("the default list contains NO package-fetching (npx) or mutating/install entries", () => {
    const v = defaultConfig().build.verifyCommands;
    expect(v.some((c) => c.includes("npx"))).toBe(false);
    expect(v.some((c) => /install|publish|\brm\b|git (commit|push)|curl|wget/.test(c))).toBe(false);
    // And every default entry is itself auto-approvable (none would be self-disqualified).
    for (const c of v) expect(allowVerifyBash("Bash", { command: c }, v)).toMatch(/Auto-approved/);
  });

  it("a YAML override replaces the array (deepMerge), siblings preserved", () => {
    const merged = deepMerge<SparraConfig>(defaultConfig(), { build: { verifyCommands: ["npm test"] } });
    expect(merged.build.verifyCommands).toEqual(["npm test"]);
    expect(merged.build.maxRoundsPerItem).toBe(defaultConfig().build.maxRoundsPerItem); // sibling survives
  });
});

describe("build.zeroCostTokenCap knob", () => {
  it("defaults to 0 (off)", () => {
    expect(defaultConfig().build.zeroCostTokenCap).toBe(0);
  });

  it("a partial YAML override preserves sibling build knobs", () => {
    const merged = deepMerge<SparraConfig>(defaultConfig(), { build: { zeroCostTokenCap: 750_000 } });
    expect(merged.build.zeroCostTokenCap).toBe(750_000);
    expect(merged.build.maxTokensPerItem).toBe(defaultConfig().build.maxTokensPerItem);
    expect(merged.build.maxBudgetUsdPerItem).toBe(defaultConfig().build.maxBudgetUsdPerItem);
  });
});

describe("build.assertionEscalateAfter knob (U2)", () => {
  it("defaults to 2", () => {
    expect(defaultConfig().build.assertionEscalateAfter).toBe(2);
  });

  it("a YAML override (including 0 = disabled) is parsed and respected, siblings preserved", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-config-"));
    const paths = new Paths(dir);
    await paths.ensureScaffold();
    fs.writeFileSync(paths.config, "build:\n  assertionEscalateAfter: 0\n");
    const cfg = await loadConfig(paths);
    expect(cfg.build.assertionEscalateAfter).toBe(0);
    expect(cfg.build.maxRoundsPerItem).toBe(defaultConfig().build.maxRoundsPerItem);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a partial YAML override preserves sibling build knobs (deepMerge)", () => {
    const merged = deepMerge<SparraConfig>(defaultConfig(), { build: { assertionEscalateAfter: 4 } });
    expect(merged.build.assertionEscalateAfter).toBe(4);
    expect(merged.build.escalateAfterRounds).toBe(defaultConfig().build.escalateAfterRounds);
    expect(merged.build.verifyCommands).toEqual(defaultConfig().build.verifyCommands);
  });
});

describe("build.preflightVerify knob", () => {
  it("defaults to false (off)", () => {
    expect(defaultConfig().build.preflightVerify).toBe(false);
  });

  it("a YAML config with preflightVerify: true is parsed and respected, siblings preserved", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-config-"));
    const paths = new Paths(dir);
    await paths.ensureScaffold();
    fs.writeFileSync(paths.config, "build:\n  preflightVerify: true\n");
    const cfg = await loadConfig(paths);
    expect(cfg.build.preflightVerify).toBe(true);
    // A partial override must not clobber unrelated build knobs.
    expect(cfg.build.maxRoundsPerItem).toBe(defaultConfig().build.maxRoundsPerItem);
    expect(cfg.build.flakinessReruns).toBe(defaultConfig().build.flakinessReruns);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a partial YAML override preserves sibling build knobs (deepMerge)", () => {
    const merged = deepMerge<SparraConfig>(defaultConfig(), { build: { preflightVerify: true } });
    expect(merged.build.preflightVerify).toBe(true);
    expect(merged.build.maxTokensPerItem).toBe(defaultConfig().build.maxTokensPerItem);
    expect(merged.build.verifyCommands).toEqual(defaultConfig().build.verifyCommands);
  });
});

describe("rubric.anchorFunctionality knob (Q4)", () => {
  it("defaults to true", () => {
    expect(defaultConfig().rubric.anchorFunctionality).toBe(true);
  });

  it("appears in the seeded config output (writeDefaultConfig YAML)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-config-"));
    const paths = new Paths(dir);
    await paths.ensureScaffold();
    await writeDefaultConfig(paths, "existing");
    const yaml = fs.readFileSync(paths.config, "utf8");
    expect(yaml).toContain("anchorFunctionality: true");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a YAML override of false merges over the default, rubric siblings preserved", () => {
    const merged = deepMerge<SparraConfig>(defaultConfig(), { rubric: { anchorFunctionality: false } });
    expect(merged.rubric.anchorFunctionality).toBe(false);
    expect(merged.rubric.passThreshold).toBe(defaultConfig().rubric.passThreshold); // sibling survives
  });
});

describe("evaluator.envBlockJudge (Jev env-blocked annotation)", () => {
  it("defaults equal the documented block, and are opt-in", () => {
    expect(defaultConfig().evaluator.envBlockJudge).toEqual({
      enabled: false,
      model: "jev-1.13.0",
      apiKeyEnv: "TYPESAFE_API_KEY",
      autoNoul: 0.8,
      autoConfidence: 0.8,
      suspectNoul: 0.5,
      concurrency: 4,
      timeoutMs: 8000,
    });
  });

  it("a config without it deep-merges to the defaults; a partial block merges over them (secondOpinion sibling kept)", () => {
    const merged = deepMerge<SparraConfig>(defaultConfig(), { evaluator: { secondOpinion: { enabled: true } } });
    expect(merged.evaluator.envBlockJudge).toEqual(defaultConfig().evaluator.envBlockJudge);
    const partial = deepMerge<SparraConfig>(defaultConfig(), { evaluator: { envBlockJudge: { enabled: true, autoNoul: 0.9 } } });
    expect(partial.evaluator.envBlockJudge).toEqual({ ...defaultConfig().evaluator.envBlockJudge, enabled: true, autoNoul: 0.9 });
    expect(partial.evaluator.secondOpinion.enabled).toBe(false);
  });

  it("normalize: valid values pass through with no warn", () => {
    vi.mocked(warn).mockClear();
    const good = { enabled: true, model: "jev-x", apiKeyEnv: "K", autoNoul: 0.9, autoConfidence: 0.7, suspectNoul: 0.9, concurrency: 2, timeoutMs: 100 };
    expect(normalizeEnvBlockJudgeConfig(good)).toEqual(good);
    expect(normalizeEnvBlockJudgeConfig(undefined)).toEqual(defaultConfig().evaluator.envBlockJudge);
    expect(vi.mocked(warn)).not.toHaveBeenCalled();
  });

  it.each([
    ["autoNoul: 1.5", { autoNoul: 1.5 }],
    ["autoNoul: NaN", { autoNoul: Number.NaN }],
    ["autoConfidence: -0.1", { autoConfidence: -0.1 }],
    ["suspectNoul: '0.5'", { suspectNoul: "0.5" }],
    ["concurrency: 0", { concurrency: 0 }],
    ["concurrency: 1.5", { concurrency: 1.5 }],
    ["timeoutMs: -1", { timeoutMs: -1 }],
    ["timeoutMs: '5'", { timeoutMs: "5" }],
    ["model: ''", { model: "" }],
    ["apiKeyEnv: 7", { apiKeyEnv: 7 }],
  ])("normalize: invalid %s → default for it, exactly one warn", (_n, bad) => {
    vi.mocked(warn).mockClear();
    const def = defaultConfig().evaluator.envBlockJudge;
    const out = normalizeEnvBlockJudgeConfig({ enabled: true, ...bad } as never);
    expect(vi.mocked(warn)).toHaveBeenCalledTimes(1);
    expect(out.enabled).toBe(true);
    for (const k of Object.keys(bad) as (keyof typeof def)[]) expect(out[k]).toBe(def[k]);
  });

  it.each([["yes"], [1], [null], [{}]])("normalize: non-boolean enabled %j → default false, one warn naming `enabled`", (enabled) => {
    vi.mocked(warn).mockClear();
    const out = normalizeEnvBlockJudgeConfig({ enabled } as never);
    expect(out.enabled).toBe(false);
    expect(vi.mocked(warn)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(warn).mock.calls[0]![0])).toContain("enabled");
  });

  it("normalize: enabled true/false/absent are valid → no warn", () => {
    vi.mocked(warn).mockClear();
    expect(normalizeEnvBlockJudgeConfig({ enabled: true }).enabled).toBe(true);
    expect(normalizeEnvBlockJudgeConfig({ enabled: false }).enabled).toBe(false);
    expect(normalizeEnvBlockJudgeConfig({}).enabled).toBe(false);
    expect(vi.mocked(warn)).not.toHaveBeenCalled();
  });

  it("normalize: suspectNoul above autoNoul falls back to BOTH defaults with one warn", () => {
    vi.mocked(warn).mockClear();
    const out = normalizeEnvBlockJudgeConfig({ suspectNoul: 0.95, autoNoul: 0.6 });
    expect(out.suspectNoul).toBe(0.5);
    expect(out.autoNoul).toBe(0.8);
    expect(vi.mocked(warn)).toHaveBeenCalledTimes(1);
  });

  it("normalize: several invalid values still produce ONE warn naming them", () => {
    vi.mocked(warn).mockClear();
    const out = normalizeEnvBlockJudgeConfig({ autoNoul: 1.5, concurrency: 0, timeoutMs: 0 } as never);
    expect(out).toEqual(defaultConfig().evaluator.envBlockJudge);
    expect(vi.mocked(warn)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(warn).mock.calls[0]![0])).toMatch(/autoNoul.*concurrency.*timeoutMs/);
  });
});
