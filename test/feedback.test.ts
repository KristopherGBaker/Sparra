import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  renderPatchFeedback,
  renderPivotFeedback,
  renderBlockedFeedback,
  EVIDENCE_CAP,
  TRUNCATION_MARKER,
} from "../src/build/feedback.ts";
import { cmdBuild, type BuildDeps } from "../src/phases/build.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig, type SparraConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import type { WorkItem, Verdict } from "../src/build/types.ts";
import type { GenerateOutput } from "../src/build/generate.ts";
import type { EvalOutput } from "../src/build/evaluate.ts";

/** A verdict with a mixed pass/fail assertion set — the contract's contrast case. */
function mixedVerdict(over: Partial<Verdict> = {}): Verdict {
  return {
    assertions: [
      { id: 1, pass: true, evidence: "ran sub, saw ok" },
      { id: 2, pass: false, evidence: "ran add 2 3, saw 6" },
      { id: 4, pass: false, evidence: "crash: TypeError" },
    ],
    scores: { design: 40, originality: 40, craft: 40, functionality: 40 },
    weightedTotal: 40,
    verdict: "fail",
    blocking: ["add returns the wrong sum", "process crashes on empty input"],
    notes: "n",
    ...over,
  };
}

describe("renderPatchFeedback — per-assertion evidence (pure function of the Verdict)", () => {
  it("includes each FAILED assertion's evidence and NOT the passed assertion's evidence", () => {
    const fb = renderPatchFeedback(mixedVerdict());
    expect(fb).toContain("#2: ran add 2 3, saw 6");
    expect(fb).toContain("#4: crash: TypeError");
    expect(fb).not.toContain("ran sub, saw ok"); // passed assertion's evidence stays out
  });

  it("includes every blocking[] item (no regression from the ids-only format)", () => {
    const fb = renderPatchFeedback(mixedVerdict());
    expect(fb).toContain("- add returns the wrong sum");
    expect(fb).toContain("- process crashes on empty input");
  });

  it("caps long evidence at the cap with a truncation marker; the full text is absent", () => {
    const long = "x".repeat(EVIDENCE_CAP) + "TAIL-THAT-MUST-NOT-APPEAR";
    const v = mixedVerdict({ assertions: [{ id: 7, pass: false, evidence: long }] });
    const fb = renderPatchFeedback(v);
    expect(fb).toContain("x".repeat(EVIDENCE_CAP) + TRUNCATION_MARKER);
    expect(fb).not.toContain(long); // full text absent
    expect(fb).not.toContain("TAIL-THAT-MUST-NOT-APPEAR");
  });

  it("keeps a readable fallback when no assertions failed", () => {
    const v = mixedVerdict({ assertions: [{ id: 1, pass: true, evidence: "ok" }] });
    expect(renderPatchFeedback(v)).toContain("(see verdict)");
  });
});

describe("renderPivotFeedback — restart instruction + latest evidence", () => {
  it("carries the pivot (rebuild-from-scratch) instruction AND failed-assertion evidence lines", () => {
    const fb = renderPivotFeedback(mixedVerdict(), { criterion: "craft", threshold: 50, rounds: 3 });
    expect(fb).toContain("GAN PIVOT");
    expect(fb).toContain('below 50 on "craft" for 3 rounds');
    expect(fb).toContain("rebuild from scratch");
    expect(fb).toContain("#2: ran add 2 3, saw 6");
    expect(fb).toContain("#4: crash: TypeError");
    expect(fb).not.toContain("ran sub, saw ok");
  });
});

describe("renderBlockedFeedback — inconclusive framing + evidence when present", () => {
  it("keeps the 'make it exercisable' framing and adds failed-assertion evidence lines", () => {
    const v = mixedVerdict({ exerciseStatus: "blocked" });
    const fb = renderBlockedFeedback(v);
    expect(fb).toContain("could NOT run (blocked)");
    expect(fb).toContain("NOT a behavioral failure");
    expect(fb).toContain("exercisable");
    expect(fb).toContain("#2: ran add 2 3, saw 6");
    expect(fb).toContain("#4: crash: TypeError");
  });

  it("omits the evidence section entirely when the verdict carries no failed assertions", () => {
    const v = mixedVerdict({ exerciseStatus: "blocked", assertions: [] });
    const fb = renderBlockedFeedback(v);
    expect(fb).toContain("exercisable");
    expect(fb).not.toContain("observed");
  });
});

