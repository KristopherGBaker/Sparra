import { describe, it, expect, vi } from "vitest";
import { mergeFfOnly, defaultBranch } from "../src/util/git.ts";

/** A fake git runner that records the argv of every invocation and answers from a map. */
function fakeRunner(answers: (args: string[]) => { ok: boolean; out: string }) {
  const calls: string[][] = [];
  const run = vi.fn((_root: string, args: string[]) => {
    calls.push(args);
    return answers(args);
  });
  return { run, calls };
}

describe("mergeFfOnly", () => {
  it("happy path: fast-forwards target=main to source=the Sparra branch", () => {
    // is-ancestor succeeds ⇒ it WILL fast-forward; every step returns ok.
    const { run, calls } = fakeRunner(() => ({ ok: true, out: "" }));
    const r = mergeFfOnly("/repo", "main", "sparra/build-x", run);

    expect(r.ok).toBe(true);
    // Ancestry was checked first, BEFORE any checkout.
    expect(calls[0]).toEqual(["merge-base", "--is-ancestor", "main", "sparra/build-x"]);
    // Then checkout target (main) and merge --ff-only the source (the Sparra branch).
    expect(calls).toContainEqual(["checkout", "main"]);
    expect(calls).toContainEqual(["merge", "--ff-only", "sparra/build-x"]);
  });

  it("divergence path: aborts WITHOUT mutating checkout state (no checkout, no merge)", () => {
    // is-ancestor FAILS ⇒ target has diverged from source.
    const { run, calls } = fakeRunner((args) =>
      args[0] === "merge-base" ? { ok: false, out: "" } : { ok: true, out: "" }
    );
    const r = mergeFfOnly("/repo", "main", "sparra/build-x", run);

    expect(r.ok).toBe(false);
    // The ONLY call made is the read-only ancestry check — checkout/merge never ran.
    expect(calls).toEqual([["merge-base", "--is-ancestor", "main", "sparra/build-x"]]);
    expect(calls.some((a) => a[0] === "checkout")).toBe(false);
    expect(calls.some((a) => a[0] === "merge")).toBe(false);
  });
});

describe("defaultBranch", () => {
  it("prefers origin/HEAD (e.g. origin/main → main)", () => {
    const run = (_r: string, args: string[]) =>
      args[0] === "symbolic-ref" ? { ok: true, out: "origin/main\n" } : { ok: false, out: "" };
    expect(defaultBranch("/repo", run)).toBe("main");
  });

  it("falls back to a local main, then master — but NEVER the current branch", () => {
    const present = new Set(["refs/heads/master"]); // no origin/HEAD, no local main
    const run = (_r: string, args: string[]) => {
      if (args[0] === "symbolic-ref") return { ok: false, out: "" };
      if (args[0] === "show-ref") return { ok: present.has(args[args.length - 1]!), out: "" };
      // A `rev-parse --abbrev-ref HEAD` (current branch) MUST NOT be consulted; if it were and
      // returned the Sparra branch, a later --merge would self-merge. Make it loudly wrong.
      return { ok: true, out: "sparra/build-x\n" };
    };
    expect(defaultBranch("/repo", run)).toBe("master");
  });

  it("returns empty when nothing resolves (so callers refuse rather than self-merge)", () => {
    const run = vi.fn((_r: string, _args: string[]) => ({ ok: false, out: "" }));
    expect(defaultBranch("/repo", run)).toBe("");
    // It must never have asked for the current branch as a fallback.
    expect(run.mock.calls.some(([, args]) => args[0] === "rev-parse")).toBe(false);
  });
});
