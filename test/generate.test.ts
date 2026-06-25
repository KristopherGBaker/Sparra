import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateItem } from "../src/build/generate.ts";
import { appleConventions, isApplePlatform } from "../src/build/swiftConventions.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

async function ctxFor(mechanism: "ios" | "cli"): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-gen-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  const config = defaultConfig();
  config.exercise.mechanism = mechanism;
  return { ctx: { root: dir, paths, config, store }, dir };
}

const item = { id: "item-001", title: "thing", summary: "", dependsOn: [], rationale: "" };

function fakeRun(capture: (p: RunSessionParams) => void): (p: RunSessionParams) => Promise<RunResult> {
  return async (p) => {
    capture(p);
    return {
      ok: true, subtype: "success", resultText: "{}", sessionId: "s",
      costUsd: 0, tokens: 0, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
    };
  };
}

describe("appleConventions / isApplePlatform", () => {
  it("flags ios mechanism as Apple", async () => {
    const a = await ctxFor("ios");
    const c = await ctxFor("cli");
    expect(isApplePlatform(a.ctx)).toBe(true);
    expect(isApplePlatform(c.ctx)).toBe(false);
    fs.rmSync(a.dir, { recursive: true, force: true });
    fs.rmSync(c.dir, { recursive: true, force: true });
  });

  it("covers the key house rules", () => {
    const t = appleConventions();
    expect(t).toMatch(/XcodeGen/);
    expect(t).toMatch(/Swift Testing/);
    expect(t).toMatch(/@Observable/);
    expect(t).toMatch(/provider seam|PROVIDER SEAM/i);
    expect(t).toMatch(/Shikisha/);
    expect(t).toMatch(/disable-sandbox/); // don't bake build-env workarounds into project.yml
    expect(t).toMatch(/debounce|per-keystroke/); // deterministic UI guidance
  });
});

describe("generateItem — Apple conventions injection", () => {
  it("injects the house conventions into the generator prompt for ios builds", async () => {
    const { ctx, dir } = await ctxFor("ios");
    let prompt = "";
    await generateItem({
      ctx, item, contractText: "the contract", workspaceDir: dir, traceDir: dir, traceSeq: 1,
      runSessionFn: fakeRun((p) => (prompt = p.prompt)),
    });
    expect(prompt).toMatch(/HOUSE CONVENTIONS/);
    expect(prompt).toMatch(/Swift Testing/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT inject Swift conventions for a non-Apple (cli) build", async () => {
    const { ctx, dir } = await ctxFor("cli");
    let prompt = "";
    await generateItem({
      ctx, item, contractText: "the contract", workspaceDir: dir, traceDir: dir, traceSeq: 1,
      runSessionFn: fakeRun((p) => (prompt = p.prompt)),
    });
    expect(prompt).not.toMatch(/HOUSE CONVENTIONS/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("routes the generator role to its configured backend", async () => {
    const { ctx, dir } = await ctxFor("cli");
    ctx.config.roles.generator.backend = "codex";
    let backend: string | undefined = "unset";
    await generateItem({
      ctx, item, contractText: "c", workspaceDir: dir, traceDir: dir, traceSeq: 1,
      runSessionFn: fakeRun((p) => (backend = p.backend)),
    });
    expect(backend).toBe("codex");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves the backend unset (→ claude default) when not configured", async () => {
    const { ctx, dir } = await ctxFor("cli");
    let backend: string | undefined = "unset";
    await generateItem({
      ctx, item, contractText: "c", workspaceDir: dir, traceDir: dir, traceSeq: 1,
      runSessionFn: fakeRun((p) => (backend = p.backend)),
    });
    expect(backend).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
