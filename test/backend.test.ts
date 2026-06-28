import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { getBackend, listBackends, registerBackend, type AgentBackend, type AgentRequest, type AgentResult } from "../src/sdk/backend.ts";
import { codexSandboxMode, isEmptyCompletion } from "../src/sdk/backends/codex.ts";
import { consumeQuery } from "../src/sdk/backends/claude.ts";
import { TraceWriter } from "../src/sdk/trace.ts";
import "../src/sdk/session.ts"; // side-effect: registers the claude + codex backends

describe("agent backend registry (the AgentBackend seam)", () => {
  it("registers the claude backend with expected capabilities", () => {
    const b = getBackend("claude");
    expect(b.id).toBe("claude");
    expect(b.capabilities.hooks).toBe(true);
    expect(b.capabilities.mcp).toBe(true);
    expect(b.capabilities.resume).toBe(true);
    expect(b.capabilities.cost).toBe("usd");
    expect(listBackends()).toContain("claude");
  });

  it("defaults to claude", () => {
    expect(getBackend().id).toBe("claude");
  });

  it("throws on an unknown backend", () => {
    expect(() => getBackend("nope")).toThrow(/Unknown agent backend/);
  });

  it("lets a new backend slot in behind the same interface (where Codex will land)", async () => {
    const fake: AgentBackend = {
      id: "fake",
      capabilities: { resume: false, streaming: false, outputSchema: true, mcp: false, hooks: false, sandbox: true, skills: false, cost: "tokens" },
      runTask: async (req) => ({
        ok: true,
        subtype: "success",
        resultText: `ran ${req.role} on ${req.model}`,
        sessionId: "t1",
        costUsd: 0,
        tokens: 42,
        numTurns: 1,
        hitMaxTurns: false,
        hitBudget: false,
        errors: [],
        tracePath: "",
      }),
    };
    registerBackend(fake);
    expect(getBackend("fake").capabilities.sandbox).toBe(true);

    // The normalized request shape (writeScope/readOnly/outputSchema intent) is honored
    // without any Claude-specific fields.
    const r = await getBackend("fake").runTask({
      role: "generator",
      prompt: "build it",
      systemPrompt: "you are a builder",
      model: "some-model",
      cwd: "/tmp/work",
      writeScope: ["/tmp/work"],
      outputSchema: { type: "object" },
      maxTokens: 1000,
      traceDir: "/tmp/work",
      traceSeq: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.tokens).toBe(42);
  });
});

describe("codex backend", () => {
  it("is registered with sandbox-first, schema-native capabilities", () => {
    const b = getBackend("codex");
    expect(b.id).toBe("codex");
    expect(b.capabilities.sandbox).toBe(true);
    expect(b.capabilities.outputSchema).toBe(true);
    expect(b.capabilities.hooks).toBe(false);
    expect(b.capabilities.cost).toBe("tokens");
  });

  // NOTE: the "@openai/codex-sdk not installed → error_backend_unavailable" path is in
  // the adapter (try/catch around the lazy import) but isn't unit-tested: the package is
  // an optional dependency, so it's present in dev/CI, and invoking runTask for real would
  // spawn the codex CLI (network). The live path is validated by a manual smoke test.

  // The sandbox DECISION is extracted into a pure helper so we can exercise it without
  // spawning the CLI. (Mirrors the no-live-call rule in test/build.test.ts.)
  describe("codexSandboxMode (req → ThreadOptions.sandboxMode)", () => {
    it("readOnly ALWAYS wins, even when a sandbox knob is set", () => {
      expect(codexSandboxMode({ readOnly: true })).toBe("read-only");
      expect(codexSandboxMode({ readOnly: true, sandbox: "danger-full-access" })).toBe("read-only");
      expect(codexSandboxMode({ readOnly: true, sandbox: "workspace-write" })).toBe("read-only");
    });

    it("a write role defaults to workspace-write when the knob is unset (unchanged from today)", () => {
      expect(codexSandboxMode({})).toBe("workspace-write");
      expect(codexSandboxMode({ readOnly: false })).toBe("workspace-write");
    });

    it("honors the requested write-role sandbox", () => {
      expect(codexSandboxMode({ sandbox: "workspace-write" })).toBe("workspace-write");
      expect(codexSandboxMode({ sandbox: "danger-full-access" })).toBe("danger-full-access");
    });

    it("the exerciseScratch carve-out relaxes a read-only EXERCISE to workspace-write", () => {
      // A plain read-only role stays strictly read-only…
      expect(codexSandboxMode({ readOnly: true })).toBe("read-only");
      // …but the exercising evaluator needs writable scratch for test/build tools.
      expect(codexSandboxMode({ readOnly: true, exerciseScratch: true })).toBe("workspace-write");
      // The carve-out only applies to read-only roles (write roles are unaffected).
      expect(codexSandboxMode({ exerciseScratch: true })).toBe("workspace-write");
      expect(codexSandboxMode({ sandbox: "danger-full-access", exerciseScratch: true })).toBe("danger-full-access");
    });
  });

  // Item I: a silent empty completion (ok, 0 tokens, no text) is classified as a limit so runRole
  // falls back over roles.<role>.fallback (the codex→claude path proven by the auto-fallback tests
  // in roleRun.test.ts) instead of churning on a bogus empty verdict.
  describe("isEmptyCompletion (silent empty result → treated as a limit)", () => {
    it("is true ONLY for ok + zero tokens + no text", () => {
      expect(isEmptyCompletion({ ok: true, tokens: 0, resultText: "" })).toBe(true);
      expect(isEmptyCompletion({ ok: true, tokens: 0, resultText: "   \n " })).toBe(true); // whitespace-only counts as empty
    });
    it("is false when there is real output, tokens, or an error", () => {
      expect(isEmptyCompletion({ ok: true, tokens: 0, resultText: "hi" })).toBe(false); // has text
      expect(isEmptyCompletion({ ok: true, tokens: 5, resultText: "" })).toBe(false); // spent tokens
      expect(isEmptyCompletion({ ok: false, tokens: 0, resultText: "" })).toBe(false); // already an error
    });
  });
});

// Item J: the message-consumption seam must surface a terminal result (hitMaxTurns/hitBudget)
// instead of rejecting on the SDK's trailing exit-throw — see the ordering note in consumeQuery.
describe("consumeQuery — terminal results survive the SDK's trailing exit-throw", () => {
  // A hand-rolled AsyncIterable<SDKMessage> mirroring the observed SDK ordering: it yields the
  // listed messages, then (optionally) THROWS — exactly as query() does after an error result.
  function fakeStream(msgs: any[], throwAfter?: Error): AsyncIterable<any> {
    return {
      async *[Symbol.asyncIterator]() {
        for (const m of msgs) yield m;
        if (throwAfter) throw throwAfter;
      },
    };
  }

  function blankResult(): AgentResult {
    return {
      ok: false,
      subtype: "unknown",
      resultText: "",
      sessionId: "",
      costUsd: 0,
      tokens: 0,
      numTurns: 0,
      hitMaxTurns: false,
      hitBudget: false,
      errors: [],
      tracePath: "",
    };
  }

  function makeCtx() {
    const file = path.join(os.tmpdir(), `sparra-consumeQuery-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    const trace = new TraceWriter(file, "# test\n");
    const req = { role: "tester", prompt: "p", systemPrompt: "s", model: "m", cwd: "/tmp", traceDir: os.tmpdir(), traceSeq: 1 } as AgentRequest;
    return { result: blankResult(), trace, req, echo: false };
  }

  const initMsg = { type: "system", subtype: "init", session_id: "sess-J", model: "m", uuid: "u1" };

  it("turn-cap: yields init + error_max_turns then THROWS ⇒ structured, resumable, no throw", async () => {
    const ctx = makeCtx();
    const r = await consumeQuery(
      fakeStream(
        [
          initMsg,
          { type: "result", subtype: "error_max_turns", is_error: true, errors: ["Reached maximum number of turns (2)"], num_turns: 2, total_cost_usd: 0, session_id: "sess-J", uuid: "u2" },
        ],
        new Error("Claude Code returned an error result: Reached maximum number of turns (2)"),
      ),
      ctx,
    );
    expect(r.hitMaxTurns).toBe(true);
    expect(r.hitBudget).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.subtype).toBe("error_max_turns");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.sessionId).toBe("sess-J");
  });

  it("budget-cap: error_max_budget_usd then THROWS ⇒ hitBudget, no throw", async () => {
    const ctx = makeCtx();
    const r = await consumeQuery(
      fakeStream(
        [
          initMsg,
          { type: "result", subtype: "error_max_budget_usd", is_error: true, errors: ["Reached max budget"], num_turns: 1, total_cost_usd: 5, session_id: "sess-J", uuid: "u2" },
        ],
        new Error("Claude Code returned an error result: Reached max budget"),
      ),
      ctx,
    );
    expect(r.hitBudget).toBe(true);
    expect(r.hitMaxTurns).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.subtype).toBe("error_max_budget_usd");
    expect(r.sessionId).toBe("sess-J");
  });

  it("pre-result failure (negative): init then THROWS with NO result ⇒ REJECTS (gate is on the result, not sessionId)", async () => {
    const ctx = makeCtx();
    await expect(
      consumeQuery(fakeStream([initMsg], new Error("spawn ENOENT")), ctx),
    ).rejects.toThrow(/spawn ENOENT/);
    // The init message arrived (sessionId captured) but a never-completed run must NOT
    // be returned as a silent ok:false result.
    expect(ctx.result.subtype).toBe("unknown");
  });

  it("success control: init + success result ⇒ ok:true, resultText populated, no throw", async () => {
    const ctx = makeCtx();
    const r = await consumeQuery(
      fakeStream([
        initMsg,
        { type: "result", subtype: "success", is_error: false, result: "all done", num_turns: 1, total_cost_usd: 1, session_id: "sess-J", uuid: "u2" },
      ]),
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.subtype).toBe("success");
    expect(r.resultText).toBe("all done");
    expect(r.sessionId).toBe("sess-J");
  });
});
