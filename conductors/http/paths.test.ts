import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  isWithinAllowlistedRoot,
  matchedAllowlistRoot,
  PathGuardError,
  resolveWithinAllowlist,
} from "./paths.ts";

let tmp: string;
let root: string;
let outside: string;

beforeAll(() => {
  // realpath the tmp base so macOS /var → /private/var symlinking doesn't confuse the comparisons.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "sparra-http-paths-")));
  root = join(tmp, "root");
  outside = join(tmp, "outside");
  mkdirSync(join(root, "sub"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "sub", "file.txt"), "hi");
  writeFileSync(join(outside, "secret.txt"), "nope");
  // A symlink INSIDE root pointing OUTSIDE it.
  symlinkSync(outside, join(root, "escape"));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveWithinAllowlist", () => {
  it("returns the realpath for a path inside an allowlisted root", () => {
    const resolved = resolveWithinAllowlist(join(root, "sub", "file.txt"), [root]);
    expect(resolved).toBe(join(root, "sub", "file.txt"));
  });

  it("accepts the root itself", () => {
    expect(resolveWithinAllowlist(root, [root])).toBe(root);
  });

  it("resolves a not-yet-existing leaf via its nearest existing parent", () => {
    const p = join(root, "sub", "does-not-exist-yet.txt");
    expect(resolveWithinAllowlist(p, [root])).toBe(p);
  });

  it("THROWS on `..` traversal escaping a root", () => {
    expect(() => resolveWithinAllowlist(join(root, "..", "outside", "secret.txt"), [root])).toThrow(
      PathGuardError,
    );
  });

  it("THROWS on a symlink inside a root whose realpath points outside it", () => {
    // root/escape → outside; resolving root/escape/secret.txt must land outside and be rejected.
    expect(() => resolveWithinAllowlist(join(root, "escape", "secret.txt"), [root])).toThrow(
      PathGuardError,
    );
  });

  it("THROWS on a symlink escape even for a not-yet-existing leaf under it", () => {
    expect(() => resolveWithinAllowlist(join(root, "escape", "brand-new.txt"), [root])).toThrow(
      PathGuardError,
    );
  });

  it("THROWS for a path under no allowlisted root", () => {
    expect(() => resolveWithinAllowlist(join(outside, "secret.txt"), [root])).toThrow(PathGuardError);
  });

  it("ACCEPTS an in-root directory whose name merely starts with `..` (e.g. `..safe`)", () => {
    const dotDir = join(root, "..safe");
    mkdirSync(dotDir, { recursive: true });
    writeFileSync(join(dotDir, "f.txt"), "ok");
    // `relative(root, root/..safe/f.txt)` is `..safe/f.txt` — NOT a real traversal; must be accepted.
    expect(resolveWithinAllowlist(join(dotDir, "f.txt"), [root])).toBe(join(dotDir, "f.txt"));
    // …and a not-yet-existing leaf under it is accepted too.
    expect(resolveWithinAllowlist(join(dotDir, "new.txt"), [root])).toBe(join(dotDir, "new.txt"));
    // …while a genuine parent step out of root is still rejected.
    expect(() => resolveWithinAllowlist(join(root, "..", "outside", "x"), [root])).toThrow(PathGuardError);
  });

  it("uses segment-boundary matching: /a/bcd is NOT inside /a/b", () => {
    const b = join(tmp, "a", "b");
    const bcd = join(tmp, "a", "bcd");
    mkdirSync(b, { recursive: true });
    mkdirSync(bcd, { recursive: true });
    expect(() => resolveWithinAllowlist(join(bcd, "x.txt"), [b])).toThrow(PathGuardError);
    // sanity: the true child IS accepted
    expect(resolveWithinAllowlist(join(b, "x.txt"), [b])).toBe(join(b, "x.txt"));
  });

  it("maps escape to 403 and empty input to 400", () => {
    try {
      resolveWithinAllowlist(join(outside, "secret.txt"), [root]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PathGuardError);
      expect((e as PathGuardError).httpStatus).toBe(403);
    }
    try {
      resolveWithinAllowlist("   ", [root]);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as PathGuardError).httpStatus).toBe(400);
    }
  });

  it("THROWS (403) when no roots are configured", () => {
    expect(() => resolveWithinAllowlist(join(root, "sub"), [])).toThrow(PathGuardError);
  });
});

describe("isWithinAllowlistedRoot (pure audit-safety gate)", () => {
  it("true for the root itself and a segment-inside path; false otherwise", () => {
    expect(isWithinAllowlistedRoot("/tmp/root", ["/tmp/root"])).toBe(true);
    expect(isWithinAllowlistedRoot("/tmp/root/proj/sub", ["/tmp/root"])).toBe(true);
    expect(isWithinAllowlistedRoot("/etc/evil", ["/tmp/root"])).toBe(false);
    // segment-boundary: /tmp/rootX is NOT inside /tmp/root
    expect(isWithinAllowlistedRoot("/tmp/rootX", ["/tmp/root"])).toBe(false);
    // empty candidate / empty allowlist → false (fail closed; never echo)
    expect(isWithinAllowlistedRoot("", ["/tmp/root"])).toBe(false);
    expect(isWithinAllowlistedRoot("/tmp/root", [])).toBe(false);
  });
});

describe("matchedAllowlistRoot (audit logs the ENTRY, not the sub-path)", () => {
  it("returns the matching allowlist ENTRY (as configured), not the resolved sub-path", () => {
    // A deep sub-path resolves to its trusted PARENT entry — the arbitrary tail is never returned.
    expect(matchedAllowlistRoot("/tmp/root/RANDOMsub/deep/leaf", ["/tmp/root"])).toBe("/tmp/root");
    // The entry itself maps to itself.
    expect(matchedAllowlistRoot("/tmp/root", ["/tmp/root"])).toBe("/tmp/root");
    // Picks the correct entry among several.
    expect(matchedAllowlistRoot("/srv/b/x/y", ["/srv/a", "/srv/b"])).toBe("/srv/b");
  });

  it("returns undefined for a non-member, segment-boundary near-miss, or empty input", () => {
    expect(matchedAllowlistRoot("/etc/evil", ["/tmp/root"])).toBeUndefined();
    expect(matchedAllowlistRoot("/tmp/rootX/y", ["/tmp/root"])).toBeUndefined();
    expect(matchedAllowlistRoot("", ["/tmp/root"])).toBeUndefined();
    expect(matchedAllowlistRoot("/tmp/root", [])).toBeUndefined();
  });
});
