import { describe, it, expect } from "vitest";
import path from "node:path";
import { snapshotArtifact, enforceArtifactIntegrity, isBuildCachePath, type IntegrityDeps } from "../src/build/integrity.ts";

/** An in-memory fake IntegrityDeps so the guard is exercised with no real git/fs.
 *  `tracked` is the artifact surface (what `git ls-files …` would list, relative to ws).
 *  `files` is the on-disk content keyed by RELPATH (the test mutates this to simulate the
 *  evaluator writing during the exercise). */
function fakeDeps(ws: string, initial: Record<string, string | Buffer>, tracked: string[]) {
  const files = new Map<string, Buffer>(
    Object.entries(initial).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v)])
  );
  const rel = (abs: string) => path.relative(ws, abs);
  const writes: string[] = [];
  const removes: string[] = [];
  const reads: string[] = [];
  const deps: IntegrityDeps = {
    // The surface = tracked names that still exist, PLUS any new (injected) non-ignored file.
    listArtifactFiles: () => {
      const set = new Set<string>(tracked.filter((t) => files.has(t)));
      for (const k of files.keys()) if (!IGNORED.some((ig) => k.startsWith(ig))) set.add(k);
      return [...set];
    },
    readFile: (abs) => {
      reads.push(rel(abs));
      return files.has(rel(abs)) ? files.get(rel(abs))! : null;
    },
    writeFile: (abs, content) => {
      writes.push(rel(abs));
      files.set(rel(abs), content);
    },
    removeFile: (abs) => {
      removes.push(rel(abs));
      files.delete(rel(abs));
    },
  };
  return { deps, files, writes, removes, reads };
}

// Scratch the lister would never surface (gitignored): node_modules, .vite-temp, coverage.
const IGNORED = ["node_modules/", ".vite-temp", "coverage/"];

const WS = "/ws";

