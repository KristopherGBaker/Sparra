import { describe, expect, it, vi } from "vitest";

import {
  runUnitsConcurrently,
  type ParentSummary,
  type RunRoleSpec,
  type RunUnitConfig,
  type UnitJob,
} from "./index.ts";

const CANARY = "SPARRA_HOLDOUT_CANARY_DO_NOT_LEAK";

/** Minimal required fields for a well-formed ParentSummary — mirrors `contract.test.ts`. */
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

/** Pull `--unit <id>` out of a spec's args, so the scripted runner below can dispatch per-unit
 *  queues purely from `spec.args` (no closure-captured job identity). */
function unitIdFromArgs(args: string[] | undefined): string {
  const idx = (args ?? []).indexOf("--unit");
  const id = idx >= 0 ? args?.[idx + 1] : undefined;
  if (!id) throw new Error(`scriptedRunner: no --unit in args ${JSON.stringify(args)}`);
  return id;
}

/** Build a scripted `runRole` keyed on `spec.args`'s `--unit <id>`: each unit gets its own queue of
 *  [contract-evaluator(agree), generator, evaluator(pass)] summaries, consumed one call at a time.
 *  A unit whose id is in `throwingUnitIds` rejects on its very first call, so a downstream unit
 *  runner (`runUnit`) surfaces that as a real rejection for the scheduler to catch. */
function scriptedRunner(unitIds: string[], throwingUnitIds: Set<string> = new Set()) {
  const queues = new Map<string, ParentSummary[]>(
    unitIds.map((id) => [
      id,
      [
        baseSummary({ roleKind: "contract-evaluator", model: `${id}-contract`, contractAgreed: true }),
        baseSummary({ roleKind: "generator", model: `${id}-gen`, filesChanged: 1 }),
        baseSummary({ roleKind: "evaluator", model: `${id}-eval`, verdict: "pass", sameModelGrade: false }),
      ],
    ]),
  );
  const calls: string[] = [];
  const runRole = vi.fn(async (spec: RunRoleSpec) => {
    const id = unitIdFromArgs(spec.args);
    calls.push(id);
    if (throwingUnitIds.has(id)) throw new Error(`scriptedRunner: unit ${id} configured to throw`);
    const queue = queues.get(id);
    if (!queue || queue.length === 0) throw new Error(`scriptedRunner: queue exhausted for unit ${id}`);
    return queue.shift()!;
  });
  return { runRole, calls };
}

function unitConfig(id: string): RunUnitConfig {
  return {
    contract: {
      contractEvaluatorSpec: () => ({ args: ["role", "run", "--kind", "contract-evaluator", "--unit", id] }),
    },
    generatorSpec: () => ({ args: ["role", "run", "--kind", "generator", "--unit", id] }),
    evaluatorSpec: () => ({ args: ["role", "run", "--kind", "evaluator", "--unit", id] }),
  };
}

describe("runUnitsConcurrently (bounded scheduler over runUnit)", () => {
  it("runs N > concurrency units: all collected in order, peak == concurrency, correct per-id attribution", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `u${i + 1}`);
    const { runRole } = scriptedRunner(ids);
    let observedPeak = 0;
    const jobs: UnitJob[] = ids.map((id) => ({ id, config: unitConfig(id) }));
    const results = await runUnitsConcurrently(
      { runRole },
      jobs,
      { concurrency: 2, onState: (s) => (observedPeak = Math.max(observedPeak, s.active)) },
    );
    expect(results).toHaveLength(5);
    expect(results.peakConcurrency).toBe(2);
    expect(observedPeak).toBe(2);
    results.forEach((r, i) => {
      expect(r.id).toBe(ids[i]);
      if (!("result" in r)) throw new Error(`unit ${r.id} errored unexpectedly`);
      expect(r.result.outcome).toBe("accepted");
      expect(r.result.contract.agreed).toBe(true);
    });
  });

  it("a throwing unit resolves to { id, error } while the others still succeed", async () => {
    const ids = ["u1", "u2", "u3"];
    const { runRole } = scriptedRunner(ids, new Set(["u2"]));
    const jobs: UnitJob[] = ids.map((id) => ({ id, config: unitConfig(id) }));
    const results = await runUnitsConcurrently({ runRole }, jobs, { concurrency: 2 });
    expect(results).toHaveLength(3);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));

    const u1 = byId.u1;
    if (!u1 || !("result" in u1)) throw new Error("expected u1 to have a result");
    expect(u1.result.outcome).toBe("accepted");

    const u3 = byId.u3;
    if (!u3 || !("result" in u3)) throw new Error("expected u3 to have a result");
    expect(u3.result.outcome).toBe("accepted");

    const u2 = byId.u2;
    if (!u2 || !("error" in u2)) throw new Error("expected u2 to have an error");
    expect(u2.error).toContain("configured to throw");
  });

  it("empty jobs resolves to [] with peakConcurrency 0", async () => {
    const { runRole } = scriptedRunner([]);
    const results = await runUnitsConcurrently({ runRole }, [], { concurrency: 3 });
    expect(results).toHaveLength(0);
    expect(results.peakConcurrency).toBe(0);
  });

  it("holdout-safe: JSON.stringify(results) never contains resultText/resultDigest/traceDir or the canary", async () => {
    // Like `contract.test.ts`'s equivalent test, this scripted runner returns hand-built
    // `ParentSummary` objects directly (bypassing `toParentSummary`), so the CANARY/holdout-field
    // absence here is a STRUCTURAL guarantee (the `ParentSummary` type has no `resultText` /
    // `resultDigest` / `traceDir` member — `Pick<RunRolePayload, ParentSafeField>` excludes them,
    // so a literal that tried to set one would fail to typecheck) rather than a runtime-stripping
    // one; the real stripping (`toParentSummary`) is exercised end-to-end by `pool.test.ts`'s
    // stub-subprocess test. This still guards the scheduler itself: only `RunUnitResult` (built
    // entirely from these summaries) flows through `runUnitsConcurrently`, never a raw payload.
    const ids = ["u1", "u2"];
    const { runRole } = scriptedRunner(ids);
    const jobs: UnitJob[] = ids.map((id) => ({ id, config: unitConfig(id) }));
    const results = await runUnitsConcurrently({ runRole }, jobs, { concurrency: 2 });
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain("resultText");
    expect(serialized).not.toContain("resultDigest");
    expect(serialized).not.toContain("traceDir");
  });
});
