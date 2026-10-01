import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exists, isSymlink } from "./io.ts";
import { detail, warn } from "./log.ts";

/** Filesystem probes used by `depsToProvision` — injected so tests make no real fs calls. */
export interface ProvisionFs {
  exists: (p: string) => boolean;
  isSymlink: (p: string) => boolean;
}

/**
 * Decide which configured dep dirs to copy into the build/eval worktree, and which to skip.
 * A dir is COPIED when `root/<dir>` EXISTS and is NOT a symlink AND `workspaceDir/<dir>` is ABSENT.
 * A SYMLINKED `root/<dir>` (pnpm/monorepo hoist) is SKIPPED — never copied — because copying the
 * link target, or worse linking back out of the worktree, breaks the workspace-write scratch
 * boundary (the cycle-1 EPERM trap). An absent-in-root dir, or one already present in the
 * worktree, is simply excluded. Per-dir independent — handles a mix of states in one call.
 */
export function depsToProvision(
  root: string,
  workspaceDir: string,
  dirs: string[],
  fsd: ProvisionFs
): { copy: string[]; skipped: string[] } {
  const copy: string[] = [];
  const skipped: string[] = [];
  for (const dir of dirs) {
    const src = path.join(root, dir);
    if (!fsd.exists(src)) continue; // nothing to copy from
    if (fsd.isSymlink(src)) {
      skipped.push(dir); // symlinked hoist — copying it would point outside the worktree
      continue;
    }
    if (fsd.exists(path.join(workspaceDir, dir))) continue; // already provisioned
    copy.push(dir);
  }
  return { copy, skipped };
}

/**
 * Build the argv for a recursive COPY of `src`→`dst`, preferring a copy-on-write clone where the
 * platform supports it (cheap + space-efficient for a big node_modules):
 *   darwin ⇒ `cp -c -R`            (APFS clonefile)
 *   linux  ⇒ `cp -R --reflink=auto` (reflink where the FS supports it, else a normal copy)
 *   else   ⇒ `cp -R`               (plain recursive copy)
 * NEVER a symlink (`ln -s`) — an outside-pointing link breaks the workspace-write scratch boundary.
 * `platform` is a PARAMETER so the choice is deterministically unit-testable on single-OS CI.
 */
export function pickCopyCmd(platform: NodeJS.Platform | string, src: string, dst: string): string[] {
  if (platform === "darwin") return ["cp", "-c", "-R", src, dst];
  if (platform === "linux") return ["cp", "-R", "--reflink=auto", src, dst];
  return ["cp", "-R", src, dst];
}

/**
 * Directory names whose CONTENTS are bound to the ABSOLUTE PATH they were built at, so a copy of
 * them into a new location is not merely stale — it is actively WRONG.
 *
 * `provisionWorkspaceDeps` copies configured dep dirs wholesale so an offline worktree can build.
 * For a SwiftPM package that dir is `.build`, and `.build/<triple>/debug/ModuleCache` holds
 * precompiled `.pcm` modules carrying absolute paths from wherever they were built. In the worktree
 * they resolve to nothing and the build dies on:
 *
 *     <unknown>:0: error: missing required module 'SwiftShims'
 *     error: emit-module command failed with exit code 1
 *
 * Observed twice independently — once in a unit worktree (cleared by deleting ONLY the ModuleCache)
 * and once by a contract-evaluator judging `make verify` unrunnable as written in a provisioned
 * worktree. It also presents as a lie: lint runs first and passes over ~190 files, so the log reads
 * "clean lint, then a module error", which looks like the generator broke the source.
 *
 * The correct action is CACHE-ONLY. Deleting `.build` itself would destroy the dependency checkout
 * the prewarm fetched while the network was still available — unrecoverable offline.
 */
export const PATH_BOUND_CACHE_DIRS = ["ModuleCache", "ModuleCache.noindex"];

