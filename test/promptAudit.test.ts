import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import { seedPrompts, DEFAULT_PROMPTS } from "../src/prompts.ts";
import { measurePrompt, shouldApply, auditPrompts, type AuditResult } from "../src/build/promptAudit.ts";
import type { Ctx } from "../src/context.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

async function ctxFor(seed = true): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-audit-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  if (seed) await seedPrompts(paths);
  const store = StateStore.create(paths, "greenfield");
  return { ctx: { root: dir, paths, config: defaultConfig(), store }, dir };
}

/** A fake session that returns the given audit JSON (or raw text) and captures the request. */
function fakeRun(
  payload: AuditResult | string,
  capture?: (p: RunSessionParams) => void
): (p: RunSessionParams) => Promise<RunResult> {
  const text = typeof payload === "string" ? payload : "```json\n" + JSON.stringify(payload) + "\n```";
  return async (p) => {
    capture?.(p);
    return {
      ok: true, subtype: "success", resultText: text, sessionId: "s",
      costUsd: 0, tokens: 0, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
    };
  };
}

const SAFE: AuditResult = {
  tightened: "TIGHTENED PROMPT BODY",
  coverage: [
    { rule: "be read-only", preservedIn: "READ-ONLY line" },
    { rule: "never drop holdout clause", preservedIn: "holdout line" },
  ],
  droppedNothing: true,
  notes: "deduped two near-duplicate rules",
};

describe("measurePrompt", () => {
  it("is deterministic chars + ceil(chars/4) tokens", () => {
    expect(measurePrompt("")).toEqual({ chars: 0, tokens: 0 });
    expect(measurePrompt("abcd")).toEqual({ chars: 4, tokens: 1 });
    expect(measurePrompt("abcde")).toEqual({ chars: 5, tokens: 2 }); // ceil(5/4)=2
    const big = "x".repeat(401);
    expect(measurePrompt(big)).toEqual({ chars: 401, tokens: 101 });
  });
});

describe("shouldApply (fail-closed + coverage cross-check)", () => {
  it("true only for the fully-verified safe shape", () => {
    expect(shouldApply(SAFE)).toBe(true);
  });
  it("false on every unsafe shape", () => {
    expect(shouldApply(null)).toBe(false);
    expect(shouldApply(undefined)).toBe(false);
    expect(shouldApply({ ...SAFE, droppedNothing: false })).toBe(false);
    expect(shouldApply({ ...SAFE, droppedNothing: undefined })).toBe(false);
    expect(shouldApply({ ...SAFE, tightened: "  " })).toBe(false);
    expect(shouldApply({ ...SAFE, tightened: undefined })).toBe(false);
    expect(shouldApply({ ...SAFE, coverage: [] })).toBe(false);
    expect(shouldApply({ ...SAFE, coverage: undefined })).toBe(false);
    expect(shouldApply({ ...SAFE, coverage: [{ rule: "x", dropped: true }] })).toBe(false);
  });
});

