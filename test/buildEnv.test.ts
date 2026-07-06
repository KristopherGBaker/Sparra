import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { Ctx } from "../src/context.ts";
import { defaultConfig, loadConfig } from "../src/config.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { mergedBuildEnv } from "../src/build/env.ts";
import { runVerifyCommand } from "../src/build/exec.ts";
import { measureAcceptedItem } from "../src/build/measure.ts";
import { buildExerciser } from "../src/sdk/exercise.ts";
import { generateItem } from "../src/build/generate.ts";
import { runRole } from "../src/build/roleRun.ts";
import { cmdPrototype } from "../src/phases/prototype.ts";
import { claudeBackend } from "../src/sdk/backends/claude.ts";
import { codexBackend } from "../src/sdk/backends/codex.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

const sdk = vi.hoisted(() => ({
  claudeOptions: undefined as any,
  codexOptions: undefined as any,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ options }) => {
    sdk.claudeOptions = options;
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "claude-session", model: "mock" };
      yield { type: "result", subtype: "success", session_id: "claude-session", result: "ok", total_cost_usd: 0, num_turns: 1 };
    })();
  }),
  tool: vi.fn((name, _description, _schema, handler) => ({ name, handler })),
  createSdkMcpServer: vi.fn(({ name, tools }) => ({
    type: "sdk",
    name,
    instance: { _registeredTools: Object.fromEntries(tools.map((t: any) => [t.name, { handler: t.handler }])) },
  })),
}));

vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    id = "codex-thread";
    constructor(options: any) {
      sdk.codexOptions = options;
    }
    startThread() {
      return {
        id: "codex-thread",
        run: async () => ({ usage: { total_tokens: 1 }, finalResponse: "ok" }),
      };
    }
    resumeThread() {
      return this.startThread();
    }
  },
}));

const PROBE = "SPARRA_U4_ENV_PROBE";
const OK_REPORT = '```json\n{"report":"ok","deviations":[]}\n```';

async function makeCtx(): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-build-env-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  const config = defaultConfig();
  return { ctx: { root: dir, paths, config, store }, dir };
}

function fakeRun(calls: RunSessionParams[]): (p: RunSessionParams) => Promise<RunResult> {
  return async (p) => {
    calls.push(p);
    return {
      ok: true,
      subtype: "success",
      resultText: p.role.includes("generator") ? OK_REPORT : "done",
      sessionId: "session",
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

function fakeSpawn(capture: any[]): typeof spawn {
  return vi.fn((...args: any[]) => {
    capture.push(args);
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from("ok\n"));
      child.emit("close", 0);
    });
    return child;
  }) as unknown as typeof spawn;
}

function backendReq(env?: Record<string, string>): RunSessionParams {
  return {
    role: "probe",
    prompt: "hi",
    systemPrompt: "sys",
    model: "mock",
    cwd: os.tmpdir(),
    env,
    traceDir: fs.mkdtempSync(path.join(os.tmpdir(), "sparra-backend-env-")),
    traceSeq: 1,
    echoActivity: false,
  };
}

afterEach(() => {
  sdk.claudeOptions = undefined;
  sdk.codexOptions = undefined;
});

