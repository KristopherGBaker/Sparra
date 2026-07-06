import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateItem } from "../src/build/generate.ts";
import { appleConventions, isApplePlatform } from "../src/build/swiftConventions.ts";
import { JUDGE_SCRATCH_ENV_KEYS } from "../src/build/judgeScratch.ts";
import { swiftpmCacheDir } from "../src/util/provision.ts";
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

// A parseable report block, so the default-on JSON re-ask (Q7d) never fires in these tests
// and each capture reflects the single real generation call.
const OK_REPORT = '```json\n{"report":"ok","deviations":[]}\n```';

function fakeRun(capture: (p: RunSessionParams) => void): (p: RunSessionParams) => Promise<RunResult> {
  return async (p) => {
    capture(p);
    return {
      ok: true, subtype: "success", resultText: OK_REPORT, sessionId: "s",
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

  it("carries the iOS #if DEBUG launch-arg reach clause on ios but NOT on macos (contrast pair)", () => {
    const ios = appleConventions("ios");
    const mac = appleConventions("macos");
    expect(ios).toContain("#if DEBUG");
    expect(ios).toContain("ProcessInfo.processInfo.arguments");
    // macOS uses an XCUITest target for reach, not simctl launch args — the ios-only clause is absent.
    expect(mac).not.toContain("ProcessInfo.processInfo.arguments");
  });
});

describe("generateItem — writable-scratch session env (U-X #1/#3/#4)", () => {
  it("routes the redirect keys into the autonomous generator session env (durable SwiftPM, ephemeral clang/TMPDIR)", async () => {
    const { ctx, dir } = await ctxFor("ios");
    let captured: RunSessionParams | undefined;
    await generateItem({
      ctx, item, contractText: "c", workspaceDir: dir, traceDir: dir, traceSeq: 1,
      runSessionFn: fakeRun((p) => (captured = p)),
    });
    const env = captured!.env!;
    expect(env).toBeDefined();
    // Previously plain mergedBuildEnv (no redirect); now every scratch key reaches the SDK env.
    for (const key of JUDGE_SCRATCH_ENV_KEYS) expect(typeof env[key]).toBe("string");
    expect(env.TMPDIR).toMatch(/sprj-[0-9a-f]{8}/);
    expect(env.CLANG_MODULE_CACHE_PATH).toMatch(/sprj-[0-9a-f]{8}/);
    // Durable, worktree-local SwiftPM cache keyed on the workspace — NOT the ephemeral per-run scratch.
    expect(env.SWIFTPM_CACHE_DIR).toBe(swiftpmCacheDir(dir));
    expect(env.SWIFTPM_CACHE_DIR).not.toMatch(/sprj-[0-9a-f]{8}/);
    expect(env.PATH).toBe(process.env.PATH); // unrelated process.env survives
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("user build.env still overrides the generator scratch defaults", async () => {
    const { ctx, dir } = await ctxFor("cli");
    ctx.config.build.env = { TMPDIR: "/mine", FOO: "1" };
    let captured: RunSessionParams | undefined;
    await generateItem({
      ctx, item, contractText: "c", workspaceDir: dir, traceDir: dir, traceSeq: 1,
      runSessionFn: fakeRun((p) => (captured = p)),
    });
    const env = captured!.env!;
    expect(env.TMPDIR).toBe("/mine"); // user override beats the scratch default
    expect(env.FOO).toBe("1");
    expect(env.CLANG_MODULE_CACHE_PATH).toMatch(/sprj-[0-9a-f]{8}/); // non-colliding default still applies
    fs.rmSync(dir, { recursive: true, force: true });
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

describe("generateItem — targeted map context (relevantPaths, U5)", () => {
  // A frozen map whose section for the named path sits PAST the 5000-char generator head cap.
  const LATE = "## src/build/late.ts\nSENTINEL_LATE marks the tricky seam for this item.\n";
  const MAP = "# Overview\n" + "unrelated filler describing other modules.\n".repeat(140) + LATE;

  it("wires item.relevantPaths through selectMapContext: prefers the named section + lists the file", async () => {
    const { ctx, dir } = await ctxFor("cli");
    fs.writeFileSync(ctx.paths.frozenMap, MAP);
    expect(MAP.indexOf("SENTINEL_LATE")).toBeGreaterThan(5000); // past the head cap
    let prompt = "";
    await generateItem({
      ctx, item: { ...item, relevantPaths: ["src/build/late.ts"] },
      contractText: "c", workspaceDir: dir, traceDir: dir, traceSeq: 1,
      runSessionFn: fakeRun((p) => (prompt = p.prompt)),
    });
    expect(prompt).toContain("Files most relevant to this item:");
    expect(prompt).toContain("- src/build/late.ts");
    expect(prompt).toContain("SENTINEL_LATE");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("absent relevantPaths → the blind head-slice, byte-for-byte today (no late seam, no listing)", async () => {
    const { ctx, dir } = await ctxFor("cli");
    fs.writeFileSync(ctx.paths.frozenMap, MAP);
    let prompt = "";
    await generateItem({
      ctx, item, contractText: "c", workspaceDir: dir, traceDir: dir, traceSeq: 1,
      runSessionFn: fakeRun((p) => (prompt = p.prompt)),
    });
    expect(prompt).toContain(MAP.slice(0, 5000));
    expect(prompt).not.toContain("Files most relevant to this item:");
    expect(prompt).not.toContain("SENTINEL_LATE");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("generateItem — JSON re-ask + assertionsClaimed (Q7 c/d)", () => {
  const REPORT_JSON =
    '```json\n{"report":"did it","deviations":[],"assertionsClaimed":[{"id":1,"claim":"pass","how":"ran tests"}]}\n```';

  /** Fake session returning texts[i] on the i-th call (last one repeats). */
  function seqRun(texts: string[]) {
    const calls: RunSessionParams[] = [];
    const fn = async (p: RunSessionParams): Promise<RunResult> => {
      const i = calls.length;
      calls.push(p);
      return {
        ok: true, subtype: "success", resultText: texts[Math.min(i, texts.length - 1)]!, sessionId: `s${i}`,
        costUsd: 0, tokens: 1, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
      };
    };
    return { calls, fn };
  }

  async function gen(ctx: Ctx, dir: string, rec: ReturnType<typeof seqRun>) {
    return generateItem({ ctx, item, contractText: "c", workspaceDir: dir, traceDir: dir, traceSeq: 1, runSessionFn: rec.fn });
  }

  it("re-asks ONCE on an unparseable report, resuming the SAME session, and parses the re-ask's JSON", async () => {
    const { ctx, dir } = await ctxFor("cli");
    const rec = seqRun(["no json in sight", REPORT_JSON]);
    const out = await gen(ctx, dir, rec);
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[1]!.resume).toBe("s0"); // resumed the first call's session
    expect(rec.calls[1]!.prompt).toContain("Re-emit ONLY the JSON block");
    expect(out.report).toBe("did it"); // parsed from the re-ask, not the degraded fallback
    expect(out.assertionsClaimed).toEqual([{ id: 1, claim: "pass", how: "ran tests" }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("both responses unparseable → one re-ask, then today's degraded-report fallback", async () => {
    const { ctx, dir } = await ctxFor("cli");
    const rec = seqRun(["first garbage", "second garbage"]);
    const out = await gen(ctx, dir, rec);
    expect(rec.calls).toHaveLength(2); // exactly ONE re-ask, never more
    expect(out.report).toBe("first garbage"); // degraded: first 500 chars of the original output
    expect(out.deviations).toEqual([]);
    expect(out.assertionsClaimed).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("build.jsonReask: false → NO re-ask call, straight to the degraded fallback (contrast)", async () => {
    const { ctx, dir } = await ctxFor("cli");
    ctx.config.build.jsonReask = false;
    const rec = seqRun(["garbage", REPORT_JSON]);
    const out = await gen(ctx, dir, rec);
    expect(rec.calls).toHaveLength(1);
    expect(out.report).toBe("garbage");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips the re-ask when the session already exhausted the item budget", async () => {
    const { ctx, dir } = await ctxFor("cli");
    const rec = seqRun(["garbage", REPORT_JSON]);
    const expensive = async (p: RunSessionParams): Promise<RunResult> => ({ ...(await rec.fn(p)), costUsd: 99 });
    const out = await generateItem({
      ctx, item, contractText: "c", workspaceDir: dir, traceDir: dir, traceSeq: 1,
      maxBudgetUsd: 1, runSessionFn: expensive,
    });
    expect(rec.calls).toHaveLength(1); // budget-exhausted → no re-ask
    expect(out.report).toBe("garbage");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a clean first response parses assertionsClaimed with no re-ask; omitted field stays undefined", async () => {
    const { ctx, dir } = await ctxFor("cli");
    const rec = seqRun([REPORT_JSON]);
    const out = await gen(ctx, dir, rec);
    expect(rec.calls).toHaveLength(1);
    expect(out.assertionsClaimed).toEqual([{ id: 1, claim: "pass", how: "ran tests" }]);

    const rec2 = seqRun(['```json\n{"report":"r","deviations":[]}\n```']);
    const out2 = await gen(ctx, dir, rec2);
    expect(rec2.calls).toHaveLength(1);
    expect(out2.assertionsClaimed).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("generateItem — turn-cap report recovery (U-D)", () => {
  const REPORT_JSON =
    '```json\n{"report":"recovered","deviations":[],"assertionsClaimed":[{"id":1,"claim":"pass","how":"ran tests"}]}\n```';

  /** Fake session returning results[i] (last repeats), recording every request. */
  function capSession(results: Partial<RunResult>[]) {
    const calls: RunSessionParams[] = [];
    const base: RunResult = {
      ok: true, subtype: "success", resultText: "", sessionId: "cap-sess",
      costUsd: 0, tokens: 1, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
    };
    const fn = async (p: RunSessionParams): Promise<RunResult> => {
      const shape = results[Math.min(calls.length, results.length - 1)]!;
      calls.push(p);
      return { ...base, ...shape };
    };
    return { calls, fn };
  }

  /** A turn-capped writer death: hit the 60-turn cap with a partial reply. */
  const TURN_CAP = (resultText: string): Partial<RunResult> => ({
    ok: false, subtype: "error_max_turns", resultText, hitMaxTurns: true, sessionId: "cap-sess", errors: ["error_max_turns"],
  });

  async function gen(ctx: Ctx, dir: string, rec: ReturnType<typeof capSession>, landed: string[]) {
    return generateItem({
      ctx, item, contractText: "c", workspaceDir: dir, traceDir: dir, traceSeq: 1,
      runSessionFn: rec.fn, changedFilesFn: () => landed,
    });
  }

  it("(#3/#5) turn-cap + landed work + prose (no JSON) → ONE tightCap report-only re-ask on the same session; report + assertionsClaimed recovered, hitMaxTurns STAYS true", async () => {
    const { ctx, dir } = await ctxFor("cli");
    const rec = capSession([TURN_CAP("I was still editing files when I ran out of turns…"), { resultText: REPORT_JSON, sessionId: "cap-sess" }]);
    const out = await gen(ctx, dir, rec, ["/ws/a.ts"]);
    // exactly ONE re-ask, resuming the dying session, report-only (no full-brief replay).
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[1]!.resume).toBe("cap-sess");
    expect(rec.calls[1]!.prompt).toContain("Re-emit ONLY the JSON block");
    expect(rec.calls[1]!.prompt).not.toContain("Implement work item"); // never replays the brief
    // tightCap: one text-only turn — tools stripped, no plan mode, read-only sandbox.
    expect(rec.calls[0]!.permissionMode).not.toBe("plan"); // the writer run was NOT read-only…
    expect(rec.calls[0]!.hooks).toBeDefined(); // …and carried writer hooks
    expect(rec.calls[1]!.maxTurns).toBe(1);
    expect(rec.calls[1]!.maxBudgetUsd).toBeLessThan(ctx.config.build.maxBudgetUsdPerItem);
    expect(rec.calls[1]!.tools).toEqual([]); // no built-in tools → nothing can be invoked
    expect(rec.calls[1]!.permissionMode).toBe("default"); // NOT plan (plan mode invited the blocked Write)
    expect(rec.calls[1]!.readOnly).toBe(true);
    expect(rec.calls[1]!.hooks).toBeUndefined();
    // recovery never launders the capped run as complete.
    expect(out.report).toBe("recovered");
    expect(out.assertionsClaimed).toEqual([{ id: 1, claim: "pass", how: "ran tests" }]);
    expect(out.hitMaxTurns).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(#2 robustness) turn-cap + landed work + incidental WRONG-SHAPE JSON → still re-asks (a non-report block is not a report)", async () => {
    const { ctx, dir } = await ctxFor("cli");
    // a JSON block that is NOT a completion report (no report/deviations) — the old noJson-only gate
    // would have skipped the re-ask; the turn-cap path must still recover.
    const rec = capSession([TURN_CAP('here is some telemetry ```json\n{"tokens":42,"note":"partial"}\n```'), { resultText: REPORT_JSON, sessionId: "cap-sess" }]);
    const out = await gen(ctx, dir, rec, ["/ws/a.ts"]);
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[1]!.maxTurns).toBe(1); // tightCap fired
    expect(out.report).toBe("recovered");
    expect(out.hitMaxTurns).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(#2 contrast) turn-cap but a PROPER report already emitted → NO re-ask", async () => {
    const { ctx, dir } = await ctxFor("cli");
    const rec = capSession([TURN_CAP(REPORT_JSON)]);
    const out = await gen(ctx, dir, rec, ["/ws/a.ts"]);
    expect(rec.calls).toHaveLength(1); // nothing to recover
    expect(out.report).toBe("recovered");
    expect(out.hitMaxTurns).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(#4 gating) turn-cap with NO landed work → NO re-ask (nothing to recover)", async () => {
    const { ctx, dir } = await ctxFor("cli");
    const rec = capSession([TURN_CAP("prose, no report"), { resultText: REPORT_JSON }]);
    const out = await gen(ctx, dir, rec, []); // zero changed files
    expect(rec.calls).toHaveLength(1);
    expect(out.hitMaxTurns).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(#4 gating) build.jsonReask off → NO re-ask even on a turn-cap", async () => {
    const { ctx, dir } = await ctxFor("cli");
    ctx.config.build.jsonReask = false;
    const rec = capSession([TURN_CAP("prose, no report"), { resultText: REPORT_JSON }]);
    const out = await gen(ctx, dir, rec, ["/ws/a.ts"]);
    expect(rec.calls).toHaveLength(1);
    expect(out.hitMaxTurns).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(#4 gating) a provider limitHit on a turn-capped reply → NO re-ask (the fallback chain owns limits)", async () => {
    const { ctx, dir } = await ctxFor("cli");
    const rec = capSession([{ ...TURN_CAP("prose"), limitHit: { kind: "usage", raw: "limited" } }, { resultText: REPORT_JSON }]);
    const out = await gen(ctx, dir, rec, ["/ws/a.ts"]);
    expect(rec.calls).toHaveLength(1);
    expect(out.limitHit).toBeDefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("generateItem — build read scope (extraReadDirs)", () => {
  it("adds absolute, ~, and repo-relative extra dirs to additionalDirectories", async () => {
    const { ctx, dir } = await ctxFor("cli");
    ctx.config.build.extraReadDirs = ["/opt/models", "~/cache/assets", "models"];
    let dirs: string[] | undefined;
    await generateItem({
      ctx, item, contractText: "c", workspaceDir: dir, traceDir: dir, traceSeq: 1,
      runSessionFn: fakeRun((p) => (dirs = p.additionalDirectories)),
    });
    expect(dirs).toContain("/opt/models");
    expect(dirs).toContain(path.join(os.homedir(), "cache/assets"));
    expect(dirs).toContain(path.resolve(dir, "models"));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is undefined with no extra dirs when building in the repo root", async () => {
    const { ctx, dir } = await ctxFor("cli");
    let dirs: string[] | undefined = ["x"];
    await generateItem({
      ctx, item, contractText: "c", workspaceDir: dir, traceDir: dir, traceSeq: 1,
      runSessionFn: fakeRun((p) => (dirs = p.additionalDirectories)),
    });
    expect(dirs).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("DROPS the holdout-bearing repo root but keeps clean extras on a separate worktree (no holdout leak)", async () => {
    const { ctx, dir } = await ctxFor("cli");
    ctx.config.build.extraReadDirs = ["/opt/models"];
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-wt-"));
    let dirs: string[] | undefined;
    await generateItem({
      ctx, item, contractText: "c", workspaceDir: wt, traceDir: wt, traceSeq: 1,
      runSessionFn: fakeRun((p) => (dirs = p.additionalDirectories)),
    });
    // The repo root holds .sparra/HOLDOUT.md — the generator (a forbid role) must NOT get it as a
    // readable dir. A clean extra dir is still granted.
    expect(dirs).not.toContain(dir);
    expect(dirs).toContain("/opt/models");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });
});
