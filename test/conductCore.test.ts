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
