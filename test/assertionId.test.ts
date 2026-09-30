import { describe, it, expect } from "vitest";
import { assertionKey, assertionKeySet, normalizeAssertionId, normalizeUnrunIds } from "../src/build/assertionId.ts";
import { diffClaims } from "../src/build/claims.ts";

describe("normalizeAssertionId", () => {
  it("integers and integer-literal strings → number", () => {
    expect(normalizeAssertionId(7)).toBe(7);
    expect(normalizeAssertionId("7")).toBe(7);
    expect(normalizeAssertionId(" 7 ")).toBe(7);
  });

  it("integer literals within the safe range → number; beyond it stay strings (no precision loss)", () => {
    expect(normalizeAssertionId("9007199254740991")).toBe(9007199254740991);
    expect(normalizeAssertionId(" 9007199254740991 ")).toBe(9007199254740991);
    expect(normalizeAssertionId("9007199254740992")).toBe("9007199254740992");
    expect(normalizeAssertionId("9007199254740993")).toBe("9007199254740993");
    expect(normalizeAssertionId(" 9007199254740993 ")).toBe("9007199254740993");
    expect(normalizeAssertionId("-9007199254740993")).toBe("-9007199254740993");
  });

  it("other non-empty strings → trimmed string", () => {
    expect(normalizeAssertionId("6b")).toBe("6b");
    expect(normalizeAssertionId(" H4 ")).toBe("H4");
    expect(normalizeAssertionId("A6")).toBe("A6");
    expect(normalizeAssertionId("1.5")).toBe("1.5");
  });

  it("missing / unusable → 0", () => {
    for (const bad of [undefined, null, "", "  ", NaN, 2.5, {}, [], true, Infinity]) {
      expect(normalizeAssertionId(bad)).toBe(0);
    }
  });
});

describe("assertionKey / assertionKeySet", () => {
  it("key is String(id); 7 and \"7\" normalize to the same key", () => {
    expect(assertionKey(7)).toBe("7");
    expect(assertionKey("6b")).toBe("6b");
    expect(assertionKey(normalizeAssertionId("7"))).toBe(assertionKey(normalizeAssertionId(7)));
  });

  it("keySet compares mixed forms by key", () => {
    const set = assertionKeySet(["7", "H4"]);
    expect(set.has(assertionKey(7))).toBe(true);
    expect(set.has(assertionKey("H4"))).toBe(true);
    expect(set.has("6b")).toBe(false);
    expect(assertionKeySet(undefined).size).toBe(0);
  });
});

describe("normalizeUnrunIds", () => {
  it("keeps positive ints + string ids, dedupes by key, drops 0/negative/empty/non-arrays", () => {
    expect(normalizeUnrunIds(["H4", 3, "3", "H4", 0, -2, "", "  ", null, "6b"])).toEqual(["H4", 3, "6b"]);
    expect(normalizeUnrunIds(undefined)).toEqual([]);
    expect(normalizeUnrunIds("H4")).toEqual([]);
  });
});

describe("diffClaims — string ids", () => {
  const assertions = [
    { id: 7, pass: true, evidence: "" },
    { id: "6b", pass: false, evidence: "" },
  ];

  it("detects a \"6b\" claimed pass vs graded fail", () => {
    expect(diffClaims([{ id: "6b", claim: "pass" }], assertions)).toEqual({ count: 1, ids: ["6b"] });
  });

  it("matches a claim id \"7\" to verdict id 7", () => {
    expect(diffClaims([{ id: "7", claim: "fail" }], assertions)).toEqual({ count: 1, ids: [7] });
    expect(diffClaims([{ id: "7", claim: "pass" }], assertions)).toEqual({ count: 0, ids: [] });
  });

  it("dedupes by key and skips claims without a usable id or matching assertion", () => {
    const out = diffClaims(
      [
        { id: "6b", claim: "pass" },
        { id: "6b ", claim: "pass" },
        { id: "zz", claim: "pass" },
        { id: undefined as unknown as string, claim: "pass" },
      ],
      assertions,
    );
    expect(out).toEqual({ count: 1, ids: ["6b"] });
  });
});
