import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmdNew } from "../src/phases/new.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";

async function project(): Promise<{ ctx: Ctx; dir: string; paths: Paths }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-new-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  // A finished cycle: one passed item, a run id, frozen, phase done.
  store.data.phase = "done";
  store.data.build.runId = "build-x";
  store.data.build.items = { "item-001": { status: "passed", round: 2, pivots: 0, criterionFailStreak: {}, lastScore: 86.4 } };
  store.data.freeze = { frozenAt: "2026-06-25T00:00:00Z" };
  await store.save();

  // Working-set artifacts + cross-cycle artifacts.
  fs.writeFileSync(paths.plan, "# Plan: First Feature\n\nold plan content");
  fs.writeFileSync(paths.frozenPlan, "frozen first feature");
  fs.writeFileSync(paths.workitemsFile, JSON.stringify([{ id: "item-001", title: "t" }]));
  fs.writeFileSync(paths.contractFile("item-001"), "contract");
  fs.writeFileSync(paths.verdictFile("item-001", 1), "verdict");
  fs.writeFileSync(paths.reviewFile("item-001", 1), "review");
  fs.writeFileSync(paths.memory, "# Sparra memory\n- learned a thing");
  fs.writeFileSync(paths.changelog, "# Changelog\n");
  fs.mkdirSync(paths.traceDir("build-x"), { recursive: true });
  fs.writeFileSync(path.join(paths.traceDir("build-x"), "01-generator.md"), "trace");

  return { ctx: { root: dir, paths, config: defaultConfig(), store } as unknown as Ctx, dir, paths };
}

describe("cmdNew", () => {
  it("archives the finished cycle and resets for a fresh plan", async () => {
    const { ctx, dir, paths } = await project();
    await cmdNew(ctx, "Second Feature");

    const cd = paths.cycleDir("0001-second-feature");
    // Working set was moved into the archive.
    expect(fs.existsSync(path.join(cd, "PLAN.md"))).toBe(true);
    expect(fs.readFileSync(path.join(cd, "PLAN.md"), "utf8")).toContain("First Feature");
    expect(fs.existsSync(path.join(cd, "frozen", "PLAN.frozen.md"))).toBe(true);
    expect(fs.existsSync(path.join(cd, "workitems", "items.json"))).toBe(true);
    expect(fs.existsSync(path.join(cd, "contracts", "item-001.contract.md"))).toBe(true);
    expect(fs.existsSync(path.join(cd, "verdicts", "item-001.r1.verdict.md"))).toBe(true);
    expect(fs.existsSync(path.join(cd, "reviews", "item-001.r1.review.md"))).toBe(true);
    expect(fs.existsSync(path.join(cd, "traces", "build-x", "01-generator.md"))).toBe(true);

    // cycle.json manifest captured what happened.
    const manifest = JSON.parse(fs.readFileSync(path.join(cd, "cycle.json"), "utf8"));
    expect(manifest.n).toBe(1);
    expect(manifest.runId).toBe("build-x");
    expect(manifest.items[0]).toMatchObject({ id: "item-001", status: "passed" });

    // Working set is reset: fresh plan, no leftover items/contracts.
    expect(fs.existsSync(paths.workitemsFile)).toBe(false);
    expect(fs.existsSync(paths.contractFile("item-001"))).toBe(false);
    const fresh = fs.readFileSync(paths.plan, "utf8");
    expect(fresh).toContain("# Plan: Second Feature");
    expect(fresh).not.toContain("old plan content");

    // Cross-cycle artifacts carried forward.
    expect(fs.existsSync(paths.memory)).toBe(true);
    expect(fs.readFileSync(paths.memory, "utf8")).toContain("learned a thing");
    expect(fs.existsSync(paths.changelog)).toBe(true);

    // State reset.
    expect(ctx.store.data.phase).toBe("plan");
    expect(Object.keys(ctx.store.data.build.items)).toHaveLength(0);
    expect(ctx.store.data.build.runId).toBeUndefined();
    expect(ctx.store.data.freeze.frozenAt).toBeUndefined();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("numbers cycles monotonically", async () => {
    const { ctx, dir, paths } = await project();
    await cmdNew(ctx, "Second");
    // Re-stage a tiny working set, then start a third cycle.
    fs.writeFileSync(paths.workitemsFile, "[]");
    await cmdNew(ctx, "Third");
    expect(fs.existsSync(paths.cycleDir("0001-second"))).toBe(true);
    expect(fs.existsSync(paths.cycleDir("0002-third"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
