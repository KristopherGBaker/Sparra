import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadCtxForRole, type Ctx } from "../src/context.ts";
import {
  runConduct,
  resumeConduct,
  type ConductDeps,
  type ConductOptions,
} from "../src/conduct/run.ts";
import { conductRunDir, runStatePath } from "../src/conduct/runState.ts";
import { cmdConductDecide } from "../src/phases/conduct.ts";
import type { ConductRunState, UnitOutcome, UnitStateEntry } from "../src/conduct/types.ts";
import type { DecisionRecord } from "../src/conduct/decision.ts";
import type { EnsureUnitWorktreeResult } from "../src/build/unitWorktree.ts";
import type { ParentSummary, RunRoleSpec } from "../conductors/core/index.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

/**
 * `conduct --resume` + evaluator prior-blocking threading. All offline: fake RoleRunner, temp dirs,
 * injected worktree seam — no live model, no real git, no network.
 */

const noProbe = async (): Promise<void> => {};
function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sparra-resume-"));
}
async function makeCtx(dir: string): Promise<Ctx> {
  return loadCtxForRole(dir, { probeAuto: noProbe });
}
function summary(o: Partial<ParentSummary>): ParentSummary {
  return { roleKind: "generator", backend: "stub", model: "stub-1", ok: true, errors: [], tokens: 0, costUsd: 0, ...o };
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
      return handler({ kind: kindOf(spec.args), unit: spec.env?.SPARRA_CONDUCT_UNIT as string | undefined, spec });
    },
  };
}
function decomposerFn(n: number): (p: RunSessionParams) => Promise<RunResult> {
  return async () => ({
    ok: true,
    subtype: "success",
    resultText: "```json\n" + JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `unit-${String(i + 1).padStart(3, "0")}`, title: `U${i + 1}`, summary: "s", rationale: "r" }))) + "\n```",
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
const OPTS = (o: Partial<ConductOptions> = {}): ConductOptions => ({ prompt: "build a thing", maxUnits: 4, concurrency: 2, dryRun: false, ...o });

/** A worktree seam backed by an in-memory "registry" Set: a name already present is REUSED
 *  (created:false); an absent name is RECREATED (created:true) and added. Records every call. */
function fakeWorktreeSeam(preRegistered: string[] = []): {
  fn: NonNullable<ConductDeps["ensureUnitWorktreeFn"]>;
  calls: Array<{ name: string; created: boolean }>;
  registry: Set<string>;
} {
  const registry = new Set(preRegistered);
  const calls: Array<{ name: string; created: boolean }> = [];
  const fn = (async (_ctx: Ctx, name: string, src: string): Promise<EnsureUnitWorktreeResult> => {
    const created = !registry.has(name);
    if (created) registry.add(name);
    calls.push({ name, created });
    return { dir: `/wt/${name}`, branch: `sparra/${name}`, src, created };
  }) as NonNullable<ConductDeps["ensureUnitWorktreeFn"]>;
  return { fn, calls, registry };
}

interface SeedUnit {
  id: string;
  title?: string;
  outcome: UnitOutcome;
  contract?: string;
  contractAgreed?: boolean;
  contractForced?: boolean;
  verdictPaths?: string[];
  decisions?: DecisionRecord[];
}
/** Write a persisted run dir (run.json + per-unit brief/contract), simulating a crashed run. */
function seedRun(ctx: Ctx, runId: string, opts: { status: ConductRunState["status"]; brain?: "hybrid" | "llm"; units: SeedUnit[] }): { runDir: string } {
  const runDir = conductRunDir(ctx.paths.dir, runId);
  const units: UnitStateEntry[] = opts.units.map((u) => {
    const unitDir = path.join(runDir, u.id);
    fs.mkdirSync(unitDir, { recursive: true });
    const briefPath = path.join(unitDir, "brief.md");
    fs.writeFileSync(briefPath, `# ${u.title ?? u.id}\n\nbrief text for ${u.id}\n`);
    const contractPath = path.join(unitDir, "contract.md");
    if (u.contract !== undefined) fs.writeFileSync(contractPath, u.contract);
    return {
      id: u.id,
      title: u.title ?? u.id,
      outcome: u.outcome,
      briefPath,
      contractPath,
      ...(u.contractAgreed !== undefined ? { contractAgreed: u.contractAgreed } : {}),
      ...(u.contractForced !== undefined ? { contractForced: u.contractForced } : {}),
      ...(u.verdictPaths ? { verdictPaths: u.verdictPaths } : {}),
      ...(u.decisions ? { decisions: u.decisions } : {}),
    };
  });
  const state: ConductRunState = {
    runId,
    prompt: "the original prompt",
    status: opts.status,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    maxUnits: 4,
    concurrency: 2,
    dryRun: false,
    ...(opts.brain ? { brain: opts.brain } : {}),
    units,
  };
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(runStatePath(runDir), JSON.stringify(state, null, 2));
  return { runDir };
}

