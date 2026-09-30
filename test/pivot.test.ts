import { describe, it, expect } from "vitest";
import { updateStreaksAndDecide, updateAssertionStreaks, assertionsToEscalate } from "../src/build/pivot.ts";
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

  it("a BLOCKED exercise never pivots and never advances a streak — even repeated N+1 times", () => {
    const cfg = defaultConfig(); // N = 3
    const blocked: Verdict = { ...makeVerdict({ design: 0, originality: 0, craft: 0, functionality: 0 }), exerciseStatus: "blocked" };

    // Feed it more than N consecutive blocked rounds with 0 scores — must never pivot or count.
    let item = makeItem({ design: 5 }); // even with a pre-existing streak
    for (let i = 0; i < cfg.pivot.N + 1; i++) {
      const result = updateStreaksAndDecide(item, blocked, cfg);
      expect(result.pivot).toBe(false);
      expect(result.streaks.design).toBe(5); // unchanged — blocked doesn't move streaks
      item = makeItem(result.streaks);
    }
  });

  it("all-UN-RUN assertions never pivot and never advance a streak", () => {
    const cfg = defaultConfig();
    const allUnrun: Verdict = {
      ...makeVerdict({ design: 0, originality: 0, craft: 0, functionality: 0 }),
      assertions: [
        { id: 1, pass: false, evidence: "command not found" },
        { id: 2, pass: false, evidence: "CoreSimulator unavailable" },
      ],
      unrunAssertionIds: [1, 2],
      exerciseStatus: "mixed",
    };
    const item = makeItem({ design: 2 });
    const result = updateStreaksAndDecide(item, allUnrun, cfg);
    expect(result.pivot).toBe(false);
    expect(result.streaks.design).toBe(2);
  });

  it("mixed status alone does not block normal scoring when there are observed failures", () => {
    const cfg = defaultConfig();
    const mixedObservedFail: Verdict = {
      ...makeVerdict({ design: 40, originality: 70, craft: 80, functionality: 75 }),
      assertions: [
        { id: 1, pass: false, evidence: "observed product failure" },
        { id: 2, pass: false, evidence: "command not found" },
      ],
      unrunAssertionIds: [2],
      exerciseStatus: "mixed",
    };
    const result = updateStreaksAndDecide(makeItem({}), mixedObservedFail, cfg);
    expect(result.streaks.design).toBe(1);
  });
});

function assertionItem(streaks: Record<string, number> = {}): ItemState {
  return { status: "building", round: 1, pivots: 0, criterionFailStreak: {}, assertionFailStreak: streaks };
}

function assertionVerdict(assertions: Verdict["assertions"], over: Partial<Verdict> = {}): Verdict {
  return {
    assertions,
    scores: { design: 40, originality: 40, craft: 40, functionality: 40 },
    weightedTotal: 40,
    verdict: "fail",
    blocking: [],
    notes: "",
    ...over,
  };
}

