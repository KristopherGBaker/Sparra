import type { Ctx } from "../context.ts";
import { fill, loadPrompt } from "../prompts.ts";
import { runSession } from "../sdk/session.ts";
import type { RunResult, RunSessionParams } from "../sdk/session.ts";
import type { LimitHit } from "../sdk/backend.ts";
import { evaluatorGuard } from "../sdk/guard.ts";
import { skillsForRole } from "../sdk/skills.ts";
import { buildExerciser } from "../sdk/exercise.ts";
import { snapshotArtifact, enforceArtifactIntegrity, realIntegrityDeps, type IntegrityDeps } from "./integrity.ts";
import { buildReadDirs } from "./readscope.ts";
import { extractJsonWhere } from "../util/extract.ts";
import { writeText } from "../util/io.ts";
import { info, ok, warn } from "../util/log.ts";
import { readMemory, memorySection } from "../memory.ts";
import { readHoldout, holdoutSection, redactHoldout, holdoutLines } from "./holdout.ts";
import { calibrationText, existingTestsText, rubricText } from "./modeText.ts";
import { RUBRIC_CRITERIA, type Verdict, type WorkItem } from "./types.ts";
import type { RoleConfig } from "../config.ts";

export interface EvalOutput {
  verdict: Verdict;
  raw: string;
  sessionId: string;
  /** Set when the session failed on a provider rate/usage limit — the build loop waits + retries. */
  limitHit?: LimitHit;
  costUsd: number;
  tokens: number;
}

/** Normalize the rubric weights and compute the weighted total ourselves (don't trust model arithmetic). */
function computeWeighted(ctx: Ctx, scores: Verdict["scores"]): number {
  const w = ctx.config.rubric.weights;
  const sum = w.design + w.originality + w.craft + w.functionality || 1;
  const total =
    (scores.design * w.design + scores.originality * w.originality + scores.craft * w.craft + scores.functionality * w.functionality) / sum;
  return Math.round(total * 10) / 10;
}

/**
 * The adversarial evaluator EXERCISES the artifact (via the pluggable exerciser)
 * and grades it against the agreed contract + rubric. Returns a structured verdict
 * with the weighted total recomputed by us.
 */
