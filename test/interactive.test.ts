import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmdBuild, type BuildDeps } from "../src/phases/build.ts";
import { pauseDir, parseSteps, writeCommitPause, writeItemPause } from "../src/build/interactive.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig, type SparraConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import type { WorkItem, Verdict } from "../src/build/types.ts";
import type { GenerateOutput } from "../src/build/generate.ts";
import type { EvalOutput } from "../src/build/evaluate.ts";

function makeVerdict(pass: boolean): Verdict {
  return {
    assertions: [{ id: 1, pass, evidence: "e" }],
    scores: { design: 80, originality: 80, craft: 80, functionality: 80 },
    weightedTotal: pass ? 90 : 30,
    verdict: pass ? "pass" : "fail",
    blocking: pass ? [] : ["something is wrong"],
    notes: "n",
  };
}
const genOut = (over: Partial<GenerateOutput> = {}): GenerateOutput => ({ report: "", deviations: [], sessionId: "g", hitMaxTurns: false, costUsd: 0.001, tokens: 100, ...over });
const evalOut = (pass: boolean): EvalOutput => ({ verdict: makeVerdict(pass), raw: "", sessionId: "e", costUsd: 0.001, tokens: 100 });

async function makeCtx(buildOver: Partial<SparraConfig["build"]> = {}): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-interactive-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  fs.writeFileSync(paths.frozenPlan, "# Plan\nBuild some things.\n");
  const store = StateStore.create(paths, "greenfield");
  store.data.phase = "frozen";
  const config = defaultConfig();
  config.build = { ...config.build, maxBudgetUsdPerItem: 0, maxRoundsPerItem: 6, ...buildOver };
  return { ctx: { root: dir, paths, config, store }, dir };
}

function baseDeps(): Partial<BuildDeps> {
  return {
    ensureAutoProbed: async () => {},
    negotiateContract: async () => ({ text: "contract", agreed: true, tracesUsed: 0 }),
    recordDeviations: async () => ({ changelog: 0, proposals: 0 }),
    reconcilePlan: async () => {},
  };
}

const item: WorkItem = { id: "item-001", title: "first", summary: "", dependsOn: [], rationale: "" };

function setDecision(ctx: Ctx, decision: string, reason = "", feedback?: string): void {
  const runId = ctx.store.data.build.runId!;
  const dir = pauseDir(ctx, runId, "item-001");
  fs.writeFileSync(path.join(dir, "decision.json"), JSON.stringify({ decision, reason }));
  if (feedback != null) fs.writeFileSync(path.join(dir, "feedback.md"), feedback);
}
const status = (ctx: Ctx) => ctx.store.data.build.items["item-001"]!.status;

