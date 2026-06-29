import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import { seedPrompts } from "../src/prompts.ts";
import { recordDeviations, reconcilePlan } from "../src/build/reconcile.ts";
import { cmdReflect, applyReflection } from "../src/phases/reflect.ts";
import type { Ctx } from "../src/context.ts";
import type { Deviation } from "../src/build/generate.ts";
import type { WorkItem } from "../src/build/types.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

/** A scaffolded, seeded ctx in a throwaway temp dir. autoSupported is pre-set so no live SDK probe fires. */
async function ctxFor(seed = true): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-reflect-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  if (seed) await seedPrompts(paths);
  const store = StateStore.create(paths, "existing");
  store.data.autoSupported = false; // short-circuits ensureAutoProbed → fully offline
  return { ctx: { root: dir, paths, config: defaultConfig(), store }, dir };
}

/** A success RunResult skeleton. */
function okResult(): RunResult {
  return {
    ok: true, subtype: "success", resultText: "done", sessionId: "s",
    costUsd: 0, tokens: 0, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
  };
}

/** A fake session that records every request and (optionally) simulates the agent's file writes. */
function recorder(sideEffect?: (p: RunSessionParams) => void) {
  const calls: RunSessionParams[] = [];
  const fn = async (p: RunSessionParams): Promise<RunResult> => {
    calls.push(p);
    sideEffect?.(p);
    return okResult();
  };
  return { calls, fn };
}

const item: WorkItem = { id: "I1", title: "Add a thing" } as WorkItem;

const dev = (scope: Deviation["scope"], summary = "did X", rationale = "because Y"): Deviation => ({ summary, rationale, scope });

// ───────────────────────────── recordDeviations (pure, deterministic) ─────────────────────────────

