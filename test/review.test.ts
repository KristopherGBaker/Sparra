import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reviewItem } from "../src/build/review.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

async function ctxFor(blockOn: "high" | "all" | "none"): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-review-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  const config = defaultConfig();
  config.review.blockOn = blockOn;
  return { ctx: { root: dir, paths, config, store }, dir };
}

const item = { id: "item-001", title: "thing", summary: "", dependsOn: [], rationale: "" };

function fakeRun(resultText: string): (p: RunSessionParams) => Promise<RunResult> {
  return async () => ({
    ok: true, subtype: "success", resultText, sessionId: "r", costUsd: 0, tokens: 0,
    numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
  });
}

const FINDINGS =
  '```json\n{"findings":[' +
  '{"severity":"blocking","file":"App.swift","line":5,"issue":"committed API key","why":"secret leak","fix":"move to Keychain"},' +
  '{"severity":"advisory","file":"View.swift","issue":"duplicated layout","why":"maintainability"}' +
  '],"summary":"one blocker"}\n```';

async function review(blockOn: "high" | "all" | "none", text = FINDINGS) {
  const { ctx, dir } = await ctxFor(blockOn);
  const r = await reviewItem({
    ctx, item, contractText: "c", workspaceDir: dir, round: 1, traceDir: dir, traceSeq: 1,
    runSessionFn: fakeRun(text),
  });
  return { r, ctx, dir };
}

describe("reviewItem", () => {
  it("blockOn=high blocks only blocking-severity findings", async () => {
    const { r, dir } = await review("high");
    expect(r.findings).toHaveLength(2);
    expect(r.blocking).toHaveLength(1);
    expect(r.blocking[0]).toMatch(/App\.swift:5/);
    expect(r.advisory).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("blockOn=all blocks advisory findings too", async () => {
    const { r, dir } = await review("all");
    expect(r.blocking).toHaveLength(2);
    expect(r.advisory).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("blockOn=none never blocks (advisory-only)", async () => {
    const { r, dir } = await review("none");
    expect(r.blocking).toHaveLength(0);
    expect(r.advisory).toHaveLength(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("clean code → no findings, nothing blocks", async () => {
    const { r, dir } = await review("high", '```json\n{"findings":[],"summary":"clean"}\n```');
    expect(r.findings).toHaveLength(0);
    expect(r.blocking).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes a review file", async () => {
    const { ctx, dir } = await review("high");
    expect(fs.existsSync(ctx.paths.reviewFile("item-001", 1))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
