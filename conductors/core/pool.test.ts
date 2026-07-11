import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { type RoleJob, runRolesConcurrently } from "./pool.ts";

const CANARY = "SPARRA_HOLDOUT_CANARY_DO_NOT_LEAK";
const STUB = fileURLToPath(new URL("./__fixtures__/stub-sparra.mjs", import.meta.url));

function jobs(n: number, delayMs = 0): RoleJob[] {
  return Array.from({ length: n }, (_, i) => {
    const id = `stub${i + 1}`;
    return {
      id,
      spec: {
        sparraBin: STUB,
        args: ["role", "run", "--kind", "evaluator"],
        env: { STUB_ID: id, STUB_DELAY_MS: String(delayMs) },
      },
    };
  });
}

describe("runRolesConcurrently (bounded, isolated, no cross-talk)", () => {
  it("runs more jobs than the bound: all complete, peak == bound, queued not dropped", async () => {
    let observedPeak = 0;
    const results = await runRolesConcurrently(jobs(5, 40), {
      concurrency: 3,
      onState: (s) => (observedPeak = Math.max(observedPeak, s.active)),
    });
    expect(results).toHaveLength(5);
    expect(results.every((r) => "summary" in r)).toBe(true);
    expect(results.peakConcurrency).toBe(3);
    expect(observedPeak).toBe(3);
  });

  it("attributes each result to the right job (distinct model/score, in input order)", async () => {
    const results = await runRolesConcurrently(jobs(5), { concurrency: 3 });
    results.forEach((r, i) => {
      expect(r.id).toBe(`stub${i + 1}`);
      if (!("summary" in r)) throw new Error(`job ${r.id} errored`);
      expect(r.summary.model).toBe(`stub-model-stub${i + 1}`);
      // stub weightedTotal = 50 + (id digit)*10 → stub1=60, stub2=70, …
      expect(r.summary.weightedTotal).toBe(50 + (i + 1) * 10);
    });
  });

  it("no canary and no cross-talk across children; only allowlisted fields survive", async () => {
    const results = await runRolesConcurrently(jobs(4), { concurrency: 2 });
    const summaries = results.map((r) => {
      if (!("summary" in r)) throw new Error(`job ${r.id} errored`);
      return { id: r.id, summary: r.summary };
    });
    for (const { summary } of summaries) {
      const blob = JSON.stringify(summary);
      expect(blob).not.toContain(CANARY);
      expect(blob).not.toContain("resultText");
      expect(blob).not.toContain("traceDir");
    }
    // child i's marker must not appear in child j's summary
    for (const a of summaries) {
      for (const b of summaries) {
        if (a.id === b.id) continue;
        expect(JSON.stringify(b.summary)).not.toContain(a.summary.model);
      }
    }
  });

  it("a failing job resolves to an error entry without rejecting the batch", async () => {
    const results = await runRolesConcurrently(
      [
        { id: "ok", spec: { sparraBin: STUB, args: ["eval"], env: { STUB_ID: "ok9" } } },
        { id: "bad", spec: { sparraBin: "/nonexistent/nope-sparra", args: ["eval"] } },
      ],
      { concurrency: 2 },
    );
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect("summary" in byId.ok!).toBe(true);
    expect("error" in byId.bad!).toBe(true);
  });

  it("empty job list resolves to an empty result with peak 0", async () => {
    const results = await runRolesConcurrently([], { concurrency: 3 });
    expect(results).toHaveLength(0);
    expect(results.peakConcurrency).toBe(0);
  });
});
