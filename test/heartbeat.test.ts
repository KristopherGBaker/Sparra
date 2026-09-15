import { describe, it, expect, vi } from "vitest";
import { startHeartbeat, heartbeatMessage, HEARTBEAT_INTERVAL_MS } from "../src/mcp/heartbeat.ts";

// ── Field report 2026-09-14/15 (Sarukani): three generator runs died with no envelope; two were
// "sent no response or progress for 1800s". They were the VERIFY-heavy units — two xcodebuild gates
// plus a determinism rerun, i.e. long stretches inside one Bash call with nothing crossing the MCP
// boundary — so the idle guard killed exactly the runs that had cost the most. ─────────────────────

/** A controllable interval so the test never actually waits. */
function fakeTimers() {
  let fn: (() => void) | undefined;
  let cleared = false;
  const setIntervalFn = ((cb: () => void) => {
    fn = cb;
    return 1 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setInterval;
  const clearIntervalFn = (() => {
    cleared = true;
  }) as unknown as typeof clearInterval;
  return { setIntervalFn, clearIntervalFn, beat: () => fn?.(), get cleared() { return cleared; } };
}

describe("run_role keep-alive heartbeat", () => {
  it("emits notifications/progress on the client's token so a quiet long run isn't aborted", async () => {
    const sent: any[] = [];
    const t = fakeTimers();
    let now = 0;
    const stop = startHeartbeat({
      progressToken: "tok-1",
      sendNotification: async (n) => void sent.push(n),
      label: "run_role generator",
      detail: "resume id in /tr/sessions.jsonl",
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
      nowMs: () => now,
    });
    now = 65_000;
    t.beat();
    now = 130_000;
    t.beat();
    stop();

    expect(sent).toHaveLength(2);
    expect(sent[0].method).toBe("notifications/progress");
    expect(sent[0].params.progressToken).toBe("tok-1");
    expect(sent[0].params.progress).toBe(1);
    expect(sent[1].params.progress).toBe(2); // monotonic
    expect(sent[0].params.total).toBeUndefined(); // the duration is genuinely unknown
    expect(sent[0].params.message).toContain("1m05s elapsed"); // a wedged run is visible AS wedged
    expect(sent[0].params.message).toContain("/tr/sessions.jsonl"); // where the resume id lives
    expect(t.cleared).toBe(true);
  });

  it("is a no-op when the client asked for no progress (no token to attach to)", () => {
    const t = fakeTimers();
    const send = vi.fn();
    const stop = startHeartbeat({
      sendNotification: send as never,
      label: "run_role evaluator",
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
    });
    t.beat();
    stop();
    expect(send).not.toHaveBeenCalled();
  });

  it("a failed send never propagates — a dropped keep-alive must not fail the role-run", () => {
    const t = fakeTimers();
    const stop = startHeartbeat({
      progressToken: 7,
      sendNotification: async () => {
        throw new Error("transport closed");
      },
      label: "run_role generator",
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
    });
    expect(() => t.beat()).not.toThrow();
    stop();
  });

  it("beats well inside the observed 1800s idle window", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThan(1800_000 / 4);
  });

  it("formats elapsed time readably at both scales", () => {
    expect(heartbeatMessage("x", 9_000)).toBe("x: still running (9s elapsed)");
    expect(heartbeatMessage("x", 3_725_000)).toContain("62m05s elapsed");
  });
});
