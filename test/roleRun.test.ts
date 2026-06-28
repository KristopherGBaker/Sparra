import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runRole, makeHoldoutReadDecider, type RoleKind } from "../src/build/roleRun.ts";
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
