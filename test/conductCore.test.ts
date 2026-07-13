import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { loadCtxForRole, type Ctx } from "../src/context.ts";
import { runConduct, type ConductDeps, type ConductOptions } from "../src/conduct/run.ts";
import { deterministicStrategy, type JudgmentStrategy } from "../src/conduct/strategy.ts";
import { resolveSparraBin } from "../src/conduct/roleSpecs.ts";
import { decideFromEvaluation, type ParentSummary, type RunRoleSpec } from "../conductors/core/index.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";
import { makeBrain, type Brain, type DriveContext } from "../src/conduct/brain.ts";
import { buildDecisionRequest, type BrainDecision, type DecisionRequest } from "../src/conduct/decision.ts";
import { resolveDecision, type DecisionEngineDeps } from "../src/conduct/decisionEngine.ts";
import { classifyRecovery, buildRecoverySpec } from "../src/conduct/recovery.ts";
import type { RoleConfig } from "../src/config.ts";

const noProbe = async (): Promise<void> => {};

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sparra-conduct-"));
}

async function makeCtx(dir: string): Promise<Ctx> {
  return loadCtxForRole(dir, { probeAuto: noProbe });
}

/** Minimal well-formed ParentSummary. */
function summary(overrides: Partial<ParentSummary>): ParentSummary {
  return {
    roleKind: "generator",
    backend: "stub",
    model: "stub-1",
    ok: true,
    errors: [],
    tokens: 0,
    costUsd: 0,
    ...overrides,
  };
}

/** A decomposer session fake returning `n` units as a JSON block. */
function decomposerFn(n: number): (p: RunSessionParams) => Promise<RunResult> {
  return async (_p) => {
    const units = Array.from({ length: n }, (_, i) => ({
      id: `unit-${String(i + 1).padStart(3, "0")}`,
      title: `Unit ${i + 1}`,
      summary: `Do thing ${i + 1}.`,
      rationale: "because",
    }));
    return {
      ok: true,
      subtype: "success",
      resultText: "```json\n" + JSON.stringify(units) + "\n```",
      sessionId: "d",
      costUsd: 0,
      tokens: 1,
      numTurns: 1,
      hitMaxTurns: false,
      hitBudget: false,
      errors: [],
      tracePath: "",
    };
  };
}

function kindOf(args: string[]): string {
  const i = args.indexOf("--kind");
  return i >= 0 ? args[i + 1]! : args[0] === "eval" ? "evaluator" : "?";
}
function argVal(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
function argVals(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag) out.push(args[i + 1]!);
  return out;
}

interface FakeRunner {
  runRole: (spec: RunRoleSpec) => Promise<ParentSummary>;
  specs: RunRoleSpec[];
}
function fakeRunner(handler: (c: { kind: string; unit?: string; spec: RunRoleSpec }) => Promise<ParentSummary> | ParentSummary): FakeRunner {
  const specs: RunRoleSpec[] = [];
  return {
    specs,
    runRole: async (spec: RunRoleSpec) => {
      specs.push(spec);
      const kind = kindOf(spec.args);
      const unit = spec.env?.SPARRA_CONDUCT_UNIT as string | undefined;
      return handler({ kind, unit, spec });
    },
  };
}

const OPTS = (o: Partial<ConductOptions> = {}): ConductOptions => ({
  prompt: "build a thing",
  maxUnits: 4,
  concurrency: 2,
  dryRun: false,
  ...o,
});

