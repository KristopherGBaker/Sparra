import path from "node:path";
import type { Ctx } from "../context.ts";
import { newRunId } from "../context.ts";
import { cmdBuild } from "./build.ts";
import { banner, color, detail, info, ok } from "../util/log.ts";
import { ensureDir, exists, writeText } from "../util/io.ts";

/**
 * Run K independent builds of the same frozen plan, then summarize which failed
 * and how. Greenfield runs are isolated into separate workspaces; existing-repo
 * runs each get their own git worktree (via the configured git strategy).
 */
export async function cmdBatch(ctx: Ctx, opts: { k?: number } = {}): Promise<void> {
  const K = opts.k ?? ctx.config.batch.K;
  banner(`BATCH · ${K} builds of the frozen plan`);
  if (ctx.store.data.phase !== "frozen" && ctx.store.data.phase !== "build" && ctx.store.data.phase !== "done") {
    info("Batch requires a frozen plan. Run `sparra freeze` first.");
    return;
  }

  const batchId = newRunId("batch");
  const batchDir = path.join(ctx.paths.runs, batchId);
  await ensureDir(batchDir);

  const results: {
    n: number;
    runId: string;
    passed: number;
    failed: number;
    total: number;
    items: { id: string; status: string; rounds: number; pivots: number; score: number | undefined }[];
  }[] = [];

  for (let n = 1; n <= K; n++) {
    banner(`Batch run ${n}/${K}`);
    const override =
      ctx.store.data.mode === "greenfield" ? path.join(batchDir, `run-${n}`, "ws") : undefined;
    if (override) await ensureDir(override);

    const r = await cmdBuild(ctx, { fresh: true, workspaceOverride: override });
    const items = Object.entries(ctx.store.data.build.items).map(([id, s]) => ({
      id,
      status: s.status,
      rounds: s.round,
      pivots: s.pivots,
      score: s.lastScore,
    }));
    results.push({ n, runId: r.runId, passed: r.passed, failed: r.failed, total: r.total, items });
  }

  // Summary report.
  const lines: string[] = [`# Batch ${batchId}`, "", `Frozen plan built ${K} times.`, ""];
  for (const res of results) {
    lines.push(`## Run ${res.n} — ${res.passed}/${res.total} passed (${res.runId})`);
    for (const it of res.items) {
      lines.push(`- ${it.status === "passed" ? "✓" : it.status === "failed" ? "✗" : "•"} ${it.id} — ${it.status} (rounds ${it.rounds}, pivots ${it.pivots}, score ${it.score ?? "-"})`);
    }
    lines.push("");
  }
  // Per-item failure tally across runs.
  const tally: Record<string, { fail: number; pass: number }> = {};
  for (const res of results)
    for (const it of res.items) {
      tally[it.id] ??= { fail: 0, pass: 0 };
      if (it.status === "passed") tally[it.id]!.pass++;
      else tally[it.id]!.fail++;
    }
  lines.push("## Per-item reliability across runs");
  for (const [id, t] of Object.entries(tally)) lines.push(`- ${id}: passed ${t.pass}/${K}${t.fail ? `  ⚠ failed ${t.fail}` : ""}`);

  const report = path.join(batchDir, "SUMMARY.md");
  await writeText(report, lines.join("\n") + "\n");

  banner("BATCH COMPLETE");
  for (const res of results) {
    const m = res.passed === res.total ? color.green("✓") : color.yellow("•");
    detail(`${m} run ${res.n}: ${res.passed}/${res.total} passed`);
  }
  ok(`Summary: ${path.relative(ctx.root, report)}`);
  if (exists(report)) info("Open it to see which items are flaky across runs.");
}
