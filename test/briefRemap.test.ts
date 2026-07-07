import { describe, it, expect } from "vitest";
import path from "node:path";
import { remapBriefForWorkspace, BRIEF_SPARRA_MARKER } from "../src/build/roleRun.ts";

/**
 * Unit tests for remapBriefForWorkspace — the pure helper that rewrites conductor-authored
 * brief paths so they resolve to the run's workspace instead of the main-repo root.
 */
describe("remapBriefForWorkspace — no-op cases", () => {
  const ROOT = "/abs/Sparra";
  const WS = "/abs/Sparra-unit-u1";

  it("workspace === root: returns the brief byte-for-byte unchanged (in-place no-op)", () => {
    const brief = `Implement at ${ROOT}/src/x.ts and see ${ROOT}/.sparra/contract.md`;
    expect(remapBriefForWorkspace(brief, ROOT, ROOT)).toBe(brief);
  });

  it("falsy workspace (empty string): no-op", () => {
    const brief = `Build ${ROOT}/src/x.ts`;
    expect(remapBriefForWorkspace(brief, ROOT, "")).toBe(brief);
  });

  it("path.resolve equality: symlink-equivalent same dir is a no-op", () => {
    // /abs/Sparra/../Sparra resolves to /abs/Sparra — same as root
    const brief = `Build ${ROOT}/src/x.ts`;
    expect(remapBriefForWorkspace(brief, ROOT, `${ROOT}/../Sparra`)).toBe(brief);
  });

  it("brief with no paths: unchanged regardless of workspace", () => {
    const brief = "Implement the feature as described in the contract above.";
    expect(remapBriefForWorkspace(brief, ROOT, WS)).toBe(brief);
  });
});

describe("remapBriefForWorkspace — root→workspace remap", () => {
  const ROOT = "/abs/Sparra";
  const WS = "/abs/Sparra-unit-u1";

  it("single path: <root>/file.ts → <workspace>/file.ts", () => {
    const brief = `See ${ROOT}/src/x.ts for reference.`;
    expect(remapBriefForWorkspace(brief, ROOT, WS)).toBe(`See ${WS}/src/x.ts for reference.`);
  });

  it("multiple paths in the same brief: all occurrences rewritten", () => {
    const brief = `Build in ${ROOT}/src/build, test ${ROOT}/test/x.test.ts`;
    const result = remapBriefForWorkspace(brief, ROOT, WS);
    expect(result).toBe(`Build in ${WS}/src/build, test ${WS}/test/x.test.ts`);
    // No <root>/ token (with separator) should remain — the root+sep boundary is the rewrite marker.
    expect(result).not.toContain(`${ROOT}/`);
  });

  it("anchored on separator: /abs/Sparra-fork/x.ts is NOT rewritten when root=/abs/Sparra", () => {
    // The 'Sparra-fork' part has a different path segment — not under root
    const brief = `See /abs/Sparra-fork/src/x.ts — that is a sibling project`;
    expect(remapBriefForWorkspace(brief, ROOT, WS)).toBe(brief);
  });

  it("path not under root (different prefix) is left untouched", () => {
    const brief = `Deploy from /other/repo/app.ts to ${ROOT}/dest.ts`;
    const result = remapBriefForWorkspace(brief, ROOT, WS);
    expect(result).toContain("/other/repo/app.ts"); // untouched
    expect(result).toContain(`${WS}/dest.ts`); // rewritten
  });

  it("root without a trailing separator is NOT rewritten (only ROOT/... anchored on sep)", () => {
    // A bare mention of root without a following path is left as-is
    const brief = `Located at ${ROOT} (the project root) — see ${ROOT}/src/x.ts`;
    const result = remapBriefForWorkspace(brief, ROOT, WS);
    // ROOT without separator should NOT be rewritten
    expect(result).toContain(`${ROOT} (the project root)`);
    // But ROOT/src/x.ts IS rewritten
    expect(result).toContain(`${WS}/src/x.ts`);
  });
});

