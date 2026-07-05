import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Paths } from "../src/paths.ts";
import {
  appendLearning,
  readMemory,
  formatLearning,
  capEntries,
  memorySection,
  distillTechnique,
  hasTechniqueNote,
  TECHNIQUE_CAP,
  TECHNIQUE_MARKER,
} from "../src/memory.ts";

describe("formatLearning", () => {
  it("renders a compact one-line entry and collapses whitespace", () => {
    expect(
      formatLearning({ item: "item-002", kind: "pivot", detail: "craft  stuck\nrebuilt", at: "2026-06-24T10:00:00Z" })
    ).toBe("- [2026-06-24] item-002 · PIVOT: craft stuck rebuilt");
  });

  it("omits the date when no timestamp is given", () => {
    expect(formatLearning({ item: "x", kind: "note", detail: "hi" })).toBe("- x · NOTE: hi");
  });
});

describe("appendLearning + readMemory", () => {
  it("appends a learning and reads it back", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
    const paths = new Paths(dir);
    await appendLearning(paths, { item: "item-001", kind: "failed", detail: "no good", at: "2026-06-24T00:00:00Z" });
    const mem = await readMemory(paths);
    expect(mem).toContain("item-001");
    expect(mem).toMatch(/FAILED/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty string when there is no memory file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
    expect(await readMemory(new Paths(dir))).toBe("");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("memorySection", () => {
  it("returns empty string for empty memory", () => {
    expect(memorySection("")).toBe("");
    expect(memorySection("   ")).toBe("");
  });
  it("wraps memory text in a labeled prompt section", () => {
    const s = memorySection("- [d] item-001 · PIVOT: x");
    expect(s).toMatch(/PRIOR LEARNINGS/);
    expect(s).toContain("PIVOT");
  });
});

describe("capEntries", () => {
  it("collapses oldest entries into a summary when over maxEntries", () => {
    const entries = Array.from({ length: 5 }, (_, i) => `- [d] item-00${i} · FAILED: e${i}`);
    const { keptEntries, summaryLine } = capEntries(entries, null, { maxEntries: 3, maxChars: 10000 });
    expect(keptEntries).toHaveLength(3);
    expect(keptEntries[0]).toContain("item-002");
    expect(summaryLine).toMatch(/failed:2/);
    expect(summaryLine).toMatch(/total 2/);
  });

  it("merges collapsed counts into a pre-existing summary", () => {
    const existing = "> older learnings summarized — pivot:1 budget_exceeded:0 passed:0 failed:0 note:0 (total 1)";
    const entries = Array.from({ length: 4 }, (_, i) => `- [d] item-00${i} · PASSED: e${i}`);
    const { keptEntries, summaryLine } = capEntries(entries, existing, { maxEntries: 2, maxChars: 10000 });
    expect(keptEntries).toHaveLength(2);
    expect(summaryLine).toMatch(/pivot:1/);
    expect(summaryLine).toMatch(/passed:2/);
    expect(summaryLine).toMatch(/total 3/);
  });

  it("keeps everything when under the caps", () => {
    const entries = ["- a · NOTE: 1", "- b · NOTE: 2"];
    const { keptEntries, summaryLine } = capEntries(entries, null, { maxEntries: 10, maxChars: 10000 });
    expect(keptEntries).toEqual(entries);
    expect(summaryLine).toBeNull();
  });
});

describe("memory stays bounded", () => {
  it("does not grow unbounded across many appends and retains the newest", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
    const paths = new Paths(dir);
    const caps = { maxEntries: 10, maxChars: 2000 };
    for (let i = 0; i < 100; i++) {
      await appendLearning(
        paths,
        { item: `item-${i}`, kind: "failed", detail: "x".repeat(40), at: "2026-06-24T00:00:00Z" },
        caps
      );
    }
    const text = fs.readFileSync(paths.memory, "utf8");
    const entryLines = text.split("\n").filter((l) => l.startsWith("- "));
    expect(entryLines.length).toBeLessThanOrEqual(caps.maxEntries);
    expect(text).toMatch(/older learnings summarized/);
    expect(text).toContain("item-99"); // newest retained
    expect(text).not.toContain("item-0 "); // oldest collapsed
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("distillTechnique (pure)", () => {
  // Assertion 2 — preserves the DISTINCTIVE technique across two different reports (not a constant).
  it("returns two different, technique-preserving strings for two distinct reports", () => {
    const a = distillTechnique({
      item: "item-001",
      status: "passed",
      lastReport: "Fixed the flaky UI read by adding @MainActor to the assertion so it runs on the main actor.",
    });
    const b = distillTechnique({
      item: "item-002",
      status: "passed",
      lastReport: "Seed the fixture before enroll so the recognizer has a known face to match against.",
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    // Each keeps its own distinctive term — a hardcoded/generic constant would fail this.
    expect(a).toMatch(/@MainActor/);
    expect(b!.toLowerCase()).toContain("seed the fixture before enroll");
    // Each begins with the marker and is at most 2 lines within the char cap.
    for (const out of [a!, b!]) {
      expect(out.startsWith(TECHNIQUE_MARKER)).toBe(true);
      expect(out.split("\n").length).toBeLessThanOrEqual(2);
      expect(out.length).toBeLessThanOrEqual(TECHNIQUE_CAP);
    }
  });

  // Assertion 3 — BOTH durable fields are used: attempts feed the distiller when the report is empty.
  it("distills from the attempts ledger when the report is empty, and returns null when there is nothing", () => {
    const fromAttempts = distillTechnique({
      item: "item-003",
      status: "failed",
      lastReport: "",
      attempts: [
        { round: 1, approach: "Wrapped the enroll call in a retry loop but the race persisted.", failure: "still flaky" },
      ],
    });
    expect(fromAttempts).not.toBeNull();
    expect(fromAttempts!.toLowerCase()).toContain("enroll");

    expect(distillTechnique({ item: "item-004", status: "failed", lastReport: "", attempts: [] })).toBeNull();
    expect(distillTechnique({ item: "item-004", status: "failed" })).toBeNull();
    expect(distillTechnique({ item: "item-004", status: "passed", lastReport: "   \n  " })).toBeNull();
  });

  // Assertion 4 — never the score / bookkeeping, but legitimate non-score numbers survive.
  it("strips the score, cost, and bookkeeping phrasing but keeps legitimate numbers", () => {
    const out = distillTechnique({
      item: "item-005",
      status: "passed",
      lastReport:
        "Used the ArcFace embedding and made 2 passes over the index to dedup matches. Scored 87 after $0.41 spent, accepted in round 2.",
    });
    expect(out).not.toBeNull();
    expect(out!.toLowerCase()).not.toContain("score");
    expect(out).not.toContain("87");
    expect(out).not.toContain("$0.41");
    expect(out!.toLowerCase()).not.toContain("spent");
    expect(out!.toLowerCase()).not.toContain("accepted in round");
    // Legitimate technique numbers/terms are NOT banned.
    expect(out).toContain("ArcFace");
    expect(out).toContain("2 passes");
  });

  // Assertion 5 — pure & deterministic.
  it("is deterministic: identical input yields an identical string", () => {
    const input = {
      item: "item-006",
      status: "passed" as const,
      lastReport: "Added a guard to redact the holdout and dedup on the marker before the append.",
      attempts: [{ round: 1, approach: "Tried a naive kind-based dedup which collided.", failure: "collision" }],
    };
    const first = distillTechnique(input);
    expect(first).not.toBeNull();
    for (let i = 0; i < 5; i++) expect(distillTechnique(input)).toBe(first);
  });

  // Assertion 10 — the cap (marker included) is respected even for a very long report.
  it("caps the distilled detail (marker included) at TECHNIQUE_CAP", () => {
    const long = "Refactored the parser to handle the nested brace expansion before matching. ".repeat(20);
    const out = distillTechnique({ item: "item-007", status: "passed", lastReport: long });
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(TECHNIQUE_CAP);
    expect(out!.startsWith(TECHNIQUE_MARKER)).toBe(true);
  });
});

describe("hasTechniqueNote (marker-keyed dedup)", () => {
  it("detects only a technique-marked note for the item, not other notes or other items", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
    const paths = new Paths(dir);
    // An unrelated note for the same item must NOT count as a technique note.
    await appendLearning(paths, { item: "item-001", kind: "note", detail: "human-abandoned round 2.", at: "2026-06-24T00:00:00Z" });
    expect(await hasTechniqueNote(paths, "item-001")).toBe(false);
    // The technique note for item-001 does.
    await appendLearning(paths, { item: "item-001", kind: "note", detail: `${TECHNIQUE_MARKER} add @MainActor to the assertion.`, at: "2026-06-24T00:00:00Z" });
    expect(await hasTechniqueNote(paths, "item-001")).toBe(true);
    // …but not for a different item.
    expect(await hasTechniqueNote(paths, "item-002")).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns false when there is no memory file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
    expect(await hasTechniqueNote(new Paths(dir), "item-001")).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
