import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import { seedPrompts } from "../src/prompts.ts";
import { cmdReflect, upstreamInboxDir } from "../src/phases/reflect.ts";
import type { Ctx } from "../src/context.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

const savedHome = process.env.SPARRA_HOME;

afterEach(() => {
  if (savedHome === undefined) delete process.env.SPARRA_HOME;
  else process.env.SPARRA_HOME = savedHome;
});

async function ctxFor(): Promise<{ ctx: Ctx; dir: string; home: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-role-reflect-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-home-"));
  process.env.SPARRA_HOME = home;
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  await seedPrompts(paths);
  const store = StateStore.create(paths, "existing");
  store.data.autoSupported = false;
  return { ctx: { root: dir, paths, config: defaultConfig(), store }, dir, home };
}

function okResult(): RunResult {
  return {
    ok: true,
    subtype: "success",
    resultText: "done",
    sessionId: "s",
    costUsd: 0,
    tokens: 0,
    numTurns: 1,
    hitMaxTurns: false,
    hitBudget: false,
    errors: [],
    tracePath: "",
  };
}

function recorder(sideEffect?: (p: RunSessionParams) => void) {
  const calls: RunSessionParams[] = [];
  const fn = async (p: RunSessionParams): Promise<RunResult> => {
    calls.push(p);
    sideEffect?.(p);
    return okResult();
  };
  return { calls, fn };
}

function captureStdout(): { buf: () => string; restore: () => void } {
  // The logger is silenced under vitest; lift the gate via the documented escape hatch while capturing.
  const priorLogInTests = process.env.SPARRA_LOG_IN_TESTS;
  process.env.SPARRA_LOG_IN_TESTS = "1";
  let buf = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
  return {
    buf: () => buf,
    restore: () => {
      spy.mockRestore();
      if (priorLogInTests === undefined) delete process.env.SPARRA_LOG_IN_TESTS;
      else process.env.SPARRA_LOG_IN_TESTS = priorLogInTests;
    },
  };
}

