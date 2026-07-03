import { describe, it, expect } from "vitest";
import { parse } from "../src/util/args.ts";

// Characterization tests for the CLI arg parser. Importing `parse` from `src/util/args.ts`
// does NOT run the CLI (that's the point of extracting it out of `src/cli.ts`), so we can
// pin the parsing semantics — in particular the repeated-flag array accumulation added in
// the U3 cycle — without executing `main()`.

describe("parse — repeated-flag accumulation", () => {
  it("collects a repeated flag's values into an array, in given order", () => {
    expect(parse(["--x", "a", "--x", "b", "--x", "c"]).flags.x).toEqual(["a", "b", "c"]);
  });

  it("a first repeat turns a scalar into a 2-element array", () => {
    expect(parse(["--x", "a", "--x", "b"]).flags.x).toEqual(["a", "b"]);
  });

  it("mirrors the real repeatable flag `--prior-critique`", () => {
    const { flags } = parse(["role", "run", "--prior-critique", "a.md", "--prior-critique", "b.md"]);
    expect(flags["prior-critique"]).toEqual(["a.md", "b.md"]);
  });

  it("a single occurrence stays a scalar string (NOT a 1-element array)", () => {
    const v = parse(["--x", "a"]).flags.x;
    expect(v).toBe("a");
    expect(Array.isArray(v)).toBe(false);
  });
});

describe("parse — bare boolean flags", () => {
  it("a bare flag is boolean true, not a string", () => {
    expect(parse(["--flag"]).flags.flag).toBe(true);
  });

  it("a repeated bare boolean does NOT accumulate into [true, true] — it stays true", () => {
    expect(parse(["--flag", "--flag"]).flags.flag).toBe(true);
  });

  it("value-then-bare-boolean: the later bare boolean overwrites (non-string value replaces)", () => {
    // `--x a --x` → second occurrence's value is `true` (bare), which is non-string, so it
    // replaces the prior string rather than accumulating.
    expect(parse(["--x", "a", "--x"]).flags.x).toBe(true);
  });

  it("bare-boolean-then-value: the later string replaces the prior boolean (no array)", () => {
    // `--x --x a` → prior is boolean `true`, so the new string does NOT accumulate; it wins.
    expect(parse(["--x", "--x", "a"]).flags.x).toBe("a");
  });
});

describe("parse — -k and positionals", () => {
  it("parses `-k N` into flags.k and collects positionals", () => {
    const { positionals, flags } = parse(["batch", "-k", "3"]);
    expect(flags.k).toBe("3");
    expect(positionals).toEqual(["batch"]);
  });

  it("collects multiple positionals in order alongside flags", () => {
    const { positionals, flags } = parse(["role", "run", "--kind", "evaluator", "dir"]);
    expect(positionals).toEqual(["role", "run", "dir"]);
    expect(flags.kind).toBe("evaluator");
  });

  it("a trailing `-k` with no argument defaults to an empty string", () => {
    expect(parse(["-k"]).flags.k).toBe("");
  });
});
