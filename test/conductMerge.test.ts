import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { loadCtxForRole, type Ctx } from "../src/context.ts";
import { runConduct, resumeConduct, type ConductDeps, type ConductOptions } from "../src/conduct/run.ts";
import { conductRunDir, runStatePath } from "../src/conduct/runState.ts";
import type { ConductRunState, UnitStateEntry } from "../src/conduct/types.ts";
import type { EnsureUnitWorktreeResult } from "../src/build/unitWorktree.ts";
import { commitUnit } from "../src/conduct/commit.ts";
import {
  conductRunBranch,
  conductMergeWorktreeDir,
  resolveMergeTarget,
  realLandingGit,
  type LandingGit,
} from "../src/conduct/merge.ts";
import type { Brain } from "../src/conduct/brain.ts";
import type { DecisionRequest } from "../src/conduct/decision.ts";
import { defaultUnitWorktreeDir } from "../src/build/unitWorktree.ts";
import {
  addNamedWorktree,
  isDirty,
  mergeOrRebaseInProgress,
  rebaseBranch,
  mergeCheckedOut,
  revParse,
} from "../src/util/git.ts";
import type { ParentSummary, RunRoleSpec } from "../conductors/core/index.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

/**
 * `sparra conduct --commit/--merge` — real-git integration in throwaway temp repos (mirrors
 * test/unitWorktree.test.ts). Every model call is FAKED (a decomposer session fn + a runRole that
 * creates real unit worktrees and returns accepted verdicts); `git.agentCommits` defaults to
 * `template` so no committer session ever runs. Lives in the vitest "real-git" project (groupOrder 1)
 * so its git subprocesses don't contend with the parallel unit suite.
 */
const GIT_IT = { timeout: 30_000 };
const noProbe = async (): Promise<void> => {};

function g(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

/** A throwaway git repo with one commit containing `files`, on branch `main`. Identity is set
 *  REPO-LOCAL (not just `-c` on the base commit): the PRODUCT code commits in this repo and its
 *  worktrees too, and an identity-less environment (CI runners) fails `git commit` outright —
 *  auto-detection only happens to work on a dev macOS box. */
function makeRepo(files: Record<string, string> = {}): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sparra-cmerge-")));
  g(dir, ["init"]);
  g(dir, ["config", "user.email", "t@t"]);
  g(dir, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, ".gitignore"), ".sparra/\n");
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  g(dir, ["add", "-A"]);
  g(dir, ["commit", "-m", "base"]);
  g(dir, ["branch", "-M", "main"]);
  return dir;
}

async function makeCtx(root: string): Promise<Ctx> {
  const ctx = await loadCtxForRole(root, { probeAuto: noProbe });
  ctx.config.git.agentCommits = "template"; // no committer session in tests
  return ctx;
}

