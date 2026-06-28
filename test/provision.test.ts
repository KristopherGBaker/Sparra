import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { depsToProvision, pickCopyCmd, provisionWorkspaceDeps } from "../src/util/provision.ts";

/** Build injectable fs probes from sets of paths that "exist" / "are symlinks". */
function fakeFs(existing: Set<string>, symlinks: Set<string> = new Set()) {
  return {
    exists: (p: string) => existing.has(p) || symlinks.has(p),
    isSymlink: (p: string) => symlinks.has(p),
  };
}

/** A fake copy runner that records every argv and answers from `answer`. */
function fakeRun(answer: (argv: string[]) => { ok: boolean; out: string } = () => ({ ok: true, out: "" })) {
  const calls: string[][] = [];
  const run = vi.fn((argv: string[]) => {
    calls.push(argv);
    return answer(argv);
  });
  return { run, calls };
}

const ROOT = "/repo";
const WT = "/repo-wt";

describe("depsToProvision", () => {
  it("handles ≥2 dirs in ONE call with MIXED states, per-dir independent", () => {
    // node_modules: present in root, absent in worktree → INCLUDE.
    // .cache:       present in BOTH → EXCLUDE (already provisioned).
    // gone:         absent in root → EXCLUDE.
    // hoisted:      symlinked in root → SKIP (never copy).
    const existing = new Set([
      path.join(ROOT, "node_modules"),
      path.join(ROOT, ".cache"),
      path.join(WT, ".cache"),
    ]);
    const symlinks = new Set([path.join(ROOT, "hoisted")]);
    const { copy, skipped } = depsToProvision(
      ROOT,
      WT,
      ["node_modules", ".cache", "gone", "hoisted"],
      fakeFs(existing, symlinks)
    );
    expect(copy).toEqual(["node_modules"]);
    expect(skipped).toEqual(["hoisted"]);
  });
});

describe("pickCopyCmd", () => {
  it("darwin → a copy-on-write clone (cp -c), targeting a path inside the worktree", () => {
    const argv = pickCopyCmd("darwin", path.join(ROOT, "node_modules"), path.join(WT, "node_modules"));
    expect(argv).toEqual(["cp", "-c", "-R", "/repo/node_modules", "/repo-wt/node_modules"]);
    expect(argv).not.toContain("-s"); // never a symlink
    expect(argv[0]).not.toBe("ln");
    expect(argv[argv.length - 1]!.startsWith(WT)).toBe(true);
  });

  it("linux → cp -R --reflink=auto (a copy, not a symlink)", () => {
    const argv = pickCopyCmd("linux", path.join(ROOT, "node_modules"), path.join(WT, "node_modules"));
    expect(argv).toEqual(["cp", "-R", "--reflink=auto", "/repo/node_modules", "/repo-wt/node_modules"]);
    expect(argv[0]).not.toBe("ln");
  });

  it("other platforms → a plain recursive copy (cp -R), never ln -s", () => {
    const argv = pickCopyCmd("win32", "/a/x", "/b/x");
    expect(argv).toEqual(["cp", "-R", "/a/x", "/b/x"]);
    expect(argv.join(" ")).not.toContain("ln -s");
  });
});

describe("provisionWorkspaceDeps — gating", () => {
  it("no-op when workspaceDir === root (in-place run already has deps)", () => {
    const { run, calls } = fakeRun();
    const r = provisionWorkspaceDeps(ROOT, ROOT, { enabled: true, dirs: ["node_modules"] }, {
      exists: () => true,
      isSymlink: () => false,
      run,
      platform: "linux",
    });
    expect(calls).toEqual([]);
    expect(r.copied).toEqual([]);
  });

  it("no-op when cfg.enabled is false", () => {
    const { run, calls } = fakeRun();
    provisionWorkspaceDeps(ROOT, WT, { enabled: false, dirs: ["node_modules"] }, {
      exists: () => true,
      isSymlink: () => false,
      run,
      platform: "linux",
    });
    expect(calls).toEqual([]);
  });
});

describe("provisionWorkspaceDeps — positive copy (a no-op stub must FAIL this)", () => {
  it("issues EXACTLY ONE copy for the eligible dir and NONE for the symlinked dir", () => {
    const existing = new Set([path.join(ROOT, "node_modules")]); // eligible: in root, absent in WT
    const symlinks = new Set([path.join(ROOT, "hoisted")]); // symlinked in root → skip
    const { run, calls } = fakeRun();
    const r = provisionWorkspaceDeps(ROOT, WT, { enabled: true, dirs: ["node_modules", "hoisted"] }, {
      exists: fakeFs(existing, symlinks).exists,
      isSymlink: fakeFs(existing, symlinks).isSymlink,
      run,
      platform: "darwin",
    });
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(pickCopyCmd("darwin", path.join(ROOT, "node_modules"), path.join(WT, "node_modules")));
    expect(calls[0]![calls[0]!.length - 2]).toBe(path.join(ROOT, "node_modules")); // src = root/<dir>
    expect(calls[0]![calls[0]!.length - 1]).toBe(path.join(WT, "node_modules")); // dst = workspaceDir/<dir>
    expect(r.copied).toEqual(["node_modules"]);
    expect(r.skipped).toEqual(["hoisted"]);
  });
});

describe("provisionWorkspaceDeps — symlinked root dep dir", () => {
  it("warns + skips, issues NO copy, and produces no outside-pointing symlink", () => {
    const symlinks = new Set([path.join(ROOT, "node_modules")]);
    const { run, calls } = fakeRun();
    const r = provisionWorkspaceDeps(ROOT, WT, { enabled: true, dirs: ["node_modules"] }, {
      exists: fakeFs(new Set(), symlinks).exists,
      isSymlink: fakeFs(new Set(), symlinks).isSymlink,
      run,
      platform: "linux",
    });
    expect(calls).toEqual([]); // no copy, and certainly no `ln -s`
    expect(r.skipped).toEqual(["node_modules"]);
    expect(r.copied).toEqual([]);
  });
});

describe("provisionWorkspaceDeps — non-fatal copy failure", () => {
  it("does NOT throw when the injected run throws", () => {
    const existing = new Set([path.join(ROOT, "node_modules")]);
    const run = vi.fn(() => {
      throw new Error("boom");
    });
    let r: ReturnType<typeof provisionWorkspaceDeps> | undefined;
    expect(() => {
      r = provisionWorkspaceDeps(ROOT, WT, { enabled: true, dirs: ["node_modules"] }, {
        exists: fakeFs(existing).exists,
        isSymlink: fakeFs(existing).isSymlink,
        run,
        platform: "linux",
      });
    }).not.toThrow();
    expect(r!.failed).toEqual(["node_modules"]);
    expect(r!.copied).toEqual([]);
  });

  it("does NOT throw when the injected run returns ok:false", () => {
    const existing = new Set([path.join(ROOT, "node_modules")]);
    const { run } = fakeRun(() => ({ ok: false, out: "cp: permission denied" }));
    const r = provisionWorkspaceDeps(ROOT, WT, { enabled: true, dirs: ["node_modules"] }, {
      exists: fakeFs(existing).exists,
      isSymlink: fakeFs(existing).isSymlink,
      run,
      platform: "linux",
    });
    expect(r.failed).toEqual(["node_modules"]);
  });
});