describe("conduct core — decompose + wiring", () => {
  it("assertion 4/19: decompose clamps to --max-units, writes briefs, creates .sparra/conduct without init", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      expect(fs.existsSync(path.join(dir, ".sparra"))).toBe(false); // no init
      const runner = fakeRunner(({ kind, spec }) => {
        if (kind === "contract-generator") {
          fs.writeFileSync(argVal(spec.args, "--out")!, "PROPOSAL");
          return summary({ roleKind: "contract-generator", outPath: argVal(spec.args, "--out") });
        }
        if (kind === "contract-evaluator") return summary({ roleKind: "contract-evaluator", contractAgreed: true });
        if (kind === "generator") return summary({ roleKind: "generator", filesChanged: 1 });
        return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false });
      });
      const res = await runConduct(ctx, OPTS({ maxUnits: 2 }), {
        runRole: runner.runRole,
        runSessionFn: decomposerFn(5), // over-splits → clamp to 2
      });
      expect(res.state.units).toHaveLength(2);
      expect(fs.existsSync(path.join(res.runDir, "unit-001", "brief.md"))).toBe(true);
      expect(fs.existsSync(path.join(res.runDir, "unit-002", "brief.md"))).toBe(true);
      expect(fs.existsSync(path.join(res.runDir, "run.json"))).toBe(true);

      // Single-unit run also proceeds.
      const dir2 = tmpdir();
      const ctx2 = await makeCtx(dir2);
      const res2 = await runConduct(ctx2, OPTS(), { runRole: runner.runRole, runSessionFn: decomposerFn(1) });
      expect(res2.state.units).toHaveLength(1);
      fs.rmSync(dir2, { recursive: true, force: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 11: --dry-run runs ONLY the decomposer (zero role runs), writes briefs + run.json, status dry-run", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      let roleCalls = 0;
      const res = await runConduct(ctx, OPTS({ dryRun: true }), {
        runRole: async () => {
          roleCalls++;
          return summary({});
        },
        runSessionFn: decomposerFn(3),
      });
      expect(roleCalls).toBe(0);
      expect(res.state.status).toBe("dry-run");
      expect(res.state.units.every((u) => u.outcome === "dry-run")).toBe(true);
      expect(fs.existsSync(path.join(res.runDir, "unit-001", "brief.md"))).toBe(true);
      const rj = JSON.parse(fs.readFileSync(path.join(res.runDir, "run.json"), "utf8"));
      expect(rj.status).toBe("dry-run");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct core — multi-unit flow + feedback threading", () => {
  it("assertion 1: unit A eval FAIL→PASS threads feedback into round-2 generator; unit B independent; both in run.json", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const genBriefTexts: Record<string, string[]> = {};
      const evalRounds: Record<string, number> = {};
      const runner = fakeRunner(({ kind, unit, spec }) => {
        if (kind === "contract-generator") {
          fs.writeFileSync(argVal(spec.args, "--out")!, "C");
          return summary({ roleKind: "contract-generator", outPath: argVal(spec.args, "--out") });
        }
        if (kind === "contract-evaluator") return summary({ roleKind: "contract-evaluator", contractAgreed: true });
        if (kind === "generator") {
          const bt = argVal(spec.args, "--brief-text");
          if (bt) (genBriefTexts[unit!] ??= []).push(bt);
          return summary({ roleKind: "generator", filesChanged: 1 });
        }
        // evaluator: unit-001 fails once then passes; unit-002 passes immediately.
        evalRounds[unit!] = (evalRounds[unit!] ?? 0) + 1;
        if (unit === "unit-001" && evalRounds[unit!] === 1) {
          return summary({ roleKind: "evaluator", verdict: "fail", blocking: ["FEEDBACK-XYZ missing test"], sameModelGrade: false });
        }
        return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false });
      });
      const res = await runConduct(ctx, OPTS({ concurrency: 2 }), {
        runRole: runner.runRole,
        runSessionFn: decomposerFn(2),
      });
      expect(res.state.units).toHaveLength(2);
      const a = res.state.units.find((u) => u.id === "unit-001")!;
      const b = res.state.units.find((u) => u.id === "unit-002")!;
      expect(a.outcome).toBe("accepted");
      expect(b.outcome).toBe("accepted");
      // The round-2 generator for unit-001 received the round-1 blocking feedback.
      expect(genBriefTexts["unit-001"]?.some((t) => t.includes("FEEDBACK-XYZ"))).toBe(true);
      expect(genBriefTexts["unit-002"] ?? []).toHaveLength(0); // B never revised
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct core — cross-model gate + judgment strategy", () => {
  it("assertion 2/17: deterministic strategy == decideFromEvaluation; sameModelGrade pass NOT accepted, cross-model pass accepted", async () => {
    const pass = summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false });
    const collapsed = summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: true });
    const cfg = { pivotAfterFailures: 2, requireCrossModel: true };
    expect(deterministicStrategy.decide(pass, { consecutiveFailures: 0 }, cfg)).toBe(
      decideFromEvaluation(pass, { consecutiveFailures: 0 }, cfg),
    );
    expect(deterministicStrategy.decide(collapsed, { consecutiveFailures: 0 }, cfg)).toBe(
      decideFromEvaluation(collapsed, { consecutiveFailures: 0 }, cfg),
    );
    expect(deterministicStrategy.decide(pass, { consecutiveFailures: 0 }, cfg)).toBe("accept");
    expect(deterministicStrategy.decide(collapsed, { consecutiveFailures: 0 }, cfg)).toBe("grade-not-independent");
  });

  it("assertion 2: end-to-end — sameModelGrade pass yields NON-accepted unit; cross-model pass accepted", async () => {
    const dir = tmpdir();
    try {
      const mk = (sameModel: boolean) =>
        fakeRunner(({ kind, spec }) => {
          if (kind === "contract-generator") {
            fs.writeFileSync(argVal(spec.args, "--out")!, "C");
            return summary({ roleKind: "contract-generator", outPath: argVal(spec.args, "--out") });
          }
          if (kind === "contract-evaluator") return summary({ roleKind: "contract-evaluator", contractAgreed: true });
          if (kind === "generator") return summary({ roleKind: "generator", filesChanged: 1 });
          return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: sameModel });
        });
      const ctxA = await makeCtx(tmpdir());
      const resCollapsed = await runConduct(ctxA, OPTS(), { runRole: mk(true).runRole, runSessionFn: decomposerFn(1) });
      expect(resCollapsed.state.units[0]!.outcome).toBe("grade-not-independent");

      const ctxB = await makeCtx(tmpdir());
      const resCross = await runConduct(ctxB, OPTS(), { runRole: mk(false).runRole, runSessionFn: decomposerFn(1) });
      expect(resCross.state.units[0]!.outcome).toBe("accepted");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 17: an injected strategy is consulted and flips PASS → revise (observable)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      // A strategy that always revises (never accepts) — a scripted PASS must NOT accept.
      const alwaysRevise: JudgmentStrategy = { decide: () => "revise" };
      let evalCalls = 0;
      const runner = fakeRunner(({ kind, spec }) => {
        if (kind === "contract-generator") {
          fs.writeFileSync(argVal(spec.args, "--out")!, "C");
          return summary({ roleKind: "contract-generator", outPath: argVal(spec.args, "--out") });
        }
        if (kind === "contract-evaluator") return summary({ roleKind: "contract-evaluator", contractAgreed: true });
        if (kind === "generator") return summary({ roleKind: "generator", filesChanged: 1 });
        evalCalls++;
        return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false });
      });
      const res = await runConduct(ctx, OPTS(), {
        runRole: runner.runRole,
        runSessionFn: decomposerFn(1),
        strategy: alwaysRevise,
      });
      // Flipped: a PASS that would accept now revises every round → exhausted, not accepted.
      expect(res.state.units[0]!.outcome).toBe("exhausted");
      expect(evalCalls).toBeGreaterThan(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct core — contract negotiation (generator-driven)", () => {
  it("assertion 3: convergence → contractForced false; assertion 16: distinct proposals, round-2 gen sees round-1 critique, forced persists latest proposal", async () => {
    // Non-convergence case: evaluator never agrees → forced finalization with the latest proposal.
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      // Force a small negotiation round cap via config default (contract.maxNegotiationRounds).
      const rounds = ctx.config.contract.maxNegotiationRounds;
      let genRound = 0;
      const genArgsByRound: string[][] = [];
      const critiquePaths: string[] = [];
      const runner = fakeRunner(({ kind, spec }) => {
        if (kind === "contract-generator") {
          genRound++;
          genArgsByRound.push(spec.args);
          const out = argVal(spec.args, "--out")!;
          fs.writeFileSync(out, `PROPOSAL-ROUND-${genRound}`); // DISTINCT per round
          return summary({ roleKind: "contract-generator", outPath: out });
        }
        if (kind === "contract-evaluator") {
          const critique = argVal(spec.args, "--out")!;
          fs.writeFileSync(critique, "nope");
          critiquePaths.push(critique);
          return summary({ roleKind: "contract-evaluator", contractAgreed: false, outPath: critique });
        }
        if (kind === "generator") return summary({ roleKind: "generator", filesChanged: 1 });
        return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false });
      });
      const res = await runConduct(ctx, OPTS(), { runRole: runner.runRole, runSessionFn: decomposerFn(1) });
      const u = res.state.units[0]!;
      expect(u.contractAgreed).toBe(false);
      expect(u.contractForced).toBe(true);
      // Ran the full round cap of contract-generator drafts.
      expect(genRound).toBe(rounds);
      // Round 2's contract-generator argv carries round 1's critique path (threaded).
      expect(argVals(genArgsByRound[1]!, "--prior-critique")).toContain(critiquePaths[0]);
      // Forced finalization persists the LATEST generated proposal text.
      const finalContract = fs.readFileSync(u.contractPath!, "utf8");
      expect(finalContract).toBe(`PROPOSAL-ROUND-${rounds}`);
      // argv used the correct role kinds.
      expect(genArgsByRound[0]!.slice(0, 4)).toEqual(["role", "run", "--kind", "contract-generator"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 3: convergence path records contractForced false", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runner = fakeRunner(({ kind, spec }) => {
        if (kind === "contract-generator") {
          fs.writeFileSync(argVal(spec.args, "--out")!, "AGREED-PROP");
          return summary({ roleKind: "contract-generator", outPath: argVal(spec.args, "--out") });
        }
        if (kind === "contract-evaluator") return summary({ roleKind: "contract-evaluator", contractAgreed: true });
        if (kind === "generator") return summary({ roleKind: "generator", filesChanged: 1 });
        return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false });
      });
      const res = await runConduct(ctx, OPTS(), { runRole: runner.runRole, runSessionFn: decomposerFn(1) });
      expect(res.state.units[0]!.contractAgreed).toBe(true);
      expect(res.state.units[0]!.contractForced).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct core — run.json fields, holdout wall, git safety, specs, bin seam", () => {
  it("assertion 6: two units with DISTINCT score/cost/branch/worktree recorded; overall status final", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runner = fakeRunner(({ kind, unit, spec }) => {
        if (kind === "contract-generator") {
          fs.writeFileSync(argVal(spec.args, "--out")!, "C");
          return summary({ roleKind: "contract-generator", outPath: argVal(spec.args, "--out"), costUsd: 0.01 });
        }
        if (kind === "contract-evaluator") return summary({ roleKind: "contract-evaluator", contractAgreed: true, costUsd: 0.02 });
        if (kind === "generator") {
          const n = unit === "unit-001" ? "1" : "2";
          return summary({
            roleKind: "generator",
            filesChanged: 1,
            costUsd: unit === "unit-001" ? 0.5 : 0.7,
            unitWorktree: { name: `wt-${n}`, dir: `/tmp/wt-${n}`, branch: `sparra/br-${n}`, created: true },
          });
        }
        return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, weightedTotal: unit === "unit-001" ? 88 : 91, costUsd: 0.1 });
      });
      const res = await runConduct(ctx, OPTS(), { runRole: runner.runRole, runSessionFn: decomposerFn(2) });
      const a = res.state.units.find((u) => u.id === "unit-001")!;
      const b = res.state.units.find((u) => u.id === "unit-002")!;
      expect(a.score).toBe(88);
      expect(b.score).toBe(91);
      expect(a.branch).toBe("sparra/br-1");
      expect(b.branch).toBe("sparra/br-2");
      expect(a.worktree).toBe("wt-1");
      expect(b.worktree).toBe("wt-2");
      // cost = sum of all role costUsd for the unit (distinct between units).
      expect(a.cost).toBeCloseTo(0.01 + 0.02 + 0.5 + 0.1, 6);
      expect(b.cost).toBeCloseTo(0.01 + 0.02 + 0.7 + 0.1, 6);
      const rj = JSON.parse(fs.readFileSync(path.join(res.runDir, "run.json"), "utf8"));
      expect(rj.status).toBe("completed");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 6: GENUINE mid-run observation — while unit-2 is pending, on-disk run.json is parseable, non-final, and carries unit-1's completed terminal fields", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      // Concurrency 1 ⇒ strict ordering: unit-1 fully finishes (all its incremental writes landed)
      // before unit-2's first role runs. At THAT instant we read run.json straight off disk — a real
      // mid-flight snapshot, not the final completed state — and stash it for assertions.
      let midSnapshot: unknown;
      const conductDirOf = (): string => path.join(dir, ".sparra", "conduct");
      const runner = fakeRunner(({ kind, unit, spec }) => {
        if (unit === "unit-002" && midSnapshot === undefined) {
          // Locate the single run dir and read its run.json AS IT STANDS right now (unit-2 pending).
          const runs = fs.readdirSync(conductDirOf());
          const rj = fs.readFileSync(path.join(conductDirOf(), runs[0]!, "run.json"), "utf8");
          midSnapshot = JSON.parse(rj); // throws here if a torn/partial write was ever observed
        }
        if (kind === "contract-generator") {
          fs.writeFileSync(argVal(spec.args, "--out")!, "C");
          return summary({ roleKind: "contract-generator", outPath: argVal(spec.args, "--out"), costUsd: 0.01 });
        }
        if (kind === "contract-evaluator") return summary({ roleKind: "contract-evaluator", contractAgreed: true });
        if (kind === "generator")
          return summary({ roleKind: "generator", filesChanged: 1, unitWorktree: { name: `wt-${unit}`, dir: `/tmp/wt-${unit}`, branch: `sparra/wt-${unit}`, created: true } });
        return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, weightedTotal: 80, costUsd: 0.2 });
      });
      const res = await runConduct(ctx, OPTS({ concurrency: 1 }), { runRole: runner.runRole, runSessionFn: decomposerFn(2) });

      // The mid-run snapshot was actually captured, and it is a valid, NON-FINAL document.
      expect(midSnapshot).toBeDefined();
      const snap = midSnapshot as { status: string; units: Array<Record<string, unknown>> };
      expect(["pending", "running"]).toContain(snap.status); // non-final overall status
      const sa = snap.units.find((u) => u.id === "unit-001")!;
      const sb = snap.units.find((u) => u.id === "unit-002")!;
      // Unit-1 is COMPLETED: its terminal-valued fields (score/branch/worktree/cost) are present.
      expect(sa.score).toBe(80);
      expect(sa.branch).toBe("sparra/wt-unit-001");
      expect(sa.worktree).toBe("wt-unit-001");
      expect(sa.cost as number).toBeGreaterThan(0);
      // Unit-2 is still PENDING: no terminal fields yet.
      expect(sb.outcome).toBe("pending");
      expect(sb.score).toBeUndefined();
      expect(sb.branch).toBeUndefined();

      // After the full run, the overall status is FINAL and both units terminal.
      const finalRj = JSON.parse(fs.readFileSync(path.join(res.runDir, "run.json"), "utf8"));
      expect(finalRj.status).toBe("completed");
      expect(finalRj.units.every((u: { outcome: string }) => u.outcome === "accepted")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 5: holdout PATH only on evaluator specs; content canary never in conductor-visible state", async () => {
    const dir = tmpdir();
    try {
      // Create a holdout file with a canary; conduct must never read it.
      fs.mkdirSync(dir, { recursive: true });
      const canary = "HOLDOUT-CANARY-9f3a1c";
      fs.writeFileSync(path.join(dir, "HOLDOUT.md"), `secret checks: ${canary}`);
      const ctx = await makeCtx(dir);
      const specsByKind: Record<string, RunRoleSpec[]> = {};
      const runner = fakeRunner(({ kind, spec }) => {
        (specsByKind[kind] ??= []).push(spec);
        if (kind === "contract-generator") {
          fs.writeFileSync(argVal(spec.args, "--out")!, "C");
          return summary({ roleKind: "contract-generator", outPath: argVal(spec.args, "--out") });
        }
        if (kind === "contract-evaluator") return summary({ roleKind: "contract-evaluator", contractAgreed: true });
        if (kind === "generator") return summary({ roleKind: "generator", filesChanged: 1 });
        return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false });
      });
      const res = await runConduct(ctx, OPTS(), { runRole: runner.runRole, runSessionFn: decomposerFn(1) });
      const holdoutPath = path.join(dir, "HOLDOUT.md");
      expect(argVals(specsByKind["evaluator"]![0]!.args, "--holdout")).toContain(holdoutPath);
      expect(specsByKind["generator"]![0]!.args).not.toContain("--holdout");
      expect(specsByKind["contract-generator"]![0]!.args).not.toContain("--holdout");
      expect(specsByKind["contract-evaluator"]![0]!.args).not.toContain("--holdout");
      // The holdout CONTENT canary never appears in run.json / conductor-visible state.
      const rjText = fs.readFileSync(path.join(res.runDir, "run.json"), "utf8");
      expect(rjText).not.toContain(canary);
      expect(JSON.stringify(res.state)).not.toContain(canary);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 7/8: distinct stable --unit-worktree per unit; evaluator targets the unit worktree; config identity + budget/max-turns on argv; concurrency honored; invoking git state unchanged", async () => {
    const dir = tmpdir();
    try {
      // A real git repo as the checkout; fakes never touch it, so HEAD/status stay put.
      const git = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      git(["init", "-q"]);
      git(["config", "user.email", "t@t"]);
      git(["config", "user.name", "t"]);
      fs.writeFileSync(path.join(dir, "f.txt"), "hi");
      git(["add", "."]);
      git(["commit", "-q", "-m", "init"]);
      const head0 = git(["rev-parse", "HEAD"]).stdout.trim();
      const status0 = git(["status", "--porcelain"]).stdout;

      const ctx = await makeCtx(dir);
      const genWorktreeNames: Record<string, string[]> = {};
      const evalWorkspaces: string[] = [];
      const evalRounds: Record<string, number> = {};
      let peakSeen = 0;
      let live = 0;
      // The fake generator ACTS like the real one: it derives its unitWorktree metadata (name +
      // sparra/<name> branch + name-derived dir) from the --unit-worktree name the conductor assigned,
      // and returns it in its ParentSummary — so run.json's branch/worktree are provenance from the
      // role result, never hardcoded. It never touches the invoking git checkout (its "worktree" is
      // notional), so HEAD/status must stay put.
      const runner = fakeRunner(async ({ kind, unit, spec }) => {
        live++;
        peakSeen = Math.max(peakSeen, live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        if (kind === "contract-generator") {
          fs.writeFileSync(argVal(spec.args, "--out")!, "C");
          return summary({ roleKind: "contract-generator", outPath: argVal(spec.args, "--out") });
        }
        if (kind === "contract-evaluator") return summary({ roleKind: "contract-evaluator", contractAgreed: true });
        if (kind === "generator") {
          const name = argVal(spec.args, "--unit-worktree")!;
          (genWorktreeNames[unit!] ??= []).push(name);
          return summary({
            roleKind: "generator",
            filesChanged: 1,
            unitWorktree: { name, dir: `/notional/${name}`, branch: `sparra/${name}`, created: true },
          });
        }
        evalWorkspaces.push(argVal(spec.args, "--workspace")!);
        // unit-001 FAILs its first round (→ a second generator round on the SAME worktree), then PASSes.
        evalRounds[unit!] = (evalRounds[unit!] ?? 0) + 1;
        if (unit === "unit-001" && evalRounds[unit!] === 1) {
          return summary({ roleKind: "evaluator", verdict: "fail", blocking: ["fix it"], sameModelGrade: false });
        }
        return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, weightedTotal: 90 });
      });
      const res = await runConduct(ctx, OPTS({ concurrency: 2 }), {
        runRole: runner.runRole,
        runSessionFn: decomposerFn(2),
      });

      // Distinct worktree name per unit, STABLE across the same unit's rounds.
      const w1 = genWorktreeNames["unit-001"]![0]!;
      const w2 = genWorktreeNames["unit-002"]![0]!;
      expect(w1).not.toBe(w2);
      expect(genWorktreeNames["unit-001"]!.length).toBeGreaterThan(1); // unit-001 ran ≥2 generator rounds
      expect(genWorktreeNames["unit-001"]!.every((n) => n === w1)).toBe(true); // same name every round
      // Evaluator workspaces reference the unit worktree dirs (name-derived judge surface).
      expect(evalWorkspaces.some((w) => w.includes(w1))).toBe(true);
      expect(evalWorkspaces.some((w) => w.includes(w2))).toBe(true);
      // Config identity: generator carries configured --backend/--model.
      const genSpec = runner.specs.find((s) => kindOf(s.args) === "generator")!;
      expect(argVal(genSpec.args, "--backend")).toBe(ctx.config.roles.generator.backend ?? "claude");
      expect(argVal(genSpec.args, "--model")).toBe(ctx.config.roles.generator.model);
      // Concurrency honored (default 2 units at once, capped at unit count).
      expect(peakSeen).toBeGreaterThan(1);
      expect(res.state.units).toHaveLength(2);

      // NON-VACUOUS: both units accepted, and the accepted units' branch+worktree provenance from the
      // generator's returned metadata is carried in BOTH the in-memory report AND the on-disk run.json.
      const rj = JSON.parse(fs.readFileSync(path.join(res.runDir, "run.json"), "utf8"));
      for (const uid of ["unit-001", "unit-002"] as const) {
        const name = genWorktreeNames[uid]![0]!;
        const reportEntry = res.state.units.find((u) => u.id === uid)!;
        const diskEntry = rj.units.find((u: { id: string }) => u.id === uid);
        expect(reportEntry.outcome).toBe("accepted");
        expect(reportEntry.worktree).toBe(name);
        expect(reportEntry.branch).toBe(`sparra/${name}`);
        expect(diskEntry.outcome).toBe("accepted");
        expect(diskEntry.worktree).toBe(name);
        expect(diskEntry.branch).toBe(`sparra/${name}`);
      }

      // Invoking checkout untouched: no commit landed on the branch, and no TRACKED file changed
      // (the only new path is the gitignore-able .sparra/conduct run dir — an untracked artifact).
      expect(git(["rev-parse", "HEAD"]).stdout.trim()).toBe(head0);
      const trackedChanges = (l: string) => l && !l.includes(".sparra");
      expect(git(["status", "--porcelain"]).stdout.split("\n").filter(trackedChanges).join("\n")).toBe(
        status0.split("\n").filter(trackedChanges).join("\n"),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 8: --budget/--max-turns propagate onto EVERY role-run argv (contract-generator, contract-evaluator, generator, evaluator)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runner = fakeRunner(({ kind, spec }) => {
        if (kind === "contract-generator") {
          fs.writeFileSync(argVal(spec.args, "--out")!, "C");
          return summary({ roleKind: "contract-generator", outPath: argVal(spec.args, "--out") });
        }
        if (kind === "contract-evaluator") return summary({ roleKind: "contract-evaluator", contractAgreed: true });
        if (kind === "generator") return summary({ roleKind: "generator", filesChanged: 1 });
        return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false });
      });
      await runConduct(ctx, OPTS({ budget: 3, maxTurns: 12 }), { runRole: runner.runRole, runSessionFn: decomposerFn(1) });
      // ALL four spawned role kinds must carry --budget/--max-turns.
      for (const kind of ["contract-generator", "contract-evaluator", "generator", "evaluator"] as const) {
        const spec = runner.specs.find((s) => kindOf(s.args) === kind)!;
        expect(spec, `no ${kind} spec captured`).toBeTruthy();
        expect(argVal(spec.args, "--budget"), `${kind} --budget`).toBe("3");
        expect(argVal(spec.args, "--max-turns"), `${kind} --max-turns`).toBe("12");
      }
      // Evaluator carries the generator identity as the cross-model baseline.
      const ev = runner.specs.find((s) => kindOf(s.args) === "evaluator")!;
      expect(argVal(ev.args, "--baseline-model")).toBe(ctx.config.roles.generator.model);
      // The runner rejects any non-`evaluator` role-run without a brief ("provide a brief" exit 1),
      // so every other spawned kind MUST carry --brief on its argv (live-fire regression: the
      // contract-evaluator spec omitted it and the first real conduct run crashed both units).
      for (const kind of ["contract-generator", "contract-evaluator", "generator"] as const) {
        const spec = runner.specs.find((s) => kindOf(s.args) === kind)!;
        expect(argVal(spec.args, "--brief"), `${kind} --brief`).toBeTruthy();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 9: spawned bin defaults to repo bin/sparra.mjs and honors SPARRA_BIN", async () => {
    const prev = process.env.SPARRA_BIN;
    try {
      delete process.env.SPARRA_BIN;
      expect(resolveSparraBin().replace(/\\/g, "/")).toMatch(/\/bin\/sparra\.mjs$/);
      process.env.SPARRA_BIN = "/custom/sparra";
      expect(resolveSparraBin()).toBe("/custom/sparra");
    } finally {
      if (prev === undefined) delete process.env.SPARRA_BIN;
      else process.env.SPARRA_BIN = prev;
    }
  });
});

