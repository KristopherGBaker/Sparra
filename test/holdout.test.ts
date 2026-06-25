import { describe, it, expect } from "vitest";
import { holdoutSection, assertNoHoldoutLeak } from "../src/build/holdout.ts";

describe("holdoutSection", () => {
  it("is empty when there is no holdout", () => {
    expect(holdoutSection("")).toBe("");
    expect(holdoutSection("   ")).toBe("");
  });
  it("labels the holdout for the evaluator and marks failures blocking", () => {
    const s = holdoutSection("- Entering a 6-digit code logs in within 2 seconds.");
    expect(s).toMatch(/HOLDOUT ACCEPTANCE CHECKS/);
    expect(s).toMatch(/BLOCKING/);
    expect(s).toContain("6-digit code");
  });
});

describe("assertNoHoldoutLeak (the code-enforced isolation wall)", () => {
  const holdout = "- Entering a 6-digit code logs in within 2 seconds.\n- Tapping logout clears the session token.";

  it("does nothing when there is no holdout", () => {
    expect(() => assertNoHoldoutLeak("generator", "any prompt with the 6-digit code text", "")).not.toThrow();
  });

  it("does nothing when the prompt is clean", () => {
    expect(() => assertNoHoldoutLeak("generator", "Build a login screen per the contract.", holdout)).not.toThrow();
  });

  it("throws if a substantive holdout line leaks into the builder prompt", () => {
    const leaky = "Build it.\nAlso make sure: Entering a 6-digit code logs in within 2 seconds.\n";
    expect(() => assertNoHoldoutLeak("generator", leaky, holdout)).toThrow(/Holdout leaked into the generator/);
  });

  it("ignores short/structural lines (no false positives on markers)", () => {
    const h = "## Checks\n- ok\n";
    expect(() => assertNoHoldoutLeak("contract-generator", "## Checks\n- ok\nbuild the thing", h)).not.toThrow();
  });
});
