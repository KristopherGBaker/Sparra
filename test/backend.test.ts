import { describe, it, expect } from "vitest";
import { getBackend, listBackends, registerBackend, type AgentBackend } from "../src/sdk/backend.ts";
import { codexSandboxMode } from "../src/sdk/backends/codex.ts";
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
});