// ── Wiring: the build loop threads helper-rendered feedback into the NEXT generator round ──

function genOut(over: Partial<GenerateOutput> = {}): GenerateOutput {
  return { report: "", deviations: [], sessionId: "g", hitMaxTurns: false, costUsd: 0.001, tokens: 100, ...over };
}
function evalOut(verdict: Verdict, over: Partial<EvalOutput> = {}): EvalOutput {
  return { verdict, raw: "", sessionId: "e", costUsd: 0.001, tokens: 100, ...over };
}

async function makeCtx(buildOver: Partial<SparraConfig["build"]> = {}): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-feedback-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  fs.writeFileSync(paths.frozenPlan, "# Plan\nBuild some things.\n");
  const store = StateStore.create(paths, "greenfield");
  store.data.phase = "frozen";
  const config = defaultConfig();
  config.build = { ...config.build, ...buildOver };
  return { ctx: { root: dir, paths, config, store }, dir };
}

function baseDeps(): Partial<BuildDeps> {
  return {
    ensureAutoProbed: async () => {},
    negotiateContract: async () => ({ text: "contract", agreed: true, tracesUsed: 0 }),
    recordDeviations: async () => ({ changelog: 0, proposals: 0 }),
    reconcilePlan: async () => {},
  };
}

const item: WorkItem = { id: "item-001", title: "first", summary: "", dependsOn: [], rationale: "" };

describe("cmdBuild — feedback paths carry per-assertion evidence", () => {
  it("PATCH path: round-2 generator feedback carries failed-assertion evidence, not passed evidence", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    const feedbacks: (string | undefined)[] = []; // one entry per generate round, in order
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async (args) => {
        feedbacks.push(args.feedback);
        return genOut();
      },
      evaluateItem: async () => evalOut(mixedVerdict()),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    const round2 = feedbacks[1];
    expect(round2).toContain("#2: ran add 2 3, saw 6");
    expect(round2).toContain("#4: crash: TypeError");
    expect(round2).toContain("- add returns the wrong sum");
    expect(round2).not.toContain("ran sub, saw ok");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("PIVOT path: post-pivot feedback carries the pivot instruction AND the latest verdict's evidence", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 4 });
    const feedbacks: (string | undefined)[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async (args) => {
        feedbacks.push(args.feedback);
        return genOut();
      },
      // Same criterion (craft) below threshold every round → GAN pivot at N=3.
      evaluateItem: async () => evalOut(mixedVerdict({ scores: { design: 80, originality: 80, craft: 10, functionality: 80 } })),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(ctx.store.data.build.items["item-001"]!.pivots).toBeGreaterThanOrEqual(1);
    const pivotFeedback = feedbacks[3]; // round 4 = the generation right after the pivot decision
    expect(pivotFeedback).toContain("GAN PIVOT");
    expect(pivotFeedback).toContain("rebuild from scratch");
    expect(pivotFeedback).toContain("#2: ran add 2 3, saw 6");
    expect(pivotFeedback).toContain("#4: crash: TypeError");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("BLOCKED path: stays inconclusive (no pivot, no streak advance) while feedback carries evidence", async () => {
    const { ctx, dir } = await makeCtx({ maxBudgetUsdPerItem: 0, maxRoundsPerItem: 2 });
    const feedbacks: (string | undefined)[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async (args) => {
        feedbacks.push(args.feedback);
        return genOut();
      },
      evaluateItem: async () =>
        evalOut(mixedVerdict({ exerciseStatus: "blocked", scores: { design: 0, originality: 0, craft: 0, functionality: 0 } })),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    const st = ctx.store.data.build.items["item-001"]!;
    expect(st.pivots).toBe(0); // blocked never advances the pivot machinery
    expect(st.criterionFailStreak).toEqual({}); // ...nor the fail streaks
    const round2 = feedbacks[1];
    expect(round2).toContain("could NOT run (blocked)");
    expect(round2).toContain("exercisable"); // framing preserved
    expect(round2).toContain("#2: ran add 2 3, saw 6");
    expect(round2).toContain("#4: crash: TypeError");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
