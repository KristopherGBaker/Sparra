import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReadDirs } from "../src/build/readscope.ts";
import { within } from "../src/sdk/scoping.ts";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";

/**
 * A ctx whose root contains `.sparra`, plus a separate worktree + a holdout-free extra dir.
 *
 * `withHoldout` WRITES a real `HOLDOUT.md`, because exclusion is existence-aware: a project with no
 * holdout has no wall to enforce, and treating its root as holdout-bearing because `.sparra/` sits
 * under it charged every forbid role for nothing. These fixtures previously relied on that bug —
 * they never wrote a holdout at all.
 */
function makeCtx(
  extraReadDirs: string[] = [],
  docsDir = "",
  withHoldout = true
): { ctx: Ctx; root: string; workspace: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-readscope-root-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-readscope-wt-"));
  const paths = new Paths(root, docsDir);
  const store = StateStore.create(paths, "greenfield");
  const config = defaultConfig();
  config.build.extraReadDirs = extraReadDirs;
  const ctx: Ctx = { root, paths, config, store };
  if (withHoldout) {
    fs.mkdirSync(path.dirname(paths.holdout), { recursive: true });
    fs.writeFileSync(paths.holdout, "# Holdout\n\n- the evaluator-only check\n");
  }
  return { ctx, root, workspace };
}

describe("buildReadDirs — holdout scope exclusion", () => {
  it("without the flag, includes ctx.root (which contains .sparra) — unchanged behavior", () => {
    const { ctx, root, workspace } = makeCtx();
    expect(buildReadDirs(ctx, workspace)).toEqual([root]);
  });

  it("with excludeHoldoutScope, drops ctx.root because it contains .sparra — keeping only the role INPUT dirs", () => {
    const { ctx, workspace } = makeCtx();
    // ctx.root is dropped (it holds the holdout), but the brief the role is asked to work from, and
    // the negotiated contracts, are its INPUTS — excluding them left a forbid role told to read a
    // file it could not reach. They carry no evaluator-derived content.
    expect(buildReadDirs(ctx, workspace, { excludeHoldoutScope: true })).toEqual(ctx.paths.roleInputDirs);
  });

  it("with excludeHoldoutScope, KEEPS a holdout-free extraReadDir while dropping ctx.root", () => {
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-readscope-extra-"));
    const { ctx, root, workspace } = makeCtx([extra]);
    // Without the flag both ctx.root and the extra dir are granted.
    expect(buildReadDirs(ctx, workspace)).toEqual([root, extra]);
    // With it, only the holdout-free extra dir survives.
    expect(buildReadDirs(ctx, workspace, { excludeHoldoutScope: true })).toEqual([extra, ...ctx.paths.roleInputDirs]);
  });

  it("with excludeHoldoutScope, also drops an extraReadDir that CONTAINS .sparra", () => {
    const { ctx, root, workspace } = makeCtx();
    ctx.config.build.extraReadDirs = [root]; // ctx.root listed again as an extra (contains .sparra)
    expect(buildReadDirs(ctx, workspace, { excludeHoldoutScope: true })).toEqual(ctx.paths.roleInputDirs);
  });

  it("with NO holdout on disk, excludeHoldoutScope keeps ctx.root — there is no wall to enforce", () => {
    // The field case: a project with no HOLDOUT.md anywhere. `.sparra/` still resolves, so an
    // existence-blind predicate marked the repo root holdout-bearing forever and dropped it.
    const { ctx, root, workspace } = makeCtx([], "", false);
    expect(fs.existsSync(ctx.paths.holdout)).toBe(false);
    // ctx.root is granted, and it CONTAINS the role-input dirs — so they are not granted redundantly.
    expect(buildReadDirs(ctx, workspace, { excludeHoldoutScope: true })).toEqual([root]);
  });

  it("drops an extraReadDir whose holdout (under docsDir, OUTSIDE .sparra) it contains, while keeping a holdout-free dir", () => {
    // docsDir places HOLDOUT.md at <root>/docs/HOLDOUT.md — NOT under .sparra.
    const holdoutFree = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-readscope-free-"));
    const { ctx, root, workspace } = makeCtx([], "docs");
    const docsBase = ctx.paths.docsBase;
    expect(docsBase).toBe(path.join(root, "docs"));
    // Sanity: the live holdout really lives under docsBase, outside .sparra.
    expect(ctx.paths.holdout).toBe(path.join(docsBase, "HOLDOUT.md"));
    expect(within(ctx.paths.holdout, ctx.paths.dir)).toBe(false);

    ctx.config.build.extraReadDirs = [docsBase, holdoutFree];
    // Evaluator (no exclusion) still gets BOTH the docsBase (holdout dir) and the free dir.
    expect(buildReadDirs(ctx, workspace)).toEqual([root, docsBase, holdoutFree]);
    // Forbid role: docsBase is dropped (it contains the live holdout), holdout-free dir kept.
    expect(buildReadDirs(ctx, workspace, { excludeHoldoutScope: true })).toEqual([holdoutFree, ...ctx.paths.roleInputDirs]);
  });
});
