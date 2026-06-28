import type { Ctx } from "../context.ts";
import { runSession } from "../sdk/session.ts";
import { readOnlyGuard } from "../sdk/guard.ts";
import { makeHoldoutReadDecider } from "./holdout.ts";
import { extractJson } from "../util/extract.ts";
import { readJson, readText, writeJson, exists } from "../util/io.ts";
import { info, warn } from "../util/log.ts";
import type { WorkItem } from "./types.ts";

const DECOMPOSE_SYSTEM = `You decompose a frozen build plan into a small, ordered set of
work items for an autonomous build loop. Keep items COARSE — each should be a meaningful,
independently verifiable chunk of product value, not a micro-task.

SCALE THE COUNT TO THE PLAN'S SIZE. A tiny project (e.g. a single-file tool, or a
one-screen app) is ONE item. A small project is 1–3 items; a typical project 3–8. Do NOT
split a trivial task into setup/implement/verify steps — verification is handled separately
by the build loop, so never make a standalone "test it" item. Likewise NEVER make a
standalone scaffold / project-setup / "create the project" / "generate the Xcode project"
item — project generation, config files, and boilerplate are SETUP, not independently
shippable value; fold them into the first feature item that needs them (that item's
contract can still check the project builds). Order items so dependencies come first. The
plan is a strong prior, not a contract; do not over-specify implementation.`;

/** Read the frozen plan and produce items.json. Idempotent unless force is set. */
export async function decompose(ctx: Ctx, traceDir: string, force = false): Promise<WorkItem[]> {
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
  const res = await runSession({
    role: "decomposer",
    prompt: task,
    systemPrompt: DECOMPOSE_SYSTEM,
    backend: role.backend,
    model: role.model,
    effort: role.effort,
    cwd: ctx.root,
    tools: ["Read", "Glob", "Grep"],
    // Forbid role in the repo root (which holds .sparra/HOLDOUT.md): deny on-disk holdout reads.
    ...readOnlyGuard(ctx, { extraDeny: [makeHoldoutReadDecider(ctx, ctx.root)] }),
    maxTurns: 20,
    traceDir,
    traceSeq: 1,
  });

  const items = extractJson<WorkItem[]>(res.resultText);
  if (!items || !Array.isArray(items) || items.length === 0) {
    warn("Decomposition produced no parseable items; check the trace.");
    return [];
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
