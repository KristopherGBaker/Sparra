/**
 * `conductors/http/paths.ts` — the single choke point for every path a request supplies.
 *
 * A remote caller must never be able to steer Sparra at a directory outside the configured
 * allowlist. {@link resolveWithinAllowlist} realpaths the input (defeating `..` traversal AND
 * symlink escapes) and requires the result to live inside an allowlisted root using a
 * SEGMENT-BOUNDARY prefix check. Later units call this — they never re-implement the guard.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Typed error the server maps to an HTTP status (400 malformed input, 403 outside the allowlist). */
export class PathGuardError extends Error {
  readonly httpStatus: 400 | 403;
  constructor(message: string, httpStatus: 400 | 403) {
    super(message);
    this.name = "PathGuardError";
    this.httpStatus = httpStatus;
  }
}

/**
 * Realpath `abs`, tolerating a not-yet-existing leaf: walk UP to the nearest existing ancestor,
 * realpath THAT (so a symlinked ancestor is resolved to its true location), then rejoin the
 * remaining not-yet-existing segments. This keeps the symlink defense intact even for paths whose
 * final component doesn't exist yet (e.g. an output file a later unit will create).
 */
function realpathNearestExisting(abs: string): string {
  let current = abs;
  const trailing: string[] = [];
  // dirname() is a fixed point at the filesystem root, so this loop always terminates.
  for (;;) {
    try {
      const real = realpathSync(current);
      if (trailing.length === 0) return real;
      return resolve(real, ...trailing.slice().reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        // Reached the root and nothing along the way exists — treat as unresolvable.
        throw new PathGuardError(`cannot resolve path "${abs}"`, 400);
      }
      trailing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * True when `child` is `parent` itself or lives strictly inside it, at a SEGMENT boundary.
 *
 * Using `path.relative` (rather than a raw string prefix) is what makes `/a/bcd` NOT count as inside
 * `/a/b`: `relative("/a/b", "/a/bcd")` is `"../bcd"` — a real traversal — and is rejected. But the
 * check must be SEGMENT-aware, not a blanket `startsWith("..")`: a legitimately in-root directory
 * whose NAME merely begins with `..` (e.g. `..safe`) yields a relative path like `"..safe"` and MUST
 * be accepted. So `child` is inside `parent` iff the relative path is `''` (the root itself) or it is
 * not exactly `..`, does not start with `".." + sep` (an actual parent-directory step), and is not
 * absolute (a different drive/root).
 */
function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

/**
 * PURE, fs-free lookup: return the ALLOWLIST ENTRY (the operator-configured `roots[i]`, as written)
 * that `candidate` is equal to or segment-inside — or `undefined` if none.
 *
 * The AUDIT logger uses this to record WHICH allowlisted project an action targeted: it logs the
 * matched trusted PARENT entry, NOT the full resolved request path. The portion of the path BELOW the
 * entry is where arbitrary request-derived text lives, so it must never reach the audit line; the
 * allowlist entries themselves are trusted operator config and safe to log. This is NOT a file-access
 * decision (that's {@link resolveWithinAllowlist}, which realpaths) — just a cheap parent lookup.
 */
export function matchedAllowlistRoot(candidate: string, roots: string[]): string | undefined {
  if (typeof candidate !== "string" || candidate.length === 0) return undefined;
  const target = resolve(candidate);
  for (const root of roots) {
    if (isWithin(target, resolve(root))) return root;
  }
  return undefined;
}

/**
 * PURE, fs-free check: is `candidate` equal to or segment-inside any of the allowlisted `roots`?
 * Thin boolean wrapper over {@link matchedAllowlistRoot}.
 */
export function isWithinAllowlistedRoot(candidate: string, roots: string[]): boolean {
  return matchedAllowlistRoot(candidate, roots) !== undefined;
}

/**
 * Resolve `inputPath` to an absolute realpath and require it to be inside one of `roots`.
 *
 * Throws {@link PathGuardError}(400) for an empty/unresolvable input, and (403) when the resolved
 * path escapes every allowlisted root — including via `..` traversal, a symlink that points outside
 * a root, or a not-yet-existing leaf under a root that ultimately resolves outside.
 */
export function resolveWithinAllowlist(inputPath: string, roots: string[]): string {
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    throw new PathGuardError("empty path", 400);
  }
  if (roots.length === 0) {
    // No allowlist means nothing is permitted — fail closed rather than allowing everything.
    throw new PathGuardError("no allowlisted roots configured", 403);
  }

  // `resolve` normalizes `..`/`.` up front, so traversal segments are collapsed before we realpath.
  const abs = resolve(inputPath);
  const real = realpathNearestExisting(abs);

  const realRoots = roots.map((root) => {
    const absRoot = resolve(root);
    try {
      return realpathSync(absRoot);
    } catch {
      // A configured root that doesn't currently exist can't contain anything; keep its normalized
      // form so it simply never matches rather than throwing here.
      return absRoot;
    }
  });

  for (const root of realRoots) {
    if (isWithin(real, root)) return real;
  }
  throw new PathGuardError(`path "${inputPath}" is not within any allowlisted root`, 403);
}
