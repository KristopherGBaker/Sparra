import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runRole, runRoleInTempWorktree, type RoleRunRequest, type RoleRunResult } from "../src/build/roleRun.ts";
import { isLinkedWorktree, listWorktrees } from "../src/util/git.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

// Item D — `sparra eval --worktree`: the temp WIP-snapshot worktree wrapper. Everything here
// uses a THROWAWAY temp git repo + an injected fake inner runner / session — no live model,
// never a recursive real evaluation, and NEVER a real dep copy (the provisioning seam is always
// a fake — see `fakeProvision`). The remaining cost is genuine git IO (worktree add/remove per
// test), so each describe SHARES one repo fixture (tests in a file run sequentially and every
// test tears its worktree down) and the its carry explicit headroom for full-suite load — the
// timeout guards against hangs, not against real work.

/** Real git worktree ops under parallel-suite load can exceed vitest's 5s default; this is
 *  headroom for spawn contention, NOT a retry — a regression/hang still fails, just at 20s. */
const GIT_IT = { timeout: 20_000 };

function g(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

/** A throwaway git repo with a committed base + a WIP delta on top:
 *  tracked.txt MODIFIED, untracked.txt NEW (non-ignored), ignored.txt NEW (gitignored),
 *  doomed.txt DELETED (a tracked deletion). */
function makeWipRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-evalwt-"));
  g(dir, ["init"]);
  fs.writeFileSync(path.join(dir, "tracked.txt"), "original\n");
  fs.writeFileSync(path.join(dir, "doomed.txt"), "delete me\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n.sparra/\n");
  g(dir, ["add", "-A"]);
  g(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "base"]);
  fs.writeFileSync(path.join(dir, "tracked.txt"), "modified\n");
  fs.writeFileSync(path.join(dir, "untracked.txt"), "new\n");
  fs.writeFileSync(path.join(dir, "ignored.txt"), "must not travel\n");
  fs.rmSync(path.join(dir, "doomed.txt"));
  return dir;
}

async function makeCtx(root: string): Promise<Ctx> {
  const paths = new Paths(root);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  return { root, paths, config: defaultConfig(), store };
}

/** realpath both sides (macOS tmpdir is /var → /private/var) before comparing worktree paths. */
function real(p: string): string {
  return fs.realpathSync(p);
}

/** The dep-provisioning seam, ALWAYS faked in these tests — no real npm-level copy ever runs,
 *  so the suite stays fast and deterministic under full-suite load. */
function fakeProvision() {
  return vi.fn(() => ({ copied: [], skipped: [], failed: [] }));
}

function fakeResult(over: Partial<RoleRunResult> = {}): RoleRunResult {
  return {
    ok: true,
    roleKind: "evaluator",
    backend: "claude",
    model: "m",
    resultText: "done",
    traceDir: "/t",
    sessionId: "s",
    costUsd: 0,
    tokens: 1,
    errors: [],
    ...over,
  };
}

/** What the injected inner runner observes INSIDE the temp worktree, while it exists. */
interface Seen {
  workspace?: string;
  linked?: boolean;
  tracked?: string;
  untracked?: boolean;
  ignored?: boolean;
  doomed?: boolean;
}

function observer(seen: Seen, opts: { throwAfter?: boolean } = {}) {
  return async (r: RoleRunRequest): Promise<RoleRunResult> => {
    seen.workspace = r.workspace;
    seen.linked = isLinkedWorktree(r.workspace!);
    seen.tracked = fs.readFileSync(path.join(r.workspace!, "tracked.txt"), "utf8").trim();
    seen.untracked = fs.existsSync(path.join(r.workspace!, "untracked.txt"));
    seen.ignored = fs.existsSync(path.join(r.workspace!, "ignored.txt"));
    seen.doomed = fs.existsSync(path.join(r.workspace!, "doomed.txt"));
    if (opts.throwAfter) throw new Error("evaluation exploded");
    return fakeResult();
  };
}

