import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deepMerge, defaultConfig, writeDefaultConfig, type SparraConfig } from "../src/config.ts";
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
});

describe("git.provisionDeps knob", () => {
  it("defaults to { enabled: true, dirs: ['node_modules'] }", () => {
    expect(defaultConfig().git.provisionDeps).toEqual({ enabled: true, dirs: ["node_modules"] });
  });

  it("a partial YAML override of enabled keeps dirs AND sibling git knobs", () => {
    const merged = deepMerge<SparraConfig>(defaultConfig(), { git: { provisionDeps: { enabled: false } } });
    expect(merged.git.provisionDeps.enabled).toBe(false);
    expect(merged.git.provisionDeps.dirs).toEqual(["node_modules"]); // sibling key survives the partial merge
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