describe("updateAssertionStreaks — per-assertion fail streaks (U2)", () => {
  it("increments a FAILED assertion's streak and resets a PASSED one", () => {
    const item = assertionItem({ "2": 1, "3": 4 });
    const v = assertionVerdict([
      { id: 2, pass: false, evidence: "still wrong" }, // fail → 1→2
      { id: 3, pass: true, evidence: "now ok" }, // pass → reset to 0
    ]);
    const out = updateAssertionStreaks(item, v);
    expect(out["2"]).toBe(2);
    expect(out["3"]).toBe(0);
  });

  it("resets a previously-tracked id that is NOT failing this round (passed) — no stale streak", () => {
    // Prior {2:2, 3:1}; only #3 fails now (#2 passes) → #3 → 2, #2 must drop to 0, not keep 2.
    const item = assertionItem({ "2": 2, "3": 1 });
    const v = assertionVerdict([
      { id: 2, pass: true, evidence: "fixed" },
      { id: 3, pass: false, evidence: "still failing" },
    ]);
    const out = updateAssertionStreaks(item, v);
    expect(out["3"]).toBe(2);
    expect(out["2"]).toBe(0); // reset, not the stale 2 (would spuriously escalate otherwise)
  });

  it("resets a previously-tracked id that is ABSENT from this round's assertions entirely", () => {
    // Prior {2:2, 3:1}; the verdict this round contains ONLY #3 (failing). #2 is gone → reset to 0.
    const item = assertionItem({ "2": 2, "3": 1 });
    const v = assertionVerdict([{ id: 3, pass: false, evidence: "still failing" }]);
    const out = updateAssertionStreaks(item, v);
    expect(out["3"]).toBe(2);
    expect(out["2"]).toBe(0); // absent = not failing → reset, no stale streak
  });

  it("starts a fresh assertion at streak 1 on its first failure", () => {
    const out = updateAssertionStreaks(assertionItem(), assertionVerdict([{ id: 5, pass: false, evidence: "boom" }]));
    expect(out["5"]).toBe(1);
  });

  it("a BLOCKED verdict advances NO assertion streak (mirrors the pivot guard)", () => {
    const item = assertionItem({ "2": 2 });
    const v = assertionVerdict([{ id: 2, pass: false, evidence: "x" }], { exerciseStatus: "blocked" });
    expect(updateAssertionStreaks(item, v)).toEqual({ "2": 2 }); // unchanged
  });

  it("does NOT mutate the item's stored streak map (returns a fresh object)", () => {
    const stored = { "2": 1 };
    const item = assertionItem(stored);
    updateAssertionStreaks(item, assertionVerdict([{ id: 2, pass: false, evidence: "x" }]));
    expect(stored).toEqual({ "2": 1 }); // original untouched
  });

  it("6b: an UN-RUN assertion neither increments nor triggers a streak", () => {
    const item = assertionItem({ "1": 1 });
    const v = assertionVerdict(
      [
        { id: 1, pass: false, evidence: "command not found" },
        { id: 2, pass: false, evidence: "real fail" },
      ],
      { unrunAssertionIds: [1], exerciseStatus: "mixed" }
    );
    const out = updateAssertionStreaks(item, v);
    expect(out["1"]).toBe(1); // un-run: left untouched, NOT incremented
    expect(out["2"]).toBe(1); // the run failure advances
  });

  it("6b: an ALL-un-run verdict leaves assertionFailStreak unchanged", () => {
    const item = assertionItem({ "1": 1, "2": 2 });
    const v = assertionVerdict(
      [
        { id: 1, pass: false, evidence: "not found" },
        { id: 2, pass: false, evidence: "no simulator" },
      ],
      { unrunAssertionIds: [1, 2], exerciseStatus: "mixed" }
    );
    expect(updateAssertionStreaks(item, v)).toEqual({ "1": 1, "2": 2 });
  });
});

describe("assertionsToEscalate — escalation trigger set (U2)", () => {
  const v = assertionVerdict([
    { id: 2, pass: false, evidence: "a" },
    { id: 3, pass: false, evidence: "b" },
    { id: 4, pass: true, evidence: "ok" },
  ]);

  it("returns failed ids at/over the threshold; passing ids and below-threshold ids excluded", () => {
    expect(assertionsToEscalate({ "2": 2, "3": 1 }, v, 2)).toEqual([2]);
  });

  it("disabled (after <= 0) never escalates, even at a high streak", () => {
    expect(assertionsToEscalate({ "2": 9 }, v, 0)).toEqual([]);
  });

  it("6b: an un-run failing id cannot escalate even at a high streak", () => {
    const unrun = assertionVerdict([{ id: 2, pass: false, evidence: "not found" }], { unrunAssertionIds: [2] });
    expect(assertionsToEscalate({ "2": 9 }, unrun, 2)).toEqual([]);
  });
});

