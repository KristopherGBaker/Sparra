import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCtxForRole, type Ctx } from "../src/context.ts";
import { runRole } from "../src/build/roleRun.ts";
import { defaultConfig } from "../src/config.ts";
import { autonomousPermissionMode, ensureAutoProbed } from "../src/sdk/guard.ts";
import { StateStore } from "../src/state.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

/** A no-op probeAuto injection — keeps loadCtxForRole offline (no live SDK probe). */
const noProbe = async (_ctx: Ctx, _persisted: boolean): Promise<void> => {};

/** A probeAuto built on the real ensureAutoProbed but with an injected fake probe. */
function fakeProbeAuto(returns: boolean, counter: { n: number }) {
  return (ctx: Ctx, persisted: boolean) =>
    ensureAutoProbed(ctx, {
      persist: persisted,
      probe: async () => {
        counter.n++;
        return returns;
      },
    });
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

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sparra-ctxrole-"));
}

describe("loadCtxForRole — config-less fallback", () => {
  it("returns a default-backed ctx (greenfield store) when .sparra/ is absent, and writes nothing", async () => {
    const dir = tmpdir();
    try {
      const ctx = await loadCtxForRole(dir, { probeAuto: noProbe });
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
      const ctx = await loadCtxForRole(dir, { probeAuto: noProbe });
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
      const ctx = await loadCtxForRole(dir, { probeAuto: noProbe });
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
      const ctx = await loadCtxForRole(dir, { probeAuto: noProbe });
      expect(ctx.store.data.mode).toBe("existing");
      expect(ctx.store.data.phase).toBe("build");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Write a minimal real .sparra/state.json so StateStore.load returns non-null. */
function writePersistedState(dir: string): void {
  fs.mkdirSync(path.join(dir, ".sparra"), { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(dir, ".sparra", "state.json"),
    JSON.stringify({
      version: 1,
      mode: "existing",
      phase: "build",
      createdAt: now,
      updatedAt: now,
      planning: { turns: 0 },
      freeze: {},
      build: { items: {} },
      sessions: {},
    })
  );
}

describe("loadCtxForRole — auto probe (cached, no-litter, offline)", () => {
  it("persisted state.json + probe⇒true ⇒ mode 'auto', autoSupported true, persisted to disk", async () => {
    const dir = tmpdir();
    try {
      writePersistedState(dir);
      const counter = { n: 0 };
      const ctx = await loadCtxForRole(dir, { probeAuto: fakeProbeAuto(true, counter) });
      expect(counter.n).toBe(1);
      expect(ctx.store.data.autoSupported).toBe(true);
      expect(autonomousPermissionMode(ctx)).toBe("auto");
      // Re-load from disk: the result was cached/persisted.
      const reloaded = await StateStore.load(ctx.paths);
      expect(reloaded?.data.autoSupported).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("greenfield/config-less + probe⇒true ⇒ mode 'auto' in memory, but no .sparra litter", async () => {
    const dir = tmpdir();
    try {
      const counter = { n: 0 };
      const ctx = await loadCtxForRole(dir, { probeAuto: fakeProbeAuto(true, counter) });
      expect(counter.n).toBe(1);
      expect(ctx.store.data.autoSupported).toBe(true);
      expect(autonomousPermissionMode(ctx)).toBe("auto");
      // Memory-only: nothing was written to the repo.
      expect(fs.existsSync(path.join(dir, ".sparra"))).toBe(false);
      expect(fs.existsSync(ctx.paths.state)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("probe⇒false ⇒ mode 'acceptEdits', no throw", async () => {
    const dir = tmpdir();
    try {
      const counter = { n: 0 };
      const ctx = await loadCtxForRole(dir, { probeAuto: fakeProbeAuto(false, counter) });
      expect(counter.n).toBe(1);
      expect(ctx.store.data.autoSupported).toBe(false);
      expect(autonomousPermissionMode(ctx)).toBe("acceptEdits");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("autoSupported already set ⇒ probe never called (short-circuit)", async () => {
    const dir = tmpdir();
    try {
      writePersistedState(dir);
      // Pre-set the cached flag in the persisted state.
      const path0 = path.join(dir, ".sparra", "state.json");
      const data = JSON.parse(fs.readFileSync(path0, "utf8"));
      data.autoSupported = true;
      fs.writeFileSync(path0, JSON.stringify(data));
      const counter = { n: 0 };
      const ctx = await loadCtxForRole(dir, { probeAuto: fakeProbeAuto(false, counter) });
      expect(counter.n).toBe(0);
      expect(autonomousPermissionMode(ctx)).toBe("auto");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("permission.mode does NOT want auto (acceptEdits) ⇒ probe never called, mode 'acceptEdits'", async () => {
    const dir = tmpdir();
    try {
      fs.mkdirSync(path.join(dir, ".sparra"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".sparra", "config.yaml"), "permission:\n  mode: acceptEdits\n");
      const counter = { n: 0 };
      const ctx = await loadCtxForRole(dir, { probeAuto: fakeProbeAuto(true, counter) });
      expect(counter.n).toBe(0);
      expect(autonomousPermissionMode(ctx)).toBe("acceptEdits");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
