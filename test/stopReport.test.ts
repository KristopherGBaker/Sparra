import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { renderStopReport, writeStopReport, type StopReportInput } from "../src/stopReport.ts";
import { cmdBuild, type BuildDeps } from "../src/phases/build.ts";
import { pauseDir } from "../src/build/interactive.ts";
import { cmdStatus } from "../src/phases/status.ts";
import { runConduct, type ConductResult } from "../src/conduct/run.ts";
import { cmdConductStatus } from "../src/phases/conduct.ts";
import { buildRunRolePayload } from "../src/mcp/runRoleServer.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig, type SparraConfig } from "../src/config.ts";
import { loadCtxForRole, type Ctx } from "../src/context.ts";
import type { WorkItem, Verdict } from "../src/build/types.ts";
import type { GenerateOutput } from "../src/build/generate.ts";
import type { EvalOutput } from "../src/build/evaluate.ts";
import type { RoleRunResult } from "../src/build/roleRun.ts";
import type { ParentSummary, RunRoleSpec } from "../conductors/core/index.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

// ───────────────────────────────── shared fixtures ─────────────────────────────────

function baseInput(over: Partial<StopReportInput> = {}): StopReportInput {
  return {
    scope: "build",
    id: "u1",
    outcome: "budget_exceeded",
    reason: "cost $1.250 crossed maxBudgetUsdPerItem $1.00 (during evaluate)",
    bestScore: 71.5,
    bestRound: 1,
    rounds: 2,
    pivots: 1,
    costUsd: 1.25,
    tokensUsed: 120000,
    artifact: { worktree: ".wt/u1", branch: "sparra/u1", committed: false, uncommitted: true },
    blocking: ["CLI exits 2 on --json"],
    failedAssertions: [{ id: 4, evidence: "expected 5, got 3" }],
    verdictPath: "verdicts/r1/u1.r2.verdict.md",
    nextAction: "resume with a raised cap",
    ...over,
  };
}

// ─────────────────────────────── assertion 1: renderer ───────────────────────────────

describe("renderStopReport — assertion 1 (smoke greps)", () => {
  it("renders every fact the verify-cmd greps for", () => {
    const out = renderStopReport(baseInput());
    for (const needle of [
      "budget_exceeded",
      "maxBudgetUsdPerItem $1.00",
      "71.5",
      "1.25",
      "120000",
      "CLI exits 2 on --json",
      "#4",
      "expected 5, got 3",
      "u1.r2.verdict.md",
    ]) {
      expect(out, `missing "${needle}"`).toContain(needle);
    }
  });

  it("renders unavailable facts EXPLICITLY (never silently omitted)", () => {
    const out = renderStopReport(
      baseInput({
        bestScore: "unknown",
        bestRound: "unknown",
        costUsd: "unknown",
        tokensUsed: "unknown",
        artifact: { committed: "unknown", uncommitted: "unknown" },
        blocking: [],
        failedAssertions: [],
        verdictPath: false,
      }),
    );
    expect(out).toContain("unknown");
    // worktree absent → explicit in-place marker; branch absent → explicit "unknown" (never omitted).
    expect(out).toMatch(/\*\*Worktree:\*\* in-place \(no isolated worktree\)/);
    expect(out).toMatch(/\*\*Branch:\*\* unknown/);
    expect(out).toMatch(/\*\*Committed:\*\* unknown/);
    expect(out).toMatch(/\*\*Uncommitted work:\*\* unknown/);
    expect(out).toContain("_none reported_"); // blocking
    expect(out).toContain("_none_"); // failed assertions / verdict
  });

  it("renders a present worktree AND branch explicitly (no silent omission of either)", () => {
    const out = renderStopReport(
      baseInput({ artifact: { worktree: ".wt/u1", branch: "sparra/u1", committed: false, uncommitted: "unknown" } }),
    );
    expect(out).toMatch(/\*\*Worktree:\*\* `\.wt\/u1`/);
    expect(out).toMatch(/\*\*Branch:\*\* `sparra\/u1`/);
    expect(out).toMatch(/\*\*Committed:\*\* false/); // known boolean → literal false, not "no"
    expect(out).toMatch(/\*\*Uncommitted work:\*\* unknown/);
  });

  it("known booleans render as literal true/false (never yes/no)", () => {
    const out = renderStopReport(
      baseInput({ artifact: { worktree: ".wt/u1", branch: "sparra/u1", committed: true, uncommitted: false } }),
    );
    expect(out).toMatch(/\*\*Committed:\*\* true/);
    expect(out).toMatch(/\*\*Uncommitted work:\*\* false/);
    expect(out).not.toContain("Committed:** yes");
    expect(out).not.toContain("Committed:** no");
  });

  it("a present worktree with NO branch still renders branch explicitly as unknown", () => {
    const out = renderStopReport(
      baseInput({ artifact: { worktree: ".wt/u1", committed: false, uncommitted: false } }),
    );
    expect(out).toMatch(/\*\*Worktree:\*\* `\.wt\/u1`/);
    expect(out).toMatch(/\*\*Branch:\*\* unknown/); // branch missing → explicit, not omitted
    expect(out).toMatch(/\*\*Committed:\*\* false/);
    expect(out).toMatch(/\*\*Uncommitted work:\*\* false/);
  });

  it("does not emit thousands separators that would break a raw-number grep", () => {
    expect(renderStopReport(baseInput({ tokensUsed: 120000 }))).not.toContain("120,000");
  });
});

