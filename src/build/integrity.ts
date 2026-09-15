import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Source-integrity guard for the EXERCISING evaluator. When the Codex evaluator runs under
 * `workspace-write` (so test/build tools can write the scratch they need — node_modules/.vite-temp,
 * tsc/test caches), the OS sandbox can no longer stop it writing the artifact source it grades.
 * This guard restores that boundary at the runner level: snapshot the artifact surface before the
 * exercise, then after it detect + REVERT any write the evaluator made to that surface and report
 * the mutated paths (the runner fails the verdict on a non-empty result).
 *
 * The protected set is the ARTIFACT SURFACE — tracked files + new non-ignored files
 * (`git ls-files --cached --others --exclude-standard`) — which EXCLUDES gitignored scratch
 * (node_modules, .vite-temp, coverage, build output). So test/build scratch is left untouched
 * while real source mutations are reverted.
 *
 * Pure + dependency-injected so the unit tests need no real git/fs.
 */

export interface IntegrityDeps {
  /** List the artifact surface relative to the workspace: tracked + new non-ignored files.
   *  Real impl: `git -C <ws> ls-files --cached --others --exclude-standard`. */
  listArtifactFiles: (workspace: string) => string[];
  /** Read a file's raw BYTES, or null if it doesn't exist. Bytes (not strings) so restore is
   *  byte-exact even for binary/non-UTF-8 artifact files (e.g. an iOS image asset). */
  readFile: (absPath: string) => Buffer | null;
  /** Write bytes back (restore). */
  writeFile: (absPath: string, content: Buffer) => void;
  /** Delete a file (remove an evaluator-injected file). */
  removeFile: (absPath: string) => void;
  /** Whether `absPath` is a symlink (lstat, no follow). Optional so in-memory unit fakes need not
   *  supply it — absent ⇒ treated as "not a symlink" (unchanged non-symlink behavior). Used to
   *  classify a symlinked top-level `node_modules` as scratch. Real impl: `fs.lstatSync(...).isSymbolicLink()`. */
  isSymlink?: (absPath: string) => boolean;
  /** Read a symlink's TARGET, or null if it isn't a symlink / doesn't exist. Optional for the same
   *  reason as `isSymlink`. Real impl: `fs.readlinkSync(...)`. */
  readLink?: (absPath: string) => string | null;
  /** Recreate a symlink pointing at `target` (restore). Real impl: unlink-then-`fs.symlinkSync`. */
  writeLink?: (absPath: string, target: string) => void;
}

export interface SourceSnapshot {
  files: Map<string /*relpath*/, Buffer /*bytes*/>;
  /** TRACKED symlinks, snapshotted by link TARGET rather than by content.
   *
   *  A symlink has no readable bytes of its own: `readFile` FOLLOWS it, so a symlink-to-directory
   *  yields EISDIR → null → it never enters `files`. Enforce would then see a path git lists but the
   *  snapshot lacks, classify it as evaluator-injected, and DELETE it — destroying a tracked symlink
   *  on every exercise and reporting that destruction as "(reverted)". Snapshotting the target keeps
   *  the integrity guarantee (tampering is still detected and undone) without the guard itself being
   *  the thing that mutates the artifact surface.
   *
   *  Optional so a snapshot built by an in-memory fake without link deps still type-checks. */
  links?: Map<string /*relpath*/, string /*link target*/>;
}

/**
 * A DIRECTORY segment that names Xcode/SwiftPM BUILD OUTPUT rather than graded source.
 *
 * Exact-name matching was not enough. A judge told to build into a "repo-local derived-data dir"
 * picks its own name — observed in the field: `.derivedData-load`, which the project's `.gitignore`
 * (covering `.derivedData/`) did not match either, so git listed **7,664** compiler intermediates as
 * untracked and the guard reported a 93.0/80 verdict with zero failed assertions as an integrity
 * FAILURE. The paths were all `<dd>/Build/Intermediates.noindex/GRDB.build/…` — output of running
 * the very gates the contract demanded.
 *
 * So the families, not the literals:
 *   - a derived-data root: `DerivedData`, `.derivedData`, `derived-data`, `.derivedData-load`,
 *     `DerivedData_ci` — i.e. `derived[-_]?data` optionally followed by a `-`/`_`/`.` suffix;
 *   - an Xcode per-target intermediates dir: anything ending `.build` (`GRDB.build`, `App.build`);
 *   - an Xcode non-indexed build dir: anything ending `.noindex` (`Intermediates.noindex`).
 *
 * Judged on a DIRECTORY segment only — never the final (filename) segment — so a documentation file
 * named `DerivedDataNotes.md` stays on the protected artifact surface.
 */
