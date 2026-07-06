import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { negotiateContract } from "../src/build/contract.ts";
import type { CommandExecutor, ExecOutcome } from "../src/build/exec.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import { DEFAULT_PROMPTS } from "../src/prompts.ts";
import type { Ctx } from "../src/context.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

/**
 * Q3: the harness verify-PROBE on contract agreement. All offline — the SDK session and the
 * command executor are BOTH dependency-injected fakes; no live model calls, no real spawns.
 */

/** Compare two dotted numeric versions (e.g. "2026.7.5.2"): >0 if a>b, 0 if equal, <0 if a<b.
 *  Segment-wise numeric so the plugin-version assertion tolerates forward bumps. */
function cmpDottedVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

async function makeCtx(withHoldout = false): Promise<{ ctx: Ctx; root: string; wt: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-probe-root-"));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-probe-wt-"));
  const paths = new Paths(root);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, "greenfield");
  const ctx: Ctx = { root, paths, config: defaultConfig(), store };
  if (withHoldout) fs.writeFileSync(paths.holdout, "# Holdout\n\n- The secret acceptance check nobody may see.\n");
  return { ctx, root, wt };
}

const item = { id: "item-001", title: "thing", summary: "s", dependsOn: [], rationale: "" };

/** Proposal text with a real "I will verify by" section around `cmd`. */
const proposalWith = (cmd: string) => `## Item\nA thing.\n## I will verify by\n- \`${cmd}\` → exit 0\n## Assertions\n1. works`;

/** Session fake: generator proposes (per-round command), evaluator always AGREES. Records calls. */
function fakeSession(commandForRound: (round: number) => string) {
  const calls: RunSessionParams[] = [];
  let genRound = 0;
  const fn = async (p: RunSessionParams): Promise<RunResult> => {
    calls.push(p);
    const text = p.role === "contract-generator" ? proposalWith(commandForRound(++genRound)) : "Looks solid.\nCONTRACT: AGREED";
    return { ok: true, subtype: "success", resultText: text, sessionId: "s", costUsd: 0, tokens: 0, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "" };
  };
  return { calls, fn };
}

const usage = (command: string, stderr = "error: unknown option --bogus"): ExecOutcome => ({ ran: true, command, exitCode: 2, stdout: "", stderr, timedOut: false });
const behavioral = (command: string): ExecOutcome => ({ ran: true, command, exitCode: 1, stdout: "", stderr: "artifact not built yet", timedOut: false });