function roleTrace(ctx: Ctx, kind: string, body: string, suffix = "2026-07-03T00-00-00-abcdef12"): string {
  const dir = path.join(ctx.paths.traces, `role-run-${kind}-${suffix}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `01-role-run-${kind}.md`), body);
  return dir;
}

function allText(dir: string): string {
  let out = "";
  const visit = (p: string) => {
    for (const name of fs.readdirSync(p)) {
      const child = path.join(p, name);
      const st = fs.statSync(child);
      if (st.isDirectory()) visit(child);
      else out += fs.readFileSync(child, "utf8") + "\n";
    }
  };
  visit(dir);
  return out;
}

function reflectDir(ctx: Ctx): string {
  const names = fs.readdirSync(ctx.paths.reflect).filter((n) => n.startsWith("reflect-")).sort();
  return path.join(ctx.paths.reflect, names.at(-1)!);
}

function roleInputDir(ctx: Ctx): string {
  const dirs = fs
    .readdirSync(ctx.paths.reflect)
    .filter((n) => n.startsWith("reflect-") && fs.existsSync(path.join(ctx.paths.reflect, n, "input")))
    .sort();
  return path.join(ctx.paths.reflect, dirs.at(-1)!, "input");
}

function requestText(p: RunSessionParams): string {
  return [p.prompt, p.systemPrompt, p.cwd, ...(p.additionalDirectories ?? [])].join("\n");
}

describe("cmdReflect over role-run traces", () => {
  it("auto-discovers role-run dirs, bundles non-evaluator bodies, and ignores sibling trace dirs", async () => {
    const { ctx, dir } = await ctxFor();
    try {
      roleTrace(ctx, "generator", "GENERATOR BODY");
      roleTrace(ctx, "evaluator", "EVALUATOR BODY SECRET", "2026-07-03T00-00-01-abcdef12");
      fs.mkdirSync(path.join(ctx.paths.traces, "build-2026-ignored"), { recursive: true });
      fs.writeFileSync(path.join(ctx.paths.traces, "build-2026-ignored", "01-generator.md"), "BUILD BODY");
      fs.mkdirSync(path.join(ctx.paths.traces, "junk"), { recursive: true });
      fs.writeFileSync(path.join(ctx.paths.traces, "junk", "01.md"), "JUNK BODY");

      const rec = recorder();
      await cmdReflect(ctx, { runSessionFn: rec.fn });

      expect(rec.calls).toHaveLength(1);
      const p = rec.calls[0]!;
      const input = path.join(reflectDir(ctx), "input");
      const bundled = allText(input);
      expect(bundled).toContain("GENERATOR BODY");
      expect(bundled).not.toContain("EVALUATOR BODY SECRET");
      expect(bundled).not.toContain("BUILD BODY");
      expect(bundled).not.toContain("JUNK BODY");
      expect(bundled).toContain("role-run-evaluator-2026-07-03T00-00-01-abcdef12: EXCLUDED");
      expect(p.prompt).toContain(path.relative(ctx.root, input));
      expect(p.prompt).toContain("selected interactive role-run traces");
      expect(p.prompt).not.toContain("last build run");
      expect(requestText(p)).not.toContain(path.relative(ctx.root, ctx.paths.traces));
      expect(requestText(p)).not.toContain(ctx.paths.traces);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("friendly-exits when there is no build run and no role-run trace", async () => {
    const { ctx, dir } = await ctxFor();
    const cap = captureStdout();
    try {
      const rec = recorder();
      await cmdReflect(ctx, { runSessionFn: rec.fn });
      expect(rec.calls).toHaveLength(0);
      expect(cap.buf()).toContain("sparra build");
      expect(cap.buf()).toContain("role-run");
      expect(cap.buf()).toContain("--traces");
    } finally {
      cap.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the post-reflect session window and lets --traces override it", async () => {
    const { ctx, dir } = await ctxFor();
    try {
      const older = roleTrace(ctx, "generator", "OLD BODY", "2026-07-03T00-00-00-aaaaaaaa");
      const newer = roleTrace(ctx, "generator", "NEW BODY", "2026-07-03T00-00-01-bbbbbbbb");
      const prior = path.join(ctx.paths.reflect, "reflect-prior");
      fs.mkdirSync(prior, { recursive: true });
      const base = new Date("2026-07-03T00:00:00Z");
      fs.utimesSync(older, new Date(base.getTime() - 10_000), new Date(base.getTime() - 10_000));
      fs.utimesSync(prior, base, base);
      fs.utimesSync(newer, new Date(base.getTime() + 10_000), new Date(base.getTime() + 10_000));

      const rec = recorder();
      await cmdReflect(ctx, { runSessionFn: rec.fn });
      expect(rec.calls).toHaveLength(1);
      expect(allText(roleInputDir(ctx))).toContain("NEW BODY");
      expect(allText(roleInputDir(ctx))).not.toContain("OLD BODY");

      const { ctx: ctx2, dir: dir2 } = await ctxFor();
      try {
        const onlyOld = roleTrace(ctx2, "generator", "ONLY OLD", "2026-07-03T00-00-00-cccccccc");
        const prior2 = path.join(ctx2.paths.reflect, "reflect-prior");
        fs.mkdirSync(prior2, { recursive: true });
        fs.utimesSync(onlyOld, new Date(base.getTime() - 10_000), new Date(base.getTime() - 10_000));
        fs.utimesSync(prior2, base, base);
        const cap = captureStdout();
        try {
          const rec2 = recorder();
          await cmdReflect(ctx2, { runSessionFn: rec2.fn });
          expect(rec2.calls).toHaveLength(0);
          expect(cap.buf()).toContain("--traces");
        } finally {
          cap.restore();
        }
      } finally {
        fs.rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--traces direct dir overrides a build run and omits optional empty verdict/contract dirs", async () => {
    const { ctx, dir } = await ctxFor();
    try {
      ctx.store.data.build.runId = "build-present";
      const buildDir = ctx.paths.traceDir("build-present");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "01-generator.md"), "BUILD RUN BODY");
      const gen = roleTrace(ctx, "generator", "DIRECT ROLE BODY");

      const rec = recorder();
      await cmdReflect(ctx, { traces: gen, runSessionFn: rec.fn });
      expect(rec.calls).toHaveLength(1);
      expect(allText(path.join(reflectDir(ctx), "input"))).toContain("DIRECT ROLE BODY");
      expect(rec.calls[0]!.prompt).not.toContain("BUILD RUN BODY");
      expect(rec.calls[0]!.prompt).not.toContain("Verdicts:");
      expect(rec.calls[0]!.prompt).not.toContain("Contracts:");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--traces glob bundles multiple generators and excludes evaluator matches with a warning", async () => {
    const { ctx, dir } = await ctxFor();
    const cap = captureStdout();
    try {
      roleTrace(ctx, "generator", "GEN A", "2026-07-03T00-00-00-11111111");
      roleTrace(ctx, "generator", "GEN B", "2026-07-03T00-00-01-22222222");
      roleTrace(ctx, "evaluator", "EVAL CANARY BODY", "2026-07-03T00-00-02-33333333");
      const rec = recorder();
      await cmdReflect(ctx, { traces: path.join(ctx.paths.traces, "role-run-*"), runSessionFn: rec.fn });
      expect(rec.calls).toHaveLength(1);
      const text = allText(path.join(reflectDir(ctx), "input"));
      expect(text).toContain("GEN A");
      expect(text).toContain("GEN B");
      expect(text).not.toContain("EVAL CANARY BODY");
      expect(cap.buf()).toContain("Excluded evaluator trace");
    } finally {
      cap.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--traces only evaluator dirs or no matches runs no session with a friendly warning", async () => {
    const { ctx, dir } = await ctxFor();
    const cap = captureStdout();
    try {
      roleTrace(ctx, "evaluator", "EVAL ONLY", "2026-07-03T00-00-02-33333333");
      const rec = recorder();
      await cmdReflect(ctx, { traces: path.join(ctx.paths.traces, "role-run-evaluator-*"), runSessionFn: rec.fn });
      expect(rec.calls).toHaveLength(0);
      expect(cap.buf()).toContain("holdout-bearing");
      const rec2 = recorder();
      await cmdReflect(ctx, { traces: path.join(ctx.paths.traces, "role-run-generator-NOPE-*"), runSessionFn: rec2.fn });
      expect(rec2.calls).toHaveLength(0);
      expect(cap.buf()).toContain("role-run-generator-NOPE-*");
    } finally {
      cap.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("references optional verdicts when present and still runs without contracts", async () => {
    const { ctx, dir } = await ctxFor();
    try {
      roleTrace(ctx, "generator", "GEN");
      fs.writeFileSync(path.join(ctx.paths.verdicts, "r1.md"), "VERDICT");
      const rec = recorder();
      await cmdReflect(ctx, { runSessionFn: rec.fn });
      expect(rec.calls).toHaveLength(1);
      expect(rec.calls[0]!.prompt).toContain("Verdicts, when produced");
      expect(rec.calls[0]!.prompt).not.toContain("Contracts, when produced");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps evaluator holdout canaries out of bundle/request and redacts routed upstream output", async () => {
    for (const backend of ["claude", "codex"]) {
      const { ctx, dir, home } = await ctxFor();
      try {
        ctx.config.roles.reflector.backend = backend;
        const canary = `DO NOT LEAK THIS HOLDOUT CANARY ${backend}`;
        fs.writeFileSync(ctx.paths.holdout, canary + "\n");
        roleTrace(ctx, "generator", "SAFE GENERATOR BODY");
        roleTrace(ctx, "evaluator", `evaluator quoted ${canary}`, "2026-07-03T00-00-01-abcdef12");
        const rec = recorder((p) => {
          const outDir = path.dirname(p.traceDir!);
          fs.writeFileSync(path.join(outDir, "upstream.md"), `${canary}\n### Finding\nnon-holdout finding ${backend}`);
        });

        await cmdReflect(ctx, { runSessionFn: rec.fn });

        expect(rec.calls).toHaveLength(1);
        const p = rec.calls[0]!;
        expect(p.backend).toBe(backend);
        expect(allText(path.join(reflectDir(ctx), "input"))).not.toContain(canary);
        expect(requestText(p)).not.toContain(canary);
        expect(requestText(p)).not.toContain(path.relative(ctx.root, ctx.paths.traces));
        const files = fs.readdirSync(path.join(home, "reflections")).filter((f) => f.endsWith(".md"));
        expect(files).toHaveLength(1);
        const routed = fs.readFileSync(path.join(upstreamInboxDir(), files[0]!), "utf8");
        expect(routed).toContain("[redacted: holdout]");
        expect(routed).not.toContain(canary);
        expect(routed).toContain(`non-holdout finding ${backend}`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("keeps project-local candidates local while routing only upstream findings", async () => {
    const { ctx, dir, home } = await ctxFor();
    try {
      roleTrace(ctx, "generator", "GEN");
      const rec = recorder((p) => {
        const outDir = path.dirname(p.traceDir!);
        fs.writeFileSync(path.join(outDir, "candidates", "evaluator.md"), "NEW EVALUATOR");
        fs.writeFileSync(path.join(outDir, "SUMMARY.md"), "summary");
      });
      await cmdReflect(ctx, { runSessionFn: rec.fn });
      const outDir = reflectDir(ctx);
      expect(fs.readFileSync(path.join(outDir, "candidates", "evaluator.md"), "utf8")).toBe("NEW EVALUATOR");
      expect(fs.readFileSync(path.join(outDir, "SUMMARY.md"), "utf8")).toBe("summary");
      expect(fs.existsSync(path.join(home, "reflections"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