describe("assertion streaks — non-numeric ids (\"6a\", \"6b\") keep SEPARATE keys", () => {
  it("two distinct failing string ids get separate streak keys (no shared NaN key)", () => {
    const v = assertionVerdict([
      { id: "6a", pass: false, evidence: "a" },
      { id: "6b", pass: false, evidence: "b" },
    ]);
    const first = updateAssertionStreaks(assertionItem(), v);
    expect(first).toEqual({ "6a": 1, "6b": 1 });
    expect(first["NaN"]).toBeUndefined();
    const second = updateAssertionStreaks(assertionItem(first), assertionVerdict([{ id: "6b", pass: false, evidence: "b" }, { id: "6a", pass: true, evidence: "ok" }]));
    expect(second).toEqual({ "6a": 0, "6b": 2 });
  });

  it("a tracked \"6b\" streak resets to 0 when 6b passes, and a tracked key ABSENT from the verdict also resets", () => {
    const passed = updateAssertionStreaks(assertionItem({ "6b": 3 }), assertionVerdict([{ id: "6b", pass: true, evidence: "ok" }, { id: 1, pass: false, evidence: "x" }]));
    expect(passed["6b"]).toBe(0);
    expect(passed["1"]).toBe(1);
    const absent = updateAssertionStreaks(assertionItem({ "6b": 3 }), assertionVerdict([{ id: 1, pass: false, evidence: "x" }]));
    expect(absent["6b"]).toBe(0);
  });

  it("a tracked \"6b\" streak is untouched when 6b is un-run", () => {
    const v = assertionVerdict(
      [{ id: "6b", pass: false, evidence: "env" }, { id: 1, pass: false, evidence: "real" }],
      { unrunAssertionIds: ["6b"] },
    );
    const out = updateAssertionStreaks(assertionItem({ "6b": 3 }), v);
    expect(out["6b"]).toBe(3);
    expect(out["1"]).toBe(1);
  });

  it("compares by key across number/string forms (verdict id 7 vs un-run \"7\")", () => {
    const v = assertionVerdict([{ id: 7, pass: false, evidence: "env" }, { id: 1, pass: false, evidence: "real" }], {
      unrunAssertionIds: ["7"],
    });
    const out = updateAssertionStreaks(assertionItem({ "7": 2 }), v);
    expect(out["7"]).toBe(2);
    expect(assertionsToEscalate({ "7": 9, "1": 9 }, v, 2)).toEqual([1]);
  });

  it("assertionsToEscalate returns \"6b\" at threshold, not below, and never an un-run string id", () => {
    const v = assertionVerdict([
      { id: "6b", pass: false, evidence: "b" },
      { id: "H4", pass: false, evidence: "env" },
    ], { unrunAssertionIds: ["H4"] });
    expect(assertionsToEscalate({ "6b": 2, H4: 9 }, v, 2)).toEqual(["6b"]);
    expect(assertionsToEscalate({ "6b": 1 }, v, 2)).toEqual([]);
  });
});

// ── Jev env-block annotation (`verdict.envBlock`): auto-band ids freeze the streaks ──
const flag = (id: number | string, band: "auto" | "suspect") => ({ id, noul: 0.95, choice: "environment_blocked", confidence: 0.9, band });
const withEnvBlock = (flags: ReturnType<typeof flag>[]): Partial<Verdict> => ({ envBlock: { model: "jev-1.13.0", assertions: flags } });