describe("remapBriefForWorkspace — .sparra neutralization", () => {
  const ROOT = "/abs/Sparra";
  const WS = "/abs/Sparra-unit-u1";

  it("absolute <root>/.sparra/file → BRIEF_SPARRA_MARKER (no path leak)", () => {
    const brief = `Contract at ${ROOT}/.sparra/loop-br/u.contract.md — read it`;
    const result = remapBriefForWorkspace(brief, ROOT, WS);
    expect(result).toBe(`Contract at ${BRIEF_SPARRA_MARKER} — read it`);
    expect(result).not.toContain(".sparra");
    // No root-rooted path token should remain (the .sparra path was neutralized, not rewritten)
    expect(result).not.toContain(`${ROOT}/`);
  });

  it("bare .sparra/... relative reference → BRIEF_SPARRA_MARKER", () => {
    const brief = `Check .sparra/loop-x/u.contract.md for the spec`;
    const result = remapBriefForWorkspace(brief, ROOT, WS);
    expect(result).toBe(`Check ${BRIEF_SPARRA_MARKER} for the spec`);
    expect(result).not.toContain(".sparra");
  });

  it("both absolute and bare .sparra refs in the same brief: both neutralized", () => {
    const brief = `Primary: ${ROOT}/.sparra/loop/u.md; alternate: .sparra/loop/u.md`;
    const result = remapBriefForWorkspace(brief, ROOT, WS);
    expect(result).not.toContain(".sparra");
    expect(result).toContain(BRIEF_SPARRA_MARKER);
    // Should appear twice (once for each reference)
    expect(result.split(BRIEF_SPARRA_MARKER).length).toBe(3);
  });

  it("absolute .sparra dir reference (no tail) is also neutralized", () => {
    const brief = `Run from ${ROOT}/.sparra — the config is there`;
    const result = remapBriefForWorkspace(brief, ROOT, WS);
    expect(result).not.toContain(".sparra");
    expect(result).toContain(BRIEF_SPARRA_MARKER);
  });

  it("BRIEF_SPARRA_MARKER itself contains no .sparra path", () => {
    expect(BRIEF_SPARRA_MARKER).not.toContain(".sparra");
    // The marker should be a readable phrase, not a path
    expect(BRIEF_SPARRA_MARKER.length).toBeGreaterThan(10);
  });

  it(".sparra refs NOT rewritten to workspace (the worktree has no .sparra)", () => {
    const brief = `Contract at ${ROOT}/.sparra/loop/u.md`;
    const result = remapBriefForWorkspace(brief, ROOT, WS);
    // Must not be rewritten to workspace/.sparra/... — it must be neutralized
    expect(result).not.toContain(`${WS}/.sparra`);
    expect(result).toContain(BRIEF_SPARRA_MARKER);
  });
});

