import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadCtxForRole, type Ctx } from "../src/context.ts";
import { runConduct, resumeConduct, type ConductDeps, type ConductOptions } from "../src/conduct/run.ts";
import { conductRunDir, runStatePath } from "../src/conduct/runState.ts";
import type { ConductRunState, UnitOutcome, UnitStateEntry } from "../src/conduct/types.ts";
import type { ParentSummary, RunRoleSpec } from "../conductors/core/index.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";
import type { EnsureUnitWorktreeResult } from "../src/build/unitWorktree.ts";

/**
 * `runConduct`/`resumeConduct` — `git.pullBeforeWork` (opt-in ff-only upstream sync, injected via
 * `ConductDeps.pullUpstream`). Mirrors the `test/conductHooks.test.ts` / `test/conductResume.test.ts`
 * fixture patterns. All offline: fake `RoleRunner` + decomposer, no real git, no network.
 */

const noProbe = async (): Promise<void> => {};
function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sparra-conduct-pull-"));
}
async function makeCtx(dir: string): Promise<Ctx> {
  return loadCtxForRole(dir, { probeAuto: noProbe });
}

function summary(overrides: Partial<ParentSummary>): ParentSummary {
  return { roleKind: "generator", backend: "stub", model: "stub-1", ok: true, errors: [], tokens: 0, costUsd: 0, ...overrides };
}

function decomposerFn(n: number): (p: RunSessionParams) => Promise<RunResult> {
  return async () => {
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

interface FakeRunner {
  runRole: (spec: RunRoleSpec) => Promise<ParentSummary>;
  calls: RunRoleSpec[];
}
function fakeRunner(handler: (c: { kind: string; unit?: string; spec: RunRoleSpec }) => ParentSummary): FakeRunner {
  const calls: RunRoleSpec[] = [];
  return {
    calls,
    runRole: async (spec: RunRoleSpec) => {
      calls.push(spec);
      const kind = kindOf(spec.args);
      const unit = spec.env?.SPARRA_CONDUCT_UNIT as string | undefined;
      return handler({ kind, unit, spec });
    },
  };
}
/** Contract phase: generator drafts, evaluator AGREES (round 1). Undefined for other kinds. */
function contractAgree(kind: string, spec: RunRoleSpec): ParentSummary | undefined {
  if (kind === "contract-generator") {
    fs.writeFileSync(argVal(spec.args, "--out")!, "C");
    return summary({ roleKind: "contract-generator", outPath: argVal(spec.args, "--out") });
  }
  if (kind === "contract-evaluator") return summary({ roleKind: "contract-evaluator", contractAgreed: true });
  return undefined;
}
/** A hybrid fake runner: agreed contract, then a PASS every round (for brain-path fixtures). */
function passingHybridRunner(): FakeRunner {
  return fakeRunner(({ kind, spec }) => {
    const c = contractAgree(kind, spec);
    if (c) return c;
    if (kind === "generator") return summary({ roleKind: "generator", filesChanged: 1 });
    return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false });
  });
}

const OPTS = (o: Partial<ConductOptions> = {}): ConductOptions => ({
  prompt: "build a thing",
  maxUnits: 4,
  concurrency: 2,
  dryRun: false,
  ...o,
});

interface SeedUnit {
  id: string;
  title?: string;
  outcome: UnitOutcome;
  contract?: string;
  contractAgreed?: boolean;
  contractForced?: boolean;
}
/** Write a persisted run dir (run.json + per-unit brief/contract), simulating a crashed run —
 *  so `resumeConduct` can be exercised WITHOUT ever calling `runConduct` first. */
function seedRun(ctx: Ctx, runId: string, opts: { status: ConductRunState["status"]; units: SeedUnit[] }): void {
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
    units,
  };
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(runStatePath(runDir), JSON.stringify(state, null, 2));
}

function fakeWorktreeSeam(): NonNullable<ConductDeps["ensureUnitWorktreeFn"]> {
  return (async (_ctx: Ctx, name: string, src: string): Promise<EnsureUnitWorktreeResult> => ({
    dir: `/wt/${name}`,
    branch: `sparra/${name}`,
    src,
    created: true,
  })) as NonNullable<ConductDeps["ensureUnitWorktreeFn"]>;
}

describe("runConduct — git.pullBeforeWork (fresh run)", () => {
  it("knob ON: injected pullUpstream is called once on ctx.root, BEFORE decomposition and before the first runRole call", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      ctx.config.git.pullBeforeWork = true;
      const order: string[] = [];
      const pullCalls: string[] = [];
      const runner = passingHybridRunner();
      const trackedRunRole = async (spec: RunRoleSpec) => {
        order.push("runRole");
        return runner.runRole(spec);
      };
      const trackedDecomposer: (p: RunSessionParams) => Promise<RunResult> = async (p) => {
        order.push("decompose");
        return decomposerFn(1)(p);
      };
      const res = await runConduct(ctx, OPTS(), {
        runRole: trackedRunRole,
        runSessionFn: trackedDecomposer,
        pullUpstream: (root) => {
          order.push("pull");
          pullCalls.push(root);
          return { ok: true, updated: true, note: "fast-forwarded" };
        },
      });
      expect(res.state.status).toBe("completed");
      expect(pullCalls).toEqual([ctx.root]);
      expect(order[0]).toBe("pull");
      expect(order.indexOf("pull")).toBeLessThan(order.indexOf("decompose"));
      expect(order.indexOf("pull")).toBeLessThan(order.indexOf("runRole"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("knob OFF (default): injected pullUpstream is never called", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      expect(ctx.config.git.pullBeforeWork).toBe(false); // default
      let called = false;
      const runner = passingHybridRunner();
      const res = await runConduct(ctx, OPTS(), {
        runRole: runner.runRole,
        runSessionFn: decomposerFn(1),
        pullUpstream: () => {
          called = true;
          return { ok: true, updated: false, note: "n/a" };
        },
      });
      expect(res.state.status).toBe("completed");
      expect(called).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failed pull (ok:false) never blocks the run — decomposition and the unit batch still proceed", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      ctx.config.git.pullBeforeWork = true;
      const runner = passingHybridRunner();
      const res = await runConduct(ctx, OPTS(), {
        runRole: runner.runRole,
        runSessionFn: decomposerFn(1),
        pullUpstream: () => ({ ok: false, updated: false, note: "offline — skipping" }),
      });
      expect(res.state.status).toBe("completed");
      expect(res.state.units[0]!.outcome).toBe("accepted");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resumeConduct — git.pullBeforeWork NEVER pulls on resume", () => {
  it("knob ON: injected pullUpstream is never called on --resume, even though a unit re-enters and runs roles", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      ctx.config.git.pullBeforeWork = true;
      const runId = "conduct-PULL-RESUME";
      seedRun(ctx, runId, {
        status: "running",
        units: [{ id: "unit-001", outcome: "error", contract: "AGREED", contractAgreed: true }],
      });
      let pullCalled = false;
      const runner = passingHybridRunner();
      const res = await resumeConduct(ctx, runId, { surface: "auto" }, {
        runRole: runner.runRole,
        ensureUnitWorktreeFn: fakeWorktreeSeam(),
        brain: null,
        pullUpstream: () => {
          pullCalled = true;
          return { ok: true, updated: true, note: "fast-forwarded" };
        },
      });
      expect(res.status).toBe("resumed");
      // The unit actually re-ran (proving resume did real work) — yet the pull seam never fired.
      expect(runner.calls.length).toBeGreaterThan(0);
      expect(pullCalled).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
