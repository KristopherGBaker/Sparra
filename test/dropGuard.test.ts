import { describe, it, expect } from "vitest";
import {
  extractAssertions,
  critiqueCites,
  findUncitedDrops,
  buildDropGuardReport,
} from "../src/build/dropGuard.ts";

/**
 * U-A: the runner-side assertion-DROP guard's pure helpers (mirrors exec.ts's extractVerifyCommands
 * pattern — extraction + a text heuristic, tested directly, no model). The through-the-loop wiring
 * is exercised in contract.test.ts.
 */

const A1 = "tool add 2 3 prints 5 exits 0";
const A2 = "negotiateContract voids agreement on an uncited assertion drop";
const A3 = "holdout redaction scrubs the sentinel before the generator sees it";

/** A contract body with an "## Assertions" section of numbered items. */
const contract = (asserts: string[]) =>
  `## Item\nA thing.\n## I will build\nX.\n## Assertions\n${asserts.map((a, i) => `${i + 1}. ${a}`).join("\n")}\n`;

describe("extractAssertions", () => {
  it("returns exactly the numbered items' texts", () => {
    expect(extractAssertions(contract([A1, A2, A3]))).toEqual([A1, A2, A3]);
  });

  it("returns [] when there is no ## Assertions section", () => {
    expect(extractAssertions("## Item\nA thing.\n## I will verify by\n- `npm test`\n")).toEqual([]);
  });

  it("stops at the next heading (does not bleed following sections in)", () => {
    const md = `## Assertions\n1. ${A1}\n2. ${A2}\n\n## Notes\n- unrelated prose\n`;
    expect(extractAssertions(md)).toEqual([A1, A2]);
  });

  it("folds a wrapped continuation line into its item", () => {
    const md = `## Assertions\n1. first part of the assertion\n   continues onto a second line\n2. ${A2}\n`;
    expect(extractAssertions(md)).toEqual([
      "first part of the assertion continues onto a second line",
      A2,
    ]);
  });

  it("accepts '-' bullets as well as numbers", () => {
    expect(extractAssertions(`## Assertions\n- ${A1}\n- ${A2}\n`)).toEqual([A1, A2]);
  });
});

describe("critiqueCites — the citation heuristic (defeats degenerate count-only drop detection)", () => {
  // (a) significant-token overlap, NO literal "CUT" → cited.
  it("(a) counts significant-token overlap as citation without any literal CUT", () => {
    const critique = "The guard where negotiateContract voids agreement on a silently dropped assertion is the crux — keep it.";
    expect(critique.toLowerCase()).not.toContain("cut");
    expect(critiqueCites(critique, A2, 2)).toBe(true);
  });

  // (b) explicit "CUT assertion N" naming it → cited.
  it("(b) counts an explicit numeric 'CUT assertion N' as citation", () => {
    expect(critiqueCites("CUT assertion 2 — it duplicates the holdout check.", A2, 2)).toBe(true);
  });

  it("(b) numeric citation keys on the assertion's index, not just any number", () => {
    // "assertion 1" names index 1, NOT index 2 — and the words share no distinctive token with A2.
    expect(critiqueCites("Assertion 1's wording is loose — make 'prints 5' exact.", A2, 2)).toBe(false);
  });

  // (c) only stopwords / generic tokens shared → NOT cited.
  it("(c) generic/stopword-only overlap is NOT citation", () => {
    const critique = "Please make the whole contract terser and fix the wording throughout.";
    expect(critiqueCites(critique, A2, 2)).toBe(false);
  });
});

describe("findUncitedDrops — old→new diff filtered by citation", () => {
  const old3 = contract([A1, A2, A3]);
  const droppedA2 = contract([A1, A3]);

  it("flags an uncited drop (a → nothing, no critique naming it)", () => {
    const critique = "Assertion 1's wording is loose — make 'prints 5' exact."; // names index 1 only
    expect(findUncitedDrops(old3, droppedA2, critique)).toEqual([A2]);
  });

  it("does NOT flag a drop the critique cited by significant-token overlap (no literal CUT)", () => {
    const critique = "negotiateContract voids agreement on a silently dropped assertion — is that still needed?";
    expect(critique.toLowerCase()).not.toContain("cut");
    expect(findUncitedDrops(old3, droppedA2, critique)).toEqual([]);
  });

  it("does NOT flag a drop the critique cited explicitly by number", () => {
    expect(findUncitedDrops(old3, droppedA2, "CUT assertion 2 — redundant with assertion 3.")).toEqual([]);
  });

  it("does NOT flag a reworded assertion (still covered by significant-token overlap)", () => {
    const reworded = contract([A1, "negotiateContract must void the agreement whenever an uncited assertion is silently dropped", A3]);
    expect(findUncitedDrops(old3, reworded, "Assertion 1's wording is loose.")).toEqual([]);
  });

  it("does NOT flag an add-only superset revision", () => {
    const superset = contract([A1, A2, A3, "new: extra edge-case assertion added this round"]);
    expect(findUncitedDrops(old3, superset, "Please add an edge case.")).toEqual([]);
  });

  it("returns [] when the new proposal has no Assertions section to diff nothing away from all", () => {
    // Both sides parse to []: no assertions means nothing to drop.
    expect(findUncitedDrops("## Item\nx\n", "## Item\ny\n", "whatever")).toEqual([]);
  });
});

describe("buildDropGuardReport", () => {
  it("carries the HARNESS DROP-GUARD marker and each dropped assertion verbatim", () => {
    const report = buildDropGuardReport([A2, A3], "");
    expect(report).toContain("HARNESS DROP-GUARD");
    expect(report).toContain(`- ${A2}`);
    expect(report).toContain(`- ${A3}`);
    expect(report).toContain("2 previously-agreed assertion");
  });

  it("redacts a holdout sentinel embedded in a dropped assertion (redaction at the construction boundary)", () => {
    const sentinel = "The secret acceptance check nobody may ever see.";
    const holdout = `# Holdout\n\n- ${sentinel}\n`;
    const report = buildDropGuardReport([`assertion mentioning ${sentinel} inline`], holdout);
    expect(report).not.toContain(sentinel);
    expect(report).toContain("[redacted: holdout]");
  });
});