/** A runner that: agrees any renegotiated contract, generates, and PASSES cross-model (accept). */
function acceptingRunner(): FakeRunner {
  return fakeRunner(({ kind, spec }) => {
    if (kind === "contract-generator") {
      fs.writeFileSync(argVal(spec.args, "--out")!, "RENEGOTIATED");
      return summary({ roleKind: "contract-generator", outPath: argVal(spec.args, "--out") });
    }
    if (kind === "contract-evaluator") return summary({ roleKind: "contract-evaluator", contractAgreed: true });
    if (kind === "generator") return summary({ roleKind: "generator", filesChanged: 1 });
    return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, weightedTotal: 90 });
  });
}
const resumeDeps = (runner: FakeRunner, extra: Partial<ConductDeps> = {}): ConductDeps => ({
  runRole: runner.runRole,
  ensureUnitWorktreeFn: fakeWorktreeSeam().fn,
  // No conductor brain by default → judgment points resolve via the DETERMINISTIC policy, so a resume
  // that surfaces a decision under `auto`/`timeout` never makes a live model call (offline guarantee).
  brain: null,
  ...extra,
});

describe("full-suite test-count floor (assertion 19)", () => {
  it("records a machine-parseable builder-measured pre-change floor for the no-decrease check", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = fs.readFileSync(path.join(here, "suite-count-floor.json"), "utf8");
    const doc = JSON.parse(raw) as { floor?: unknown; measuredWith?: unknown };
    // The recorded floor is a parseable POSITIVE INTEGER the evaluator compares `npm test`'s
    // reported count against (>=, never an exact pin — see verify step 3).
    expect(typeof doc.floor).toBe("number");
    const floor = doc.floor as number;
    expect(Number.isInteger(floor)).toBe(true);
    expect(floor).toBeGreaterThan(0);
    // The artifact names HOW it was measured so the compare is reproducible.
    expect(doc.measuredWith).toBe("npm test");
  });
});

