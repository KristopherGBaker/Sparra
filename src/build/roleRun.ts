import path from "node:path";
import type { Ctx } from "../context.ts";
import type { RoleConfig } from "../config.ts";
import { fill, loadPrompt } from "../prompts.ts";
import { runSession } from "../sdk/session.ts";
import type { RunResult, RunSessionParams } from "../sdk/session.ts";
import { evaluatorGuard, readOnlyGuard, scopedWriterGuard, type Guard } from "../sdk/guard.ts";
import { makeDenyHook, mergeHooks } from "../sdk/hooks.ts";
import { skillsForRole } from "../sdk/skills.ts";
import { buildExerciser } from "../sdk/exercise.ts";
import { buildReadDirs } from "./readscope.ts";
import { randomUUID } from "node:crypto";
import { readHoldout, holdoutSection, assertNoHoldoutLeak, holdoutLines } from "./holdout.ts";
import { contractModeClauses, deviationPolicy, rubricText, calibrationText, existingTestsText } from "./modeText.ts";
import { appleConventions, isApplePlatform } from "./swiftConventions.ts";
import { readMemory, memorySection } from "../memory.ts";
import { RUBRIC_CRITERIA, type Verdict } from "./types.ts";
import { extractJsonWhere } from "../util/extract.ts";
import { exists, readText, writeText, stampFromDate } from "../util/io.ts";

/**
 * The policy role-runner — the seam that makes Sparra's roles callable from an
 * interactive Claude Code session (via `sparra role run` or the MCP `run_role`
 * tool) without reimplementing the engine.
 *
 * It sits ABOVE `runSession` (the backend choke point) and owns the *policy* the
 * build loop normally enforces: backend/guard/tool selection, backend-agnostic
 * safety intent (readOnly/writeScope so Codex roles sandbox correctly too), and —
 * critically — the HOLDOUT WALL. Holdout is a runner concern, never a generic
 * AgentRequest field: only the evaluator ever sees holdout contents; every other
 * ("forbid") role has its brief checked with `assertNoHoldoutLeak` BEFORE any
 * backend call AND is denied tool-reads of the holdout file on disk. The
 * interactive conductor passes a holdout *path*, never its contents, and a detected
 * leak surfaces a sanitized error (no holdout text).
 */

export type RoleKind = "generator" | "contract-generator" | "contract-evaluator" | "evaluator" | "reviewer";

/** Only the build evaluator is allowed to see holdout; everyone else is forbidden. */
function isEvaluator(kind: RoleKind): boolean {
  return kind === "evaluator";
}

interface RoleSpec {
  configKey: "generator" | "contractGenerator" | "contractEvaluator" | "evaluator" | "reviewer";
  promptName: string;
  skillsName: string;
  tools: string[];
  guard: "writer" | "evaluator" | "readonly";
}

const WRITER_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash"];
const READ_TOOLS = ["Read", "Glob", "Grep", "Bash"];

const SPECS: Record<RoleKind, RoleSpec> = {
  generator: { configKey: "generator", promptName: "generator", skillsName: "generator", tools: WRITER_TOOLS, guard: "writer" },
  "contract-generator": { configKey: "contractGenerator", promptName: "contract-generator", skillsName: "contractGenerator", tools: READ_TOOLS, guard: "readonly" },
  "contract-evaluator": { configKey: "contractEvaluator", promptName: "contract-evaluator", skillsName: "contractEvaluator", tools: READ_TOOLS, guard: "readonly" },
  evaluator: { configKey: "evaluator", promptName: "evaluator", skillsName: "evaluator", tools: READ_TOOLS, guard: "evaluator" },
  reviewer: { configKey: "reviewer", promptName: "reviewer", skillsName: "reviewer", tools: READ_TOOLS, guard: "readonly" },
};

export interface RoleRunRequest {
  ctx: Ctx;
  roleKind: RoleKind;
  /** Where the artifact lives / the role runs (the cwd). Defaults to ctx.root. */
  workspace?: string;
  /** The task brief (inline) or a file to read it from. One is required. */
  brief?: string;
  briefPath?: string;
  /** The agreed contract (inline) or a file to read it from. */
  contract?: string;
  contractPath?: string;
  /** Holdout file (evaluator-only). Defaults to the project holdout. Pass a PATH, never contents.
   *  If given and missing, the run FAILS CLOSED (throws) rather than silently running without it. */
  holdoutPath?: string;
  /** Where to write the normalized verdict (evaluator) / result (others). */
  out?: string;
  /** Backend/model/effort overrides; else the role's config defaults. */
  backend?: string;
  model?: string;
  effort?: RoleConfig["effort"];
  /** Injectable for tests; defaults to the real backend session. */
  runSessionFn?: (p: RunSessionParams) => Promise<RunResult>;
  traceDir?: string;
  traceSeq?: number;
}