describe("recordDeviations", () => {
  it("appends in-scope deviations to CHANGELOG.md with item heading + rationale", async () => {
    const { ctx, dir } = await ctxFor();
    try {
      const r = await recordDeviations(ctx, item, [dev("in-scope", "renamed a flag"), dev("in-scope", "tightened a guard")]);
      expect(r).toEqual({ changelog: 2, proposals: 0 });
      const log = fs.readFileSync(ctx.paths.changelog, "utf8");
      expect(log).toContain("I1 — Add a thing");
      expect(log).toContain("renamed a flag");
      expect(log).toContain("_rationale:_ because Y");
      // no proposals dir entries
      expect(fs.existsSync(ctx.paths.proposals) ? fs.readdirSync(ctx.paths.proposals) : []).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes out-of-scope deviations as human-decision proposals, one file each, NOT to CHANGELOG", async () => {
    const { ctx, dir } = await ctxFor();
    try {
      const r = await recordDeviations(ctx, item, [dev("out-of-scope", "bigger refactor"), dev("out-of-scope", "new dep")]);
      expect(r).toEqual({ changelog: 0, proposals: 2 });
      const files = fs.readdirSync(ctx.paths.proposals).sort();
      expect(files).toEqual(["I1-1.md", "I1-2.md"]);
      const p1 = fs.readFileSync(path.join(ctx.paths.proposals, "I1-1.md"), "utf8");
      expect(p1).toContain("OUT OF SCOPE");
      expect(p1).toContain("NOT done autonomously");
      expect(p1).toContain("bigger refactor");
      expect(p1).toMatch(/\[ \] accept/);
      // CHANGELOG untouched
      expect(fs.existsSync(ctx.paths.changelog)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("splits a mixed batch: in-scope → changelog, out-of-scope → proposals", async () => {
    const { ctx, dir } = await ctxFor();
    try {
      const r = await recordDeviations(ctx, item, [dev("in-scope", "A"), dev("out-of-scope", "B"), dev("in-scope", "C")]);
      expect(r).toEqual({ changelog: 2, proposals: 1 });
      const log = fs.readFileSync(ctx.paths.changelog, "utf8");
      expect(log).toContain("A");
      expect(log).toContain("C");
      expect(log).not.toContain("did X — because Y"); // sanity: no garbage
      expect(fs.readdirSync(ctx.paths.proposals)).toEqual(["I1-1.md"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no deviations ⇒ {0,0} and writes nothing", async () => {
    const { ctx, dir } = await ctxFor();
    try {
      const r = await recordDeviations(ctx, item, []);
      expect(r).toEqual({ changelog: 0, proposals: 0 });
      expect(fs.existsSync(ctx.paths.changelog)).toBe(false);
      expect(fs.existsSync(ctx.paths.proposals) ? fs.readdirSync(ctx.paths.proposals) : []).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────── reconcilePlan (session-gated) ─────────────────────────────

describe("reconcilePlan", () => {
  it("no deviations ⇒ short-circuits, the session is NEVER invoked", async () => {
    const { ctx, dir } = await ctxFor();
    try {
      const rec = recorder();
      await reconcilePlan(ctx, item, [], path.join(dir, "trace"), 1, { runSessionFn: rec.fn });
      expect(rec.calls).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with deviations ⇒ runs the planner once, scoped to edit PLAN.md, carrying the deviations in the brief", async () => {
    const { ctx, dir } = await ctxFor();
    try {
      const rec = recorder();
      await reconcilePlan(ctx, item, [dev("in-scope", "kept it lean"), dev("out-of-scope", "future idea")], path.join(dir, "trace"), 3, {
        runSessionFn: rec.fn,
      });
      expect(rec.calls).toHaveLength(1);
      const p = rec.calls[0]!;
      expect(p.role).toBe("reconcile-I1");
      expect(p.systemPrompt).toBeTruthy();
      expect(p.permissionMode).toBe("default");
      // the planner reconciles PLAN.md only
      expect(p.tools).toContain("Edit");
      expect(p.prompt).toContain(ctx.paths.plan);
      // both deviations are surfaced verbatim to the planner
      expect(p.prompt).toContain("kept it lean");
      expect(p.prompt).toContain("future idea");
      expect(p.prompt).toContain("[in-scope]");
      expect(p.prompt).toContain("[out-of-scope]");
      expect(p.traceSeq).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────── cmdReflect (propose) ─────────────────────────────

/** Seed a trace dir for a run so cmdReflect's existence guard passes. */
function seedTrace(ctx: Ctx, runId: string): void {
  const td = ctx.paths.traceDir(runId);
  fs.mkdirSync(td, { recursive: true });
  fs.writeFileSync(path.join(td, "1.json"), "{}");
}

describe("cmdReflect — propose", () => {
  it("no build run + no --run ⇒ warns and never runs a session", async () => {
    const { ctx, dir } = await ctxFor();
    try {
      const rec = recorder();
      ctx.store.data.build.runId = undefined;
      await cmdReflect(ctx, { runSessionFn: rec.fn });
      expect(rec.calls).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runId present but no traces on disk ⇒ warns and never runs a session", async () => {
    const { ctx, dir } = await ctxFor();
    try {
      const rec = recorder();
      await cmdReflect(ctx, { run: "build-missing", runSessionFn: rec.fn });
      expect(rec.calls).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("traces present + reflector writes candidates ⇒ runs reflector once (read+Write scoped), records a learning", async () => {
    const { ctx, dir } = await ctxFor();
    try {
      const runId = "build-xyz";
      seedTrace(ctx, runId);
      // The fake reflector writes a candidate prompt into <outDir>/candidates/, derived from the trace dir it was handed.
      const rec = recorder((p) => {
        const outDir = path.dirname(p.traceDir!);
        fs.writeFileSync(path.join(outDir, "candidates", "evaluator.md"), "IMPROVED EVALUATOR PROMPT");
      });
      await cmdReflect(ctx, { run: runId, runSessionFn: rec.fn });
      expect(rec.calls).toHaveLength(1);
      const p = rec.calls[0]!;
      expect(p.role).toBe("reflector");
      expect(p.tools).toContain("Read");
      expect(p.tools).toContain("Write");
      // The candidate survives on disk under a reflect-<stamp>/candidates dir.
      const reflectDirs = fs.readdirSync(ctx.paths.reflect);
      expect(reflectDirs.length).toBe(1);
      const cand = path.join(ctx.paths.reflect, reflectDirs[0]!, "candidates", "evaluator.md");
      expect(fs.readFileSync(cand, "utf8")).toBe("IMPROVED EVALUATOR PROMPT");
      // a learning was appended to memory naming the reflected run
      const mem = fs.readFileSync(ctx.paths.memory, "utf8");
      expect(mem).toContain(runId);
      expect(mem).toContain("evaluator");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("traces present but reflector writes NO candidates ⇒ runs once, warns, records no learning", async () => {
    const { ctx, dir } = await ctxFor();
    try {
      const runId = "build-empty";
      seedTrace(ctx, runId);
      const rec = recorder(); // no side-effect: no candidate files written
      await cmdReflect(ctx, { run: runId, runSessionFn: rec.fn });
      expect(rec.calls).toHaveLength(1);
      // no learning naming this run (memory either absent or doesn't mention it)
      const mem = fs.existsSync(ctx.paths.memory) ? fs.readFileSync(ctx.paths.memory, "utf8") : "";
      expect(mem).not.toContain(runId);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses ctx.store.data.build.runId when no --run override is given", async () => {
    const { ctx, dir } = await ctxFor();
    try {
      const runId = "build-default";
      ctx.store.data.build.runId = runId;
      seedTrace(ctx, runId);
      const rec = recorder((p) => {
        const outDir = path.dirname(p.traceDir!);
        fs.writeFileSync(path.join(outDir, "candidates", "planner.md"), "NEW");
      });
      await cmdReflect(ctx, { runSessionFn: rec.fn });
      expect(rec.calls).toHaveLength(1);
      expect(rec.calls[0]!.prompt).toContain(runId);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("apply:true delegates to applyReflection and never runs a session", async () => {
    const { ctx, dir } = await ctxFor();
    try {
      const rec = recorder();
      await cmdReflect(ctx, { apply: true, runSessionFn: rec.fn });
      expect(rec.calls).toHaveLength(0); // applyReflection is pure fs; it warns (no proposals) and returns
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────── applyReflection (back up + overwrite live prompts) ─────────────────────────────

/** Write a reflection proposal dir with the given candidate prompts. */
function seedReflection(ctx: Ctx, stamp: string, candidates: Record<string, string>): string {
  const outDir = path.join(ctx.paths.reflect, stamp);
  const candDir = path.join(outDir, "candidates");
  fs.mkdirSync(candDir, { recursive: true });
  for (const [role, body] of Object.entries(candidates)) fs.writeFileSync(path.join(candDir, `${role}.md`), body);
  return outDir;
}

describe("applyReflection", () => {
  it("no reflection proposals ⇒ warns, leaves live prompts untouched", async () => {
    const { ctx, dir } = await ctxFor();
    try {
      const before = fs.readFileSync(ctx.paths.promptFile("evaluator"), "utf8");
      await applyReflection(ctx);
      expect(fs.readFileSync(ctx.paths.promptFile("evaluator"), "utf8")).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backs up the current prompt, then overwrites it from the candidate", async () => {
    const { ctx, dir } = await ctxFor();
    try {
      const live = ctx.paths.promptFile("evaluator");
      const original = fs.readFileSync(live, "utf8");
      const outDir = seedReflection(ctx, "reflect-001", { evaluator: "REPLACED EVALUATOR" });
      await applyReflection(ctx);
      // live now holds the candidate
      expect(fs.readFileSync(live, "utf8")).toBe("REPLACED EVALUATOR");
      // a backup of the ORIGINAL was kept alongside the candidates
      expect(fs.readFileSync(path.join(outDir, "backup", "evaluator.md"), "utf8")).toBe(original);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies the LATEST reflection (lexicographically last stamp) and all of its candidates", async () => {
    const { ctx, dir } = await ctxFor();
    try {
      seedReflection(ctx, "reflect-001", { evaluator: "OLD ONE" });
      seedReflection(ctx, "reflect-002", { evaluator: "NEW EVAL", planner: "NEW PLAN" });
      await applyReflection(ctx);
      expect(fs.readFileSync(ctx.paths.promptFile("evaluator"), "utf8")).toBe("NEW EVAL");
      expect(fs.readFileSync(ctx.paths.promptFile("planner"), "utf8")).toBe("NEW PLAN");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
