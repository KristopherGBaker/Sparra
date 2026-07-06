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

/** Injectable seams (fs probes + exec + host platform), mirroring git.ts's `git()` runner seam. */
export interface ProvisionDeps {
  exists?: (p: string) => boolean;
  isSymlink?: (p: string) => boolean;
  run?: (argv: string[]) => { ok: boolean; out: string };
  platform?: NodeJS.Platform | string;
}

export interface ProvisionSummary {
  copied: string[];
  skipped: string[];
  failed: string[];
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
  const summary: ProvisionSummary = { copied: [], skipped: [], failed: [] };
  if (workspaceDir === root || !cfg.enabled) return summary;

  const fsd: ProvisionFs = { exists: deps.exists ?? exists, isSymlink: deps.isSymlink ?? isSymlink };
  const run = deps.run ?? copyRun;
  const platform = deps.platform ?? os.platform();

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
