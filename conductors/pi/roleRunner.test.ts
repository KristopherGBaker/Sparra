import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { ParentSummary, RunRoleSpec } from "../core/index.ts";
import { renderSummaryText, runSparraRoleForTool } from "./roleRunner.ts";

const CANARY = "SPARRA_HOLDOUT_CANARY_DO_NOT_LEAK";
const STUB = fileURLToPath(new URL("../core/__fixtures__/stub-sparra.mjs", import.meta.url));

/** Minimal required fields for a well-formed ParentSummary, so hand-built test fixtures below don't
 *  need risky `as ParentSummary` casts over partial objects. */
function baseSummary(overrides: Partial<ParentSummary>): ParentSummary {
  return {
    roleKind: "evaluator",
    backend: "stub",
    model: "stub-model-1",
    ok: true,
    errors: [],
    tokens: 0,
    costUsd: 0,
    ...overrides,
  };
}

describe("runSparraRoleForTool against the core stub", () => {
  it("returns a ParentSummary and a compact text rendering with the verdict/score", async () => {
    const out = await runSparraRoleForTool({
      args: ["role", "run", "--kind", "evaluator"],
      sparraBin: STUB,
    });
    expect(out.summary.verdict).toBe("pass");
    expect(out.summary.weightedTotal).toBe(88.5);
    expect(out.text).toContain("verdict: pass");
    expect(out.text).toContain("weightedTotal: 88.5");
    expect(out.text).toContain("passThreshold: 75");
  });

  it("never leaks the canary, resultText, or traceDir in text or the serialized output", async () => {
    const out = await runSparraRoleForTool({
      args: ["role", "run", "--kind", "evaluator"],
      sparraBin: STUB,
    });
    const serialized = JSON.stringify(out);
    for (const forbidden of [CANARY, "resultText", "traceDir"]) {
      expect(out.text).not.toContain(forbidden);
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("honors SPARRA_BIN env as an alternative to sparraBin (via deps.runRole default path)", async () => {
    const prevBin = process.env.SPARRA_BIN;
    process.env.SPARRA_BIN = STUB;
    try {
      const out = await runSparraRoleForTool({ args: ["eval", "."] });
      expect(out.summary.ok).toBe(true);
      expect(JSON.stringify(out)).not.toContain(CANARY);
    } finally {
      if (prevBin === undefined) delete process.env.SPARRA_BIN;
      else process.env.SPARRA_BIN = prevBin;
    }
  });

  it("appends --holdout <path> to the spec's args when holdoutPath is given, and never reads the file", async () => {
    const capturedSpecs: RunRoleSpec[] = [];
    const stubSummary: ParentSummary = baseSummary({
      verdict: "pass",
      weightedTotal: 90,
      passThreshold: 75,
      blocking: [],
    });
    const runRoleSpy = vi.fn(async (spec: RunRoleSpec) => {
      capturedSpecs.push(spec);
      return stubSummary;
    });

    // A path that does not exist — if the adapter ever tried to read it, this would throw.
    const nonexistentHoldoutPath = "/definitely/does/not/exist/HOLDOUT.md";

    const out = await runSparraRoleForTool(
      { args: ["eval", "."], holdoutPath: nonexistentHoldoutPath },
      { runRole: runRoleSpy },
    );

    expect(runRoleSpy).toHaveBeenCalledTimes(1);
    expect(capturedSpecs).toHaveLength(1);
    expect(capturedSpecs[0]!.args).toEqual(["eval", ".", "--holdout", nonexistentHoldoutPath]);
    // The adapter used the injected summary straight through — proof it never opened the path itself.
    expect(out.summary).toEqual(stubSummary);
  });

  it("does not mutate the caller's args array when adding --holdout", async () => {
    const originalArgs = ["eval", "."];
    const runRoleSpy = vi.fn(async (_spec: RunRoleSpec) => {
      return baseSummary({ verdict: "pass" });
    });
    await runSparraRoleForTool(
      { args: originalArgs, holdoutPath: "/tmp/whatever/HOLDOUT.md" },
      { runRole: runRoleSpy },
    );
    expect(originalArgs).toEqual(["eval", "."]);
  });

  it("renderSummaryText reports blocking count, not the blocking array contents, and 'none' when no flags are set", () => {
    const summary = baseSummary({
      verdict: "fail",
      weightedTotal: 40,
      passThreshold: 75,
      blocking: ["assertion-1", "assertion-2"],
      verdictPath: "/tmp/verdict.md",
    });
    const text = renderSummaryText(summary);
    expect(text).toContain("blocking: 2");
    expect(text).not.toContain("assertion-1");
    expect(text).toContain("flags: none");
  });

  it("renderSummaryText surfaces control flags (e.g. limitHit, fallbackFrom) without leaking raw content", () => {
    const summary = baseSummary({
      verdict: "pass",
      weightedTotal: 80,
      passThreshold: 75,
      blocking: [],
      limitHit: { kind: "rate", raw: "rate limit hit at provider X, retry after N" },
      fallbackFrom: { backend: "openai-codex", model: "gpt-5" },
    });
    const text = renderSummaryText(summary);
    expect(text).toContain("limitHit=rate");
    expect(text).toContain("fallbackFrom=openai-codex/gpt-5");
    // The raw provider message on `limitHit.raw` is holdout-adjacent noise, not a control field —
    // it must never leak into the compact rendering.
    expect(text).not.toContain("retry after N");
  });
});
