import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { banner, info, ok, warn, err, step, detail, raw } from "../src/util/log.ts";

// Every output function in the logger, exercised as a group so the gate is checked uniformly.
const logFns: Array<(msg: string) => void> = [banner, info, ok, warn, err, step, detail];

// Capture into persistent buffers/counters so the assertions survive spy restoration
// (mockRestore() clears mock.calls, so we read from closures, mirroring the other test files).
function spyStreams() {
  let outBuf = "";
  let outCalls = 0;
  let errBuf = "";
  let errCalls = 0;
  const write = (add: (s: string) => void, bump: () => void) => (chunk: string | Uint8Array) => {
    add(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    bump();
    return true;
  };
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(write((s) => (outBuf += s), () => (outCalls += 1)));
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(write((s) => (errBuf += s), () => (errCalls += 1)));
  return {
    out: () => outBuf,
    outCalls: () => outCalls,
    err: () => errBuf,
    errCalls: () => errCalls,
    restore: () => { outSpy.mockRestore(); errSpy.mockRestore(); },
  };
}

describe("log gate under vitest", () => {
  let priorVitest: string | undefined;
  let priorLogInTests: string | undefined;

  beforeEach(() => {
    priorVitest = process.env.VITEST;
    priorLogInTests = process.env.SPARRA_LOG_IN_TESTS;
  });

  afterEach(() => {
    if (priorVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = priorVitest;
    if (priorLogInTests === undefined) delete process.env.SPARRA_LOG_IN_TESTS;
    else process.env.SPARRA_LOG_IN_TESTS = priorLogInTests;
  });

  it("writes nothing to stdout or stderr when VITEST is set and the escape hatch is unset", () => {
    process.env.VITEST = "true";
    delete process.env.SPARRA_LOG_IN_TESTS;
    const s = spyStreams();

    for (const fn of logFns) fn("should be silent");
    s.restore();

    expect(s.outCalls()).toBe(0);
    expect(s.errCalls()).toBe(0);
    expect(s.out()).toBe("");
    expect(s.err()).toBe("");
  });

  it("writes as usual when the escape hatch SPARRA_LOG_IN_TESTS is truthy, even under vitest", () => {
    process.env.VITEST = "true";
    process.env.SPARRA_LOG_IN_TESTS = "1";
    const s = spyStreams();

    for (const fn of logFns) fn("visible");
    s.restore();

    // err goes to stderr; the other six go to stdout.
    expect(s.errCalls()).toBe(1);
    expect(s.outCalls()).toBe(logFns.length - 1);
    expect(s.err()).toContain("visible");
    expect(s.out()).toContain("visible");
  });

  it("raw() writes nothing under vitest when the escape hatch is unset", () => {
    process.env.VITEST = "true";
    delete process.env.SPARRA_LOG_IN_TESTS;
    const s = spyStreams();

    raw("--- diff\n+++ candidate\n");
    s.restore();

    expect(s.outCalls()).toBe(0);
    expect(s.out()).toBe("");
  });

  it("raw() writes the passthrough content when the escape hatch is set, even under vitest", () => {
    process.env.VITEST = "true";
    process.env.SPARRA_LOG_IN_TESTS = "1";
    const s = spyStreams();

    raw("+++ candidate diff\n");
    s.restore();

    expect(s.outCalls()).toBe(1);
    expect(s.out()).toBe("+++ candidate diff\n");
  });

  it("raw() writes when VITEST is unset (normal `sparra reflect` behavior)", () => {
    delete process.env.VITEST;
    delete process.env.SPARRA_LOG_IN_TESTS;
    const s = spyStreams();

    raw("visible diff");
    s.restore();

    expect(s.outCalls()).toBe(1);
    expect(s.out()).toBe("visible diff");
  });
});
