import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "../config.ts";
import { discoverAllProjects, MAX_DISCOVERED_PROJECTS } from "./discovery.ts";
import type { ProjectStatus } from "./phases.ts";

const cleanupDirs: string[] = [];

function tmpRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sparra-disc-")));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Plant a real `.sparra/state.json` at `dir`, making it a discoverable Sparra project. */
function makeProject(dir: string, phase = "build"): void {
  mkdirSync(join(dir, ".sparra"), { recursive: true });
  writeFileSync(join(dir, ".sparra", "state.json"), JSON.stringify({ phase }), "utf8");
}

/** Test status source: mirrors the real default reader (phase + a static hint), nothing more. */
const statusSource = (root: string): ProjectStatus => {
  try {
    const raw = readFileSync(join(root, ".sparra", "state.json"), "utf8");
    const data = JSON.parse(raw) as { phase?: unknown };
    const phase = typeof data.phase === "string" ? data.phase : "unknown";
    return { phase, next: "hint" };
  } catch {
    return { phase: "uninitialized", next: "sparra init" };
  }
};

function baseConfig(roots: string[], overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    roots,
    port: 8787,
    lastNJobs: 50,
    auditLogPath: "/tmp/audit.log",
    allowRemotePlan: false,
    dashboard: true,
    discoverProjects: true,
    discoverDepth: 3,
    ...overrides,
  };
}

describe("discoverAllProjects — finds nested projects", () => {
  it("discovers projects at depths 1..N under an allowlisted root that is not itself a project", () => {
    const root = tmpRoot();
    makeProject(join(root, "projA"));
    makeProject(join(root, "sub", "projB"));
    makeProject(join(root, "sub", "deeper", "projC"));

    const result = discoverAllProjects(baseConfig([root], { discoverDepth: 3 }), { statusSource });

    expect(result.map((p) => p.root).sort()).toEqual(
      [join(root, "projA"), join(root, "sub", "projB"), join(root, "sub", "deeper", "projC")].sort(),
    );
  });

  it("reports the SAME phase/next the existing status read produces, per discovered project", () => {
    const root = tmpRoot();
    makeProject(join(root, "projA"), "build");
    makeProject(join(root, "projB"), "done");

    const result = discoverAllProjects(baseConfig([root]), { statusSource });
    const byRoot = new Map(result.map((p) => [p.root, p]));
    expect(byRoot.get(join(root, "projA"))).toEqual({ root: join(root, "projA"), phase: "build", next: "hint" });
    expect(byRoot.get(join(root, "projB"))).toEqual({ root: join(root, "projB"), phase: "done", next: "hint" });
  });
});

describe("discoverAllProjects — depth bound is exact", () => {
  it("lists a project at exactly discoverDepth, not one at discoverDepth + 1", () => {
    const root = tmpRoot();
    // depth 2: root/a/b (project)
    makeProject(join(root, "a", "atDepth2"));
    // depth 3: root/a/b/c (project) — one level deeper
    makeProject(join(root, "a", "atDepth2Parent", "atDepth3"));

    const shallow = discoverAllProjects(baseConfig([root], { discoverDepth: 2 }), { statusSource });
    expect(shallow.map((p) => p.root)).toContain(join(root, "a", "atDepth2"));
    expect(shallow.map((p) => p.root)).not.toContain(join(root, "a", "atDepth2Parent", "atDepth3"));

    const deep = discoverAllProjects(baseConfig([root], { discoverDepth: 3 }), { statusSource });
    expect(deep.map((p) => p.root)).toContain(join(root, "a", "atDepth2Parent", "atDepth3"));
  });

  it("discoverDepth:0 lists only a root that is itself a project", () => {
    const projectRoot = tmpRoot();
    makeProject(projectRoot);
    makeProject(join(projectRoot, "nested")); // depth 1 — must NOT appear at depth 0

    const result = discoverAllProjects(baseConfig([projectRoot], { discoverDepth: 0 }), { statusSource });
    expect(result.map((p) => p.root)).toEqual([projectRoot]);
  });

  it("discoverDepth:0 over a root that is NOT itself a project yields nothing", () => {
    const root = tmpRoot();
    makeProject(join(root, "nested"));
    const result = discoverAllProjects(baseConfig([root], { discoverDepth: 0 }), { statusSource });
    expect(result).toEqual([]);
  });
});

describe("discoverAllProjects — stops descending at a found project", () => {
  it("a .sparra/ nested BELOW an already-found project is not a second entry", () => {
    const root = tmpRoot();
    makeProject(join(root, "outer"));
    // A second .sparra sits INSIDE the already-found "outer" project.
    makeProject(join(root, "outer", "inner"));

    const result = discoverAllProjects(baseConfig([root], { discoverDepth: 5 }), { statusSource });
    expect(result.map((p) => p.root)).toEqual([join(root, "outer")]);
  });
});

describe("discoverAllProjects — skips noise dirs", () => {
  it("does not discover a .sparra/ planted under node_modules or .git", () => {
    const root = tmpRoot();
    makeProject(join(root, "node_modules", "someLib"));
    makeProject(join(root, ".git", "hooks-ish"));
    makeProject(join(root, "realProject")); // control: a real, non-noise project still found

    const result = discoverAllProjects(baseConfig([root], { discoverDepth: 3 }), { statusSource });
    expect(result.map((p) => p.root)).toEqual([join(root, "realProject")]);
  });
});

