import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { getBackend, listBackends, registerBackend, type AgentBackend, type AgentRequest, type AgentResult } from "../src/sdk/backend.ts";
import { codexBackend, codexSandboxMode, isEmptyCompletion, markEmptyCompletion, limitFromErrors as codexLimit } from "../src/sdk/backends/codex.ts";

// Capture the ThreadOptions the codex backend builds, without spawning the codex CLI.
const codexCapture = vi.hoisted(() => ({ threadOptions: undefined as any }));
vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    id = "codex-thread";
    startThread(opts: any) {
      codexCapture.threadOptions = opts;
      return { id: "codex-thread", run: async () => ({ usage: { total_tokens: 1 }, finalResponse: "ok" }) };
    }
    resumeThread(_id: string, opts: any) {
      return this.startThread(opts);
    }
  },
}));
import { consumeQuery, limitFromErrors as claudeLimit } from "../src/sdk/backends/claude.ts";
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

  it("distinguishes inProcessMcp per backend: claude hosts an in-process MCP server, codex does not", () => {
    // `mcp` (can call externally-configured MCP tools) is true for BOTH; only `inProcessMcp`
    // (can HOST an in-process createSdkMcpServer via req.mcpServers) discriminates them.
    expect(getBackend("claude").capabilities.mcp).toBe(true);
    expect(getBackend("codex").capabilities.mcp).toBe(true);
    expect(getBackend("claude").capabilities.inProcessMcp).toBe(true);
    expect(getBackend("codex").capabilities.inProcessMcp).toBe(false);
  });

  it("throws on an unknown backend", () => {
    expect(() => getBackend("nope")).toThrow(/Unknown agent backend/);
  });

  it("lets a new backend slot in behind the same interface (where Codex will land)", async () => {
    const fake: AgentBackend = {
      id: "fake",
      capabilities: { resume: false, streaming: false, outputSchema: true, mcp: false, inProcessMcp: false, hooks: false, sandbox: true, skills: false, cost: "tokens" },
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

  // U-A #6: when scratch flips a read-only judge (evaluator OR contract-evaluator) to
  // workspace-write, `networkAccessEnabled:false` must reach the Codex ThreadOptions for BOTH roles —
  // the write scope widens for test/build scratch, but the network stays sealed.
  describe("network stays OFF when scratch relaxes a judge to workspace-write", () => {
    function judgeReq(role: string, over: Partial<AgentRequest> = {}): AgentRequest {
      return {
        role,
        prompt: "p",
        systemPrompt: "s",
        model: "m",
        cwd: os.tmpdir(),
        readOnly: true,
        exerciseScratch: true,
        traceDir: os.tmpdir(),
        traceSeq: 1,
        echoActivity: false,
        ...over,
      } as AgentRequest;
    }

    it.each(["evaluator", "contract-evaluator"])(
      "%s: readOnly + exerciseScratch ⇒ sandbox workspace-write with networkAccessEnabled:false",
      async (role) => {
        codexCapture.threadOptions = undefined;
        await codexBackend.runTask(judgeReq(role));
        expect(codexCapture.threadOptions.sandboxMode).toBe("workspace-write");
        expect(codexCapture.threadOptions.networkAccessEnabled).toBe(false);
      }
    );

    it("a plain read-only judge (no scratch) stays read-only, no network relaxation flag", async () => {
      codexCapture.threadOptions = undefined;
      await codexBackend.runTask(judgeReq("evaluator", { exerciseScratch: false }));
      expect(codexCapture.threadOptions.sandboxMode).toBe("read-only");
      expect(codexCapture.threadOptions.networkAccessEnabled).toBeUndefined();
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

  // Item A: the promotion stamps the EXPLICIT `emptyCompletion` marker on our AgentResult —
  // the ORIGIN signal runRole's classification keys on (never re-inferred from tokens/text).
  describe("markEmptyCompletion (the explicit ec marker the Codex path sets)", () => {
    function base(over: Partial<AgentResult>): AgentResult {
      return {
        ok: true,
        subtype: "success",
        resultText: "",
        sessionId: "s",
        costUsd: 0,
        tokens: 0,
        numTurns: 1,
        hitMaxTurns: false,
        hitBudget: false,
        errors: [],
        tracePath: "",
        ...over,
      };
    }

    it("stamps emptyCompletion + promotes to a session limitHit on a silent empty completion", () => {
      const r = base({});
      markEmptyCompletion(r);
      expect(r.emptyCompletion).toBe(true);
      expect(r.ok).toBe(false);
      expect(r.limitHit?.kind).toBe("session");
      expect(r.errors.join(" ")).toMatch(/empty completion/i);
    });

    it("does NOT stamp a genuine limit that happens to have empty text / zero tokens (already failed)", () => {
      const r = base({ ok: false, limitHit: { kind: "usage", raw: "plan window" }, errors: ["limited"] });
      markEmptyCompletion(r);
      expect(r.emptyCompletion).toBeUndefined(); // origin distinguishable: not an ec
      expect(r.limitHit?.kind).toBe("usage"); // untouched
    });

    it("does NOT stamp a real (non-empty) result", () => {
      const r = base({ resultText: "answer", tokens: 12 });
      markEmptyCompletion(r);
      expect(r.emptyCompletion).toBeUndefined();
      expect(r.ok).toBe(true);
      expect(r.limitHit).toBeUndefined();
    });
  });
});

// U-A (#4): an auth/transport failure (401 / missing bearer / not logged in) means the session
// never ran — it's classified as a LimitHit(kind:"auth") so the build loop pauses-and-retries /
// falls back, rather than consuming it as a 0-score behavioral FAIL. Both classifiers are the pure,
// exported functions (string[] → LimitHit | undefined), exercised directly with no live calls.
describe("limitFromErrors — auth/transport failures classify as kind:auth (not a FAIL)", () => {
  const authSignatures = [
    "401 Unauthorized: Missing bearer or basic authentication",
    "Error: missing bearer token",
    "Not logged in · Please run /login",
    "please run /login to authenticate",
    "invalid api key provided",
    "authentication failed",
    "authentication required",
  ];

  for (const backend of [
    { name: "codex", fn: (e: string[]) => codexLimit(e) },
    { name: "claude", fn: (e: string[]) => claudeLimit(e) },
  ]) {
    describe(backend.name, () => {
      for (const sig of authSignatures) {
        it(`classifies "${sig.slice(0, 30)}…" as kind:auth`, () => {
          expect(backend.fn([sig])?.kind).toBe("auth");
        });
      }
      it("is case-insensitive and scoped to the joined error strings", () => {
        expect(backend.fn(["401 UNAUTHORIZED"])?.kind).toBe("auth");
        expect(backend.fn(["boot", "Missing Bearer"])?.kind).toBe("auth");
      });

      // #3: the auth branch must NOT swallow or re-label the existing rate/usage classification,
      // and a plain non-auth non-limit error still returns undefined.
      it("leaves rate/usage classification UNCHANGED and returns undefined for a plain error", () => {
        expect(backend.fn(["rate limit exceeded"])?.kind).toBe("rate");
        expect(backend.fn(["hit the usage limit"])?.kind).toBe("usage");
        expect(backend.fn(["429 too many requests"])?.kind).toBe("rate");
        // Non-auth limit signals classify CONSISTENTLY across both backends (quota→usage,
        // overloaded→rate) — closes a pre-existing claude/codex divergence on `quota`.
        expect(backend.fn(["quota exceeded for this org"])?.kind).toBe("usage");
        expect(backend.fn(["the model is overloaded, try again"])?.kind).toBe("rate");
        expect(backend.fn(["Reached maximum number of turns (2)"])).toBeUndefined();
        expect(backend.fn(["TypeError: cannot read property x of undefined"])).toBeUndefined();
        // a bare "401" without "unauthorized" is not enough to claim an auth failure
        expect(backend.fn(["exit code 401 lines processed"])).toBeUndefined();
      });
    });
  }
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