describe("remapBriefForWorkspace — mixed + idempotency", () => {
  const ROOT = "/abs/Sparra";
  const WS = "/abs/Sparra-unit-u1";

  it("mixed brief: root path + .sparra path + external path all handled correctly", () => {
    const brief = `Work in ${ROOT}/src/build, contract at ${ROOT}/.sparra/loop/u.md, example at /other/repo/x.ts`;
    const result = remapBriefForWorkspace(brief, ROOT, WS);
    expect(result).toContain(`${WS}/src/build`); // root path rewritten
    expect(result).toContain(BRIEF_SPARRA_MARKER); // .sparra neutralized
    expect(result).not.toContain(".sparra"); // no .sparra leak
    // No root-rooted path token (with separator) should remain
    expect(result).not.toContain(`${ROOT}/`);
    expect(result).toContain("/other/repo/x.ts"); // external path untouched
  });

  it("idempotent: calling twice on a sibling workspace gives the same result", () => {
    // Sibling workspace (not under root) → after first pass there are no <root>/ patterns left,
    // so the second pass is a true no-op.
    const brief = `Build at ${ROOT}/src/x.ts, contract at ${ROOT}/.sparra/c.md, bare .sparra/c.md too`;
    const once = remapBriefForWorkspace(brief, ROOT, WS);
    const twice = remapBriefForWorkspace(once, ROOT, WS);
    expect(twice).toBe(once);
  });

  it("idempotent on a brief that already has no paths: repeated calls return the same value", () => {
    const brief = "No paths here, just instructions.";
    const once = remapBriefForWorkspace(brief, ROOT, WS);
    const twice = remapBriefForWorkspace(once, ROOT, WS);
    expect(once).toBe(brief);
    expect(twice).toBe(brief);
  });

  it("root appearing as a non-path substring in prose is not affected", () => {
    // The word "Sparra" in prose (not as an absolute path) must survive
    const brief = `This is the Sparra project. Files at ${ROOT}/src/x.ts should be rewritten.`;
    const result = remapBriefForWorkspace(brief, ROOT, WS);
    expect(result).toContain("This is the Sparra project.");
    expect(result).toContain(`${WS}/src/x.ts`);
  });

  // ── Regression #5: workspace nested under root — must be idempotent (no double-nesting) ──
  it("regression #5: workspace UNDER root — idempotent, no double-nesting on second pass", () => {
    const NESTED_WS = `${ROOT}/worktrees/u1`; // workspace IS a subdirectory of root
    const brief = `Build at ${ROOT}/src/x.ts`;
    const once = remapBriefForWorkspace(brief, ROOT, NESTED_WS);
    expect(once).toBe(`Build at ${NESTED_WS}/src/x.ts`); // first pass rewrites correctly
    const twice = remapBriefForWorkspace(once, ROOT, NESTED_WS);
    expect(twice).toBe(once); // second pass must be a no-op — NOT double-nested
    expect(twice).not.toContain("/worktrees/u1/worktrees/u1"); // the double-nesting defect
  });

  it("regression #5: workspace-rooted paths (already under workspace) survive a second pass unchanged", () => {
    // After first pass the brief has ${WS}/src/x.ts — calling again must not re-translate it.
    const NESTED_WS = `${ROOT}/worktrees/u1`;
    // A brief that already only contains workspace paths (as if this is a second call)
    const alreadyMapped = `Build at ${NESTED_WS}/src/x.ts and ${NESTED_WS}/test/y.ts`;
    const result = remapBriefForWorkspace(alreadyMapped, ROOT, NESTED_WS);
    expect(result).toBe(alreadyMapped); // no change — idempotent
  });

  // ── Regression #4: adjacent prose punctuation (backtick, comma) must survive .sparra neutralization ──
  it("regression #4: backtick-quoted .sparra path — closing backtick and comma survive", () => {
    // The original defect: "`.sparra/loop/u.contract.md`," had its "`," consumed by [^\s]*
    const brief = "Read `.sparra/loop/u.contract.md`, then implement";
    const result = remapBriefForWorkspace(brief, ROOT, WS);
    expect(result).not.toContain(".sparra");
    expect(result).toContain(BRIEF_SPARRA_MARKER);
    // The closing backtick must survive immediately after the marker
    expect(result).toContain(`${BRIEF_SPARRA_MARKER}\``);
    // The comma after the closing backtick must also survive
    expect(result).toContain(`${BRIEF_SPARRA_MARKER}\`,`);
    // Full exact output check
    expect(result).toBe(`Read \`${BRIEF_SPARRA_MARKER}\`, then implement`);
  });

  it("regression #4: absolute <root>/.sparra path in backtick span — punctuation preserved", () => {
    const brief = `Check \`${ROOT}/.sparra/loop/u.md\`, done`;
    const result = remapBriefForWorkspace(brief, ROOT, WS);
    expect(result).not.toContain(".sparra");
    expect(result).toContain(`\`${BRIEF_SPARRA_MARKER}\``);
    expect(result).toContain(", done");
  });

  // ── Regression #2 (new): root as mid-token substring must NOT be rewritten ──
  it("regression #2: root embedded inside a longer path (mid-token) is left untouched", () => {
    // /tmp/abs/Sparra/... — the root "/abs/Sparra" appears INSIDE the larger token "/tmp/abs/Sparra/..."
    // The "/" before root is a path-interior char → left boundary fires → NOT rewritten.
    const brief = `Leave /tmp${ROOT}/src/x.ts alone; rewrite ${ROOT}/src/y.ts`;
    const result = remapBriefForWorkspace(brief, ROOT, WS);
    // The embedded occurrence is untouched
    expect(result).toContain(`/tmp${ROOT}/src/x.ts`);
    // The real token-initial occurrence IS rewritten
    expect(result).toContain(`${WS}/src/y.ts`);
    expect(result).not.toContain(`${ROOT}/src/y.ts`);
  });

  it("regression #2: host:/abs/... and word/abs/... — only token-initial occurrences rewritten", () => {
    // "noroot" has ROOT as a suffix (no left boundary issue since ROOT starts with "/")
    // but "/prefix/abs/Sparra/..." has "/" immediately before the root.
    const brief = `Primary: ${ROOT}/src/x.ts. See /prefix${ROOT}/src/x.ts for comparison`;
    const result = remapBriefForWorkspace(brief, ROOT, WS);
    expect(result).toContain(`${WS}/src/x.ts`); // token-initial → rewritten
    expect(result).toContain(`/prefix${ROOT}/src/x.ts`); // embedded → untouched
  });

  // ── Regression #5 (new): bare .sparra with non-boundary left char (foo.sparra) must NOT match ──
  it("regression #5 (left-anchor): foo.sparra/path is NOT neutralized — 'o' is a path-interior char", () => {
    // "foo.sparra/path.md" — the dot is preceded by "o" (a path-interior char) → must be left alone.
    const brief = `See foo.sparra/path.md and also .sparra/real.md`;
    const result = remapBriefForWorkspace(brief, ROOT, WS);
    // foo.sparra/path.md must survive unchanged
    expect(result).toContain("foo.sparra/path.md");
    // The token-initial .sparra/real.md IS neutralized
    expect(result).not.toContain(".sparra/real.md");
    expect(result).toContain(BRIEF_SPARRA_MARKER);
  });

  it("regression #5 (left-anchor): digit.sparra/path is NOT neutralized — digit is path-interior", () => {
    const brief = `1.sparra/path.md should survive; .sparra/contract.md should not`;
    const result = remapBriefForWorkspace(brief, ROOT, WS);
    expect(result).toContain("1.sparra/path.md"); // untouched
    expect(result).not.toContain(".sparra/contract.md"); // neutralized
    expect(result).toContain(BRIEF_SPARRA_MARKER);
  });
});