// ─────────────────────────────── U2: conductor brain + decision engine ───────────────────────────

function fakeBrain(
  judgeFn: (r: DecisionRequest) => BrainDecision | undefined,
  driveFn?: (c: DriveContext) => BrainDecision | undefined,
): { brain: Brain; judgeCalls: DecisionRequest[]; driveCalls: DriveContext[] } {
  const judgeCalls: DecisionRequest[] = [];
  const driveCalls: DriveContext[] = [];
  return {
    judgeCalls,
    driveCalls,
    brain: {
      async judge(r) {
        judgeCalls.push(r);
        return judgeFn(r);
      },
      async drive(c) {
        driveCalls.push(c);
        return driveFn ? driveFn(c) : undefined;
      },
    },
  };
}

/** A RunResult carrying `text` as its resultText (for the brain-session fake). */
function sess(text: string, sessionId = "brain-s"): RunResult {
  return {
    ok: true,
    subtype: "success",
    resultText: text,
    sessionId,
    costUsd: 0,
    tokens: 1,
    numTurns: 1,
    hitMaxTurns: false,
    hitBudget: false,
    errors: [],
    tracePath: "",
  };
}

/** Contract phase: generator drafts, evaluator AGREES (round 1). Returns undefined for other kinds. */
function contractAgree(kind: string, spec: RunRoleSpec): ParentSummary | undefined {
  if (kind === "contract-generator") {
    fs.writeFileSync(argVal(spec.args, "--out")!, "C");
    return summary({ roleKind: "contract-generator", outPath: argVal(spec.args, "--out") });
  }
  if (kind === "contract-evaluator") return summary({ roleKind: "contract-evaluator", contractAgreed: true });
  return undefined;
}

