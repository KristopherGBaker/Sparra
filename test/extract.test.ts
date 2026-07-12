import { describe, it, expect } from "vitest";
import { extractJson, hasMarker } from "../src/util/extract.ts";

describe("extractJson", () => {
  it("returns parsed object from a fenced ```json block", () => {
    const text = "```json\n{\"key\":\"value\"}\n```";
    expect(extractJson(text)).toEqual({ key: "value" });
  });

  it("returns bare object when no fenced block present", () => {
    expect(extractJson("{}")).toEqual({});
  });

  it("returns bare array when no fenced block present", () => {
    expect(extractJson("[]")).toEqual([]);
  });

  it("last-block-wins: fenced block with invalid JSON falls back to lastBalanced []", () => {
    // Fenced block contains invalid JSON; lastBalanced finds the trailing []
    const text = "```json\n{invalid\n``` some text []";
    expect(extractJson(text)).toEqual([]);
  });

  it("returns null when there is no parseable JSON anywhere", () => {
    expect(extractJson("not json")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractJson("")).toBeNull();
  });

  it("last-block-wins: returns last valid fenced block when multiple are present", () => {
    const text = "```json\n{\"a\":1}\n```\n```json\n{\"b\":2}\n```";
    expect(extractJson(text)).toEqual({ b: 2 });
  });
});

describe("hasMarker", () => {
  it("matches a line that contains exactly the marker with surrounding whitespace", () => {
    expect(hasMarker("  CONTRACT: AGREED  ", "CONTRACT: AGREED")).toBe(true);
  });

  it("returns false when the marker appears as a substring mid-line (not at line boundary)", () => {
    expect(hasMarker("CONTRACT: AGREED in the middle", "CONTRACT: AGREED")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasMarker("", "CONTRACT: AGREED")).toBe(false);
  });

  it("matches across a multi-line string when the marker line is present", () => {
    const text = "some preamble\nCONTRACT: AGREED\ntrailing text";
    expect(hasMarker(text, "CONTRACT: AGREED")).toBe(true);
  });

  it("tolerates a stray trailing period (the recurring evaluator false-negative)", () => {
    expect(hasMarker("CONTRACT: AGREED.", "CONTRACT: AGREED")).toBe(true);
    expect(hasMarker("preamble\nCONTRACT: AGREED.\nmore", "CONTRACT: AGREED")).toBe(true);
  });

  it("tolerates trailing punctuation and leading/closing markdown decoration", () => {
    expect(hasMarker("CONTRACT: AGREED!", "CONTRACT: AGREED")).toBe(true);
    expect(hasMarker("**CONTRACT: AGREED**", "CONTRACT: AGREED")).toBe(true);
    expect(hasMarker("- CONTRACT: AGREED", "CONTRACT: AGREED")).toBe(true);
    expect(hasMarker("> CONTRACT: AGREED.", "CONTRACT: AGREED")).toBe(true);
  });

  it("still rejects trailing WORDS or a leading negation (no false positive on 'not agreed')", () => {
    expect(hasMarker("CONTRACT: AGREED, pending fixes", "CONTRACT: AGREED")).toBe(false);
    expect(hasMarker("CONTRACT: AGREED (with caveats)", "CONTRACT: AGREED")).toBe(false);
    expect(hasMarker("not CONTRACT: AGREED", "CONTRACT: AGREED")).toBe(false);
    expect(hasMarker("NOT CONTRACT: AGREED yet", "CONTRACT: AGREED")).toBe(false);
  });
});
