import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runSession,
  withSessionRecording,
  readSessionRecords,
  sessionsPath,
  registerBackend,
  type AgentBackend,
  type AgentRequest,
  type AgentResult,
} from "../src/sdk/session.ts";

// ── Field report 2026-09-14/15 (Sarukani): three generator runs died with no envelope — two MCP
// client aborts after 1800s of silence, one provider session limit — and NONE returned a sessionId,
// so `resumeSessionId` was unavailable and hours of landed work could only be re-run from scratch.
// The id exists from the backend's FIRST message; it just wasn't durable until the last one. ──────

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-sessrec-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function req(over: Partial<AgentRequest> = {}): AgentRequest {
  return {
    role: "generator-u1",
    prompt: "build it",
    systemPrompt: "you are the generator",
    model: "claude-opus-5",
    cwd: "/work/unit",
    traceDir: path.join(dir, "traces"),
    traceSeq: 3,
    ...over,
  };
}

/** A backend that emits `init` and then DIES — the shape every field abort took. */
function dyingBackend(id: string, sessionId: string): AgentBackend {
  return {
    id,
    capabilities: { resume: true, streaming: true, outputSchema: false, mcp: true, inProcessMcp: true, hooks: true, sandbox: false, skills: true, cost: "usd" },
    async runTask(r: AgentRequest): Promise<AgentResult> {
      r.onEvent?.({ kind: "init", sessionId, model: r.model });
      throw new Error("aborted: sent no response or progress for 1800s");
    },
  };
}

describe("session-start recording — the id is durable before the work, not after it", () => {
  it("persists the session identity at INIT, so a run that never returns is still resumable", async () => {
    registerBackend(dyingBackend("fake-dying", "sess-abc123"));
    const p = req({ backend: "fake-dying" });
    await expect(runSession(p)).rejects.toThrow(/1800s/); // the run dies with no result, as in the field

    const records = readSessionRecords(p.traceDir);
    expect(records).toHaveLength(1);
    expect(records[0]!.sessionId).toBe("sess-abc123"); // ← what resumeSessionId needs
    expect(records[0]!.role).toBe("generator-u1");
    expect(records[0]!.backend).toBe("fake-dying");
    expect(records[0]!.model).toBe("claude-opus-5");
    expect(records[0]!.traceSeq).toBe(3);
    expect(records[0]!.cwd).toBe("/work/unit");
    expect(Date.parse(records[0]!.startedAt)).not.toBeNaN();
    expect(records[0]!.resumedFrom).toBeUndefined();
  });

  it("appends (never truncates) so a re-ask/resume chain leaves every id recoverable", () => {
    const traceDir = path.join(dir, "traces");
    for (const [seq, id, resume] of [[1, "s1", undefined], [2, "s2", "s1"]] as const) {
      const wrapped = withSessionRecording(req({ traceDir, traceSeq: seq, ...(resume ? { resume } : {}) }));
      wrapped.onEvent!({ kind: "init", sessionId: id, model: "claude-sonnet-5" });
    }
    const records = readSessionRecords(traceDir);
    expect(records.map((r) => r.sessionId)).toEqual(["s1", "s2"]);
    expect(records[1]!.resumedFrom).toBe("s1"); // the chain is traceable
  });

  it("does not mute the console echo it wraps (backends derive echo from onEvent's presence)", () => {
    // No front-end consumer → the role still echoes activity; a front-end consumer → it still doesn't.
    expect(withSessionRecording(req()).echoActivity).toBe(true);
    expect(withSessionRecording(req({ onEvent: () => {} })).echoActivity).toBe(false);
    expect(withSessionRecording(req({ onAssistantText: () => {} })).echoActivity).toBe(false);
    expect(withSessionRecording(req({ echoActivity: false })).echoActivity).toBe(false); // explicit wins
  });

  it("still forwards events to the caller's own onEvent", () => {
    const seen: string[] = [];
    const wrapped = withSessionRecording(req({ onEvent: (e) => seen.push(e.kind) }));
    wrapped.onEvent!({ kind: "init", sessionId: "s9", model: "m" });
    wrapped.onEvent!({ kind: "text", text: "hi" });
    expect(seen).toEqual(["init", "text"]);
  });

  it("is a no-op without a trace dir, and never throws on an unwritable one", () => {
    const noTrace = { ...req(), traceDir: "" };
    expect(withSessionRecording(noTrace)).toBe(noTrace); // untouched request
    // A trace dir under a regular FILE fails fast (ENOTDIR) on every OS. Never use /proc here: Node's
    // recursive mkdir spins forever on procfs paths on Linux, which hung CI to the 6h job limit.
    const blocker = path.join(dir, "afile");
    fs.writeFileSync(blocker, "");
    const wrapped = withSessionRecording(req({ traceDir: path.join(blocker, "traces") }));
    expect(() => wrapped.onEvent!({ kind: "init", sessionId: "s", model: "m" })).not.toThrow();
  });

  it("a torn final line (killed mid-append) does not lose the records before it", () => {
    const traceDir = path.join(dir, "traces");
    fs.mkdirSync(traceDir, { recursive: true });
    fs.writeFileSync(sessionsPath(traceDir), '{"sessionId":"good","role":"r","backend":"b","model":"m","traceSeq":1,"cwd":"/w","startedAt":"2026-09-15T00:00:00.000Z"}\n{"sessionId":"tor');
    expect(readSessionRecords(traceDir).map((r) => r.sessionId)).toEqual(["good"]);
  });
});
