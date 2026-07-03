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
