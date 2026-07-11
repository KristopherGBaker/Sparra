import { describe, expect, it, vi } from "vitest";

import {
  decideFromEvaluation,
  runBuildCycle,
  type BuildCycleConfig,
  type ParentSummary,
  type RoundContext,
} from "./index.ts";

/** Minimal required fields for a well-formed ParentSummary, so hand-built fixtures below don't need
 *  risky `as ParentSummary` casts over partial objects. Mirrors the pattern in
 *  `conductors/pi/roleRunner.test.ts`. */
function baseSummary(overrides: Partial<ParentSummary>): ParentSummary {
  return {
    roleKind: "generator",
    backend: "stub",
    model: "stub-model-1",
    ok: true,
    errors: [],
    tokens: 0,
    costUsd: 0,
    ...overrides,
  };
}

const genSummary = (round: number) =>
  baseSummary({ roleKind: "generator", model: "sonnet", filesChanged: round });

/** Build a scripted `RoleRunner` from an alternating queue of [generator, evaluator, generator,
 *  evaluator, ...] summaries. Also records every spec handed to it, keyed by call index, so tests
 *  can inspect what `generatorSpec`/`evaluatorSpec` received via their `RoundContext`. */
function scriptedRunner(queue: ParentSummary[]) {
  let i = 0;
  const calls: ParentSummary[] = [];
  const runRole = vi.fn(async () => {
    const next = queue[i];
    i++;
    if (!next) throw new Error(`scriptedRunner: queue exhausted at call ${i}`);
    calls.push(next);
    return next;
  });
  return { runRole, calls };
}

describe("decideFromEvaluation (pure)", () => {
  const config = { pivotAfterFailures: 2, requireCrossModel: true };

  it("accept: verdict pass, cross-model", () => {
    const evaluator = baseSummary({ verdict: "pass", sameModelGrade: false });
    expect(decideFromEvaluation(evaluator, { consecutiveFailures: 0 }, config)).toBe("accept");
  });

  it("grade-not-independent: sameModelGrade true even with verdict pass (the cross-model gate)", () => {
    const evaluator = baseSummary({ verdict: "pass", sameModelGrade: true });
    expect(decideFromEvaluation(evaluator, { consecutiveFailures: 0 }, config)).toBe(
      "grade-not-independent",
    );
  });

  it("revise: verdict fail, below pivot threshold", () => {
    const evaluator = baseSummary({ verdict: "fail", blocking: ["x"] });
    expect(decideFromEvaluation(evaluator, { consecutiveFailures: 0 }, config)).toBe("revise");
  });

  it("pivot: verdict fail, at pivot threshold", () => {
    const evaluator = baseSummary({ verdict: "fail", blocking: ["x"] });
    expect(decideFromEvaluation(evaluator, { consecutiveFailures: 1 }, config)).toBe("pivot");
  });

  it("inconclusive: null verdict", () => {
    const evaluator = baseSummary({ verdict: null });
    expect(decideFromEvaluation(evaluator, { consecutiveFailures: 0 }, config)).toBe("inconclusive");
  });

  it("inconclusive: undefined verdict (field entirely absent)", () => {
    const evaluator = baseSummary({});
    delete (evaluator as Record<string, unknown>).verdict;
    expect(decideFromEvaluation(evaluator, { consecutiveFailures: 0 }, config)).toBe("inconclusive");
  });

  it("requireCrossModel:false lets a same-model pass through as accept", () => {
    const evaluator = baseSummary({ verdict: "pass", sameModelGrade: true });
    expect(
      decideFromEvaluation(evaluator, { consecutiveFailures: 0 }, { ...config, requireCrossModel: false }),
    ).toBe("accept");
  });
});

