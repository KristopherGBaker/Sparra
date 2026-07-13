import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadCtxForRole, type Ctx } from "../src/context.ts";
import { runConduct, type ConductOptions } from "../src/conduct/run.ts";
import { parseConductFlags } from "../src/phases/conduct.ts";
import { commitUnit } from "../src/conduct/commit.ts";
import type { LandingGit } from "../src/conduct/merge.ts";
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
