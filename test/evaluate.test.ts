import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { evaluateItem } from "../src/build/evaluate.ts";
import type { Exerciser } from "../src/sdk/exercise.ts";
import type { IntegrityDeps } from "../src/build/integrity.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import type { WorkItem } from "../src/build/types.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

async function makeCtx(): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-eval-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  const config = defaultConfig();
  return { ctx: { root: dir, paths, config, store }, dir };
}

const ITEM: WorkItem = { id: "item-001", title: "t", summary: "", dependsOn: [], rationale: "" };

const PASS_JSON =
  '```json\n{"assertions":[{"id":1,"pass":true,"evidence":"ok"}],' +
  '"scores":{"design":90,"originality":90,"craft":90,"functionality":90},"verdict":"pass","blocking":[],"notes":"n"}\n```';

function recorder(resultText = PASS_JSON) {
  const calls: RunSessionParams[] = [];
  const fn = async (p: RunSessionParams): Promise<RunResult> => {
    calls.push(p);
    return {
      ok: true,
      subtype: "success",
      resultText,
      sessionId: "e",
      costUsd: 0,
      tokens: 5,
      numTurns: 1,
      hitMaxTurns: false,
      hitBudget: false,
      errors: [],
      tracePath: "",
    };
  };
  return { calls, fn };
}

const cleanIntegrityDeps: IntegrityDeps = {
  listArtifactFiles: () => [],
  readFile: () => null,
  writeFile: () => {},
  removeFile: () => {},
};

function mutatingIntegrityDeps(rel: string): IntegrityDeps {
  let reads = 0;
  return {
    listArtifactFiles: () => [rel],
    readFile: () => Buffer.from(reads++ === 0 ? "before" : "after"),
    writeFile: () => {},
    removeFile: () => {},
  };
}

async function run(ctx: Ctx, dir: string, rec: ReturnType<typeof recorder>, integrityDeps: IntegrityDeps) {
  return evaluateItem({
    ctx,
    item: ITEM,
    contractText: "contract",
    workspaceDir: dir,
    round: 1,
    traceDir: path.join(dir, "trace"),
    traceSeq: 1,
    runSessionFn: rec.fn,
    integrityDeps,
  });
}

