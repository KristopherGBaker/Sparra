import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runRole, runRoleRaw } from "./roleClient.ts";

const CANARY = "SPARRA_HOLDOUT_CANARY_DO_NOT_LEAK";
const STUB = fileURLToPath(new URL("./__fixtures__/stub-sparra.mjs", import.meta.url));

describe("runRole against the stub sparra", () => {
  it("returns ONLY the redacted summary — no holdout-bearing fields, no canary", async () => {
    const summary = await runRole({ sparraBin: STUB, args: ["role", "run", "--kind", "evaluator"] });
    expect(summary.verdict).toBe("pass");
    expect(summary.weightedTotal).toBe(88.5);
    const blob = JSON.stringify(summary);
    expect(blob).not.toContain(CANARY);
    expect(blob).not.toContain("resultText");
    expect(blob).not.toContain("traceDir");
  });

  it("runRoleRaw exposes the payload (canary present → non-vacuous) but the summary stays clean", async () => {
    const { payload, summary } = await runRoleRaw({ sparraBin: STUB, args: ["eval", "."] });
    // The raw payload genuinely contains the canary — so the summary's absence of it is meaningful.
    expect(payload.resultText).toContain(CANARY);
    expect(payload.traceDir).toBeDefined();
    expect(JSON.stringify(summary)).not.toContain(CANARY);
  });

  it("ignores non-JSON stderr noise and still parses stdout", async () => {
    const summary = await runRole({
      sparraBin: STUB,
      args: ["role", "run", "--kind", "evaluator"],
      env: { STUB_STDERR_NOISE: "1" },
    });
    expect(summary.ok).toBe(true);
    expect(summary.verdict).toBe("pass");
  });

  it("rejects when the binary exits non-zero", async () => {
    await expect(runRole({ sparraBin: "/nonexistent/definitely-not-sparra", args: ["eval"] })).rejects.toThrow();
  });
});
