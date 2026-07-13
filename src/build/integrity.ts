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
}

export interface SourceSnapshot {
  files: Map<string /*relpath*/, Buffer /*bytes*/>;
}

/**
 * Built-in exclusion for well-known compiler/module-cache relpaths. These are the evaluator's OWN
 * build-cache writes (a legit `swift build` emits `.swiftpm-home/.cache/clang/ModuleCache/…`,
 * `.build/…`, DerivedData/…) — NOT edits to the graded artifact source — so the guard must ignore
 * them regardless of whether the project's `.gitignore` happens to cover them. Match semantics:
 *   - `.cache/clang/ModuleCache` as ANY path segment run (matches `**​/.cache/clang/ModuleCache/**`);
 *   - `.build` as ANY path segment (matches `**​/.build/**` and a leading `.build/`);
 *   - `DerivedData` as ANY path segment (matches `**​/DerivedData/**`);
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
  for (const rel of artifactSurface(workspace, deps)) {
    const content = deps.readFile(path.resolve(workspace, rel));
    if (content !== null) files.set(rel, content);
  }
  return { files };
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

  // Remove any non-ignored file the evaluator injected (present now, absent from the snapshot).
  for (const rel of current) {
    if (!before.files.has(rel)) {
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
