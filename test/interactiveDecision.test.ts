import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import {
  activePause,
  applyDecision,
  readPauseSummary,
  readRoundDecision,
  readCommitDecision,
  readItemDecision,
  pauseDir,
  PAUSE_DECISIONS,
} from "../src/build/interactive.ts";

// Pure decision-plumbing tests for the programmatic pause API (round-trips with the
// resume readers). Uses a temp `.sparra`, injects nothing live.

async function makeCtx(): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-decision-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  return { ctx: { root: dir, paths, config: defaultConfig(), store }, dir };
}

const RUN = "build-test";
const ITEM = "item-001";

describe("applyDecision — round-trips with the resume readers", () => {
  it("round: writes decision.json + feedback.md that readRoundDecision reads back identically", async () => {
    const { ctx, dir } = await makeCtx();
    await applyDecision(ctx.paths, RUN, ITEM, { kind: "round", decision: "accept", reason: "ship it", feedback: "FOCUS: parser" });
    const res = await readRoundDecision(ctx, RUN, ITEM);
    expect(res.decision).toBe("accept");
    expect(res.reason).toBe("ship it");
    expect(res.feedback).toBe("FOCUS: parser");
    // and the on-disk shape is exactly what the resume path expects
    const raw = JSON.parse(fs.readFileSync(path.join(pauseDir(ctx, RUN, ITEM), "decision.json"), "utf8"));
    expect(raw).toEqual({ decision: "accept", reason: "ship it" });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("omits feedback.md when no feedback is provided", async () => {
    const { ctx, dir } = await makeCtx();
    await applyDecision(ctx.paths, RUN, ITEM, { kind: "round", decision: "abandon" });
    expect(fs.existsSync(path.join(pauseDir(ctx, RUN, ITEM), "feedback.md"))).toBe(false);
    const res = await readRoundDecision(ctx, RUN, ITEM);
    expect(res.decision).toBe("abandon");
    expect(res.feedback).toBe("");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("commit: round-trips with readCommitDecision", async () => {
    const { ctx, dir } = await makeCtx();
    await applyDecision(ctx.paths, RUN, ITEM, { kind: "commit", decision: "skip" });
    expect(await readCommitDecision(ctx, RUN, ITEM)).toBe("skip");
    await applyDecision(ctx.paths, RUN, ITEM, { kind: "commit", decision: "commit" });
    expect(await readCommitDecision(ctx, RUN, ITEM)).toBe("commit");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("item: round-trips with readItemDecision", async () => {
    const { ctx, dir } = await makeCtx();
    await applyDecision(ctx.paths, RUN, ITEM, { kind: "item", decision: "stop" });
    expect(await readItemDecision(ctx, RUN, ITEM)).toBe("stop");
    await applyDecision(ctx.paths, RUN, ITEM, { kind: "item", decision: "continue" });
    expect(await readItemDecision(ctx, RUN, ITEM)).toBe("continue");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("contract: records the no-op resume without crashing", async () => {
    const { ctx, dir } = await makeCtx();
    await applyDecision(ctx.paths, RUN, ITEM, { kind: "contract", decision: "resume" });
    const raw = JSON.parse(fs.readFileSync(path.join(pauseDir(ctx, RUN, ITEM), "decision.json"), "utf8"));
    expect(raw.decision).toBe("resume");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("applyDecision — validates against the kind's allowed set", () => {
  it("rejects a decision not allowed for the kind", async () => {
    const { ctx, dir } = await makeCtx();
    await expect(applyDecision(ctx.paths, RUN, ITEM, { kind: "round", decision: "commit" })).rejects.toThrow(/invalid|expected/i);
    await expect(applyDecision(ctx.paths, RUN, ITEM, { kind: "commit", decision: "continue" })).rejects.toThrow();
    await expect(applyDecision(ctx.paths, RUN, ITEM, { kind: "item", decision: "pivot" })).rejects.toThrow();
    await expect(applyDecision(ctx.paths, RUN, ITEM, { kind: "contract", decision: "accept" })).rejects.toThrow();
    // nothing written on a rejected decision
    expect(fs.existsSync(path.join(pauseDir(ctx, RUN, ITEM), "decision.json"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts every decision the allowed set advertises", async () => {
    const { ctx, dir } = await makeCtx();
    for (const [kind, decisions] of Object.entries(PAUSE_DECISIONS)) {
      for (const d of decisions) {
        await applyDecision(ctx.paths, RUN, `${kind}-${d}`, { kind: kind as keyof typeof PAUSE_DECISIONS, decision: d });
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("activePause", () => {
  it("returns null when nothing is paused (and for a null state)", async () => {
    const { ctx, dir } = await makeCtx();
    expect(activePause(null)).toBeNull();
    expect(activePause(undefined)).toBeNull();
    expect(activePause(ctx.store.data)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns the descriptor when a pause is set", async () => {
    const { ctx, dir } = await makeCtx();
    ctx.store.data.build.paused = { kind: "round", itemId: ITEM, round: 3 };
    expect(activePause(ctx.store.data)).toEqual({ kind: "round", itemId: ITEM, round: 3 });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("readPauseSummary", () => {
  it("returns the pause.md text, or '' when missing", async () => {
    const { ctx, dir } = await makeCtx();
    expect(await readPauseSummary(ctx.paths, RUN, ITEM)).toBe("");
    const pd = pauseDir(ctx, RUN, ITEM);
    fs.mkdirSync(pd, { recursive: true });
    fs.writeFileSync(path.join(pd, "pause.md"), "# Paused — review me\n");
    expect(await readPauseSummary(ctx.paths, RUN, ITEM)).toBe("# Paused — review me\n");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
