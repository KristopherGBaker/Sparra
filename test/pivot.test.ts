import { describe, it, expect } from "vitest";
import { updateStreaksAndDecide } from "../src/build/pivot.ts";
import { defaultConfig } from "../src/config.ts";
import type { ItemState } from "../src/state.ts";
import type { Verdict } from "../src/build/types.ts";

function makeVerdict(scores: { design: number; originality: number; craft: number; functionality: number }): Verdict {
  return {
    assertions: [],
    scores,
    weightedTotal: 0,
    verdict: "fail",
    blocking: [],
    notes: "",
  };
}

function makeItem(streaks: Record<string, number> = {}): ItemState {
  return {
    status: "building",
    round: 1,
    pivots: 0,
    criterionFailStreak: streaks,
  };
}

describe("updateStreaksAndDecide", () => {
  it("resets all streaks to 0 when every criterion score is at or above the threshold", () => {
    const cfg = defaultConfig(); // pivot.threshold = 50
    const item = makeItem({ design: 2, craft: 1 });
    const verdict = makeVerdict({ design: 60, originality: 70, craft: 80, functionality: 75 });

    const result = updateStreaksAndDecide(item, verdict, cfg);

    expect(result.pivot).toBe(false);
    expect(result.streaks.design).toBe(0);
    expect(result.streaks.craft).toBe(0);
    expect(result.streaks.originality).toBe(0);
    expect(result.streaks.functionality).toBe(0);
  });

  it("increments the fail streak for a criterion that scores below the threshold", () => {
    const cfg = defaultConfig();
    const item = makeItem({});
    const verdict = makeVerdict({ design: 40, originality: 70, craft: 80, functionality: 75 });

    const result = updateStreaksAndDecide(item, verdict, cfg);

    expect(result.pivot).toBe(false);
    expect(result.streaks.design).toBe(1);
    expect(result.streaks.originality).toBe(0);
  });

  it("does not trigger pivot before N consecutive failures", () => {
    const cfg = defaultConfig(); // N = 3
    const item = makeItem({ design: 1 }); // streak at 1 already
    const verdict = makeVerdict({ design: 40, originality: 70, craft: 80, functionality: 75 });

    const result = updateStreaksAndDecide(item, verdict, cfg);

    expect(result.pivot).toBe(false);
    expect(result.streaks.design).toBe(2);
  });

  it("CRITICAL: triggers pivot at N=3 consecutive failures on the same criterion (threaded state)", () => {
    const cfg = defaultConfig(); // pivot.N = 3, pivot.threshold = 50
    const allFail = makeVerdict({ design: 40, originality: 70, craft: 80, functionality: 75 });

    // Round 1
    let item = makeItem({});
    const result1 = updateStreaksAndDecide(item, allFail, cfg);
    expect(result1.pivot).toBe(false);
    expect(result1.streaks["design"]).toBe(1);

    // Round 2 — thread streaks from round 1
    item = makeItem(result1.streaks);
    const result2 = updateStreaksAndDecide(item, allFail, cfg);
    expect(result2.pivot).toBe(false);
    expect(result2.streaks["design"]).toBe(2);

    // Round 3 — thread streaks from round 2 — streak reaches N=3, pivot fires
    item = makeItem(result2.streaks);
    const result3 = updateStreaksAndDecide(item, allFail, cfg);
    expect(result3.pivot).toBe(true);
    expect(result3.criterion).toBe("design");
    expect(result3.streaks["design"]).toBe(3);
  });

  it("resets a streak after a passing round interrupts consecutive failures", () => {
    const cfg = defaultConfig();
    const item = makeItem({ design: 2 }); // two failures so far
    const passVerdict = makeVerdict({ design: 55, originality: 70, craft: 80, functionality: 75 });

    const result = updateStreaksAndDecide(item, passVerdict, cfg);

    expect(result.pivot).toBe(false);
    expect(result.streaks.design).toBe(0); // reset because score >= threshold
  });
});
