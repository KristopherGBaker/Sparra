import { describe, it, expect } from "vitest";
import { buildRunRolePayload, toRunRoleRequest, type RunRolePayload } from "../src/mcp/runRoleServer.ts";
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
    expect("resultText" in p).toBe(false);
    expect(p.errors).toEqual([]);
  });

  it("surfaces the auto-persisted verdictPath (distinct from outPath) on the evaluator branch", () => {
    const r = baseResult({
      roleKind: "evaluator",
      verdictPath: "/proj/.sparra/verdicts/role-run-evaluator-2026-07-06T00-00-00-deadbeef.verdict.md",
      outPath: "/proj/my-out.md",
      verdict: { verdict: "pass", weightedTotal: 90, blocking: [], assertions: [] } as unknown as RoleRunResult["verdict"],
    });
    const p = buildRunRolePayload(r, 75);
    expect(p.verdictPath).toBe("/proj/.sparra/verdicts/role-run-evaluator-2026-07-06T00-00-00-deadbeef.verdict.md");
    expect(p.outPath).toBe("/proj/my-out.md");
    expect(p.verdictPath).not.toBe(p.outPath);
    expect("traceDir" in p).toBe(false); // wall intact
  });

  it("a NON-evaluator payload INCLUDES traceDir (holdout-free by scope) + result text, no verdict", () => {
    const r = baseResult({ roleKind: "generator", noProgress: true });
    const p = buildRunRolePayload(r, 75);

    expect(p.traceDir).toBe("/proj/.sparra/traces/role-run-generator-x/");
    expect(p.resultText).toBe("did the thing");
    expect("result" in p).toBe(false);
    expect(p.errors).toEqual([]);
    expect(p.noProgress).toBe(true);
    expect("verdict" in p).toBe(false);
  });

  it("preserves recovered resultText together with its recovery errors", () => {
    const p: RunRolePayload = buildRunRolePayload(
      baseResult({ resultText: "recovered report", errors: ["Recovered completion report after one-shot re-ask"] }),
      75
    );
    expect(p.resultText).toBe("recovered report");
    expect(p.errors).toEqual(["Recovered completion report after one-shot re-ask"]);
  });

  it("surfaces the unitWorktree {name,dir,branch,created} on the (non-evaluator) generator branch", () => {
    const uw = { name: "u1", dir: "/proj-unit-u1", branch: "sparra/u1", created: true };
    const p = buildRunRolePayload(baseResult({ roleKind: "generator", unitWorktree: uw }), 75);
    expect(p.unitWorktree).toEqual(uw);
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

  it("forwards unitWorktree (persistent per-unit generator tree)", () => {
    const req = toRunRoleRequest(ctx, { roleKind: "generator", brief: "build", unitWorktree: "u1" });
    expect(req.unitWorktree).toBe("u1");
  });

  it("leaves unitWorktree undefined when not set", () => {
    expect(toRunRoleRequest(ctx, { roleKind: "generator", brief: "build" }).unitWorktree).toBeUndefined();
  });

  it("forwards expectedHead / evalBaseRef (eval-provenance controls)", () => {
    const req = toRunRoleRequest(ctx, { roleKind: "evaluator", expectedHead: "09cb754", evalBaseRef: "HEAD~1" });
    expect(req.expectedHead).toBe("09cb754");
    expect(req.evalBaseRef).toBe("HEAD~1");
  });

  it("leaves expectedHead / evalBaseRef undefined when not set", () => {
    const req = toRunRoleRequest(ctx, { roleKind: "evaluator" });
    expect(req.expectedHead).toBeUndefined();
    expect(req.evalBaseRef).toBeUndefined();
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

  it("forwards priorBlockingPaths verbatim (evaluator re-grade; .sparra/ paths OK)", () => {
    const req = toRunRoleRequest(ctx, {
      roleKind: "evaluator",
      priorBlockingPaths: [".sparra/verdicts/r1.verdict.md", ".sparra/verdicts/r2.verdict.md"],
    });
    expect(req.priorBlockingPaths).toEqual([".sparra/verdicts/r1.verdict.md", ".sparra/verdicts/r2.verdict.md"]);
  });

  it("leaves priorBlockingPaths undefined when not supplied", () => {
    const req = toRunRoleRequest(ctx, { roleKind: "evaluator" });
    expect(req.priorBlockingPaths).toBeUndefined();
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

describe("buildRunRolePayload — verifyGateWarning field (U-V Assertion 5)", () => {
  // (Assertion 5) The warning is surfaced in the MCP payload's non-evaluator branch when set.
  it("exposes verifyGateWarning on the non-evaluator branch when the result carries it", () => {
    const warn = "[VERIFY-GATE ADVISORY] contract references `npm test`; self-verify is off";
    const p = buildRunRolePayload(baseResult({ roleKind: "generator", verifyGateWarning: warn }), 75);
    expect(p.verifyGateWarning).toBe(warn);
  });

  it("verifyGateWarning is absent (undefined) when the result does not carry it", () => {
    const p = buildRunRolePayload(baseResult({ roleKind: "generator" }), 75);
    // The field is optional — when the run had no warning it should be absent / undefined.
    expect(p.verifyGateWarning).toBeUndefined();
  });

  it("verifyGateWarning is NOT present on the evaluator (verdict) branch — evaluator never self-verifies", () => {
    const w = "[VERIFY-GATE ADVISORY] should not appear on evaluator branch";
    const p = buildRunRolePayload(
      baseResult({
        roleKind: "evaluator",
        verifyGateWarning: w,
        verdict: { verdict: "pass", weightedTotal: 88, blocking: [], assertions: [] } as unknown as RoleRunResult["verdict"],
      }),
      75
    );
    // The evaluator branch does not surface verifyGateWarning (it's a writer-only field).
    expect("verifyGateWarning" in p).toBe(false);
  });
});

// ── U-1: Fallback provenance + same-model-grade warning — MCP payload (assertion 4, 7e) ──

describe("buildRunRolePayload — fallbackFrom + sameModelGrade (U-1 assertion 4)", () => {
  const evalVerdict = { verdict: "pass", weightedTotal: 88, blocking: [], assertions: [] } as unknown as RoleRunResult["verdict"];

  // (4-eval-branch) evaluator payload exposes both fallbackFrom and sameModelGrade
  it("evaluator branch: exposes fallbackFrom when the run fell back", () => {
    const p = buildRunRolePayload(
      baseResult({
        roleKind: "evaluator",
        backend: "claude",
        model: "opus",
        fallbackFrom: { backend: "codex", model: "gpt-5.5" },
        verdict: evalVerdict,
      }),
      75
    );
    expect(p.fallbackFrom).toEqual({ backend: "codex", model: "gpt-5.5" });
    // Wall: traceDir still omitted on evaluator branch
    expect("traceDir" in p).toBe(false);
  });

  it("evaluator branch: fallbackFrom is absent when no fallback occurred", () => {
    const p = buildRunRolePayload(
      baseResult({ roleKind: "evaluator", fallbackFrom: undefined, verdict: evalVerdict }),
      75
    );
    expect(p.fallbackFrom).toBeUndefined();
  });

  it("evaluator branch: sameModelGrade===true is exposed when the gate collapsed", () => {
    const p = buildRunRolePayload(
      baseResult({
        roleKind: "evaluator",
        sameModelGrade: true,
        fallbackFrom: { backend: "codex", model: "gpt-5.5" },
        verdict: evalVerdict,
      }),
      75
    );
    expect(p.sameModelGrade).toBe(true);
    expect(p.fallbackFrom).toEqual({ backend: "codex", model: "gpt-5.5" });
    expect("traceDir" in p).toBe(false); // wall intact
  });

  it("evaluator branch: sameModelGrade===false is exposed when baseline is present but differs", () => {
    const p = buildRunRolePayload(
      baseResult({ roleKind: "evaluator", sameModelGrade: false, verdict: evalVerdict }),
      75
    );
    expect(p.sameModelGrade).toBe(false);
  });

  it("evaluator branch: sameModelGrade is absent when no crossModelBaseline was supplied", () => {
    const p = buildRunRolePayload(
      baseResult({ roleKind: "evaluator", sameModelGrade: undefined, verdict: evalVerdict }),
      75
    );
    expect(p.sameModelGrade).toBeUndefined();
  });

  // (4-non-eval-branch) non-evaluator also gets fallbackFrom (but not sameModelGrade)
  it("non-evaluator branch: exposes fallbackFrom when the run fell back (generator path)", () => {
    const p = buildRunRolePayload(
      baseResult({ roleKind: "generator", fallbackFrom: { backend: "codex", model: "gpt-5.5" } }),
      75
    );
    expect(p.fallbackFrom).toEqual({ backend: "codex", model: "gpt-5.5" });
    // traceDir PRESENT on non-evaluator (holdout-free)
    expect(p.traceDir).toBeDefined();
  });

  it("non-evaluator branch: fallbackFrom is absent when no fallback occurred", () => {
    const p = buildRunRolePayload(baseResult({ roleKind: "generator", fallbackFrom: undefined }), 75);
    expect(p.fallbackFrom).toBeUndefined();
  });

  // MUTATION DISCRIMINATOR for the wall: evaluator branch still omits traceDir even when fallbackFrom is present
  it("wall: evaluator branch OMITS traceDir even when fallbackFrom and sameModelGrade are set", () => {
    const p = buildRunRolePayload(
      baseResult({
        roleKind: "evaluator",
        fallbackFrom: { backend: "codex", model: "gpt-5.5" },
        sameModelGrade: true,
        verdict: evalVerdict,
      }),
      75
    );
    expect("traceDir" in p).toBe(false);
    expect(p.traceDir).toBeUndefined();
    expect(p.fallbackFrom).toBeDefined(); // provenance present
    expect(p.sameModelGrade).toBe(true); // signal present
  });
});

describe("toRunRoleRequest — crossModelBaseline forwarding (U-1 assertion 4, 7e)", () => {
  const ctx = { root: "/proj" } as unknown as Ctx;

  it("forwards crossModelBaseline onto the RoleRunRequest", () => {
    const req = toRunRoleRequest(ctx, {
      roleKind: "evaluator",
      crossModelBaseline: { backend: "claude", model: "opus" },
    });
    expect(req.crossModelBaseline).toEqual({ backend: "claude", model: "opus" });
  });

  it("leaves crossModelBaseline undefined when not set (backwards-compatible)", () => {
    const req = toRunRoleRequest(ctx, { roleKind: "evaluator" });
    expect(req.crossModelBaseline).toBeUndefined();
  });

  it("forwards crossModelBaseline with absent backend (model-only baseline)", () => {
    const req = toRunRoleRequest(ctx, {
      roleKind: "evaluator",
      crossModelBaseline: { model: "opus" },
    });
    expect(req.crossModelBaseline).toEqual({ model: "opus" });
    expect(req.crossModelBaseline?.backend).toBeUndefined();
  });
});