describe("source-integrity guard (snapshotArtifact + enforceArtifactIntegrity)", () => {
  it("a clean run returns [] and writes/removes nothing", () => {
    const { deps, writes, removes } = fakeDeps(WS, { "src/a.ts": "A", "src/b.ts": "B" }, ["src/a.ts", "src/b.ts"]);
    const snap = snapshotArtifact(WS, deps);
    const mutated = enforceArtifactIntegrity(WS, snap, deps);
    expect(mutated).toEqual([]);
    expect(writes).toEqual([]);
    expect(removes).toEqual([]);
  });

  it("a modified tracked file is detected, restored to the snapshot bytes, and reported", () => {
    const ctx = fakeDeps(WS, { "src/a.ts": "A", "src/b.ts": "B" }, ["src/a.ts", "src/b.ts"]);
    const snap = snapshotArtifact(WS, ctx.deps);
    ctx.files.set("src/a.ts", Buffer.from("HACKED")); // evaluator edits the code it grades
    const mutated = enforceArtifactIntegrity(WS, snap, ctx.deps);
    expect(mutated).toEqual(["src/a.ts"]);
    expect(ctx.files.get("src/a.ts")!.toString()).toBe("A"); // restored
  });

  it("a deleted artifact file is recreated and reported", () => {
    const ctx = fakeDeps(WS, { "src/a.ts": "A", "src/b.ts": "B" }, ["src/a.ts", "src/b.ts"]);
    const snap = snapshotArtifact(WS, ctx.deps);
    ctx.files.delete("src/b.ts");
    const mutated = enforceArtifactIntegrity(WS, snap, ctx.deps);
    expect(mutated).toEqual(["src/b.ts"]);
    expect(ctx.files.get("src/b.ts")!.toString()).toBe("B"); // recreated
  });

  it("a newly-injected non-ignored file is removed and reported", () => {
    const ctx = fakeDeps(WS, { "src/a.ts": "A" }, ["src/a.ts"]);
    const snap = snapshotArtifact(WS, ctx.deps);
    ctx.files.set("src/evil.ts", Buffer.from("injected")); // evaluator injects a new source file
    const mutated = enforceArtifactIntegrity(WS, snap, ctx.deps);
    expect(mutated).toEqual(["src/evil.ts"]);
    expect(ctx.files.has("src/evil.ts")).toBe(false); // removed
  });

  it("gitignored scratch (node_modules/.vite-temp, coverage) is never touched or flagged", () => {
    const ctx = fakeDeps(WS, { "src/a.ts": "A" }, ["src/a.ts"]);
    const snap = snapshotArtifact(WS, ctx.deps);
    // Test/build tools write scratch under ignored dirs — exactly what workspace-write must permit.
    ctx.files.set("node_modules/.vite-temp/x", Buffer.from("tmp"));
    ctx.files.set("coverage/lcov.info", Buffer.from("cov"));
    const mutated = enforceArtifactIntegrity(WS, snap, ctx.deps);
    expect(mutated).toEqual([]); // not part of the artifact surface
    expect(ctx.files.has("node_modules/.vite-temp/x")).toBe(true); // left in place
    expect(ctx.files.has("coverage/lcov.info")).toBe(true);
    expect(ctx.removes).toEqual([]);
    // H3: the guard only ever touches artifact-surface paths, never ignored scratch.
    expect(ctx.reads.some((r) => r.startsWith("node_modules/") || r.startsWith("coverage/"))).toBe(false);
    expect(ctx.writes.some((w) => w.startsWith("node_modules/") || w.startsWith("coverage/"))).toBe(false);
  });

  it("reports the deduped, sorted set across mixed mutations", () => {
    const ctx = fakeDeps(WS, { "src/a.ts": "A", "src/b.ts": "B", "src/c.ts": "C" }, ["src/a.ts", "src/b.ts", "src/c.ts"]);
    const snap = snapshotArtifact(WS, ctx.deps);
    ctx.files.set("src/c.ts", Buffer.from("edited"));
    ctx.files.delete("src/a.ts");
    ctx.files.set("src/new.ts", Buffer.from("new"));
    const mutated = enforceArtifactIntegrity(WS, snap, ctx.deps);
    expect(mutated).toEqual(["src/a.ts", "src/c.ts", "src/new.ts"]);
  });

  it("restore is byte-exact for binary / non-UTF-8 / trailing-newline content (H2)", () => {
    // A tracked binary asset (e.g. an iOS image) + a unicode file with a trailing newline.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
    const unicode = Buffer.from("héllo — 🌳\n\n");
    const ctx = fakeDeps(WS, { "assets/i.png": png, "src/u.ts": unicode }, ["assets/i.png", "src/u.ts"]);
    const snap = snapshotArtifact(WS, ctx.deps);
    ctx.files.set("assets/i.png", Buffer.from([0x00])); // evaluator corrupts the binary
    ctx.files.set("src/u.ts", Buffer.from("mangled"));
    const mutated = enforceArtifactIntegrity(WS, snap, ctx.deps);
    expect(mutated).toEqual(["assets/i.png", "src/u.ts"]);
    expect(ctx.files.get("assets/i.png")!.equals(png)).toBe(true); // byte-identical
    expect(ctx.files.get("src/u.ts")!.equals(unicode)).toBe(true);
  });
});

