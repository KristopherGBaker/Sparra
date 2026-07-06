import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mergeFfOnly, defaultBranch, isLinkedWorktree, revParse, diffNames } from "../src/util/git.ts";

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

describe("isLinkedWorktree", () => {
  /** Answer rev-parse with a map keyed by the requested ref (--git-dir / --git-common-dir). */
  function gitRunner(map: Record<string, { ok: boolean; out: string }>) {
    return (_root: string, args: string[]) => {
      if (args[0] === "rev-parse") return map[args[1]!] ?? { ok: false, out: "" };
      return { ok: false, out: "" };
    };
  }

  it("true when git-dir ≠ common-dir (a linked worktree)", () => {
    const run = gitRunner({
      "--git-dir": { ok: true, out: "/repo/.git/worktrees/wt-1\n" },
      "--git-common-dir": { ok: true, out: "/repo/.git\n" },
    });
    expect(isLinkedWorktree("/repo/../wt", run)).toBe(true);
  });

  it("false in the main worktree — relative `.git` git-dir vs absolute common-dir that RESOLVE equal", () => {
    // The main worktree commonly reports a relative `.git` for --git-dir and an absolute path for
    // --git-common-dir; both must resolve (against root) to the same dir ⇒ false.
    const run = gitRunner({
      "--git-dir": { ok: true, out: ".git\n" },
      "--git-common-dir": { ok: true, out: "/repo/.git\n" },
    });
    expect(isLinkedWorktree("/repo", run)).toBe(false);
  });

  it("false when both are the same absolute path (main worktree)", () => {
    const run = gitRunner({
      "--git-dir": { ok: true, out: "/repo/.git\n" },
      "--git-common-dir": { ok: true, out: "/repo/.git\n" },
    });
    expect(isLinkedWorktree("/repo", run)).toBe(false);
  });

  it("false on a non-repo / git error (either rev-parse fails)", () => {
    expect(isLinkedWorktree("/nope", gitRunner({}))).toBe(false);
    const partial = gitRunner({
      "--git-dir": { ok: true, out: "/repo/.git\n" },
      "--git-common-dir": { ok: false, out: "fatal: not a git repository\n" },
    });
    expect(isLinkedWorktree("/repo", partial)).toBe(false);
  });
});

describe("revParse / diffNames (eval-provenance seams)", () => {
  function g(dir: string, args: string[]): string {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  }
  // ONE shared repo for the describe (no test mutates it after setup) — halves the git subprocess
  // count vs. a per-test `git init`, so the block stays fast under full-suite parallel load.
  let dir: string;
  let base: string;
  let head: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-gittest-"));
    g(dir, ["init"]);
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    g(dir, ["add", "-A"]);
    g(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "base"]);
    base = g(dir, ["rev-parse", "HEAD"]).trim();
    fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
    fs.writeFileSync(path.join(dir, "b.txt"), "new\n");
    g(dir, ["add", "-A"]);
    g(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "unit"]);
    head = g(dir, ["rev-parse", "HEAD"]).trim();
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("revParse resolves HEAD and a short SHA to the full commit; unknown ref → null", () => {
    expect(revParse(dir, "HEAD")).toBe(head);
    expect(revParse(dir, head.slice(0, 8))).toBe(head);
    expect(revParse(dir, "no-such-ref")).toBeNull();
    expect(revParse("/nonexistent-dir", "HEAD")).toBeNull();
  });

  it("diffNames returns absolute paths of files changed between base..HEAD; bad base → null", () => {
    const names = diffNames(dir, base);
    expect(names).not.toBeNull();
    expect(names!.sort()).toEqual([path.resolve(dir, "a.txt"), path.resolve(dir, "b.txt")]);
    expect(diffNames(dir, "bogus-base")).toBeNull();
  });
});