describe("auditPrompts — review file", () => {
  it("writes a per-role review with coverage, droppedNothing, and before→after sizes", async () => {
    const { ctx, dir } = await ctxFor();
    const rows = await auditPrompts(ctx, { roles: ["generator"], runSessionFn: fakeRun(SAFE) });
    expect(rows).toHaveLength(1);
    const review = fs.readFileSync(rows[0]!.reviewPath, "utf8");
    expect(review).toMatch(/preservedIn/);
    expect(review).toMatch(/droppedNothing: true/);
    expect(review).toMatch(/size before:/);
    expect(review).toMatch(/size after:/);
    // before reflects the real on-disk prompt size
    expect(rows[0]!.sizeBefore.chars).toBeGreaterThan(100);
    expect(rows[0]!.sizeAfter.chars).toBe(SAFE.tightened!.length);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("renders a dropped coverage entry in the review", async () => {
    const { ctx, dir } = await ctxFor();
    const dropped: AuditResult = { tightened: "x", coverage: [{ rule: "safety", dropped: true }], droppedNothing: false, notes: "" };
    const rows = await auditPrompts(ctx, { roles: ["generator"], runSessionFn: fakeRun(dropped) });
    const review = fs.readFileSync(rows[0]!.reviewPath, "utf8");
    expect(review).toMatch(/dropped: true/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("auditPrompts — apply gate (fail-closed + coverage cross-check)", () => {
  it("SAFE + --apply overwrites the prompt with the tightened text", async () => {
    const { ctx, dir } = await ctxFor();
    const rows = await auditPrompts(ctx, { roles: ["generator"], apply: true, runSessionFn: fakeRun(SAFE) });
    expect(rows[0]!.applied).toBe(true);
    expect(rows[0]!.skipped).toBe(false);
    const onDisk = fs.readFileSync(ctx.paths.promptFile("generator"), "utf8");
    expect(onDisk).toContain(SAFE.tightened!);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const unsafeCases: Array<[string, AuditResult | string]> = [
    ["droppedNothing:false", { ...SAFE, droppedNothing: false }],
    ["unparseable JSON", "no json here at all"],
    ["omitted droppedNothing field", { tightened: "x", coverage: [{ rule: "r", preservedIn: "p" }] }],
    ["empty tightened", { ...SAFE, tightened: "  " }],
    ["coverage:[]", { ...SAFE, coverage: [] }],
    ["droppedNothing:true WITH a dropped:true entry", { ...SAFE, coverage: [...SAFE.coverage!, { rule: "z", dropped: true }] }],
  ];
  for (const [name, payload] of unsafeCases) {
    it(`${name} + --apply leaves the prompt BYTE-IDENTICAL and reports a skip`, async () => {
      const { ctx, dir } = await ctxFor();
      const before = fs.readFileSync(ctx.paths.promptFile("generator"), "utf8");
      const rows = await auditPrompts(ctx, { roles: ["generator"], apply: true, runSessionFn: fakeRun(payload) });
      expect(rows[0]!.applied).toBe(false);
      expect(rows[0]!.skipped).toBe(true);
      expect(rows[0]!.skipReason).toBeTruthy();
      const after = fs.readFileSync(ctx.paths.promptFile("generator"), "utf8");
      expect(after).toBe(before); // byte-identical
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  it("no --apply (report-only) never changes the prompt file even on a SAFE result", async () => {
    const { ctx, dir } = await ctxFor();
    const before = fs.readFileSync(ctx.paths.promptFile("generator"), "utf8");
    const rows = await auditPrompts(ctx, { roles: ["generator"], runSessionFn: fakeRun(SAFE) });
    expect(rows[0]!.applied).toBe(false);
    expect(rows[0]!.skipped).toBe(false);
    expect(fs.readFileSync(ctx.paths.promptFile("generator"), "utf8")).toBe(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("auditPrompts — read-only + overrides", () => {
  it("grants NO Write/Edit/Bash tools and routes --backend/--model/--effort to the session", async () => {
    const { ctx, dir } = await ctxFor();
    let req: RunSessionParams | undefined;
    await auditPrompts(ctx, {
      roles: ["generator"], backend: "codex", model: "gpt-5.5", effort: "xhigh",
      runSessionFn: fakeRun(SAFE, (p) => (req = p)),
    });
    expect(req).toBeDefined();
    expect(req!.tools ?? []).not.toContain("Write");
    expect(req!.tools ?? []).not.toContain("Edit");
    expect(req!.tools ?? []).not.toContain("Bash");
    expect(req!.readOnly).toBe(true);
    expect(req!.backend).toBe("codex");
    expect(req!.model).toBe("gpt-5.5");
    expect(req!.effort).toBe("xhigh");
    // the prompt TEXT is inlined; no holdout/memory injected
    expect(req!.prompt).toContain("PROMPT TEXT:");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("defaults the role to ctx.config.roles.reflector when no overrides given", async () => {
    const { ctx, dir } = await ctxFor();
    ctx.config.roles.reflector = { model: "opus", effort: "max", backend: "claude" };
    let req: RunSessionParams | undefined;
    await auditPrompts(ctx, { roles: ["generator"], runSessionFn: fakeRun(SAFE, (p) => (req = p)) });
    expect(req!.model).toBe("opus");
    expect(req!.effort).toBe("max");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("auditPrompts — effective-prompt resolution", () => {
  it("audits the DRIFTED on-disk prompt, not DEFAULT_PROMPTS", async () => {
    const { ctx, dir } = await ctxFor();
    const drifted = "DRIFTED LOCAL PROMPT — much shorter than the default\n";
    fs.writeFileSync(ctx.paths.promptFile("generator"), drifted);
    let req: RunSessionParams | undefined;
    const rows = await auditPrompts(ctx, { roles: ["generator"], runSessionFn: fakeRun(SAFE, (p) => (req = p)) });
    expect(req!.prompt).toContain("DRIFTED LOCAL PROMPT");
    expect(req!.prompt).not.toContain("autonomous build loop"); // a default-only phrase
    expect(rows[0]!.sizeBefore.chars).toBe(drifted.length);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to DEFAULT_PROMPTS when no on-disk prompt exists", async () => {
    const { ctx, dir } = await ctxFor(false); // not seeded
    const rows = await auditPrompts(ctx, { roles: ["generator"], runSessionFn: fakeRun(SAFE) });
    expect(rows[0]!.sizeBefore.chars).toBe(DEFAULT_PROMPTS["generator"]!.length);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("prompt-auditor DEFAULT_PROMPTS text", () => {
  it("carries the enumerate/coverage/protect discipline and the JSON schema fields", () => {
    const t = DEFAULT_PROMPTS["prompt-auditor"]!;
    expect(t).toMatch(/ENUMERATE/);
    expect(t).toMatch(/coverage/i);
    expect(t).toMatch(/preservedIn/);
    expect(t).toMatch(/droppedNothing/);
    expect(t).toMatch(/tightened/);
    expect(t).toMatch(/notes/);
    expect(t).toMatch(/READ-ONLY/);
    expect(t).toMatch(/safety/i);
    expect(t).toMatch(/sandbox/i);
    expect(t).toMatch(/permission/i);
    expect(t).toMatch(/holdout/i);
    expect(t).toMatch(/anti-gaming/i);
  });
});

describe("auditPrompts — all roles + unknown role", () => {
  it("audits every role when none specified", async () => {
    const { ctx, dir } = await ctxFor();
    const rows = await auditPrompts(ctx, { runSessionFn: fakeRun(SAFE) });
    expect(rows.length).toBe(Object.keys(DEFAULT_PROMPTS).length);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdPrompts audit dispatch", () => {
  it("warns and does not crash on an unknown --role", async () => {
    const { cmdPrompts } = await import("../src/phases/prompts.ts");
    const { ctx, dir } = await ctxFor();
    await expect(cmdPrompts(ctx, ["audit"], { role: "nope-not-a-role" })).resolves.toBeUndefined();
    // no audit review dir should have been created (we returned before auditing)
    expect(fs.existsSync(path.join(ctx.paths.prompts, "audit"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
