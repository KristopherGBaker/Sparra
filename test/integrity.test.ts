import { describe, it, expect } from "vitest";
import path from "node:path";
import { snapshotArtifact, enforceArtifactIntegrity, type IntegrityDeps } from "../src/build/integrity.ts";

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