export function isBuildOutputDirSegment(seg: string): boolean {
  const s = seg.replace(/^\./, "").toLowerCase();
  return /^derived[-_]?data([-_.].*)?$/.test(s) || s.endsWith(".build") || s.endsWith(".noindex");
}

/**
 * Built-in exclusion for well-known compiler/module-cache relpaths. These are the evaluator's OWN
 * build-cache writes (a legit `swift build` emits `.swiftpm-home/.cache/clang/ModuleCache/…`,
 * `.build/…`, DerivedData/…) — NOT edits to the graded artifact source — so the guard must ignore
 * them regardless of whether the project's `.gitignore` happens to cover them. Match semantics:
 *   - `.cache/clang/ModuleCache` as ANY path segment run (matches `**​/.cache/clang/ModuleCache/**`);
 *   - `.build` as ANY path segment (matches `**​/.build/**` and a leading `.build/`);
 *   - `DerivedData` as ANY path segment (matches `**​/DerivedData/**`);
 *   - any `isBuildOutputDirSegment` DIRECTORY segment — the derived-data / `*.build` / `*.noindex`
 *     families above, so a judge's own choice of derived-data name is covered too;
 *   - a leading `.swiftpm-home/` prefix;
 *   - `.claude/skills` as ANY consecutive segment run (matches `**​/.claude/skills/**`) — tool-generated
 *     skill scratch (e.g. `.claude/skills/aseprite`) written during exercise. Only the `skills`
 *     sub-dir is whitelisted, NOT all of `.claude/` — `.claude/settings.json` is still on the surface.
 * Separators are normalized so it works on the forward-slash relpaths git emits (and Windows `\`).
 */
export function isBuildCachePath(rel: string): boolean {
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  const segs = norm.split("/");
  if (norm.startsWith(".swiftpm-home/")) return true;
  if (segs.includes(".build") || segs.includes("DerivedData")) return true;
  // Build-output DIRECTORY segments (never the filename): a derived-data root under any name, an
  // Xcode `*.build` intermediates dir, a `*.noindex` build dir.
  for (let i = 0; i + 1 < segs.length; i++) {
    if (isBuildOutputDirSegment(segs[i]!)) return true;
  }
  // `.cache/clang/ModuleCache` as a consecutive segment run.
  for (let i = 0; i + 2 < segs.length; i++) {
    if (segs[i] === ".cache" && segs[i + 1] === "clang" && segs[i + 2] === "ModuleCache") return true;
  }
  // `.claude/skills` as a consecutive segment run — tool-generated skills scratch only.
  for (let i = 0; i + 1 < segs.length; i++) {
    if (segs[i] === ".claude" && segs[i + 1] === "skills") return true;
  }
  return false;
}

/**
 * A top-level `node_modules` that is a SYMLINK is a dependency dir (scratch), not artifact source.
 * `.gitignore`'s `node_modules/` (dir-ONLY) pattern doesn't match a symlink, so `git ls-files --others
 * --exclude-standard` surfaces the symlink as an untracked entry. Left unclassified, snapshot can't read
 * it (a symlink-to-dir yields EISDIR → null → not snapshotted) and enforce then treats it as an
 * evaluator-injected artifact → deletes the symlink and false-flags an integrity violation. Resolve it
 * via lstat and exclude it as scratch, applied SYMMETRICALLY in snapshot + enforce.
 *
 * Deliberately narrow: ONLY the exact top-level `node_modules` name is classified this way — an
 * arbitrary symlink (or a differently-named untracked file) is still on the artifact surface, so the
 * guard does NOT blanket-ignore symlinks/untracked files.
 */
export function isScratchDepSymlink(rel: string, workspace: string, deps: IntegrityDeps): boolean {
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (norm !== "node_modules") return false;
  return deps.isSymlink?.(path.resolve(workspace, rel)) ?? false;
}

/** The artifact surface minus build-cache paths + scratch dep symlinks (applied identically in
 *  snapshot + enforce). */
function artifactSurface(workspace: string, deps: IntegrityDeps): string[] {
  return deps
    .listArtifactFiles(workspace)
    .filter((rel) => !isBuildCachePath(rel) && !isScratchDepSymlink(rel, workspace, deps));
}