describe("build-cache exclusion (isBuildCachePath + guard integration)", () => {
  it("isBuildCachePath matches the documented cache relpaths and nothing else", () => {
    // .cache/clang/ModuleCache as any segment run; .build/DerivedData as any segment; .swiftpm-home/ leading.
    for (const yes of [
      ".swiftpm-home/config.json",
      ".swiftpm-home/.cache/clang/ModuleCache/x-ABC/mod.pcm",
      ".build/debug/App.o",
      "sub/.build/x.o",
      "App/DerivedData/Build/Products/x",
      "nested/.cache/clang/ModuleCache/y.pcm",
      "./.build/x.o", // leading ./ normalized away
    ]) {
      expect(isBuildCachePath(yes)).toBe(true);
    }
    // Windows-style separators normalize too.
    expect(isBuildCachePath("sub\\.build\\x.o")).toBe(true);
    expect(isBuildCachePath(".swiftpm-home\\a\\b")).toBe(true);
    // Real graded source (incl. lookalikes) is NOT excluded.
    for (const no of [
      "src/App.swift",
      "src/build/integrity.ts", // ".build" only as a substring, not a segment
      "docs/DerivedDataNotes.md", // "DerivedData" only as a substring
      ".cache/clang/other/x", // wrong tail
      "swiftpm-home/x", // no leading dot
    ]) {
      expect(isBuildCachePath(no)).toBe(false);
    }
  });

  it("an evaluator writing ONLY excluded cache paths yields an empty mutated list (created/modified/deleted)", () => {
    const ctx = fakeDeps(
      WS,
      { "src/App.swift": "APP", ".build/old.o": "OLD", ".swiftpm-home/existing": "E" },
      ["src/App.swift", ".build/old.o", ".swiftpm-home/existing"]
    );
    const snap = snapshotArtifact(WS, ctx.deps);
    ctx.files.set(".swiftpm-home/.cache/clang/ModuleCache/m.pcm", Buffer.from("new")); // created
    ctx.files.set(".build/old.o", Buffer.from("rebuilt")); // modified
    ctx.files.delete(".swiftpm-home/existing"); // deleted
    const mutated = enforceArtifactIntegrity(WS, snap, ctx.deps);
    expect(mutated).toEqual([]); // no integrity violation
    // Excluded paths are left exactly as the build left them (not restored/removed).
    expect(ctx.files.get(".build/old.o")!.toString()).toBe("rebuilt");
    expect(ctx.files.has(".swiftpm-home/.cache/clang/ModuleCache/m.pcm")).toBe(true);
    expect(ctx.files.has(".swiftpm-home/existing")).toBe(false);
    expect(ctx.writes).toEqual([]);
    expect(ctx.removes).toEqual([]);
  });

  it("a real source mutation alongside excluded cache writes reports ONLY the source", () => {
    const ctx = fakeDeps(WS, { "src/App.swift": "APP" }, ["src/App.swift"]);
    const snap = snapshotArtifact(WS, ctx.deps);
    ctx.files.set("src/App.swift", Buffer.from("HACKED")); // real graded-source edit
    ctx.files.set(".build/debug/App.o", Buffer.from("obj")); // legit build cache
    ctx.files.set(".swiftpm-home/.cache/clang/ModuleCache/m.pcm", Buffer.from("mc"));
    const mutated = enforceArtifactIntegrity(WS, snap, ctx.deps);
    expect(mutated).toEqual(["src/App.swift"]); // only the source trips the guard
    expect(ctx.files.get("src/App.swift")!.toString()).toBe("APP"); // reverted
    expect(ctx.files.has(".build/debug/App.o")).toBe(true); // cache untouched
    expect(ctx.files.has(".swiftpm-home/.cache/clang/ModuleCache/m.pcm")).toBe(true);
  });

  it("an excluded path present at snapshot then modified is not restored-and-reported (snapshot/enforce agree)", () => {
    const ctx = fakeDeps(WS, { "src/App.swift": "APP", ".build/x.o": "V1" }, ["src/App.swift", ".build/x.o"]);
    const snap = snapshotArtifact(WS, ctx.deps);
    expect(snap.files.has(".build/x.o")).toBe(false); // excluded from the protected set on the snapshot side
    ctx.files.set(".build/x.o", Buffer.from("V2"));
    const mutated = enforceArtifactIntegrity(WS, snap, ctx.deps);
    expect(mutated).toEqual([]);
    expect(ctx.files.get(".build/x.o")!.toString()).toBe("V2"); // left as rebuilt, not reverted to V1
  });

  describe(".claude/skills scratch exclusion", () => {
    it("isBuildCachePath returns true for .claude/skills paths (direct and nested)", () => {
      // Direct: tool writes .claude/skills/aseprite during exercise.
      expect(isBuildCachePath(".claude/skills/aseprite")).toBe(true);
      // Nested file inside skill dir.
      expect(isBuildCachePath(".claude/skills/aseprite/tool.json")).toBe(true);
      // Consecutive segment run appearing deeper in the path.
      expect(isBuildCachePath("some/dir/.claude/skills/x")).toBe(true);
      // Windows-style separators normalize correctly.
      expect(isBuildCachePath(".claude\\skills\\aseprite")).toBe(true);
    });

    it("isBuildCachePath returns false for other .claude/ paths — only skills scratch is whitelisted", () => {
      // Settings file — must remain on the integrity surface.
      expect(isBuildCachePath(".claude/settings.json")).toBe(false);
      // Arbitrary file under .claude/ — not whitelisted.
      expect(isBuildCachePath(".claude/foo.ts")).toBe(false);
      // Hooks directory — not whitelisted.
      expect(isBuildCachePath(".claude/hooks/x.sh")).toBe(false);
    });

    it("isBuildCachePath returns false for false-positive candidates (wrong segment name/boundary)", () => {
      // Segment is 'skills-evil', not exactly 'skills'.
      expect(isBuildCachePath(".claude/skills-evil/x")).toBe(false);
      // Leading segment is 'foo.claude', not '.claude'.
      expect(isBuildCachePath("foo.claude/skills/x")).toBe(false);
    });

    it("existing whitelisted paths still return true; ordinary source paths still return false", () => {
      // Existing whitelist entries must be unaffected.
      expect(isBuildCachePath(".swiftpm-home/x")).toBe(true);
      expect(isBuildCachePath("a/.build/x")).toBe(true);
      expect(isBuildCachePath("x/DerivedData/y")).toBe(true);
      expect(isBuildCachePath("p/.cache/clang/ModuleCache/z")).toBe(true);
      // Ordinary source.
      expect(isBuildCachePath("src/foo.ts")).toBe(false);
      expect(isBuildCachePath("README.md")).toBe(false);
    });

    it("a .claude/skills/… file written during exercise is not snapshotted, not reverted, not reported", () => {
      const ctx = fakeDeps(WS, { "src/App.swift": "APP" }, ["src/App.swift"]);
      const snap = snapshotArtifact(WS, ctx.deps);
      // Skill scratch injected by a tool during exercise.
      ctx.files.set(".claude/skills/aseprite", Buffer.from("skill-data"));
      const mutated = enforceArtifactIntegrity(WS, snap, ctx.deps);
      // No integrity violation — skills scratch is whitelisted.
      expect(mutated).toEqual([]);
      // The file is left in place (not removed).
      expect(ctx.files.has(".claude/skills/aseprite")).toBe(true);
      expect(ctx.removes).toEqual([]);
    });

    it("a .claude/settings.json mutation alongside skills scratch reports only the settings file", () => {
      const ctx = fakeDeps(WS, { "src/App.swift": "APP", ".claude/settings.json": "CFG" }, ["src/App.swift", ".claude/settings.json"]);
      const snap = snapshotArtifact(WS, ctx.deps);
      // Settings tampered with — MUST be detected.
      ctx.files.set(".claude/settings.json", Buffer.from("HACKED"));
      // Skills scratch added — MUST be ignored.
      ctx.files.set(".claude/skills/aseprite", Buffer.from("skill"));
      const mutated = enforceArtifactIntegrity(WS, snap, ctx.deps);
      expect(mutated).toEqual([".claude/settings.json"]);
      // Settings reverted; skills scratch left alone.
      expect(ctx.files.get(".claude/settings.json")!.toString()).toBe("CFG");
      expect(ctx.files.has(".claude/skills/aseprite")).toBe(true);
    });
  });
});
