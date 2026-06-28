import path from "node:path";
import os from "node:os";
import type { Ctx } from "../context.ts";
import { within } from "../sdk/scoping.ts";

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
 *
 * `opts.excludeHoldoutScope` (for forbid roles): DROP any candidate dir that contains a
 * holdout artifact — the `.sparra` machinery (`ctx.paths.dir`: verdicts, evaluator traces,
 * frozen copies), the live holdout (`ctx.paths.holdout`), or the frozen holdout
 * (`ctx.paths.frozenHoldout`). The live holdout is NOT always under `.sparra`: with a
 * configured `docsDir` it resolves to `<docsBase>/HOLDOUT.md`, OUTSIDE `.sparra`, so a dir
 * pointing at `docsBase` must be dropped too. In particular this drops `ctx.root` on a
 * separate worktree (the worktree cwd already holds the full code checkout, so this doesn't
 * blind the role to the source); `extraReadDirs` that hold no holdout artifact are kept.
 */
export function buildReadDirs(
  ctx: Ctx,
  workspaceDir: string,
  opts?: { excludeHoldoutScope?: boolean }
): string[] | undefined {
  const dirs: string[] = [];
  if (workspaceDir !== ctx.root) dirs.push(ctx.root);
  for (const raw of ctx.config.build.extraReadDirs ?? []) {
    if (!raw || !raw.trim()) continue;
    const expanded = expandHome(raw.trim());
    dirs.push(path.isAbsolute(expanded) ? expanded : path.resolve(ctx.root, expanded));
  }
  let deduped = [...new Set(dirs)].filter((d) => d !== workspaceDir);
  if (opts?.excludeHoldoutScope) {
    const artifacts = [ctx.paths.dir, ctx.paths.holdout, ctx.paths.frozenHoldout].map((p) =>
      path.resolve(p)
    );
    deduped = deduped.filter((d) => {
      const c = path.resolve(d);
      return !artifacts.some((a) => within(a, c));
    });
  }
  return deduped.length ? deduped : undefined;
}
