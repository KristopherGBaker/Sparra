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

  it("parses un-run assertion ids and excludes them from the functionality cap denominator", async () => {
    const { ctx, dir } = await makeCtx();
    const json =
      "```json\n" +
      JSON.stringify({
        assertions: [
          { id: 1, pass: true, evidence: "ok" },
          { id: 2, pass: true, evidence: "ok" },
          { id: 3, pass: false, evidence: "observed failure" },
          { id: 4, pass: false, evidence: "xcrun simctl unavailable in evaluator env" },
        ],
        unrunAssertionIds: [4],
        scores: { design: 90, originality: 90, craft: 90, functionality: 95 },
        verdict: "fail",
        blocking: ["real assertion 3 failed"],
        notes: "assertion 4 UN-RUN: CoreSimulator unavailable",
      }) +
      "\n```";
    const out = await run(ctx, dir, recorder(json), cleanIntegrityDeps);
    expect(out.verdict.unrunAssertionIds).toEqual([4]);
    expect(out.verdict.scores.functionality).toBe(67); // 2/3 runnable, not 2/4
    const written = fs.readFileSync(ctx.paths.verdictFile(ITEM.id, 1), "utf8");
    expect(written).toContain("un-run assertions: #4");
    expect(written).toContain("2/3 assertions passed; 1 un-run excluded");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("model pass with passing runnable assertions plus an un-run id remains pass", async () => {
    const { ctx, dir } = await makeCtx();
    const json =
      "```json\n" +
      JSON.stringify({
        assertions: [
          { id: 1, pass: true, evidence: "ok" },
          { id: 2, pass: true, evidence: "ok" },
          { id: 3, pass: false, evidence: "simulator unavailable" },
        ],
        unrunAssertionIds: [3],
        scores: { design: 90, originality: 90, craft: 90, functionality: 90 },
        verdict: "pass",
        exerciseStatus: "ran",
        blocking: [],
        notes: "assertion 3 UN-RUN: simulator unavailable",
      }) +
      "\n```";
    const out = await runWithExerciser(recorder(json), "ran", dir, ctx);
    expect(out.verdict.verdict).toBe("pass");
    expect(out.verdict.unrunAssertionIds).toEqual([3]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("all-un-run verdict is inconclusive and never normalizes to pass", async () => {
    const { ctx, dir } = await makeCtx();
    const json =
      "```json\n" +
      JSON.stringify({
        assertions: [
          { id: 1, pass: false, evidence: "command not found" },
          { id: 2, pass: false, evidence: "CoreSimulator dead" },
        ],
        unrunAssertionIds: [1, 2],
        scores: { design: 90, originality: 90, craft: 90, functionality: 90 },
        verdict: "pass",
        exerciseStatus: "mixed",
        blocking: [],
        notes: "all gates UN-RUN in evaluator environment",
      }) +
      "\n```";
    const out = await runWithExerciser(recorder(json), "mixed", dir, ctx);
    expect(out.verdict.exerciseStatus).toBe("mixed");
    expect(out.verdict.verdict).toBe("fail");
    expect(out.verdict.scores.functionality).toBe(90); // no runnable denominator, so no cap
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
  const stubExerciser = (status: "blocked" | "ran" | "mixed" | "none"): Exerciser => ({
    mcpServers: {},
    allowedTools: ["mcp__exercise__run_command"],
    guidance: "",
    exerciseStatus: () => status,
  });

  async function runWithExerciser(rec: ReturnType<typeof recorder>, status: "blocked" | "ran" | "mixed" | "none", dir: string, ctx: Ctx) {
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

  it("harness 'mixed' OVERRIDES model status and remains gradeable", async () => {
    const { ctx, dir } = await makeCtx();
    const out = await runWithExerciser(recorder(PASS_JSON), "mixed", dir, ctx);
    expect(out.verdict.exerciseStatus).toBe("mixed");
    expect(out.verdict.verdict).toBe("pass");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("real run_command aggregation produces mixed and does not fail from an un-runnable command alone", async () => {
    const { ctx, dir } = await makeCtx();
    const calls: RunSessionParams[] = [];
    const fn = async (p: RunSessionParams): Promise<RunResult> => {
      calls.push(p);
      // Drive the REAL MCP handler from buildExerciser: one observed run + one env-blocked command.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const server = (p.mcpServers?.exercise as any);
      const runCommand = server.instance._registeredTools.run_command.handler;
      await runCommand({ command: "echo ok" }, {});
      await runCommand({ command: "this-binary-does-not-exist-xyz" }, {});
      return {
        ok: true,
        subtype: "success",
        resultText: PASS_JSON,
        sessionId: "mixed",
        costUsd: 0,
        tokens: 5,
        numTurns: 1,
        hitMaxTurns: false,
        hitBudget: false,
        errors: [],
        tracePath: "",
      };
    };
    const out = await evaluateItem({
      ctx,
      item: ITEM,
      contractText: "contract",
      workspaceDir: dir,
      round: 1,
      traceDir: path.join(dir, "trace"),
      traceSeq: 1,
      runSessionFn: fn,
      integrityDeps: cleanIntegrityDeps,
    });
    expect(calls).toHaveLength(1);
    expect(out.verdict.exerciseStatus).toBe("mixed");
    expect(out.verdict.verdict).toBe("pass");
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

  // — Backend-aware exercise-tool wiring (U1) —
  it("attaches the exercise mcpServers/allowedTools for a Claude eval backend, NOT for a Codex one (U1)", async () => {
    const { ctx, dir } = await makeCtx();
    const claude = recorder();
    await evaluateItem({
      ctx, item: ITEM, contractText: "contract", workspaceDir: dir, round: 1,
      traceDir: path.join(dir, "trace"), traceSeq: 1, runSessionFn: claude.fn,
      integrityDeps: cleanIntegrityDeps, role: { backend: "claude", model: "opus" },
    });
    expect(claude.calls[0]!.mcpServers).toBeDefined();
    expect(claude.calls[0]!.allowedTools).toContain("mcp__exercise__run_command");

    const codex = recorder();
    await evaluateItem({
      ctx, item: ITEM, contractText: "contract", workspaceDir: dir, round: 1,
      traceDir: path.join(dir, "trace"), traceSeq: 1, runSessionFn: codex.fn,
      integrityDeps: cleanIntegrityDeps, role: { backend: "codex", model: "gpt" },
    });
    expect(codex.calls[0]!.mcpServers).toBeUndefined();
    expect(codex.calls[0]!.allowedTools ?? []).not.toContain("mcp__exercise__run_command");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a Codex eval backend gets native-runner guidance (no mcp__exercise__ token); Claude keeps the mcp mandate (U1)", async () => {
    const { ctx, dir } = await makeCtx();
    const codex = recorder();
    await evaluateItem({
      ctx, item: ITEM, contractText: "contract", workspaceDir: dir, round: 1,
      traceDir: path.join(dir, "trace"), traceSeq: 1, runSessionFn: codex.fn,
      integrityDeps: cleanIntegrityDeps, role: { backend: "codex", model: "gpt" },
    });
    // Non-degenerate: assert the FULLY-ASSEMBLED no-inProcessMcp evaluator system prompt (template +
    // injected guidance + PROCESS-step run-instruction) contains ZERO `mcp__exercise__` token — not
    // just the injected guidance phrase (the prompts.ts PROCESS-step run-instruction must also be
    // backend-aware, else this fails). Contract assertion 5.
    const sys = codex.calls[0]!.systemPrompt ?? "";
    expect(sys).not.toContain("mcp__exercise__"); // NO phantom mandate anywhere in the assembled prompt
    expect(sys).toContain("Exercise it with your shell/Bash");
    expect(sys).toMatch(/cannot observe or classify exit codes/i);

    const claude = recorder();
    await evaluateItem({
      ctx, item: ITEM, contractText: "contract", workspaceDir: dir, round: 1,
      traceDir: path.join(dir, "trace"), traceSeq: 1, runSessionFn: claude.fn,
      integrityDeps: cleanIntegrityDeps, role: { backend: "claude", model: "opus" },
    });
    // The Claude (inProcessMcp) prompt still names the tool in BOTH the guidance AND the PROCESS step.
    const claudeSys = claude.calls[0]!.systemPrompt ?? "";
    expect(claudeSys).toContain("Exercise it with mcp__exercise__run_command"); // injected guidance
    expect(claudeSys).toContain("Run via `mcp__exercise__run_command`"); // PROCESS-step run-instruction
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("observed-run demotion fires for a Claude backend but NOT a Codex one (harness 'none' is expected on Codex) (U1)", async () => {
    // Harness 'none' + cli + model pass: on Claude (inProcessMcp) an observed run was possible, so
    // the unobserved pass is demoted; on Codex (no inProcessMcp) 'none' is EXPECTED (the server was
    // never attachable), so the honest pass must stand.
    const stub = (): Exerciser => ({ mcpServers: {}, allowedTools: ["mcp__exercise__run_command"], guidance: "", exerciseStatus: () => "none" });
    const { ctx, dir } = await makeCtx();
    ctx.config.exercise.mechanism = "cli";

    const claude = await evaluateItem({
      ctx, item: ITEM, contractText: "contract", workspaceDir: dir, round: 1,
      traceDir: path.join(dir, "trace"), traceSeq: 1, runSessionFn: recorder(PASS_JSON).fn,
      integrityDeps: cleanIntegrityDeps, role: { backend: "claude", model: "opus" }, buildExerciserFn: stub,
    });
    expect(claude.verdict.verdict).toBe("fail");
    expect(claude.verdict.blocking.join(" ")).toContain(UNOBSERVED_NOTE);

    const codex = await evaluateItem({
      ctx, item: ITEM, contractText: "contract", workspaceDir: dir, round: 1,
      traceDir: path.join(dir, "trace"), traceSeq: 1, runSessionFn: recorder(PASS_JSON).fn,
      integrityDeps: cleanIntegrityDeps, role: { backend: "codex", model: "gpt" }, buildExerciserFn: stub,
    });
    expect(codex.verdict.verdict).toBe("pass");
    expect(codex.verdict.blocking.join(" ")).not.toContain(UNOBSERVED_NOTE);
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

  it("the evaluator's assembled system prompt carries the anchored rubric (definitions + bands) (Q4)", async () => {
    const { ctx, dir } = await makeCtx();
    const rec = recorder();
    await run(ctx, dir, rec, cleanIntegrityDeps);
    const sys = rec.calls[0]!.systemPrompt ?? "";
    expect(sys).toContain("functionality (weight 0.3): works when exercised");
    expect(sys).toContain("90+ exemplary");
    expect(sys).toContain("70-89 solid");
    expect(sys).toContain("50-69 notable gaps");
    expect(sys).toContain("<50 broken/deficient");
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

describe("evaluateItem — JSON re-ask on no-parseable-verdict (Q7d)", () => {
  /** Fake session returning texts[i] on the i-th call (last one repeats); sessionId is s<i>. */
  function seqRecorder(texts: string[], costUsd = 0) {
    const calls: RunSessionParams[] = [];
    const fn = async (p: RunSessionParams): Promise<RunResult> => {
      const i = calls.length;
      calls.push(p);
      return {
        ok: true, subtype: "success", resultText: texts[Math.min(i, texts.length - 1)]!, sessionId: `s${i}`,
        costUsd, tokens: 1, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
      };
    };
    return { calls, fn };
  }

  async function runSeq(ctx: Ctx, dir: string, rec: ReturnType<typeof seqRecorder>) {
    return evaluateItem({
      ctx, item: ITEM, contractText: "contract", workspaceDir: dir, round: 1,
      traceDir: path.join(dir, "trace"), traceSeq: 1, runSessionFn: rec.fn, integrityDeps: cleanIntegrityDeps,
    });
  }

  it("re-asks ONCE, resuming the SAME session; a valid verdict on the re-ask is parsed, NOT forced FAIL", async () => {
    const { ctx, dir } = await makeCtx();
    ctx.config.exercise.requireObservedRun = false; // isolate the re-ask from the observed-run gate
    const rec = seqRecorder(["no verdict json here", PASS_JSON]);
    const out = await runSeq(ctx, dir, rec);
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[1]!.resume).toBe("s0"); // resumed the first call's session
    expect(rec.calls[1]!.prompt).toContain("Re-emit ONLY the JSON block");
    expect(out.verdict.verdict).toBe("pass"); // round proceeds normally
    expect(out.verdict.notes).not.toBe("no verdict parsed");
    expect(out.raw).toContain("no verdict json here"); // original output preserved in the raw record
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("both responses unparseable → one re-ask, then today's forced-FAIL fallback", async () => {
    const { ctx, dir } = await makeCtx();
    const rec = seqRecorder(["garbage one", "garbage two"]);
    const out = await runSeq(ctx, dir, rec);
    expect(rec.calls).toHaveLength(2); // exactly ONE re-ask, never more
    expect(out.verdict.verdict).toBe("fail");
    expect(out.verdict.notes).toBe("no verdict parsed");
    expect(out.verdict.blocking.join(" ")).toContain("parseable JSON verdict");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("build.jsonReask: false → NO re-ask call, straight to the forced FAIL (contrast)", async () => {
    const { ctx, dir } = await makeCtx();
    ctx.config.build.jsonReask = false;
    const rec = seqRecorder(["garbage", PASS_JSON]);
    const out = await runSeq(ctx, dir, rec);
    expect(rec.calls).toHaveLength(1);
    expect(out.verdict.verdict).toBe("fail");
    expect(out.verdict.notes).toBe("no verdict parsed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips the re-ask when the session already exhausted the item budget", async () => {
    const { ctx, dir } = await makeCtx();
    const rec = seqRecorder(["garbage", PASS_JSON], 99); // each call costs $99 vs the default $5 cap
    const out = await runSeq(ctx, dir, rec);
    expect(rec.calls).toHaveLength(1); // budget-exhausted → no re-ask
    expect(out.verdict.verdict).toBe("fail");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accumulates the re-ask's cost + tokens into the eval output", async () => {
    const { ctx, dir } = await makeCtx();
    const rec = seqRecorder(["garbage", PASS_JSON], 0.5);
    const out = await runSeq(ctx, dir, rec);
    expect(rec.calls).toHaveLength(2);
    expect(out.costUsd).toBe(1); // 0.5 × 2
    expect(out.tokens).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("evaluateItem — TARGETED re-ask on a WRONG-SHAPE verdict (U-C #7)", () => {
  /** Fake session returning texts[i] on the i-th call (last repeats); optionally sets limitHit. */
  function seqRecorder(texts: string[], opts: { costUsd?: number; limitHit?: boolean } = {}) {
    const calls: RunSessionParams[] = [];
    const fn = async (p: RunSessionParams): Promise<RunResult> => {
      const i = calls.length;
      calls.push(p);
      return {
        ok: true, subtype: "success", resultText: texts[Math.min(i, texts.length - 1)]!, sessionId: `s${i}`,
        costUsd: opts.costUsd ?? 0, tokens: 1, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
        ...(opts.limitHit ? { limitHit: { kind: "usage", raw: "usage limit" } as RunResult["limitHit"] } : {}),
      };
    };
    return { calls, fn };
  }

  async function runSeq(ctx: Ctx, dir: string, rec: ReturnType<typeof seqRecorder>) {
    return evaluateItem({
      ctx, item: ITEM, contractText: "contract", workspaceDir: dir, round: 1,
      traceDir: path.join(dir, "trace"), traceSeq: 1, runSessionFn: rec.fn, integrityDeps: cleanIntegrityDeps,
    });
  }

  // GAMEABILITY FIXTURE: incidental command-output JSON (no rubric fields) FIRST and LAST, with a
  // wrong-shaped verdict-like block (has `verdict`, NO `scores`) in the MIDDLE — so a naive
  // first/last-block impl derives fields from the incidental block, not the verdict candidate.
  const GAMEABLE_WRONG_SHAPE =
    "I ran the suite:\n```json\n" +
    '{"command":"npm test","exitCode":0,"stdout":"5 passing"}\n```\n' +
    "My assessment:\n```json\n" +
    '{"verdict":"fail","blocking":["broken"],"notes":"n"}\n```\n' +
    "Final status:\n```json\n" +
    '{"command":"echo done","exitCode":0}\n```';

  it("names the field missing from the VERDICT-LIKE candidate (scores), NOT the incidental block (kills first/last-block impls)", async () => {
    const { ctx, dir } = await makeCtx();
    const rec = seqRecorder([GAMEABLE_WRONG_SHAPE, "still garbage"]);
    await runSeq(ctx, dir, rec);
    expect(rec.calls).toHaveLength(2); // exactly one targeted re-ask
    expect(rec.calls[1]!.resume).toBe("s0"); // same resumed session
    const prompt = rec.calls[1]!.prompt!;
    expect(prompt).toContain("Re-emit ONLY the JSON");
    // The named missing field(s) come from the candidate (`scores`), not the incidental object.
    const fieldList = prompt.split("invalid value for:")[1]!.split(".")[0]!;
    expect(fieldList).toContain("scores");
    expect(fieldList).not.toContain("verdict"); // candidate HAS verdict → naive [scores,verdict] must fail
    expect(fieldList).not.toContain("command"); // never fields derived from the incidental block
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a valid verdict on the wrong-shape re-ask is parsed and used (no forced FAIL)", async () => {
    const { ctx, dir } = await makeCtx();
    ctx.config.exercise.requireObservedRun = false;
    const rec = seqRecorder([GAMEABLE_WRONG_SHAPE, PASS_JSON]);
    const out = await runSeq(ctx, dir, rec);
    expect(rec.calls).toHaveLength(2);
    expect(out.verdict.verdict).toBe("pass");
    expect(out.verdict.notes).not.toBe("no verdict parsed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("wrong-shape re-ask still invalid → forced-FAIL fallback unchanged", async () => {
    const { ctx, dir } = await makeCtx();
    const rec = seqRecorder([GAMEABLE_WRONG_SHAPE, "no json at all"]);
    const out = await runSeq(ctx, dir, rec);
    expect(rec.calls).toHaveLength(2);
    expect(out.verdict.verdict).toBe("fail");
    expect(out.verdict.notes).toBe("no verdict parsed");
    expect(out.verdict.blocking.join(" ")).toContain("parseable JSON verdict");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("budget-exhausted → NO wrong-shape re-ask (guard holds)", async () => {
    const { ctx, dir } = await makeCtx();
    const rec = seqRecorder([GAMEABLE_WRONG_SHAPE, PASS_JSON], { costUsd: 99 });
    const out = await runSeq(ctx, dir, rec);
    expect(rec.calls).toHaveLength(1);
    expect(out.verdict.verdict).toBe("fail");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("limitHit set → NO wrong-shape re-ask (the fallback chain owns provider limits)", async () => {
    const { ctx, dir } = await makeCtx();
    const rec = seqRecorder([GAMEABLE_WRONG_SHAPE, PASS_JSON], { limitHit: true });
    const out = await runSeq(ctx, dir, rec);
    expect(rec.calls).toHaveLength(1);
    expect(out.verdict.verdict).toBe("fail");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("build.jsonReask:false → NO wrong-shape re-ask", async () => {
    const { ctx, dir } = await makeCtx();
    ctx.config.build.jsonReask = false;
    const rec = seqRecorder([GAMEABLE_WRONG_SHAPE, PASS_JSON]);
    const out = await runSeq(ctx, dir, rec);
    expect(rec.calls).toHaveLength(1);
    expect(out.verdict.verdict).toBe("fail");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("evaluateItem — assertion-anchored functionality cap (Q4, rubric.anchorFunctionality)", () => {
  // Verdict JSON with a chosen assertion pass/fail mix + a chosen functionality score.
  const verdictJson = (passes: boolean[], functionality: number, others = 90) =>
    "```json\n" +
    JSON.stringify({
      assertions: passes.map((pass, i) => ({ id: i + 1, pass, evidence: pass ? "ok" : "broken" })),
      scores: { design: others, originality: others, craft: others, functionality },
      verdict: "fail",
      blocking: [],
      notes: "n",
    }) +
    "\n```";

  it("2 of 4 assertions failed + model functionality 95 ⇒ capped to 50, weightedTotal recomputed, cap noted in the verdict markdown", async () => {
    const { ctx, dir } = await makeCtx();
    const out = await run(ctx, dir, recorder(verdictJson([true, true, false, false], 95)), cleanIntegrityDeps);
    expect(out.verdict.scores.functionality).toBe(50); // round(100 × 2/4)
    // Recomputed from the CAPPED score: 90×(0.25+0.15+0.3) + 50×0.3 = 78 (uncapped would be 91.5).
    expect(out.verdict.weightedTotal).toBe(78);
    const written = fs.readFileSync(ctx.paths.verdictFile(ITEM.id, 1), "utf8");
    expect(written).toContain("functionality capped at 50");
    expect(written).toContain("2/4 assertions passed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("1 of 3 assertions passed + model functionality 90 ⇒ capped to 33 (distinct fixture — not a hardcoded cap), noted in the markdown", async () => {
    const { ctx, dir } = await makeCtx();
    const out = await run(ctx, dir, recorder(verdictJson([true, false, false], 90, 80)), cleanIntegrityDeps);
    expect(out.verdict.scores.functionality).toBe(33); // round(100 × 1/3)
    // Recomputed from the CAPPED score: 80×0.7 + 33×0.3 = 65.9.
    expect(out.verdict.weightedTotal).toBe(65.9);
    const written = fs.readFileSync(ctx.paths.verdictFile(ITEM.id, 1), "utf8");
    expect(written).toContain("functionality capped at 33");
    expect(written).toContain("1/3 assertions passed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("contrast: ALL assertions passed + functionality 95 ⇒ unchanged, no cap note", async () => {
    const { ctx, dir } = await makeCtx();
    const out = await run(ctx, dir, recorder(verdictJson([true, true, true], 95)), cleanIntegrityDeps);
    expect(out.verdict.scores.functionality).toBe(95);
    expect(out.verdict.weightedTotal).toBe(91.5); // 90×0.7 + 95×0.3 — untouched
    const written = fs.readFileSync(ctx.paths.verdictFile(ITEM.id, 1), "utf8");
    expect(written).not.toContain("functionality capped");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("contrast: failures present but functionality already BELOW the ceiling (30 < 50) ⇒ unchanged (a cap never raises)", async () => {
    const { ctx, dir } = await makeCtx();
    const out = await run(ctx, dir, recorder(verdictJson([true, true, false, false], 30)), cleanIntegrityDeps);
    expect(out.verdict.scores.functionality).toBe(30);
    const written = fs.readFileSync(ctx.paths.verdictFile(ITEM.id, 1), "utf8");
    expect(written).not.toContain("functionality capped");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("opt-out: rubric.anchorFunctionality=false ⇒ no cap even with failures", async () => {
    const { ctx, dir } = await makeCtx();
    ctx.config.rubric.anchorFunctionality = false;
    const out = await run(ctx, dir, recorder(verdictJson([true, true, false, false], 95)), cleanIntegrityDeps);
    expect(out.verdict.scores.functionality).toBe(95);
    expect(out.verdict.weightedTotal).toBe(91.5);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("zero assertions listed ⇒ no cap (division guard), existing behavior preserved", async () => {
    const { ctx, dir } = await makeCtx();
    const out = await run(ctx, dir, recorder(verdictJson([], 95)), cleanIntegrityDeps);
    expect(out.verdict.scores.functionality).toBe(95);
    expect(out.verdict.weightedTotal).toBe(91.5);
    const written = fs.readFileSync(ctx.paths.verdictFile(ITEM.id, 1), "utf8");
    expect(written).not.toContain("functionality capped");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the knob defaults ON: a fresh defaultConfig applies the cap with no config edits", async () => {
    const { ctx, dir } = await makeCtx();
    expect(ctx.config.rubric.anchorFunctionality).toBe(true); // default
    const out = await run(ctx, dir, recorder(verdictJson([false], 100)), cleanIntegrityDeps);
    expect(out.verdict.scores.functionality).toBe(0); // 0/1 passed
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
