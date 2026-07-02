import { describe, it, expect } from "vitest";
import { buildRunRolePayload } from "../src/mcp/runRoleServer.ts";
import type { RoleRunResult } from "../src/build/roleRun.ts";

// The holdout-safe field split for the `run_role` MCP payload. The wall-critical invariant is that
// the EVALUATOR payload never carries `traceDir` (its trace is holdout-bearing), while every other
// role does (holdout-free by scope) so the conductor can tail it for live progress.

function baseResult(over: Partial<RoleRunResult>): RoleRunResult {
  return {
    ok: true,
    roleKind: "generator",
    backend: "claude",
    model: "opus",
    resultText: "did the thing",
    traceDir: "/proj/.sparra/traces/role-run-generator-x/",
    sessionId: "sess-1",
    costUsd: 0.12,
    tokens: 3400,
    errors: [],
    ...over,
  };
}

describe("buildRunRolePayload — holdout-safe field split", () => {
  it("the EVALUATOR payload OMITS traceDir (its trace is holdout-bearing) and carries the verdict", () => {
    const r = baseResult({
      roleKind: "evaluator",
      backend: "codex",
      model: "gpt-5.5",
      traceDir: "/proj/.sparra/traces/role-run-evaluator-y/", // set on the result, must NOT be exposed
      verdict: {
        verdict: "PASS",
        weightedTotal: 88,
        blocking: [],
        assertions: [{ pass: true }, { pass: false }],
      } as unknown as RoleRunResult["verdict"],
    });
    const p = buildRunRolePayload(r, 75);

    // WALL: no pointer to the holdout-bearing evaluator trace ever leaves the runner.
    expect("traceDir" in p).toBe(false);
    expect(p.traceDir).toBeUndefined();
    // Verdict branch content is present + threshold echoed; raw result text is NOT.
    expect(p.verdict).toBe("PASS");
    expect(p.weightedTotal).toBe(88);
    expect(p.passThreshold).toBe(75);
    expect(p.failedAssertions).toHaveLength(1);
    expect("result" in p).toBe(false);
  });

  it("a NON-evaluator payload INCLUDES traceDir (holdout-free by scope) + result text, no verdict", () => {
    const r = baseResult({ roleKind: "generator", noProgress: true });
    const p = buildRunRolePayload(r, 75);

    expect(p.traceDir).toBe("/proj/.sparra/traces/role-run-generator-x/");
    expect(p.result).toBe("did the thing");
    expect(p.noProgress).toBe(true);
    expect("verdict" in p).toBe(false);
  });

  it("carries the not-a-fail signals through both branches", () => {
    const limited = buildRunRolePayload(baseResult({ limitHit: { backend: "codex" } as any, hitMaxTurns: true }), 75);
    expect(limited.limitHit).toBeTruthy();
    expect(limited.hitMaxTurns).toBe(true);
  });
});
