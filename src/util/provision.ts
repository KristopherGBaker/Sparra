import { spawnSync } from "node:child_process";
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
