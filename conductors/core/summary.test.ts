import { describe, expect, it } from "vitest";

import type { RunRolePayload } from "../../src/roleEnvelope.ts";
import { HOLDOUT_BEARING_FIELDS, PARENT_SAFE_FIELDS, toParentSummary } from "./summary.ts";

const CANARY = "SPARRA_HOLDOUT_CANARY_DO_NOT_LEAK";

function fullEnvelope(): RunRolePayload & { secretExtra?: string } {
  return {
    roleKind: "evaluator",
    backend: "claude",
    model: "opus",
    ok: true,
    verdict: "pass",
    weightedTotal: 92,
    passThreshold: 75,
    blocking: [],
    failedAssertions: [],
    verdictPath: "/x/verdict.md",
    filesChanged: 2,
    errors: [],
    tokens: 100,
    costUsd: 0.5,
    // holdout-bearing / raw:
    resultText: `raw transcript with ${CANARY}`,
    resultDigest: "sha256:abc",
    traceDir: "/x/trace",
    // a field the allowlist does NOT name (stands in for a future envelope field):
    secretExtra: CANARY,
  };
}

describe("toParentSummary (the holdout wall)", () => {
  it("keeps allowlisted control fields", () => {
    const s = toParentSummary(fullEnvelope());
    expect(s.verdict).toBe("pass");
    expect(s.weightedTotal).toBe(92);
    expect(s.verdictPath).toBe("/x/verdict.md");
    expect(s.backend).toBe("claude");
    expect(s.ok).toBe(true);
  });

  it("drops holdout-bearing fields and the canary", () => {
    const s = toParentSummary(fullEnvelope()) as Record<string, unknown>;
    for (const f of HOLDOUT_BEARING_FIELDS) expect(s[f]).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain(CANARY);
  });

  it("drops UNKNOWN fields (allowlist, not denylist)", () => {
    // `secretExtra` is not in PARENT_SAFE_FIELDS → must not survive, proving new/unforeseen envelope
    // fields can't leak until consciously allowlisted.
    const s = toParentSummary(fullEnvelope()) as Record<string, unknown>;
    expect(s.secretExtra).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain(CANARY);
  });

  it("only copies fields actually present on the input", () => {
    const minimal: RunRolePayload = {
      roleKind: "generator",
      backend: "claude",
      model: "sonnet",
      ok: true,
      errors: [],
      tokens: 0,
      costUsd: 0,
    };
    const s = toParentSummary(minimal);
    expect(Object.prototype.hasOwnProperty.call(s, "verdict")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(s, "weightedTotal")).toBe(false);
    expect(s.roleKind).toBe("generator");
  });

  it("PARENT_SAFE_FIELDS contains no holdout-bearing field", () => {
    for (const h of HOLDOUT_BEARING_FIELDS) {
      expect(PARENT_SAFE_FIELDS as readonly string[]).not.toContain(h);
    }
  });
});
