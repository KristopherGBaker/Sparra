import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getBackend, listBackends, registerBackend, type AgentBackend } from "../src/sdk/backend.ts";
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
      capabilities: { resume: false, streaming: false, outputSchema: true, mcp: false, hooks: false, sandbox: true, cost: "tokens" },
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

  it("degrades gracefully when @openai/codex-sdk is not installed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-"));
    const r = await getBackend("codex").runTask({
      role: "generator",
      prompt: "build it",
      systemPrompt: "s",
      model: "gpt-5-codex",
      cwd: dir,
      writeScope: [dir],
      traceDir: dir,
      traceSeq: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.subtype).toBe("error_backend_unavailable");
    expect(r.errors.join(" ")).toMatch(/@openai\/codex-sdk/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