describe("evaluateItem — exercising evaluator scratch + integrity guard", () => {
  it("carries readOnly + exerciseScratch on a branch boundary with sandbox=workspace-write", async () => {
    const { ctx, dir } = await makeCtx();
    ctx.store.data.build.branch = "sparra/x";
    ctx.config.exercise.sandbox = "workspace-write";
    const rec = recorder();
    await run(ctx, dir, rec, cleanIntegrityDeps);
    expect(rec.calls[0]!.readOnly).toBe(true);
    expect(rec.calls[0]!.exerciseScratch).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT carry exerciseScratch with no branch, or when sandbox=read-only", async () => {
    const { ctx, dir } = await makeCtx();
    ctx.config.exercise.sandbox = "workspace-write";

    const a = recorder();
    await run(ctx, dir, a, cleanIntegrityDeps); // no branch
    expect(a.calls[0]!.exerciseScratch).toBeUndefined();
    expect(a.calls[0]!.readOnly).toBe(true);

    ctx.store.data.build.branch = "sparra/x";
    ctx.config.exercise.sandbox = "read-only";
    const b = recorder();
    await run(ctx, dir, b, cleanIntegrityDeps);
    expect(b.calls[0]!.exerciseScratch).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an integrity violation FORCES the verdict to fail and records the blocking line in the verdict file", async () => {
    const { ctx, dir } = await makeCtx();
    ctx.store.data.build.branch = "sparra/x";
    ctx.config.exercise.sandbox = "workspace-write";
    const rec = recorder(PASS_JSON); // model says pass…
    const out = await run(ctx, dir, rec, mutatingIntegrityDeps("src/App.ts"));
    expect(out.verdict.verdict).toBe("fail"); // …but the guard overrides
    expect(out.verdict.blocking[0]).toMatch(/Integrity violation/);
    expect(out.verdict.blocking[0]).toContain("src/App.ts");
    const written = fs.readFileSync(ctx.paths.verdictFile(ITEM.id, 1), "utf8");
    expect(written).toMatch(/verdict: \*\*fail\*\*/);
    expect(written).toMatch(/Integrity violation/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("redacts holdout the evaluator quoted from blocking/notes/evidence (no leak to generator feedback)", async () => {
    const { ctx, dir } = await makeCtx();
    const secret = "The widget must persist across app restarts reliably";
    fs.writeFileSync(ctx.paths.holdout, `# HOLDOUT\n\n- ${secret}\n`);
    const failJson =
      '```json\n{"assertions":[{"id":1,"pass":false,"evidence":"' +
      secret +
      '"}],"scores":{"design":40,"originality":40,"craft":40,"functionality":40},"verdict":"fail",' +
      '"blocking":["fails: ' +
      secret +
      '"],"notes":"because ' +
      secret +
      '"}\n```';
    const rec = recorder(failJson);
    const out = await run(ctx, dir, rec, cleanIntegrityDeps);
    expect(out.verdict.blocking[0]).toContain("[redacted: holdout]");
    expect(out.verdict.blocking.join(" ")).not.toContain(secret);
    expect(out.verdict.notes).not.toContain(secret);
    expect(out.verdict.assertions[0]!.evidence).not.toContain(secret);
    expect(out.raw).not.toContain(secret); // returned raw is redacted too
    const written = fs.readFileSync(ctx.paths.verdictFile(ITEM.id, 1), "utf8");
    expect(written).not.toContain(secret); // verdict file (incl. raw <details>) is clean
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("carries exerciseStatus:blocked from the evaluator JSON, and defaults junk/absent to ran", async () => {
    const blockedJson =
      '```json\n{"assertions":[],"scores":{"design":80,"originality":80,"craft":80,"functionality":80},' +
      '"verdict":"fail","exerciseStatus":"blocked","blocking":["EPERM — could not run tests"],"notes":"n"}\n```';
    const { ctx, dir } = await makeCtx();
    const out = await run(ctx, dir, recorder(blockedJson), cleanIntegrityDeps);
    expect(out.verdict.exerciseStatus).toBe("blocked");
    expect(out.verdict.scores.design).toBe(80); // score preserved (H5), not zeroed

    // Absent → "ran"; a garbage value → "ran" (only the exact string "blocked" blocks). (H4)
    const junkJson =
      '```json\n{"assertions":[],"scores":{"design":40,"originality":40,"craft":40,"functionality":40},' +
      '"verdict":"fail","exerciseStatus":"weird","blocking":[],"notes":""}\n```';
    const junk = await run(ctx, dir, recorder(junkJson), cleanIntegrityDeps);
    expect(junk.verdict.exerciseStatus).toBe("ran");
    const plain = await run(ctx, dir, recorder(PASS_JSON), cleanIntegrityDeps);
    expect(plain.verdict.exerciseStatus).toBe("ran");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("grants exerciseScratch on a REAL linked worktree with state.build.branch UNSET (Item E, anti-no-op)", async () => {
    const { ctx, dir } = await makeCtx();
    // A real offline git repo + linked worktree; only local `git` runs (no model/network).
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-eval-repo-"));
    const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    g("init", "-q");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "Test");
    g("commit", "--allow-empty", "-q", "-m", "init");
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-eval-wt-"));
    fs.rmSync(worktree, { recursive: true, force: true });
    g("worktree", "add", "--detach", "-q", worktree, "HEAD");

    ctx.config.exercise.sandbox = "workspace-write";
    expect(ctx.store.data.build.branch).toBeFalsy(); // no branch — worktree is the only reason
    const rec = recorder();
    await run(ctx, worktree, rec, cleanIntegrityDeps);
    expect(rec.calls[0]!.exerciseScratch).toBe(true); // fails for a no-op isWorktree:false wiring

    // WALL: the same setup with workspace = the MAIN worktree gets NO scratch.
    const recMain = recorder();
    await run(ctx, repo, recMain, cleanIntegrityDeps);
    expect(recMain.calls[0]!.exerciseScratch).toBeUndefined();

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  // A stub exerciser that reports a fixed harness status — no real run_command needed (the faked
  // session never calls the tools, so the real exerciser would always report "none").
  const stubExerciser = (status: "blocked" | "ran" | "none"): Exerciser => ({
    mcpServers: {},
    allowedTools: ["mcp__exercise__run_command"],
    guidance: "",
    exerciseStatus: () => status,
  });

  async function runWithExerciser(rec: ReturnType<typeof recorder>, status: "blocked" | "ran" | "none", dir: string, ctx: Ctx) {
    return evaluateItem({
      ctx,
      item: ITEM,
      contractText: "contract",
      workspaceDir: dir,
      round: 1,
      traceDir: path.join(dir, "trace"),
      traceSeq: 1,
      runSessionFn: rec.fn,
      integrityDeps: cleanIntegrityDeps,
      buildExerciserFn: () => stubExerciser(status),
    });
  }

  it("harness 'blocked' OVERRIDES a model {pass, ran} — final blocked AND not a pass (Item F)", async () => {
    const { ctx, dir } = await makeCtx();
    const out = await runWithExerciser(recorder(PASS_JSON), "blocked", dir, ctx);
    expect(out.verdict.exerciseStatus).toBe("blocked");
    expect(out.verdict.verdict).toBe("fail"); // unverified — can't launder into a pass
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("harness 'ran' OVERRIDES a model that self-reported blocked (Item F)", async () => {
    const blockedJson =
      '```json\n{"assertions":[],"scores":{"design":80,"originality":80,"craft":80,"functionality":80},' +
      '"verdict":"fail","exerciseStatus":"blocked","blocking":["claimed EPERM"],"notes":"n"}\n```';
    const { ctx, dir } = await makeCtx();
    const out = await runWithExerciser(recorder(blockedJson), "ran", dir, ctx);
    expect(out.verdict.exerciseStatus).toBe("ran");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("harness 'none' falls back to the model's self-reported status (Item F)", async () => {
    const { ctx, dir } = await makeCtx();
    const ran = await runWithExerciser(recorder(PASS_JSON), "none", dir, ctx);
    expect(ran.verdict.exerciseStatus).toBe("ran");
    const blockedJson =
      '```json\n{"assertions":[],"scores":{"design":80,"originality":80,"craft":80,"functionality":80},' +
      '"verdict":"fail","exerciseStatus":"blocked","blocking":["EPERM"],"notes":"n"}\n```';
    const blocked = await runWithExerciser(recorder(blockedJson), "none", dir, ctx);
    expect(blocked.verdict.exerciseStatus).toBe("blocked");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("no-parseable-verdict + harness 'blocked' ⇒ verdict carries blocked, not the hardcoded 'ran' (Item F)", async () => {
    const { ctx, dir } = await makeCtx();
    const out = await runWithExerciser(recorder("no json here at all"), "blocked", dir, ctx);
    expect(out.verdict.exerciseStatus).toBe("blocked");
    expect(out.verdict.verdict).toBe("fail");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // — Observed-run gate (Q2): an unobserved pass (harness "none") is demoted to fail on cli/web —
  const UNOBSERVED_NOTE = "no mcp__exercise__ activity backed this pass; run gating commands via run_command";

  it("mechanism cli + harness 'none' + model pass ⇒ FAIL with the unobserved-exercise blocking note (Q2)", async () => {
    const { ctx, dir } = await makeCtx();
    ctx.config.exercise.mechanism = "cli";
    const out = await runWithExerciser(recorder(PASS_JSON), "none", dir, ctx);
    expect(out.verdict.verdict).toBe("fail");
    expect(out.verdict.blocking.join(" ")).toContain(UNOBSERVED_NOTE);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("mechanism web + harness 'none' + model pass ⇒ FAIL with the same note (gate covers web too) (Q2)", async () => {
    const { ctx, dir } = await makeCtx();
    ctx.config.exercise.mechanism = "web";
    const out = await runWithExerciser(recorder(PASS_JSON), "none", dir, ctx);
    expect(out.verdict.verdict).toBe("fail");
    expect(out.verdict.blocking.join(" ")).toContain(UNOBSERVED_NOTE);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("mechanism cli + harness 'ran' + model pass ⇒ stays PASS (gate discriminates observed vs unobserved) (Q2)", async () => {
    const { ctx, dir } = await makeCtx();
    ctx.config.exercise.mechanism = "cli";
    const out = await runWithExerciser(recorder(PASS_JSON), "ran", dir, ctx);
    expect(out.verdict.verdict).toBe("pass");
    expect(out.verdict.blocking.join(" ")).not.toContain(UNOBSERVED_NOTE);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("mechanisms ios, computer-use, and custom are EXEMPT — 'none' + model pass stays PASS (Q2)", async () => {
    for (const mech of ["ios", "computer-use", "custom"] as const) {
      const { ctx, dir } = await makeCtx();
      ctx.config.exercise.mechanism = mech;
      const out = await runWithExerciser(recorder(PASS_JSON), "none", dir, ctx);
      expect(out.verdict.verdict, `mechanism ${mech} should be exempt`).toBe("pass");
      expect(out.verdict.blocking.join(" ")).not.toContain(UNOBSERVED_NOTE);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exercise.requireObservedRun: false opts out — cli + 'none' + model pass stays PASS (Q2)", async () => {
    const { ctx, dir } = await makeCtx();
    ctx.config.exercise.mechanism = "cli";
    ctx.config.exercise.requireObservedRun = false;
    const out = await runWithExerciser(recorder(PASS_JSON), "none", dir, ctx);
    expect(out.verdict.verdict).toBe("pass");
    expect(out.verdict.blocking.join(" ")).not.toContain(UNOBSERVED_NOTE);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a FAILING verdict with 'none' observed stays fail WITHOUT the unobserved-pass note (gate targets passes only) (Q2)", async () => {
    const failJson =
      '```json\n{"assertions":[{"id":1,"pass":false,"evidence":"broken"}],' +
      '"scores":{"design":40,"originality":40,"craft":40,"functionality":40},"verdict":"fail","blocking":["it is broken"],"notes":"n"}\n```';
    const { ctx, dir } = await makeCtx();
    ctx.config.exercise.mechanism = "cli";
    const out = await runWithExerciser(recorder(failJson), "none", dir, ctx);
    expect(out.verdict.verdict).toBe("fail");
    expect(out.verdict.blocking.join(" ")).not.toContain(UNOBSERVED_NOTE);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the demoted verdict's markdown carries the unobserved-exercise note in its Blocking section (Q2)", async () => {
    const { ctx, dir } = await makeCtx();
    ctx.config.exercise.mechanism = "cli";
    await runWithExerciser(recorder(PASS_JSON), "none", dir, ctx);
    const written = fs.readFileSync(ctx.paths.verdictFile(ITEM.id, 1), "utf8");
    expect(written).toMatch(/verdict: \*\*fail\*\*/);
    const blockingSection = written.split("## Blocking")[1]!.split("## Notes")[0]!;
    expect(blockingSection).toContain(UNOBSERVED_NOTE);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a blocked exercise can NEVER pass, even if the model claims pass with a high score (H3)", async () => {
    // Contradictory verdict: model says pass + 90s but admits the exercise was blocked.
    const blockedButPass =
      '```json\n{"assertions":[{"id":1,"pass":true,"evidence":"asserted"}],' +
      '"scores":{"design":90,"originality":90,"craft":90,"functionality":90},"weightedTotal":90,' +
      '"verdict":"pass","exerciseStatus":"blocked","blocking":["EPERM — never ran the suite"],"notes":"n"}\n```';
    const { ctx, dir } = await makeCtx();
    const out = await run(ctx, dir, recorder(blockedButPass), cleanIntegrityDeps);
    expect(out.verdict.exerciseStatus).toBe("blocked");
    expect(out.verdict.verdict).toBe("fail"); // never accepted — unverified
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