describe("cmdBuild --step=round — pause after evaluate", () => {
  it("pauses after the round, writing a steering folder; the item stays mid-flight", async () => {
    const { ctx, dir } = await makeCtx();
    const genCalls: unknown[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async () => { genCalls.push(1); return genOut(); },
      evaluateItem: async () => evalOut(false),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["round"] }, deps);

    expect(genCalls).toHaveLength(1); // generated once, then paused — no second round
    expect(ctx.store.data.build.paused).toMatchObject({ kind: "round", itemId: "item-001", round: 1 });
    expect(status(ctx)).toBe("building"); // NOT marked failed
    const pd = pauseDir(ctx, ctx.store.data.build.runId!, "item-001");
    expect(fs.existsSync(path.join(pd, "pause.md"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(pd, "decision.json"), "utf8")).decision).toBe("continue");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdBuild --step=round — resume decisions", () => {
  it("continue: feeds the edited feedback into the next round", async () => {
    const { ctx, dir } = await makeCtx();
    const feedbacks: (string | undefined)[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async (a) => { feedbacks.push(a.feedback); return genOut(); },
      evaluateItem: async () => evalOut(false),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["round"] }, deps); // pause @ round 1
    setDecision(ctx, "continue", "", "FOCUS: fix the parser");
    await cmdBuild(ctx, { workspaceOverride: dir }, deps); // resume → round 2, pause again

    expect(feedbacks[0]).toBeUndefined(); // round 1 had no feedback
    expect(feedbacks[1]).toContain("FOCUS: fix the parser"); // round 2 got the human's edit
    expect(ctx.store.data.build.paused?.round).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("pivot: restarts fresh and bumps the pivot count", async () => {
    const { ctx, dir } = await makeCtx();
    const freshFlags: boolean[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async (a) => { freshFlags.push(!!a.fresh); return genOut(); },
      evaluateItem: async () => evalOut(false),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["round"] }, deps);
    setDecision(ctx, "pivot", "", "try a different design");
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);

    expect(freshFlags[1]).toBe(true); // round 2 generated fresh
    expect(ctx.store.data.build.items["item-001"]!.pivots).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accept on a pass: reconciles and marks the item passed", async () => {
    const { ctx, dir } = await makeCtx();
    let reconciled = false;
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true), // passing → default decision "accept"
      reconcilePlan: async () => { reconciled = true; },
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["round"] }, deps); // pause @ round 1 (pass)
    await cmdBuild(ctx, { workspaceOverride: dir }, deps); // resume with default accept

    expect(status(ctx)).toBe("passed");
    expect(reconciled).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accept override on a FAIL: requires a reason, then records it", async () => {
    const { ctx, dir } = await makeCtx();
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(false),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["round"] }, deps); // pause @ round 1 (fail)

    setDecision(ctx, "accept", ""); // override a FAIL with no reason → stays paused
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(status(ctx)).toBe("building");
    expect(ctx.store.data.build.paused?.kind).toBe("round");

    setDecision(ctx, "accept", "ship it — the failing assertion is out of scope");
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(status(ctx)).toBe("passed");
    expect(ctx.store.data.build.items["item-001"]!.overrideReason).toMatch(/out of scope/);
    expect(fs.readFileSync(ctx.paths.memory, "utf8")).toMatch(/OVERRIDING/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("abandon: marks the item abandoned", async () => {
    const { ctx, dir } = await makeCtx();
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(false),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["round"] }, deps);
    setDecision(ctx, "abandon");
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(status(ctx)).toBe("abandoned");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an accept reason that leaks the holdout (it would reach memory→generators)", async () => {
    const { ctx, dir } = await makeCtx();
    fs.writeFileSync(ctx.paths.holdout, "# Holdout\n- The exact byte-for-byte output must equal the golden file.\n");
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(false),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["round"] }, deps);
    setDecision(ctx, "accept", "ok because The exact byte-for-byte output must equal the golden file.");
    await expect(cmdBuild(ctx, { workspaceOverride: dir }, deps)).rejects.toThrow(/holdout/i);
    expect(status(ctx)).toBe("building"); // not accepted
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects feedback.md that leaks the holdout", async () => {
    const { ctx, dir } = await makeCtx();
    fs.writeFileSync(ctx.paths.holdout, "# Holdout\n- The exact byte-for-byte output must equal the golden file.\n");
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(false),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["round"] }, deps);
    setDecision(ctx, "continue", "", "The exact byte-for-byte output must equal the golden file.");
    await expect(cmdBuild(ctx, { workspaceOverride: dir }, deps)).rejects.toThrow(/holdout/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdBuild --step — resume safety", () => {
  it("--fresh clears a prior interactive mode + pause (a fresh run is autonomous)", async () => {
    const { ctx, dir } = await makeCtx();
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["round"] }, deps); // pause @ round 1
    expect(ctx.store.data.build.paused).toBeTruthy();

    await cmdBuild(ctx, { workspaceOverride: dir, fresh: true }, deps); // fresh → autonomous
    expect(ctx.store.data.build.step).toBeUndefined();
    expect(ctx.store.data.build.paused).toBeUndefined();
    expect(status(ctx)).toBe("passed"); // ran to completion without pausing
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a --only that would skip the paused item", async () => {
    const { ctx, dir } = await makeCtx();
    const two = [item, { id: "item-002", title: "second", summary: "", dependsOn: [], rationale: "" }];
    const calls: string[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => two,
      generateItem: async (a) => { calls.push(a.item.id); return genOut(); },
      evaluateItem: async () => evalOut(false),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["round"] }, deps); // pause @ item-001
    calls.length = 0;
    await cmdBuild(ctx, { workspaceOverride: dir, only: "item-002" }, deps); // should refuse
    expect(calls).toHaveLength(0); // nothing generated — refused
    expect(ctx.store.data.build.paused?.itemId).toBe("item-001"); // pause intact
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdBuild --step=contract — pause before generation", () => {
  it("pauses after negotiation (before generating), then resumes into the build", async () => {
    const { ctx, dir } = await makeCtx();
    const genCalls: unknown[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async () => { genCalls.push(1); return genOut(); },
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["contract"] }, deps);
    expect(genCalls).toHaveLength(0); // paused BEFORE generation
    expect(ctx.store.data.build.paused).toMatchObject({ kind: "contract", itemId: "item-001" });
    expect(fs.existsSync(path.join(pauseDir(ctx, ctx.store.data.build.runId!, "item-001"), "pause.md"))).toBe(true);

    await cmdBuild(ctx, { workspaceOverride: dir }, deps); // resume → contract acked → builds (passes)
    expect(genCalls).toHaveLength(1);
    expect(status(ctx)).toBe("passed");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

const item2: WorkItem = { id: "item-002", title: "second", summary: "", dependsOn: [], rationale: "" };
/** A ctx with autoCommit + a Sparra branch, so the commit gate can engage in tests. */
async function makeCommitCtx(): Promise<{ ctx: Ctx; dir: string }> {
  const { ctx, dir } = await makeCtx();
  ctx.config.git = { ...ctx.config.git, autoCommit: true };
  ctx.store.data.build.branch = "sparra/test";
  return { ctx, dir };
}

describe("parseSteps", () => {
  it("bare --step (raw === true) enables all four gates", () => {
    expect(parseSteps(true)).toEqual(["contract", "round", "commit", "item"]);
  });
  it("parses a CSV list, dedupes, and ignores unknown tokens", () => {
    expect(parseSteps("commit,item,commit,bogus,round")).toEqual(["commit", "item", "round"]);
  });
  it("an absent flag is no gates", () => {
    expect(parseSteps(undefined)).toEqual([]);
  });
});

describe("commit/item pause files are holdout-redacted", () => {
  const HOLD = "The exact byte-for-byte output must equal the golden file.";

  it("writeCommitPause redacts the holdout out of pause.md (incl. the file plan)", async () => {
    const { ctx, dir } = await makeCtx();
    const runId = "build-redact";
    // A pathological plan text that echoes a holdout line — it must be scrubbed like the round pause.
    await writeCommitPause(ctx, {
      runId,
      itemId: "item-001",
      itemTitle: "first",
      planText: `- src/foo.ts\n- ${HOLD}`,
      holdoutText: `# Holdout\n- ${HOLD}\n`,
    });
    const md = fs.readFileSync(path.join(pauseDir(ctx, runId, "item-001"), "pause.md"), "utf8");
    expect(md).not.toContain(HOLD);
    expect(md).toContain("[redacted: holdout]");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writeItemPause redacts the holdout out of pause.md", async () => {
    const { ctx, dir } = await makeCtx();
    const runId = "build-redact";
    await writeItemPause(ctx, {
      runId,
      itemId: "item-001",
      itemTitle: `first ${HOLD}`, // a leaked title must still be scrubbed
      status: "passed",
      holdoutText: `# Holdout\n- ${HOLD}\n`,
    });
    const md = fs.readFileSync(path.join(pauseDir(ctx, runId, "item-001"), "pause.md"), "utf8");
    expect(md).not.toContain(HOLD);
    expect(md).toContain("[redacted: holdout]");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdBuild --step=commit — pause before commit", () => {
  it("accepts (passed) but defers the commit; resume with 'commit' commits exactly once", async () => {
    const { ctx, dir } = await makeCommitCtx();
    const commitCalls: string[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
      commitItem: async (_c, a) => { commitCalls.push(a.item.id); return { ok: true, commits: 1 }; },
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["commit"] }, deps);
    expect(ctx.store.data.build.paused).toMatchObject({ kind: "commit", itemId: "item-001" });
    expect(status(ctx)).toBe("passed"); // accepted, just not committed
    expect(commitCalls).toHaveLength(0); // NOT committed before the pause
    const pd = pauseDir(ctx, ctx.store.data.build.runId!, "item-001");
    expect(fs.existsSync(path.join(pd, "pause.md"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(pd, "decision.json"), "utf8")).decision).toBe("commit");

    await cmdBuild(ctx, { workspaceOverride: dir }, deps); // resume with default "commit"
    expect(commitCalls).toEqual(["item-001"]);
    expect(ctx.store.data.build.paused).toBeUndefined();
    expect(status(ctx)).toBe("passed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resume with 'skip' does NOT commit; the item stays passed", async () => {
    const { ctx, dir } = await makeCommitCtx();
    const commitCalls: string[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
      commitItem: async (_c, a) => { commitCalls.push(a.item.id); return { ok: true, commits: 1 }; },
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["commit"] }, deps);
    setDecision(ctx, "skip");
    await cmdBuild(ctx, { workspaceOverride: dir }, deps);
    expect(commitCalls).toHaveLength(0); // skipped — never committed
    expect(ctx.store.data.build.paused).toBeUndefined();
    expect(status(ctx)).toBe("passed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a --only that would skip a commit pause", async () => {
    const { ctx, dir } = await makeCommitCtx();
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item, item2],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
      commitItem: async () => ({ ok: true, commits: 1 }),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["commit"] }, deps); // pause @ commit on item-001
    expect(ctx.store.data.build.paused?.kind).toBe("commit");
    await cmdBuild(ctx, { workspaceOverride: dir, only: "item-002" }, deps); // should refuse
    expect(ctx.store.data.build.paused?.itemId).toBe("item-001"); // pause intact
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdBuild --step=item — pause between items", () => {
  it("pauses after item-001 (before item-002), and NOT after the final item", async () => {
    const { ctx, dir } = await makeCtx();
    const genCalls: string[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item, item2],
      generateItem: async (a) => { genCalls.push(a.item.id); return genOut(); },
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["item"] }, deps);
    expect(status(ctx)).toBe("passed");
    expect(ctx.store.data.build.paused).toMatchObject({ kind: "item", itemId: "item-001" });
    expect(genCalls).toEqual(["item-001"]); // item-002 not generated yet

    await cmdBuild(ctx, { workspaceOverride: dir }, deps); // resume (default continue)
    expect(genCalls).toEqual(["item-001", "item-002"]);
    expect(ctx.store.data.build.items["item-002"]!.status).toBe("passed");
    expect(ctx.store.data.build.paused).toBeUndefined(); // no pause after the last item
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("'stop' ends the run cleanly; a re-run advances to the next item", async () => {
    const { ctx, dir } = await makeCtx();
    const genCalls: string[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item, item2],
      generateItem: async (a) => { genCalls.push(a.item.id); return genOut(); },
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["item"] }, deps); // pause after item-001
    setDecision(ctx, "stop");
    await cmdBuild(ctx, { workspaceOverride: dir }, deps); // stop → run ends here
    expect(ctx.store.data.build.paused).toBeUndefined(); // pause cleared (no infinite stop)
    expect(ctx.store.data.build.items["item-002"]).toBeUndefined(); // item-002 untouched
    expect(genCalls).toEqual(["item-001"]);

    await cmdBuild(ctx, { workspaceOverride: dir }, deps); // re-run advances
    expect(genCalls).toEqual(["item-001", "item-002"]);
    expect(ctx.store.data.build.items["item-002"]!.status).toBe("passed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a --only that would skip an item pause", async () => {
    const { ctx, dir } = await makeCtx();
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item, item2],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["item"] }, deps); // pause @ item gate on item-001
    expect(ctx.store.data.build.paused?.kind).toBe("item");
    await cmdBuild(ctx, { workspaceOverride: dir, only: "item-002" }, deps); // should refuse
    expect(ctx.store.data.build.paused?.itemId).toBe("item-001"); // pause intact
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a FAILED item that exhausted its rounds is advanced past on resume, not re-run", async () => {
    const { ctx, dir } = await makeCtx({ maxRoundsPerItem: 1 }); // one shot, so item-001 fails fast
    const genCalls: string[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item, item2],
      generateItem: async (a) => { genCalls.push(a.item.id); return genOut(); },
      evaluateItem: async (a) => evalOut(a.item.id === "item-002"), // item-001 fails, item-002 passes
    };
    await cmdBuild(ctx, { workspaceOverride: dir, step: ["item"] }, deps); // item-001 fails → item gate
    expect(status(ctx)).toBe("failed");
    expect(ctx.store.data.build.paused).toMatchObject({ kind: "item", itemId: "item-001" });
    expect(genCalls).toEqual(["item-001"]);

    setDecision(ctx, "stop");
    await cmdBuild(ctx, { workspaceOverride: dir }, deps); // stop → run ends, pause cleared
    expect(ctx.store.data.build.paused).toBeUndefined();
    expect(genCalls).toEqual(["item-001"]); // item-001 NOT re-run, item-002 untouched

    await cmdBuild(ctx, { workspaceOverride: dir }, deps); // follow-up advances PAST the failed item
    expect(genCalls).toEqual(["item-001", "item-002"]); // item-001 still not re-contracted/re-run
    expect(ctx.store.data.build.items["item-002"]!.status).toBe("passed");
    expect(status(ctx)).toBe("failed"); // item-001 stays failed (terminal)
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdBuild — autonomous when no --step", () => {
  it("commits inline and never pauses", async () => {
    const { ctx, dir } = await makeCommitCtx();
    const commitCalls: string[] = [];
    const deps: Partial<BuildDeps> = {
      ...baseDeps(),
      decompose: async () => [item, item2],
      generateItem: async () => genOut(),
      evaluateItem: async () => evalOut(true),
      commitItem: async (_c, a) => { commitCalls.push(a.item.id); return { ok: true, commits: 1 }; },
    };
    await cmdBuild(ctx, { workspaceOverride: dir }, deps); // no step → fully autonomous
    expect(ctx.store.data.build.paused).toBeUndefined();
    expect(status(ctx)).toBe("passed");
    expect(ctx.store.data.build.items["item-002"]!.status).toBe("passed");
    expect(commitCalls).toEqual(["item-001", "item-002"]); // committed inline, both items
    // Parity proof: a fully autonomous run writes NO interactive steering folder at all.
    expect(fs.existsSync(path.join(ctx.paths.dir, "interactive"))).toBe(false);
    expect(fs.existsSync(pauseDir(ctx, ctx.store.data.build.runId!, "item-001"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