function argVal(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
function kindOf(args: string[]): string {
  const i = args.indexOf("--kind");
  return i >= 0 ? args[i + 1]! : args[0] === "eval" ? "evaluator" : "?";
}

function summary(overrides: Partial<ParentSummary>): ParentSummary {
  return { roleKind: "generator", backend: "stub", model: "stub-1", ok: true, errors: [], tokens: 0, costUsd: 0, ...overrides };
}

function decomposerFn(units: { id: string; title: string; summary: string }[]): (p: RunSessionParams) => Promise<RunResult> {
  return async () => ({
    ok: true,
    subtype: "success",
    resultText: "```json\n" + JSON.stringify(units.map((u) => ({ ...u, rationale: "x" })) ) + "\n```",
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

/**
 * A fake runRole that, for the generator, creates the unit's REAL worktree (deterministic dir/branch)
 * and writes `wip(unitId)` into it as uncommitted WIP; the evaluator returns a cross-model pass.
 * `barrier` (optional) forces two units' generators to overlap in time.
 */
function fakeRunner(
  wip: (unitId: string, wtDir: string) => void,
  opts: { score?: number; barrier?: (unitId: string) => Promise<void> } = {},
): (spec: RunRoleSpec) => Promise<ParentSummary> {
  return async (spec: RunRoleSpec) => {
    const kind = kindOf(spec.args);
    const unit = (spec.env?.SPARRA_CONDUCT_UNIT as string) ?? "unit-001";
    if (kind === "contract-generator") {
      const out = argVal(spec.args, "--out");
      if (out) fs.writeFileSync(out, "CONTRACT PROPOSAL\n");
      return summary({ roleKind: "contract-generator", ...(out ? { outPath: out } : {}) });
    }
    if (kind === "contract-evaluator") return summary({ roleKind: "contract-evaluator", contractAgreed: true });
    if (kind === "generator") {
      const name = argVal(spec.args, "--unit-worktree")!;
      const wtDir = defaultUnitWorktreeDir(spec.cwd!, name);
      const branch = `sparra/${name}`;
      if (!fs.existsSync(wtDir)) addNamedWorktree(spec.cwd!, wtDir, branch);
      wip(unit, wtDir);
      if (opts.barrier) await opts.barrier(unit);
      return summary({
        roleKind: "generator",
        filesChanged: 1,
        unitWorktree: { name, dir: wtDir, branch, created: true },
        ...(opts.score !== undefined ? { weightedTotal: opts.score } : {}),
      });
    }
    return summary({ roleKind: "evaluator", verdict: "pass", sameModelGrade: false, ...(opts.score !== undefined ? { weightedTotal: opts.score } : {}) });
  };
}

const OPTS = (o: Partial<ConductOptions>): ConductOptions => ({
  prompt: "build a thing",
  maxUnits: 4,
  concurrency: 2,
  dryRun: false,
  ...o,
});

function cleanup(...dirs: string[]): void {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

/** True iff `sha` is reachable from `ref` (an ancestor of, or equal to, `ref`'s tip). */
function isAncestor(repo: string, sha: string, ref: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, ref], { cwd: repo });
    return true;
  } catch {
    return false;
  }
}

/** The LOGICAL index content (mode · sha · stage · path per entry) — stable across a stat-cache
 *  refresh, so a byte-for-byte string compare proves the index was never mutated. */
function stagedIndex(repo: string): string {
  return g(repo, ["ls-files", "--stage"]);
}

/** A fake conductor Brain whose `judge` returns a fixed merge answer and records every request. */
function fakeBrain(answer: string, seen: DecisionRequest[]): Brain {
  return {
    async judge(req: DecisionRequest) {
      seen.push(req);
      return { answer, rationale: "test" };
    },
    async drive() {
      return undefined;
    },
  };
}

/** Wrap the real landing git seam so every rebase/merge on the TARGET is COUNTED (still delegates to
 *  real git). Proves whether any target-mutating op started. */
function countingLandingGit(counters: { rebase: number; merge: number }): Partial<LandingGit> {
  return {
    rebaseBranch: (wt, onto) => {
      counters.rebase += 1;
      return rebaseBranch(wt, onto);
    },
    mergeCheckedOut: (dir, src, opts) => {
      counters.merge += 1;
      return mergeCheckedOut(dir, src, opts);
    },
  };
}

describe("conduct --commit (real git)", () => {
  it("A3/A14: accepted unit WIP lands on its sparra/<name> branch; committedSha == branch tip; no mergedInto", GIT_IT, async () => {
    const repo = makeRepo();
    const wts: string[] = [];
    try {
      const ctx = await makeCtx(repo);
      const runner = fakeRunner((u, wt) => fs.writeFileSync(path.join(wt, "feature.txt"), `work by ${u}\n`), { score: 90 });
      const res = await runConduct(ctx, OPTS({ commit: true }), {
        runRole: runner,
        runSessionFn: decomposerFn([{ id: "unit-001", title: "First unit", summary: "Do it." }]),
      });
      const entry = res.state.units[0]!;
      expect(entry.outcome).toBe("accepted");
      expect(entry.committedSha).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.mergedInto).toBeUndefined();
      // committedSha equals the branch tip, and the committed tree contains the WIP file.
      expect(revParse(repo, entry.branch!)).toBe(entry.committedSha);
      const tree = g(repo, ["ls-tree", "-r", "--name-only", entry.branch!]);
      expect(tree).toContain("feature.txt");
      // Worktree + branch preserved on --commit-only (A13).
      wts.push(defaultUnitWorktreeDir(repo, entry.worktree!));
      expect(fs.existsSync(defaultUnitWorktreeDir(repo, entry.worktree!))).toBe(true);
      // The commit message carries the score + conduct runId (A4).
      const msg = g(repo, ["log", "-1", "--format=%B", entry.branch!]);
      expect(msg).toContain(res.runId);
      expect(msg).toContain("90");
    } finally {
      cleanup(repo, ...wts);
    }
  });

  it("A5: holdout-path WIP change is EXCLUDED from the committed tree (mirrors commitItem)", GIT_IT, async () => {
    const repo = makeRepo();
    const name = "hold-unit";
    const wtDir = defaultUnitWorktreeDir(repo, name);
    try {
      addNamedWorktree(repo, wtDir, `sparra/${name}`);
      fs.writeFileSync(path.join(wtDir, "feature.txt"), "real work\n");
      fs.writeFileSync(path.join(wtDir, "HOLDOUT.md"), "SECRET holdout\n"); // must be excluded
      const ctx = await makeCtx(repo);
      const r = await commitUnit(ctx, {
        unit: { id: name, title: "Holdout unit", score: 88 },
        runId: "conduct-xyz",
        worktreeDir: wtDir,
        holdoutPaths: [path.join(wtDir, "HOLDOUT.md")],
        agentCommits: "template",
        traceDir: wtDir,
      });
      expect(r.ok).toBe(true);
      const tree = g(wtDir, ["ls-tree", "-r", "--name-only", "HEAD"]);
      expect(tree).toContain("feature.txt");
      expect(tree).not.toContain("HOLDOUT.md");
      // Holdout still present in the working tree (excluded, never destroyed).
      expect(fs.existsSync(path.join(wtDir, "HOLDOUT.md"))).toBe(true);
    } finally {
      cleanup(repo, wtDir);
    }
  });

  it("A4: template mode runs NO committer session; agent mode exercises the committer-plan flow", GIT_IT, async () => {
    const repo = makeRepo();
    const nameT = "tmpl-unit";
    const nameA = "agent-unit";
    const wtT = defaultUnitWorktreeDir(repo, nameT);
    const wtA = defaultUnitWorktreeDir(repo, nameA);
    try {
      const ctx = await makeCtx(repo);
      // template: a session fn that FAILS the test if ever called.
      let sessions = 0;
      const failingSession = async (): Promise<RunResult> => {
        sessions++;
        throw new Error("no committer session may run in template mode");
      };
      addNamedWorktree(repo, wtT, `sparra/${nameT}`);
      fs.writeFileSync(path.join(wtT, "a.txt"), "a\n");
      const rT = await commitUnit(ctx, {
        unit: { id: nameT, title: "T", score: 70 },
        runId: "conduct-t",
        worktreeDir: wtT,
        agentCommits: "template",
        traceDir: wtT,
        runSessionFn: failingSession,
      });
      expect(rT.ok).toBe(true);
      expect(sessions).toBe(0); // NO committer session ran

      // agent: a fake committer returns a two-commit plan; the harness executes it.
      addNamedWorktree(repo, wtA, `sparra/${nameA}`);
      fs.writeFileSync(path.join(wtA, "x.txt"), "x\n");
      fs.writeFileSync(path.join(wtA, "y.txt"), "y\n");
      const planSession = async (): Promise<RunResult> => ({
        ok: true,
        subtype: "success",
        resultText: "```json\n" + JSON.stringify({ commits: [
          { message: "feat: x", files: ["x.txt"] },
          { message: "feat: y", files: ["y.txt"] },
        ] }) + "\n```",
        sessionId: "c",
        costUsd: 0,
        tokens: 1,
        numTurns: 1,
        hitMaxTurns: false,
        hitBudget: false,
        errors: [],
        tracePath: "",
      });
      const rA = await commitUnit(ctx, {
        unit: { id: nameA, title: "A", score: 80 },
        runId: "conduct-a",
        worktreeDir: wtA,
        agentCommits: "agent",
        traceDir: wtA,
        runSessionFn: planSession,
      });
      expect(rA.ok).toBe(true);
      expect(rA.commits).toBe(2); // the committer plan was executed atomically
      expect(g(wtA, ["log", "--format=%s"]).split("\n").filter(Boolean).slice(0, 2)).toEqual(["feat: y", "feat: x"]);
    } finally {
      cleanup(repo, wtT, wtA);
    }
  });
});

describe("conduct --merge (real git)", () => {
  /** Run a full commit+merge conduct over one repo with the given units + WIP writers. */
  async function runMerge(
    repo: string,
    units: { id: string; title: string; summary: string }[],
    wip: (unitId: string, wtDir: string) => void,
    deps: Partial<ConductDeps> = {},
    opts: Partial<ConductOptions> = {},
  ) {
    const ctx = await makeCtx(repo);
    return runConduct(ctx, OPTS({ merge: true, concurrency: 2, ...opts }), {
      runRole: fakeRunner(wip, { score: 90 }),
      runSessionFn: decomposerFn(units),
      now: () => Date.now(),
      sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 1))),
      ...deps,
    });
  }

  it("A6/A7 (default branch): --merge implies --commit; branches land on sparra/<runId>; default tip unchanged", GIT_IT, async () => {
    const repo = makeRepo();
    const runWts: string[] = [];
    try {
      const mainTipBefore = revParse(repo, "main");
      const res = await runMerge(
        repo,
        [{ id: "unit-001", title: "Unit one", summary: "one" }],
        (u, wt) => fs.writeFileSync(path.join(wt, `f-${u}.txt`), `${u}\n`),
      );
      const entry = res.state.units[0]!;
      const target = conductRunBranch(res.runId);
      runWts.push(path.join(path.dirname(repo), `${path.basename(repo)}-merge-${res.runId}`));
      expect(entry.committedSha).toMatch(/^[0-9a-f]{40}$/); // commit happened before merge
      expect(entry.mergedInto).toBe(target);
      // The unit's commit is reachable from the run branch.
      expect(g(repo, ["ls-tree", "-r", "--name-only", target])).toContain("f-unit-001.txt");
      // A14 after rebase: committedSha is the SURVIVING landed tip (== the target tip after rebase+ff),
      // reachable from mergedInto even though the unit branch is torn down — NOT a dangling pre-rebase sha.
      expect(revParse(repo, target)).toBe(entry.committedSha);
      expect(isAncestor(repo, entry.committedSha!, target)).toBe(true);
      // Default branch NEVER touched.
      expect(revParse(repo, "main")).toBe(mainTipBefore);
      expect(target).not.toBe("main");
    } finally {
      cleanup(repo, ...runWts);
    }
  });

  it("A7 (feature branch): merges land on the current non-default branch; default tip unchanged; A8 linear ff", GIT_IT, async () => {
    const repo = makeRepo();
    try {
      // Start conduct ON a non-default feature branch.
      g(repo, ["checkout", "-b", "feature"]);
      const mainTipBefore = revParse(repo, "main");
      const res = await runMerge(
        repo,
        [{ id: "unit-001", title: "Unit one", summary: "one" }],
        (u, wt) => fs.writeFileSync(path.join(wt, `f-${u}.txt`), `${u}\n`),
      );
      const entry = res.state.units[0]!;
      expect(entry.mergedInto).toBe("feature");
      expect(g(repo, ["ls-tree", "-r", "--name-only", "feature"])).toContain("f-unit-001.txt");
      // Rebase+ff → linear history (no merge commit): feature has a single parent chain.
      const merges = g(repo, ["log", "--merges", "--format=%H", "feature"]).trim();
      expect(merges).toBe("");
      // Default branch untouched.
      expect(revParse(repo, "main")).toBe(mainTipBefore);
    } finally {
      cleanup(repo);
    }
  });

  it("A8: merge-commit FALLBACK when rebase fails but a clean merge succeeds (DI-forced rebase failure)", GIT_IT, async () => {
    const repo = makeRepo();
    try {
      g(repo, ["checkout", "-b", "feature"]);
      const res = await runMerge(
        repo,
        [{ id: "unit-001", title: "Unit one", summary: "one" }],
        (u, wt) => fs.writeFileSync(path.join(wt, `f-${u}.txt`), `${u}\n`),
        { landingGit: { rebaseBranch: () => ({ ok: false, out: "forced rebase failure" }) } },
      );
      const entry = res.state.units[0]!;
      expect(entry.mergedInto).toBe("feature");
      expect(g(repo, ["ls-tree", "-r", "--name-only", "feature"])).toContain("f-unit-001.txt");
      // A merge commit landed (contrast with the linear ff case above).
      expect(g(repo, ["log", "--merges", "--format=%H", "feature"]).trim()).not.toBe("");
      // A14 in the merge-commit case: committedSha is a PARENT of the merge commit (reachable from the
      // target) but NOT the target tip — the verifiable branch-tip relationship the contract requires.
      expect(entry.committedSha).toMatch(/^[0-9a-f]{40}$/);
      expect(isAncestor(repo, entry.committedSha!, "feature")).toBe(true);
      expect(revParse(repo, "feature")).not.toBe(entry.committedSha);
    } finally {
      cleanup(repo);
    }
  });

  it("A9/A11: genuine same-line conflict PARKS (skip-unit/abort-merge); target clean, no mid-op state, unit intact", GIT_IT, async () => {
    // shared.txt exists at base; two units edit the SAME line differently → the 2nd conflicts.
    const repo = makeRepo({ "shared.txt": "base line\n" });
    try {
      g(repo, ["checkout", "-b", "feature"]);
      const requests: string[] = [];
      const res = await runMerge(
        repo,
        [
          { id: "unit-001", title: "Edit A", summary: "a" },
          { id: "unit-002", title: "Edit B", summary: "b" },
        ],
        (u, wt) => fs.writeFileSync(path.join(wt, "shared.txt"), `${u} version\n`),
        {
          // surface=park; resolve by writing the decision file the instant the request lands.
          onDecisionRequest: (p) => {
            requests.push(p);
            const seq = path.basename(p).split(".")[0];
            fs.writeFileSync(path.join(path.dirname(p), `${seq}.decision.json`), JSON.stringify({ answer: "skip-unit" }));
          },
        },
        { surface: "park", concurrency: 1 },
      );
      // Exactly one unit merged; the other parked.
      const merged = res.state.units.filter((u) => u.mergedInto);
      const parked = res.state.units.filter((u) => u.decisions?.some((d) => d.kind === "merge-blocked"));
      expect(merged).toHaveLength(1);
      expect(parked).toHaveLength(1);
      // The parked request carried the required options.
      expect(requests).toHaveLength(1);
      const reqDoc = JSON.parse(fs.readFileSync(requests[0]!, "utf8"));
      expect(reqDoc.options).toEqual(expect.arrayContaining(["skip-unit", "abort-merge"]));
      const rec = parked[0]!.decisions!.find((d) => d.kind === "merge-blocked")!;
      expect(rec.status).toBe("resolved");
      expect(rec.chosen).toBe("skip-unit");
      // A11: target (feature) has NO mid-operation state and is clean; the parked unit's branch/worktree survive.
      expect(mergeOrRebaseInProgress(repo)).toBe(false);
      expect(g(repo, ["status", "--porcelain"]).trim()).toBe("");
      const parkedEntry = parked[0]!;
      expect(fs.existsSync(defaultUnitWorktreeDir(repo, parkedEntry.worktree!))).toBe(true);
      expect(revParse(repo, parkedEntry.branch!)).toBeTruthy();
      // The parked unit's own WIP commit is intact (its shared.txt version).
      expect(g(repo, ["show", `${parkedEntry.branch}:shared.txt`])).toContain("version");
    } finally {
      cleanup(repo);
    }
  });

  it("A11: genuine conflict resolved ABORT-MERGE — target aborted clean (tip/index/worktree), unit intact", GIT_IT, async () => {
    // Two units edit shared.txt's same line; concurrency 1 lands unit-001 then CONFLICTS unit-002.
    const repo = makeRepo({ "shared.txt": "base line\n" });
    try {
      g(repo, ["checkout", "-b", "feature"]);
      const requests: string[] = [];
      const res = await runMerge(
        repo,
        [
          { id: "unit-001", title: "Edit A", summary: "a" },
          { id: "unit-002", title: "Edit B", summary: "b" },
        ],
        (u, wt) => fs.writeFileSync(path.join(wt, "shared.txt"), `${u} version\n`),
        {
          onDecisionRequest: (p) => {
            requests.push(p);
            const seq = path.basename(p).split(".")[0];
            fs.writeFileSync(path.join(path.dirname(p), `${seq}.decision.json`), JSON.stringify({ answer: "abort-merge" }));
          },
        },
        { surface: "park", concurrency: 1 },
      );
      const merged = res.state.units.filter((u) => u.mergedInto);
      const parked = res.state.units.filter((u) => u.decisions?.some((d) => d.kind === "merge-blocked"));
      expect(merged).toHaveLength(1);
      expect(parked).toHaveLength(1);
      const rec = parked[0]!.decisions!.find((d) => d.kind === "merge-blocked")!;
      expect(rec.chosen).toBe("abort-merge");
      expect(rec.status).toBe("resolved");
      // The merge was ABORTED clean: no mid-op, worktree clean, and the index matches HEAD (no staged
      // conflict residue). The target tip is EXACTLY the merged unit's landed commit — the aborted
      // unit never moved it.
      expect(mergeOrRebaseInProgress(repo)).toBe(false);
      expect(g(repo, ["status", "--porcelain"]).trim()).toBe("");
      expect(g(repo, ["diff", "--cached", "--name-only"]).trim()).toBe(""); // index == HEAD (no residue)
      expect(revParse(repo, "feature")).toBe(merged[0]!.committedSha);
      // The aborted unit's branch/worktree + its own WIP commit are intact (nothing torn down).
      const parkedEntry = parked[0]!;
      expect(fs.existsSync(defaultUnitWorktreeDir(repo, parkedEntry.worktree!))).toBe(true);
      expect(revParse(repo, parkedEntry.branch!)).toBeTruthy();
      expect(g(repo, ["show", `${parkedEntry.branch}:shared.txt`])).toContain("version");
      // The aborted unit did NOT land on the target.
      expect(g(repo, ["show", "feature:shared.txt"])).not.toContain("unit-002 version");
    } finally {
      cleanup(repo);
    }
  });

  it("A9 (auto): genuine conflict under --auto resolves deterministically with NO parked request file", GIT_IT, async () => {
    const repo = makeRepo({ "shared.txt": "base line\n" });
    try {
      g(repo, ["checkout", "-b", "feature"]);
      const requests: string[] = [];
      const res = await runMerge(
        repo,
        [
          { id: "unit-001", title: "Edit A", summary: "a" },
          { id: "unit-002", title: "Edit B", summary: "b" },
        ],
        (u, wt) => fs.writeFileSync(path.join(wt, "shared.txt"), `${u} version\n`),
        { onDecisionRequest: (p) => requests.push(p) },
        { surface: "auto", concurrency: 1 },
      );
      const merged = res.state.units.filter((u) => u.mergedInto);
      const parked = res.state.units.filter((u) => u.decisions?.some((d) => d.kind === "merge-blocked"));
      expect(merged).toHaveLength(1);
      expect(parked).toHaveLength(1);
      // AUTO never parks: no request file was ever written, and the decision resolved deterministically.
      expect(requests).toHaveLength(0);
      const decisionsDir = path.join(res.runDir, "decisions");
      const files = fs.existsSync(decisionsDir) ? fs.readdirSync(decisionsDir) : [];
      expect(files.filter((f) => f.endsWith(".request.json"))).toHaveLength(0);
      const rec = parked[0]!.decisions!.find((d) => d.kind === "merge-blocked")!;
      expect(rec.status).toBe("resolved");
      expect(rec.chosen).toBe("skip-unit"); // deterministic default
      expect(rec.source).toBe("auto-deterministic");
      // Target clean, and the skipped unit's worktree/branch survive.
      expect(mergeOrRebaseInProgress(repo)).toBe(false);
      expect(g(repo, ["status", "--porcelain"]).trim()).toBe("");
      const parkedEntry = parked[0]!;
      expect(fs.existsSync(defaultUnitWorktreeDir(repo, parkedEntry.worktree!))).toBe(true);
    } finally {
      cleanup(repo);
    }
  });

  it("A9 (brain): genuine conflict resolved by the conductor BRAIN with NO parked request file", GIT_IT, async () => {
    const repo = makeRepo({ "shared.txt": "base line\n" });
    try {
      g(repo, ["checkout", "-b", "feature"]);
      const ctx = await makeCtx(repo);
      const requests: string[] = [];
      const seen: DecisionRequest[] = [];
      const res = await runConduct(ctx, OPTS({ merge: true, concurrency: 1, brain: "hybrid", surface: "auto" }), {
        runRole: fakeRunner((u, wt) => fs.writeFileSync(path.join(wt, "shared.txt"), `${u} version\n`), { score: 90 }),
        runSessionFn: decomposerFn([
          { id: "unit-001", title: "Edit A", summary: "a" },
          { id: "unit-002", title: "Edit B", summary: "b" },
        ]),
        brain: fakeBrain("skip-unit", seen),
        now: () => Date.now(),
        sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 1))),
        onDecisionRequest: (p) => requests.push(p),
      });
      const merged = res.state.units.filter((u) => u.mergedInto);
      const parked = res.state.units.filter((u) => u.decisions?.some((d) => d.kind === "merge-blocked"));
      expect(merged).toHaveLength(1);
      expect(parked).toHaveLength(1);
      // The BRAIN judged the merge-blocked point (exactly once) and it never parked to a file.
      expect(seen.filter((r) => r.kind === "merge-blocked")).toHaveLength(1);
      expect(requests).toHaveLength(0);
      const decisionsDir = path.join(res.runDir, "decisions");
      const files = fs.existsSync(decisionsDir) ? fs.readdirSync(decisionsDir) : [];
      expect(files.filter((f) => f.endsWith(".request.json"))).toHaveLength(0);
      const rec = parked[0]!.decisions!.find((d) => d.kind === "merge-blocked")!;
      expect(rec.chosen).toBe("skip-unit");
      expect(rec.source).toBe("brain");
      expect(mergeOrRebaseInProgress(repo)).toBe(false);
      expect(g(repo, ["status", "--porcelain"]).trim()).toBe("");
    } finally {
      cleanup(repo);
    }
  });

  it("A10/A11: dirty target PARKS before any git op; tip + index (byte-for-byte) + dirty WIP intact; NO rebase/merge started", GIT_IT, async () => {
    const repo = makeRepo({ "shared.txt": "base line\n" });
    try {
      g(repo, ["checkout", "-b", "feature"]);
      // Dirty the target: BOTH a tracked-file working change AND a STAGED change, so an errant merge/
      // rebase would be detectable in either the working tree OR the index.
      fs.writeFileSync(path.join(repo, "shared.txt"), "DIRTY uncommitted\n");
      fs.writeFileSync(path.join(repo, "staged.txt"), "staged content\n");
      g(repo, ["add", "staged.txt"]);
      const tipBefore = revParse(repo, "feature");
      const indexBefore = stagedIndex(repo);
      const sharedBefore = fs.readFileSync(path.join(repo, "shared.txt"), "utf8");
      expect(isDirty(repo)).toBe(true);
      const requests: string[] = [];
      // Instrument the target-mutating seams: prove NEITHER a rebase NOR a merge is ever begun.
      const counters = { rebase: 0, merge: 0 };
      const res = await runMerge(
        repo,
        [{ id: "unit-001", title: "Unit one", summary: "one" }],
        (u, wt) => fs.writeFileSync(path.join(wt, `f-${u}.txt`), `${u}\n`),
        {
          landingGit: countingLandingGit(counters),
          onDecisionRequest: (p) => {
            requests.push(p);
            const seq = path.basename(p).split(".")[0];
            fs.writeFileSync(path.join(path.dirname(p), `${seq}.decision.json`), JSON.stringify({ answer: "skip-unit" }));
          },
        },
        { surface: "park", concurrency: 1 },
      );
      const entry = res.state.units[0]!;
      expect(entry.mergedInto).toBeUndefined(); // never merged
      expect(entry.committedSha).toMatch(/^[0-9a-f]{40}$/); // but committed
      expect(requests).toHaveLength(1);
      // The dirty target was detected and parked BEFORE any git op — no rebase, no merge ever started.
      expect(counters.rebase).toBe(0);
      expect(counters.merge).toBe(0);
      // Target byte-identical: tip unchanged, index unchanged (every entry's mode·sha·stage·path
      // compared byte-for-byte), dirty + staged WIP preserved verbatim, no mid-op state.
      expect(revParse(repo, "feature")).toBe(tipBefore);
      expect(stagedIndex(repo)).toBe(indexBefore);
      expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe(sharedBefore);
      expect(fs.readFileSync(path.join(repo, "staged.txt"), "utf8")).toBe("staged content\n");
      expect(mergeOrRebaseInProgress(repo)).toBe(false);
      // Unit branch + worktree remain available.
      expect(fs.existsSync(defaultUnitWorktreeDir(repo, entry.worktree!))).toBe(true);
    } finally {
      cleanup(repo);
    }
  });

  it("A10/A11: dirty target resolved ABORT-MERGE — target tip/index/dirty WIP byte-identical; NO git op; unit intact", GIT_IT, async () => {
    const repo = makeRepo({ "shared.txt": "base line\n" });
    try {
      g(repo, ["checkout", "-b", "feature"]);
      fs.writeFileSync(path.join(repo, "shared.txt"), "DIRTY uncommitted\n");
      fs.writeFileSync(path.join(repo, "staged.txt"), "staged content\n");
      g(repo, ["add", "staged.txt"]);
      const tipBefore = revParse(repo, "feature");
      const indexBefore = stagedIndex(repo);
      const sharedBefore = fs.readFileSync(path.join(repo, "shared.txt"), "utf8");
      const counters = { rebase: 0, merge: 0 };
      const res = await runMerge(
        repo,
        [{ id: "unit-001", title: "Unit one", summary: "one" }],
        (u, wt) => fs.writeFileSync(path.join(wt, `f-${u}.txt`), `${u}\n`),
        {
          landingGit: countingLandingGit(counters),
          onDecisionRequest: (p) => {
            const seq = path.basename(p).split(".")[0];
            fs.writeFileSync(path.join(path.dirname(p), `${seq}.decision.json`), JSON.stringify({ answer: "abort-merge" }));
          },
        },
        { surface: "park", concurrency: 1 },
      );
      const entry = res.state.units[0]!;
      const rec = entry.decisions!.find((d) => d.kind === "merge-blocked")!;
      expect(rec.chosen).toBe("abort-merge");
      expect(entry.mergedInto).toBeUndefined();
      expect(entry.committedSha).toMatch(/^[0-9a-f]{40}$/); // committed, never merged
      // No git op ever began on the dirty target; it is byte-identical.
      expect(counters.rebase).toBe(0);
      expect(counters.merge).toBe(0);
      expect(revParse(repo, "feature")).toBe(tipBefore);
      expect(stagedIndex(repo)).toBe(indexBefore);
      expect(fs.readFileSync(path.join(repo, "shared.txt"), "utf8")).toBe(sharedBefore);
      expect(fs.readFileSync(path.join(repo, "staged.txt"), "utf8")).toBe("staged content\n");
      expect(mergeOrRebaseInProgress(repo)).toBe(false);
      // Unit branch + worktree + WIP commit intact.
      expect(fs.existsSync(defaultUnitWorktreeDir(repo, entry.worktree!))).toBe(true);
      expect(revParse(repo, entry.branch!)).toBe(entry.committedSha);
    } finally {
      cleanup(repo);
    }
  });

  it("A12: two concurrently-completing units both land on the target EXACTLY once; both torn down", GIT_IT, async () => {
    const repo = makeRepo();
    const runWts: string[] = [];
    try {
      // Barrier: both units' generators must arrive before either proceeds (forced completion overlap).
      let arrived = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const barrier = async () => {
        if (++arrived === 2) release();
        await gate;
      };
      const ctx = await makeCtx(repo);
      const mainTipBefore = revParse(repo, "main");
      const res = await runConduct(ctx, OPTS({ merge: true, concurrency: 2 }), {
        runRole: fakeRunner(
          (u, wt) => fs.writeFileSync(path.join(wt, `f-${u}.txt`), `${u}\n`),
          { score: 90, barrier },
        ),
        runSessionFn: decomposerFn([
          { id: "unit-001", title: "One", summary: "1" },
          { id: "unit-002", title: "Two", summary: "2" },
        ]),
        now: () => Date.now(),
        sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 1))),
      });
      const target = conductRunBranch(res.runId);
      runWts.push(path.join(path.dirname(repo), `${path.basename(repo)}-merge-${res.runId}`));
      // Both units merged into the target exactly once, each with a valid committedSha.
      for (const e of res.state.units) {
        expect(e.outcome).toBe("accepted");
        expect(e.committedSha).toMatch(/^[0-9a-f]{40}$/);
        expect(e.mergedInto).toBe(target);
        // Worktree torn down after its own merge (A13).
        expect(fs.existsSync(defaultUnitWorktreeDir(repo, e.worktree!))).toBe(false);
      }
      // Both files present on the target, exactly once each (no lost update, no duplicate).
      const treeLines = g(repo, ["ls-tree", "-r", "--name-only", target]).split("\n").filter(Boolean);
      expect(treeLines.filter((l) => l === "f-unit-001.txt")).toHaveLength(1);
      expect(treeLines.filter((l) => l === "f-unit-002.txt")).toHaveLength(1);
      expect(revParse(repo, "main")).toBe(mainTipBefore); // default untouched
    } finally {
      cleanup(repo, ...runWts);
    }
  });

  it("commit-failure gate: changed WIP but commit creation FAILS → no rebase/merge/removal; WIP + branch + target all intact", GIT_IT, async () => {
    // Start on a feature branch so the merge target is `feature` in-place (no run worktree to reason about).
    const repo = makeRepo({ "shared.txt": "base line\n" });
    try {
      g(repo, ["checkout", "-b", "feature"]);
      const featureTipBefore = revParse(repo, "feature");
      let commitAttempts = 0;
      const res = await runMerge(
        repo,
        [{ id: "unit-001", title: "Unit one", summary: "one" }],
        (u, wt) => fs.writeFileSync(path.join(wt, `f-${u}.txt`), `${u}\n`),
        {
          // Real changedFiles/diff/revParse; commit CREATION forced to fail (simulates e.g. a hook rejection).
          commitGit: {
            commitPaths: () => {
              commitAttempts++;
              return { ok: false, out: "simulated commit failure (rejected)" };
            },
          },
        },
        { surface: "auto", concurrency: 1 },
      );
      const entry = res.state.units[0]!;
      expect(entry.outcome).toBe("accepted");
      // The commit step WAS attempted (WIP existed) but failed → no committedSha, no mergedInto.
      expect(commitAttempts).toBeGreaterThan(0);
      expect(entry.committedSha).toBeUndefined();
      expect(entry.mergedInto).toBeUndefined();
      // Target (feature) untouched: tip unchanged, no mid-operation state, and NOT dirtied by any merge.
      expect(revParse(repo, "feature")).toBe(featureTipBefore);
      expect(mergeOrRebaseInProgress(repo)).toBe(false);
      expect(g(repo, ["status", "--porcelain"]).trim()).toBe("");
      // The unit branch has NO new commit (tip still equals the base it was branched from).
      const unitWt = defaultUnitWorktreeDir(repo, entry.worktree!);
      expect(revParse(repo, entry.branch!)).toBe(featureTipBefore);
      // The unit worktree is preserved (NOT torn down) and its WIP is intact + still uncommitted.
      expect(fs.existsSync(unitWt)).toBe(true);
      expect(fs.existsSync(path.join(unitWt, "f-unit-001.txt"))).toBe(true);
      expect(g(unitWt, ["status", "--porcelain"]).trim()).toContain("f-unit-001.txt");
    } finally {
      cleanup(repo);
    }
  });

  it("A13: successful merge tears the unit worktree down (git worktree list clean, dir gone)", GIT_IT, async () => {
    const repo = makeRepo();
    const runWts: string[] = [];
    try {
      const res = await runMerge(
        repo,
        [{ id: "unit-001", title: "Unit one", summary: "one" }],
        (u, wt) => fs.writeFileSync(path.join(wt, `f-${u}.txt`), `${u}\n`),
      );
      const entry = res.state.units[0]!;
      runWts.push(path.join(path.dirname(repo), `${path.basename(repo)}-merge-${res.runId}`));
      expect(entry.mergedInto).toBe(conductRunBranch(res.runId));
      const wtDir = defaultUnitWorktreeDir(repo, entry.worktree!);
      expect(fs.existsSync(wtDir)).toBe(false);
      // git no longer lists the unit worktree.
      expect(g(repo, ["worktree", "list", "--porcelain"])).not.toContain(wtDir);
    } finally {
      cleanup(repo, ...runWts);
    }
  });

  it("A7 (reuse validation): a default-start run worktree is reused ONLY when it is this repo's run branch", GIT_IT, async () => {
    const repo = makeRepo();
    const runId = "conduct-reuse-test";
    const branch = conductRunBranch(runId);
    const dir = conductMergeWorktreeDir(repo, runId);
    const cleanupDirs: string[] = [dir];
    try {
      const ctx = await makeCtx(repo); // on the default branch (main)

      // (a) A genuine run-branch worktree of THIS repo → reused, not recreated.
      addNamedWorktree(repo, dir, branch);
      const reused = resolveMergeTarget(ctx, runId, realLandingGit);
      expect(reused.ok).toBe(true);
      if (reused.ok) {
        expect(reused.target.dir).toBe(dir);
        expect(reused.target.branch).toBe(branch);
      }

      // (b) A worktree at the same path but on a DIFFERENT branch → NOT ours, refuse (commit-only).
      const otherId = "conduct-other-test";
      const otherDir = conductMergeWorktreeDir(repo, otherId);
      cleanupDirs.push(otherDir);
      addNamedWorktree(repo, otherDir, "sparra/some-other-branch");
      // Ask resolveMergeTarget for otherId, whose EXPECTED branch is sparra/conduct-other-test, but the
      // worktree at otherDir is checked out on sparra/some-other-branch → mismatch → refuse.
      const wrongBranch = resolveMergeTarget(ctx, otherId, realLandingGit);
      expect(wrongBranch.ok).toBe(false);

      // (c) A plain (non-worktree) directory sitting at the expected path → refuse.
      const plainId = "conduct-plain-test";
      const plainDir = conductMergeWorktreeDir(repo, plainId);
      cleanupDirs.push(plainDir);
      fs.mkdirSync(plainDir, { recursive: true });
      fs.writeFileSync(path.join(plainDir, "junk.txt"), "not a worktree\n");
      const plain = resolveMergeTarget(ctx, plainId, realLandingGit);
      expect(plain.ok).toBe(false);
    } finally {
      cleanup(repo, ...cleanupDirs);
    }
  });
});