/** Capture the artifact surface before an exercise that may write. */
export function snapshotArtifact(workspace: string, deps: IntegrityDeps): SourceSnapshot {
  const files = new Map<string, Buffer>();
  const links = new Map<string, string>();
  for (const rel of artifactSurface(workspace, deps)) {
    const abs = path.resolve(workspace, rel);
    // Symlinks first: `readFile` follows the link, so a symlink-to-dir would read as EISDIR → null
    // and silently fall out of the snapshot. Record the target instead.
    if (deps.isSymlink?.(abs)) {
      const target = deps.readLink?.(abs) ?? null;
      if (target !== null) {
        links.set(rel, target);
        continue;
      }
    }
    const content = deps.readFile(abs);
    if (content !== null) files.set(rel, content);
  }
  return { files, links };
}

/** After the exercise: detect + REVERT any change to the artifact surface (modified content,
 *  deleted file, or newly-injected non-ignored file). Returns the sorted list of relpaths that
 *  were mutated (empty = clean). The runner treats a non-empty result as an integrity violation. */
export function enforceArtifactIntegrity(workspace: string, before: SourceSnapshot, deps: IntegrityDeps): string[] {
  const mutated = new Set<string>();
  const current = new Set(artifactSurface(workspace, deps));

  // Restore anything in the snapshot that changed or vanished (byte-exact comparison).
  for (const [rel, content] of before.files) {
    const abs = path.resolve(workspace, rel);
    const now = deps.readFile(abs);
    if (now === null || !now.equals(content)) {
      deps.writeFile(abs, content); // recreate (missing) or revert (modified)
      mutated.add(rel);
    }
  }

  // Restore any snapshotted SYMLINK whose target changed or which vanished. Compared by target,
  // not bytes — see `SourceSnapshot.links`.
  const links = before.links ?? new Map<string, string>();
  for (const [rel, target] of links) {
    const abs = path.resolve(workspace, rel);
    const now = deps.isSymlink?.(abs) ? (deps.readLink?.(abs) ?? null) : null;
    if (now !== target) {
      deps.writeLink?.(abs, target); // recreate (missing/replaced) or repoint (retargeted)
      mutated.add(rel);
    }
  }

  // Remove any non-ignored file the evaluator injected (present now, absent from the snapshot).
  // A path snapshotted as a symlink is NOT injected — without this exemption the guard deletes
  // every tracked symlink on the surface, which is exactly the bug the `links` map exists to fix.
  for (const rel of current) {
    if (!before.files.has(rel) && !links.has(rel)) {
      deps.removeFile(path.resolve(workspace, rel));
      mutated.add(rel);
    }
  }

  return [...mutated].sort();
}

/** Wire the real git/fs. Resilient: if `git` fails (not a git tree), the lister returns [] and the
 *  guard becomes a no-op — acceptable because the guard is only ENABLED on a branch boundary. */
export function realIntegrityDeps(): IntegrityDeps {
  return {
    listArtifactFiles: (workspace) => {
      try {
        const out = execFileSync("git", ["-C", workspace, "ls-files", "--cached", "--others", "--exclude-standard"], {
          encoding: "utf8",
        });
        return out.split("\n").filter((l) => l.length > 0);
      } catch {
        return [];
      }
    },
    readFile: (absPath) => {
      try {
        return fs.readFileSync(absPath); // raw Buffer — byte-exact, no encoding
      } catch {
        return null;
      }
    },
    isSymlink: (absPath) => {
      try {
        return fs.lstatSync(absPath).isSymbolicLink(); // lstat: don't follow, so a dep symlink is detected
      } catch {
        return false;
      }
    },
    readLink: (absPath) => {
      try {
        return fs.readlinkSync(absPath); // the link's own target — never follows to the destination
      } catch {
        return null;
      }
    },
    writeLink: (absPath, target) => {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      // Clear whatever is in the way first: symlinkSync fails EEXIST, and the evaluator may have
      // replaced the link with a regular file or a real directory.
      try {
        fs.rmSync(absPath, { force: true, recursive: true });
      } catch {
        // best-effort; the symlinkSync below surfaces a genuine failure
      }
      fs.symlinkSync(target, absPath);
    },
    writeFile: (absPath, content) => {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content);
    },
    removeFile: (absPath) => {
      try {
        fs.rmSync(absPath, { force: true });
      } catch {
        // best-effort: a removal failure is reported via the mutated list regardless.
      }
    },
  };
}