describe("runRoleInTempWorktree — WIP-faithful temp worktree (Item D)", () => {
  // ONE shared source repo + ctx for the describe: no test mutates the repo (worktrees are
  // siblings, torn down per test), and tests within a file run sequentially.
  let repo: string;
  let ctxRepo: Ctx;
  beforeAll(async () => {
    repo = makeWipRepo();
    ctxRepo = await makeCtx(repo);
  });
  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("snapshots the SELECTED non-default workspace (not ctx.root), runs the role there, and tears down dir + registration + refs", GIT_IT, async () => {
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-evalwt-root-"));
    const ctx = await makeCtx(otherRoot); // ctx.root is NOT the repo — the workspace must win
    const refsBefore = g(repo, ["for-each-ref"]);
    const seen: Seen = {};
    const res = await runRoleInTempWorktree(
      { ctx, roleKind: "evaluator", workspace: repo, brief: "grade", provisionFn: fakeProvision() },
      { runRoleFn: observer(seen) }
    );
    expect(res.ok).toBe(true);

    // (a)+(c) the role ran in a DIFFERENT dir that was a LINKED worktree of the repo.
    expect(seen.workspace).toBeDefined();
    expect(path.resolve(seen.workspace!)).not.toBe(path.resolve(repo));
    expect(path.resolve(seen.workspace!)).not.toBe(path.resolve(otherRoot));
    expect(seen.linked).toBe(true);

    // (b) WIP-faithful: modified tracked content, untracked non-ignored file, tracked deletion;
    // a gitignored file does NOT travel.
    expect(seen.tracked).toBe("modified");
    expect(seen.untracked).toBe(true);
    expect(seen.doomed).toBe(false);
    expect(seen.ignored).toBe(false);

    // (d) teardown by default: the dir, the worktree registration, and any temp ref are GONE.
    expect(fs.existsSync(seen.workspace!)).toBe(false);
    expect(listWorktrees(repo).map((w) => real(w.path))).toEqual([real(repo)]);
    expect(g(repo, ["for-each-ref"])).toBe(refsBefore);

    // Safety: the REAL tree's WIP is untouched (teardown never clobbers the main tree).
    expect(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8").trim()).toBe("modified");
    expect(fs.existsSync(path.join(repo, "untracked.txt"))).toBe(true);
    expect(fs.existsSync(path.join(repo, "doomed.txt"))).toBe(false);

    fs.rmSync(otherRoot, { recursive: true, force: true });
  });

  it("defaults the source to ctx.root when no workspace is given", GIT_IT, async () => {
    const seen: Seen = {};
    await runRoleInTempWorktree({ ctx: ctxRepo, roleKind: "evaluator", brief: "grade" }, { runRoleFn: observer(seen) });
    expect(path.resolve(seen.workspace!)).not.toBe(path.resolve(repo));
    expect(seen.tracked).toBe("modified"); // still the WIP snapshot, of ctx.root
    expect(fs.existsSync(seen.workspace!)).toBe(false);
  });

  it("--keep-worktree retains the dir and PRINTS its path", GIT_IT, async () => {
    const seen: Seen = {};
    // The logger is silenced under vitest; lift the gate via the documented escape hatch while capturing.
    const priorLogInTests = process.env.SPARRA_LOG_IN_TESTS;
    process.env.SPARRA_LOG_IN_TESTS = "1";
    let buf = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    });
    try {
      await runRoleInTempWorktree({ ctx: ctxRepo, roleKind: "evaluator", brief: "grade", keepWorktree: true }, { runRoleFn: observer(seen) });
    } finally {
      spy.mockRestore();
      if (priorLogInTests === undefined) delete process.env.SPARRA_LOG_IN_TESTS;
      else process.env.SPARRA_LOG_IN_TESTS = priorLogInTests;
    }
    expect(fs.existsSync(seen.workspace!)).toBe(true); // RETAINED
    expect(buf).toContain(seen.workspace!); // path actually printed
    expect(buf).toMatch(/keep-worktree.*retained/i);
    g(repo, ["worktree", "remove", "--force", seen.workspace!]);
  });

  it("teardown still runs when the injected role THROWS", GIT_IT, async () => {
    const seen: Seen = {};
    await expect(
      runRoleInTempWorktree({ ctx: ctxRepo, roleKind: "evaluator", brief: "grade" }, { runRoleFn: observer(seen, { throwAfter: true }) })
    ).rejects.toThrow(/evaluation exploded/);
    expect(seen.workspace).toBeDefined(); // the worktree DID exist during the run…
    expect(fs.existsSync(seen.workspace!)).toBe(false); // …and is gone after the throw
    expect(listWorktrees(repo).map((w) => real(w.path))).toEqual([real(repo)]);
  });

  it("the reviewer (read-only judge) is also supported", GIT_IT, async () => {
    const seen: Seen = {};
    const res = await runRoleInTempWorktree({ ctx: ctxRepo, roleKind: "reviewer", brief: "review" }, { runRoleFn: observer(seen) });
    expect(res.ok).toBe(true);
    expect(seen.linked).toBe(true);
    expect(fs.existsSync(seen.workspace!)).toBe(false);
  });
});