/**
 * `conduct --resume` composed with `--commit`/`--merge`, exercised against REAL git in a throwaway
 * repo. A crashed run is simulated by hand-writing `run.json` + the unit brief/contract, then
 * resumed. `agentCommits: template` (via makeCtx) means no committer session ever runs; the worktree
 * reuse/recreate seam is faked so the generator fakeRunner creates the real unit worktree exactly once.
 */

/** Seed a persisted (crashed) conduct run under `<repo>/.sparra/conduct/<runId>/`: run.json + the
 *  unit's brief + an AGREED contract file, so resume re-enters the unit straight at generate. */
function seedResumableRun(
  ctx: Ctx,
  runId: string,
  units: Array<{ id: string; title: string }>,
): string {
  const runDir = conductRunDir(ctx.paths.dir, runId);
  const entries: UnitStateEntry[] = units.map((u) => {
    const unitDir = path.join(runDir, u.id);
    fs.mkdirSync(unitDir, { recursive: true });
    const briefPath = path.join(unitDir, "brief.md");
    fs.writeFileSync(briefPath, `# ${u.title}\n\nbrief for ${u.id}\n`);
    const contractPath = path.join(unitDir, "contract.md");
    fs.writeFileSync(contractPath, "AGREED CONTRACT\n");
    return { id: u.id, title: u.title, outcome: "error", briefPath, contractPath, contractAgreed: true };
  });
  const state: ConductRunState = {
    runId,
    prompt: "resumed prompt",
    status: "running",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    maxUnits: 4,
    concurrency: 2,
    dryRun: false,
    units: entries,
  };
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(runStatePath(runDir), JSON.stringify(state, null, 2));
  return runDir;
}

