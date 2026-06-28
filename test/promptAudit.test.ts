import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import { seedPrompts, DEFAULT_PROMPTS } from "../src/prompts.ts";
import {
  measurePrompt,
  shouldApply,
  verifierApproves,
  auditPrompts,
  type AuditResult,
  type VerifierResult,
} from "../src/build/promptAudit.ts";
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

const APPROVE: VerifierResult = { complete: true, missing: [] };

/**
 * A role-aware fake: returns the auditor payload for the auditor session and the verifier payload
 * for the verifier session. We distinguish by the role string carrying "prompt-audit-verifier"
 * (an EXACT substring) — NOT startsWith("prompt-auditor"), which would prefix-collide.
 */
function fakeRoleAware(
  auditor: AuditResult | string,
  verifier: VerifierResult | string,
  capture?: { auditor?: (p: RunSessionParams) => void; verifier?: (p: RunSessionParams) => void }
): (p: RunSessionParams) => Promise<RunResult> {
  const toText = (pl: AuditResult | VerifierResult | string) =>
    typeof pl === "string" ? pl : "```json\n" + JSON.stringify(pl) + "\n```";
  return async (p) => {
    const isVerifier = p.role.includes("prompt-audit-verifier");
    if (isVerifier) capture?.verifier?.(p);
    else capture?.auditor?.(p);
    return {
      ok: true, subtype: "success", resultText: isVerifier ? toText(verifier) : toText(auditor),
      sessionId: "s", costUsd: 0, tokens: 0, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
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

describe("verifierApproves (independent second gate)", () => {
  it("true ONLY for complete:true with an empty missing array", () => {
    expect(verifierApproves({ complete: true, missing: [] })).toBe(true);
  });
  it("false on every other shape", () => {
    expect(verifierApproves(null)).toBe(false);
    expect(verifierApproves(undefined)).toBe(false);
    expect(verifierApproves({ complete: false, missing: [] })).toBe(false);
    expect(verifierApproves({ complete: true })).toBe(false); // missing not an array
    expect(verifierApproves({ complete: true, missing: [{ rule: "x" }] })).toBe(false);
    expect(verifierApproves({ missing: [] })).toBe(false); // complete absent
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
  it("SAFE + --apply overwrites the prompt with the tightened text (verifier approves)", async () => {
    const { ctx, dir } = await ctxFor();
    let auditorCalls = 0;
    let verifierCalls = 0;
    const rows = await auditPrompts(ctx, {
      roles: ["generator"], apply: true,
      runSessionFn: fakeRoleAware(SAFE, APPROVE, {
        auditor: () => auditorCalls++,
        verifier: () => verifierCalls++,
      }),
    });
    expect(rows[0]!.applied).toBe(true);
    expect(rows[0]!.skipped).toBe(false);
    expect(auditorCalls).toBe(1);
    expect(verifierCalls).toBe(1);
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

describe("auditPrompts — independent verifier gate (the missed-rule guard)", () => {
  const disapprovals: Array<[string, VerifierResult | string]> = [
    ["verifier complete:false", { complete: false, missing: [] }],
    ["verifier non-empty missing", { complete: false, missing: [{ rule: "never read the holdout" }] }],
    ["verifier unparseable JSON", "the model said nothing structured"],
  ];
  for (const [name, vpayload] of disapprovals) {
    it(`SAFE auditor but ${name} ⇒ prompt BYTE-IDENTICAL + skipReason /verifier/i`, async () => {
      const { ctx, dir } = await ctxFor();
      const before = fs.readFileSync(ctx.paths.promptFile("generator"), "utf8");
      const rows = await auditPrompts(ctx, {
        roles: ["generator"], apply: true, runSessionFn: fakeRoleAware(SAFE, vpayload),
      });
      expect(rows[0]!.applied).toBe(false);
      expect(rows[0]!.skipped).toBe(true);
      expect(rows[0]!.skipReason).toMatch(/verifier/i);
      // NOT the generic coverage reason — coverage passed; the verifier is what refused.
      expect(rows[0]!.skipReason).not.toMatch(/coverage/i);
      expect(fs.readFileSync(ctx.paths.promptFile("generator"), "utf8")).toBe(before);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  it("auditor UNSAFE (shouldApply false) ⇒ byte-identical AND the verifier is NEVER called", async () => {
    const { ctx, dir } = await ctxFor();
    const before = fs.readFileSync(ctx.paths.promptFile("generator"), "utf8");
    let verifierCalls = 0;
    const unsafe: AuditResult = { ...SAFE, droppedNothing: false };
    const rows = await auditPrompts(ctx, {
      roles: ["generator"], apply: true,
      runSessionFn: fakeRoleAware(unsafe, APPROVE, { verifier: () => verifierCalls++ }),
    });
    expect(rows[0]!.applied).toBe(false);
    expect(verifierCalls).toBe(0);
    expect(fs.readFileSync(ctx.paths.promptFile("generator"), "utf8")).toBe(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("report-only (no --apply) NEVER calls the verifier", async () => {
    const { ctx, dir } = await ctxFor();
    let verifierCalls = 0;
    await auditPrompts(ctx, {
      roles: ["generator"], runSessionFn: fakeRoleAware(SAFE, APPROVE, { verifier: () => verifierCalls++ }),
    });
    expect(verifierCalls).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("source=default + --apply NEVER calls the verifier (report-only)", async () => {
    const { ctx, dir } = await ctxFor();
    let verifierCalls = 0;
    await auditPrompts(ctx, {
      roles: ["generator"], source: "default", apply: true,
      runSessionFn: fakeRoleAware(SAFE, APPROVE, { verifier: () => verifierCalls++ }),
    });
    expect(verifierCalls).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("INDEPENDENCE: the verifier sees BOTH original + tightened, its OWN system prompt, read-only, no write tools, overrides applied", async () => {
    const { ctx, dir } = await ctxFor();
    let auditorReq: RunSessionParams | undefined;
    let verifierReq: RunSessionParams | undefined;
    await auditPrompts(ctx, {
      roles: ["generator"], apply: true, backend: "codex", model: "gpt-5.5", effort: "xhigh",
      runSessionFn: fakeRoleAware(SAFE, APPROVE, {
        auditor: (p) => (auditorReq = p),
        verifier: (p) => (verifierReq = p),
      }),
    });
    expect(verifierReq).toBeDefined();
    // re-derives FROM SOURCE: the verifier prompt carries BOTH the original and the tightened text
    expect(verifierReq!.prompt).toContain(DEFAULT_PROMPTS["generator"]!.slice(0, 40)); // original
    expect(verifierReq!.prompt).toContain(SAFE.tightened!); // proposed tightened
    // its own system prompt, distinct from the auditor's
    expect(verifierReq!.systemPrompt).not.toBe(auditorReq!.systemPrompt);
    expect(verifierReq!.systemPrompt).toMatch(/VERIFIER/);
    // safety + overrides
    expect(verifierReq!.readOnly).toBe(true);
    expect(verifierReq!.tools ?? []).not.toContain("Write");
    expect(verifierReq!.tools ?? []).not.toContain("Edit");
    expect(verifierReq!.tools ?? []).not.toContain("Bash");
    expect(verifierReq!.backend).toBe("codex");
    expect(verifierReq!.model).toBe("gpt-5.5");
    expect(verifierReq!.effort).toBe("xhigh");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("records the verifier outcome in the review file on a verifier-skip --apply", async () => {
    const { ctx, dir } = await ctxFor();
    const flagged: VerifierResult = { complete: false, missing: [{ rule: "never read the holdout" }] };
    const rows = await auditPrompts(ctx, {
      roles: ["generator"], apply: true, runSessionFn: fakeRoleAware(SAFE, flagged),
    });
    const review = fs.readFileSync(rows[0]!.reviewPath, "utf8");
    expect(review).toMatch(/verifier/i);
    expect(review).toContain("never read the holdout");
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

describe("auditPrompts — source=default (audit the shipping DEFAULT_PROMPTS)", () => {
  it("audits DEFAULT_PROMPTS even when a drifted on-disk prompt exists", async () => {
    const { ctx, dir } = await ctxFor();
    fs.writeFileSync(ctx.paths.promptFile("generator"), "DRIFTED LOCAL — ignore me\n");
    let req: RunSessionParams | undefined;
    const rows = await auditPrompts(ctx, {
      roles: ["generator"], source: "default", runSessionFn: fakeRun(SAFE, (p) => (req = p)),
    });
    expect(req!.prompt).not.toContain("DRIFTED LOCAL"); // the on-disk drift is ignored
    expect(req!.prompt).toContain(DEFAULT_PROMPTS["generator"]!.slice(0, 40)); // the built-in default is audited
    expect(rows[0]!.sizeBefore.chars).toBe(DEFAULT_PROMPTS["generator"]!.length);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is REPORT-ONLY: --apply never rewrites the on-disk prompt for source=default", async () => {
    const { ctx, dir } = await ctxFor();
    const before = fs.readFileSync(ctx.paths.promptFile("generator"), "utf8");
    const rows = await auditPrompts(ctx, {
      roles: ["generator"], source: "default", apply: true, runSessionFn: fakeRun(SAFE),
    });
    expect(rows[0]!.applied).toBe(false);
    expect(rows[0]!.skipped).toBe(false); // report-only, not a coverage skip
    expect(fs.readFileSync(ctx.paths.promptFile("generator"), "utf8")).toBe(before);
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

describe("prompt-audit-verifier DEFAULT_PROMPTS text", () => {
  it("carries the independent-enumeration cue, the protect-safety discipline, and the JSON fields", () => {
    const t = DEFAULT_PROMPTS["prompt-audit-verifier"]!;
    expect(t).toMatch(/independent/i);
    expect(t).toMatch(/re-enumerate/i);
    expect(t).toMatch(/original/i);
    expect(t).toMatch(/safety/i);
    expect(t).toMatch(/holdout/i);
    expect(t).toMatch(/complete/);
    expect(t).toMatch(/missing/);
    // it must NOT derive from the auditor's coverage
    expect(t).toMatch(/coverage/i);
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