/** Directory names never worth descending into when hunting for a path-bound cache (they are huge
 *  and hold none). Keeps the post-copy walk cheap on a `node_modules`-sized tree. */
const PRUNE_WALK_SKIP = new Set(["node_modules", ".git"]);

/** How deep to look. `.build/<triple>/debug/ModuleCache` is depth 4; DerivedData's is similar. */
const PRUNE_WALK_MAX_DEPTH = 6;

/** Filesystem seam for the post-copy prune — injected so the unit tests touch no real disk. */
export interface PruneFs {
  /** Sub-DIRECTORY names of `dir` (not files; [] when unreadable). */
  readdirDirs: (dir: string) => string[];
  /** Remove a directory recursively. */
  remove: (dir: string) => void;
}

/**
 * Find the path-bound cache dirs under `root` (bounded walk; never descends INTO a match, nor into
 * `node_modules`/`.git`). Pure w.r.t. the injected fs — returns absolute paths, removes nothing.
 */
export function pathBoundCacheDirs(root: string, fsd: PruneFs, maxDepth: number = PRUNE_WALK_MAX_DEPTH): string[] {
  // The skip set applies to the walk ROOT too: provisioning's common case is a `node_modules` with
  // tens of thousands of directories and no path-bound cache anywhere in it, and walking it would
  // cost more than the prune can ever save.
  if (PRUNE_WALK_SKIP.has(path.basename(root))) return [];
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    for (const name of fsd.readdirDirs(dir)) {
      const abs = path.join(dir, name);
      if (PATH_BOUND_CACHE_DIRS.includes(name)) {
        found.push(abs); // a match is the leaf — its contents are exactly what we're discarding
        continue;
      }
      if (PRUNE_WALK_SKIP.has(name)) continue;
      walk(abs, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/** Remove every path-bound cache under `root`, returning what was removed (absolute paths). */
export function prunePathBoundCaches(root: string, fsd: PruneFs): string[] {
  const dirs = pathBoundCacheDirs(root, fsd);
  for (const dir of dirs) fsd.remove(dir);
  return dirs;
}

/** Default (real) prune seam. Both probes are best-effort: an unreadable dir yields no children,
 *  and a failed removal is not worth aborting provisioning over. */
function realPruneFs(): PruneFs {
  return {
    readdirDirs: (dir) => {
      try {
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.isSymbolicLink())
          .map((e) => e.name);
      } catch {
        return [];
      }
    },
    remove: (dir) => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

/** Injectable seams (fs probes + exec + host platform), mirroring git.ts's `git()` runner seam. */
export interface ProvisionDeps {
  exists?: (p: string) => boolean;
  isSymlink?: (p: string) => boolean;
  run?: (argv: string[]) => { ok: boolean; out: string };
  platform?: NodeJS.Platform | string;
  /** Post-copy prune seam (see `prunePathBoundCaches`); defaults to the real fs. */
  pruneFs?: PruneFs;
  /** Post-copy Node-package scan seam (see `unprovisionedNodePackages`); defaults to the real fs. */
  nodeScanFs?: NodeScanFs;
}

export interface ProvisionSummary {
  copied: string[];
  skipped: string[];
  failed: string[];
  /** Path-bound caches discarded from the COPIES (never from the source) — see
   *  `PATH_BOUND_CACHE_DIRS`. Relative to the worktree, for a readable log/summary. */
  pruned: string[];
  /** Node package dirs (worktree-relative, `.` for the root) that declare dependencies but still have
   *  no `node_modules` after provisioning — see `unprovisionedNodePackages`. */
  unprovisioned: string[];
}

/** Filesystem probes for `unprovisionedNodePackages` — injected so tests can fake a tree. */
export interface NodeScanFs {
  /** Subdirectory names of `dir` (empty when unreadable). */
  listDirs: (dir: string) => string[];
  /** File text, or `null` when absent/unreadable. */
  readFile: (file: string) => string | null;
  exists: (p: string) => boolean;
}

function realNodeScanFs(): NodeScanFs {
  return {
    listDirs: (dir) => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        return [];
      }
    },
    readFile: (file) => {
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return null;
      }
    },
    exists,
  };
}

/** Whether a `package.json` text declares at least one dependency or devDependency. */
function declaresDeps(pkgText: string): boolean {
  try {
    const pkg = JSON.parse(pkgText) as { dependencies?: unknown; devDependencies?: unknown };
    const nonEmpty = (v: unknown) => !!v && typeof v === "object" && Object.keys(v as object).length > 0;
    return nonEmpty(pkg.dependencies) || nonEmpty(pkg.devDependencies);
  } catch {
    return false;
  }
}

/**
 * Node package dirs in `workspaceDir` — the root and up to two levels below it, skipping hidden dirs
 * and `node_modules` — whose `package.json` declares dependencies but which have no `node_modules`.
 * Returned worktree-relative (`.` for the root), in walk order.
 *
 * A judge's sandbox has the network off, so such a package cannot install its deps there: its
 * `tsc`/`vitest`/`eslint` exit 127 or `npm install --offline` fails with ENOTCACHED, and every gate
 * that needs them comes back UN-RUN. A monorepo whose deps live in `dashboard/node_modules` while
 * `git.provisionDeps.dirs` lists only `node_modules` hits exactly this.
 */
export function unprovisionedNodePackages(workspaceDir: string, fsd: NodeScanFs = realNodeScanFs()): string[] {
  const missing: string[] = [];
  const visit = (rel: string, depth: number) => {
    const dir = path.join(workspaceDir, rel);
    const pkg = fsd.readFile(path.join(dir, "package.json"));
    if (pkg !== null && declaresDeps(pkg) && !fsd.exists(path.join(dir, "node_modules"))) missing.push(rel || ".");
    if (depth <= 0) return;
    for (const name of fsd.listDirs(dir)) {
      if (name.startsWith(".") || name === "node_modules") continue;
      visit(rel ? path.join(rel, name) : name, depth - 1);
    }
  };
  visit("", 2);
  return missing;
}

/**
 * The provisioning warning for `unprovisionedNodePackages`' result (`undefined` when none are
 * missing). Each dir gets its remedy: a `node_modules` that exists in the main checkout can be copied
 * by listing it in `git.provisionDeps.dirs`; one that doesn't must be installed there first.
 */
export function unprovisionedWarning(missing: string[], root: string, existsFn: (p: string) => boolean = exists): string | undefined {
  if (!missing.length) return undefined;
  const lines = missing.map((rel) => {
    const nm = rel === "." ? "node_modules" : path.join(rel, "node_modules");
    return existsFn(path.join(root, nm))
      ? `  - ${rel}: add \`${nm}\` to git.provisionDeps.dirs`
      : `  - ${rel}: no ${nm} in the main checkout either — install its dependencies there first`;
  });
  return (
    `provision: ${missing.length} Node package(s) in the worktree declare dependencies but have no ` +
    `node_modules, so a sandboxed judge (network off) cannot run their tools and those gates will come ` +
    `back UN-RUN:\n${lines.join("\n")}`
  );
}

/** Default copy runner: spawn the argv (no shell), reporting ok/out like git.ts's `git()`. */
function copyRun(argv: string[]): { ok: boolean; out: string } {
  const [cmd, ...args] = argv;
  const r = spawnSync(cmd!, args, { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

/**
 * Provision the repo's dependency dirs (default `node_modules`) into the build/eval worktree so the
 * generator's verify commands and the evaluator's `npm test` can actually run there.
 *
 * NO-OP when `workspaceDir === root` (an in-place run already has the deps) or `!cfg.enabled`. Else
 * COPY each eligible dir via `pickCopyCmd` (copy-on-write clone where supported) — never a symlink,
 * so nothing points outside the worktree. A symlinked `root/<dir>` is warned + SKIPPED. A copy
 * failure is NON-FATAL: it is warned + recorded in `failed`, and provisioning continues — this never
 * throws, so a provisioning hiccup can't abort the build.
 */
export function provisionWorkspaceDeps(
  root: string,
  workspaceDir: string,
  cfg: { enabled: boolean; dirs: string[] },
  deps: ProvisionDeps = {}
): ProvisionSummary {
  const summary: ProvisionSummary = { copied: [], skipped: [], failed: [], pruned: [], unprovisioned: [] };
  if (workspaceDir === root || !cfg.enabled) return summary;

  const fsd: ProvisionFs = { exists: deps.exists ?? exists, isSymlink: deps.isSymlink ?? isSymlink };
  const run = deps.run ?? copyRun;
  const platform = deps.platform ?? os.platform();
  const pruneFs = deps.pruneFs ?? realPruneFs();

  const { copy, skipped } = depsToProvision(root, workspaceDir, cfg.dirs, fsd);
  for (const dir of skipped) {
    warn(`provision: ${dir} in ${root} is a symlink — skipping (won't link outside the worktree).`);
    summary.skipped.push(dir);
  }
  for (const dir of copy) {
    const src = path.join(root, dir);
    const dst = path.join(workspaceDir, dir);
    try {
      const r = run(pickCopyCmd(platform, src, dst));
      if (r.ok) {
        detail(`provision: copied ${dir} into the worktree.`);
        summary.copied.push(dir);
        // A copied module cache is bound to the path it was built at, so it poisons the very build
        // this copy exists to enable (see PATH_BOUND_CACHE_DIRS). Discard it from the COPY only —
        // the dependency checkout beside it cannot be re-fetched offline.
        const pruned = prunePathBoundCaches(dst, pruneFs).map((p) => path.relative(workspaceDir, p));
        if (pruned.length) {
          detail(`provision: discarded ${pruned.length} path-bound module cache(s) from ${dir}: ${pruned.join(", ")}.`);
          summary.pruned.push(...pruned);
        }
      } else {
        warn(`provision: copy of ${dir} into the worktree failed (non-fatal): ${r.out.trim()}`);
        summary.failed.push(dir);
      }
    } catch (e) {
      // Non-fatal: a copy hiccup must never abort the build — the verify/eval step will just warn.
      warn(`provision: copy of ${dir} into the worktree failed (non-fatal): ${(e as Error).message}`);
      summary.failed.push(dir);
    }
  }
  summary.unprovisioned = unprovisionedNodePackages(workspaceDir, deps.nodeScanFs);
  const missingWarning = unprovisionedWarning(summary.unprovisioned, root, fsd.exists);
  if (missingWarning) warn(missingWarning);
  return summary;
}

// ── Durable, WORKTREE-LOCAL SwiftPM dependency cache ─────────────────────────────────────────────
//
// The clang ModuleCache / TMPDIR scratch a build session redirects is REGENERABLE (a fresh
// per-session temp is fine). The SwiftPM DEPENDENCY cache is NOT: it holds the resolved+fetched
// package state a `swift package resolve` produced while the network was still available (at
// provisioning time). So it must PERSIST across the worktree's sessions — the prewarm writes it and
// a later OFFLINE `swift build` in the same worktree reuses it. This derives a STABLE path keyed on
// the worktree location (NOT a fresh per-run temp), placed under `baseDir` (os.tmpdir() default) —
// never under the workspace, which would put it on the graded-artifact surface and risk the UDS
// sun_path length limit the judge scratch guards.

/** The durable SwiftPM cache path for a worktree — deterministic from the workspace path, so the
 *  provisioning-time prewarm and every later build session of the SAME worktree share ONE cache. */
export function swiftpmCacheDir(workspaceDir: string, baseDir: string = os.tmpdir()): string {
  const key = createHash("sha1").update(path.resolve(workspaceDir)).digest("hex").slice(0, 16);
  return path.join(baseDir, "sparra-swiftpm", key);
}

/** Ensure the durable SwiftPM cache dir exists on disk and return it (idempotent). */
export function ensureSwiftpmCacheDir(workspaceDir: string, baseDir: string = os.tmpdir()): string {
  const dir = swiftpmCacheDir(workspaceDir, baseDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Injectable seams for the SwiftPM dep-prewarm (fs probe + exec), mirroring `ProvisionDeps`. */
export interface SwiftPrewarmDeps {
  exists?: (p: string) => boolean;
  run?: (argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => { ok: boolean; out: string };
  /** Override the durable cache location (tests point it at a temp base). */
  cacheDirFn?: (workspaceDir: string) => string;
}

export interface SwiftPrewarmResult {
  /** True when the prewarm command was actually invoked. */
  ran: boolean;
  /** True when the invoked command exited 0. */
  ok: boolean;
  /** Why the prewarm was a no-op (when `ran` is false). */
  skipped?: "disabled" | "in-place" | "not-a-swift-package";
  /** The durable cache the prewarm targeted (present whenever it ran). */
  cacheDir?: string;
  out?: string;
}

/** Default prewarm runner: spawn the argv (no shell) in `cwd` with `env`, reporting ok/out. */
function swiftResolveRun(
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
): { ok: boolean; out: string } {
  const [cmd, ...args] = argv;
  const r = spawnSync(cmd!, args, { cwd: opts.cwd, env: opts.env, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

/**
 * Prewarm a SwiftPM package's dependencies into the durable worktree-local cache DURING worktree
 * provisioning, while the network is still available — so a later OFFLINE `swift build` in the
 * throwaway worktree reuses the resolved state instead of failing to resolve GRDB & friends.
 *
 * A NO-OP (never spawns `swift`) when: the `swiftPackages` knob is off; the run is in-place
 * (`workspaceDir === root` already has resolved deps); or the source tree is NOT a SwiftPM package
 * (`root/Package.swift` absent). Otherwise it runs a `swift package resolve` against the durable
 * cache from `swiftpmCacheDir`, in the worktree cwd, with `SWIFTPM_CACHE_DIR` pointed there too.
 *
 * Failures are NON-FATAL and logged (mirrors `provisionWorkspaceDeps`): a prewarm hiccup — a broken
 * toolchain, a network blip, a resolve error — must never abort provisioning, so this never throws.
 */
export function prewarmSwiftPackages(
  root: string,
  workspaceDir: string,
  cfg: { swiftPackages: boolean },
  deps: SwiftPrewarmDeps = {}
): SwiftPrewarmResult {
  if (!cfg.swiftPackages) return { ran: false, ok: false, skipped: "disabled" };
  if (workspaceDir === root) return { ran: false, ok: false, skipped: "in-place" };
  const fsExists = deps.exists ?? exists;
  if (!fsExists(path.join(root, "Package.swift"))) return { ran: false, ok: false, skipped: "not-a-swift-package" };

  const cacheDir = (deps.cacheDirFn ?? ensureSwiftpmCacheDir)(workspaceDir);
  const run = deps.run ?? swiftResolveRun;
  const argv = ["swift", "package", "resolve", "--cache-path", cacheDir];
  try {
    const r = run(argv, { cwd: workspaceDir, env: { ...process.env, SWIFTPM_CACHE_DIR: cacheDir } });
    if (r.ok) detail(`prewarm: resolved SwiftPM dependencies into the durable cache (${cacheDir}).`);
    else warn(`prewarm: swift package resolve failed (non-fatal): ${r.out.trim()}`);
    return { ran: true, ok: r.ok, cacheDir, out: r.out };
  } catch (e) {
    // Non-fatal: a prewarm hiccup must never abort provisioning — the eval step will just warn.
    warn(`prewarm: swift package resolve threw (non-fatal): ${(e as Error).message}`);
    return { ran: true, ok: false, cacheDir, out: (e as Error).message };
  }
}
