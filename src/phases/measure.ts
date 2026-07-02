import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Ctx } from "../context.ts";
import { measureAcceptedItem, realMeasureDeps, type MeasureDeps, type MeasureResult } from "../build/measure.ts";
import { addWipWorktree, removeWipWorktree, isLinkedWorktree } from "../util/git.ts";
import { provisionWorkspaceDeps } from "../util/provision.ts";
import { writeText, stampFromDate } from "../util/io.ts";
import { banner, detail, info, ok, warn } from "../util/log.ts";

/** Injectable seams for `--worktree` so a test can exercise the wrapper without a real git worktree. */
export interface MeasureCmdDeps {
  measureDeps?: MeasureDeps;
  provisionFn?: typeof provisionWorkspaceDeps;
  addWorktreeFn?: typeof addWipWorktree;
  removeWorktreeFn?: typeof removeWipWorktree;
  worktreeDirFn?: (src: string) => string;
}

export interface MeasureCmdOptions {
  /** Dir to measure (default cwd = ctx.root). */
  dir?: string;
  /** Reuse the SAME WIP-snapshot worktree provisioning as `sparra eval --worktree`. */
  worktree?: boolean;
  /** Retain the temp worktree after the run (prints its path). */
  keepWorktree?: boolean;
  /** Update the baseline (default is compare-only: baseline NOT written). */
  setBaseline?: boolean;
  /** Also write the rendered report to this path. */
  out?: string;
}

/** Unique sibling dir for the temp worktree (same volume as the source, cheap COW dep copies). */
function defaultTempWorktreeDir(src: string): string {
  return path.join(path.dirname(src), `${path.basename(src)}-measure-${stampFromDate(new Date())}-${randomUUID().slice(0, 6)}`);
}

/**
 * `sparra measure [dir] [--worktree] [--set-baseline] [--out f]` — run the project's own
 * measurement command on `dir` (default cwd), parse structured metrics, diff them against the
 * stored baseline (under the MAIN repo `.sparra`), print the report, and write the artifact.
 * Default is COMPARE-ONLY (baseline not written); `--set-baseline` updates it. `--worktree` runs
 * the command in a TEMPORARY linked worktree snapshotted from `dir`'s WIP (torn down after), the
 * same machinery `sparra eval --worktree` uses — so the baseline still lands in the main `.sparra`.
 */
export async function cmdMeasure(ctx: Ctx, opts: MeasureCmdOptions = {}, deps: MeasureCmdDeps = {}): Promise<MeasureResult | undefined> {
  banner("MEASURE");
  const m = ctx.config.measure;
  if (!m.command) {
    warn("measure.command is not set in .sparra/config.yaml — nothing to run. Set measure.command (a single argv command that prints a JSON `metrics` object) and re-run.");
    return undefined;
  }
  const src = opts.dir ?? ctx.root;
  const compareOnly = !opts.setBaseline;
  const measureDeps = deps.measureDeps ?? realMeasureDeps();

  info(`command: ${m.command} · cwd: ${opts.worktree ? "(temp WIP worktree of " + src + ")" : src} · ${compareOnly ? "compare-only" : "will update baseline"}`);

  let result: MeasureResult;
  if (opts.worktree) {
    const wtDir = (deps.worktreeDirFn ?? defaultTempWorktreeDir)(src);
    const added = (deps.addWorktreeFn ?? addWipWorktree)(src, wtDir);
    if (!added.ok) throw new Error(`--worktree: could not snapshot ${src} into a temp worktree: ${added.out.trim()}`);
    info(`measure: temp worktree ${wtDir} (WIP snapshot of ${src})`);
    try {
      // Provision deps (node_modules) so the measure command can run in the bare worktree.
      if (ctx.config.git.provisionDeps.enabled && isLinkedWorktree(wtDir)) {
        (deps.provisionFn ?? provisionWorkspaceDeps)(src, wtDir, ctx.config.git.provisionDeps);
      }
      result = await measureAcceptedItem(ctx, wtDir, { compareOnly }, measureDeps);
    } finally {
      if (opts.keepWorktree) info(`--keep-worktree: retained temp worktree at ${wtDir}`);
      else {
        const removed = (deps.removeWorktreeFn ?? removeWipWorktree)(src, wtDir);
        if (!removed.ok) warn(`--worktree teardown failed for ${wtDir}: ${removed.out.trim()}`);
      }
    }
  } else {
    result = await measureAcceptedItem(ctx, src, { compareOnly }, measureDeps);
  }

  // Report the outcome (non-blocking: measure is always a signal).
  if (!result.ran) warn(`measure did not run: ${result.reason}`);
  else if (!result.ok) warn(`measure produced no usable metrics: ${result.reason}`);
  else if (result.regressions.length)
    warn(`measure flagged ${result.regressions.length} regression(s): ${result.regressions.map((d) => d.name).join(", ")}`);
  else ok(`measure: no regressions across ${Object.keys(result.metrics).length} metric(s)${result.baselineUpdated ? "; baseline updated" : ""}.`);

  // Print the RENDERED report body (the markdown table runMeasure wrote), not just a per-metric
  // digest — `sparra measure` surfaces the same artifact the build loop records.
  if (result.reportPath) {
    const body = (await measureDeps.readFile(result.reportPath)) ?? "";
    if (body.trim()) process.stdout.write("\n" + body.trimEnd() + "\n\n");
    info(`report: ${path.relative(ctx.root, result.reportPath)}`);
  } else {
    for (const d of result.deltas) {
      const change = d.isNew ? "new" : d.pct === undefined ? "—" : `${d.pct >= 0 ? "+" : ""}${Math.round(d.pct * 100)}%`;
      detail(`${d.regressed ? "REGRESSED " : d.isNew ? "new       " : "ok        "}${d.name}: ${d.current}${d.unit ? ` ${d.unit}` : ""} (${change}, goal ${d.goal})`);
    }
  }

  if (opts.out && result.reportPath) {
    // Re-emit the rendered artifact to the requested path (read from what runMeasure wrote).
    const content = (await measureDeps.readFile(result.reportPath)) ?? "";
    await writeText(opts.out, content);
    info(`wrote: ${opts.out}`);
  }
  return result;
}
