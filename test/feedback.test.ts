import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  renderPatchFeedback,
  renderPivotFeedback,
  renderBlockedFeedback,
  truncateEvidence,
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

  it("separates UN-RUN assertions from failed assertion feedback", () => {
    const fb = renderPatchFeedback(
      mixedVerdict({
        assertions: [
          { id: 1, pass: true, evidence: "ok" },
          { id: 2, pass: false, evidence: "real failure" },
          { id: 3, pass: false, evidence: "command not found in evaluator env" },
        ],
        unrunAssertionIds: [3],
      })
    );
    const failedSection = fb.split("Un-run assertions")[0]!;
    expect(failedSection).toContain("#2: real failure");
    expect(failedSection).not.toContain("#3: command not found");
    expect(fb).toContain("Un-run assertions (no signal");
    expect(fb).toContain("#3: command not found in evaluator env");
    expect(fb).not.toContain("ok");
  });

  it("includes every blocking[] item (no regression from the ids-only format)", () => {
    const fb = renderPatchFeedback(mixedVerdict());
    expect(fb).toContain("- add returns the wrong sum");
    expect(fb).toContain("- process crashes on empty input");
  });

  it("caps long evidence with a truncation marker; the full un-elided text is absent", () => {
    // A no-error blob far over the cap → head + marker + tail, marker present, full text gone.
    const long = "x".repeat(EVIDENCE_CAP * 2) + "MIDDLE-CONTENT-DROPPED" + "y".repeat(EVIDENCE_CAP * 2);
    const v = mixedVerdict({ assertions: [{ id: 7, pass: false, evidence: long }] });
    const fb = renderPatchFeedback(v);
    expect(fb).toContain(TRUNCATION_MARKER);
    expect(fb).not.toContain(long); // full contiguous text absent (it was elided)
    expect(fb).not.toContain("MIDDLE-CONTENT-DROPPED"); // the elided middle is gone
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

describe("calibration nudge — claimMismatches surfaced once via the shared body (Item C)", () => {
  const cm = { count: 2, ids: [3, 5] };

  it("patch, pivot, and blocked feedback all name the contradicted ids + the verify nudge", () => {
    const fbs = [
      renderPatchFeedback(mixedVerdict({ claimMismatches: cm })),
      renderPivotFeedback(mixedVerdict({ claimMismatches: cm }), { criterion: "craft", threshold: 50, rounds: 3 }),
      renderBlockedFeedback(mixedVerdict({ claimMismatches: cm, exerciseStatus: "blocked" })),
    ];
    for (const fb of fbs) {
      expect(fb).toContain("#3, #5");
      expect(fb).toContain("VERIFY those assertions before claiming pass");
    }
  });

  it("absent claimMismatches → feedback identical to today (no calibration line)", () => {
    const fb = renderPatchFeedback(mixedVerdict());
    expect(fb).not.toContain("Calibration");
    expect(renderBlockedFeedback(mixedVerdict({ exerciseStatus: "blocked" }))).not.toContain("Calibration");
  });

  it("count: 0 renders byte-identical to no claimMismatches at all", () => {
    expect(renderPatchFeedback(mixedVerdict({ claimMismatches: { count: 0, ids: [] } }))).toBe(
      renderPatchFeedback(mixedVerdict())
    );
  });

  it("carries ids + count only — never evaluator text beyond the verdict (redaction wall)", () => {
    const fb = renderPatchFeedback(mixedVerdict({ claimMismatches: cm }));
    // The line is built solely from ids; the ids named are NOT echoes of assertion evidence.
    expect(fb).toContain("you claimed pass on #3, #5");
  });
});

describe("truncateEvidence — error-biased head+tail window (U2)", () => {
  it("keeps the trailing ERROR line when evidence exceeds the cap (mutation: head-only drops it)", () => {
    const evidence = "context ".repeat(60) + "\nEXPECTED 6 but got 5 — the actual failing line";
    expect(evidence.length).toBeGreaterThan(EVIDENCE_CAP);
    const out = truncateEvidence(evidence, EVIDENCE_CAP);
    expect(out).toContain("EXPECTED 6 but got 5 — the actual failing line");
    expect(out).toContain(TRUNCATION_MARKER);
    // A blind head-only slice would end at cap and NOT contain the trailing error line.
    expect(evidence.slice(0, EVIDENCE_CAP)).not.toContain("EXPECTED 6 but got 5");
  });

  it("evidence AT or UNDER the cap is byte-identical (no marker, no window)", () => {
    const atCap = "z".repeat(EVIDENCE_CAP);
    expect(truncateEvidence(atCap, EVIDENCE_CAP)).toBe(atCap);
    const under = "short evidence line";
    expect(truncateEvidence(under, EVIDENCE_CAP)).toBe(under);
    expect(truncateEvidence(atCap, EVIDENCE_CAP)).not.toContain(TRUNCATION_MARKER);
  });

  it("bounded: kept text (excluding the marker) never exceeds the cap; marker present", () => {
    const huge = "line error here\n".repeat(200); // way over cap, error on every line
    const out = truncateEvidence(huge, EVIDENCE_CAP);
    expect(out).toContain(TRUNCATION_MARKER);
    const kept = out.split(TRUNCATION_MARKER).join(""); // head + tail without the marker
    expect(kept.length).toBeLessThanOrEqual(EVIDENCE_CAP);
  });

  it("deterministic: identical input → identical output across repeated calls", () => {
    const evidence = "a".repeat(400) + "\nFAIL: boom\n" + "b".repeat(400);
    const a = truncateEvidence(evidence, EVIDENCE_CAP);
    const b = truncateEvidence(evidence, EVIDENCE_CAP);
    expect(a).toBe(b);
  });

  it("pulls the tail back to an error line the default tail window would just miss", () => {
    // Big head, then the error line, then ~195 chars of frames: a plain 65%-of-cap tail keeps only
    // the frames; the error-bias extension grows the tail (still within cap) to re-include the line.
    const evidence = "H".repeat(400) + "\nERROR: root cause is X\n" + "    at frame\n".repeat(15);
    const out = truncateEvidence(evidence, EVIDENCE_CAP);
    expect(out).toContain("ERROR: root cause is X");
    // Sanity: a naive last-195-chars tail would NOT have contained it.
    expect(evidence.slice(evidence.length - 195)).not.toContain("ERROR: root cause is X");
  });
});

describe("renderPatchFeedback — escalation register (U2, assertion 7 & 8)", () => {
  const longEvidence = "detail ".repeat(80) + "TAIL-MARK"; // > cap
  function escVerdict(): Verdict {
    return mixedVerdict({
      assertions: [
        { id: 2, pass: false, evidence: longEvidence }, // escalated
        { id: 4, pass: false, evidence: "y".repeat(EVIDENCE_CAP + 50) + "CAPPED-TAIL" }, // NOT escalated
      ],
    });
  }

  it("escalated id: FULL uncapped evidence + a diagnose-first instruction naming #id", () => {
    const fb = renderPatchFeedback(escVerdict(), { escalateAssertionIds: [2] });
    expect(fb).toContain(longEvidence); // full, uncapped
    expect(fb).toContain("DIAGNOSE FIRST");
    expect(fb).toContain("ROOT CAUSE");
    expect(fb).toContain("#2");
  });

  it("a non-escalated failing assertion in the same verdict stays CAPPED", () => {
    const fb = renderPatchFeedback(escVerdict(), { escalateAssertionIds: [2] });
    expect(fb).toContain(TRUNCATION_MARKER); // #4 was truncated
    expect(fb).not.toContain("y".repeat(EVIDENCE_CAP + 50) + "CAPPED-TAIL"); // full #4 text absent
  });

  it("disabled/no ids: no diagnose-first prefix, no uncap — byte-identical to a plain patch", () => {
    const v = escVerdict();
    expect(renderPatchFeedback(v, { escalateAssertionIds: [] })).toBe(renderPatchFeedback(v));
    expect(renderPatchFeedback(v)).not.toContain("DIAGNOSE FIRST");
    // #2's full long evidence is truncated when NOT escalated.
    expect(renderPatchFeedback(v)).not.toContain(longEvidence);
  });

  it("deterministic under escalation: same verdict + ids → identical string", () => {
    const v = escVerdict();
    expect(renderPatchFeedback(v, { escalateAssertionIds: [2] })).toBe(
      renderPatchFeedback(v, { escalateAssertionIds: [2] })
    );
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

  it("ALL-UN-RUN path: does not advance failed-round or pivot counters and feeds back no-signal ids", async () => {
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
        evalOut(
          mixedVerdict({
            assertions: [
              { id: 1, pass: false, evidence: "command not found" },
              { id: 2, pass: false, evidence: "simulator unavailable" },
            ],
            unrunAssertionIds: [1, 2],
            exerciseStatus: "mixed",
            scores: { design: 0, originality: 0, craft: 0, functionality: 0 },
          })
        ),
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    const st = ctx.store.data.build.items["item-001"]!;
    expect(st.failedRounds ?? 0).toBe(0);
    expect(st.pivots).toBe(0);
    expect(st.criterionFailStreak).toEqual({});
    const round2 = feedbacks[1];
    expect(round2).toContain("UN-RUN/no-signal");
    expect(round2).toContain("Un-run assertions (no signal");
    expect(round2).toContain("#1: command not found");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
