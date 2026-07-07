import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  depsToProvision,
  pickCopyCmd,
  provisionWorkspaceDeps,
  prewarmSwiftPackages,
  swiftpmCacheDir,
  ensureSwiftpmCacheDir,
  type SwiftPrewarmDeps,
} from "../src/util/provision.ts";
import { createSandboxSessionEnv } from "../src/build/judgeScratch.ts";
import { defaultConfig } from "../src/config.ts";

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

/** A spy prewarm runner: records every (argv, opts) and answers from `answer` (default ok). */
function fakeSwiftRun(answer: () => { ok: boolean; out: string } = () => ({ ok: true, out: "" })) {
  const calls: { argv: string[]; opts: { cwd: string; env: NodeJS.ProcessEnv } }[] = [];
  const run: NonNullable<SwiftPrewarmDeps["run"]> = (argv, opts) => {
    calls.push({ argv, opts });
    return answer();
  };
  return { run, calls };
}

describe("swiftpmCacheDir — durable, worktree-local derivation", () => {
  it("is STABLE for a given worktree and DISTINCT across worktrees (not a per-run temp)", () => {
    const a = swiftpmCacheDir("/wt/one");
    expect(swiftpmCacheDir("/wt/one")).toBe(a); // deterministic — two calls agree
    expect(swiftpmCacheDir("/wt/two")).not.toBe(a); // keyed on the worktree path
    expect(a).toMatch(/sparra-swiftpm/);
    // STRUCTURAL: the durable cache lives under a "sparra-swiftpm" parent segment —
    // immune to an ambient TMPDIR that itself contains a sprj-* token.
    expect(path.basename(path.dirname(a))).toBe("sparra-swiftpm"); // NOT the ephemeral clang/TMPDIR scratch
    // NEGATIVE FIXTURE: a synthetic ephemeral path must FAIL the same predicate, proving it discriminates.
    expect(path.basename(path.dirname("/tmp/sprj-deadbeef/swiftpm"))).not.toBe("sparra-swiftpm");
  });
});

describe("SwiftPM durable cache continuity (U-X #3)", () => {
  it("the prewarm's cache dir EQUALS the later session env's SWIFTPM_CACHE_DIR — durable, not per-session", () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-swiftcont-"));
    try {
      const cfg = defaultConfig();
      const spy = fakeSwiftRun();
      // Prewarm resolves into the durable worktree-local cache.
      const r = prewarmSwiftPackages("/repo", wt, { swiftPackages: true }, { exists: () => true, run: spy.run });
      // Two LATER independent sessions of the SAME worktree.
      const sessA = createSandboxSessionEnv(cfg, wt);
      const sessB = createSandboxSessionEnv(cfg, wt);
      expect(r.cacheDir).toBe(swiftpmCacheDir(wt));
      expect(sessA.SWIFTPM_CACHE_DIR).toBe(r.cacheDir); // prewarm cache == session cache
      // DURABLE: two sessions share ONE SwiftPM cache (a fresh-per-session temp would FAIL this).
      expect(sessB.SWIFTPM_CACHE_DIR).toBe(sessA.SWIFTPM_CACHE_DIR);
      // The ephemeral clang/TMPDIR scratch, by contrast, IS fresh per session (regenerable).
      expect(sessB.TMPDIR).not.toBe(sessA.TMPDIR);
      expect(path.basename(path.dirname(sessA.SWIFTPM_CACHE_DIR!))).toBe("sparra-swiftpm");
      // The durable cache is materialized on disk (ensureSwiftpmCacheDir), ready for an offline build.
      expect(fs.existsSync(ensureSwiftpmCacheDir(wt))).toBe(true);
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("prewarmSwiftPackages — invocation (U-X #5)", () => {
  it("ON + Package.swift ⇒ runs `swift package resolve` in the worktree, targeting the durable cache", () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-prewarm-"));
    try {
      const spy = fakeSwiftRun();
      const r = prewarmSwiftPackages("/repo", wt, { swiftPackages: true }, {
        exists: (p) => p.endsWith("Package.swift"), // source tree IS a SwiftPM package
        run: spy.run,
      });
      expect(r.ran).toBe(true);
      expect(r.ok).toBe(true);
      expect(spy.calls).toHaveLength(1);
      const { argv, opts } = spy.calls[0]!;
      const cacheDir = swiftpmCacheDir(wt);
      expect(argv.slice(0, 3)).toEqual(["swift", "package", "resolve"]); // resolve-style command
      expect(argv).toContain("--cache-path");
      expect(argv).toContain(cacheDir); // targets the durable cache
      expect(r.cacheDir).toBe(cacheDir);
      expect(opts.env.SWIFTPM_CACHE_DIR).toBe(cacheDir); // env points there too
      expect(opts.cwd).toBe(wt); // runs in the worktree (provisioning cwd), not the source root
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("prewarmSwiftPackages — skip / non-fatal (U-X #6)", () => {
  const WT = "/repo-wt";

  it("(a) knob disabled ⇒ runner NOT invoked (spy 0)", () => {
    const spy = fakeSwiftRun();
    const r = prewarmSwiftPackages("/repo", WT, { swiftPackages: false }, { exists: () => true, run: spy.run });
    expect(spy.calls).toHaveLength(0);
    expect(r.ran).toBe(false);
    expect(r.skipped).toBe("disabled");
  });

  it("(b) enabled but NO Package.swift ⇒ runner NOT invoked (spy 0)", () => {
    const spy = fakeSwiftRun();
    const r = prewarmSwiftPackages("/repo", WT, { swiftPackages: true }, { exists: () => false, run: spy.run });
    expect(spy.calls).toHaveLength(0);
    expect(r.ran).toBe(false);
    expect(r.skipped).toBe("not-a-swift-package");
  });

  it("(c) enabled + Package.swift + runner THROWS ⇒ provisioning still completes (non-fatal)", () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-prewarm-throw-"));
    try {
      let r: ReturnType<typeof prewarmSwiftPackages> | undefined;
      expect(() => {
        r = prewarmSwiftPackages("/repo", wt, { swiftPackages: true }, {
          exists: () => true,
          run: () => {
            throw new Error("boom");
          },
        });
      }).not.toThrow(); // never aborts provisioning
      expect(r!.ran).toBe(true);
      expect(r!.ok).toBe(false); // recorded as failed
      expect(r!.out).toContain("boom");
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });

  it("in-place (workspaceDir === root) ⇒ runner NOT invoked (deps already resolved)", () => {
    const spy = fakeSwiftRun();
    const r = prewarmSwiftPackages("/repo", "/repo", { swiftPackages: true }, { exists: () => true, run: spy.run });
    expect(spy.calls).toHaveLength(0);
    expect(r.skipped).toBe("in-place");
  });
});