export interface RoleRunResult {
  ok: boolean;
  roleKind: RoleKind;
  backend: string;
  model: string;
  resultText: string;
  /** Present for the evaluator role. */
  verdict?: Verdict;
  /** Path the verdict/result was written to, if `out` was given. */
  outPath?: string;
  sessionId: string;
  costUsd: number;
  tokens: number;
  errors: string[];
}

/** Recompute the weighted rubric total ourselves (don't trust model arithmetic). */
function computeWeighted(ctx: Ctx, scores: Verdict["scores"]): number {
  const w = ctx.config.rubric.weights;
  const sum = w.design + w.originality + w.craft + w.functionality || 1;
  const total =
    (scores.design * w.design + scores.originality * w.originality + scores.craft * w.craft + scores.functionality * w.functionality) / sum;
  return Math.round(total * 10) / 10;
}

/** Fill the union of placeholders the standard role prompts use. Unknown placeholders are
 *  left visible (a misconfigured custom prompt should be obvious, not silently blanked). */
async function roleSystemPrompt(ctx: Ctx, kind: RoleKind, exerciseGuidance: string): Promise<string> {
  const template = await loadPrompt(ctx.paths, SPECS[kind].promptName);
  return fill(template, {
    MODE: ctx.store.data.mode,
    DEVIATION: ctx.config.deviation.strictness,
    DEVIATION_POLICY: deviationPolicy(ctx),
    EXERCISE_GUIDANCE: exerciseGuidance,
    EXISTING_TESTS: existingTestsText(ctx),
    RUBRIC: rubricText(ctx),
    CALIBRATION: calibrationText(ctx),
    ASSERTION_MIN: String(ctx.config.contract.assertionMin),
    ASSERTION_MAX: String(ctx.config.contract.assertionMax),
    MODE_CLAUSES: contractModeClauses(ctx),
  });
}

/** Conventions block (CODEBASE_MAP + Apple house style) the build/contract/review roles inject. */
async function conventionsBlock(ctx: Ctx): Promise<string> {
  const map = await readText(ctx.paths.frozenMap);
  return (
    (map ? `CONVENTIONS (CODEBASE_MAP — conform; don't regress existing behavior):\n---\n${map.slice(0, 5000)}\n---\n` : "") +
    (isApplePlatform(ctx) ? `\n${appleConventions(ctx.config.exercise.ios.platform)}\n` : "")
  );
}

/** Resolve holdout text. Explicit path FAILS CLOSED if missing; else the project holdout (may be ""). */
async function resolveHoldout(req: RoleRunRequest): Promise<string> {
  if (req.holdoutPath) {
    if (!exists(req.holdoutPath)) {
      throw new Error(`holdout path not found: ${req.holdoutPath} (refusing to run without the holdout it names).`);
    }
    return (await readText(req.holdoutPath)) ?? "";
  }
  return readHoldout(req.ctx);
}

/** A PreToolUse decider that denies a forbid role from reading the holdout file(s) off disk —
 *  closing the gap that the prompt-leak check alone can't (Read/Bash could `cat HOLDOUT.md`).
 *  (Claude backend only; Codex ignores hooks — see the runner doc for that residual.) */
