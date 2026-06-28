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

/** A ctx whose root contains `.sparra`, plus a separate worktree + a holdout-free extra dir. */
function makeCtx(
  extraReadDirs: string[] = [],
  docsDir = ""
): { ctx: Ctx; root: string; workspace: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-readscope-root-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-readscope-wt-"));
  const paths = new Paths(root, docsDir);
  const store = StateStore.create(paths, "greenfield");
  const config = defaultConfig();
  config.build.extraReadDirs = extraReadDirs;
  const ctx: Ctx = { root, paths, config, store };
  return { ctx, root, workspace };
}

describe("buildReadDirs — holdout scope exclusion", () => {
  it("without the flag, includes ctx.root (which contains .sparra) — unchanged behavior", () => {
    const { ctx, root, workspace } = makeCtx();
    expect(buildReadDirs(ctx, workspace)).toEqual([root]);
  });

  it("with excludeHoldoutScope, drops ctx.root because it contains .sparra", () => {
    const { ctx, workspace } = makeCtx();
    expect(buildReadDirs(ctx, workspace, { excludeHoldoutScope: true })).toBeUndefined();
  });

  it("with excludeHoldoutScope, KEEPS a holdout-free extraReadDir while dropping ctx.root", () => {
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-readscope-extra-"));
    const { ctx, root, workspace } = makeCtx([extra]);
    // Without the flag both ctx.root and the extra dir are granted.
    expect(buildReadDirs(ctx, workspace)).toEqual([root, extra]);
    // With it, only the holdout-free extra dir survives.
    expect(buildReadDirs(ctx, workspace, { excludeHoldoutScope: true })).toEqual([extra]);
  });

  it("with excludeHoldoutScope, also drops an extraReadDir that CONTAINS .sparra", () => {
    const { ctx, root, workspace } = makeCtx();
    ctx.config.build.extraReadDirs = [root]; // ctx.root listed again as an extra (contains .sparra)
    expect(buildReadDirs(ctx, workspace, { excludeHoldoutScope: true })).toBeUndefined();
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
    expect(buildReadDirs(ctx, workspace, { excludeHoldoutScope: true })).toEqual([holdoutFree]);
  });
});
