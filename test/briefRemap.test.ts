import { describe, it, expect } from "vitest";
import path from "node:path";
import { remapBriefForWorkspace, remapBriefForWorkspaceCounted, BRIEF_SPARRA_MARKER } from "../src/build/roleRun.ts";

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

  // ── F1: inline code spans are VERBATIM QUOTES — a .sparra reference inside them is PRESERVED ──
  // (Supersedes the pre-F1 "regression #4" tests, which neutralized the marker inside backticks and
  //  only asserted the trailing punctuation survived; F1 preserves the whole span byte-identical.)
  it("F1: bare .sparra path inside an inline code span is PRESERVED byte-identical", () => {
    const brief = "Read `.sparra/loop/u.contract.md`, then implement";
    const result = remapBriefForWorkspace(brief, ROOT, WS);
    // The whole span (and its trailing punctuation) survives — no marker substitution inside a span.
    expect(result).toBe(brief);
    expect(result).toContain("`.sparra/loop/u.contract.md`");
    expect(result).not.toContain(BRIEF_SPARRA_MARKER);
  });

  it("F1: absolute <root>/.sparra path inside an inline code span is PRESERVED byte-identical", () => {
    const brief = `Check \`${ROOT}/.sparra/loop/u.md\`, done`;
    const result = remapBriefForWorkspace(brief, ROOT, WS);
    expect(result).toBe(brief);
    // Neither neutralized to a marker nor re-rooted to the workspace — the span is a verbatim quote.
    expect(result).not.toContain(BRIEF_SPARRA_MARKER);
    expect(result).not.toContain(`${WS}/.sparra`);
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

describe("remapBriefForWorkspace — F1 code-span exemption + count surfacing", () => {
  const ROOT = "/abs/Sparra";
  const WS = "/abs/Sparra-unit-u1";

  it("assertion 1: a .sparra ref inside a FENCED code block survives byte-identical (worktree remap)", () => {
    const brief = "Quoting a tool desc:\n```\nThe runner reads .sparra/loop/u.contract.md itself.\n```\nGo.";
    const result = remapBriefForWorkspace(brief, ROOT, WS);
    expect(result).toBe(brief);
    expect(result).toContain(".sparra/loop/u.contract.md");
    expect(result).not.toContain(BRIEF_SPARRA_MARKER);
  });

  it("assertion 1: a .sparra ref inside an INLINE code span survives byte-identical", () => {
    const brief = "See `.sparra/config.yaml` for the layout.";
    const result = remapBriefForWorkspace(brief, ROOT, WS);
    expect(result).toBe(brief);
    expect(result).not.toContain(BRIEF_SPARRA_MARKER);
  });

  it("assertion 2: mixed fenced + inline + prose — only the PROSE occurrence is neutralized, count === 1", () => {
    const brief =
      "Prose ref .sparra/loop/u.md must go.\n" +
      "```\nfenced .sparra/loop/u.md stays\n```\n" +
      "inline `.sparra/loop/u.md` stays too. Also read " + `${ROOT}/src/x.ts.`;
    const { text, substitutions } = remapBriefForWorkspaceCounted(brief, ROOT, WS);
    // Protected occurrences are byte-identical.
    expect(text).toContain("```\nfenced .sparra/loop/u.md stays\n```");
    expect(text).toContain("inline `.sparra/loop/u.md` stays too");
    // Exactly ONE marker substitution (the prose occurrence).
    expect(text.split(BRIEF_SPARRA_MARKER).length - 1).toBe(1);
    expect(substitutions).toBe(1);
    // The prose <root>/… re-rooting outside code spans STILL occurs (not a marker substitution).
    expect(text).toContain(`${WS}/src/x.ts`);
    expect(text).not.toContain(`${ROOT}/src/x.ts`);
  });

  it("assertion 4-support: substitutions counts EACH prose neutralization (absolute + bare)", () => {
    const brief = `A: ${ROOT}/.sparra/a.md and B: .sparra/b.md`;
    const { substitutions } = remapBriefForWorkspaceCounted(brief, ROOT, WS);
    expect(substitutions).toBe(2);
  });

  // ── Adversarial fence regressions (fix round): CommonMark fence rules ──
  it("adversarial: a .sparra ref inside a TILDE (~~~) fenced block is preserved byte-identical, count 0", () => {
    const brief = "Quote:\n~~~\nThe runner reads .sparra/loop/u.contract.md itself.\n~~~\nDone.";
    const { text, substitutions } = remapBriefForWorkspaceCounted(brief, ROOT, WS);
    expect(text).toBe(brief);
    expect(text).toContain(".sparra/loop/u.contract.md");
    expect(substitutions).toBe(0);
    expect(text).not.toContain(BRIEF_SPARRA_MARKER);
  });

  it("adversarial: a 4-backtick fence whose body contains a ``` line preserves ALL .sparra refs, count 0", () => {
    // The inner ``` line is SHORTER than the 4-backtick opener → NOT a closer; the block spans to the
    // final ```` fence, so every .sparra ref inside (including after the inner ``` line) is preserved.
    const brief =
      "Example:\n" +
      "````\n" +
      "outer .sparra/loop/a.md\n" +
      "```\n" +
      "inner-still-fenced .sparra/loop/b.md\n" +
      "````\n" +
      "Tail prose .sparra/loop/c.md goes.";
    const { text, substitutions } = remapBriefForWorkspaceCounted(brief, ROOT, WS);
    // Both fenced .sparra refs preserved byte-identical.
    expect(text).toContain("outer .sparra/loop/a.md");
    expect(text).toContain("inner-still-fenced .sparra/loop/b.md");
    // Only the tail PROSE ref is neutralized (count 1 total for this brief).
    expect(substitutions).toBe(1);
    expect(text.split(BRIEF_SPARRA_MARKER).length - 1).toBe(1);
    // The tail prose ref became the marker; the fenced ones did not.
    expect(text).toContain("Tail prose " + BRIEF_SPARRA_MARKER + " goes.");
  });

  it("adversarial: a LONGER (5-backtick) tilde/backtick fence with a shorter fence-like body line is whole-preserved", () => {
    const brief = "`````\ntop .sparra/x.md\n~~~\nmid .sparra/y.md\n`````\nafter";
    const { text, substitutions } = remapBriefForWorkspaceCounted(brief, ROOT, WS);
    expect(text).toBe(brief);
    expect(substitutions).toBe(0);
  });

  // ── CRLF regression (fix round 3): CRLF-delimited fences must be recognized byte-exact ──
  it("adversarial: a CRLF-delimited ~~~ tilde fence preserves the fenced .sparra ref byte-identical (CR bytes intact)", () => {
    // Real \r\n line endings — the line scanner splits on \n and each line retains its \r.
    const brief =
      "Quote:\r\n" +
      "~~~\r\n" +
      "The runner reads .sparra/loop/u.contract.md itself.\r\n" +
      "~~~\r\n" +
      "Tail prose .sparra/loop/c.md goes.";
    const { text, substitutions } = remapBriefForWorkspaceCounted(brief, ROOT, WS);
    // Fenced content preserved byte-identical, including the CR bytes and the .sparra ref.
    expect(text).toContain("~~~\r\nThe runner reads .sparra/loop/u.contract.md itself.\r\n~~~");
    expect(text).toContain(".sparra/loop/u.contract.md");
    // ONLY the trailing prose ref is neutralized (count 1); the fenced ref is not counted.
    expect(substitutions).toBe(1);
    expect(text.split(BRIEF_SPARRA_MARKER).length - 1).toBe(1);
    // No newline normalization anywhere — the CRLF sequences survive.
    expect(text).toContain("Quote:\r\n~~~\r\n");
  });

  it("adversarial: a CRLF-delimited ``` backtick fence (with an info string) is preserved byte-identical, count 0", () => {
    const brief =
      "```yaml\r\n" +
      "path: .sparra/loop/u.contract.md\r\n" +
      "```\r\n" +
      "done";
    const { text, substitutions } = remapBriefForWorkspaceCounted(brief, ROOT, WS);
    expect(text).toBe(brief); // whole input is fence + trailing prose with no .sparra ref → byte-identical
    expect(substitutions).toBe(0);
    expect(text).toContain(".sparra/loop/u.contract.md");
    expect(text).not.toContain(BRIEF_SPARRA_MARKER);
  });

  it("assertion 3: in-place run (workspace == root) is a byte-identical no-op with zero substitutions", () => {
    const brief = "prose .sparra/x.md and `.sparra/y.md` and ```\n.sparra/z.md\n```";
    const { text, substitutions } = remapBriefForWorkspaceCounted(brief, ROOT, ROOT);
    expect(text).toBe(brief);
    expect(substitutions).toBe(0);
  });

  it("zero substitutions when a worktree brief has no .sparra prose (count 0)", () => {
    const brief = `Build ${ROOT}/src/x.ts and quote \`.sparra/only-in-a-span.md\``;
    const { text, substitutions } = remapBriefForWorkspaceCounted(brief, ROOT, WS);
    expect(substitutions).toBe(0);
    expect(text).toContain(`${WS}/src/x.ts`); // re-rooting still happens, but it's not a substitution
    expect(text).toContain("`.sparra/only-in-a-span.md`"); // span preserved
  });
});
