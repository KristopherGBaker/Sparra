import { describe, it, expect } from "vitest";
import { budgetExceeded, remainingBudget } from "../src/build/budget.ts";

describe("budgetExceeded", () => {
  it("is false when the cap is 0 (unlimited) regardless of spend", () => {
    expect(budgetExceeded(0, 1000)).toBe(false);
    expect(budgetExceeded(-1, 1000)).toBe(false);
  });
  it("is false when spend is below the cap", () => {
    expect(budgetExceeded(5, 4.99)).toBe(false);
  });
  it("is true when spend reaches or passes the cap", () => {
    expect(budgetExceeded(5, 5)).toBe(true);
    expect(budgetExceeded(5, 6)).toBe(true);
  });
});

describe("remainingBudget", () => {
  it("returns 0 when there is no cap (0 = unlimited)", () => {
    expect(remainingBudget(0, 3)).toBe(0);
  });
  it("returns the remainder under a cap", () => {
    expect(remainingBudget(5, 2)).toBe(3);
  });
  it("never goes negative", () => {
    expect(remainingBudget(5, 9)).toBe(0);
  });
});
