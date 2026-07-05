import { describe, it, expect } from "vitest";
import { selectMapContext } from "../src/build/mapContext.ts";

/**
 * Unit tests for the item-targeted CODEBASE_MAP selector. Pure function — no DI/session needed.
 * A CODEBASE_MAP with a filler head and a real section for `src/build/late.ts` placed PAST any
 * modest head cutoff, so head-slicing would drop it.
 */
const HEAD = `# Overview\n${"filler line describing unrelated modules.\n".repeat(60)}`;
const LATE_SECTION = `## src/build/late.ts\nThe late module: SENTINEL_LATE handles the tricky seam.\n`;
const OTHER_SECTION = `## src/build/other.ts\nUnrelated helper, no named path here.\n`;
const MAP = `${HEAD}${LATE_SECTION}${OTHER_SECTION}`;

describe("selectMapContext — absent/empty → exact head-slice (byte-for-byte today)", () => {
  it("undefined relevantPaths returns EXACTLY map.slice(0, cap)", () => {
    const cap = 200;
    expect(selectMapContext(MAP, undefined, cap)).toBe(MAP.slice(0, cap));
  });

  it("empty array returns EXACTLY map.slice(0, cap)", () => {
    const cap = 200;
    expect(selectMapContext(MAP, [], cap)).toBe(MAP.slice(0, cap));
  });

  it("an array of only empty-string entries is treated as empty → exact head-slice", () => {
    const cap = 200;
    // Defensive: the helper drops empty strings; a degenerate array still falls back byte-for-byte.
    expect(selectMapContext(MAP, ["", ""], cap)).toBe(MAP.slice(0, cap));
  });
});

describe("selectMapContext — present → item-targeting", () => {
  it("selects a section that sits PAST the head cutoff and lists the named path (head-slice would drop it)", () => {
    const cap = 400;
    // The late section starts well past cap in the raw map — a blind head-slice never reaches it.
    expect(MAP.indexOf("SENTINEL_LATE")).toBeGreaterThan(cap);
    const out = selectMapContext(MAP, ["src/build/late.ts"], cap);
    expect(out).toContain("SENTINEL_LATE"); // the targeted section text is present
    expect(out).toContain("Files most relevant to this item:");
    expect(out).toContain("- src/build/late.ts"); // named-path listing
    // Contrast: the plain head-slice at this cap does NOT contain the late seam.
    expect(MAP.slice(0, cap)).not.toContain("SENTINEL_LATE");
  });

  it("bounded: output length never exceeds cap even with an over-long map", () => {
    const big = `${HEAD}## src/build/late.ts\n${"SENTINEL_LATE detail. ".repeat(2000)}`;
    for (const cap of [50, 300, 1000]) {
      const out = selectMapContext(big, ["src/build/late.ts"], cap);
      expect(out.length).toBeLessThanOrEqual(cap);
    }
  });

  it("single-source: same call shape used by generate.ts (cap 5000) and contract.ts (cap 4000)", () => {
    // Both call sites route through this one helper; exercise both caps produce the targeted seam.
    expect(selectMapContext(MAP, ["src/build/late.ts"], 5000)).toContain("SENTINEL_LATE");
    expect(selectMapContext(MAP, ["src/build/late.ts"], 4000)).toContain("SENTINEL_LATE");
  });
});

describe("selectMapContext — robust on unknown paths", () => {
  it("a named path in no section (or nonexistent) does not throw and falls back to a head-slice-shaped context", () => {
    const cap = 400;
    let out = "";
    expect(() => {
      out = selectMapContext(MAP, ["does/not/exist.ts"], cap);
    }).not.toThrow();
    expect(out.length).toBeLessThanOrEqual(cap);
    // Head-slice-shaped: the fallback carries the head content (after the listing header).
    expect(out).toContain("# Overview");
    expect(out).toContain("Files most relevant to this item:");
    expect(out).toContain("- does/not/exist.ts");
  });

  it("empty map with a named path does not throw", () => {
    expect(() => selectMapContext("", ["src/x.ts"], 100)).not.toThrow();
  });
});
