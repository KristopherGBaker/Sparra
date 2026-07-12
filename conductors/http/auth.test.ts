import { describe, expect, it } from "vitest";

import { checkBearer, requireBridgeToken } from "./auth.ts";

const TOKEN = "s3cr3t-token-value";

describe("checkBearer", () => {
  it("returns true for the correct token", () => {
    expect(checkBearer(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it("returns false for a missing header", () => {
    expect(checkBearer(undefined, TOKEN)).toBe(false);
    expect(checkBearer(null, TOKEN)).toBe(false);
    expect(checkBearer("", TOKEN)).toBe(false);
  });

  it("returns false for a header without the Bearer scheme", () => {
    expect(checkBearer(TOKEN, TOKEN)).toBe(false);
    expect(checkBearer(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(checkBearer("Bearer ", TOKEN)).toBe(false);
  });

  it("returns false for a wrong token of DIFFERENT length", () => {
    expect(checkBearer("Bearer nope", TOKEN)).toBe(false);
  });

  it("returns false for a wrong token of EQUAL length (constant-time compare, no early return)", () => {
    const equalLenWrong = "X".repeat(TOKEN.length);
    expect(equalLenWrong.length).toBe(TOKEN.length);
    expect(checkBearer(`Bearer ${equalLenWrong}`, TOKEN)).toBe(false);
    // Differ only in the LAST byte — a first-byte-mismatch early-return bug would still catch this,
    // but a compare that stops at the first differing byte would not exercise the length-equal path.
    const lastByteWrong = TOKEN.slice(0, -1) + (TOKEN.at(-1) === "e" ? "f" : "e");
    expect(lastByteWrong.length).toBe(TOKEN.length);
    expect(checkBearer(`Bearer ${lastByteWrong}`, TOKEN)).toBe(false);
  });

  it("never authenticates against an empty configured token (no allow-all)", () => {
    expect(checkBearer("Bearer ", "")).toBe(false);
    expect(checkBearer("Bearer anything", "")).toBe(false);
  });
});

describe("requireBridgeToken", () => {
  it("returns the token when set", () => {
    expect(requireBridgeToken({ SPARRA_BRIDGE_TOKEN: TOKEN })).toBe(TOKEN);
  });

  it("THROWS when unset", () => {
    expect(() => requireBridgeToken({})).toThrow(/unset or empty/);
  });

  it("THROWS when empty", () => {
    expect(() => requireBridgeToken({ SPARRA_BRIDGE_TOKEN: "" })).toThrow(/unset or empty/);
  });
});