export function makeHoldoutReadDecider(
  ctx: Ctx,
  workspace: string,
  explicitPath?: string
): (tool: string, input: unknown) => string | null {
  // Protect the holdout file(s) AND the whole .sparra/ machinery dir — which also
  // holds the frozen holdout, evaluator verdicts, and evaluator traces (all
  // holdout-derived). A forbid role never legitimately needs to read .sparra.
  const sparraDir = path.resolve(ctx.paths.dir);
  const protectedFiles = new Set(
    [ctx.paths.holdout, ctx.paths.frozenHoldout, explicitPath].filter(Boolean).map((p) => path.resolve(p as string))
  );
  const basenames = new Set([...protectedFiles].map((p) => path.basename(p)));
  const resolve = (p: string) => (path.isAbsolute(p) ? path.resolve(p) : path.resolve(workspace, p));
  const within = (child: string, parent: string) => {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  const blockedTarget = (t: string) => {
    const abs = resolve(t);
    return protectedFiles.has(abs) || within(abs, sparraDir);
  };
  const DENY = "Holdout/.sparra is evaluator-only and not readable by this role.";
  return (tool, input) => {
    const i = input as { file_path?: string; path?: string; command?: string } | undefined;
    if (tool === "Read" || tool === "Glob" || tool === "Grep") {
      const target = i?.file_path ?? i?.path;
      if (target && blockedTarget(target)) return DENY;
    }
    if (tool === "Bash") {
      const cmd = i?.command ?? "";
      if (cmd.includes(".sparra") || cmd.includes("HOLDOUT") || [...basenames].some((b) => cmd.includes(b))) return DENY;
    }
    return null;
  };
}

/** Redact any verbatim holdout line from conductor-facing text (verdict evidence/
 *  blocking/notes) — the evaluator may quote holdout, and that must not reach the
 *  conductor via `--out` or the MCP payload. */
function redactHoldout(text: string, lines: string[]): string {
  let out = text;
  for (const line of lines) out = out.split(line).join("[redacted: holdout]");
  return out;
}

/** Strip holdout quotes from a verdict's conductor-facing strings. */
function redactVerdict(v: Verdict, holdoutText: string): Verdict {
  const lines = holdoutLines(holdoutText);
  if (!lines.length) return v;
  return {
    ...v,
    blocking: v.blocking.map((b) => redactHoldout(b, lines)),
    notes: redactHoldout(v.notes, lines),
    // Rebuild each assertion to the exact schema (no spread) so no stray field survives.
    assertions: v.assertions.map((a) => ({ id: a.id, pass: a.pass, evidence: redactHoldout(a.evidence, lines) })),
  };
}

/** Parse + normalize an evaluator verdict the same way the build loop does. */
function parseVerdict(ctx: Ctx, resultText: string): Verdict {
  const parsed = extractJsonWhere<Verdict>(
    resultText,
    (v) => v && typeof v === "object" && v.scores && typeof v.scores === "object" && ("verdict" in v || "weightedTotal" in v)
  );
  if (!parsed || !parsed.scores) {
    return {
      assertions: [],
      scores: { design: 0, originality: 0, craft: 0, functionality: 0 },
      weightedTotal: 0,
      verdict: "fail",
      blocking: ["Evaluator did not produce a parseable JSON verdict; re-run."],
      notes: "no verdict parsed",
    };
  }
  for (const c of RUBRIC_CRITERIA) {
    const v = Number(parsed.scores[c] ?? 0);
    parsed.scores[c] = Math.max(0, Math.min(100, isFinite(v) ? v : 0));
  }
  const weighted = computeWeighted(ctx, parsed.scores);
  const meets = weighted >= ctx.config.rubric.passThreshold && parsed.verdict === "pass";
  // Normalize to the EXACT schema — the evaluator's JSON is untrusted model output, so
  // drop any extra properties (e.g. a smuggled `holdoutQuote`) that would otherwise ride
  // through to conductor-facing artifacts.
  const assertions = Array.isArray(parsed.assertions)
    ? parsed.assertions.map((a) => ({
        id: Number((a as { id?: unknown })?.id ?? 0),
        pass: Boolean((a as { pass?: unknown })?.pass),
        evidence: String((a as { evidence?: unknown })?.evidence ?? ""),
      }))
    : [];
  return {
    assertions,
    scores: parsed.scores,
    weightedTotal: weighted,
    verdict: meets ? "pass" : "fail",
    blocking: (Array.isArray(parsed.blocking) ? parsed.blocking : []).map((b) => String(b)),
    notes: String(parsed.notes ?? ""),
  };
}

/**
 * Run a single Sparra role once, enforcing the holdout wall, and return a normalized
 * result (a verdict for the evaluator). The interactive surface never receives holdout
 * contents — only this runner materializes them, and only for the evaluator.
 */
export async function runRole(req: RoleRunRequest): Promise<RoleRunResult> {
  const { ctx, roleKind } = req;
  const spec = SPECS[roleKind];
  if (!spec) throw new Error(`Unknown roleKind "${roleKind}". Valid: ${Object.keys(SPECS).join(", ")}`);

  const baseRole = ctx.config.roles[spec.configKey] as RoleConfig;
  const role: RoleConfig = {
    ...baseRole,
    ...(req.backend ? { backend: req.backend } : {}),
    ...(req.model ? { model: req.model } : {}),
    ...(req.effort ? { effort: req.effort } : {}),
  };
  const workspace = req.workspace ?? ctx.root;
  const run = req.runSessionFn ?? runSession;

  const brief = req.brief ?? (req.briefPath ? (await readText(req.briefPath)) ?? "" : "");
  if (!brief.trim()) throw new Error("runRole requires a non-empty brief (brief or briefPath).");
  const contract = req.contract ?? (req.contractPath ? (await readText(req.contractPath)) ?? "" : "");

  // The runner — not the conductor — is the only context that reads holdout.
  const holdoutText = await resolveHoldout(req);
  const evaluator = isEvaluator(roleKind);

  const exerciser = evaluator ? buildExerciser(ctx.config, workspace) : undefined;
  const system = await roleSystemPrompt(ctx, roleKind, exerciser?.guidance ?? "");

  // Parity context the real roles inject (cheap reads; improves single-shot fidelity).
  const memory = memorySection(await readMemory(ctx.paths));
  const conventions = roleKind === "generator" || roleKind === "reviewer" ? await conventionsBlock(ctx) : "";

  const contractBlock = contract.trim() ? `\nAGREED CONTRACT (satisfy/grade against THIS):\n---\n${contract.trim()}\n---\n` : "";
  let task = `${brief.trim()}\n${contractBlock}${conventions}${memory}`;
  if (evaluator) {
    task += holdoutSection(holdoutText); // injected ONLY here
  } else {
    // Throws BEFORE any backend call if the brief/contract leak the holdout — but with a
    // SANITIZED message (the raw assertion includes a holdout snippet; don't surface it).
    try {
      assertNoHoldoutLeak(roleKind, task, holdoutText);
    } catch {
      throw new Error(`Holdout content detected in the ${roleKind} brief/contract — remove it; holdout is evaluator-only.`);
    }
  }

  // Guard: Claude-side permission/hooks. For forbid roles, also deny reading the holdout file.
  let guard: Guard =
    spec.guard === "writer"
      ? scopedWriterGuard(ctx, [workspace], { format: true })
      : spec.guard === "evaluator"
        ? evaluatorGuard(ctx)
        : readOnlyGuard(ctx);
  if (!evaluator) {
    guard = { ...guard, hooks: mergeHooks(guard.hooks, makeDenyHook([makeHoldoutReadDecider(ctx, workspace, req.holdoutPath)])) };
  }

  // Unique trace dir so repeated role runs don't overwrite each other. Evaluator traces
  // contain holdout by design (the evaluator is allowed to see it) — they live in a
  // role-run subdir; the conductor reads verdicts, not evaluator traces.
  const traceDir =
    req.traceDir ?? path.join(ctx.paths.traces, `role-run-${roleKind}-${stampFromDate(new Date())}-${randomUUID().slice(0, 8)}`);

  const res = await run({
    role: `role-run-${roleKind}`,
    prompt: task,
    systemPrompt: system,
    backend: role.backend,
    model: role.model,
    effort: role.effort,
    baseUrl: role.baseUrl,
    apiKey: role.apiKey,
    cwd: workspace,
    additionalDirectories: buildReadDirs(ctx, workspace),
    tools: spec.tools,
    skills: skillsForRole(ctx, spec.skillsName),
    // Backend-agnostic safety intent so Codex sandboxes correctly (it ignores Claude hooks):
    // only the generator may write; every other role is read-only.
    ...(spec.guard === "writer" ? { writeScope: [workspace] } : { readOnly: true }),
    ...(exerciser ? { allowedTools: exerciser.allowedTools, mcpServers: exerciser.mcpServers } : {}),
    ...guard,
    maxTurns: ctx.config.build.maxTurnsPerSession,
    maxBudgetUsd: ctx.config.build.maxBudgetUsdPerItem,
    traceDir,
    traceSeq: req.traceSeq ?? 1,
  });

  const result: RoleRunResult = {
    ok: res.ok,
    roleKind,
    backend: role.backend ?? "claude",
    model: role.model,
    resultText: res.resultText,
    sessionId: res.sessionId,
    costUsd: res.costUsd,
    tokens: res.tokens,
    errors: res.errors,
  };

  if (evaluator) {
    // Redact any holdout the evaluator quoted, so it can't reach the conductor via
    // the returned verdict or the `--out` file (the evaluator may cite holdout in
    // evidence/blocking/notes — it's allowed to see it; the conductor is not).
    const verdict = redactVerdict(parseVerdict(ctx, res.resultText), holdoutText);
    result.verdict = verdict;
    result.ok = res.ok && verdict.verdict === "pass";
    if (req.out) {
      const failed = verdict.assertions.filter((a) => !a.pass);
      await writeText(
        req.out,
        `# Verdict — ${roleKind} (${role.backend ?? "claude"}/${role.model})\n\n- verdict: **${verdict.verdict}**\n- weighted total: **${verdict.weightedTotal}** (threshold ${ctx.config.rubric.passThreshold})\n- scores: design ${verdict.scores.design}, originality ${verdict.scores.originality}, craft ${verdict.scores.craft}, functionality ${verdict.scores.functionality}\n\n## Failed assertions (${failed.length}/${verdict.assertions.length})\n${failed.map((a) => `- #${a.id}: ${a.evidence}`).join("\n") || "_none_"}\n\n## Blocking\n${verdict.blocking.map((b) => `- ${b}`).join("\n") || "_none_"}\n\n## Notes\n${verdict.notes}\n`
      );
      result.outPath = req.out;
    }
  } else if (req.out) {
    await writeText(req.out, res.resultText);
    result.outPath = req.out;
  }

  return result;
}
