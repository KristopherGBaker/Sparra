import { describe, expect, it, vi } from "vitest";

import {
  negotiateContract,
  runUnit,
  type ContractNegotiationConfig,
  type ContractRoundContext,
  type ParentSummary,
  type RunUnitConfig,
} from "./index.ts";

/** Minimal required fields for a well-formed ParentSummary, so hand-built fixtures below don't need
 *  risky `as ParentSummary` casts over partial objects. Mirrors the pattern in `loop.test.ts`. */
function baseSummary(overrides: Partial<ParentSummary>): ParentSummary {
  return {
    roleKind: "contract-evaluator",
    backend: "stub",
    model: "stub-model-1",
    ok: true,
    errors: [],
    tokens: 0,
    costUsd: 0,
    ...overrides,
  };
}

/** Build a scripted `RoleRunner` from a queue of summaries. Also records every spec handed to it. */
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

describe("negotiateContract", () => {
  it("agrees on round 1", async () => {
    const { runRole, calls } = scriptedRunner([
      baseSummary({ contractAgreed: true }),
    ]);
    const config: ContractNegotiationConfig = {
      contractEvaluatorSpec: () => ({ args: ["role", "run", "--kind", "contract-evaluator"] }),
    };
    const result = await negotiateContract({ runRole }, config);
    expect(result.agreed).toBe(true);
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]!.agreed).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("agrees on round 2, threading round-1's outPath as round-2's priorCritiquePaths", async () => {
    const { runRole } = scriptedRunner([
      baseSummary({ contractAgreed: false, outPath: "/c/round1.md" }),
      baseSummary({ contractAgreed: true }),
    ]);
    const capturedCtx: ContractRoundContext[] = [];
    const config: ContractNegotiationConfig = {
      contractEvaluatorSpec: (ctx) => {
        capturedCtx.push(ctx);
        return { args: ["role", "run", "--kind", "contract-evaluator"] };
      },
    };
    const result = await negotiateContract({ runRole }, config);
    expect(result.agreed).toBe(true);
    expect(result.rounds).toHaveLength(2);
    expect(capturedCtx[0]!.priorCritiquePaths).toEqual([]);
    expect(capturedCtx[0]!.round).toBe(1);
    expect(capturedCtx[1]!.priorCritiquePaths).toEqual(["/c/round1.md"]);
    expect(capturedCtx[1]!.round).toBe(2);
  });

  it("never agrees: exhausts maxRounds, critiquePaths carries both outPaths", async () => {
    const { runRole, calls } = scriptedRunner([
      baseSummary({ contractAgreed: false, outPath: "/c/round1.md" }),
      baseSummary({ contractAgreed: false, outPath: "/c/round2.md" }),
    ]);
    const config: ContractNegotiationConfig = {
      contractEvaluatorSpec: () => ({ args: ["role", "run", "--kind", "contract-evaluator"] }),
      maxRounds: 2,
    };
    const result = await negotiateContract({ runRole }, config);
    expect(result.agreed).toBe(false);
    expect(result.rounds).toHaveLength(2);
    expect(result.critiquePaths).toEqual(["/c/round1.md", "/c/round2.md"]);
    expect(calls).toHaveLength(2);
  });

  it("stops at maxRounds even if outPath is always absent (bounded, terminates)", async () => {
    const { runRole } = scriptedRunner([
      baseSummary({ contractAgreed: false }),
      baseSummary({ contractAgreed: false }),
      baseSummary({ contractAgreed: false }),
    ]);
    const config: ContractNegotiationConfig = {
      contractEvaluatorSpec: () => ({ args: ["role", "run", "--kind", "contract-evaluator"] }),
      maxRounds: 3,
    };
    const result = await negotiateContract({ runRole }, config);
    expect(result.agreed).toBe(false);
    expect(result.rounds).toHaveLength(3);
    expect(result.critiquePaths).toEqual([]);
  });
});

