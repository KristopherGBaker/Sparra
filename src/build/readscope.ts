import path from "node:path";
import os from "node:os";
import type { Ctx } from "../context.ts";

/** Expand a leading `~` to the home dir. */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Directories the build (generator + evaluator) may read, as `additionalDirectories`:
 * the repo root (when building on a separate worktree) plus any `build.extraReadDirs`
 * (absolute, `~`-prefixed, or repo-root-relative). Deduped; the work dir itself is omitted
 * (it's the cwd, already accessible). Returns `undefined` when there's nothing to add.
 */
export function buildReadDirs(ctx: Ctx, workspaceDir: string): string[] | undefined {
  const dirs: string[] = [];
  if (workspaceDir !== ctx.root) dirs.push(ctx.root);
  for (const raw of ctx.config.build.extraReadDirs ?? []) {
    if (!raw || !raw.trim()) continue;
    const expanded = expandHome(raw.trim());
    dirs.push(path.isAbsolute(expanded) ? expanded : path.resolve(ctx.root, expanded));
  }
  const deduped = [...new Set(dirs)].filter((d) => d !== workspaceDir);
  return deduped.length ? deduped : undefined;
}