describe("envBlock auto band — pivot streaks (Jev, informational annotation)", () => {
  const cfg = defaultConfig(); // N = 3
  const lowScores = { design: 40, originality: 40, craft: 40, functionality: 40 };

  it("ALL failed runnable assertions auto → criterion streaks unchanged, no pivot, even at N-1", () => {
    const item = makeItem({ design: 2, craft: 2, originality: 0 });
    const v = assertionVerdict(
      [{ id: 1, pass: false, evidence: "EPERM" }, { id: 2, pass: false, evidence: "EPERM" }, { id: 3, pass: true, evidence: "ok" }],
      { scores: lowScores, ...withEnvBlock([flag(1, "auto"), flag(2, "auto")]) },
    );
    const out = updateStreaksAndDecide(item, v, cfg);
    expect(out.pivot).toBe(false);
    expect(out.criterion).toBeUndefined();
    expect(out.streaks).toEqual({ design: 2, craft: 2, originality: 0 });
  });

  it("un-run ids are not failed-runnable: one auto + the rest un-run is still all-auto", () => {
    const v = assertionVerdict(
      [{ id: 1, pass: false, evidence: "EPERM" }, { id: 2, pass: false, evidence: "no simulator" }],
      { scores: lowScores, unrunAssertionIds: [2], ...withEnvBlock([flag(1, "auto")]) },
    );
    const out = updateStreaksAndDecide(makeItem({ design: 2 }), v, cfg);
    expect(out.pivot).toBe(false);
    expect(out.streaks.design).toBe(2);
  });

  it("one auto + one non-flagged failure → the normal advance (and pivot at N)", () => {
    const v = assertionVerdict([{ id: 1, pass: false, evidence: "EPERM" }, { id: 2, pass: false, evidence: "wrong sum" }], {
      scores: lowScores,
      ...withEnvBlock([flag(1, "auto")]),
    });
    const out = updateStreaksAndDecide(makeItem({ design: 2 }), v, cfg);
    expect(out.pivot).toBe(true);
    expect(out.criterion).toBe("design");
    expect(out.streaks.design).toBe(3);
  });

  it("auto + a failure flagged only SUSPECT → normal advance", () => {
    const v = assertionVerdict([{ id: 1, pass: false, evidence: "EPERM" }, { id: 2, pass: false, evidence: "maybe env" }], {
      scores: lowScores,
      ...withEnvBlock([flag(1, "auto"), flag(2, "suspect")]),
    });
    expect(updateStreaksAndDecide(makeItem({ design: 1 }), v, cfg).streaks.design).toBe(2);
  });

  it("suspect-only has NO effect on any of the three functions", () => {
    const failing = [{ id: 1, pass: false, evidence: "maybe env" }];
    const plain = assertionVerdict(failing, { scores: lowScores });
    const suspect = assertionVerdict(failing, { scores: lowScores, ...withEnvBlock([flag(1, "suspect")]) });
    expect(updateStreaksAndDecide(makeItem({ design: 2 }), suspect, cfg)).toEqual(updateStreaksAndDecide(makeItem({ design: 2 }), plain, cfg));
    expect(updateAssertionStreaks(assertionItem({ "1": 1 }), suspect)).toEqual(updateAssertionStreaks(assertionItem({ "1": 1 }), plain));
    expect(assertionsToEscalate({ "1": 5 }, suspect, 2)).toEqual([1]);
  });

  it("an auto id's assertion streak is neither advanced nor reset; assertionsToEscalate excludes it", () => {
    const v = assertionVerdict(
      [{ id: 1, pass: false, evidence: "EPERM" }, { id: "6b", pass: false, evidence: "real" }, { id: 3, pass: true, evidence: "ok" }],
      withEnvBlock([flag(1, "auto")]),
    );
    const out = updateAssertionStreaks(assertionItem({ "1": 2, "6b": 1, "3": 4, "9": 3 }), v);
    expect(out["1"]).toBe(2); // frozen, like an un-run id
    expect(out["6b"]).toBe(2); // the real failure advances
    expect(out["3"]).toBe(0); // a pass still resets
    expect(out["9"]).toBe(0); // a tracked id ABSENT from the verdict still resets
    expect(assertionsToEscalate({ "1": 9, "6b": 9 }, v, 2)).toEqual(["6b"]);
  });

  it("an ALL-auto-failing verdict keeps the auto streak while the passing sibling resets", () => {
    const v = assertionVerdict([{ id: 1, pass: false, evidence: "EPERM" }, { id: 2, pass: true, evidence: "ok" }], withEnvBlock([flag(1, "auto")]));
    const out = updateAssertionStreaks(assertionItem({ "1": 2, "2": 3 }), v);
    expect(out).toEqual({ "1": 2, "2": 0 });
  });

  it("matches auto ids by KEY across number/string forms", () => {
    const v = assertionVerdict([{ id: 7, pass: false, evidence: "EPERM" }], { scores: lowScores, ...withEnvBlock([flag("7", "auto")]) });
    expect(updateStreaksAndDecide(makeItem({ design: 2 }), v, cfg).pivot).toBe(false);
    expect(assertionsToEscalate({ "7": 9 }, v, 2)).toEqual([]);
  });

  it("a verdict WITHOUT envBlock behaves exactly as before (and an empty annotation is inert)", () => {
    const failing = [{ id: 1, pass: false, evidence: "EPERM" }];
    const plain = assertionVerdict(failing, { scores: lowScores });
    const empty = assertionVerdict(failing, { scores: lowScores, ...withEnvBlock([]) });
    const out = updateStreaksAndDecide(makeItem({ design: 2 }), plain, cfg);
    expect(out.pivot).toBe(true);
    expect(updateStreaksAndDecide(makeItem({ design: 2 }), empty, cfg)).toEqual(out);
  });
});
