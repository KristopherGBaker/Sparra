import type { Ctx } from "../context.ts";
import { loadPrompt } from "../prompts.ts";
import { runSession } from "../sdk/session.ts";
import type { RunResult, RunSessionParams } from "../sdk/session.ts";
import { readOnlyGuard } from "../sdk/guard.ts";
import { makeHoldoutReadDecider } from "../build/holdout.ts";
import { holdoutFreeCwd } from "../build/readscope.ts";
import { mergedBuildEnv } from "../build/env.ts";
import { extractJson } from "../util/extract.ts";
import { info, warn } from "../util/log.ts";
import type { ConductUnit } from "./types.ts";

/**
 * `src/conduct/decompose.ts` — decompose a raw `sparra conduct "<prompt>"` into 1..N units.
 *
 * Mirrors `src/build/decompose.ts` (same forbid-role holdout-free cwd, read-only tools, injectable
 * `runSessionFn`) but is sourced from the PROMPT TEXT rather than the frozen plan — conduct has no
 * frozen plan. Small prompts may legitimately yield a single unit; over-splitting is clamped to
 * `maxUnits` (head kept, order preserved).
 */

/** The decomposer's raw JSON item shape (a subset of the build decomposer's). */
interface RawUnit {
  id?: string;
  title?: string;
  summary?: string;
  rationale?: string;
  dependsOn?: unknown;
}

export interface DecomposeConductOptions {
  prompt: string;
  /** Clamp to at most this many units (head kept). */
  maxUnits: number;
  /** Trace dir for the decomposer session. */
  traceDir: string;
}

/**
 * Run the `decomposer` role over the prompt and return the clamped, normalized unit list. Never
 * throws on a fresh repo — uses `loadPrompt` defaults and a holdout-free cwd like the build
 * decomposer. `runSessionFn` is injectable for tests (defaults to the real `runSession`).
 */
export async function decomposeConduct(
  ctx: Ctx,
  opts: DecomposeConductOptions,
  runSessionFn?: (p: RunSessionParams) => Promise<RunResult>,
): Promise<ConductUnit[]> {
  const run = runSessionFn ?? runSession;
  // Forbid role: run in a holdout-free cwd (ctx.root here — conduct reads the user's checkout).
  const cwd = holdoutFreeCwd(ctx, ctx.root);
  const role = ctx.config.roles.decomposer;

  const task = `Decompose this build request into a SMALL number of independent work units (aim for the
coarsest split that still isolates genuinely separable concerns — a small request may be ONE unit).

BUILD REQUEST:
---
${opts.prompt}
---

Output ONLY a fenced \`\`\`json block: an array of objects with fields:
  id (e.g. "unit-001"), title, summary (2-4 sentences of what this unit builds), rationale.
Order matters: earlier units should not depend on later ones. Do NOT exceed ${opts.maxUnits} units.`;

  info("Decomposing the prompt into work units…");
  const res = await run({
    role: "decomposer",
    prompt: task,
    systemPrompt: await loadPrompt(ctx.paths, "decomposer"),
    backend: role.backend,
    model: role.model,
    effort: role.effort,
    cwd,
    tools: ["Read", "Glob", "Grep"],
    env: mergedBuildEnv(ctx.config),
    ...readOnlyGuard(ctx, { extraDeny: [makeHoldoutReadDecider(ctx, cwd)] }),
    maxTurns: 20,
    traceDir: opts.traceDir,
    traceSeq: 1,
  });

  const raw = extractJson<RawUnit[]>(res.resultText);
  if (!raw || !Array.isArray(raw) || raw.length === 0) {
    warn("Decomposition produced no parseable units; check the trace.");
    return [];
  }

  const clamped = raw.slice(0, Math.max(1, opts.maxUnits));
  if (raw.length > clamped.length) {
    warn(`Decomposer produced ${raw.length} units — clamping to --max-units (${opts.maxUnits}).`);
  }

  return clamped.map((u, i) => {
    const id = u.id && /^[A-Za-z0-9._-]+$/.test(u.id) ? u.id : `unit-${String(i + 1).padStart(3, "0")}`;
    const title = u.title ?? `Unit ${i + 1}`;
    const summary = u.summary ?? "";
    const rationale = u.rationale ?? "";
    const brief = renderBrief({ prompt: opts.prompt, title, summary, rationale });
    return { id, title, summary, brief };
  });
}

/** Render a unit's brief file text from its decomposed fields + the originating prompt. */
function renderBrief(parts: {
  prompt: string;
  title: string;
  summary: string;
  rationale: string;
}): string {
  return (
    `# ${parts.title}\n\n` +
    `${parts.summary}\n\n` +
    (parts.rationale ? `## Rationale\n\n${parts.rationale}\n\n` : "") +
    `## Originating request\n\n${parts.prompt}\n`
  );
}
