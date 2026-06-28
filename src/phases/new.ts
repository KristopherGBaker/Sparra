import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "../context.ts";
import { exists, writeText, readText } from "../util/io.ts";
import { banner, ok, info } from "../util/log.ts";

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "cycle"
  );
}

function nextCycleNumber(cyclesDir: string): number {
  if (!exists(cyclesDir)) return 1;
  const ns = fs
    .readdirSync(cyclesDir)
    .map((d) => parseInt(d.slice(0, 4), 10))
    .filter((n) => !Number.isNaN(n));
  return (ns.length ? Math.max(...ns) : 0) + 1;
}

function freshPlan(title: string, mode: string): string {
  const heading = title ? `# Plan: ${title}` : "# Plan: (untitled)";
  return `${heading}\n\n> Co-edited with Sparra during \`sparra plan\`. High-level intent, not granular steps.\n\n## Intent\n_TBD — what are we building and why?_\n\n## Constraints\n_TBD_\n\n## Approach\n_TBD (high level)_\n\n${mode === "existing" ? "## Patterns to conform to\n_See CODEBASE_MAP.md._\n\n" : ""}## Risks & unknowns\n_TBD_\n\n## Open questions\n_TBD_\n\n## Success criteria\n_TBD_\n`;
}

export interface ArchiveResult {
  /** Cycle number assigned. */
  n: number;
  /** `<NNNN>-<slug>` directory name. */
  name: string;
  /** Absolute path of the cycle dir. */
  dest: string;
  /** Count of artifact groups moved. */
  archived: number;
}

/**
 * Archive the finished cycle's working set into `.sparra/cycles/<NNNN>-<slug>/`: the plan,
 * the live HOLDOUT.md, the frozen input, work items, contracts, verdicts, reviews, and the
 * run's traces (move, not copy — the next cycle starts clean), plus a `cycle.json` manifest.
 * Cross-cycle artifacts (memory.md, CHANGELOG.md, CODEBASE_MAP.md, config.yaml, calibration/,
 * prompts/, proposals/, snapshots/) are deliberately left in place. Shared by `new` and
 * `finish`; it does NOT re-scaffold or reset build state — that stays in `cmdNew`.
 */
export async function archiveCycle(ctx: Ctx, title: string): Promise<ArchiveResult> {
  const { paths, store } = ctx;
  const b = store.data;

  const n = nextCycleNumber(paths.cycles);
  let slug = slugify(title);
  if (!title) {
    const plan = await readText(paths.plan);
    const m = plan?.match(/^#\s*(?:Plan:\s*)?(.+)$/m);
    slug = slugify(m?.[1] ?? "");
  }
  const name = `${String(n).padStart(4, "0")}-${slug}`;
  const dest = paths.cycleDir(name);
  fs.mkdirSync(dest, { recursive: true });

  // Move the finished cycle's working set into the archive. The live HOLDOUT.md is archived
  // alongside the rest so a stale per-cycle holdout never bleeds into the next cycle (and so
  // it stays private — it is moved by path only, never read here).
  const moves: Array<[string, string]> = [
    [paths.plan, path.join(dest, "PLAN.md")],
    [paths.holdout, path.join(dest, "HOLDOUT.md")],
    [paths.frozen, path.join(dest, "frozen")],
    [paths.workitems, path.join(dest, "workitems")],
    [paths.contracts, path.join(dest, "contracts")],
    [paths.verdicts, path.join(dest, "verdicts")],
    [paths.reviews, path.join(dest, "reviews")],
  ];
  if (b.build.runId) moves.push([paths.traceDir(b.build.runId), path.join(dest, "traces", b.build.runId)]);

  let archived = 0;
  for (const [src, dst] of moves) {
    if (exists(src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      archived++;
    }
  }

  // A small manifest of what this cycle accomplished.
  const items = Object.entries(b.build.items).map(([id, s]) => ({
    id,
    status: s.status,
    lastScore: s.lastScore,
    pivots: s.pivots,
  }));
  await writeText(
    path.join(dest, "cycle.json"),
    JSON.stringify(
      {
        n,
        slug,
        runId: b.build.runId ?? null,
        frozenAt: b.freeze?.frozenAt ?? null,
        archivedAt: new Date().toISOString(),
        mode: b.mode,
        items,
      },
      null,
      2
    ) + "\n"
  );

  return { n, name, dest, archived };
}

/**
 * Start a NEW plan→build cycle in the same project. Archives the finished cycle's working
 * set (via `archiveCycle`), carries forward the cross-cycle artifacts (memory.md,
 * CHANGELOG.md, CODEBASE_MAP.md, config, calibration, prompts), resets the build state,
 * writes a fresh PLAN.md, and returns to the `plan` phase.
 */
export async function cmdNew(ctx: Ctx, title: string): Promise<void> {
  banner("NEW CYCLE");
  const { paths, store } = ctx;
  const b = store.data;

  const { n, dest, archived } = await archiveCycle(ctx, title);

  // Recreate the now-empty working dirs, write a fresh plan, reset per-cycle state.
  await paths.ensureScaffold();
  await writeText(paths.plan, freshPlan(title, b.mode));

  b.build = { items: {} };
  b.freeze = {};
  b.planning = { turns: 0 };
  b.sessions = {};
  await store.transition("plan", true);

  ok(`Cycle ${n} archived → ${path.relative(ctx.root, dest)} (${archived} artifact group(s)).`);
  info(`Carried forward: memory.md, CHANGELOG.md${exists(paths.codebaseMap) ? ", CODEBASE_MAP.md" : ""}, config, calibration, prompts.`);
  info(`Fresh PLAN.md ready — phase reset to \`plan\`.`);
  info(`Next: \`sparra plan\`${b.mode === "existing" ? "  (or `sparra orient` first to refresh the map)" : ""}.`);
}