/** A worktree reuse/recreate seam that DOESN'T touch git — it reports "reused" so the generator
 *  fakeRunner is the one that actually creates the real unit worktree (exactly once). */
const passthroughEnsureWt: NonNullable<ConductDeps["ensureUnitWorktreeFn"]> = (async (
  _ctx: Ctx,
  name: string,
  src: string,
): Promise<EnsureUnitWorktreeResult> => ({
  dir: defaultUnitWorktreeDir(src, name),
  branch: `sparra/${name}`,
  src,
  created: false,
})) as NonNullable<ConductDeps["ensureUnitWorktreeFn"]>;

describe("conduct --resume (real git)", () => {
  it("assertion 11: --commit on resume lands the re-run unit's WIP on its sparra/<name> branch (committedSha == tip); no mergedInto; default untouched", GIT_IT, async () => {
    const repo = makeRepo();
    const wts: string[] = [];
    try {
      const ctx = await makeCtx(repo);
      const mainTipBefore = revParse(repo, "main");
      const runId = "conduct-resume-commit";
      seedResumableRun(ctx, runId, [{ id: "unit-001", title: "Resumed unit" }]);
      const res = await resumeConduct(
        ctx,
        runId,
        { surface: "auto", commit: true },
        {
          runRole: fakeRunner((u, wt) => fs.writeFileSync(path.join(wt, `f-${u}.txt`), `${u}\n`), { score: 90 }),
          ensureUnitWorktreeFn: passthroughEnsureWt,
          brain: null,
          now: () => Date.now(),
          sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 1))),
        },
      );
      expect(res.status).toBe("resumed");
      const entry = (res.status === "resumed" ? res.state : undefined)!.units[0]!;
      expect(entry.outcome).toBe("accepted");
      expect(entry.committedSha).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.mergedInto).toBeUndefined(); // --commit only, never merged
      // committedSha equals the unit branch tip; the WIP file is in the committed tree.
      expect(revParse(repo, entry.branch!)).toBe(entry.committedSha);
      expect(g(repo, ["ls-tree", "-r", "--name-only", entry.branch!])).toContain("f-unit-001.txt");
      // Default branch NEVER touched.
      expect(revParse(repo, "main")).toBe(mainTipBefore);
      wts.push(defaultUnitWorktreeDir(repo, entry.worktree!));
    } finally {
      cleanup(repo, ...wts);
    }
  });

  it("assertion 12 (default branch): --merge on resume records mergedInto=sparra/<runId>; default branch is NEVER the target and its tip is unchanged", GIT_IT, async () => {
    const repo = makeRepo();
    const runWts: string[] = [];
    try {
      const ctx = await makeCtx(repo); // on the default branch (main)
      const mainTipBefore = revParse(repo, "main");
      const runId = "conduct-resume-merge";
      seedResumableRun(ctx, runId, [{ id: "unit-001", title: "Resumed unit" }]);
      runWts.push(path.join(path.dirname(repo), `${path.basename(repo)}-merge-${runId}`));
      const res = await resumeConduct(
        ctx,
        runId,
        { surface: "auto", merge: true },
        {
          runRole: fakeRunner((u, wt) => fs.writeFileSync(path.join(wt, `f-${u}.txt`), `${u}\n`), { score: 90 }),
          ensureUnitWorktreeFn: passthroughEnsureWt,
          brain: null,
          now: () => Date.now(),
          sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 1))),
        },
      );
      expect(res.status).toBe("resumed");
      const entry = (res.status === "resumed" ? res.state : undefined)!.units[0]!;
      const target = conductRunBranch(runId);
      expect(entry.committedSha).toMatch(/^[0-9a-f]{40}$/); // --merge implies commit
      expect(entry.mergedInto).toBe(target);
      // The target is the run branch, NEVER the default branch.
      expect(target).not.toBe("main");
      expect(entry.mergedInto).not.toBe("main");
      // The unit's commit is reachable from the run branch; default branch tip is untouched.
      expect(g(repo, ["ls-tree", "-r", "--name-only", target])).toContain("f-unit-001.txt");
      expect(isAncestor(repo, entry.committedSha!, target)).toBe(true);
      expect(revParse(repo, "main")).toBe(mainTipBefore);
    } finally {
      cleanup(repo, ...runWts);
    }
  });

  it("assertion 12 (feature branch): --merge on resume lands on the current non-default branch; default branch never targeted, tip unchanged", GIT_IT, async () => {
    const repo = makeRepo();
    try {
      g(repo, ["checkout", "-b", "feature"]); // start (and resume) on a non-default branch
      const ctx = await makeCtx(repo);
      const mainTipBefore = revParse(repo, "main");
      const runId = "conduct-resume-merge-feat";
      seedResumableRun(ctx, runId, [{ id: "unit-001", title: "Resumed unit" }]);
      const res = await resumeConduct(
        ctx,
        runId,
        { surface: "auto", merge: true },
        {
          runRole: fakeRunner((u, wt) => fs.writeFileSync(path.join(wt, `f-${u}.txt`), `${u}\n`), { score: 90 }),
          ensureUnitWorktreeFn: passthroughEnsureWt,
          brain: null,
          now: () => Date.now(),
          sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 1))),
        },
      );
      const entry = (res.status === "resumed" ? res.state : undefined)!.units[0]!;
      expect(entry.mergedInto).toBe("feature");
      expect(entry.mergedInto).not.toBe("main");
      expect(g(repo, ["ls-tree", "-r", "--name-only", "feature"])).toContain("f-unit-001.txt");
      // Default branch untouched.
      expect(revParse(repo, "main")).toBe(mainTipBefore);
    } finally {
      cleanup(repo);
    }
  });
});
