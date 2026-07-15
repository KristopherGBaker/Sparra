import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadCtxForRole, type Ctx } from "../src/context.ts";
import { runConduct, type ConductOptions, type ConductResult } from "../src/conduct/run.ts";
import { cmdConduct, cmdConductResume, parseConductFlags, parseConductReport } from "../src/phases/conduct.ts";
import { commitUnit } from "../src/conduct/commit.ts";
import { conductRunBranch, landAcceptedUnits, type LandingDeps, type LandingGit } from "../src/conduct/merge.ts";
import { RunStateWriter } from "../src/conduct/runState.ts";
import type { ConductRunState, UnitStateEntry } from "../src/conduct/types.ts";
import type { ConductCommitGit } from "../src/conduct/commit.ts";
import type { ParentSummary, RunRoleSpec } from "../conductors/core/index.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

/**
 * DI-fake landing tests (no model calls, no real git): the flagless byte-identity guarantee (A2),
 * `--merge` ⇒ `--commit` flag parsing (A6), and the commit template/agent selection (A4) exercised
 * with fakes. Real-git behavior lives in test/conductMerge.test.ts.
 */
const noProbe = async (): Promise<void> => {};
function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sparra-landing-"));
}
async function makeCtx(dir: string): Promise<Ctx> {
  return loadCtxForRole(dir, { probeAuto: noProbe });
}
function summary(o: Partial<ParentSummary>): ParentSummary {
  return { roleKind: "generator", backend: "stub", model: "stub-1", ok: true, errors: [], tokens: 0, costUsd: 0, ...o };
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
function kindOf(args: string[]): string {
  const i = args.indexOf("--kind");
  return i >= 0 ? args[i + 1]! : args[0] === "eval" ? "evaluator" : "?";
}
function acceptingRunner(spec: RunRoleSpec): Promise<ParentSummary> {
  const kind = kindOf(spec.args);
  if (kind === "contract-generator") {
    const i = spec.args.indexOf("--out");
    if (i >= 0) fs.writeFileSync(spec.args[i + 1]!, "P");
    return Promise.resolve(summary({ roleKind: "contract-generator", ...(i >= 0 ? { outPath: spec.args[i + 1] } : {}) }));
  }
  if (kind === "contract-evaluator") return Promise.resolve(summary({ roleKind: "contract-evaluator", contractAgreed: true }));
  if (kind === "generator") return Promise.resolve(summary({ roleKind: "generator", filesChanged: 1 }));
  return Promise.resolve(summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, weightedTotal: 90 }));
}

/** A git seam whose every method throws — proves it is NEVER called. */
function throwingLandingGit(): Partial<LandingGit> {
  const boom = (name: string) => () => {
    throw new Error(`mutating git op called: ${name}`);
  };
  return {
    currentBranch: boom("currentBranch") as unknown as LandingGit["currentBranch"],
    defaultBranch: boom("defaultBranch") as unknown as LandingGit["defaultBranch"],
    addNamedWorktree: boom("addNamedWorktree") as unknown as LandingGit["addNamedWorktree"],
    rebaseBranch: boom("rebaseBranch") as unknown as LandingGit["rebaseBranch"],
    mergeCheckedOut: boom("mergeCheckedOut") as unknown as LandingGit["mergeCheckedOut"],
    abortRebase: boom("abortRebase") as unknown as LandingGit["abortRebase"],
    abortMerge: boom("abortMerge") as unknown as LandingGit["abortMerge"],
    isDirty: boom("isDirty") as unknown as LandingGit["isDirty"],
  };
}
function throwingCommitGit(): Partial<ConductCommitGit> {
  const boom = (name: string) => () => {
    throw new Error(`mutating commit op called: ${name}`);
  };
  return {
    changedFiles: boom("changedFiles") as unknown as ConductCommitGit["changedFiles"],
    commitPaths: boom("commitPaths") as unknown as ConductCommitGit["commitPaths"],
    workingDiff: boom("workingDiff") as unknown as ConductCommitGit["workingDiff"],
    revParse: boom("revParse") as unknown as ConductCommitGit["revParse"],
  };
}