describe("runUnit", () => {
  const genSpec = vi.fn(() => ({ args: ["role", "run", "--kind", "generator"] }));
  const evalSpec = vi.fn(() => ({ args: ["role", "run", "--kind", "evaluator"] }));

  it("contract-not-agreed + proceedIfNotAgreed:false → outcome contract-not-agreed, no cycle, generator/evaluator never invoked", async () => {
    genSpec.mockClear();
    evalSpec.mockClear();
    const { runRole, calls } = scriptedRunner([
      baseSummary({ contractAgreed: false, outPath: "/c/round1.md" }),
      baseSummary({ contractAgreed: false, outPath: "/c/round2.md" }),
    ]);
    const config: RunUnitConfig = {
      contract: {
        contractEvaluatorSpec: () => ({ args: ["role", "run", "--kind", "contract-evaluator"] }),
        maxRounds: 2,
      },
      generatorSpec: genSpec,
      evaluatorSpec: evalSpec,
      proceedIfNotAgreed: false,
    };
    const result = await runUnit({ runRole }, config);
    expect(result.outcome).toBe("contract-not-agreed");
    expect(result.cycle).toBeUndefined();
    expect(result.contract.agreed).toBe(false);
    expect(calls).toHaveLength(2); // only the two contract-evaluator rounds
    expect(genSpec).not.toHaveBeenCalled();
    expect(evalSpec).not.toHaveBeenCalled();
  });

  it("agreed → proceeds to runBuildCycle, outcome mirrors the cycle", async () => {
    const { runRole } = scriptedRunner([
      // contract negotiation
      baseSummary({ roleKind: "contract-evaluator", contractAgreed: true }),
      // build cycle: generator, evaluator
      baseSummary({ roleKind: "generator", filesChanged: 1 }),
      baseSummary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false }),
    ]);
    const config: RunUnitConfig = {
      contract: {
        contractEvaluatorSpec: () => ({ args: ["role", "run", "--kind", "contract-evaluator"] }),
      },
      generatorSpec: () => ({ args: ["role", "run", "--kind", "generator"] }),
      evaluatorSpec: () => ({ args: ["role", "run", "--kind", "evaluator"] }),
    };
    const result = await runUnit({ runRole }, config);
    expect(result.contract.agreed).toBe(true);
    expect(result.cycle).toBeDefined();
    expect(result.cycle!.outcome).toBe("accepted");
    expect(result.outcome).toBe("accepted");
  });

  it("not agreed + proceedIfNotAgreed:true → proceeds to runBuildCycle anyway", async () => {
    const { runRole } = scriptedRunner([
      baseSummary({ roleKind: "contract-evaluator", contractAgreed: false, outPath: "/c/r1.md" }),
      baseSummary({ roleKind: "generator", filesChanged: 1 }),
      baseSummary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false }),
    ]);
    const config: RunUnitConfig = {
      contract: {
        contractEvaluatorSpec: () => ({ args: ["role", "run", "--kind", "contract-evaluator"] }),
        maxRounds: 1,
      },
      generatorSpec: () => ({ args: ["role", "run", "--kind", "generator"] }),
      evaluatorSpec: () => ({ args: ["role", "run", "--kind", "evaluator"] }),
      proceedIfNotAgreed: true,
    };
    const result = await runUnit({ runRole }, config);
    expect(result.contract.agreed).toBe(false);
    expect(result.cycle).toBeDefined();
    expect(result.outcome).toBe("accepted");
  });

  it("holdout-safety: JSON.stringify(result) never contains resultText/resultDigest/traceDir", async () => {
    // blocking/outPath are allowlisted control fields (like loop.test.ts's equivalent), so a canary
    // embedded there is expected to flow through untouched — this test asserts the actual
    // holdout-BEARING field names (which toParentSummary strips before a summary ever reaches this
    // module) never appear, not that all evaluator text is opaque.
    const { runRole } = scriptedRunner([
      baseSummary({
        roleKind: "contract-evaluator",
        contractAgreed: false,
        outPath: "/c/r1.md",
        blocking: ["critique: missing edge case — a safe blocking line"],
      }),
      baseSummary({ roleKind: "contract-evaluator", contractAgreed: true }),
      baseSummary({ roleKind: "generator", filesChanged: 1 }),
      baseSummary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false }),
    ]);
    const config: RunUnitConfig = {
      contract: {
        contractEvaluatorSpec: () => ({ args: ["role", "run", "--kind", "contract-evaluator"] }),
      },
      generatorSpec: () => ({ args: ["role", "run", "--kind", "generator"] }),
      evaluatorSpec: () => ({ args: ["role", "run", "--kind", "evaluator"] }),
    };
    const result = await runUnit({ runRole }, config);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("resultText");
    expect(serialized).not.toContain("resultDigest");
    expect(serialized).not.toContain("traceDir");
  });
});