// ─────────────────────────── best-effort writer (assertions 8/14 core) ───────────────────────────

describe("writeStopReport — best-effort", () => {
  it("returns { written:false } and warns (never throws) on a write failure; no false claim", async () => {
    const warns: string[] = [];
    const res = await writeStopReport({
      filePath: "/nope/x.md",
      input: baseInput(),
      warn: (m) => warns.push(m),
      writeFile: async () => {
        throw new Error("disk full");
      },
    });
    expect(res.written).toBe(false);
    expect(res.path).toBeUndefined();
    expect(warns.join("\n")).toMatch(/NOT written/);
    expect(warns.join("\n")).toContain("disk full");
  });

  it("writes on success and returns the concrete path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-stop-w-"));
    try {
      const fp = path.join(dir, "sub", "x.stop.md");
      const res = await writeStopReport({ filePath: fp, input: baseInput() });
      expect(res.written).toBe(true);
      expect(res.path).toBe(fp);
      expect(fs.readFileSync(fp, "utf8")).toContain("budget_exceeded");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────────── build wiring (2–8) ─────────────────────────────────

function makeVerdict(pass: boolean, over: Partial<Verdict> = {}): Verdict {
  return {
    assertions: [],
    scores: { design: 80, originality: 80, craft: 80, functionality: 80 },
    weightedTotal: pass ? 90 : 30,
    verdict: pass ? "pass" : "fail",
    blocking: pass ? [] : ["something is wrong"],
    notes: "n",
    ...over,
  };
}
function genOut(over: Partial<GenerateOutput> = {}): GenerateOutput {
  return { report: "", deviations: [], sessionId: "g", hitMaxTurns: false, hitBudget: false, costUsd: 0.001, tokens: 100, ...over };
}
function evalOut(verdict: Verdict, over: Partial<EvalOutput> = {}): EvalOutput {
  return { verdict, raw: "", sessionId: "e", costUsd: 0.001, tokens: 100, ...over };
}

async function makeBuildCtx(buildOver: Partial<SparraConfig["build"]> = {}): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-stop-build-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  fs.writeFileSync(paths.frozenPlan, "# Plan\nBuild.\n");
  const store = StateStore.create(paths, "greenfield");
  store.data.phase = "frozen";
  const config = defaultConfig();
  config.build = { ...config.build, ...buildOver };
  return { ctx: { root: dir, paths, config, store }, dir };
}
function buildBaseDeps(): Partial<BuildDeps> {
  return {
    ensureAutoProbed: async () => {},
    negotiateContract: async () => ({ text: "contract", agreed: true, tracesUsed: 0 }),
    recordDeviations: async () => ({ changelog: 0, proposals: 0 }),
    reconcilePlan: async () => {},
  };
}
const oneItem: WorkItem[] = [{ id: "item-001", title: "first", summary: "", dependsOn: [], rationale: "" }];

function readBuildReport(ctx: Ctx): string {
  const runId = ctx.store.data.build.runId!;
  const fp = ctx.paths.stopReportFile(runId, "item-001");
  return fs.readFileSync(fp, "utf8");
}
function buildReportExists(ctx: Ctx, itemId = "item-001"): boolean {
  const runId = ctx.store.data.build.runId!;
  return fs.existsSync(ctx.paths.stopReportFile(runId, itemId));
}

describe("cmdBuild stop report — budget path (assertion 2)", () => {
  it("writes a budget_exceeded report with cap name+value, spend, best round, artifact, verdict items", async () => {
    const { ctx, dir } = await makeBuildCtx({ maxBudgetUsdPerItem: 0.01, maxRoundsPerItem: 6 });
    try {
      const failV = makeVerdict(false, {
        weightedTotal: 42,
        blocking: ["CLI exits 2 on --json"],
        assertions: [{ id: 4, pass: false, evidence: "expected 5, got 3" }],
      });
      const deps: Partial<BuildDeps> = {
        ...buildBaseDeps(),
        decompose: async () => oneItem,
        generateItem: async () => genOut(),
        // Cross the cap DURING evaluate, so a verdict exists when the halt fires.
        evaluateItem: async () => evalOut(failV, { costUsd: 5 }),
      };
      await cmdBuild(ctx, { workspaceOverride: dir }, deps);
      expect(ctx.store.data.build.items["item-001"]!.status).toBe("budget_exceeded");
      const r = readBuildReport(ctx);
      expect(r).toContain("budget_exceeded");
      expect(r).toContain("maxBudgetUsdPerItem"); // cap NAME
      expect(r).toMatch(/maxBudgetUsdPerItem \$0\.01/); // configured VALUE
      // Exact accumulated spend (independently: gen 100 tok + eval 100 tok = 200; read off state, not
      // hard-coded to a magic literal — but asserted present verbatim in the report).
      const st = ctx.store.data.build.items["item-001"]!;
      expect(st.tokensUsed).toBe(200);
      expect(r).toContain("200 tokens");
      expect(r).toMatch(/Spend:\*\* \$5\.001 \/ 200 tokens/); // gen 0.001 + eval 5.000
      // Artifact facts EXPLICIT: committed known-false; uncommitted unknown (git status not run);
      // in-place build → worktree in-place, branch unknown.
      expect(r).toMatch(/Committed:\*\* false/);
      expect(r).toMatch(/Uncommitted work:\*\* unknown/);
      expect(r).toMatch(/\*\*Worktree:\*\* in-place \(no isolated worktree\)/);
      expect(r).toMatch(/\*\*Branch:\*\* unknown/);
      expect(r).toContain("#4");
      expect(r).toContain("expected 5, got 3");
      expect(r).toContain("CLI exits 2 on --json");
      expect(r).toContain(".verdict.md"); // pointer to the most recent verdict
      expect(r).toMatch(/Best score:\*\* 42 \(round 1\)/);
      expect(r).toMatch(/Rounds used:\*\* 1/);
      expect(r).toMatch(/Pivots used:\*\* 0/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cmdBuild stop report — best-round non-degenerate (assertion 3)", () => {
  it("names the EARLIER higher-scoring round, not the terminal one", async () => {
    const { ctx, dir } = await makeBuildCtx({ maxRoundsPerItem: 2, maxBudgetUsdPerItem: 0 });
    try {
      let round = 0;
      const deps: Partial<BuildDeps> = {
        ...buildBaseDeps(),
        decompose: async () => oneItem,
        generateItem: async () => genOut(),
        evaluateItem: async () => {
          round += 1;
          // r1 = 71.5 (higher), terminal r2 = 55 — both FAIL (below pass threshold).
          return evalOut(makeVerdict(false, { weightedTotal: round === 1 ? 71.5 : 55 }));
        },
      };
      await cmdBuild(ctx, { workspaceOverride: dir }, deps);
      expect(ctx.store.data.build.items["item-001"]!.status).toBe("failed");
      const r = readBuildReport(ctx);
      expect(r).toMatch(/Best score:\*\* 71\.5 \(round 1\)/);
      expect(r).not.toMatch(/Best score:\*\* 55/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cmdBuild stop report — latest-verdict non-degenerate (assertion 4)", () => {
  it("carries r2's items + r2 verdict path, not r1's stale content", async () => {
    const { ctx, dir } = await makeBuildCtx({ maxRoundsPerItem: 2, maxBudgetUsdPerItem: 0 });
    try {
      let round = 0;
      const deps: Partial<BuildDeps> = {
        ...buildBaseDeps(),
        decompose: async () => oneItem,
        generateItem: async () => genOut(),
        evaluateItem: async () => {
          round += 1;
          return evalOut(
            makeVerdict(false, {
              weightedTotal: 40,
              blocking: round === 1 ? ["STALE-R1-BLOCK"] : ["FRESH-R2-BLOCK"],
              assertions:
                round === 1
                  ? [{ id: 1, pass: false, evidence: "R1-EVIDENCE" }]
                  : [{ id: 2, pass: false, evidence: "R2-EVIDENCE" }],
            }),
          );
        },
      };
      await cmdBuild(ctx, { workspaceOverride: dir }, deps);
      const r = readBuildReport(ctx);
      expect(r).toContain("FRESH-R2-BLOCK");
      expect(r).toContain("R2-EVIDENCE");
      expect(r).toContain(".r2.verdict.md");
      expect(r).not.toContain("STALE-R1-BLOCK");
      expect(r).not.toContain("R1-EVIDENCE");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cmdBuild stop report — rounds-exhausted failed (assertion 5)", () => {
  it("names rounds exhausted + maxRoundsPerItem (NOT a budget reason)", async () => {
    const { ctx, dir } = await makeBuildCtx({ maxRoundsPerItem: 2, maxBudgetUsdPerItem: 0 });
    try {
      const deps: Partial<BuildDeps> = {
        ...buildBaseDeps(),
        decompose: async () => oneItem,
        generateItem: async () => genOut(),
        evaluateItem: async () => evalOut(makeVerdict(false)),
      };
      await cmdBuild(ctx, { workspaceOverride: dir }, deps);
      expect(ctx.store.data.build.items["item-001"]!.status).toBe("failed");
      const r = readBuildReport(ctx);
      expect(r).toContain("maxRoundsPerItem");
      expect(r).toMatch(/Outcome:\*\* failed/);
      expect(r).not.toContain("budget_exceeded");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocked/inconclusive: report names the BLOCKED exercise reason, not a behavioral fail", async () => {
    const { ctx, dir } = await makeBuildCtx({ maxRoundsPerItem: 2, maxBudgetUsdPerItem: 0 });
    try {
      const blockedV = makeVerdict(false, {
        exerciseStatus: "blocked",
        blocking: ["sandbox denied listen(2)"],
        assertions: [{ id: 9, pass: false, evidence: "could not exercise" }],
      });
      const deps: Partial<BuildDeps> = {
        ...buildBaseDeps(),
        decompose: async () => oneItem,
        generateItem: async () => genOut(),
        evaluateItem: async () => evalOut(blockedV),
      };
      await cmdBuild(ctx, { workspaceOverride: dir }, deps);
      expect(ctx.store.data.build.items["item-001"]!.status).toBe("failed"); // terminal status
      const r = readBuildReport(ctx);
      expect(r).toMatch(/Outcome:\*\* inconclusive/);
      expect(r).toMatch(/BLOCKED/i);
      expect(r).toContain("maxRoundsPerItem"); // never verified within the round cap
      expect(r).not.toContain("budget_exceeded");
      // Latest verdict's redacted items still surface.
      expect(r).toContain("sandbox denied listen(2)");
      expect(r).toContain("#9");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("interactive human-abandoned: report names the human abandon reason", async () => {
    const { ctx, dir } = await makeBuildCtx({ maxRoundsPerItem: 6, maxBudgetUsdPerItem: 0 });
    try {
      const deps: Partial<BuildDeps> = {
        ...buildBaseDeps(),
        decompose: async () => oneItem,
        generateItem: async () => genOut(),
        evaluateItem: async () => evalOut(makeVerdict(false, { blocking: ["needs rethink"] })),
      };
      // Pause after round 1, then the human abandons on resume.
      await cmdBuild(ctx, { workspaceOverride: dir, step: ["round"] }, deps);
      const runId = ctx.store.data.build.runId!;
      const pd = pauseDir(ctx, runId, "item-001");
      fs.writeFileSync(path.join(pd, "decision.json"), JSON.stringify({ decision: "abandon", reason: "" }));
      await cmdBuild(ctx, { workspaceOverride: dir }, deps);
      expect(ctx.store.data.build.items["item-001"]!.status).toBe("abandoned");
      const r = readBuildReport(ctx);
      expect(r).toMatch(/Outcome:\*\* abandoned/);
      expect(r).toMatch(/human abandoned/i);
      expect(r).not.toContain("budget_exceeded");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cmdBuild stop report — passed produces NO report (assertion 6)", () => {
  it("an accepted item writes no stop report file", async () => {
    const { ctx, dir } = await makeBuildCtx({ maxRoundsPerItem: 2 });
    try {
      const deps: Partial<BuildDeps> = {
        ...buildBaseDeps(),
        decompose: async () => oneItem,
        generateItem: async () => genOut(),
        evaluateItem: async () => evalOut(makeVerdict(true)),
      };
      await cmdBuild(ctx, { workspaceOverride: dir }, deps);
      expect(ctx.store.data.build.items["item-001"]!.status).toBe("passed");
      expect(buildReportExists(ctx)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cmdBuild stop report — holdout canary (assertion 7)", () => {
  it("report carries redacted blocking, never the raw-output canary", async () => {
    const { ctx, dir } = await makeBuildCtx({ maxBudgetUsdPerItem: 0.01, maxRoundsPerItem: 6 });
    try {
      const canary = "HOLDOUT-CANARY-XYZ";
      const deps: Partial<BuildDeps> = {
        ...buildBaseDeps(),
        decompose: async () => oneItem,
        generateItem: async () => genOut(),
        // raw evaluator output carries the canary; the REDACTED blocking differs. Cross the cap
        // during evaluate so the verdict is captured into the report.
        evaluateItem: async () =>
          evalOut(makeVerdict(false, { blocking: ["redacted safe blocker"] }), { raw: `leak ${canary}`, costUsd: 5 }),
      };
      await cmdBuild(ctx, { workspaceOverride: dir }, deps);
      const r = readBuildReport(ctx);
      expect(r).toContain("redacted safe blocker");
      expect(r).not.toContain(canary);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cmdBuild stop report — best-effort truthful (assertion 8)", () => {
  it("a write failure leaves the outcome intact, warns FAILED, never claims the report exists", async () => {
    const { ctx, dir } = await makeBuildCtx({ maxBudgetUsdPerItem: 0.01, maxRoundsPerItem: 6 });
    const warns: string[] = [];
    try {
      const deps: Partial<BuildDeps> = {
        ...buildBaseDeps(),
        decompose: async () => oneItem,
        generateItem: async () => genOut({ costUsd: 5 }),
        evaluateItem: async () => evalOut(makeVerdict(false)),
        // Force the underlying fs write to throw — the real best-effort writer must catch + warn.
        writeStopReport: (opts) =>
          writeStopReport({
            ...opts,
            warn: (m) => warns.push(m),
            writeFile: async () => {
              throw new Error("injected disk failure");
            },
          }),
      };
      await cmdBuild(ctx, { workspaceOverride: dir }, deps);
      expect(ctx.store.data.build.items["item-001"]!.status).toBe("budget_exceeded");
      expect(buildReportExists(ctx)).toBe(false);
      expect(warns.join("\n")).toMatch(/NOT written/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────── UN-RUN payload filter (assertion 12 direct) ───────────────────────────

describe("buildRunRolePayload — excludes UN-RUN ids from failedAssertions (assertion 12)", () => {
  it("keeps genuine failures, drops un-run ids", () => {
    const r: RoleRunResult = {
      ok: true,
      roleKind: "evaluator",
      backend: "stub",
      model: "m",
      resultText: "",
      traceDir: "",
      sessionId: "s",
      costUsd: 0,
      tokens: 0,
      errors: [],
      verdict: {
        assertions: [
          { id: 4, pass: false, evidence: "genuine fail" },
          { id: 7, pass: false, evidence: "unrun evidence" },
        ],
        unrunAssertionIds: [7],
        scores: { design: 1, originality: 1, craft: 1, functionality: 1 },
        weightedTotal: 10,
        verdict: "fail",
        blocking: [],
        notes: "",
      },
    };
    const payload = buildRunRolePayload(r, 75);
    const ids = (payload.failedAssertions ?? []).map((a) => a.id);
    expect(ids).toContain(4);
    expect(ids).not.toContain(7);
    expect(JSON.stringify(payload.failedAssertions)).not.toContain("unrun evidence");
  });
});

// ───────────────────────────────── conduct wiring (9–15) ─────────────────────────────────

function summary(o: Partial<ParentSummary>): ParentSummary {
  return { roleKind: "generator", backend: "stub", model: "m", ok: true, errors: [], tokens: 100, costUsd: 0.01, ...o };
}
function argVal(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
function kindOf(args: string[]): string {
  const i = args.indexOf("--kind");
  return i >= 0 ? args[i + 1]! : "?";
}
function decomposer(): (p: RunSessionParams) => Promise<RunResult> {
  return async () => ({
    ok: true,
    subtype: "success",
    resultText: '```json\n[{"id":"unit-001","title":"U","summary":"s","rationale":"r"}]\n```',
    sessionId: "d",
    costUsd: 0,
    tokens: 1,
    numTurns: 1,
    hitMaxTurns: false,
    hitBudget: false,
    errors: [],
    tracePath: "",
  });
}
function brainAnswer(answer: string): (p: RunSessionParams) => Promise<RunResult> {
  return async () => ({
    ok: true,
    subtype: "success",
    resultText: "```json\n" + JSON.stringify({ answer }) + "\n```",
    sessionId: "b",
    costUsd: 0,
    tokens: 1,
    numTurns: 1,
    hitMaxTurns: false,
    hitBudget: false,
    errors: [],
    tracePath: "",
  });
}
/** A runner whose evaluator returns a scripted per-round summary; contract roles converge. */
function conductRunner(evalByRound: (round: number) => Partial<ParentSummary>) {
  let evalRound = 0;
  return async (spec: RunRoleSpec): Promise<ParentSummary> => {
    const kind = kindOf(spec.args);
    if (kind === "contract-generator") {
      const out = argVal(spec.args, "--out");
      if (out) fs.writeFileSync(out, "C");
      return summary({ roleKind: "contract-generator", ...(out ? { outPath: out } : {}) });
    }
    if (kind === "contract-evaluator") return summary({ roleKind: "contract-evaluator", contractAgreed: true });
    if (kind === "generator") return summary({ roleKind: "generator", filesChanged: 1 });
    evalRound += 1;
    return summary({ roleKind: "evaluator", verdict: "fail", ...evalByRound(evalRound) });
  };
}

function unitEntry(res: ConductResult, id = "unit-001") {
  return res.state.units.find((u) => u.id === id)!;
}

async function makeConductCtx(over: Partial<SparraConfig["build"]> = {}): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-stop-conduct-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  const config = defaultConfig();
  config.build = { ...config.build, ...over };
  return { ctx: { root: dir, paths, config, store }, dir };
}

describe("runConduct stop report — exhausted via llm brain (assertion 9)", () => {
  it("writes a rich stop report + records the path, asserted against INDEPENDENTLY-summed spend", async () => {
    const { ctx, dir } = await makeConductCtx({ maxRoundsPerItem: 2 });
    try {
      // INDEPENDENT aggregation: sum every role-run summary's cost/tokens in the fake runner itself,
      // NOT read back from the entry-under-test — so a shared/incorrect aggregation in run.ts is
      // caught by a mismatch instead of silently agreeing with itself. Distinct per-kind costs make an
      // omitted/double-counted role run change the total.
      let expectCost = 0;
      let expectTokens = 0;
      let evalRounds = 0;
      const base = conductRunner((r) => ({
        weightedTotal: r === 1 ? 60 : 50,
        blocking: [`R${r}-BLOCK`],
        failedAssertions: [{ id: 4, pass: false, evidence: `R${r}-EV` }] as ParentSummary["failedAssertions"],
        verdictPath: `/v/r${r}.verdict.md`,
        costUsd: 0.05,
        tokens: 700,
      }));
      const runner = async (spec: RunRoleSpec): Promise<ParentSummary> => {
        const s = await base(spec);
        if (kindOf(spec.args) === "evaluator") evalRounds += 1;
        expectCost += s.costUsd ?? 0;
        expectTokens += s.tokens ?? 0;
        return s;
      };
      const res = await runConduct(
        ctx,
        { prompt: "p", maxUnits: 1, concurrency: 1, dryRun: false, brain: "llm" },
        { runRole: runner, runSessionFn: decomposer(), brainSessionFn: brainAnswer("run") },
      );
      const entry = unitEntry(res);
      // Independent facts computed from the fixture, not the entry.
      const expectedRounds = 2; // maxRoundsPerItem, llm always "run"
      const expectedPivots = 0;
      const expectedBestRound = 1; // r1=60 > r2=50
      const expectedBestScore = 60;
      const expectedPath = path.join(res.runDir, "unit-001", "stop.md");

      expect(entry.outcome).toBe("exhausted");
      expect(evalRounds).toBe(expectedRounds); // the fixture really ran 2 evaluated rounds
      expect(entry.cost).toBeCloseTo(expectCost, 10);
      expect(entry.tokens).toBe(expectTokens);
      expect(entry.stopReport).toBe(expectedPath); // concrete output path

      const r = fs.readFileSync(expectedPath, "utf8");
      expect(r).toMatch(/Outcome:\*\* exhausted/);
      expect(r).toMatch(/maxRoundsPerItem 2/); // concrete round cap that stopped it
      expect(r).toContain(`Spend:** $${expectCost.toFixed(3)} / ${expectTokens} tokens`);
      expect(r).not.toMatch(/Spend:\*\*.*unknown/);
      expect(r).toMatch(new RegExp(`Rounds used:\\*\\* ${expectedRounds}`));
      expect(r).toMatch(new RegExp(`Pivots used:\\*\\* ${expectedPivots}`));
      expect(r).toMatch(new RegExp(`Best score:\\*\\* ${expectedBestScore} \\(round ${expectedBestRound}\\)`));
      // latest verdict (r2) items only.
      expect(r).toContain("R2-BLOCK");
      expect(r).toContain("R2-EV");
      expect(r).toContain("#4");
      expect(r).toContain("r2.verdict.md");
      expect(r).not.toContain("R1-BLOCK");
      // artifact state explicit (no unitWorktree in this fixture).
      expect(r).toMatch(/\*\*Worktree:\*\* in-place \(no isolated worktree\)/);
      expect(r).toMatch(/\*\*Branch:\*\* unknown/);
      expect(r).toMatch(/Committed:\*\* false/);
      expect(r).toMatch(/Uncommitted work:\*\* unknown/);
      // next action derived from the tripped limit.
      expect(r).toMatch(/## Suggested next action[\s\S]*maxRoundsPerItem/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("abandoned (llm) writes a report; error report includes the error string", async () => {
    const { ctx, dir } = await makeConductCtx({ maxRoundsPerItem: 2 });
    try {
      const runner = conductRunner(() => ({ weightedTotal: 20, blocking: ["b"] }));
      const abandoned = await runConduct(
        ctx,
        { prompt: "p", maxUnits: 1, concurrency: 1, dryRun: false, brain: "llm" },
        { runRole: runner, runSessionFn: decomposer(), brainSessionFn: brainAnswer("abandon") },
      );
      const ae = unitEntry(abandoned);
      expect(ae.outcome).toBe("abandoned");
      expect(ae.stopReport).toBeTruthy();

      const { ctx: ctx2, dir: dir2 } = await makeConductCtx({ maxRoundsPerItem: 2 });
      const throwingRunner = async (spec: RunRoleSpec): Promise<ParentSummary> => {
        if (kindOf(spec.args) === "generator") throw new Error("BOOM-UNIT-ERROR");
        return conductRunner(() => ({}))(spec);
      };
      const errored = await runConduct(
        ctx2,
        { prompt: "p", maxUnits: 1, concurrency: 1, dryRun: false, brain: "llm" },
        { runRole: throwingRunner, runSessionFn: decomposer(), brainSessionFn: brainAnswer("run") },
      );
      const ee = unitEntry(errored);
      expect(ee.outcome).toBe("error");
      expect(ee.stopReport).toBeTruthy();
      expect(fs.readFileSync(ee.stopReport!, "utf8")).toContain("BOOM-UNIT-ERROR");
      fs.rmSync(dir2, { recursive: true, force: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runConduct stop report — deterministic branch coverage (assertion 11)", () => {
  it("the shared choke point writes the report on the no-brain path too", async () => {
    const { ctx, dir } = await makeConductCtx({ maxRoundsPerItem: 2 });
    try {
      const runner = conductRunner((r) => ({
        weightedTotal: r === 1 ? 72 : 58,
        blocking: [r === 1 ? "STALE-C1-BLOCK" : "FRESH-C2-BLOCK"],
        failedAssertions: [{ id: 3, pass: false, evidence: r === 1 ? "C1-EV" : "C2-EV" }] as ParentSummary["failedAssertions"],
        verdictPath: `/v/c${r}.verdict.md`,
      }));
      const res = await runConduct(
        ctx,
        { prompt: "p", maxUnits: 1, concurrency: 1, dryRun: false },
        { runRole: runner, runSessionFn: decomposer() },
      );
      const entry = unitEntry(res);
      expect(entry.outcome).toBe("exhausted");
      expect(entry.stopReport).toBeTruthy();
      const r = fs.readFileSync(entry.stopReport!, "utf8");
      // best-round + latest-verdict non-degenerate on the deterministic path (assertion 10 analogue).
      expect(r).toMatch(/Best score:\*\* 72 \(round 1\)/);
      expect(r).toContain("FRESH-C2-BLOCK");
      expect(r).toContain("C2-EV");
      expect(r).toContain("c2.verdict.md");
      expect(r).not.toContain("STALE-C1-BLOCK");
      expect(r).not.toContain("C1-EV");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runConduct stop report — accepted gets NO report (assertion 13)", () => {
  it("an accepted unit has no stopReport field and no stop.md", async () => {
    const { ctx, dir } = await makeConductCtx({ maxRoundsPerItem: 2 });
    try {
      // llm brain answers "accept" on the first drive → accepted with no rounds.
      const runner = conductRunner(() => ({ verdict: "pass", weightedTotal: 95 }));
      const res = await runConduct(
        ctx,
        { prompt: "p", maxUnits: 1, concurrency: 1, dryRun: false, brain: "llm" },
        { runRole: runner, runSessionFn: decomposer(), brainSessionFn: brainAnswer("accept") },
      );
      const entry = unitEntry(res);
      expect(entry.outcome).toBe("accepted");
      expect(entry.stopReport).toBeUndefined();
      expect(fs.existsSync(path.join(res.runDir, "unit-001", "stop.md"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runConduct stop report — UN-RUN composition (assertion 12)", () => {
  it("report shows the genuine failure's evidence; the un-run id AND its evidence are absent", async () => {
    const { ctx, dir } = await makeConductCtx({ maxRoundsPerItem: 1 });
    try {
      // Route the assertions through the REAL envelope filter (buildRunRolePayload): a genuine failure
      // #4 and an UN-RUN #7 (in unrunAssertionIds) — the payload drops #7, so the report must too.
      const rr: RoleRunResult = {
        ok: true,
        roleKind: "evaluator",
        backend: "stub",
        model: "m",
        resultText: "",
        traceDir: "",
        sessionId: "s",
        costUsd: 0,
        tokens: 0,
        errors: [],
        verdict: {
          assertions: [
            { id: 4, pass: false, evidence: "GENUINE-4-EV" },
            { id: 7, pass: false, evidence: "UNRUN-7-EV" },
          ],
          unrunAssertionIds: [7],
          scores: { design: 1, originality: 1, craft: 1, functionality: 1 },
          weightedTotal: 30,
          verdict: "fail",
          blocking: ["b"],
          notes: "",
        },
      };
      const filtered = buildRunRolePayload(rr, 75).failedAssertions;
      const runner = conductRunner(() => ({
        weightedTotal: 30,
        blocking: ["b"],
        failedAssertions: filtered,
        verdictPath: "/v/r1.verdict.md",
      }));
      const res = await runConduct(
        ctx,
        { prompt: "p", maxUnits: 1, concurrency: 1, dryRun: false, brain: "llm" },
        { runRole: runner, runSessionFn: decomposer(), brainSessionFn: brainAnswer("run") },
      );
      const entry = unitEntry(res);
      expect(entry.outcome).toBe("exhausted");
      const r = fs.readFileSync(entry.stopReport!, "utf8");
      expect(r).toContain("#4");
      expect(r).toContain("GENUINE-4-EV");
      expect(r).not.toContain("#7");
      expect(r).not.toContain("UNRUN-7-EV");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runConduct stop report — best-effort truthful (assertion 14)", () => {
  it("a write failure: outcome unchanged, no stopReport, warning names the failed write, --status shows no path", async () => {
    const { ctx, dir } = await makeConductCtx({ maxRoundsPerItem: 2 });
    try {
      const warns: string[] = [];
      const runner = conductRunner(() => ({ weightedTotal: 30, blocking: ["b"] }));
      const res = await runConduct(
        ctx,
        { prompt: "p", maxUnits: 1, concurrency: 1, dryRun: false, brain: "llm" },
        {
          runRole: runner,
          runSessionFn: decomposer(),
          brainSessionFn: brainAnswer("run"),
          writeStopReportFn: (opts) =>
            writeStopReport({
              ...opts,
              warn: (m) => warns.push(m),
              writeFile: async () => {
                throw new Error("injected conduct write failure");
              },
            }),
        },
      );
      const entry = unitEntry(res);
      expect(entry.outcome).toBe("exhausted"); // outcome unchanged by the write failure
      expect(entry.stopReport).toBeUndefined(); // never falsely claims the artifact exists
      expect(fs.existsSync(path.join(res.runDir, "unit-001", "stop.md"))).toBe(false);
      // The warning names the failure (unit id + the underlying error).
      const warnText = warns.join("\n");
      expect(warnText).toMatch(/NOT written/);
      expect(warnText).toContain("unit-001");
      expect(warnText).toContain("injected conduct write failure");

      // `conduct --status` surfaces NO stop-report path for this unit (nothing was written).
      const statusCtx = await loadCtxForRole(dir, { probeAuto: async () => {} });
      const { out } = await captureConduct(() => cmdConductStatus(statusCtx, res.runId, {}));
      expect(out).toContain("unit-001");
      expect(out).not.toContain("stop-report=");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct --status stop-report path display (assertion 15)", () => {
  it("prints the CONCRETE stopReport path for a non-pass unit that has one", async () => {
    const { ctx, dir } = await makeConductCtx({ maxRoundsPerItem: 2 });
    try {
      // A real deterministic exhausted run writes the report + records the path on run.json.
      const runner = conductRunner(() => ({ weightedTotal: 30, blocking: ["b"] }));
      const res = await runConduct(
        ctx,
        { prompt: "p", maxUnits: 1, concurrency: 1, dryRun: false },
        { runRole: runner, runSessionFn: decomposer() },
      );
      const entry = unitEntry(res);
      expect(entry.outcome).toBe("exhausted");
      expect(entry.stopReport).toBeTruthy();

      const statusCtx = await loadCtxForRole(dir, { probeAuto: async () => {} });
      const { out, exit } = await captureConduct(() => cmdConductStatus(statusCtx, res.runId, {}));
      expect(exit).toBe(0);
      expect(out).toContain(`stop-report=${entry.stopReport}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────── sparra status surfacing (assertion 15) ───────────────────────────

/** Capture stdout+stderr with the phase logger un-silenced (it's gated on VITEST). */
function captureStdout() {
  const prior = process.env.SPARRA_LOG_IN_TESTS;
  process.env.SPARRA_LOG_IN_TESTS = "1";
  let buf = "";
  const sink = (chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  const o = vi.spyOn(process.stdout, "write").mockImplementation(sink as typeof process.stdout.write);
  const e = vi.spyOn(process.stderr, "write").mockImplementation(sink as typeof process.stderr.write);
  return {
    text: () => buf,
    restore: () => {
      o.mockRestore();
      e.mockRestore();
      if (prior === undefined) delete process.env.SPARRA_LOG_IN_TESTS;
      else process.env.SPARRA_LOG_IN_TESTS = prior;
    },
  };
}

/** Run a conduct reporting command with stdout+stderr captured + the resulting exit code. */
async function captureConduct(fn: () => Promise<void>): Promise<{ out: string; exit: number }> {
  const prior = process.exitCode;
  process.exitCode = 0;
  const cap = captureStdout();
  try {
    await fn();
  } finally {
    cap.restore();
  }
  const exit = typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = prior;
  return { out: cap.text(), exit };
}

describe("sparra status stop-report surfacing (assertion 15)", () => {
  it("prints the concrete stop-report path for a non-pass item that has a report", async () => {
    const { ctx, dir } = await makeBuildCtx();
    try {
      const runId = "build-20260725-abc";
      ctx.store.data.build.runId = runId;
      ctx.store.data.build.items["item-001"] = {
        status: "budget_exceeded",
        round: 2,
        pivots: 1,
        criterionFailStreak: {},
        lastScore: 42,
      };
      const reportPath = ctx.paths.stopReportFile(runId, "item-001");
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, renderStopReport(baseInput({ id: "item-001" })));

      const cap = captureStdout();
      try {
        cmdStatus(ctx);
      } finally {
        cap.restore();
      }
      const out = cap.text();
      expect(out).toContain("stop report:");
      expect(out).toContain(path.relative(ctx.root, reportPath));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders without error or a spurious marker when a non-pass item has NO report (older run)", async () => {
    const { ctx, dir } = await makeBuildCtx();
    try {
      ctx.store.data.build.runId = "build-old-run";
      ctx.store.data.build.items["item-001"] = {
        status: "failed",
        round: 3,
        pivots: 0,
        criterionFailStreak: {},
      };
      // No report file written for this run/item.
      const cap = captureStdout();
      let threw = false;
      try {
        cmdStatus(ctx);
      } catch {
        threw = true;
      } finally {
        cap.restore();
      }
      expect(threw).toBe(false);
      expect(cap.text()).not.toContain("stop report:");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