describe("negotiateContract — harness verify-probe on agreement", () => {
  it("usage error re-opens negotiation with the probe output in the next generator's context; a fixed command then agrees", async () => {
    const { ctx, root, wt } = await makeCtx();
    const session = fakeSession((r) => (r === 1 ? "mytool --bogus" : "mytool run"));
    const probed: string[] = [];
    const exec: CommandExecutor = async (ws, cmd) => {
      probed.push(cmd);
      expect(ws).toBe(wt); // probe dry-runs in the WORKSPACE
      return cmd.includes("--bogus") ? usage(cmd) : behavioral(cmd);
    };

    const res = await negotiateContract(ctx, item, wt, 1, "", wt, session.fn, exec);

    expect(res.agreed).toBe(true);
    expect(probed).toEqual(["mytool --bogus", "mytool run"]);
    // Negotiation RE-OPENED: 2 generator + 2 evaluator rounds, not 1+1.
    const genCalls = session.calls.filter((c) => c.role === "contract-generator");
    expect(genCalls).toHaveLength(2);
    // The round-2 generator saw the probe output (appended to the critique context) —
    // so the loop did NOT proceed with the broken contract.
    expect(genCalls[1]!.prompt).toContain("HARNESS VERIFY-PROBE");
    expect(genCalls[1]!.prompt).toContain("mytool --bogus");
    // The agreed contract is the FIXED round-2 proposal.
    expect(res.text).toContain("mytool run");
    expect(res.text).not.toContain("--bogus");
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it("an UNSAFE verify command (safety-rule-rejected, never ran) bounces the contract like a usage error", async () => {
    const { ctx, root, wt } = await makeCtx();
    const session = fakeSession((r) => (r === 1 ? "npm test && echo done" : "npm test"));
    const probed: string[] = [];
    const exec: CommandExecutor = async (_ws, cmd) => {
      probed.push(cmd);
      // Mirrors the real executor: the chained command is rejected by the safety rules
      // (ran: false — never spawned); the fixed one runs and fails behaviorally (pre-build).
      return cmd.includes("&&")
        ? { ran: false as const, command: cmd, unsafeReason: "chained command (&&) — single self-contained commands only" }
        : behavioral(cmd);
    };

    const res = await negotiateContract(ctx, item, wt, 1, "", wt, session.fn, exec);

    expect(res.agreed).toBe(true);
    expect(probed).toEqual(["npm test && echo done", "npm test"]);
    // Negotiation RE-OPENED — the unsafe command did NOT sail through as an agreed contract.
    const genCalls = session.calls.filter((c) => c.role === "contract-generator");
    expect(genCalls).toHaveLength(2);
    expect(genCalls[1]!.prompt).toContain("HARNESS VERIFY-PROBE");
    expect(genCalls[1]!.prompt).toContain("npm test && echo done"); // probe output names the command
    expect(genCalls[1]!.prompt).toMatch(/unsafe/i); // …and says why it can never run
    // The agreed contract carries only the harness-runnable command.
    expect(res.text).not.toContain("&&");
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it("a BEHAVIORAL probe failure (artifact not built yet) does NOT bounce — agrees in round 1", async () => {
    const { ctx, root, wt } = await makeCtx();
    const session = fakeSession(() => "mytool run");
    const exec: CommandExecutor = async (_ws, cmd) => behavioral(cmd);
    const res = await negotiateContract(ctx, item, wt, 1, "", wt, session.fn, exec);
    expect(res.agreed).toBe(true);
    expect(session.calls.filter((c) => c.role === "contract-generator")).toHaveLength(1);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it("wires item.relevantPaths through selectMapContext: contract-generator prompt prefers the named section + lists the file", async () => {
    const { ctx, root, wt } = await makeCtx();
    const LATE = "## src/build/late.ts\nSENTINEL_LATE marks the tricky seam for this item.\n";
    const MAP = "# Overview\n" + "unrelated filler describing other modules.\n".repeat(120) + LATE;
    fs.mkdirSync(path.dirname(ctx.paths.frozenMap), { recursive: true });
    fs.writeFileSync(ctx.paths.frozenMap, MAP);
    expect(MAP.indexOf("SENTINEL_LATE")).toBeGreaterThan(4000); // past the contract head cap

    const session = fakeSession(() => "mytool run");
    const exec: CommandExecutor = async (_ws, cmd) => behavioral(cmd);
    await negotiateContract(
      ctx, { ...item, relevantPaths: ["src/build/late.ts"] }, wt, 1, "", wt, session.fn, exec
    );
    const gen = session.calls.filter((c) => c.role === "contract-generator")[0]!;
    expect(gen.prompt).toContain("Files most relevant to this item:");
    expect(gen.prompt).toContain("- src/build/late.ts");
    expect(gen.prompt).toContain("SENTINEL_LATE"); // the targeted section a head-slice would drop
    expect(gen.prompt).not.toContain(MAP.slice(0, 200)); // NOT the blind head (targeting displaced it)
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it("absent relevantPaths → the contract-generator sees the blind head-slice (byte-for-byte today)", async () => {
    const { ctx, root, wt } = await makeCtx();
    const MAP = "# Overview\n" + "unrelated filler describing other modules.\n".repeat(120) + "## src/build/late.ts\nSENTINEL_LATE seam.\n";
    fs.mkdirSync(path.dirname(ctx.paths.frozenMap), { recursive: true });
    fs.writeFileSync(ctx.paths.frozenMap, MAP);
    const session = fakeSession(() => "mytool run");
    const exec: CommandExecutor = async (_ws, cmd) => behavioral(cmd);
    await negotiateContract(ctx, item, wt, 1, "", wt, session.fn, exec);
    const gen = session.calls.filter((c) => c.role === "contract-generator")[0]!;
    expect(gen.prompt).toContain(MAP.slice(0, 4000));
    expect(gen.prompt).not.toContain("Files most relevant to this item:");
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it("respects maxNegotiationRounds when the probe keeps bouncing (forced non-agreed convergence)", async () => {
    const { ctx, root, wt } = await makeCtx();
    ctx.config.contract.maxNegotiationRounds = 2;
    const session = fakeSession(() => "mytool --bogus"); // never fixed
    const exec: CommandExecutor = async (_ws, cmd) => usage(cmd);
    const res = await negotiateContract(ctx, item, wt, 1, "", wt, session.fn, exec);
    expect(res.agreed).toBe(false); // round cap respected — no infinite probe loop
    expect(session.calls.filter((c) => c.role === "contract-generator")).toHaveLength(2);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it("contract.probeVerifyCommands=false skips the probe entirely (executor never called)", async () => {
    const { ctx, root, wt } = await makeCtx();
    ctx.config.contract.probeVerifyCommands = false;
    const session = fakeSession(() => "mytool --bogus");
    const exec = vi.fn<CommandExecutor>(async (_ws, cmd) => usage(cmd));
    const res = await negotiateContract(ctx, item, wt, 1, "", wt, session.fn, exec);
    expect(res.agreed).toBe(true); // broken command sails through — probe is OFF
    expect(exec).not.toHaveBeenCalled();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it("a contract with NO verify commands probes nothing and agrees", async () => {
    const { ctx, root, wt } = await makeCtx();
    const calls: RunSessionParams[] = [];
    const fn = async (p: RunSessionParams): Promise<RunResult> => {
      calls.push(p);
      const text = p.role === "contract-generator" ? "## Item\nA thing.\n## Assertions\n1. works" : "CONTRACT: AGREED";
      return { ok: true, subtype: "success", resultText: text, sessionId: "s", costUsd: 0, tokens: 0, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "" };
    };
    const exec = vi.fn<CommandExecutor>(async (_ws, cmd) => usage(cmd));
    const res = await negotiateContract(ctx, item, wt, 1, "", wt, fn, exec);
    expect(res.agreed).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it("probe output is HOLDOUT-REDACTED before entering the generator's critique context", async () => {
    const { ctx, root, wt } = await makeCtx(true); // holdout on disk
    const session = fakeSession((r) => (r === 1 ? "mytool --bogus" : "mytool run"));
    // A pathological executor that echoes a holdout line in its usage stderr — the redaction
    // wall must scrub it before the (forbid-role) generator sees the probe report. Without
    // redaction, negotiateContract's own assertNoHoldoutLeak would THROW here.
    const exec: CommandExecutor = async (_ws, cmd) =>
      cmd.includes("--bogus") ? usage(cmd, "unknown option --bogus\nThe secret acceptance check nobody may see.") : behavioral(cmd);
    const res = await negotiateContract(ctx, item, wt, 1, "", wt, session.fn, exec);
    expect(res.agreed).toBe(true);
    const round2 = session.calls.filter((c) => c.role === "contract-generator")[1]!;
    expect(round2.prompt).toContain("[redacted: holdout]");
    expect(round2.prompt).not.toContain("secret acceptance check");
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });
});

/**
 * U-A: the runner-side assertion-DROP guard, exercised through negotiateContract with injected
 * session/executor fakes (no live model calls). The pure helpers are unit-tested in dropGuard.test.ts.
 */
describe("negotiateContract — assertion-drop guard on revision", () => {
  const A1 = "tool add 2 3 prints 5 exits 0";
  const A2 = "negotiateContract voids agreement on an uncited assertion drop";
  const A3 = "holdout redaction scrubs the sentinel before the generator sees it";
  // Contracts carry NO "I will verify by" section, so the verify-probe never fires here — this
  // isolates the drop guard from the probe (they compose, tested separately above).
  const contract = (asserts: string[]) =>
    `## Item\nA thing.\n## I will build\nX.\n## Assertions\n${asserts.map((a, i) => `${i + 1}. ${a}`).join("\n")}\n`;

  /** Scripted fake: generator emits `proposals[round-1]`, evaluator emits `critiques[round-1]`. */
  function scriptedSession(proposals: string[], critiques: string[]) {
    const calls: RunSessionParams[] = [];
    let g = 0;
    let e = 0;
    const fn = async (p: RunSessionParams): Promise<RunResult> => {
      calls.push(p);
      const text =
        p.role === "contract-generator"
          ? proposals[Math.min(g++, proposals.length - 1)]!
          : critiques[Math.min(e++, critiques.length - 1)]!;
      return { ok: true, subtype: "success", resultText: text, sessionId: "s", costUsd: 0, tokens: 0, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "" };
    };
    return { calls, fn };
  }
  const noProbe: CommandExecutor = async (_ws, cmd) => ({ ran: true, command: cmd, exitCode: 0, stdout: "", stderr: "", timedOut: false });
  const genPrompts = (calls: RunSessionParams[]) => calls.filter((c) => c.role === "contract-generator").map((c) => c.prompt);

  it("an UNCITED drop + a same-round AGREE does NOT accept: it re-opens and the next generator sees the drop-guard marker + dropped text", async () => {
    const { ctx, root, wt } = await makeCtx();
    const session = scriptedSession(
      // r1: all three; r2: drops A2 (uncited); r3: restores A2.
      [contract([A1, A2, A3]), contract([A1, A3]), contract([A1, A2, A3])],
      // r1 critique names ONLY assertion 1; r2/r3 AGREE.
      ["Assertion 1's wording is loose — make 'prints 5' exact.", "Looks solid.\nCONTRACT: AGREED", "Good.\nCONTRACT: AGREED"]
    );
    const res = await negotiateContract(ctx, item, wt, 1, "", wt, session.fn, noProbe);

    const prompts = genPrompts(session.calls);
    expect(prompts.length).toBeGreaterThanOrEqual(3); // round-3 generator call happened
    expect(prompts[2]).toContain("HARNESS DROP-GUARD");
    expect(prompts[2]).toContain(A2); // the dropped assertion's text is in the round-3 context
    // Round 2's AGREE was voided (the drop guard re-opened negotiation), not accepted at round 2.
    expect(prompts[1]).not.toContain("HARNESS DROP-GUARD");
    expect(res.agreed).toBe(true); // round 3 restored A2 and agreed cleanly
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it("records the dropped assertion in a drop-guard section of the negotiation file", async () => {
    const { ctx, root, wt } = await makeCtx();
    const session = scriptedSession(
      [contract([A1, A2, A3]), contract([A1, A3]), contract([A1, A2, A3])],
      ["Assertion 1's wording is loose.", "CONTRACT: AGREED", "CONTRACT: AGREED"]
    );
    await negotiateContract(ctx, item, wt, 1, "", wt, session.fn, noProbe);
    const file = fs.readFileSync(ctx.paths.contractFile(item.id), "utf8");
    expect(file).toMatch(/drop-guard/i);
    expect(file).toContain(A2);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it("an EXPLICITLY-cited drop does NOT bounce: the round-2 agreement stands, no marker in any generator prompt", async () => {
    const { ctx, root, wt } = await makeCtx();
    const session = scriptedSession(
      [contract([A1, A2, A3]), contract([A1, A3])],
      [`CUT assertion 2 (${A2}) — redundant with assertion 3.`, "CONTRACT: AGREED"]
    );
    const res = await negotiateContract(ctx, item, wt, 1, "", wt, session.fn, noProbe);
    const prompts = genPrompts(session.calls);
    expect(prompts).toHaveLength(2); // agreed at round 2 — no re-open
    expect(res.agreed).toBe(true);
    expect(prompts.join("\n")).not.toContain("HARNESS DROP-GUARD");
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it("a reword-within-citation revision drops nothing → no bounce", async () => {
    const { ctx, root, wt } = await makeCtx();
    const session = scriptedSession(
      [contract([A1, A2, A3]), contract([A1, "negotiateContract must void the agreement whenever an uncited assertion is silently dropped", A3])],
      ["Assertion 2 could be sharper.", "CONTRACT: AGREED"]
    );
    const res = await negotiateContract(ctx, item, wt, 1, "", wt, session.fn, noProbe);
    const prompts = genPrompts(session.calls);
    expect(prompts).toHaveLength(2);
    expect(res.agreed).toBe(true);
    expect(prompts.join("\n")).not.toContain("HARNESS DROP-GUARD");
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it("the round>1 generator prompt carries the patch instruction (keep uncited assertions verbatim; list drops)", async () => {
    const { ctx, root, wt } = await makeCtx();
    const session = scriptedSession(
      [contract([A1, A2, A3]), contract([A1, A2, A3])], // no drop
      ["Assertion 2 could be sharper.", "CONTRACT: AGREED"]
    );
    await negotiateContract(ctx, item, wt, 1, "", wt, session.fn, noProbe);
    const round2 = genPrompts(session.calls)[1]!;
    expect(round2).toMatch(/PATCH/);
    expect(round2).toMatch(/VERBATIM/i);
    expect(round2).toMatch(/dropped\/changed|none dropped/i);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });
});

/**
 * U-B: the delta-critique protocol for re-critique rounds, exercised through negotiateContract with
 * injected session/executor fakes (no live model calls). Verify-section-free, identical-assertion
 * contracts isolate the delta protocol from the verify-probe and drop-guard machinery (both above).
 */
describe("negotiateContract — delta-critique protocol on re-critique rounds", () => {
  // No "## I will verify by" section ⇒ the probe never fires; identical "## Assertions" each round
  // ⇒ the drop guard never fires. `marker` only varies the (non-asserted) build section.
  const plain = (marker: string) => `## Item\nA thing.\n## I will build\nX ${marker}.\n## Assertions\n1. it works\n`;

  /** Scripted fake: generator emits `proposals[round-1]`, evaluator emits `critiques[round-1]`. */
  function scripted(proposals: string[], critiques: string[]) {
    const calls: RunSessionParams[] = [];
    let g = 0;
    let e = 0;
    const fn = async (p: RunSessionParams): Promise<RunResult> => {
      calls.push(p);
      const text =
        p.role === "contract-generator"
          ? proposals[Math.min(g++, proposals.length - 1)]!
          : critiques[Math.min(e++, critiques.length - 1)]!;
      return { ok: true, subtype: "success", resultText: text, sessionId: "s", costUsd: 0, tokens: 0, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "" };
    };
    return { calls, fn };
  }
  const clean: CommandExecutor = async (_ws, cmd) => ({ ran: true, command: cmd, exitCode: 0, stdout: "", stderr: "", timedOut: false });
  const evalPrompts = (calls: RunSessionParams[]) => calls.filter((c) => c.role === "contract-evaluator").map((c) => c.prompt);

  it("round>1 evaluator prompts accumulate ALL prior critiques labeled by round + the RE-CRITIQUE marker; round 1 has neither (assertions 1, 2)", async () => {
    const { ctx, root, wt } = await makeCtx();
    const session = scripted(
      [plain("v1"), plain("v2"), plain("v3")],
      // r1/r2 do NOT agree (distinct sentinels); r3 agrees.
      ["CRIT-R1-xyz: assertion 1 too loose.", "CRIT-R2-xyz: tighten the fixture.", "Good.\nCONTRACT: AGREED"]
    );
    const res = await negotiateContract(ctx, item, wt, 1, "", wt, session.fn, clean);
    expect(res.agreed).toBe(true);
    const [p1, p2, p3] = evalPrompts(session.calls) as [string, string, string];

    // Round 1: full-scope adversarial, no delta and no prior-critique block.
    expect(p1).not.toContain("RE-CRITIQUE:");
    expect(p1).not.toContain("CRIT-R1-xyz");
    // Round 2: prior round-1 critique carried in + the delta marker.
    expect(p2).toContain("RE-CRITIQUE:");
    expect(p2).toContain("CRIT-R1-xyz");
    expect(p2).toMatch(/Round 1 critique/);
    // Round 3: BOTH prior critiques, EACH labeled by its round (defeats last-critique-only).
    expect(p3).toContain("CRIT-R1-xyz");
    expect(p3).toContain("CRIT-R2-xyz");
    expect(p3).toMatch(/Round 1 critique/);
    expect(p3).toMatch(/Round 2 critique/);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it("a verify-probe bounce rides into the next round's evaluator prompt as prior-critique context (assertion 3)", async () => {
    const { ctx, root, wt } = await makeCtx();
    const session = fakeSession((r) => (r === 1 ? "mytool --bogus" : "mytool run"));
    const exec: CommandExecutor = async (_ws, cmd) => (cmd.includes("--bogus") ? usage(cmd) : behavioral(cmd));
    await negotiateContract(ctx, item, wt, 1, "", wt, session.fn, exec);
    const evals = evalPrompts(session.calls);
    expect(evals).toHaveLength(2); // round 1 bounced by the probe, round 2 agreed
    // The round-1 critique the round-2 evaluator sees INCLUDES the appended harness probe report.
    expect(evals[1]!).toContain("HARNESS VERIFY-PROBE");
    expect(evals[1]!).toContain("mytool --bogus");
    expect(evals[1]!).toContain("RE-CRITIQUE:");
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it("the RE-CRITIQUE instruction states all four delta rules (assertion 4)", async () => {
    const { ctx, root, wt } = await makeCtx();
    const session = scripted([plain("v1"), plain("v2")], ["needs work", "CONTRACT: AGREED"]);
    await negotiateContract(ctx, item, wt, 1, "", wt, session.fn, clean);
    const p2 = evalPrompts(session.calls)[1]!;
    expect(p2).toMatch(/RE-CRITIQUE:/);
    expect(p2).toMatch(/each prior point is resolved/i); // prior-points-resolved check
    expect(p2).toMatch(/new points outside the changed text/i); // no new points outside changed text…
    expect(p2).toMatch(/correctness-critical/i); // …unless correctness-critical
    expect(p2).toMatch(/reverse a position[^]*name the round/i); // no reversal without naming the round
    expect(p2).toMatch(/style\/conciseness nits are non-blocking/i); // style nits non-blocking on re-critique
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it("a 1-round agreement keeps the round-1 shape: Be adversarial + PROPOSED CONTRACT, no prior-critique block, no RE-CRITIQUE marker (assertion 9)", async () => {
    const { ctx, root, wt } = await makeCtx();
    const session = scripted([plain("v1")], ["CONTRACT: AGREED"]);
    const res = await negotiateContract(ctx, item, wt, 1, "", wt, session.fn, clean);
    expect(res.agreed).toBe(true);
    const evals = evalPrompts(session.calls);
    expect(evals).toHaveLength(1);
    expect(evals[0]!).toContain("Be adversarial");
    expect(evals[0]!).toContain("PROPOSED CONTRACT:");
    expect(evals[0]!).not.toContain("RE-CRITIQUE:");
    expect(evals[0]!).not.toContain("PRIOR CRITIQUES");
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });
});

describe("U-B delta-critique — prompt + skill + docs", () => {
  it("DEFAULT_PROMPTS[contract-evaluator] folds the re-critique protocol into the batching sentence (assertion 5)", () => {
    const p = DEFAULT_PROMPTS["contract-evaluator"]!;
    expect(p).toMatch(/grade only the delta/i); // delta-only
    expect(p).toMatch(/never reverse a prior-round position without naming/i); // no uncited reversals
    expect(p).toMatch(/style\/conciseness nits as non-blocking/i); // style nits non-blocking on re-critique
    // Folded INTO the existing batching sentence (same line), not a new section.
    const batchLine = p.split("\n").find((l) => l.includes("Batch ALL blocking issues"))!;
    expect(batchLine).toBeTruthy();
    expect(batchLine).toMatch(/RE-CRITIQUE round/);
  });

  it("SKILL.md instructs conductor-side re-critique (prior critique + delta instruction; inline, not a .sparra path) and bumps the plugin version (assertion 6)", () => {
    const skill = fs.readFileSync(path.join(process.cwd(), "skills/sparra-loop/SKILL.md"), "utf8");
    expect(skill).toMatch(/RE-CRITIQUE/);
    expect(skill).toMatch(/prior critique/i); // carry the prior critique text
    expect(skill).toMatch(/delta instruction/i); // …and state the delta instruction
    expect(skill).toMatch(/inline/i); // forbid role can't read .sparra/ — inline it
    const mkt = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".claude-plugin/marketplace.json"), "utf8"));
    // The version bumped by this item is a FLOOR, not an exact pin — later items only move it up.
    expect(cmpDottedVersion(mkt.metadata.version, "2026.7.5.1")).toBeGreaterThanOrEqual(0);
  });

  it("docs/build-loop.md documents the delta-critique protocol (assertion 7)", () => {
    const doc = fs.readFileSync(path.join(process.cwd(), "docs/build-loop.md"), "utf8");
    expect(doc).toMatch(/Delta-critique protocol/i);
    expect(doc).toMatch(/RE-CRITIQUE:/);
  });
});

describe("Q3 config defaults + prompt edits", () => {
  it("knobs default on: contract.probeVerifyCommands=true, build.flakinessReruns=2", () => {
    const cfg = defaultConfig();
    expect(cfg.contract.probeVerifyCommands).toBe(true);
    expect(cfg.build.flakinessReruns).toBe(2);
  });

  it("contract prompts no longer demand a model-side dry-run, still check the real surface, and reference the harness probe", () => {
    for (const role of ["contract-generator", "contract-evaluator"] as const) {
      const p = DEFAULT_PROMPTS[role]!;
      expect(p).not.toMatch(/dry[- ]run/i); // the model is never told to execute commands itself
      expect(p).toMatch(/harness probes/i); // …the harness probe is referenced instead
      expect(p).toMatch(/real source/i); // check-against-real-surface rule retained
    }
  });

  it("contract-generator carries the patch-revision discipline (survives-unless-named + dropped/changed list)", () => {
    const p = DEFAULT_PROMPTS["contract-generator"]!;
    expect(p).toMatch(/PATCH/); // a revision patches, not rewrites
    expect(p).toMatch(/VERBATIM/i); // existing assertions survive verbatim…
    expect(p).toMatch(/unless a critique point names it/i); // …unless a critique point names it
    expect(p).toMatch(/dropped\/changed/i); // explicit dropped/changed list
    expect(p).toMatch(/none dropped/i); // …or "none dropped"
  });
});

describe("negotiateContract — sandbox capability-notes injection (U-K)", () => {
  it("injects the KNOWN sandbox-capability notes into the contract-evaluator task for a Codex judge, NOT a Claude one", async () => {
    // Codex contract-evaluator → notes present.
    const { ctx, root, wt } = await makeCtx();
    ctx.config.roles.contractEvaluator.backend = "codex";
    const session = fakeSession(() => "npm test");
    await negotiateContract(ctx, item, wt, 1, "", wt, session.fn);
    const evalCall = session.calls.find((c) => c.role === "contract-evaluator")!;
    expect(evalCall.prompt).toContain("unix-domain-socket-listen");
    expect(evalCall.prompt).toContain("UN-RUN");
    expect(evalCall.prompt.toLowerCase()).toMatch(/do not re-prove/);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });

    // Claude contract-evaluator (default backend) → NO notes.
    const c = await makeCtx();
    const session2 = fakeSession(() => "npm test");
    await negotiateContract(c.ctx, item, c.wt, 1, "", c.wt, session2.fn);
    const evalCall2 = session2.calls.find((cc) => cc.role === "contract-evaluator")!;
    expect(evalCall2.prompt).not.toContain("unix-domain-socket-listen");
    expect(evalCall2.prompt).not.toContain("KNOWN SANDBOX CAPABILITY LIMITS");
    fs.rmSync(c.root, { recursive: true, force: true });
    fs.rmSync(c.wt, { recursive: true, force: true });
  });
});