describe("runRole — --worktree dispatch + writer rejection (Item D)", () => {
  const EVAL_JSON =
    '```json\n{"assertions":[{"id":1,"pass":true,"evidence":"ok"}],' +
    '"scores":{"design":90,"originality":80,"craft":90,"functionality":90},"verdict":"pass","blocking":[],"notes":"good"}\n```';

  function recorder(resultText?: string) {
    const calls: RunSessionParams[] = [];
    const fn = async (p: RunSessionParams): Promise<RunResult> => {
      calls.push(p);
      return {
        ok: true,
        subtype: "success",
        resultText: resultText ?? (p.role.includes("evaluator") ? EVAL_JSON : "done"),
        sessionId: "r",
        costUsd: 0,
        tokens: 7,
        numTurns: 1,
        hitMaxTurns: false,
        hitBudget: false,
        errors: [],
        tracePath: "",
      };
    };
    return { calls, fn };
  }

  // Shared source repo + ctx, as above — every test here cleans up its own worktree.
  let repo: string;
  let ctxRepo: Ctx;
  beforeAll(async () => {
    repo = makeWipRepo();
    ctxRepo = await makeCtx(repo);
  });
  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("a WRITER (generator) with useWorktree is REJECTED with a clear message — no session, no worktree", GIT_IT, async () => {
    const rec = recorder();
    await expect(
      runRole({ ctx: ctxRepo, roleKind: "generator", brief: "build", useWorktree: true, runSessionFn: rec.fn })
    ).rejects.toThrow(/--worktree.*(evaluator, reviewer).*sparra build/s);
    expect(rec.calls).toHaveLength(0); // rejected BEFORE any backend call
    expect(listWorktrees(repo).map((w) => real(w.path))).toEqual([real(repo)]); // and no worktree was created
  });

  it("runRole(useWorktree) routes the FULL evaluator path through the worktree: session cwd = worktree, exerciseScratch on, deps provisioned via provisionWorkspaceDeps", GIT_IT, async () => {
    const rec = recorder();
    const provisionFn = fakeProvision();
    const res = await runRole({
      ctx: ctxRepo,
      roleKind: "evaluator",
      brief: "grade",
      useWorktree: true,
      runSessionFn: rec.fn,
      provisionFn,
    });
    expect(res.ok).toBe(true);
    const call = rec.calls[0]!;
    // The evaluator ran IN the temp worktree (not the repo), which flips the linked-worktree paths:
    expect(path.resolve(call.cwd!)).not.toBe(path.resolve(repo));
    expect(call.readOnly).toBe(true);
    expect(call.exerciseScratch).toBe(true); // exerciseScratchEnabled via the linked-worktree branch
    // Dep provisioning reused the EXISTING provisionWorkspaceDeps seam, source → worktree:
    expect(provisionFn).toHaveBeenCalledWith(repo, call.cwd, ctxRepo.config.git.provisionDeps);
    // And the worktree is gone afterwards.
    expect(fs.existsSync(call.cwd!)).toBe(false);
  });

  it("provisions deps FROM the SELECTED non-default workspace — never ctx.root, which is a different project (fake provisionFn; no real copy)", GIT_IT, async () => {
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-evalwt-root-"));
    const ctx = await makeCtx(otherRoot); // ctx.root ≠ the graded project: the dep SOURCE must be `repo`
    const rec = recorder();
    const provisionFn = fakeProvision();
    const res = await runRole({
      ctx,
      roleKind: "evaluator",
      workspace: repo,
      brief: "grade",
      useWorktree: true,
      runSessionFn: rec.fn,
      provisionFn,
    });
    expect(res.ok).toBe(true);
    const call = rec.calls[0]!;
    expect(provisionFn).toHaveBeenCalledTimes(1);
    const [src, dst, cfg] = provisionFn.mock.calls[0]! as unknown as [string, string, unknown];
    expect(src).toBe(repo); // deps come from the dir the worktree was snapshotted from…
    expect(src).not.toBe(otherRoot); // …NOT from ctx.root (a DIFFERENT project's node_modules)
    expect(dst).toBe(call.cwd); // …into the temp worktree the evaluator runs in
    expect(cfg).toBe(ctx.config.git.provisionDeps);
    fs.rmSync(otherRoot, { recursive: true, force: true });
  });

  it("in-place runRole WITHOUT useWorktree is unchanged: cwd = workspace, no scratch, no provisioning", GIT_IT, async () => {
    const rec = recorder();
    const provisionFn = fakeProvision();
    await runRole({ ctx: ctxRepo, roleKind: "evaluator", brief: "grade", runSessionFn: rec.fn, provisionFn });
    const call = rec.calls[0]!;
    expect(path.resolve(call.cwd!)).toBe(path.resolve(repo)); // ran IN PLACE
    expect(call.exerciseScratch).toBeFalsy(); // no isolated checkout → no scratch (today's behavior)
    expect(provisionFn).not.toHaveBeenCalled();
  });
});