describe("runBuildCycle", () => {
  it("accepts on round 1 when the evaluator passes", async () => {
    const { runRole, calls } = scriptedRunner([
      genSummary(1),
      baseSummary({ roleKind: "evaluator", verdict: "pass", weightedTotal: 92, passThreshold: 75, sameModelGrade: false }),
    ]);
    const config: BuildCycleConfig = {
      generatorSpec: () => ({ args: ["role", "run", "--kind", "generator"] }),
      evaluatorSpec: () => ({ args: ["role", "run", "--kind", "evaluator"] }),
    };
    const result = await runBuildCycle({ runRole }, config);
    expect(result.outcome).toBe("accepted");
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]!.decision).toBe("accept");
    expect(result.finalVerdict?.verdict).toBe("pass");
    expect(calls).toHaveLength(2);
  });

  it("revises then accepts, threading round-1 evaluator.blocking as round-2 feedback", async () => {
    const round1Blocking = ["assertion-3 failed: missing null check"];
    const { runRole } = scriptedRunner([
      genSummary(1),
      baseSummary({
        roleKind: "evaluator",
        verdict: "fail",
        weightedTotal: 40,
        passThreshold: 75,
        blocking: round1Blocking,
        sameModelGrade: false,
      }),
      genSummary(2),
      baseSummary({
        roleKind: "evaluator",
        verdict: "pass",
        weightedTotal: 90,
        passThreshold: 75,
        sameModelGrade: false,
      }),
    ]);

    const capturedGeneratorCtx: RoundContext[] = [];
    const config: BuildCycleConfig = {
      generatorSpec: (ctx) => {
        capturedGeneratorCtx.push(ctx);
        return { args: ["role", "run", "--kind", "generator"] };
      },
      evaluatorSpec: () => ({ args: ["role", "run", "--kind", "evaluator"] }),
    };

    const result = await runBuildCycle({ runRole }, config);
    expect(result.outcome).toBe("accepted");
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]!.decision).toBe("revise");
    expect(result.rounds[1]!.decision).toBe("accept");

    // Round 1 generator saw no feedback yet; round 2 generator received round-1's blocking.
    expect(capturedGeneratorCtx[0]!.feedback).toEqual([]);
    expect(capturedGeneratorCtx[1]!.feedback).toEqual(round1Blocking);
    expect(capturedGeneratorCtx[1]!.round).toBe(2);
  });

  it("pivots after pivotAfterFailures consecutive fails, and threads pivoting:true into the next round", async () => {
    const { runRole } = scriptedRunner([
      genSummary(1),
      baseSummary({ roleKind: "evaluator", verdict: "fail", blocking: ["fail-1"], sameModelGrade: false }),
      genSummary(2),
      baseSummary({ roleKind: "evaluator", verdict: "fail", blocking: ["fail-2"], sameModelGrade: false }),
      genSummary(3),
      baseSummary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false }),
    ]);

    const capturedGeneratorCtx: RoundContext[] = [];
    const config: BuildCycleConfig = {
      generatorSpec: (ctx) => {
        capturedGeneratorCtx.push(ctx);
        return { args: ["role", "run", "--kind", "generator"] };
      },
      evaluatorSpec: () => ({ args: ["role", "run", "--kind", "evaluator"] }),
      pivotAfterFailures: 2,
      maxRounds: 5,
    };

    const result = await runBuildCycle({ runRole }, config);
    expect(result.rounds[0]!.decision).toBe("revise"); // 1st fail, below threshold
    expect(result.rounds[1]!.decision).toBe("pivot"); // 2nd consecutive fail, at threshold
    expect(result.outcome).toBe("accepted");

    // Round 1 (index 0) never pivoting; round 2 (index 1, the fail) not pivoting yet either since
    // pivoting reflects whether THIS round was entered post-pivot; round 3 (index 2) is post-pivot.
    expect(capturedGeneratorCtx[0]!.pivoting).toBe(false);
    expect(capturedGeneratorCtx[1]!.pivoting).toBe(false);
    expect(capturedGeneratorCtx[2]!.pivoting).toBe(true);
    expect(capturedGeneratorCtx[2]!.round).toBe(3);
  });

  it("returns grade-not-independent immediately (does not loop) when sameModelGrade is true, even on a pass", async () => {
    const { runRole, calls } = scriptedRunner([
      genSummary(1),
      baseSummary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: true }),
    ]);
    const config: BuildCycleConfig = {
      generatorSpec: () => ({ args: ["role", "run", "--kind", "generator"] }),
      evaluatorSpec: () => ({ args: ["role", "run", "--kind", "evaluator"] }),
      maxRounds: 5,
    };
    const result = await runBuildCycle({ runRole }, config);
    expect(result.outcome).toBe("grade-not-independent");
    expect(result.rounds).toHaveLength(1);
    expect(calls).toHaveLength(2); // did not proceed to round 2
  });

  it("returns inconclusive immediately on a null verdict", async () => {
    const { runRole } = scriptedRunner([
      genSummary(1),
      baseSummary({ roleKind: "evaluator", verdict: null }),
    ]);
    const config: BuildCycleConfig = {
      generatorSpec: () => ({ args: ["role", "run", "--kind", "generator"] }),
      evaluatorSpec: () => ({ args: ["role", "run", "--kind", "evaluator"] }),
    };
    const result = await runBuildCycle({ runRole }, config);
    expect(result.outcome).toBe("inconclusive");
    expect(result.rounds).toHaveLength(1);
  });

  it("exhausts after maxRounds when the evaluator always fails", async () => {
    const { runRole, calls } = scriptedRunner([
      genSummary(1),
      baseSummary({ roleKind: "evaluator", verdict: "fail", blocking: ["a"], sameModelGrade: false }),
      genSummary(2),
      baseSummary({ roleKind: "evaluator", verdict: "fail", blocking: ["b"], sameModelGrade: false }),
    ]);
    const config: BuildCycleConfig = {
      generatorSpec: () => ({ args: ["role", "run", "--kind", "generator"] }),
      evaluatorSpec: () => ({ args: ["role", "run", "--kind", "evaluator"] }),
      maxRounds: 2,
      pivotAfterFailures: 10, // never pivot, so both rounds are plain "revise" fails
    };
    const result = await runBuildCycle({ runRole }, config);
    expect(result.outcome).toBe("exhausted");
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]!.decision).toBe("revise");
    expect(result.rounds[1]!.decision).toBe("revise");
    expect(result.finalVerdict?.verdict).toBe("fail");
    expect(calls).toHaveLength(4);
  });

  it("only ever calls the injected runRole — never spawns a process itself", async () => {
    const { runRole } = scriptedRunner([
      genSummary(1),
      baseSummary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false }),
    ]);
    const config: BuildCycleConfig = {
      generatorSpec: () => ({ args: ["role", "run", "--kind", "generator"] }),
      evaluatorSpec: () => ({ args: ["role", "run", "--kind", "evaluator"] }),
    };
    await runBuildCycle({ runRole }, config);
    expect(runRole).toHaveBeenCalledTimes(2);
  });

  it("holdout-safety: JSON.stringify(result) never contains resultText/resultDigest/traceDir", async () => {
    const CANARY = "SPARRA_HOLDOUT_CANARY_DO_NOT_LEAK";
    const { runRole } = scriptedRunner([
      genSummary(1),
      baseSummary({
        roleKind: "evaluator",
        verdict: "fail",
        blocking: [`assertion failed near ${CANARY}? no — this is a safe blocking line`],
        sameModelGrade: false,
      }),
      genSummary(2),
      baseSummary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false }),
    ]);
    const config: BuildCycleConfig = {
      generatorSpec: () => ({ args: ["role", "run", "--kind", "generator"] }),
      evaluatorSpec: () => ({ args: ["role", "run", "--kind", "evaluator"] }),
    };
    const result = await runBuildCycle({ runRole }, config);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("resultText");
    expect(serialized).not.toContain("resultDigest");
    expect(serialized).not.toContain("traceDir");
  });
});