describe("discoverAllProjects — never follows symlinks", () => {
  it("(a) a symlink to another real project inside the allowlist: the alias is not reported", () => {
    const root = tmpRoot();
    const real = join(root, "realProject");
    makeProject(real);
    symlinkSync(real, join(root, "aliasToReal"));

    const result = discoverAllProjects(baseConfig([root], { discoverDepth: 3 }), { statusSource });
    const roots = result.map((p) => p.root);
    expect(roots).not.toContain(join(root, "aliasToReal"));
    // The canonical project, reached via the real (non-symlink) path, is fine to still appear.
    expect(roots).toContain(real);
  });

  it("(b) a symlink cycle (dir → an ancestor) terminates the walk and the alias is not descended", () => {
    const root = tmpRoot();
    makeProject(join(root, "control")); // proves the walk still completes and finds real work
    mkdirSync(join(root, "cyclic"), { recursive: true });
    // cyclic/loopToRoot -> root (an ancestor) — a classic cycle.
    symlinkSync(root, join(root, "cyclic", "loopToRoot"));

    const result = discoverAllProjects(baseConfig([root], { discoverDepth: 5 }), { statusSource });
    expect(result.map((p) => p.root)).toEqual([join(root, "control")]);
  });

  it("(c) a symlink pointing OUTSIDE the allowlisted root: alias + its contents are absent", () => {
    const root = tmpRoot();
    const outside = tmpRoot();
    makeProject(join(outside, "secretProject"));
    symlinkSync(outside, join(root, "escapeLink"));

    const result = discoverAllProjects(baseConfig([root], { discoverDepth: 3 }), { statusSource });
    const roots = result.map((p) => p.root);
    expect(roots).not.toContain(join(root, "escapeLink"));
    expect(roots).not.toContain(join(root, "escapeLink", "secretProject"));
    expect(roots.some((r) => r.includes("secretProject"))).toBe(false);
  });
});

describe("discoverAllProjects — allowlist containment", () => {
  it("every reported root's realpath is genuinely under the allowlisted root's realpath", () => {
    const root = tmpRoot();
    makeProject(join(root, "projA"));
    makeProject(join(root, "sub", "projB"));
    const outside = tmpRoot();
    makeProject(join(outside, "secretProject"));
    symlinkSync(outside, join(root, "escapeLink"));

    const result = discoverAllProjects(baseConfig([root], { discoverDepth: 3 }), { statusSource });
    expect(result.length).toBeGreaterThan(0);
    for (const p of result) {
      expect(p.root.startsWith(root + "/") || p.root === root).toBe(true);
      expect(realpathSync(p.root)).toBe(p.root);
    }
  });
});

describe("discoverAllProjects — bounded + deterministic", () => {
  it("(a) results are deterministically sorted by root", () => {
    const root = tmpRoot();
    makeProject(join(root, "zeta"));
    makeProject(join(root, "alpha"));
    makeProject(join(root, "mid"));

    const result = discoverAllProjects(baseConfig([root]), { statusSource });
    const roots = result.map((p) => p.root);
    const sorted = [...roots].sort();
    expect(roots).toEqual(sorted);
  });

  it("(b) results are capped at MAX_DISCOVERED_PROJECTS even when more exist", () => {
    const root = tmpRoot();
    const total = MAX_DISCOVERED_PROJECTS + 5;
    for (let i = 0; i < total; i++) {
      makeProject(join(root, `proj${i}`));
    }
    const result = discoverAllProjects(baseConfig([root], { discoverDepth: 1 }), { statusSource });
    expect(result.length).toBe(MAX_DISCOVERED_PROJECTS);
  }, 20000);

  it("(c) never descends deeper than discoverDepth (already covered structurally above; spot-check a tight bound)", () => {
    const root = tmpRoot();
    makeProject(join(root, "a", "b", "c")); // depth 3
    const result = discoverAllProjects(baseConfig([root], { discoverDepth: 1 }), { statusSource });
    expect(result).toEqual([]);
  });

  it("(d) a finite synthetic wide+deep fixture well beyond discoverDepth completes and returns a value", () => {
    const root = tmpRoot();
    // width 20 at each of 3 levels below root, depth well beyond discoverDepth (2).
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < 5; j++) {
        mkdirSync(join(root, `w${i}`, `w${j}`, "leaf"), { recursive: true });
      }
    }
    makeProject(join(root, "w0", "w0")); // one real project within bound, to prove real work still happens
    const result = discoverAllProjects(baseConfig([root], { discoverDepth: 2 }), { statusSource });
    expect(Array.isArray(result)).toBe(true);
    expect(result.map((p) => p.root)).toContain(join(root, "w0", "w0"));
  });
});

describe("discoverAllProjects — holdout-safe entries", () => {
  it("each entry carries ONLY {root, phase, next} — no other state.json field", () => {
    const root = tmpRoot();
    const dir = join(root, "projA");
    mkdirSync(join(dir, ".sparra"), { recursive: true });
    writeFileSync(
      join(dir, ".sparra", "state.json"),
      JSON.stringify({ phase: "build", secretHoldoutField: "should never leak", other: 42 }),
      "utf8",
    );

    const result = discoverAllProjects(baseConfig([root]), { statusSource });
    expect(result).toHaveLength(1);
    expect(Object.keys(result[0]!).sort()).toEqual(["next", "phase", "root"]);
    expect(JSON.stringify(result[0])).not.toContain("secretHoldoutField");
  });
});

describe("discoverAllProjects — a missing/unreadable configured root", () => {
  it("yields no projects (not a crash) rather than throwing", () => {
    const missing = join(tmpdir(), "sparra-disc-does-not-exist-xyz");
    expect(() => discoverAllProjects(baseConfig([missing]), { statusSource })).not.toThrow();
    expect(discoverAllProjects(baseConfig([missing]), { statusSource })).toEqual([]);
  });
});