describe("build.env config", () => {
  it("defaults to an empty map and loads string values", async () => {
    expect(defaultConfig().build.env).toEqual({});
    const { dir } = await makeCtx();
    const paths = new Paths(dir);
    fs.writeFileSync(paths.config, "build:\n  env:\n    FOO: bar\n");
    const cfg = await loadConfig(paths);
    expect(cfg.build.env).toEqual({ FOO: "bar" });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(["1", "true", "{ nested: value }", "null"])("rejects non-string build.env values (%s)", async (value) => {
    const { dir } = await makeCtx();
    const paths = new Paths(dir);
    fs.writeFileSync(paths.config, `build:\n  env:\n    FOO: ${value}\n`);
    await expect(loadConfig(paths)).rejects.toThrow(/FOO.*string/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("build.env SDK/backend injection", () => {
  it("merges over process.env and gives build.env precedence", () => {
    const old = process.env[PROBE];
    process.env[PROBE] = "old";
    try {
      const cfg = defaultConfig();
      cfg.build.env = { [PROBE]: "new" };
      const env = mergedBuildEnv(cfg)!;
      expect(env[PROBE]).toBe("new");
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      if (old === undefined) delete process.env[PROBE];
      else process.env[PROBE] = old;
    }
  });

  it("omits env when build.env is empty, so a scrubbed probe is absent", () => {
    const old = process.env[PROBE];
    delete process.env[PROBE];
    try {
      expect(mergedBuildEnv(defaultConfig())).toBeUndefined();
    } finally {
      if (old !== undefined) process.env[PROBE] = old;
    }
  });

  it("passes merged env to Claude Options.env", async () => {
    const cfg = defaultConfig();
    cfg.build.env = { [PROBE]: "on" };
    await claudeBackend.runTask(backendReq(mergedBuildEnv(cfg)));
    expect(sdk.claudeOptions.env[PROBE]).toBe("on");
    expect(sdk.claudeOptions.env.PATH).toBe(process.env.PATH);
  });

  it("passes merged env to Codex CodexOptions.env", async () => {
    const cfg = defaultConfig();
    cfg.build.env = { [PROBE]: "on" };
    await codexBackend.runTask(backendReq(mergedBuildEnv(cfg)));
    expect(sdk.codexOptions.env[PROBE]).toBe("on");
    expect(sdk.codexOptions.env.PATH).toBe(process.env.PATH);
  });

  it("changes only env, not safety-relevant request fields, on generator requests", async () => {
    const base = await makeCtx();
    const withEnv = await makeCtx();
    withEnv.ctx.config.build.env = { [PROBE]: "on" };
    const callsA: RunSessionParams[] = [];
    const callsB: RunSessionParams[] = [];
    await generateItem({
      ctx: base.ctx,
      item: { id: "item-001", title: "t", summary: "", dependsOn: [], rationale: "" },
      contractText: "c",
      workspaceDir: base.dir,
      traceDir: base.dir,
      traceSeq: 1,
      runSessionFn: fakeRun(callsA),
    });
    await generateItem({
      ctx: withEnv.ctx,
      item: { id: "item-001", title: "t", summary: "", dependsOn: [], rationale: "" },
      contractText: "c",
      workspaceDir: withEnv.dir,
      traceDir: withEnv.dir,
      traceSeq: 1,
      runSessionFn: fakeRun(callsB),
    });
    const a = callsA[0]!;
    const b = callsB[0]!;
    // The generator now always gets the writable-scratch redirect layer (SWIFTPM_CACHE_DIR etc.),
    // so env is always a map. The PROBE contrast is preserved: absent without build.env, present with.
    expect(a.env?.SWIFTPM_CACHE_DIR).toBeDefined();
    expect(a.env?.[PROBE]).toBeUndefined();
    expect(b.env?.[PROBE]).toBe("on");
    for (const key of ["permissionMode", "allowedTools", "disallowedTools", "mcpServers", "sandbox", "readOnly", "writeScope"] as const) {
      expect(b[key]).toEqual(a[key]);
    }
    expect(Object.keys(b.hooks ?? {})).toEqual(Object.keys(a.hooks ?? {}));
    expect(b.additionalDirectories?.map((p) => path.basename(p))).toEqual(a.additionalDirectories?.map((p) => path.basename(p)));
    fs.rmSync(base.dir, { recursive: true, force: true });
    fs.rmSync(withEnv.dir, { recursive: true, force: true });
  });
});

describe("build.env command executors", () => {
  it("passes merged env to runVerifyCommand spawns and has a negative contrast when unset", async () => {
    const old = process.env[PROBE];
    delete process.env[PROBE];
    try {
      const cfg = defaultConfig();
      cfg.build.env = { [PROBE]: "on" };
      const setCalls: any[] = [];
      await runVerifyCommand("/ws", "echo ok", { spawnFn: fakeSpawn(setCalls), env: mergedBuildEnv(cfg) });
      expect(setCalls[0]![2].env[PROBE]).toBe("on");
      expect(setCalls[0]![2].env.PATH).toBe(process.env.PATH);

      const unsetCalls: any[] = [];
      await runVerifyCommand("/ws", "echo ok", { spawnFn: fakeSpawn(unsetCalls) });
      expect(unsetCalls[0]![2].env[PROBE]).toBeUndefined();
    } finally {
      if (old !== undefined) process.env[PROBE] = old;
    }
  });

  it("passes merged env through the exercise run_command spawn", async () => {
    const cfg = defaultConfig();
    cfg.build.env = { [PROBE]: "on" };
    const calls: any[] = [];
    const ex = buildExerciser(cfg, os.tmpdir(), { spawnFn: fakeSpawn(calls) });
    const handler = (ex.mcpServers.exercise as any).instance._registeredTools.run_command.handler;
    await handler({ command: `printenv ${PROBE}` });
    expect(calls[0]![1].env[PROBE]).toBe("on");
    expect(calls[0]![1].env.PATH).toBe(process.env.PATH);
  });

  it("passes merged env through measure's runVerifyCommand delegation", async () => {
    const { ctx, dir } = await makeCtx();
    ctx.config.build.env = { [PROBE]: "on" };
    ctx.config.measure.command = "npm run qa";
    let captured: any;
    await measureAcceptedItem(
      ctx,
      dir,
      { compareOnly: true, now: () => new Date("2026-07-03T00:00:00Z") },
      {
        exec: async (_cwd, _cmd, opts) => {
          captured = opts;
          return { ran: true, command: _cmd, exitCode: 0, stdout: '{"metrics":{"x":1}}', stderr: "", timedOut: false };
        },
        readFile: async () => null,
        writeFile: async () => {},
      }
    );
    expect(captured.env[PROBE]).toBe("on");
    expect(captured.env.PATH).toBe(process.env.PATH);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe(".sparra/environment.md prompt injection", () => {
  it("injects notes into autonomous generator, role-run generator, and prototyper prompts", async () => {
    const { ctx, dir } = await makeCtx();
    fs.writeFileSync(ctx.paths.environment, "Set HOME=/private/tmp for Godot.");
    const item = { id: "item-001", title: "t", summary: "", dependsOn: [], rationale: "" };

    const genCalls: RunSessionParams[] = [];
    await generateItem({ ctx, item, contractText: "c", workspaceDir: dir, traceDir: dir, traceSeq: 1, runSessionFn: fakeRun(genCalls) });
    expect(genCalls[0]!.prompt).toContain("Environment notes from .sparra/environment.md");
    expect(genCalls[0]!.prompt).toContain("Set HOME=/private/tmp for Godot.");
    expect(genCalls[0]!.prompt).not.toMatch(/author|write.*environment\.md/i);

    const roleCalls: RunSessionParams[] = [];
    await runRole({ ctx, roleKind: "generator", brief: "Build it.", runSessionFn: fakeRun(roleCalls), changedFilesFn: () => [path.join(dir, "x.ts")] });
    expect(roleCalls[0]!.prompt).toContain("Set HOME=/private/tmp for Godot.");

    const protoCalls: RunSessionParams[] = [];
    await cmdPrototype(ctx, "try it", { runSessionFn: fakeRun(protoCalls) });
    expect(protoCalls[0]!.prompt).toContain("Set HOME=/private/tmp for Godot.");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not inject an environment section when environment.md is missing or empty", async () => {
    const missing = await makeCtx();
    const callsA: RunSessionParams[] = [];
    await generateItem({
      ctx: missing.ctx,
      item: { id: "item-001", title: "t", summary: "", dependsOn: [], rationale: "" },
      contractText: "c",
      workspaceDir: missing.dir,
      traceDir: missing.dir,
      traceSeq: 1,
      runSessionFn: fakeRun(callsA),
    });
    expect(callsA[0]!.prompt).not.toContain("Environment notes from .sparra/environment.md");

    const empty = await makeCtx();
    fs.writeFileSync(empty.ctx.paths.environment, " \n\t\n");
    const callsB: RunSessionParams[] = [];
    await runRole({ ctx: empty.ctx, roleKind: "generator", brief: "Build it.", runSessionFn: fakeRun(callsB), changedFilesFn: () => [] });
    expect(callsB[0]!.prompt).not.toContain("Environment notes from .sparra/environment.md");

    const callsC: RunSessionParams[] = [];
    await cmdPrototype(empty.ctx, "try it", { runSessionFn: fakeRun(callsC) });
    expect(callsC[0]!.prompt).not.toContain("Environment notes from .sparra/environment.md");
    fs.rmSync(missing.dir, { recursive: true, force: true });
    fs.rmSync(empty.dir, { recursive: true, force: true });
  });
});