const OPTS = (o: Partial<ConductOptions>): ConductOptions => ({ prompt: "p", maxUnits: 4, concurrency: 2, dryRun: false, ...o });

describe("conduct landing — flag parsing", () => {
  it("A6: --merge implies --commit; --commit alone sets commit only; neither leaves both unset", () => {
    const merge = parseConductFlags("do it", { merge: true });
    expect(merge.ok && merge.opts.commit).toBe(true);
    expect(merge.ok && merge.opts.merge).toBe(true);

    const commit = parseConductFlags("do it", { commit: true });
    expect(commit.ok && commit.opts.commit).toBe(true);
    expect(commit.ok && commit.opts.merge).toBeUndefined();

    const none = parseConductFlags("do it", {});
    expect(none.ok && none.opts.commit).toBeUndefined();
    expect(none.ok && none.opts.merge).toBeUndefined();
  });
});

describe("conduct landing — byte-identity without flags (A2)", () => {
  it("a flagless run performs ZERO mutating git/commit ops and records no committedSha/mergedInto", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const res = await runConduct(ctx, OPTS({}), {
        runRole: acceptingRunner,
        runSessionFn: decomposerFn(2),
        // If landing ran, these would throw — but no flags ⇒ landing never runs.
        landingGit: throwingLandingGit(),
        commitGit: throwingCommitGit(),
        committerSessionFn: async () => {
          throw new Error("no committer session may run without flags");
        },
        removeUnitWorktreeFn: async () => {
          throw new Error("no teardown may run without flags");
        },
      });
      expect(res.state.units).toHaveLength(2);
      for (const u of res.state.units) {
        expect(u.outcome).toBe("accepted");
        expect("committedSha" in u).toBe(false);
        expect("mergedInto" in u).toBe(false);
      }
      // The persisted run.json is likewise clean.
      const rj = JSON.parse(fs.readFileSync(path.join(res.runDir, "run.json"), "utf8"));
      for (const u of rj.units) {
        expect(u.committedSha).toBeUndefined();
        expect(u.mergedInto).toBeUndefined();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct commit — no-op when nothing changed (DI fake)", () => {
  it("returns ok:false with no sha and never calls commitPaths when there is no WIP", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      let committed = 0;
      const r = await commitUnit(ctx, {
        unit: { id: "unit-001", title: "T", score: 91 },
        runId: "conduct-x",
        worktreeDir: dir,
        agentCommits: "template",
        traceDir: dir,
        git: {
          changedFiles: () => [], // nothing changed
          commitPaths: () => {
            committed++;
            return { ok: true, out: "" };
          },
          revParse: () => "0".repeat(40),
        },
      });
      expect(r.ok).toBe(false);
      expect(r.sha).toBeUndefined();
      expect(committed).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════ conduct --land ═══════════════════════════

/** A 40-hex placeholder sha, distinguishable by its leading digit. */
function sha(n: number): string {
  return String(n).repeat(40).slice(0, 40);
}

/** One minimal `UnitStateEntry`. */
function unit(id: string, outcome: UnitStateEntry["outcome"], extra: Partial<UnitStateEntry> = {}): UnitStateEntry {
  return { id, title: `Unit ${id}`, outcome, briefPath: `/tmp/${id}/brief.md`, ...extra };
}

/** A minimal `ConductRunState` for direct `landAcceptedUnits` calls. */
function landState(runId: string, units: UnitStateEntry[], extra: Partial<ConductRunState> = {}): ConductRunState {
  return {
    runId,
    prompt: "p",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    maxUnits: 4,
    concurrency: 2,
    dryRun: false,
    units,
    ...extra,
  };
}

/**
 * A fully-faked `LandingGit` that never touches real git: `currentBranch`/`defaultBranch` are
 * STATEFUL (call-counted) so a test can simulate "started on default" (the FIRST call, made by
 * `resolveMergeTarget`) diverging from "still on default at land time" (the SECOND call, made by
 * `attemptLandToDefault`) — e.g. the worktree-safe case, where the live checkout moved between
 * conduct-start and land. `refs` models a tiny ref store so `mergeCheckedOut`/`fastForwardBranchRef`
 * can realistically "advance" the default branch and `revParse`/`landedInto` reflect it.
 */
function fakeLandGit(
  runId: string,
  opts: {
    /** `currentBranch` return values, in call order (repeats the last one past the end). */
    currentBranchSeq?: string[];
    isBranchMerged?: boolean;
    mergeCheckedOutResult?: { ok: boolean; out: string };
    fastForwardResult?: { ok: boolean; out: string };
  } = {},
): { git: Partial<LandingGit>; refs: Record<string, string>; calls: { mergeCheckedOut: number; fastForwardBranchRef: number } } {
  const branch = conductRunBranch(runId);
  const refs: Record<string, string> = { main: sha(1), [branch]: sha(2) };
  const calls = { mergeCheckedOut: 0, fastForwardBranchRef: 0 };
  const seq = opts.currentBranchSeq ?? ["main", "main"];
  let call = 0;
  const git: Partial<LandingGit> = {
    currentBranch: () => seq[Math.min(call++, seq.length - 1)]!,
    defaultBranch: () => "main",
    listWorktrees: () => [],
    addNamedWorktree: () => ({ ok: true, out: "" }),
    isDirty: () => false,
    revParse: (_dir, ref) => refs[ref] ?? null,
    isBranchMerged: () => opts.isBranchMerged ?? true,
    mergeCheckedOut: (_dir, source) => {
      calls.mergeCheckedOut++;
      const res = opts.mergeCheckedOutResult ?? { ok: true, out: "" };
      if (res.ok) refs.main = refs[source] ?? refs.main!;
      return res;
    },
    fastForwardBranchRef: (_root, br, sourceRef) => {
      calls.fastForwardBranchRef++;
      const res = opts.fastForwardResult ?? { ok: true, out: "" };
      if (res.ok) refs[br] = refs[sourceRef] ?? refs[br]!;
      return res;
    },
  };
  return { git, refs, calls };
}

/** Build a minimal `LandingDeps` for a direct `landAcceptedUnits` call in `land` mode. */
function landDeps(runId: string, dir: string, state: ConductRunState, git: Partial<LandingGit>): LandingDeps {
  return {
    mode: "merge",
    land: true,
    runId,
    runDir: path.join(dir, "run"),
    writer: new RunStateWriter(path.join(dir, "run")),
    state,
    git,
    surface: "auto",
    nowMs: () => Date.now(),
    sleep: async () => {},
    timeoutSec: 30,
    seqRef: { n: 0 },
    // Empty restrictTo ⇒ the per-unit commit/merge loop processes NOTHING this invocation (these
    // tests construct `state.units` already reflecting a prior "merged onto the run branch" state
    // directly) — only the `--land` step (which evaluates readiness over the FULL `deps.state`,
    // independent of restrictTo) runs. This also means every git call this invocation is faked
    // (`fakeLandGit`); nothing falls through to real git.
    restrictTo: new Set<string>(),
  };
}

describe("conduct --land — CLI flag parsing + the double gate", () => {
  it("--land implies --merge implies --commit (all three set true)", () => {
    const r = parseConductFlags("do it", { land: true });
    expect(r.ok && r.opts.land).toBe(true);
    expect(r.ok && r.opts.merge).toBe(true);
    expect(r.ok && r.opts.commit).toBe(true);
  });

  it("--merge alone still leaves land unset; neither flag leaves all three unset", () => {
    const merge = parseConductFlags("do it", { merge: true });
    expect(merge.ok && merge.opts.land).toBeUndefined();
    const none = parseConductFlags("do it", {});
    expect(none.ok && none.opts.land).toBeUndefined();
    expect(none.ok && none.opts.merge).toBeUndefined();
    expect(none.ok && none.opts.commit).toBeUndefined();
  });

  it("--status/--list reject --land exactly as they reject --commit/--merge (fail-closed allowlist)", () => {
    const withLand = parseConductReport(["conduct"], { status: "r1", land: true });
    expect(withLand).toEqual({ kind: "usage-error", error: expect.stringContaining("--land") });
    const withMerge = parseConductReport(["conduct"], { status: "r1", merge: true });
    expect(withMerge.kind).toBe("usage-error");
    const listWithLand = parseConductReport(["conduct"], { list: true, land: true });
    expect(listWithLand.kind).toBe("usage-error");
  });

  it("gate matrix: --land requires landToDefault:true — {config,flag} × {true,false}", async () => {
    async function attempt(landToDefault: boolean, land: boolean): Promise<{ reached: boolean; exitCode: number; seenLand?: boolean }> {
      const dir = tmpdir();
      try {
        const ctx = await makeCtx(dir);
        ctx.config.conduct.landToDefault = landToDefault;
        let reached = false;
        let seenLand: boolean | undefined;
        process.exitCode = 0;
        await cmdConduct(ctx, "build a thing", land ? { land: true } : {}, {
          autoProbe: noProbe as unknown as never,
          runConductFn: async (_c, opts) => {
            reached = true;
            seenLand = opts.land;
            return { runId: "r", runDir: "d", state: { units: [] } } as unknown as ConductResult;
          },
        });
        return { reached, exitCode: process.exitCode, seenLand };
      } finally {
        process.exitCode = 0;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    // both false/absent → normal run, no land.
    expect(await attempt(false, false)).toMatchObject({ reached: true, exitCode: 0, seenLand: undefined });
    // config true, flag absent → normal run, no land (flag is still required).
    expect(await attempt(true, false)).toMatchObject({ reached: true, exitCode: 0, seenLand: undefined });
    // flag present, config false → HARD ERROR, runner never reached.
    expect(await attempt(false, true)).toMatchObject({ reached: false, exitCode: 1 });
    // BOTH true → the only cell that reaches the runner with land:true.
    expect(await attempt(true, true)).toMatchObject({ reached: true, exitCode: 0, seenLand: true });
  });

  it("--land without conduct.landToDefault: true is a hard, actionable error naming the knob; no run dir created", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      ctx.config.conduct.landToDefault = false;
      let reached = 0;
      process.exitCode = 0;
      await cmdConduct(ctx, "build a thing", { land: true }, {
        autoProbe: noProbe as unknown as never,
        runConductFn: async () => {
          reached++;
          return { runId: "r", runDir: "d", state: { units: [] } } as unknown as ConductResult;
        },
      });
      expect(reached).toBe(0);
      expect(process.exitCode).toBe(1);
      expect(fs.existsSync(path.join(dir, ".sparra", "conduct"))).toBe(false);
    } finally {
      process.exitCode = 0;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resume: --land without conduct.landToDefault: true is a hard error too; resumeConductFn never reached", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      ctx.config.conduct.landToDefault = false;
      let reached = 0;
      process.exitCode = 0;
      await cmdConductResume(ctx, "some-run-id", { land: true }, {
        autoProbe: noProbe as unknown as never,
        resumeConductFn: async () => {
          reached++;
          return { status: "resumed", runId: "r", runDir: "d", state: { units: [] } } as unknown as never;
        },
      });
      expect(reached).toBe(0);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = 0;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct --land — non-default-start no-op (DI fake)", () => {
  it("a run that did NOT start on the default branch performs no land: no park, no landedInto, no git write", async () => {
    const dir = tmpdir();
    const runId = "conduct-land-nondef";
    try {
      const state = landState(runId, [unit("u1", "accepted", { mergedInto: "feature" })]);
      // currentBranch differs from defaultBranch on BOTH calls → resolveMergeTarget resolves a
      // non-default (in-place) target, so land never even reaches the readiness check.
      const { git, calls } = fakeLandGit(runId, { currentBranchSeq: ["feature", "feature"] });
      await landAcceptedUnits(await makeCtx(dir), landDeps(runId, dir, state, git));
      expect(state.landedInto).toBeUndefined();
      expect(state.landDecisions ?? []).toHaveLength(0);
      expect(calls.mergeCheckedOut).toBe(0);
      expect(calls.fastForwardBranchRef).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct --land — clean-run gate (DI fake)", () => {
  async function attempt(
    units: UnitStateEntry[],
    extra: Partial<ConductRunState> = {},
  ): Promise<{ state: ConductRunState; calls: { mergeCheckedOut: number; fastForwardBranchRef: number }; onDisk: ConductRunState }> {
    const dir = tmpdir();
    const runId = "conduct-land-gate";
    const state = landState(runId, units, extra);
    const { git, calls } = fakeLandGit(runId);
    await landAcceptedUnits(await makeCtx(dir), landDeps(runId, dir, state, git));
    // Read run.json back BEFORE cleanup — proves the reason is really durable on disk (survives a
    // fresh read), not merely in-memory on the `state` object this test happens to hold.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "run", "run.json"), "utf8")) as ConductRunState;
    fs.rmSync(dir, { recursive: true, force: true });
    return { state, calls, onDisk };
  }

  it("(a) accepted-only, all merged into the run branch → LANDS", async () => {
    const branch = conductRunBranch("conduct-land-gate");
    const { state, calls } = await attempt([unit("u1", "accepted", { mergedInto: branch })]);
    expect(state.landedInto).toBe(`main@${sha(2)}`);
    expect(calls.mergeCheckedOut).toBe(1);
  });

  it("(b1) an ERROR unit → no land, park names the unit + its outcome, default untouched", async () => {
    const branch = conductRunBranch("conduct-land-gate");
    const { state, calls, onDisk } = await attempt([
      unit("u1", "accepted", { mergedInto: branch }),
      unit("u2", "error"),
    ]);
    expect(state.landedInto).toBeUndefined();
    expect(calls.mergeCheckedOut).toBe(0);
    const rec = state.landDecisions?.[0];
    expect(rec?.kind).toBe("land-blocked");
    expect(rec?.status).toBe("resolved");
    expect(rec?.note ?? rec?.rationale ?? "").not.toContain("undefined");
    // The PERSISTED record (not just transient logger output) names the concrete first-failing
    // condition: the specific non-accepted unit + its outcome.
    expect(rec?.reason).toBe('unit u2 is not accepted (outcome "error")');
    // And it survives a fresh read of run.json off disk — i.e. it's really durable, not merely
    // in-memory on the `state` object this test happens to hold a reference to.
    expect(onDisk.landDecisions?.[0]?.reason).toBe('unit u2 is not accepted (outcome "error")');
  });

  it("(b2) a PENDING unit → no land (outcome !== accepted rejects it, not an allowlist of named states)", async () => {
    const { state, calls } = await attempt([unit("u1", "pending")]);
    expect(state.landedInto).toBeUndefined();
    expect(calls.mergeCheckedOut).toBe(0);
    expect(state.landDecisions?.[0]?.kind).toBe("land-blocked");
  });

  it("(b3) a NOVEL/unknown outcome string → still rejected (the predicate is 'all terminal ACCEPTED', never a denylist)", async () => {
    const branch = conductRunBranch("conduct-land-gate");
    const { state, calls } = await attempt([
      unit("u1", "accepted", { mergedInto: branch }),
      unit("u2", "some-brand-new-outcome-nobody-named-yet" as UnitStateEntry["outcome"]),
    ]);
    expect(state.landedInto).toBeUndefined();
    expect(calls.mergeCheckedOut).toBe(0);
    expect(calls.fastForwardBranchRef).toBe(0);
    expect(state.landDecisions?.[0]?.kind).toBe("land-blocked");
  });

  it("(c) an unresolved parked decision on a unit → no land, default untouched", async () => {
    const branch = conductRunBranch("conduct-land-gate");
    const { state, calls } = await attempt([
      unit("u1", "accepted", {
        mergedInto: branch,
        decisions: [
          { seq: 1, unit: "u1", kind: "borderline-accept", question: "q", options: ["accept"], default: "accept", status: "pending", requestedAt: "t" },
        ],
      }),
    ]);
    expect(state.landedInto).toBeUndefined();
    expect(calls.mergeCheckedOut).toBe(0);
    expect(state.landDecisions?.[0]?.kind).toBe("land-blocked");
  });

  it("(d) an accepted unit whose run-branch merge PARKED (mergedInto unset) → no land, default untouched", async () => {
    const { state, calls } = await attempt([
      unit("u1", "accepted", {
        decisions: [
          { seq: 1, unit: "u1", kind: "merge-blocked", question: "q", options: ["skip-unit", "abort-merge"], default: "skip-unit", status: "resolved", chosen: "skip-unit", requestedAt: "t" },
        ],
      }),
    ]);
    expect(state.landedInto).toBeUndefined();
    expect(calls.mergeCheckedOut).toBe(0);
    const rec = state.landDecisions?.[0];
    expect(rec?.kind).toBe("land-blocked");
  });
});

describe("conduct --land — ff-only, advanced-default, and worktree-safety (DI fake)", () => {
  it("a TRUE fast-forward lands: records landedInto and advances the default ref to the run-branch tip", async () => {
    const dir = tmpdir();
    const runId = "conduct-land-ff";
    try {
      const branch = conductRunBranch(runId);
      const state = landState(runId, [unit("u1", "accepted", { mergedInto: branch })]);
      const { git, refs, calls } = fakeLandGit(runId, { currentBranchSeq: ["main", "main"] });
      await landAcceptedUnits(await makeCtx(dir), landDeps(runId, dir, state, git));
      expect(refs.main).toBe(sha(2)); // advanced to the run branch's tip
      expect(state.landedInto).toBe(`main@${sha(2)}`);
      expect(calls.mergeCheckedOut).toBe(1); // default WAS the live checkout → checked-out ff merge
      expect(calls.fastForwardBranchRef).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an ADVANCED default (non-ff) ABORTS + PARKS: default tip UNCHANGED, no write attempted", async () => {
    const dir = tmpdir();
    const runId = "conduct-land-nonff";
    try {
      const branch = conductRunBranch(runId);
      const state = landState(runId, [unit("u1", "accepted", { mergedInto: branch })]);
      const { git, refs, calls } = fakeLandGit(runId, { isBranchMerged: false });
      await landAcceptedUnits(await makeCtx(dir), landDeps(runId, dir, state, git));
      expect(refs.main).toBe(sha(1)); // UNCHANGED
      expect(state.landedInto).toBeUndefined();
      expect(calls.mergeCheckedOut).toBe(0); // never even attempted the write
      expect(calls.fastForwardBranchRef).toBe(0);
      const rec = state.landDecisions?.[0];
      expect(rec?.kind).toBe("land-blocked");
      expect(rec?.status).toBe("resolved");
      // The PERSISTED reason names the advanced default's (unresolvable, since it never advanced past
      // sha(1) here) tip and that the run branch no longer fast-forwards.
      expect(rec?.reason).toContain(sha(1));
      expect(rec?.reason).toContain("no longer fast-forwards");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("WORKTREE-SAFE: default is NOT the live checkout at land time → advances the ref directly (fastForwardBranchRef), never mergeCheckedOut", async () => {
    const dir = tmpdir();
    const runId = "conduct-land-wtsafe";
    try {
      const branch = conductRunBranch(runId);
      const state = landState(runId, [unit("u1", "accepted", { mergedInto: branch })]);
      // FIRST call (resolveMergeTarget, at conduct-start time) sees "main" → started on default.
      // SECOND call (attemptLandToDefault, at land time) sees "elsewhere" → no longer the live checkout.
      const { git, refs, calls } = fakeLandGit(runId, { currentBranchSeq: ["main", "elsewhere"] });
      await landAcceptedUnits(await makeCtx(dir), landDeps(runId, dir, state, git));
      expect(calls.fastForwardBranchRef).toBe(1);
      expect(calls.mergeCheckedOut).toBe(0);
      expect(refs.main).toBe(sha(2));
      expect(state.landedInto).toBe(`main@${sha(2)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checked-out case: default IS the live checkout at land time → uses mergeCheckedOut, never fastForwardBranchRef", async () => {
    const dir = tmpdir();
    const runId = "conduct-land-checkedout";
    try {
      const branch = conductRunBranch(runId);
      const state = landState(runId, [unit("u1", "accepted", { mergedInto: branch })]);
      const { git, calls } = fakeLandGit(runId, { currentBranchSeq: ["main", "main"] });
      await landAcceptedUnits(await makeCtx(dir), landDeps(runId, dir, state, git));
      expect(calls.mergeCheckedOut).toBe(1);
      expect(calls.fastForwardBranchRef).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no `--force`/`-f` argument is ever passed on the land path (grep the implementation)", () => {
    const src = fs.readFileSync(new URL("../src/conduct/merge.ts", import.meta.url), "utf8");
    // The whole attemptLandToDefault function body is force-free; a narrow sanity grep suffices here
    // (the exhaustive "no push anywhere" sweep lives in the dedicated safety-properties test below).
    const start = src.indexOf("async function attemptLandToDefault");
    const end = src.indexOf("\n}", start);
    const body = src.slice(start, end);
    expect(body).not.toMatch(/--force|-f\b|"-f"/);
  });
});

describe("conduct --land — landing-write failure is non-fatal (DI fake, assertion 7)", () => {
  it("an injected ref-update failure leaves default UNCHANGED, landedInto UNSET, run-branch state intact, and parks", async () => {
    const dir = tmpdir();
    const runId = "conduct-land-writefail";
    try {
      const branch = conductRunBranch(runId);
      const state = landState(runId, [unit("u1", "accepted", { mergedInto: branch, committedSha: sha(2) })]);
      // Worktree-safe path (fastForwardBranchRef) injected to FAIL.
      const { git, refs, calls } = fakeLandGit(runId, {
        currentBranchSeq: ["main", "elsewhere"],
        fastForwardResult: { ok: false, out: "simulated ref-update rejection" },
      });
      await expect(landAcceptedUnits(await makeCtx(dir), landDeps(runId, dir, state, git))).resolves.toBeUndefined();
      expect(refs.main).toBe(sha(1)); // UNCHANGED
      expect(state.landedInto).toBeUndefined(); // UNSET
      expect(calls.fastForwardBranchRef).toBe(1); // the write WAS attempted (this is the write failure, not the ff precheck)
      // The unit's own run-branch work is untouched — still recorded as merged onto the run branch.
      expect(state.units[0]!.mergedInto).toBe(branch);
      expect(state.units[0]!.committedSha).toBe(sha(2));
      // Parked/noted through the decision engine.
      const rec = state.landDecisions?.[0];
      expect(rec?.kind).toBe("land-blocked");
      expect(rec?.status).toBe("resolved");
      // The PERSISTED reason names the write failure itself (not the generic question).
      expect(rec?.reason).toContain("the landing write failed");
      expect(rec?.reason).toContain("simulated ref-update rejection");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an injected checked-out ff-merge failure is equally non-fatal", async () => {
    const dir = tmpdir();
    const runId = "conduct-land-writefail2";
    try {
      const branch = conductRunBranch(runId);
      const state = landState(runId, [unit("u1", "accepted", { mergedInto: branch })]);
      const { git, refs, calls } = fakeLandGit(runId, {
        currentBranchSeq: ["main", "main"],
        mergeCheckedOutResult: { ok: false, out: "simulated ff-merge rejection" },
      });
      await landAcceptedUnits(await makeCtx(dir), landDeps(runId, dir, state, git));
      expect(refs.main).toBe(sha(1));
      expect(state.landedInto).toBeUndefined();
      expect(calls.mergeCheckedOut).toBe(1);
      const rec = state.landDecisions?.[0];
      expect(rec?.kind).toBe("land-blocked");
      expect(rec?.reason).toContain("the landing write failed");
      expect(rec?.reason).toContain("simulated ff-merge rejection");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct --land — no push, no new push knob/flag (assertion 9)", () => {
  it("grep: no runnable code path in merge.ts/git.ts/conduct wiring invokes git push", () => {
    const files = ["src/conduct/merge.ts", "src/util/git.ts", "src/conduct/run.ts", "src/phases/conduct.ts"];
    for (const f of files) {
      const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
      expect(src).not.toMatch(/["'`]push["'`]/);
      expect(src).not.toMatch(/\bgit\s+push\b/);
    }
  });

  it("no new push CLI flag or config knob was introduced alongside --land", () => {
    const cli = fs.readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const config = fs.readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
    expect(cli).not.toMatch(/--push\b/);
    expect(config).not.toMatch(/\bpush\s*:/);
  });
});