describe("conduct --resume — state matrix + in-place append", () => {
  it("assertion 1/2: skips accepted+dry-run, re-enters pending/running/error, no decomposer, appends to SAME run.json with resumedAt", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runId = "conduct-RESUME1";
      seedRun(ctx, runId, {
        status: "running",
        units: [
          { id: "unit-001", outcome: "accepted" },
          { id: "unit-002", outcome: "dry-run" },
          { id: "unit-003", outcome: "pending", contract: "AGREED", contractAgreed: true },
          { id: "unit-004", outcome: "running", contract: "AGREED", contractAgreed: true },
          { id: "unit-005", outcome: "error", contract: "AGREED", contractAgreed: true },
        ],
      });
      const runner = acceptingRunner();
      let decomposerRan = false;
      const res = await resumeConduct(ctx, runId, { surface: "auto" }, resumeDeps(runner, {
        runSessionFn: async () => { decomposerRan = true; return decomposerFn(1)({} as RunSessionParams); },
      }));

      expect(res.status).toBe("resumed");
      // No decomposer ever runs on resume.
      expect(decomposerRan).toBe(false);
      // Accepted + dry-run units ran ZERO roles; the three re-enterable units each ran roles.
      const ranUnits = new Set(runner.specs.map((s) => s.env?.SPARRA_CONDUCT_UNIT as string));
      expect(ranUnits.has("unit-001")).toBe(false);
      expect(ranUnits.has("unit-002")).toBe(false);
      expect(ranUnits.has("unit-003")).toBe(true);
      expect(ranUnits.has("unit-004")).toBe(true);
      expect(ranUnits.has("unit-005")).toBe(true);

      // SAME run dir + run.json (no second run dir was created under conduct/).
      const conductRoot = path.join(dir, ".sparra", "conduct");
      expect(fs.readdirSync(conductRoot)).toEqual([runId]);
      const rj = JSON.parse(fs.readFileSync(runStatePath(conductRunDir(ctx.paths.dir, runId)), "utf8")) as ConductRunState;
      expect(Array.isArray(rj.resumedAt)).toBe(true);
      expect(rj.resumedAt!.length).toBe(1);
      expect(rj.status).toBe("completed");
      expect(rj.units.find((u) => u.id === "unit-003")!.outcome).toBe("accepted");
      expect(rj.units.find((u) => u.id === "unit-004")!.outcome).toBe("accepted");
      expect(rj.units.find((u) => u.id === "unit-005")!.outcome).toBe("accepted");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 2(d): agreed contract → re-enters at generate (NO contract roles); generator carries --contract <persisted path>", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runId = "conduct-AGREED";
      const { runDir } = seedRun(ctx, runId, {
        status: "running",
        units: [{ id: "unit-001", outcome: "error", contract: "AGREED-CONTRACT", contractAgreed: true }],
      });
      const runner = acceptingRunner();
      await resumeConduct(ctx, runId, { surface: "auto" }, resumeDeps(runner));
      const kinds = runner.specs.map((s) => kindOf(s.args));
      expect(kinds).not.toContain("contract-generator");
      expect(kinds).not.toContain("contract-evaluator");
      const gen = runner.specs.find((s) => kindOf(s.args) === "generator")!;
      expect(argVal(gen.args, "--contract")).toBe(path.join(runDir, "unit-001", "contract.md"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 2(e): missing agreement flag → renegotiates using the persisted brief (contract roles DO run)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runId = "conduct-RENEG";
      const { runDir } = seedRun(ctx, runId, {
        status: "running",
        // Contract file exists but neither contractAgreed nor contractForced recorded → renegotiate.
        units: [{ id: "unit-001", outcome: "error", contract: "STALE-PARTIAL" }],
      });
      const runner = acceptingRunner();
      await resumeConduct(ctx, runId, { surface: "auto" }, resumeDeps(runner));
      const kinds = runner.specs.map((s) => kindOf(s.args));
      expect(kinds).toContain("contract-generator");
      expect(kinds).toContain("contract-evaluator");
      // The renegotiation used the persisted brief.
      const cg = runner.specs.find((s) => kindOf(s.args) === "contract-generator")!;
      expect(argVal(cg.args, "--brief")).toBe(path.join(runDir, "unit-001", "brief.md"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 5: unknown runId → status unknown-run, NO side effects (no run dir created)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runner = acceptingRunner();
      const res = await resumeConduct(ctx, "no-such-run", { surface: "auto" }, resumeDeps(runner));
      expect(res.status).toBe("unknown-run");
      expect(runner.specs).toHaveLength(0);
      expect(fs.existsSync(path.join(dir, ".sparra", "conduct", "no-such-run"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 5 (path-safety): an unsafe runId ('../…') → unknown-run, ZERO side effects (no escape, no write)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      // Plant a sibling run.json OUTSIDE .sparra/conduct that a `../`-escaping runId would resolve to.
      const outside = path.join(dir, ".sparra", "evil");
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, "run.json"), JSON.stringify({ runId: "evil", units: [] }));
      const before = fs.readFileSync(path.join(outside, "run.json"), "utf8");
      const runner = acceptingRunner();
      for (const bad of ["../evil", "..", "a/b", "foo/../bar", "/abs", "-flag"]) {
        const res = await resumeConduct(ctx, bad, { surface: "auto" }, resumeDeps(runner));
        expect(res.status).toBe("unknown-run"); // rejected before any path is trusted
      }
      // No roles ran, and the unrelated run.json was never read-modified or clobbered.
      expect(runner.specs).toHaveLength(0);
      expect(fs.readFileSync(path.join(outside, "run.json"), "utf8")).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 6: terminal all-accepted 'completed' run → no-op (nothing to do, zero role runs, entries unchanged)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runId = "conduct-DONE";
      seedRun(ctx, runId, { status: "completed", units: [
        { id: "unit-001", outcome: "accepted" },
        { id: "unit-002", outcome: "accepted" },
      ] });
      const before = fs.readFileSync(runStatePath(conductRunDir(ctx.paths.dir, runId)), "utf8");
      const runner = acceptingRunner();
      const res = await resumeConduct(ctx, runId, { surface: "auto" }, resumeDeps(runner));
      expect(res.status).toBe("nothing-to-do");
      expect(runner.specs).toHaveLength(0);
      // run.json untouched.
      expect(fs.readFileSync(runStatePath(conductRunDir(ctx.paths.dir, runId)), "utf8")).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 7: decision seq stays MONOTONIC across resume (new decisions exceed the persisted max)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runId = "conduct-SEQ";
      const priorDecision: DecisionRecord = {
        seq: 5, unit: "unit-001", kind: "borderline-accept", question: "q", options: ["a"], default: "a",
        status: "resolved", chosen: "a", requestedAt: "t", resolvedAt: "t",
      };
      seedRun(ctx, runId, { status: "running", units: [
        { id: "unit-001", outcome: "accepted", decisions: [priorDecision] },
        { id: "unit-002", outcome: "error", contract: "AGREED", contractAgreed: true },
      ] });
      // unit-002's grade collapses the cross-model gate (sameModelGrade pass) → a single-round
      // gate-collapse judgment point → judge records a fresh decision (seq continues from the max).
      const runner = fakeRunner(({ kind }) => {
        if (kind === "generator") return summary({ roleKind: "generator", filesChanged: 1 });
        return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: true });
      });
      const res = await resumeConduct(ctx, runId, { surface: "auto" }, resumeDeps(runner, {
        now: () => 0,
        sleep: async () => {},
        pollMs: 0,
      }));
      const rj = res.status === "resumed" ? res.state : undefined;
      expect(rj).toBeDefined();
      const newDecisions = rj!.units.find((u) => u.id === "unit-002")!.decisions ?? [];
      expect(newDecisions.length).toBeGreaterThan(0);
      for (const d of newDecisions) expect(d.seq).toBeGreaterThan(5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe("conduct --resume — worktree reuse vs recreate (assertion 4)", () => {
  it("registered stable worktree is REUSED (no new creation); absent one is RECREATED under the same identity", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runId = "conduct-WT";
      seedRun(ctx, runId, { status: "running", units: [
        { id: "unit-001", outcome: "error", contract: "A", contractAgreed: true },
        { id: "unit-002", outcome: "error", contract: "A", contractAgreed: true },
      ] });
      // unit-001's stable worktree already exists in the registry (reuse); unit-002's is absent (recreate).
      const seam = fakeWorktreeSeam([`${runId}-unit-001`]);
      const runner = acceptingRunner();
      await resumeConduct(ctx, runId, { surface: "auto" }, { runRole: runner.runRole, ensureUnitWorktreeFn: seam.fn });

      const reuse = seam.calls.find((c) => c.name === `${runId}-unit-001`)!;
      const recreate = seam.calls.find((c) => c.name === `${runId}-unit-002`)!;
      expect(reuse.created).toBe(false); // REUSED — registry/fs state, not argv alone
      expect(recreate.created).toBe(true); // RECREATED under the SAME <runId>-<unitId> identity
      // The recreate added exactly one new registry entry (nothing extra created for the reuse).
      expect(seam.registry.has(`${runId}-unit-001`)).toBe(true);
      expect(seam.registry.has(`${runId}-unit-002`)).toBe(true);
      // Generators carry the stable per-unit worktree name.
      const genA = runner.specs.find((s) => kindOf(s.args) === "generator" && (s.env?.SPARRA_CONDUCT_UNIT === "unit-001"))!;
      const genB = runner.specs.find((s) => kindOf(s.args) === "generator" && (s.env?.SPARRA_CONDUCT_UNIT === "unit-002"))!;
      expect(argVal(genA.args, "--unit-worktree")).toBe(`${runId}-unit-001`);
      expect(argVal(genB.args, "--unit-worktree")).toBe(`${runId}-unit-002`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("evaluator prior-blocking threading (assertions 8/9/10)", () => {
  it("assertion 8/9: normal multi-round — round-2 evaluator argv carries --prior-blocking (paths only, in round order); verdictPaths persisted", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      let evalRound = 0;
      const evalSpecs: RunRoleSpec[] = [];
      const runner = fakeRunner(({ kind, spec }) => {
        if (kind === "contract-generator") { fs.writeFileSync(argVal(spec.args, "--out")!, "C"); return summary({ roleKind: "contract-generator", outPath: argVal(spec.args, "--out") }); }
        if (kind === "contract-evaluator") return summary({ roleKind: "contract-evaluator", contractAgreed: true });
        if (kind === "generator") return summary({ roleKind: "generator", filesChanged: 1 });
        evalRound += 1;
        evalSpecs.push(spec);
        const verdictPath = `/verdicts/u1-r${evalRound}.md`;
        // Round 1 FAILs (→ a round 2), round 2 PASSes.
        return evalRound === 1
          ? summary({ roleKind: "evaluator", verdict: "fail", blocking: ["b"], sameModelGrade: false, verdictPath })
          : summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, weightedTotal: 90, verdictPath });
      });
      const res = await runConduct(ctx, OPTS(), { runRole: runner.runRole, runSessionFn: decomposerFn(1) });
      expect(res.state.units[0]!.outcome).toBe("accepted");
      // Round 1 evaluator: NO prior-blocking.
      expect(argVals(evalSpecs[0]!.args, "--prior-blocking")).toHaveLength(0);
      // Round 2 evaluator: EXACTLY the round-1 verdict path, threaded as a path (never contents).
      expect(argVals(evalSpecs[1]!.args, "--prior-blocking")).toEqual(["/verdicts/u1-r1.md"]);
      // Per-round verdictPaths persisted in round order.
      const rj = JSON.parse(fs.readFileSync(runStatePath(res.runDir), "utf8")) as ConductRunState;
      expect(rj.units[0]!.verdictPaths).toEqual(["/verdicts/u1-r1.md", "/verdicts/u1-r2.md"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 10: resumed re-grade threads PERSISTED verdictPaths through the same --prior-blocking mechanism", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runId = "conduct-PB";
      seedRun(ctx, runId, { status: "running", units: [
        { id: "unit-001", outcome: "error", contract: "AGREED", contractAgreed: true, verdictPaths: ["/persisted/u1-r1.md", "/persisted/u1-r2.md"] },
      ] });
      const evalSpecs: RunRoleSpec[] = [];
      const runner = fakeRunner(({ kind, spec }) => {
        if (kind === "generator") return summary({ roleKind: "generator", filesChanged: 1 });
        if (kind === "evaluator") { evalSpecs.push(spec); return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, weightedTotal: 90, verdictPath: "/persisted/u1-r3.md" }); }
        // No contract roles expected (agreed contract).
        return summary({ roleKind: kind as ParentSummary["roleKind"] });
      });
      await resumeConduct(ctx, runId, { surface: "auto" }, resumeDeps(runner));
      // The FIRST re-grade after resume threads BOTH persisted prior-round verdict paths, in order.
      expect(argVals(evalSpecs[0]!.args, "--prior-blocking")).toEqual(["/persisted/u1-r1.md", "/persisted/u1-r2.md"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct --resume — contract re-entry variants (assertions 2d/2e/3)", () => {
  it("assertion 2(d) forced: contractForced (not agreed) + existing contract file → re-enters at generate (NO contract roles); --contract threaded; forced flag preserved", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runId = "conduct-FORCED";
      const { runDir } = seedRun(ctx, runId, {
        status: "running",
        // Contract was FORCED (rounds exhausted) — agreed:false but forced:true, file present.
        units: [{ id: "unit-001", outcome: "error", contract: "FORCED-CONTRACT", contractAgreed: false, contractForced: true }],
      });
      const runner = acceptingRunner();
      const res = await resumeConduct(ctx, runId, { surface: "auto" }, resumeDeps(runner));
      const kinds = runner.specs.map((s) => kindOf(s.args));
      expect(kinds).not.toContain("contract-generator");
      expect(kinds).not.toContain("contract-evaluator");
      const gen = runner.specs.find((s) => kindOf(s.args) === "generator")!;
      expect(argVal(gen.args, "--contract")).toBe(path.join(runDir, "unit-001", "contract.md"));
      const rj = res.status === "resumed" ? res.state : undefined;
      const u = rj!.units.find((x) => x.id === "unit-001")!;
      expect(u.outcome).toBe("accepted");
      expect(u.contractForced).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 2(e) missing FILE: agreement flag set but contract file ABSENT on disk → renegotiates from the persisted brief", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runId = "conduct-NOFILE";
      // contractAgreed recorded, but NO contract file written (u.contract omitted) — the file is gone.
      const { runDir } = seedRun(ctx, runId, {
        status: "running",
        units: [{ id: "unit-001", outcome: "error", contractAgreed: true }],
      });
      expect(fs.existsSync(path.join(runDir, "unit-001", "contract.md"))).toBe(false);
      const runner = acceptingRunner();
      await resumeConduct(ctx, runId, { surface: "auto" }, resumeDeps(runner));
      const kinds = runner.specs.map((s) => kindOf(s.args));
      // Missing file → must renegotiate (both contract roles run) rather than pass a phantom --contract.
      expect(kinds).toContain("contract-generator");
      expect(kinds).toContain("contract-evaluator");
      const cg = runner.specs.find((s) => kindOf(s.args) === "contract-generator")!;
      expect(argVal(cg.args, "--brief")).toBe(path.join(runDir, "unit-001", "brief.md"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertion 3: resume takes a runId (not a prompt) — the persisted prompt is NEVER overwritten by a resume", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runId = "conduct-PROMPT";
      seedRun(ctx, runId, {
        status: "running",
        units: [{ id: "unit-001", outcome: "error", contract: "AGREED", contractAgreed: true }],
      });
      const before = JSON.parse(fs.readFileSync(runStatePath(conductRunDir(ctx.paths.dir, runId)), "utf8")) as ConductRunState;
      expect(before.prompt).toBe("the original prompt");
      const runner = acceptingRunner();
      const res = await resumeConduct(ctx, runId, { surface: "auto" }, resumeDeps(runner));
      const rj = res.status === "resumed" ? res.state : undefined;
      // The persisted prompt is carried through unchanged — resume never re-decomposes or re-prompts.
      expect(rj!.prompt).toBe("the original prompt");
      const after = JSON.parse(fs.readFileSync(runStatePath(conductRunDir(ctx.paths.dir, runId)), "utf8")) as ConductRunState;
      expect(after.prompt).toBe("the original prompt");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct --resume — parked-decision recovery (assertion 13)", () => {
  it("re-surfaces an unresolved persisted parked decision with a seq above the max, answered via the real conduct --decide path", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runId = "conduct-PARK";
      // A borderline-accept decision that was PENDING when the run crashed (persisted, unresolved).
      const parked: DecisionRecord = {
        seq: 3,
        unit: "unit-001",
        kind: "borderline-accept",
        question: "q",
        options: ["accept", "revise", "abandon"],
        default: "accept",
        status: "pending",
        requestedAt: "2026-07-13T00:00:00.000Z",
      };
      seedRun(ctx, runId, {
        status: "running",
        units: [{ id: "unit-001", outcome: "error", contract: "AGREED", contractAgreed: true, decisions: [parked] }],
      });
      const runner = acceptingRunner();
      // The instant the recovery request lands, answer it through the REAL `sparra conduct --decide`
      // CLI path (requestExists + writeDecisionAnswer under the hood) from "another terminal".
      const answeredSeqs: number[] = [];
      const onDecisionRequest = (reqPath: string): void => {
        const m = /(\d+)\.request\.json$/.exec(reqPath);
        if (!m) return;
        const seq = Number(m[1]);
        answeredSeqs.push(seq);
        void cmdConductDecide(ctx, runId, String(seq), "accept");
      };
      const res = await resumeConduct(ctx, runId, { surface: "park" }, resumeDeps(runner, {
        now: () => Date.now(),
        sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 1))),
        pollMs: 1,
        onDecisionRequest,
      }));
      expect(res.status).toBe("resumed");
      const rj = res.status === "resumed" ? res.state : undefined;
      const decisions = rj!.units.find((u) => u.id === "unit-001")!.decisions ?? [];
      // A NEW record with a seq strictly above the persisted max (3), resolved via the FILE channel
      // (i.e. the conduct --decide answer the poller read) — this is what unblocked the resume.
      const recovered = decisions.find((d) => d.seq > 3 && d.kind === "borderline-accept");
      expect(recovered).toBeDefined();
      expect(recovered!.seq).toBeGreaterThan(3);
      expect(recovered!.status).toBe("resolved");
      expect(recovered!.chosen).toBe("accept");
      expect(recovered!.source).toBe("file");
      // The recovery request was surfaced under the new seq (answerable by conduct --decide).
      expect(answeredSeqs).toContain(recovered!.seq);
      // The stale pending record is retired in place — no interrupted decision lingers pending.
      const stale = decisions.find((d) => d.seq === 3)!;
      expect(stale.status).toBe("resolved");
      expect(stale.note).toContain("recovered on resume");
      // The whole unit re-entered and accepted after the parked decision was cleared.
      expect(rj!.units.find((u) => u.id === "unit-001")!.outcome).toBe("accepted");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("recovered ABANDON STOPS the unit: it is marked abandoned and NOT re-run to acceptance", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runId = "conduct-PARK-ABANDON";
      // gate-collapse parks; its deterministic default under --auto is `abandon`.
      const parked: DecisionRecord = {
        seq: 4, unit: "unit-001", kind: "gate-collapse", question: "q",
        options: ["abandon", "accept-anyway", "retry"], default: "abandon",
        status: "pending", requestedAt: "2026-07-13T00:00:00.000Z",
      };
      seedRun(ctx, runId, { status: "running", units: [
        { id: "unit-001", outcome: "error", contract: "AGREED", contractAgreed: true, decisions: [parked] },
        { id: "unit-002", outcome: "error", contract: "AGREED", contractAgreed: true },
      ] });
      // acceptingRunner would drive ANY re-run unit to `accepted` — proving the abandon actually
      // stops unit-001 (not resolved-then-ignored) while the untouched unit-002 still accepts.
      const runner = acceptingRunner();
      const res = await resumeConduct(ctx, runId, { surface: "auto" }, resumeDeps(runner, {
        now: () => 0, sleep: async () => {}, pollMs: 0,
      }));
      const rj = res.status === "resumed" ? res.state : undefined;
      const u1 = rj!.units.find((u) => u.id === "unit-001")!;
      expect(u1.outcome).toBe("abandoned"); // recovered abandon APPLIED to control flow
      // No role ran for unit-001 (it never re-entered generation).
      expect(runner.specs.some((s) => s.env?.SPARRA_CONDUCT_UNIT === "unit-001")).toBe(false);
      // The unrelated unit-002 still re-entered and accepted.
      expect(rj!.units.find((u) => u.id === "unit-002")!.outcome).toBe("accepted");
      expect(runner.specs.some((s) => s.env?.SPARRA_CONDUCT_UNIT === "unit-002")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovered ACCEPT-ANYWAY finalizes the unit as accepted WITHOUT re-running generation", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runId = "conduct-PARK-ACCEPT";
      const parked: DecisionRecord = {
        seq: 2, unit: "unit-001", kind: "gate-collapse", question: "q",
        options: ["abandon", "accept-anyway", "retry"], default: "abandon",
        status: "pending", requestedAt: "2026-07-13T00:00:00.000Z",
      };
      seedRun(ctx, runId, { status: "running", units: [
        { id: "unit-001", outcome: "error", contract: "AGREED", contractAgreed: true, decisions: [parked] },
      ] });
      const runner = acceptingRunner();
      // Answer the recovery request `accept-anyway` through the real conduct --decide path.
      const onDecisionRequest = (reqPath: string): void => {
        const m = /(\d+)\.request\.json$/.exec(reqPath);
        if (m) void cmdConductDecide(ctx, runId, m[1]!, "accept-anyway");
      };
      const res = await resumeConduct(ctx, runId, { surface: "park" }, resumeDeps(runner, {
        now: () => Date.now(),
        sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 1))),
        pollMs: 1,
        onDecisionRequest,
      }));
      const rj = res.status === "resumed" ? res.state : undefined;
      const u1 = rj!.units.find((u) => u.id === "unit-001")!;
      expect(u1.outcome).toBe("accepted"); // recovered accept-anyway finalized the unit
      // Accepted WITHOUT re-running generation (no generator/evaluator role for the unit).
      expect(runner.specs.some((s) => s.env?.SPARRA_CONDUCT_UNIT === "unit-001")).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("under --auto, a persisted parked decision recovers deterministically (no waiting) with a seq above the max", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const runId = "conduct-PARK-AUTO";
      const parked: DecisionRecord = {
        seq: 7,
        unit: "unit-001",
        kind: "gate-collapse",
        question: "q",
        options: ["abandon", "accept-anyway", "retry"],
        default: "abandon",
        status: "pending",
        requestedAt: "2026-07-13T00:00:00.000Z",
      };
      seedRun(ctx, runId, {
        status: "running",
        units: [{ id: "unit-001", outcome: "error", contract: "AGREED", contractAgreed: true, decisions: [parked] }],
      });
      const runner = acceptingRunner();
      let requestsWritten = 0;
      const res = await resumeConduct(ctx, runId, { surface: "auto" }, resumeDeps(runner, {
        brain: null, // no conductor brain → deterministic policy (zero live model calls)
        now: () => 0,
        sleep: async () => {},
        pollMs: 0,
        onDecisionRequest: () => { requestsWritten += 1; },
      }));
      const rj = res.status === "resumed" ? res.state : undefined;
      const decisions = rj!.units.find((u) => u.id === "unit-001")!.decisions ?? [];
      const recovered = decisions.find((d) => d.seq > 7 && d.kind === "gate-collapse")!;
      expect(recovered).toBeDefined();
      expect(recovered.status).toBe("resolved");
      // --auto never parks (never writes a request file) — the deterministic default resolves it.
      expect(requestsWritten).toBe(0);
      expect(recovered.source).toBe("auto-deterministic");
      expect(recovered.chosen).toBe("abandon");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct --resume — landing composition (assertions 11/12)", () => {
  it("assertion 11: --commit on resume commits a newly-accepted unit (committedSha) WITHOUT merging", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      ctx.config.git.agentCommits = "template"; // deterministic single commit — no committer session
      const runId = "conduct-COMMIT";
      seedRun(ctx, runId, { status: "running", units: [
        { id: "unit-001", outcome: "error", contract: "AGREED", contractAgreed: true },
      ] });
      // Generator returns a unit worktree so the accepted unit has committable WIP; evaluator PASSes.
      const runner = fakeRunner(({ kind }) => {
        if (kind === "generator") return summary({ roleKind: "generator", filesChanged: 1, unitWorktree: { name: `${runId}-unit-001`, dir: `/wt/${runId}-unit-001`, branch: `sparra/${runId}-unit-001`, created: false } });
        return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, weightedTotal: 90 });
      });
      // Commit git seam: report a changed file + a deterministic 40-hex SHA; never merge.
      const commitGit = {
        changedFiles: () => [`/wt/${runId}-unit-001/f.txt`],
        workingDiff: () => "f.txt | 1 +",
        commitPaths: () => ({ ok: true, out: "" }),
        revParse: () => "a".repeat(40),
      } as unknown as ConductDeps["commitGit"];
      const res = await resumeConduct(ctx, runId, { surface: "auto", commit: true }, resumeDeps(runner, { commitGit }));
      expect(res.status).toBe("resumed");
      const rj = res.status === "resumed" ? res.state : undefined;
      const u = rj!.units.find((x) => x.id === "unit-001")!;
      expect(u.outcome).toBe("accepted");
      expect(u.committedSha).toBe("a".repeat(40));
      expect(u.mergedInto).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
