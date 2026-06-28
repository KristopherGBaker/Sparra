import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCtxForRole } from "../src/context.ts";
import { runRole } from "../src/build/roleRun.ts";
import { defaultConfig } from "../src/config.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

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

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sparra-ctxrole-"));
}

describe("loadCtxForRole — config-less fallback", () => {
  it("returns a default-backed ctx (greenfield store) when .sparra/ is absent, and writes nothing", async () => {
    const dir = tmpdir();
    try {
      const ctx = await loadCtxForRole(dir);
      const def = defaultConfig();
      expect(ctx.config.rubric.passThreshold).toBe(75);
      expect(ctx.config.rubric.passThreshold).toBe(def.rubric.passThreshold);
      expect(ctx.config.roles.evaluator.backend).toBe(def.roles.evaluator.backend);
      expect(ctx.store).not.toBeNull();
      expect(ctx.store.data.mode).toBe("greenfield");
      // The load must not litter the repo root with a .sparra/ tree or state.json.
      expect(fs.existsSync(path.join(dir, ".sparra"))).toBe(false);
      expect(fs.existsSync(ctx.paths.state)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs an evaluator role on the config-less ctx without throwing (produces a verdict)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await loadCtxForRole(dir);
      const rec = recorder();
      const r = await runRole({ ctx, roleKind: "evaluator", brief: "grade", runSessionFn: rec.fn });
      expect(r.verdict?.verdict).toBe("pass");
      expect(rec.calls).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadCtxForRole — existing config honored (fallback only)", () => {
  it("reflects a non-default .sparra/config.yaml (passThreshold + evaluator backend)", async () => {
    const dir = tmpdir();
    try {
      fs.mkdirSync(path.join(dir, ".sparra"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".sparra", "config.yaml"),
        "rubric:\n  passThreshold: 90\nroles:\n  evaluator:\n    backend: codex\n"
      );
      const ctx = await loadCtxForRole(dir);
      expect(ctx.config.rubric.passThreshold).toBe(90);
      expect(ctx.config.roles.evaluator.backend).toBe("codex");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses an existing state.json's mode instead of synthesizing greenfield", async () => {
    const dir = tmpdir();
    try {
      fs.mkdirSync(path.join(dir, ".sparra"), { recursive: true });
      const now = new Date().toISOString();
      const state = {
        version: 1,
        mode: "existing",
        phase: "build",
        createdAt: now,
        updatedAt: now,
        planning: { turns: 0 },
        freeze: {},
        build: { items: {} },
        sessions: {},
      };
      fs.writeFileSync(path.join(dir, ".sparra", "state.json"), JSON.stringify(state));
      const ctx = await loadCtxForRole(dir);
      expect(ctx.store.data.mode).toBe("existing");
      expect(ctx.store.data.phase).toBe("build");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
