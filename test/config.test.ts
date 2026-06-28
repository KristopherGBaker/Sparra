import { describe, it, expect } from "vitest";
import { deepMerge, defaultConfig, type SparraConfig } from "../src/config.ts";

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
