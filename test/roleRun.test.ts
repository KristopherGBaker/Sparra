import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runRole, makeHoldoutReadDecider, type RoleKind } from "../src/build/roleRun.ts";
import type { Exerciser } from "../src/sdk/exercise.ts";
import type { IntegrityDeps } from "../src/build/integrity.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

const HOLDOUT_LINE = "The export must produce a byte-identical copy of the original file.";

async function makeCtx(withHoldout = true): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-rolerun-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  const config = defaultConfig();
  const ctx: Ctx = { root: dir, paths, config, store };
  if (withHoldout) fs.writeFileSync(paths.holdout, `# Holdout\n\n- ${HOLDOUT_LINE}\n`);
  return { ctx, dir };
}

const EVAL_JSON =
  '```json\n{"assertions":[{"id":1,"pass":true,"evidence":"ok"}],' +
  '"scores":{"design":90,"originality":80,"craft":90,"functionality":90},"verdict":"pass","blocking":[],"notes":"good"}\n```';

/** A fake session that records every request and returns role-appropriate output. */
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

const FORBID: RoleKind[] = ["generator", "contract-generator", "contract-evaluator", "reviewer"];

describe("runRole — holdout wall", () => {
  it.each(FORBID)("%s: a brief leaking the holdout throws BEFORE any backend call, sanitized", async (kind) => {
    const { ctx, dir } = await makeCtx();
    const rec = recorder();
    await expect(
      runRole({ ctx, roleKind: kind, brief: `Do the thing. ${HOLDOUT_LINE}`, runSessionFn: rec.fn })
    ).rejects.toThrow(/holdout/i);
    // It must reject WITHOUT calling the backend, and WITHOUT echoing the holdout text.
    expect(rec.calls).toHaveLength(0);
    try {
      await runRole({ ctx, roleKind: kind, brief: `Do the thing. ${HOLDOUT_LINE}`, runSessionFn: rec.fn });
    } catch (e) {
      expect((e as Error).message).not.toContain("byte-identical");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("evaluator injects the holdout into its prompt; a forbid role never sees it", async () => {
    const { ctx, dir } = await makeCtx();
    const evalRec = recorder();
    await runRole({ ctx, roleKind: "evaluator", brief: "Grade the artifact.", runSessionFn: evalRec.fn });
    expect(evalRec.calls[0]!.prompt).toContain(HOLDOUT_LINE);

    const genRec = recorder();
    await runRole({ ctx, roleKind: "generator", brief: "Build the artifact.", runSessionFn: genRec.fn });
    expect(genRec.calls[0]!.prompt).not.toContain(HOLDOUT_LINE);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an explicit but missing holdout path fails closed (throws)", async () => {
    const { ctx, dir } = await makeCtx(false);
    const rec = recorder();
    await expect(
      runRole({ ctx, roleKind: "evaluator", brief: "Grade it.", holdoutPath: path.join(dir, "nope.md"), runSessionFn: rec.fn })
    ).rejects.toThrow(/holdout path not found/i);
    expect(rec.calls).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("runRole — safety intent + wiring", () => {
  it("generator gets writeScope (not readOnly); other roles get readOnly", async () => {
    const { ctx, dir } = await makeCtx();
    const gen = recorder();
    await runRole({ ctx, roleKind: "generator", brief: "Build.", runSessionFn: gen.fn });
    expect(gen.calls[0]!.writeScope).toEqual([dir]);
    expect(gen.calls[0]!.readOnly).toBeFalsy();

    for (const kind of ["evaluator", "contract-generator", "reviewer"] as RoleKind[]) {
      const rec = recorder();
      await runRole({ ctx, roleKind: kind, brief: "x", runSessionFn: rec.fn });
      expect(rec.calls[0]!.readOnly).toBe(true);
      expect(rec.calls[0]!.writeScope).toBeUndefined();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the exerciser (MCP run_command) is wired ONLY for the evaluator", async () => {
    const { ctx, dir } = await makeCtx();
    const ev = recorder();
    await runRole({ ctx, roleKind: "evaluator", brief: "grade", runSessionFn: ev.fn });
    expect(ev.calls[0]!.allowedTools).toContain("mcp__exercise__run_command");
    expect(ev.calls[0]!.mcpServers).toBeDefined();

    const gen = recorder();
    await runRole({ ctx, roleKind: "generator", brief: "build", runSessionFn: gen.fn });
    expect(gen.calls[0]!.mcpServers).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("forbid-role requests carry a PreToolUse hook (holdout-read deny)", async () => {
    const { ctx, dir } = await makeCtx();
    const gen = recorder();
    await runRole({ ctx, roleKind: "generator", brief: "build", runSessionFn: gen.fn });
    expect(gen.calls[0]!.hooks?.PreToolUse?.length).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a forbid role on a separate worktree does NOT get .sparra/ in its read scope; the evaluator does", async () => {
    const { ctx, dir } = await makeCtx();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-rolerun-wt-"));

    const gen = recorder();
    await runRole({ ctx, roleKind: "generator", brief: "build", workspace, runSessionFn: gen.fn });
    const genDirs = gen.calls[0]!.additionalDirectories ?? [];
    // ctx.root (which contains .sparra) is dropped — no granted dir contains the holdout machinery.
    expect(genDirs).not.toContain(dir);
    expect(genDirs.some((d) => d.includes(".sparra"))).toBe(false);

    const ev = recorder();
    await runRole({ ctx, roleKind: "evaluator", brief: "grade", workspace, runSessionFn: ev.fn });
    // The evaluator keeps the full scope (it may see the holdout).
    expect(ev.calls[0]!.additionalDirectories).toContain(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("warns when a forbid Codex role runs in-place with a reachable holdout (no hard refusal)", async () => {
    const { ctx, dir } = await makeCtx(); // holdout present; in-place (workspace defaults to ctx.root)
    let buf = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    });
    try {
      const gen = recorder();
      const r = await runRole({ ctx, roleKind: "generator", brief: "build", backend: "codex", runSessionFn: gen.fn });
      expect(r.ok).toBe(true); // not blocked — the run proceeds
      expect(gen.calls).toHaveLength(1);
      expect(buf).toMatch(/holdout is reachable/i);

      // The same in-place forbid role on Claude does NOT warn (the deny-hook covers it).
      buf = "";
      await runRole({ ctx, roleKind: "generator", brief: "build", backend: "claude", runSessionFn: recorder().fn });
      expect(buf).not.toMatch(/holdout is reachable/i);
    } finally {
      spy.mockRestore();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the evaluator runs with a default brief (standalone WIP eval), but other roles require one", async () => {
    const { ctx, dir } = await makeCtx();
    const ev = recorder();
    await runRole({ ctx, roleKind: "evaluator", runSessionFn: ev.fn }); // no brief
    expect(ev.calls[0]!.prompt).toContain("Evaluate the artifact in");
    await expect(runRole({ ctx, roleKind: "generator", runSessionFn: recorder().fn })).rejects.toThrow(/brief/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the backend is overridable (cross-model: e.g. a Codex evaluator)", async () => {
    const { ctx, dir } = await makeCtx();
    const rec = recorder();
    const r = await runRole({ ctx, roleKind: "evaluator", brief: "grade", backend: "codex", runSessionFn: rec.fn });
    expect(rec.calls[0]!.backend).toBe("codex");
    expect(r.backend).toBe("codex");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("maxBudgetUsd override reaches the session request; 0 survives; omission falls back to config", async () => {
    const { ctx, dir } = await makeCtx();

    // (a) a supplied override (25) reaches the session's per-call budget verbatim.
    const supplied = recorder();
    await runRole({ ctx, roleKind: "generator", brief: "build", maxBudgetUsd: 25, runSessionFn: supplied.fn });
    expect(supplied.calls[0]!.maxBudgetUsd).toBe(25);

    // (b) 0 is preserved (unlimited per budget.ts) — nullish-coalescing, NOT a truthy `||` that drops it.
    const zero = recorder();
    await runRole({ ctx, roleKind: "generator", brief: "build", maxBudgetUsd: 0, runSessionFn: zero.fn });
    expect(zero.calls[0]!.maxBudgetUsd).toBe(0);

    // (c) omission falls back to build.maxBudgetUsdPerItem — asserted by VARYING the config value
    //     (not matching a hardcoded constant), so the fallback is genuinely the config seam.
    ctx.config.build.maxBudgetUsdPerItem = 13.5;
    const omitted = recorder();
    await runRole({ ctx, roleKind: "generator", brief: "build", runSessionFn: omitted.fn });
    expect(omitted.calls[0]!.maxBudgetUsd).toBe(13.5);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/** A no-op IntegrityDeps that reports a clean exercise (no artifact mutation). */
const cleanIntegrityDeps: IntegrityDeps = {
  listArtifactFiles: () => [],
  readFile: () => null,
  writeFile: () => {},
  removeFile: () => {},
};

/** An IntegrityDeps that simulates the evaluator mutating one tracked file during the exercise:
 *  snapshot reads "before"; the post-exercise read returns "after" (≠ before) → reverted + reported. */
function mutatingIntegrityDeps(rel: string): IntegrityDeps {
  let reads = 0;
  return {
    listArtifactFiles: () => [rel],
    readFile: () => Buffer.from(reads++ === 0 ? "before" : "after"),
    writeFile: () => {},
    removeFile: () => {},
  };
}

describe("runRole — exercising evaluator scratch + integrity guard", () => {
  it("an evaluator on a branch boundary with exercise.sandbox=workspace-write carries exerciseScratch", async () => {
    const { ctx, dir } = await makeCtx();
    ctx.store.data.build.branch = "sparra/x"; // worktree/branch boundary
    ctx.config.exercise.sandbox = "workspace-write";
    const ev = recorder();
    await runRole({ ctx, roleKind: "evaluator", brief: "grade", runSessionFn: ev.fn, integrityDeps: cleanIntegrityDeps });
    expect(ev.calls[0]!.exerciseScratch).toBe(true);
    expect(ev.calls[0]!.readOnly).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT carry exerciseScratch with no branch boundary, or when sandbox=read-only, or for non-evaluators", async () => {
    const { ctx, dir } = await makeCtx();
    ctx.config.exercise.sandbox = "workspace-write";

    // No branch boundary → no scratch.
    const a = recorder();
    await runRole({ ctx, roleKind: "evaluator", brief: "grade", runSessionFn: a.fn, integrityDeps: cleanIntegrityDeps });
    expect(a.calls[0]!.exerciseScratch).toBeUndefined();

    // Branch boundary but sandbox forced read-only → no scratch.
    ctx.store.data.build.branch = "sparra/x";
    ctx.config.exercise.sandbox = "read-only";
    const b = recorder();
    await runRole({ ctx, roleKind: "evaluator", brief: "grade", runSessionFn: b.fn, integrityDeps: cleanIntegrityDeps });
    expect(b.calls[0]!.exerciseScratch).toBeUndefined();

    // A non-evaluator read-only role never gets scratch, even on the boundary with workspace-write.
    ctx.config.exercise.sandbox = "workspace-write";
    const c = recorder();
    await runRole({ ctx, roleKind: "reviewer", brief: "review", runSessionFn: c.fn, integrityDeps: cleanIntegrityDeps });
    expect(c.calls[0]!.exerciseScratch).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an integrity violation (evaluator wrote a file) FORCES the verdict to fail with a blocking line", async () => {
    const { ctx, dir } = await makeCtx();
    ctx.store.data.build.branch = "sparra/x";
    ctx.config.exercise.sandbox = "workspace-write";
    const ev = recorder(); // returns a PASSING verdict (EVAL_JSON)
    const r = await runRole({
      ctx,
      roleKind: "evaluator",
      brief: "grade",
      runSessionFn: ev.fn,
      integrityDeps: mutatingIntegrityDeps("src/App.ts"),
    });
    expect(r.verdict?.verdict).toBe("fail");
    expect(r.ok).toBe(false);
    expect(r.verdict?.blocking[0]).toMatch(/Integrity violation/);
    expect(r.verdict?.blocking[0]).toContain("src/App.ts");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a blocked exercise can NEVER pass via parseVerdict, even if the model claims pass + high score", async () => {
    const { ctx, dir } = await makeCtx();
    const blockedButPass =
      '```json\n{"assertions":[],"scores":{"design":95,"originality":95,"craft":95,"functionality":95},' +
      '"weightedTotal":95,"verdict":"pass","exerciseStatus":"blocked","blocking":["never ran"],"notes":"n"}\n```';
    const ev = recorder(blockedButPass);
    const r = await runRole({ ctx, roleKind: "evaluator", brief: "grade", runSessionFn: ev.fn, integrityDeps: cleanIntegrityDeps });
    expect(r.verdict?.exerciseStatus).toBe("blocked");
    expect(r.verdict?.verdict).toBe("fail"); // inconclusive → never accepted
    expect(r.ok).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/** A REAL offline git repo (main worktree) plus a linked worktree of it. Local `git` only — no
 *  network/model. Returns both dirs so a test can target either as the eval workspace. */
function makeRepoWithWorktree(): { repo: string; worktree: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-rr-repo-"));
  const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "Test");
  g("commit", "--allow-empty", "-q", "-m", "init");
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-rr-wt-"));
  fs.rmSync(worktree, { recursive: true, force: true }); // git worktree add wants a non-existent dir
  g("worktree", "add", "--detach", "-q", worktree, "HEAD");
  return { repo, worktree };
}

describe("runRole — exerciseScratch on a REAL linked worktree (Item E)", () => {
  it("grants exerciseScratch on a linked worktree even with state.build.branch UNSET (anti-no-op)", async () => {
    const { ctx, dir } = await makeCtx();
    const { repo, worktree } = makeRepoWithWorktree();
    ctx.config.exercise.sandbox = "workspace-write";
    expect(ctx.store.data.build.branch).toBeFalsy(); // no branch — the new path is the only reason
    const ev = recorder();
    await runRole({ ctx, roleKind: "evaluator", brief: "grade", workspace: worktree, runSessionFn: ev.fn, integrityDeps: cleanIntegrityDeps });
    // A no-op wiring (passing isWorktree:false / the old inline `&& !!build.branch`) FAILS this.
    expect(ev.calls[0]!.exerciseScratch).toBe(true);
    expect(ev.calls[0]!.readOnly).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("WALL: a REAL main worktree with no branch gets NO exerciseScratch", async () => {
    const { ctx, dir } = await makeCtx();
    const { repo, worktree } = makeRepoWithWorktree();
    ctx.config.exercise.sandbox = "workspace-write";
    const ev = recorder();
    await runRole({ ctx, roleKind: "evaluator", brief: "grade", workspace: repo, runSessionFn: ev.fn, integrityDeps: cleanIntegrityDeps });
    expect(ev.calls[0]!.exerciseScratch).toBeUndefined(); // main worktree ⇒ isLinkedWorktree false
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("the integrity guard ARMS on the worktree-no-branch path (artifact write reverted + reported)", async () => {
    const { ctx, dir } = await makeCtx();
    const { repo, worktree } = makeRepoWithWorktree();
    ctx.config.exercise.sandbox = "workspace-write";
    const ev = recorder(); // model returns a PASSING verdict…
    const r = await runRole({
      ctx,
      roleKind: "evaluator",
      brief: "grade",
      workspace: worktree,
      runSessionFn: ev.fn,
      integrityDeps: mutatingIntegrityDeps("src/App.ts"), // …but the guard saw a mutation
    });
    // Snapshot was gated on exerciseScratch, so the guard only arms because scratch was granted.
    expect(r.verdict?.verdict).toBe("fail");
    expect(r.verdict?.blocking[0]).toMatch(/Integrity violation/);
    expect(r.verdict?.blocking[0]).toContain("src/App.ts");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

/** A provisionWorkspaceDeps spy: records each call, performs no real copy. */
function provisionSpy() {
  const calls: Array<{ root: string; workspace: string; cfg: { enabled: boolean; dirs: string[] } }> = [];
  const fn = ((root: string, workspace: string, cfg: { enabled: boolean; dirs: string[] }) => {
    calls.push({ root, workspace, cfg });
    return { copied: [], skipped: [], failed: [] };
  }) as unknown as typeof import("../src/util/provision.ts").provisionWorkspaceDeps;
  return { calls, fn };
}

describe("runRole — dep provisioning into a linked worktree (Item D on the eval path)", () => {
  it("provisions node_modules into a REAL linked-worktree workspace (root → worktree, cfg passed)", async () => {
    const { ctx, dir } = await makeCtx();
    const { repo, worktree } = makeRepoWithWorktree();
    const spy = provisionSpy();
    await runRole({ ctx, roleKind: "evaluator", brief: "grade", workspace: worktree, runSessionFn: recorder().fn, provisionFn: spy.fn });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.root).toBe(ctx.root);
    expect(spy.calls[0]!.workspace).toBe(worktree);
    expect(spy.calls[0]!.cfg).toEqual(ctx.config.git.provisionDeps);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("provisions for a GENERATOR on a worktree too (its verify commands need deps)", async () => {
    const { ctx, dir } = await makeCtx(false);
    const { repo, worktree } = makeRepoWithWorktree();
    const spy = provisionSpy();
    await runRole({ ctx, roleKind: "generator", brief: "build", workspace: worktree, runSessionFn: recorder().fn, provisionFn: spy.fn });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.workspace).toBe(worktree);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("does NOT provision for an in-place run (workspace === ctx.root — git is never spawned)", async () => {
    const { ctx, dir } = await makeCtx();
    const spy = provisionSpy();
    await runRole({ ctx, roleKind: "evaluator", brief: "grade", runSessionFn: recorder().fn, provisionFn: spy.fn });
    expect(spy.calls).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT provision when the workspace is a MAIN worktree (not a linked checkout)", async () => {
    const { ctx, dir } = await makeCtx();
    const { repo, worktree } = makeRepoWithWorktree();
    const spy = provisionSpy();
    await runRole({ ctx, roleKind: "evaluator", brief: "grade", workspace: repo, runSessionFn: recorder().fn, provisionFn: spy.fn });
    expect(spy.calls).toHaveLength(0); // main worktree ⇒ isLinkedWorktree false ⇒ no provisioning
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("respects config: provisionDeps.enabled=false ⇒ no provisioning even on a linked worktree", async () => {
    const { ctx, dir } = await makeCtx();
    ctx.config.git.provisionDeps.enabled = false;
    const { repo, worktree } = makeRepoWithWorktree();
    const spy = provisionSpy();
    await runRole({ ctx, roleKind: "evaluator", brief: "grade", workspace: worktree, runSessionFn: recorder().fn, provisionFn: spy.fn });
    expect(spy.calls).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("provisioning composes with Item E: the same worktree eval ALSO gets exerciseScratch", async () => {
    const { ctx, dir } = await makeCtx();
    const { repo, worktree } = makeRepoWithWorktree();
    ctx.config.exercise.sandbox = "workspace-write";
    const spy = provisionSpy();
    const ev = recorder();
    await runRole({ ctx, roleKind: "evaluator", brief: "grade", workspace: worktree, runSessionFn: ev.fn, provisionFn: spy.fn, integrityDeps: cleanIntegrityDeps });
    expect(spy.calls).toHaveLength(1); // deps provisioned…
    expect(ev.calls[0]!.exerciseScratch).toBe(true); // …and scratch granted, both off the one worktree probe
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

describe("runRole — holdout never reaches the conductor", () => {
  it("redacts holdout the evaluator quoted from the verdict + the --out file", async () => {
    const { ctx, dir } = await makeCtx();
    const out = path.join(dir, "v.md");
    const leaky =
      '```json\n{"assertions":[{"id":1,"pass":false,"evidence":"failed: ' +
      HOLDOUT_LINE +
      '"}],"scores":{"design":90,"originality":90,"craft":90,"functionality":90},' +
      '"verdict":"fail","blocking":["' +
      HOLDOUT_LINE +
      '"],"notes":"see ' +
      HOLDOUT_LINE +
      '"}\n```';
    const r = await runRole({ ctx, roleKind: "evaluator", brief: "grade", out, runSessionFn: recorder(leaky).fn });
    const blob = JSON.stringify(r.verdict);
    expect(blob).not.toContain("byte-identical");
    expect(blob).toContain("[redacted: holdout]");
    expect(fs.readFileSync(out, "utf8")).not.toContain("byte-identical");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("strips extra/unknown assertion fields (no smuggled holdout via stray props)", async () => {
    const { ctx, dir } = await makeCtx();
    const smuggle =
      '```json\n{"assertions":[{"id":1,"pass":true,"evidence":"ok","holdoutQuote":"' +
      HOLDOUT_LINE +
      '"}],"scores":{"design":90,"originality":90,"craft":90,"functionality":90},"verdict":"pass","blocking":[],"notes":"n"}\n```';
    const r = await runRole({ ctx, roleKind: "evaluator", brief: "grade", runSessionFn: recorder(smuggle).fn });
    expect(JSON.stringify(r.verdict)).not.toContain("byte-identical");
    expect(JSON.stringify(r.verdict)).not.toContain("holdoutQuote");
    expect(Object.keys(r.verdict!.assertions[0]!).sort()).toEqual(["evidence", "id", "pass"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the holdout-read decider blocks holdout/.sparra access (file, dir, relative, bash)", async () => {
    const { ctx, dir } = await makeCtx();
    const deny = makeHoldoutReadDecider(ctx, dir);
    expect(deny("Read", { file_path: ctx.paths.holdout })).toBeTruthy();
    expect(deny("Read", { file_path: ctx.paths.frozenHoldout })).toBeTruthy();
    expect(deny("Grep", { path: ctx.paths.dir })).toBeTruthy();
    expect(deny("Read", { file_path: ".sparra/frozen/HOLDOUT.frozen.md" })).toBeTruthy(); // relative → resolved
    expect(deny("Bash", { command: "cat .sparra/frozen/HOLDOUT.frozen.md" })).toBeTruthy();
    expect(deny("Bash", { command: "rg foo .sparra" })).toBeTruthy();
    expect(deny("Read", { file_path: path.join(dir, "src/App.ts") })).toBeNull(); // normal read allowed
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("blocks PATHLESS and ancestor Glob/Grep over a holdout-bearing cwd (cwd=root roles)", async () => {
    const { ctx, dir } = await makeCtx();
    const deny = makeHoldoutReadDecider(ctx, dir); // workspace = repo root, which holds .sparra/HOLDOUT.md
    // Pathless search → searches the cwd (the holdout-bearing root) → its content reaches the holdout.
    expect(deny("Grep", { pattern: "byte-identical" })).toBeTruthy();
    expect(deny("Glob", { pattern: "**/*.md" })).toBeTruthy();
    // Explicit search root that IS / CONTAINS the holdout scope.
    expect(deny("Grep", { path: ".", pattern: "x" })).toBeTruthy(); // "." → root, contains .sparra
    expect(deny("Glob", { pattern: ".sparra/**" })).toBeTruthy();
    expect(deny("Glob", { pattern: "**/HOLDOUT.md" })).toBeTruthy(); // pattern names the holdout
    // A search rooted at a NON-holdout subdir is fine.
    expect(deny("Grep", { path: "src", pattern: "x" })).toBeNull();
    expect(deny("Glob", { path: "src", pattern: "*.ts" })).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the holdout Bash deny resists glob/case evasion (a forbid role keeps Bash)", async () => {
    const { ctx, dir } = await makeCtx();
    const deny = makeHoldoutReadDecider(ctx, dir);
    // Shell-glob expansion that never spells out ".sparra"/"HOLDOUT" literally (the evasion an
    // adversarial evaluator found): a dot-prefixed glob can expand into the hidden .sparra dir.
    expect(deny("Bash", { command: "cat .[a-z]*/H*" })).toBeTruthy();
    expect(deny("Bash", { command: "cat .s*/*OUT*" })).toBeTruthy();
    expect(deny("Bash", { command: "cd .sp* && cat *.md" })).toBeTruthy();
    expect(deny("Bash", { command: "cat .*/HOLD*" })).toBeTruthy();
    expect(deny("Bash", { command: "head -5 holdout.md" })).toBeTruthy(); // case-insensitive
    // Ordinary verify/build commands (no hidden-glob, no holdout/.sparra token) still pass through.
    expect(deny("Bash", { command: "npm test" })).toBeNull();
    expect(deny("Bash", { command: "ls src/*.ts" })).toBeNull();
    expect(deny("Bash", { command: "git diff --stat" })).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("repeated role runs get distinct trace dirs (no overwrite)", async () => {
    const { ctx, dir } = await makeCtx();
    const rec = recorder();
    await runRole({ ctx, roleKind: "generator", brief: "a", runSessionFn: rec.fn });
    await runRole({ ctx, roleKind: "generator", brief: "b", runSessionFn: rec.fn });
    expect(rec.calls[0]!.traceDir).not.toBe(rec.calls[1]!.traceDir);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("runRole — verdict", () => {
  it("parses, clamps, and recomputes the evaluator verdict; writes it to --out", async () => {
    const { ctx, dir } = await makeCtx();
    const out = path.join(dir, "verdict.md");
    const r = await runRole({ ctx, roleKind: "evaluator", brief: "grade", out, runSessionFn: recorder().fn });
    expect(r.verdict?.verdict).toBe("pass");
    expect(r.verdict?.weightedTotal).toBeGreaterThanOrEqual(75);
    expect(fs.existsSync(out)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails when the model says pass but scores are below threshold", async () => {
    const { ctx, dir } = await makeCtx();
    const low =
      '```json\n{"assertions":[],"scores":{"design":10,"originality":10,"craft":10,"functionality":10},"verdict":"pass","blocking":[],"notes":"n"}\n```';
    const r = await runRole({ ctx, roleKind: "evaluator", brief: "grade", runSessionFn: recorder(low).fn });
    expect(r.verdict?.verdict).toBe("fail");
    expect(r.ok).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("treats unparseable evaluator output as a failing verdict", async () => {
    const { ctx, dir } = await makeCtx();
    const r = await runRole({ ctx, roleKind: "evaluator", brief: "grade", runSessionFn: recorder("no json here").fn });
    expect(r.verdict?.verdict).toBe("fail");
    expect(r.verdict?.blocking.length).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("runRole — harness exerciseStatus override (Item F)", () => {
  const stubExerciser = (status: "blocked" | "ran" | "none"): Exerciser => ({
    mcpServers: {},
    allowedTools: ["mcp__exercise__run_command"],
    guidance: "",
    exerciseStatus: () => status,
  });

  it("harness 'blocked' overrides a model {pass, ran} — final blocked, never a pass", async () => {
    const { ctx, dir } = await makeCtx();
    const r = await runRole({
      ctx,
      roleKind: "evaluator",
      brief: "grade",
      runSessionFn: recorder(EVAL_JSON).fn, // model: pass, exerciseStatus absent (ran)
      buildExerciserFn: () => stubExerciser("blocked"),
    });
    expect(r.verdict?.exerciseStatus).toBe("blocked");
    expect(r.verdict?.verdict).toBe("fail");
    expect(r.ok).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("harness 'ran' overrides a model that self-reported blocked", async () => {
    const { ctx, dir } = await makeCtx();
    const blocked =
      '```json\n{"assertions":[],"scores":{"design":90,"originality":90,"craft":90,"functionality":90},' +
      '"verdict":"fail","exerciseStatus":"blocked","blocking":["claimed EPERM"],"notes":"n"}\n```';
    const r = await runRole({
      ctx,
      roleKind: "evaluator",
      brief: "grade",
      runSessionFn: recorder(blocked).fn,
      buildExerciserFn: () => stubExerciser("ran"),
    });
    expect(r.verdict?.exerciseStatus).toBe("ran");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("harness 'none' falls back to the model's self-report", async () => {
    const { ctx, dir } = await makeCtx();
    const blocked =
      '```json\n{"assertions":[],"scores":{"design":90,"originality":90,"craft":90,"functionality":90},' +
      '"verdict":"fail","exerciseStatus":"blocked","blocking":["EPERM"],"notes":"n"}\n```';
    const r = await runRole({
      ctx,
      roleKind: "evaluator",
      brief: "grade",
      runSessionFn: recorder(blocked).fn,
      buildExerciserFn: () => stubExerciser("none"),
    });
    expect(r.verdict?.exerciseStatus).toBe("blocked"); // model's value survives
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("no-parseable-verdict + harness 'blocked' ⇒ verdict carries blocked (not the hardcoded 'ran')", async () => {
    const { ctx, dir } = await makeCtx();
    const r = await runRole({
      ctx,
      roleKind: "evaluator",
      brief: "grade",
      runSessionFn: recorder("no json here").fn,
      buildExerciserFn: () => stubExerciser("blocked"),
    });
    expect(r.verdict?.exerciseStatus).toBe("blocked");
    expect(r.verdict?.verdict).toBe("fail");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("runRole — session resume (run_role iterate)", () => {
  it("passes resumeSessionId to the session when no resumeBackend is given", async () => {
    const { ctx, dir } = await makeCtx(false);
    const rec = recorder();
    await runRole({ ctx, roleKind: "generator", brief: "build", runSessionFn: rec.fn, resumeSessionId: "sess-1" });
    expect(rec.calls[0]!.resume).toBe("sess-1");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resumes when resumeBackend matches the effective backend (claude default)", async () => {
    const { ctx, dir } = await makeCtx(false);
    const rec = recorder();
    await runRole({ ctx, roleKind: "generator", brief: "build", runSessionFn: rec.fn, resumeSessionId: "sess-1", resumeBackend: "claude" });
    expect(rec.calls[0]!.resume).toBe("sess-1");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("IGNORES the resume (fresh) when resumeBackend differs — session ids aren't portable", async () => {
    const { ctx, dir } = await makeCtx(false);
    const rec = recorder();
    await runRole({ ctx, roleKind: "generator", brief: "build", runSessionFn: rec.fn, resumeSessionId: "sess-1", resumeBackend: "codex" });
    expect(rec.calls[0]!.resume).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("no resumeSessionId → no resume", async () => {
    const { ctx, dir } = await makeCtx(false);
    const rec = recorder();
    await runRole({ ctx, roleKind: "generator", brief: "build", runSessionFn: rec.fn });
    expect(rec.calls[0]!.resume).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/** A fake session that returns a provider-limit result for any call on a backend in `limited`,
 *  and a normal success otherwise (mirroring what the Codex backend now produces for an empty
 *  completion). */
function limiter(limited: Set<string>) {
  const calls: RunSessionParams[] = [];
  const fn = async (p: RunSessionParams): Promise<RunResult> => {
    calls.push(p);
    const be = p.backend ?? "claude";
    const isLimited = limited.has(be);
    return {
      ok: !isLimited,
      subtype: isLimited ? "error" : "success",
      resultText: isLimited ? "" : p.role.includes("evaluator") ? EVAL_JSON : "done",
      sessionId: "r",
      costUsd: 0,
      tokens: isLimited ? 0 : 7,
      numTurns: 1,
      hitMaxTurns: false,
      hitBudget: false,
      limitHit: isLimited ? { kind: "usage", raw: "limited" } : undefined,
      errors: isLimited ? ["limited"] : [],
      tracePath: "",
    };
  };
  return { calls, fn };
}

describe("runRole — effort override", () => {
  it("passes a per-call effort override through to the session request (overriding the role's config)", async () => {
    const { ctx, dir } = await makeCtx(false);
    ctx.config.roles.evaluator = { backend: "claude", model: "opus", effort: "high" };
    const rec = limiter(new Set());
    await runRole({ ctx, roleKind: "evaluator", brief: "grade", effort: "xhigh", runSessionFn: rec.fn });
    expect(rec.calls[0]!.effort).toBe("xhigh"); // override wins over the role's "high"
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("uses the role's config effort when no override is given", async () => {
    const { ctx, dir } = await makeCtx(false);
    ctx.config.roles.evaluator = { backend: "claude", model: "opus", effort: "high" };
    const rec = limiter(new Set());
    await runRole({ ctx, roleKind: "evaluator", brief: "grade", runSessionFn: rec.fn });
    expect(rec.calls[0]!.effort).toBe("high");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("runRole — auto-fallback on a provider limit", () => {
  it("falls back to a different-backend fallback when the primary is limited", async () => {
    const { ctx, dir } = await makeCtx(false);
    ctx.config.roles.evaluator = { backend: "codex", model: "gpt", fallback: { backend: "claude", model: "opus" } };
    const rec = limiter(new Set(["codex"]));
    const r = await runRole({ ctx, roleKind: "evaluator", brief: "grade", runSessionFn: rec.fn });
    expect(rec.calls.map((c) => c.backend)).toEqual(["codex", "claude"]); // tried primary, then fallback
    expect(r.backend).toBe("claude"); // result reflects the backend that actually ran
    expect(r.limitHit).toBeUndefined(); // resolved by the fallback
    expect(r.verdict?.verdict).toBe("pass");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("surfaces limitHit (not a real fail) when the whole chain is limited", async () => {
    const { ctx, dir } = await makeCtx(false);
    ctx.config.roles.evaluator = { backend: "codex", model: "gpt", fallback: { backend: "claude", model: "opus" } };
    const rec = limiter(new Set(["codex", "claude"]));
    const r = await runRole({ ctx, roleKind: "evaluator", brief: "grade", runSessionFn: rec.fn });
    expect(rec.calls.length).toBe(2); // tried both
    expect(r.limitHit).toBeDefined();
    expect(r.ok).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips a fallback that is on the SAME (already-limited) backend", async () => {
    const { ctx, dir } = await makeCtx(false);
    ctx.config.roles.evaluator = { backend: "codex", model: "gpt", fallback: { backend: "codex", model: "gpt-mini" } };
    const rec = limiter(new Set(["codex"]));
    const r = await runRole({ ctx, roleKind: "evaluator", brief: "grade", runSessionFn: rec.fn });
    expect(rec.calls.length).toBe(1); // the same-backend fallback can't help → skipped
    expect(r.limitHit).toBeDefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("no limit → runs once, no fallback attempt", async () => {
    const { ctx, dir } = await makeCtx(false);
    ctx.config.roles.evaluator = { backend: "claude", model: "opus", fallback: { backend: "codex", model: "gpt" } };
    const rec = limiter(new Set()); // nothing limited
    const r = await runRole({ ctx, roleKind: "evaluator", brief: "grade", runSessionFn: rec.fn });
    expect(rec.calls.length).toBe(1);
    expect(r.limitHit).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("runRole — writer no-progress fast-fail (Item B)", () => {
  /** A changedFilesFn returning a scripted result per call (before-run, then after-run). */
  function changes(seq: string[][]) {
    let i = 0;
    return () => seq[Math.min(i++, seq.length - 1)]!;
  }

  it("flags noProgress when a generator changes NO file (the permission-starved signature)", async () => {
    const { ctx, dir } = await makeCtx(false);
    const rec = recorder("I could not read the workspace.");
    const r = await runRole({
      ctx,
      roleKind: "generator",
      brief: "Build the artifact.",
      runSessionFn: rec.fn,
      changedFilesFn: changes([[], []]), // same (empty) set before and after → nothing written
    });
    expect(r.noProgress).toBe(true);
    expect(r.errors.some((e) => /changed no files/.test(e))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT flag noProgress when the generator wrote a file", async () => {
    const { ctx, dir } = await makeCtx(false);
    const rec = recorder();
    const r = await runRole({
      ctx,
      roleKind: "generator",
      brief: "Build the artifact.",
      runSessionFn: rec.fn,
      changedFilesFn: changes([[], [path.join(dir, "src/new.ts")]]), // a new path appeared → progress
    });
    expect(r.noProgress).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("never flags noProgress for a read-only role (evaluator) even if nothing changed", async () => {
    const { ctx, dir } = await makeCtx(false);
    const rec = recorder();
    const r = await runRole({
      ctx,
      roleKind: "evaluator",
      brief: "grade",
      runSessionFn: rec.fn,
      changedFilesFn: changes([[], []]),
    });
    expect(r.noProgress).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("prefers limitHit over noProgress (a limited run legitimately did nothing)", async () => {
    const { ctx, dir } = await makeCtx(false);
    ctx.config.roles.generator = { backend: "codex", model: "gpt" }; // no fallback → surfaces the limit
    const rec = limiter(new Set(["codex"]));
    const r = await runRole({
      ctx,
      roleKind: "generator",
      brief: "Build it.",
      runSessionFn: rec.fn,
      changedFilesFn: changes([[], []]),
    });
    expect(r.limitHit).toBeDefined();
    expect(r.noProgress).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("runRole — turn-cap (hitMaxTurns) surfacing (Item A)", () => {
  /** A fake session that stopped at the turn cap (optionally also limited). */
  function turnCapped(opts: { limitHit?: boolean } = {}) {
    const fn = async (p: RunSessionParams): Promise<RunResult> => ({
      ok: false,
      subtype: "error_max_turns",
      resultText: "partial work…",
      sessionId: "sess-cap",
      costUsd: 0,
      tokens: 9,
      numTurns: 60,
      hitMaxTurns: true,
      hitBudget: false,
      errors: ["error_max_turns"],
      tracePath: "",
      ...(opts.limitHit ? { limitHit: { kind: "usage" as const, raw: "limited" } } : {}),
    });
    return fn;
  }

  it("surfaces hitMaxTurns + the resumable sessionId/backend when a writer hits the turn cap", async () => {
    const { ctx, dir } = await makeCtx(false);
    const r = await runRole({
      ctx,
      roleKind: "generator",
      brief: "Build it.",
      runSessionFn: turnCapped(),
      changedFilesFn: () => [path.join(dir, "src/a.ts")], // it wrote something before the cap
    });
    expect(r.hitMaxTurns).toBe(true);
    expect(r.sessionId).toBe("sess-cap"); // the id the conductor resumes with
    expect(r.backend).toBe("claude");
    expect(r.noProgress).toBeUndefined(); // a turn-cap is "unfinished", not "blocked brief"
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("suppresses hitMaxTurns under a provider limit (the limit is the real reason)", async () => {
    const { ctx, dir } = await makeCtx(false);
    ctx.config.roles.generator = { backend: "claude", model: "opus" }; // no fallback → surfaces the limit
    const r = await runRole({ ctx, roleKind: "generator", brief: "Build it.", runSessionFn: turnCapped({ limitHit: true }) });
    expect(r.limitHit).toBeDefined();
    expect(r.hitMaxTurns).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT set hitMaxTurns for a normal completed run", async () => {
    const { ctx, dir } = await makeCtx(false);
    const r = await runRole({ ctx, roleKind: "generator", brief: "Build it.", runSessionFn: recorder().fn, changedFilesFn: () => [path.join(dir, "x.ts")] });
    expect(r.hitMaxTurns).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
