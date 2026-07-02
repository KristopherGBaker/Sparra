import type { Ctx } from "../context.ts";
import { loadPrompt } from "../prompts.ts";
import { runSession } from "../sdk/session.ts";
import type { RunResult, RunSessionParams } from "../sdk/session.ts";
import { readOnlyGuard } from "../sdk/guard.ts";
import { makeHoldoutReadDecider } from "./holdout.ts";
import { holdoutFreeCwd } from "./readscope.ts";
import { extractJson } from "../util/extract.ts";
import { readJson, readText, writeJson, exists } from "../util/io.ts";
import { info, warn } from "../util/log.ts";
import type { WorkItem } from "./types.ts";

/** Read the frozen plan and produce items.json. Idempotent unless force is set.
 *  `workspaceDir` (the worktree for an isolated build, else `ctx.root`) selects a holdout-free cwd;
 *  `runSessionFn` is an injectable seam for tests (mirrors generateItem). Both default to today's
 *  behavior (`cwd: ctx.root`, real `runSession`). */
export async function decompose(
  ctx: Ctx,
  traceDir: string,
  force = false,
  workspaceDir?: string,
  runSessionFn?: (p: RunSessionParams) => Promise<RunResult>
): Promise<WorkItem[]> {
  const run = runSessionFn ?? runSession;
  const cwd = holdoutFreeCwd(ctx, workspaceDir ?? ctx.root);
  if (!force && exists(ctx.paths.workitemsFile)) {
    const existing = await readJson<WorkItem[]>(ctx.paths.workitemsFile);
    if (existing && existing.length) {
      info(`Using existing decomposition (${existing.length} items).`);
      return existing;
    }
  }

  const plan = (await readText(ctx.paths.frozenPlan)) ?? (await readText(ctx.paths.plan)) ?? "";
  const map = await readText(ctx.paths.frozenMap);
  const role = ctx.config.roles.decomposer;

  // Hybrid builds: when a local generator is configured, let the decomposer route trivially-simple
  // items to it. Omit the field entirely otherwise so it never appears spuriously.
  const hasLocal = !!ctx.config.roles.generatorLocal;
  const genFieldDoc = hasLocal
    ? `, gen (OPTIONAL).
Set "gen": "local" ONLY for a trivially-simple, mechanical, low-risk item that a small local
model can do reliably — pure scaffolding, a tiny config/manifest file, a boilerplate data
struct, a one-function utility with no tricky APIs. OMIT it (defaults to the main generator)
for anything needing real design, cross-file reasoning, unfamiliar/tricky APIs, or care.
Default to omitting — tag only the genuinely trivial.`
    : `.`;

  const task = `Decompose this frozen plan into work items.

FROZEN PLAN:
---
${plan}
---
${map ? `CODEBASE_MAP (existing project — conform to this):\n---\n${map.slice(0, 6000)}\n---\n` : ""}
Output ONLY a fenced \`\`\`json block: an array of objects with fields:
  id (e.g. "item-001"), title, summary, dependsOn (array of ids), rationale${genFieldDoc}
Order matters: earlier items should not depend on later ones.`;

  info("Decomposing frozen plan into work items…");
  const res = await run({
    role: "decomposer",
    prompt: task,
    // Seeded/editable/reflectable like every other role prompt (.sparra/prompts/decomposer.md).
    systemPrompt: await loadPrompt(ctx.paths, "decomposer"),
    backend: role.backend,
    model: role.model,
    effort: role.effort,
    cwd,
    tools: ["Read", "Glob", "Grep"],
    // Forbid role: run in a holdout-free cwd (the worktree when building isolated; else ctx.root).
    // Keep the deny-decider attached (tracking THAT cwd) as defense-in-depth on hooks-aware backends.
    ...readOnlyGuard(ctx, { extraDeny: [makeHoldoutReadDecider(ctx, cwd)] }),
    maxTurns: 20,
    traceDir,
    traceSeq: 1,
  });

  const items = extractJson<WorkItem[]>(res.resultText);
  if (!items || !Array.isArray(items) || items.length === 0) {
    warn("Decomposition produced no parseable items; check the trace.");
    return [];
  }
  // Code-side item-count clamp (build.maxItems, 0 = no cap): the prompt asks for a coarse
  // decomposition, but a model that over-splits anyway is clamped here so a runaway
  // decomposition can't multiply contract/build cost. Order matters, so the head is kept.
  const maxItems = ctx.config.build.maxItems;
  if (maxItems > 0 && items.length > maxItems) {
    warn(`Decomposer produced ${items.length} items — clamping to build.maxItems (${maxItems}); dropping the last ${items.length - maxItems}.`);
    items.length = maxItems;
  }
  // Normalize ids/fields.
  const normalized = items.map((it, i) => ({
    id: it.id || `item-${String(i + 1).padStart(3, "0")}`,
    title: it.title ?? `Item ${i + 1}`,
    summary: it.summary ?? "",
    dependsOn: Array.isArray(it.dependsOn) ? it.dependsOn : [],
    rationale: it.rationale ?? "",
    // Only honor the tag when a local generator is configured; never invent it otherwise.
    ...(hasLocal && it.gen === "local" ? { gen: "local" as const } : {}),
  }));
  await writeJson(ctx.paths.workitemsFile, normalized);
  info(`Decomposed into ${normalized.length} work items.`);
  return normalized;
}
