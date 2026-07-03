import { describe, it, expect } from "vitest";
import { buildRunRolePayload, toRunRoleRequest } from "../src/mcp/runRoleServer.ts";
import type { Ctx } from "../src/context.ts";
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

  // Item A: a payload built from a result CARRYING the new signals must expose all three —
  // adding them to RoleRunResult without surfacing them over MCP fails here.
  it("exposes emptyCompletion / filesChanged / hitBudget on a result carrying them", () => {
    const p = buildRunRolePayload(baseResult({ emptyCompletion: true, filesChanged: 3, hitBudget: true }), 75);
    expect(p.emptyCompletion).toBe(true);
    expect(p.filesChanged).toBe(3);
    expect(p.hitBudget).toBe(true);
  });

  it("the evaluator (verdict) branch carries hitBudget too (a budget-capped eval is resumable)", () => {
    const p = buildRunRolePayload(
      baseResult({
        roleKind: "evaluator",
        hitBudget: true,
        verdict: { verdict: "fail", weightedTotal: 0, blocking: [], assertions: [] } as unknown as RoleRunResult["verdict"],
      }),
      75
    );
    expect(p.hitBudget).toBe(true);
  });
});

describe("buildRunRolePayload — promptDrift field (present only when actionable, body-free)", () => {
  const note = { stale: ["reviewer"], conflict: ["generator"], note: "newer default prompt(s) available for reviewer — adopt with `sparra prompts sync`" };

  it("OMITS promptDrift when no drift note is passed (non-actionable / absent)", () => {
    expect("promptDrift" in buildRunRolePayload(baseResult({}), 75)).toBe(false);
    expect("promptDrift" in buildRunRolePayload(baseResult({}), 75, null)).toBe(false);
  });

  it("INCLUDES promptDrift (role names + note line only) on the non-evaluator branch when actionable", () => {
    const p = buildRunRolePayload(baseResult({ roleKind: "generator" }), 75, note);
    expect(p.promptDrift).toEqual(note);
    // Never a prompt body: the field carries only role names + the one-liner.
    const json = JSON.stringify(p.promptDrift);
    expect(json).not.toMatch(/You are the/); // no DEFAULT_PROMPTS body text
  });

  it("INCLUDES promptDrift on the evaluator (verdict) branch too, still holdout-safe (no traceDir)", () => {
    const p = buildRunRolePayload(
      baseResult({
        roleKind: "evaluator",
        verdict: { verdict: "pass", weightedTotal: 90, blocking: [], assertions: [] } as unknown as RoleRunResult["verdict"],
      }),
      75,
      note
    );
    expect(p.promptDrift).toEqual(note);
    expect("traceDir" in p).toBe(false); // wall intact
  });
});

describe("toRunRoleRequest — MCP arg forwarding", () => {
  const ctx = { root: "/proj" } as unknown as Ctx;

  it("forwards worktree→useWorktree and keepWorktree (the drop that made evals run in-place read-only)", () => {
    const req = toRunRoleRequest(ctx, { roleKind: "evaluator", workspace: "/proj", worktree: true, keepWorktree: true });
    expect(req.useWorktree).toBe(true);
    expect(req.keepWorktree).toBe(true);
    expect(req.workspace).toBe("/proj");
    expect(req.ctx).toBe(ctx);
  });

  it("leaves useWorktree undefined when worktree is not set (default in-place)", () => {
    const req = toRunRoleRequest(ctx, { roleKind: "evaluator" });
    expect(req.useWorktree).toBeUndefined();
    expect(req.keepWorktree).toBeUndefined();
  });

  it("forwards priorCritiquePaths verbatim (contract-evaluator re-critique; .sparra/ paths OK)", () => {
    const req = toRunRoleRequest(ctx, {
      roleKind: "contract-evaluator",
      contractPath: "c.md",
      priorCritiquePaths: [".sparra/loop-x/r1.md", ".sparra/loop-x/r2.md"],
    });
    expect(req.priorCritiquePaths).toEqual([".sparra/loop-x/r1.md", ".sparra/loop-x/r2.md"]);
  });

  it("leaves priorCritiquePaths undefined when not supplied", () => {
    const req = toRunRoleRequest(ctx, { roleKind: "contract-evaluator", contractPath: "c.md" });
    expect(req.priorCritiquePaths).toBeUndefined();
  });

  it("forwards the rest of the overrides verbatim", () => {
    const req = toRunRoleRequest(ctx, {
      roleKind: "generator",
      briefPath: "b.md",
      contractPath: "c.md",
      backend: "codex",
      model: "gpt-5.5",
      effort: "xhigh",
      out: "v.md",
      maxBudgetUsd: 12,
      allowVerify: true,
      resumeSessionId: "sess-1",
      resumeBackend: "claude",
    });
    expect(req).toMatchObject({
      roleKind: "generator",
      briefPath: "b.md",
      contractPath: "c.md",
      backend: "codex",
      model: "gpt-5.5",
      effort: "xhigh",
      out: "v.md",
      maxBudgetUsd: 12,
      allowVerify: true,
      resumeSessionId: "sess-1",
      resumeBackend: "claude",
    });
  });
});