export async function evaluateItem(args: {
  ctx: Ctx;
  item: WorkItem;
  contractText: string;
  workspaceDir: string;
  round: number;
  traceDir: string;
  traceSeq: number;
  /** Prior learnings to inject (from .sparra/memory.md). Falls back to reading the file. */
  priorLearnings?: string;
  /** Per-session USD budget (remaining item budget). Defaults to the per-item cap. */
  maxBudgetUsd?: number;
  /** Evaluator role to use; defaults to `roles.evaluator`. The build loop passes a fallback
   *  model here when the primary evaluator's backend is in a limit window. */
  role?: RoleConfig;
  /** Injectable for tests; defaults to the real SDK session. */
  runSessionFn?: (p: RunSessionParams) => Promise<RunResult>;
  /** Injectable for tests; defaults to the real git/fs source-integrity deps. */
  integrityDeps?: IntegrityDeps;
}): Promise<EvalOutput> {
  const { ctx, item, contractText, workspaceDir, round } = args;
  const role = args.role ?? ctx.config.roles.evaluator;
  const run = args.runSessionFn ?? runSession;
  const exerciser = buildExerciser(ctx.config, workspaceDir);
  // Only relax the Codex exercise sandbox to workspace-write on a worktree/branch boundary (the
  // integrity guard needs git to revert). Carries `exerciseScratch` + arms the source-integrity guard.
  const exerciseScratch = ctx.config.exercise.sandbox === "workspace-write" && !!ctx.store.data.build.branch;
  const integrityDeps = args.integrityDeps ?? realIntegrityDeps();

  const system = fill(await loadPrompt(ctx.paths, "evaluator"), {
    EXERCISE_GUIDANCE: exerciser.guidance,
    EXISTING_TESTS: existingTestsText(ctx),
    RUBRIC: rubricText(ctx),
    CALIBRATION: calibrationText(ctx),
  });
  const memory = memorySection(args.priorLearnings ?? (await readMemory(ctx.paths)));
  const holdoutText = await readHoldout(ctx);
  const holdout = holdoutSection(holdoutText);

  const task = `Adversarially evaluate work item ${item.id}: ${item.title} (round ${round}).

The artifact is in: ${workspaceDir}

AGREED CONTRACT (grade against THIS, not the plan prose):
---
${contractText}
---
${holdout}${memory}Exercise the artifact for real, check every assertion with evidence, score the rubric, and emit the JSON verdict exactly as specified in your instructions.`;

  info(`Evaluating ${item.id} (round ${round}) with ${role.model} — exercising via ${ctx.config.exercise.mechanism}…`);
  // Snapshot the artifact surface before an exercise that may write (Codex workspace-write); the
  // source-integrity guard reverts + reports any artifact mutation the evaluator makes below.
  const snap = exerciseScratch ? snapshotArtifact(workspaceDir, integrityDeps) : undefined;
  const res = await run({
    role: `evaluator-${item.id}-r${round}`,
    prompt: task,
    systemPrompt: system,
    backend: role.backend,
    model: role.model,
    effort: role.effort,
    cwd: workspaceDir,
    additionalDirectories: buildReadDirs(ctx, workspaceDir),
    tools: ["Read", "Glob", "Grep", "Bash"],
    skills: skillsForRole(ctx, "evaluator"),
    allowedTools: exerciser.allowedTools,
    mcpServers: exerciser.mcpServers,
    readOnly: true,
    ...(exerciseScratch ? { exerciseScratch: true } : {}),
    ...evaluatorGuard(ctx),
    maxTurns: ctx.config.build.maxTurnsPerSession,
    maxBudgetUsd: args.maxBudgetUsd ?? ctx.config.build.maxBudgetUsdPerItem,
    traceDir: args.traceDir,
    traceSeq: args.traceSeq,
  });

  // Shape-aware: the verdict is the JSON with rubric scores — not just the last
  // fenced block (evaluator output is full of incidental JSON/command snippets).
  const parsed = extractJsonWhere<Verdict>(
    res.resultText,
    (v) => v && typeof v === "object" && v.scores && typeof v.scores === "object" && ("verdict" in v || "weightedTotal" in v)
  );
  let verdict: Verdict;
  if (!parsed || !parsed.scores) {
    warn(`Evaluator for ${item.id} returned no parseable verdict — treating as FAIL.`);
    verdict = {
      assertions: [],
      scores: { design: 0, originality: 0, craft: 0, functionality: 0 },
      weightedTotal: 0,
      verdict: "fail",
      exerciseStatus: "ran", // a missing verdict is a real failure, not a block
      blocking: ["Evaluator did not produce a parseable JSON verdict; re-run."],
      notes: "no verdict parsed",
    };
  } else {
    // Clamp scores and recompute the weighted total ourselves.
    for (const c of RUBRIC_CRITERIA) {
      const v = Number(parsed.scores[c] ?? 0);
      parsed.scores[c] = Math.max(0, Math.min(100, isFinite(v) ? v : 0));
    }
    const weighted = computeWeighted(ctx, parsed.scores);
    const modelSaidPass = parsed.verdict === "pass";
    const meetsThreshold = weighted >= ctx.config.rubric.passThreshold;
    // A BLOCKED exercise is inconclusive — it can NEVER be a pass (we couldn't verify), so an
    // unverified item is never silently accepted regardless of the model's verdict or score.
    const isBlocked = parsed.exerciseStatus === "blocked";
    verdict = {
      assertions: Array.isArray(parsed.assertions) ? parsed.assertions : [],
      scores: parsed.scores,
      weightedTotal: weighted,
      verdict: modelSaidPass && meetsThreshold && !isBlocked ? "pass" : "fail",
      exerciseStatus: isBlocked ? "blocked" : "ran",
      blocking: Array.isArray(parsed.blocking) ? parsed.blocking : [],
      notes: parsed.notes ?? "",
    };
  }

  // Source-integrity guard: revert any artifact write the evaluator made during the exercise and,
  // if it mutated the surface, FORCE the verdict to fail (a verdict from an evaluator that edited
  // the code it grades cannot be trusted). Reverts BEFORE the verdict file is written so it records it.
  if (snap) {
    const mutated = enforceArtifactIntegrity(workspaceDir, snap, integrityDeps);
    if (mutated.length) {
      verdict.verdict = "fail";
      verdict.blocking.unshift(
        `Integrity violation: the evaluator wrote ${mutated.length} artifact file(s) during exercise (reverted): ${mutated.join(", ")}. Verdict cannot be trusted.`
      );
      warn(`Integrity violation for ${item.id} round ${round}: evaluator wrote ${mutated.length} artifact file(s) (reverted): ${mutated.join(", ")}.`);
    }
  }

  // Holdout wall: the evaluator is allowed to SEE holdout, but its verdict's blocking/notes/
  // assertion-evidence flow back into the NEXT generator round as feedback (src/phases/build.ts)
  // — and the raw output is recorded to disk — so any holdout the evaluator quoted must be
  // redacted here, exactly as the interactive runRole path does. Without this, holdout leaks to
  // the generator through feedback.
  if (holdoutLines(holdoutText).length) {
    verdict.blocking = verdict.blocking.map((b) => redactHoldout(b, holdoutText));
    verdict.notes = redactHoldout(verdict.notes, holdoutText);
    verdict.assertions = verdict.assertions.map((a) => ({
      id: Number((a as { id?: unknown })?.id ?? 0),
      pass: Boolean((a as { pass?: unknown })?.pass),
      evidence: redactHoldout(String((a as { evidence?: unknown })?.evidence ?? ""), holdoutText),
    }));
  }
  const safeRaw = holdoutLines(holdoutText).length ? redactHoldout(res.resultText, holdoutText) : res.resultText;

  const failedAssertions = verdict.assertions.filter((a) => !a.pass);
  await writeText(
    ctx.paths.verdictFile(item.id, round),
    `# Verdict — ${item.id} round ${round}\n\n- verdict: **${verdict.verdict}**\n- weighted total: **${verdict.weightedTotal}** (threshold ${ctx.config.rubric.passThreshold})\n- scores: design ${verdict.scores.design}, originality ${verdict.scores.originality}, craft ${verdict.scores.craft}, functionality ${verdict.scores.functionality}\n\n## Failed assertions (${failedAssertions.length}/${verdict.assertions.length})\n${failedAssertions.map((a) => `- #${a.id}: ${a.evidence}`).join("\n") || "_none_"}\n\n## Blocking\n${verdict.blocking.map((b) => `- ${b}`).join("\n") || "_none_"}\n\n## Notes\n${verdict.notes}\n\n---\n\n<details><summary>raw evaluator output</summary>\n\n${safeRaw}\n\n</details>\n`
  );

  if (verdict.verdict === "pass") ok(`${item.id} PASSED round ${round} (${verdict.weightedTotal}).`);
  else warn(`${item.id} FAILED round ${round} (${verdict.weightedTotal}); ${verdict.blocking.length} blocking issue(s).`);

  return { verdict, raw: safeRaw, sessionId: res.sessionId, limitHit: res.limitHit, costUsd: res.costUsd, tokens: res.tokens };
}
