import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { detect } from "../src/detect.ts";

/** Create a fresh temporary directory and return its path. */
function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sparra-test-"));
}

const dirsToClean: string[] = [];

function tmpDir(): string {
  const d = makeTmp();
  dirsToClean.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirsToClean.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("detect", () => {
  it("returns greenfield with sourceFileCount:0 and no signals for an empty dir", () => {
    const dir = tmpDir();
    const result = detect(dir);
    expect(result.mode).toBe("greenfield");
    expect(result.sourceFileCount).toBe(0);
    expect(result.signals).toEqual([]);
    expect(result.light).toBe(false);
  });

  it("returns existing when dir has package.json + one .ts source file", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"test"}', "utf8");
    fs.writeFileSync(path.join(dir, "index.ts"), "export {};", "utf8");
    const result = detect(dir);
    expect(result.mode).toBe("existing");
    expect(result.sourceFileCount).toBe(1);
  });

  it("CRITICAL: returns existing with 'git history present' when manifest + .git/refs/heads has a file", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"test"}', "utf8");
    // Simulate git history: create .git/refs/heads/main
    const headsDir = path.join(dir, ".git", "refs", "heads");
    fs.mkdirSync(headsDir, { recursive: true });
    fs.writeFileSync(path.join(headsDir, "main"), "abc123\n", "utf8");

    const result = detect(dir);
    expect(result.mode).toBe("existing");
    expect(result.signals).toContain("git history present");
    // No source files were present; only manifest + git triggered existing
    expect(result.sourceFileCount).toBe(0);
  });

  it("CRITICAL: returns greenfield with light:true when only package.json present (no source, no .git)", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"test"}', "utf8");
    const result = detect(dir);
    expect(result.mode).toBe("greenfield");
    expect(result.light).toBe(true);
    expect(result.sourceFileCount).toBe(0);
  });

  it("returns existing when 3 or more source files are present regardless of manifest", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "a.ts"), "", "utf8");
    fs.writeFileSync(path.join(dir, "b.ts"), "", "utf8");
    fs.writeFileSync(path.join(dir, "c.ts"), "", "utf8");
    const result = detect(dir);
    expect(result.mode).toBe("existing");
    expect(result.sourceFileCount).toBe(3);
  });
});