/** A hybrid fake runner: agreed contract, then per-round generator/evaluator behaviors. */
function hybridRunner(
  evalFn: (unit: string, round: number) => ParentSummary,
  genFn?: (unit: string, round: number) => ParentSummary,
): FakeRunner {
  const evalRounds: Record<string, number> = {};
  const genRounds: Record<string, number> = {};
  return fakeRunner(({ kind, unit, spec }) => {
    const c = contractAgree(kind, spec);
    if (c) return c;
    if (kind === "generator") {
      const gr = (genRounds[unit!] = (genRounds[unit!] ?? 0) + 1);
      return genFn ? genFn(unit!, gr) : summary({ roleKind: "generator", filesChanged: 1 });
    }
    const er = (evalRounds[unit!] = (evalRounds[unit!] ?? 0) + 1);
    return evalFn(unit!, er);
  });
}

const AUTO = (o: Partial<ConductOptions> = {}): ConductOptions =>
  OPTS({ brain: "hybrid", surface: "auto", timeoutSec: 1800, ...o });

describe("conduct brain — hybrid consults the brain at ALL five judgment points (assertion 1)", () => {
  it("point 1 — contract non-convergence: brain consulted with kind, answer applied (abandon)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      // contract-evaluator NEVER agrees → contract non-convergence judgment point.
      const runner = fakeRunner(({ kind, spec }) => {
        if (kind === "contract-generator") {
          fs.writeFileSync(argVal(spec.args, "--out")!, "C");
          return summary({ roleKind: "contract-generator", outPath: argVal(spec.args, "--out") });
        }
        if (kind === "contract-evaluator") {
          fs.writeFileSync(argVal(spec.args, "--out")!, "no");
          return summary({ roleKind: "contract-evaluator", contractAgreed: false, outPath: argVal(spec.args, "--out") });
        }
        if (kind === "generator") return summary({ roleKind: "generator", filesChanged: 1 });
        return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false });
      });
      const fb = fakeBrain(() => ({ answer: "abandon", rationale: "ill-posed" }));
      const res = await runConduct(ctx, AUTO(), {
        runRole: runner.runRole,
        runSessionFn: decomposerFn(1),
        brain: fb.brain,
      });
      expect(fb.judgeCalls.map((c) => c.kind)).toContain("contract-nonconvergence");
      expect(res.state.units[0]!.outcome).toBe("abandoned"); // brain's answer changed the run path
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("point 2 — unit exhausted: brain consulted; abandon differs from deterministic pivot→exhausted (assertion 2)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      ctx.config.build.maxRoundsPerItem = 2;
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "fail", blocking: ["nope"], sameModelGrade: false }));
      const fb = fakeBrain(() => ({ answer: "abandon" }));
      const res = await runConduct(ctx, AUTO(), { runRole: runner.runRole, runSessionFn: decomposerFn(1), brain: fb.brain });
      expect(fb.judgeCalls.map((c) => c.kind)).toContain("unit-exhausted");
      expect(res.state.units[0]!.outcome).toBe("abandoned");

      // Contrast: deterministic (no brain) exhausts, not abandons.
      const ctx2 = await makeCtx(tmpdir());
      ctx2.config.build.maxRoundsPerItem = 2;
      const runner2 = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "fail", blocking: ["nope"], sameModelGrade: false }));
      const res2 = await runConduct(ctx2, AUTO(), { runRole: runner2.runRole, runSessionFn: decomposerFn(1), brain: null });
      expect(res2.state.units[0]!.outcome).toBe("exhausted");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("point 3 — gate collapse: brain consulted; accept-anyway differs from deterministic abandon", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: true }));
      const fb = fakeBrain(() => ({ answer: "accept-anyway" }));
      const res = await runConduct(ctx, AUTO(), { runRole: runner.runRole, runSessionFn: decomposerFn(1), brain: fb.brain });
      expect(fb.judgeCalls.map((c) => c.kind)).toContain("gate-collapse");
      expect(res.state.units[0]!.outcome).toBe("accepted");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("point 4 — budget/limit recovery ambiguity: brain consulted with kind recovery, answer applied", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      // Generator hits a provider limit with NO fallback configured → ambiguous recovery.
      const runner = hybridRunner(
        () => summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false }),
        () => summary({ roleKind: "generator", limitHit: { kind: "usage", raw: "limited" } as never }),
      );
      const fb = fakeBrain(() => ({ answer: "abandon" }));
      const res = await runConduct(ctx, AUTO(), { runRole: runner.runRole, runSessionFn: decomposerFn(1), brain: fb.brain });
      expect(fb.judgeCalls.map((c) => c.kind)).toContain("recovery");
      expect(res.state.units[0]!.outcome).toBe("abandoned");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("point 5 — borderline accept: brain consulted; abandon differs from deterministic accept", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir); // passThreshold default 75
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, weightedTotal: 77, passThreshold: 75 }));
      const fb = fakeBrain(() => ({ answer: "abandon" }));
      const res = await runConduct(ctx, AUTO(), { runRole: runner.runRole, runSessionFn: decomposerFn(1), brain: fb.brain });
      expect(fb.judgeCalls.map((c) => c.kind)).toContain("borderline-accept");
      expect(res.state.units[0]!.outcome).toBe("abandoned");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("negative — a clean, non-borderline PASS never consults the brain", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, weightedTotal: 95, passThreshold: 75 }));
      const fb = fakeBrain(() => ({ answer: "abandon" }));
      const res = await runConduct(ctx, AUTO(), { runRole: runner.runRole, runSessionFn: decomposerFn(1), brain: fb.brain });
      expect(fb.judgeCalls).toHaveLength(0);
      expect(res.state.units[0]!.outcome).toBe("accepted");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct brain — llm mode drives turn-by-turn, bounded (assertion 3)", () => {
  it("scripted [run, revise(F), accept] → 2 gen + 2 eval, F in the revise generator spec, accepted", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const genBriefTexts: string[] = [];
      const runner = fakeRunner(({ kind, spec }) => {
        const c = contractAgree(kind, spec);
        if (c) return c;
        if (kind === "generator") {
          const bt = argVal(spec.args, "--brief-text");
          if (bt) genBriefTexts.push(bt);
          return summary({ roleKind: "generator", filesChanged: 1 });
        }
        return summary({ roleKind: "evaluator", verdict: "fail", sameModelGrade: false });
      });
      const script: BrainDecision[] = [{ answer: "run" }, { answer: "revise", feedback: "FEED-LLM-42" }, { answer: "accept" }];
      let i = 0;
      const fb = fakeBrain(
        () => ({ answer: "abandon" }),
        () => script[i++] ?? { answer: "accept" },
      );
      const res = await runConduct(ctx, OPTS({ brain: "llm", surface: "auto" }), {
        runRole: runner.runRole,
        runSessionFn: decomposerFn(1),
        brain: fb.brain,
      });
      const genCount = runner.specs.filter((s) => kindOf(s.args) === "generator").length;
      const evalCount = runner.specs.filter((s) => kindOf(s.args) === "evaluator").length;
      expect(genCount).toBe(2);
      expect(evalCount).toBe(2);
      expect(genBriefTexts.some((t) => t.includes("FEED-LLM-42"))).toBe(true);
      expect(res.state.units[0]!.outcome).toBe("accepted");
      expect(fb.driveCalls).toHaveLength(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scripted abandon ends the unit non-accepted (contrasting terminal)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "fail", sameModelGrade: false }));
      const fb = fakeBrain(() => ({ answer: "x" }), () => ({ answer: "abandon" }));
      const res = await runConduct(ctx, OPTS({ brain: "llm", surface: "auto" }), { runRole: runner.runRole, runSessionFn: decomposerFn(1), brain: fb.brain });
      expect(res.state.units[0]!.outcome).toBe("abandoned");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("TERMINATION — an endlessly-driving brain stops at the round budget; zero calls after exhaustion", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      ctx.config.build.maxRoundsPerItem = 3;
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "fail", sameModelGrade: false }));
      const fb = fakeBrain(() => ({ answer: "x" }), () => ({ answer: "run" })); // never terminates itself
      const res = await runConduct(ctx, OPTS({ brain: "llm", surface: "auto" }), { runRole: runner.runRole, runSessionFn: decomposerFn(1), brain: fb.brain });
      expect(res.state.units[0]!.outcome).toBe("exhausted"); // terminal persisted despite endless brain
      // Exactly maxRounds drive turns + maxRounds gen + maxRounds eval — no calls past exhaustion.
      expect(fb.driveCalls).toHaveLength(3);
      expect(runner.specs.filter((s) => kindOf(s.args) === "generator")).toHaveLength(3);
      expect(runner.specs.filter((s) => kindOf(s.args) === "evaluator")).toHaveLength(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct brain — strict JSON + reask + fallback (assertion 4)", () => {
  const req = (): DecisionRequest => buildDecisionRequest({ seq: 1, unit: "unit-001", kind: "unit-exhausted", nowMs: 0, timeoutSec: 1800 });
  function brainOver(texts: string[]): { brain: Brain; calls: number } {
    let calls = 0;
    const brain = makeBrain({
      runSessionFn: async () => sess(texts[Math.min(calls++, texts.length - 1)]!),
      role: { model: "sonnet" },
      systemPrompt: "sys",
      cwd: "/tmp",
      traceDir: "/tmp",
      jsonReask: true,
    });
    return { brain, get calls() { return calls; } };
  }

  it("malformed → exactly one reask (same session) → reask valid → answer applied", async () => {
    const b = brainOver(["not json at all", '```json\n{"answer":"pivot"}\n```']);
    const d = await b.brain.judge(req());
    expect(d?.answer).toBe("pivot");
    expect(b.calls).toBe(2); // one ask + one reask
  });

  it("malformed → reask also malformed → brain returns undefined (→ deterministic fallback upstream)", async () => {
    const b = brainOver(["nope", "still nope"]);
    const d = await b.brain.judge(req());
    expect(d).toBeUndefined();
    expect(b.calls).toBe(2);
  });

  it("run-level: brain invalid-after-reask records source 'brain-fallback' on the decision", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: true })); // gate collapse
      const res = await runConduct(ctx, AUTO(), {
        runRole: runner.runRole,
        runSessionFn: decomposerFn(1),
        brainSessionFn: async () => sess("never valid json"),
      });
      const decisions = res.state.units[0]!.decisions ?? [];
      const gate = decisions.find((d) => d.kind === "gate-collapse");
      expect(gate?.source).toBe("brain-fallback");
      // deterministic default for gate-collapse is "abandon" → grade-not-independent outcome.
      expect(res.state.units[0]!.outcome).toBe("grade-not-independent");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct decision engine — park / timeout / auto / tty (assertions 5–8)", () => {
  function findRunDir(dir: string): string {
    const base = path.join(dir, ".sparra", "conduct");
    return path.join(base, fs.readdirSync(base)[0]!);
  }

  it("assertion 5: park → file answer wins over the default, recorded with source 'file' and note", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      ctx.config.build.maxRoundsPerItem = 2;
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "fail", blocking: ["x"], sameModelGrade: false }));
      // The file answer appears when the poller first looks (written by the fake sleep).
      let wrote = false;
      const sleep = async () => {
        if (!wrote) {
          const rd = findRunDir(dir);
          fs.mkdirSync(path.join(rd, "decisions"), { recursive: true });
          fs.writeFileSync(path.join(rd, "decisions", "1.decision.json"), JSON.stringify({ answer: "abandon", note: "human says stop" }));
          wrote = true;
        }
      };
      const requests: string[] = [];
      const res = await runConduct(ctx, OPTS({ brain: "hybrid", surface: "park", timeoutSec: 1800 }), {
        runRole: runner.runRole,
        runSessionFn: decomposerFn(1),
        brain: null,
        now: () => 0,
        sleep,
        pollMs: 0,
        onDecisionRequest: (p) => requests.push(p),
      });
      expect(requests.some((p) => p.endsWith("1.request.json"))).toBe(true);
      const rd = findRunDir(dir);
      const reqDoc = JSON.parse(fs.readFileSync(path.join(rd, "decisions", "1.request.json"), "utf8"));
      for (const f of ["id", "unit", "kind", "question", "options", "default", "expiresAt"]) expect(reqDoc).toHaveProperty(f);
      const d = (res.state.units[0]!.decisions ?? []).find((x) => x.kind === "unit-exhausted")!;
      expect(d.chosen).toBe("abandon"); // not the default "pivot"
      expect(d.source).toBe("file");
      expect(d.note).toBe("human says stop");
      expect(res.state.units[0]!.outcome).toBe("abandoned");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 6: park-timeout with no file → brain decides (source 'brain', via 'timeout'); brain unavailable → 'auto-deterministic'", async () => {
    // Brain present:
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      ctx.config.build.maxRoundsPerItem = 2;
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "fail", sameModelGrade: false }));
      let clock = 0;
      const fb = fakeBrain(() => ({ answer: "abandon", rationale: "r" }));
      const res = await runConduct(ctx, OPTS({ brain: "hybrid", surface: "park-timeout", timeoutSec: 10 }), {
        runRole: runner.runRole,
        runSessionFn: decomposerFn(1),
        brain: fb.brain,
        now: () => clock,
        sleep: async () => { clock += 1_000_000_000; },
        pollMs: 0,
      });
      const d = (res.state.units[0]!.decisions ?? []).find((x) => x.kind === "unit-exhausted")!;
      expect(d.source).toBe("brain");
      expect(d.via).toBe("timeout");
      expect(d.rationale).toBeTruthy();

      // Brain UNAVAILABLE:
      const ctx2 = await makeCtx(tmpdir());
      ctx2.config.build.maxRoundsPerItem = 2;
      const runner2 = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "fail", sameModelGrade: false }));
      let clock2 = 0;
      const res2 = await runConduct(ctx2, OPTS({ brain: "hybrid", surface: "park-timeout", timeoutSec: 10 }), {
        runRole: runner2.runRole,
        runSessionFn: decomposerFn(1),
        brain: null,
        now: () => clock2,
        sleep: async () => { clock2 += 1_000_000_000; },
        pollMs: 0,
      });
      const d2 = (res2.state.units[0]!.decisions ?? []).find((x) => x.kind === "unit-exhausted")!;
      expect(d2.source).toBe("auto-deterministic");
      expect(d2.via).toBe("timeout");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 6 (boundary): park-timeout does NOT resolve before expiresAt and DOES at/after it (kills a reversed >= comparison)", async () => {
    // Drive resolveDecision directly with a step-advanced fake clock. STEP < timeout window, so the
    // poller crosses several SUB-boundary ticks (each must NOT resolve) before the clock reaches
    // expiresAt (which MUST resolve). This pins the production `nowMs() >= expiresAtMs` boundary:
    // reversing it to `<=` makes t=0 satisfy the check, resolving at the first poll (brainCalledAt=0,
    // zero sleeps) — which fails BOTH assertions below.
    const dir = tmpdir();
    try {
      const runDir = path.join(dir, "run");
      const STEP = 3000;
      const req = buildDecisionRequest({ seq: 1, unit: "unit-001", kind: "unit-exhausted", nowMs: 0, timeoutSec: 10 });
      const expiresAtMs = Date.parse(req.expiresAt); // 10_000 ms
      let clock = 0;
      let brainCalledAt = -1;
      let brainCalls = 0;
      let sleepsBeforeResolve = 0;
      let done = false;
      const engine: DecisionEngineDeps = {
        surface: "park-timeout",
        runDir,
        nowMs: () => clock,
        sleep: async () => {
          if (!done) sleepsBeforeResolve++;
          clock += STEP;
        },
        pollMs: 0,
        brainJudge: async () => {
          brainCalls++;
          brainCalledAt = clock;
          return { answer: "abandon", rationale: "r" };
        },
      };
      const res = await resolveDecision(req, engine);
      done = true;

      expect(res.source).toBe("brain");
      expect(res.via).toBe("timeout");
      expect(brainCalls).toBe(1);
      // (1) The brain was consulted ONLY at/after the boundary — never during a sub-boundary tick.
      expect(brainCalledAt).toBeGreaterThanOrEqual(expiresAtMs);
      // (2) It genuinely polled through the sub-boundary ticks first (0 sleeps ⇒ resolved at t=0).
      expect(sleepsBeforeResolve).toBeGreaterThanOrEqual(Math.floor(expiresAtMs / STEP));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 7: TTY answer arriving before the file wins (source 'tty'); single decision record", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      ctx.config.build.maxRoundsPerItem = 2;
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "fail", sameModelGrade: false }));
      const tty = { question: async () => "abandon", cancel: () => {} };
      const res = await runConduct(ctx, OPTS({ brain: "hybrid", surface: "park", timeoutSec: 1800 }), {
        runRole: runner.runRole,
        runSessionFn: decomposerFn(1),
        brain: null,
        now: () => 0,
        sleep: async () => {},
        pollMs: 0,
        tty,
      });
      const decisions = (res.state.units[0]!.decisions ?? []).filter((x) => x.kind === "unit-exhausted");
      expect(decisions).toHaveLength(1); // loser not double-applied
      expect(decisions[0]!.source).toBe("tty");
      expect(res.state.units[0]!.outcome).toBe("abandoned");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 7 (other direction): FILE answer arriving before the TTY wins (source 'file'); TTY loser not applied, single record", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      ctx.config.build.maxRoundsPerItem = 2;
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "fail", sameModelGrade: false }));
      // The FILE answer ('abandon') is present the instant the request is written — before the TTY
      // question (a DIFFERENT valid option, 'pivot') is observed. File is checked first each poll.
      const tty = { question: async () => "pivot", cancel: () => {} };
      const res = await runConduct(ctx, OPTS({ brain: "hybrid", surface: "park", timeoutSec: 1800 }), {
        runRole: runner.runRole,
        runSessionFn: decomposerFn(1),
        brain: null,
        now: () => 0,
        sleep: async () => {},
        pollMs: 0,
        tty,
        onDecisionRequest: (reqPath) => {
          fs.writeFileSync(reqPath.replace(".request.json", ".decision.json"), JSON.stringify({ answer: "abandon" }));
        },
      });
      const decisions = (res.state.units[0]!.decisions ?? []).filter((x) => x.kind === "unit-exhausted");
      expect(decisions).toHaveLength(1); // exactly one recorded winner
      expect(decisions[0]!.source).toBe("file"); // file beat the TTY
      expect(decisions[0]!.chosen).toBe("abandon"); // NOT the TTY's 'pivot'
      expect(res.state.units[0]!.outcome).toBe("abandoned");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 8: --auto never parks — no request files; sources ∈ {brain, brain-fallback, auto-deterministic}, via 'auto'", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      ctx.config.build.maxRoundsPerItem = 2;
      // Two judgment triggers across two units: unit-1 exhausts, unit-2 gate-collapse.
      const runner = fakeRunner(({ kind, unit, spec }) => {
        const c = contractAgree(kind, spec);
        if (c) return c;
        if (kind === "generator") return summary({ roleKind: "generator", filesChanged: 1 });
        if (unit === "unit-001") return summary({ roleKind: "evaluator", verdict: "fail", sameModelGrade: false });
        return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: true });
      });
      let requestFiles = 0;
      const fb = fakeBrain(() => ({ answer: "abandon" }));
      const res = await runConduct(ctx, OPTS({ brain: "hybrid", surface: "auto" }), {
        runRole: runner.runRole,
        runSessionFn: decomposerFn(2),
        brain: fb.brain,
        onDecisionRequest: () => { requestFiles++; },
      });
      expect(requestFiles).toBe(0);
      expect(fs.existsSync(path.join(res.runDir, "decisions"))).toBe(false);
      const all = res.state.units.flatMap((u) => u.decisions ?? []);
      expect(all.length).toBeGreaterThan(0);
      for (const d of all) {
        expect(["brain", "brain-fallback", "auto-deterministic"]).toContain(d.source);
        expect(d.via).toBe("auto");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct brain — escalation on 2nd pivot (assertion 11)", () => {
  it("2nd pivot switches the generator spec to roles.generator.escalation identity", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      ctx.config.pivot.N = 1; // every fail pivots → reach the 2nd pivot fast
      ctx.config.build.maxRoundsPerItem = 4;
      const esc: RoleConfig = { backend: "codex", model: "gpt-5-esc", effort: "high" };
      ctx.config.roles.generator = { ...ctx.config.roles.generator, escalation: esc };
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "fail", blocking: ["x"], sameModelGrade: false }));
      await runConduct(ctx, AUTO(), { runRole: runner.runRole, runSessionFn: decomposerFn(1), brain: null });
      const genSpecs = runner.specs.filter((s) => kindOf(s.args) === "generator");
      // After the 2nd pivot the generator identity switches to the escalation role.
      const escalated = genSpecs.filter((s) => argVal(s.args, "--model") === "gpt-5-esc");
      expect(escalated.length).toBeGreaterThan(0);
      expect(argVal(escalated[0]!.args, "--backend")).toBe("codex");
      // The ORIGINAL brief file is byte-unchanged (escalation path never rewrites history).
      const briefPath = path.join(dir, ".sparra", "conduct");
      const runDir = path.join(briefPath, fs.readdirSync(briefPath)[0]!);
      expect(fs.readFileSync(path.join(runDir, "unit-001", "brief.md"), "utf8").length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct recovery map reaches execution (assertion 12)", () => {
  const genRole: RoleConfig = { backend: "claude", model: "sonnet", fallback: { backend: "codex", model: "gpt-5-fb", effort: "high" } };
  const spec: RunRoleSpec = { args: ["role", "run", "--kind", "generator", "--backend", "claude", "--model", "sonnet", "--budget", "3", "--max-turns", "12", "--json"], cwd: "/w", sparraBin: "b" };

  it("(a) limitHit + non-default fallback → next argv carries the fallback identity BY VALUE; no FAIL feedback", () => {
    const action = classifyRecovery(summary({ limitHit: { kind: "usage", raw: "x" } as never }), { role: genRole, budget: 3, maxTurns: 12 });
    expect(action.kind).toBe("fallback");
    const next = buildRecoverySpec(spec, action);
    expect(argVal(next.args, "--backend")).toBe("codex");
    expect(argVal(next.args, "--model")).toBe("gpt-5-fb");
    expect(argVal(next.args, "--effort")).toBe("high");
    // A limit is never turned into behavioral-FAIL feedback (no blocking string produced here).
    expect(next.args).not.toContain("--brief-text");
  });

  it("(b) hitBudget/hitMaxTurns → resume argv has --resume-session (+ --resume-backend) and STRICTLY-raised caps", () => {
    const action = classifyRecovery(summary({ hitBudget: true, sessionId: "sess-9" }), { role: genRole, budget: 3, maxTurns: 12 });
    expect(action.kind).toBe("resume");
    const next = buildRecoverySpec(spec, action);
    expect(argVal(next.args, "--resume-session")).toBe("sess-9");
    expect(argVal(next.args, "--resume-backend")).toBe("claude");
    expect(Number(argVal(next.args, "--budget"))).toBeGreaterThan(3);
    expect(Number(argVal(next.args, "--max-turns"))).toBeGreaterThan(12);
  });

  it("(c) emptyCompletion + filesChanged>0 → evaluate (no regenerate); spec unchanged", () => {
    const action = classifyRecovery(summary({ emptyCompletion: true, filesChanged: 2 }), { role: genRole });
    expect(action.kind).toBe("evaluate");
    expect(buildRecoverySpec(spec, action)).toBe(spec); // no reshaping → straight to evaluate
  });

  it("hybrid: limitHit + fallback → the NEXT captured generator argv carries the fallback identity", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      ctx.config.roles.generator = { ...ctx.config.roles.generator, fallback: { backend: "codex", model: "gpt-5-fb" } };
      let genCalls = 0;
      const runner = fakeRunner(({ kind, spec: s }) => {
        const c = contractAgree(kind, s);
        if (c) return c;
        if (kind === "generator") {
          genCalls++;
          if (genCalls === 1) return summary({ roleKind: "generator", limitHit: { kind: "usage", raw: "x" } as never });
          return summary({ roleKind: "generator", filesChanged: 1 });
        }
        return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, weightedTotal: 95, passThreshold: 75 });
      });
      await runConduct(ctx, AUTO(), { runRole: runner.runRole, runSessionFn: decomposerFn(1), brain: null });
      const genSpecs = runner.specs.filter((s) => kindOf(s.args) === "generator");
      expect(genSpecs.some((s) => argVal(s.args, "--model") === "gpt-5-fb")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct — roles.conductor config + prompt (assertion 13)", () => {
  it("defaultConfig ships roles.conductor (claude/sonnet/medium) and DEFAULT_PROMPTS has a conductor prompt", async () => {
    const { defaultConfig } = await import("../src/config.ts");
    const { DEFAULT_PROMPTS } = await import("../src/prompts.ts");
    const c = defaultConfig().roles.conductor;
    expect(c.model).toBe("sonnet");
    expect(c.effort).toBe("medium");
    expect((DEFAULT_PROMPTS as Record<string, string>).conductor).toMatch(/CONDUCTOR/);
  });

  it("an overridden conductor model is used for the brain session", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      ctx.config.roles.conductor = { backend: "claude", model: "opus-override", effort: "high" };
      const models: string[] = [];
      const runner = hybridRunner(() => summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: true })); // gate collapse
      await runConduct(ctx, AUTO(), {
        runRole: runner.runRole,
        runSessionFn: decomposerFn(1),
        brainSessionFn: async (pp: RunSessionParams) => {
          models.push(pp.model);
          return sess('```json\n{"answer":"abandon"}\n```');
        },
      });
      expect(models).toContain("opus-override");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
