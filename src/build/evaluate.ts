import type { Ctx } from "../context.ts";
import { fill, loadPrompt } from "../prompts.ts";
import { getBackend, runSession } from "../sdk/session.ts";
import type { RunResult, RunSessionParams } from "../sdk/session.ts";
import type { LimitHit } from "../sdk/backend.ts";
import { evaluatorGuard } from "../sdk/guard.ts";
import { skillsForRole } from "../sdk/skills.ts";
import { buildExerciser, exerciseRunInstruction, type Exerciser } from "../sdk/exercise.ts";
import { snapshotArtifact, enforceArtifactIntegrity, realIntegrityDeps, type IntegrityDeps } from "./integrity.ts";
import { exerciseScratchEnabled } from "./exerciseScratch.ts";
import { isLinkedWorktree } from "../util/git.ts";
import { buildReadDirs } from "./readscope.ts";
import { budgetExceeded, costUsdOrZero } from "./budget.ts";
import { extractAllJson, extractJsonWhere } from "../util/extract.ts";
import { verdictReaskPrompt } from "./jsonReask.ts";
import { writeText } from "../util/io.ts";
import { info, ok, warn } from "../util/log.ts";
import { readMemory, memorySection } from "../memory.ts";
import { readHoldout, holdoutSection, redactHoldout, holdoutLines } from "./holdout.ts";
import { calibrationText, existingTestsText, rubricText } from "./modeText.ts";
import { RUBRIC_CRITERIA, type ExerciseStatus, type Verdict, type WorkItem } from "./types.ts";
import type { RoleConfig, SparraConfig } from "../config.ts";
import { createSandboxSessionEnv, judgeCapabilityNotesText, withJudgeSandboxFlag } from "./judgeScratch.ts";

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

function parseExerciseStatus(v: unknown): ExerciseStatus {
  return v === "blocked" || v === "mixed" ? v : "ran";
}

function unrunIdsFrom(v: unknown): number[] {
  const raw = v as { unrunAssertionIds?: unknown; unRunAssertionIds?: unknown; unrunAssertions?: unknown };
  const arr = raw?.unrunAssertionIds ?? raw?.unRunAssertionIds ?? raw?.unrunAssertions;
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
}

function runnableAssertions(assertions: Verdict["assertions"], unrunIds: number[]): Verdict["assertions"] {
  const unrun = new Set(unrunIds);
  return assertions.filter((a) => !unrun.has(a.id));
}

function allAssertionsUnrun(assertions: Verdict["assertions"], unrunIds: number[]): boolean {
  return assertions.length > 0 && runnableAssertions(assertions, unrunIds).length === 0;
}

/** How much verdict signal an object carries: any of `scores` (object), `verdict`, `weightedTotal`. */
function verdictSignal(o: Record<string, unknown>): number {
  return (o.scores && typeof o.scores === "object" ? 1 : 0) + ("verdict" in o ? 1 : 0) + ("weightedTotal" in o ? 1 : 0);
}

/** Among all parsed JSON blocks, the one bearing the MOST verdict signal — so an incidental
 *  command-output/config object (zero signal) is never mistaken for the verdict. Returns undefined
 *  when NO block carries any signal (then the wrong-shape re-ask falls back to the generic prompt). */
function bestVerdictLike(blocks: unknown[]): Record<string, unknown> | undefined {
  let best: Record<string, unknown> | undefined;
  let bestScore = 0;
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    const o = b as Record<string, unknown>;
    const s = verdictSignal(o);
    if (s > bestScore) {
      bestScore = s;
      best = o;
    }
  }
  return best;
}

/** Which required verdict fields the candidate is missing/invalid — distinguishing a missing/
 *  non-object `scores` from a missing `verdict`/`weightedTotal` — to name in the targeted re-ask. */
function missingVerdictFields(candidate: Record<string, unknown>): string[] {
  const missing: string[] = [];
  if (!candidate.scores || typeof candidate.scores !== "object") missing.push("scores");
  if (!("verdict" in candidate) && !("weightedTotal" in candidate)) missing.push("verdict");
  return missing;
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
  /** The build run id (`ctx.store.data.build.runId`). When given, the verdict file lands in a
   *  RUN-SCOPED subdir so two build runs that reuse item ids never clobber each other; a resumed run
   *  reuses the same id and keeps writing alongside its own earlier rounds. */
  runId?: string;
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
  /** Injectable for tests; defaults to the real `buildExerciser`. Lets a test assert the
   *  harness-status override without driving a live model through run_command. */
  buildExerciserFn?: (config: SparraConfig, workspaceDir: string, opts?: { inProcessMcp?: boolean }) => Exerciser;
}): Promise<EvalOutput> {
  const { ctx, item, contractText, workspaceDir, round } = args;
  const role = args.role ?? ctx.config.roles.evaluator;
  const run = args.runSessionFn ?? runSession;
  // Capability-driven exercise wiring: only a backend that can HOST the in-process exercise MCP
  // server (createSdkMcpServer via req.mcpServers) gets it attached — on a backend without
  // inProcessMcp (Codex) the server is silently dropped, so we degrade to native-runner guidance and
  // never attach the phantom tool. Resolve via the SAME registry `runSession` uses (no hardcoded id).
  const inProcessMcp = getBackend(role.backend).capabilities.inProcessMcp;
  const exerciser = (args.buildExerciserFn ?? buildExerciser)(ctx.config, workspaceDir, { inProcessMcp });
  // Only relax the Codex exercise sandbox to workspace-write on an isolated-checkout boundary — a
  // Sparra build branch OR a linked git worktree (the integrity guard needs git to revert). Carries
  // `exerciseScratch` + arms the source-integrity guard. `isLinkedWorktree` is computed lazily.
  const exerciseScratch = exerciseScratchEnabled({
    judge: true,
    sandbox: ctx.config.exercise.sandbox,
    hasBranch: !!ctx.store.data.build.branch,
    isWorktree: () => isLinkedWorktree(workspaceDir),
  });
  const integrityDeps = args.integrityDeps ?? realIntegrityDeps();

  const system = fill(await loadPrompt(ctx.paths, "evaluator"), {
    EXERCISE_GUIDANCE: exerciser.guidance,
    // Backend-aware PROCESS-step run-instruction: a no-inProcessMcp evaluator's STATIC template must
    // carry NO `mcp__exercise__` mandate (it has no such tool) — same `inProcessMcp` flag threaded above.
    EXERCISE_RUN_INSTRUCTION: exerciseRunInstruction(inProcessMcp),
    EXISTING_TESTS: existingTestsText(ctx),
    RUBRIC: rubricText(ctx),
    CALIBRATION: calibrationText(ctx),
  });
  const memory = memorySection(args.priorLearnings ?? (await readMemory(ctx.paths)));
  const holdoutText = await readHoldout(ctx);
  const holdout = holdoutSection(holdoutText);

  // KNOWN sandbox-capability matrix for THIS judge (empty for a no-OS-sandbox Claude backend). A
  // sandboxed Codex judge is told up front that e.g. unix-domain-socket LISTEN is policy-denied even
  // with a writable scratch TMPDIR, so a socket-dependent gate is classified UN-RUN, not re-proved.
  const capabilityNotes = judgeCapabilityNotesText({
    backendId: role.backend ?? "claude",
    hasOsSandbox: getBackend(role.backend).capabilities.sandbox,
    sandboxMode: exerciseScratch ? "workspace-write" : "read-only",
    scratchEnabled: exerciseScratch,
  });

  const task = `Adversarially evaluate work item ${item.id}: ${item.title} (round ${round}).

The artifact is in: ${workspaceDir}

AGREED CONTRACT (grade against THIS, not the plan prose):
---
${contractText}
---
${holdout}${memory}${capabilityNotes}Exercise the artifact for real, check every assertion with evidence, score the rubric, and emit the JSON verdict exactly as specified in your instructions.`;

  info(`Evaluating ${item.id} (round ${round}) with ${role.model} — exercising via ${ctx.config.exercise.mechanism}…`);
  // Snapshot the artifact surface before an exercise that may write (Codex workspace-write); the
  // source-integrity guard reverts + reports any artifact mutation the evaluator makes below.
  const snap = exerciseScratch ? snapshotArtifact(workspaceDir, integrityDeps) : undefined;
  const baseReq: RunSessionParams = {
    role: `evaluator-${item.id}-r${round}`,
    prompt: task,
    systemPrompt: system,
    backend: role.backend,
    model: role.model,
    effort: role.effort,
    cwd: workspaceDir,
    additionalDirectories: buildReadDirs(ctx, workspaceDir),
    tools: ["Read", "Glob", "Grep", "Bash"],
    // Writable-scratch session env: redirect TMPDIR / clang cache into a per-run scratch dir so a
    // read-only Codex sandbox / unwritable $HOME doesn't EPERM Vitest's temp writes, the tsx IPC
    // socket PATH, or clang's ModuleCache before the exercise runs; SWIFTPM_CACHE_DIR points at the
    // DURABLE worktree-local cache the provisioning prewarm filled, so an offline `swift build`
    // reuses it. NB: PATH writability only — the sandbox still denies unix-socket LISTEN as policy.
    // SPARRA_JUDGE_SANDBOX=1 (judge-only) makes the socket-dependent real-bin/tsx suites vitest-SKIP
    // under this evaluator, so the full suite is expected green and a nonzero exit is a real signal.
    env: withJudgeSandboxFlag(createSandboxSessionEnv(ctx.config, workspaceDir)),
    skills: skillsForRole(ctx, "evaluator"),
    // Attach the in-process exercise server ONLY to a backend that can host it; a Codex evaluator
    // would silently drop it, so it exercises via its native runner (see guidance) instead.
    ...(inProcessMcp ? { allowedTools: exerciser.allowedTools, mcpServers: exerciser.mcpServers } : {}),
    readOnly: true,
    ...(exerciseScratch ? { exerciseScratch: true } : {}),
    ...evaluatorGuard(ctx),
    maxTurns: ctx.config.build.maxTurnsPerSession,
    maxBudgetUsd: args.maxBudgetUsd ?? ctx.config.build.maxBudgetUsdPerItem,
    traceDir: args.traceDir,
    traceSeq: args.traceSeq,
  };
  const res = await run(baseReq);
  let resultText = res.resultText;
  let costUsd = costUsdOrZero(res.costUsd);
  let tokens = res.tokens;

  // Shape-aware: the verdict is the JSON with rubric scores — not just the last
  // fenced block (evaluator output is full of incidental JSON/command snippets).
  const isVerdict = (v: any) =>
    v && typeof v === "object" && v.scores && typeof v.scores === "object" && ("verdict" in v || "weightedTotal" in v);
  let parsed = extractJsonWhere<Verdict>(resultText, isVerdict);

  // JSON re-ask (build.jsonReask): resume the session ONCE when we couldn't parse a verdict.
  // Two shapes: NO parseable JSON at all → a generic "re-emit the JSON block" prompt; a JSON
  // block of the WRONG shape (≥1 block but none passes isVerdict) → a TARGETED prompt naming the
  // required fields the best verdict-like candidate is missing (a generic re-ask can't fix a
  // block that was already emitted). ONE resumed re-emit call inside this step; never on a
  // provider-limit reply (the round loop's fallback chain owns those), and skipped when this
  // session already exhausted the item budget. If the re-ask still yields no valid verdict,
  // behavior is today's forced-FAIL fallback below (unchanged).
  const itemBudget = args.maxBudgetUsd ?? ctx.config.build.maxBudgetUsdPerItem;
  const allBlocks = extractAllJson(resultText);
  const noJson = allBlocks.length === 0;
  if (!parsed && !res.limitHit && ctx.config.build.jsonReask && !budgetExceeded(itemBudget, costUsd)) {
    const candidate = noJson ? undefined : bestVerdictLike(allBlocks);
    const reaskPrompt = candidate
      ? verdictReaskPrompt(missingVerdictFields(candidate))
      : "Your previous reply had no parseable JSON verdict. Re-emit ONLY the JSON block per your instructions — nothing else.";
    warn(
      `Evaluator for ${item.id} returned ${candidate ? "a wrong-shape" : "no parseable"} verdict — re-asking once for the JSON block.`
    );
    const retry = await run({
      ...baseReq,
      role: `evaluator-${item.id}-r${round}-reask`,
      prompt: reaskPrompt,
      resume: res.sessionId,
    });
    costUsd += costUsdOrZero(retry.costUsd);
    tokens += retry.tokens;
    const reparsed = extractJsonWhere<Verdict>(retry.resultText, isVerdict);
    if (reparsed) {
      parsed = reparsed;
      resultText = `${res.resultText}\n\n${retry.resultText}`;
    }
  }

  // INFRA guard: backend signalled a limit, empty completion, or 0-turn "never ran" AND no
  // parseable verdict was produced. Skip the forced-FAIL synthesis and disk write; surface
  // limitHit so build.ts onLimit gives the round back. A genuine model-ran-but-unparseable
  // result (numTurns>=1, no limitHit) falls through to the forced FAIL below — that IS a
  // fail-worthy signal (the model ran and produced garbage output, which is behavioral).
  if (!parsed && (res.limitHit || res.emptyCompletion || res.numTurns === 0)) {
    warn(`Evaluator for ${item.id} round ${round}: infra result (${res.limitHit?.kind ?? "empty-completion"}) — not consuming as a FAIL round.`);
    return {
      verdict: {
        assertions: [],
        scores: { design: 0, originality: 0, craft: 0, functionality: 0 },
        weightedTotal: 0,
        verdict: "fail",
        unrunAssertionIds: [],
        blocking: [],
        notes: "infra-retry",
      },
      raw: resultText,
      sessionId: res.sessionId,
      limitHit: res.limitHit,
      costUsd,
      tokens,
    };
  }

  // The harness — not the model's self-report — decides whether run_command/http_request
  // verifications actually ran (from real exit codes); when it's not "none" it OVERRIDES the
  // model's `exerciseStatus`, on both the parsed and the no-parseable-verdict paths below.
  const harnessStatus = exerciser.exerciseStatus();
  const decideStatus = (modelStatus: ExerciseStatus): ExerciseStatus => (harnessStatus !== "none" ? harnessStatus : modelStatus);

  let verdict: Verdict;
  let capNote = ""; // set when the anchor cap actually lowered the functionality score
  if (!parsed || !parsed.scores) {
    warn(`Evaluator for ${item.id} returned no parseable verdict — treating as FAIL.`);
    verdict = {
      assertions: [],
      scores: { design: 0, originality: 0, craft: 0, functionality: 0 },
      weightedTotal: 0,
      verdict: "fail",
      // A missing verdict is a real failure, not a block — UNLESS the harness observed a blocked
      // exercise (then it's inconclusive, not a behavioral fail to feed back).
      exerciseStatus: decideStatus("ran"),
      unrunAssertionIds: [],
      blocking: ["Evaluator did not produce a parseable JSON verdict; re-run."],
      notes: "no verdict parsed",
    };
  } else {
    // Clamp scores and recompute the weighted total ourselves.
    for (const c of RUBRIC_CRITERIA) {
      const v = Number(parsed.scores[c] ?? 0);
      parsed.scores[c] = Math.max(0, Math.min(100, isFinite(v) ? v : 0));
    }
    // Anchor functionality to the assertion outcomes (rubric.anchorFunctionality): with any
    // FAILED assertion, functionality is CEILINGED at round(100 × passed/total) — a cap only
    // lowers, never raises, so an already-low score stands. Zero assertions → no cap (nothing
    // to anchor to; also guards the division).
    if (ctx.config.rubric.anchorFunctionality) {
      const asserts = Array.isArray(parsed.assertions) ? parsed.assertions : [];
      const unrunIds = unrunIdsFrom(parsed);
      const runnable = runnableAssertions(
        asserts.map((a) => ({
          id: Number((a as { id?: unknown })?.id ?? 0),
          pass: Boolean((a as { pass?: unknown })?.pass),
          evidence: String((a as { evidence?: unknown })?.evidence ?? ""),
        })),
        unrunIds
      );
      const passed = runnable.filter((a) => a.pass).length;
      if (runnable.length > 0 && passed < runnable.length) {
        const cap = Math.round((100 * passed) / runnable.length);
        if (parsed.scores.functionality > cap) {
          capNote = `functionality capped at ${cap} (model scored ${parsed.scores.functionality}; ${passed}/${runnable.length} assertions passed${unrunIds.length ? `; ${unrunIds.length} un-run excluded` : ""} — rubric.anchorFunctionality)`;
          parsed.scores.functionality = cap;
        }
      }
    }
    const weighted = computeWeighted(ctx, parsed.scores);
    const modelSaidPass = parsed.verdict === "pass";
    const meetsThreshold = weighted >= ctx.config.rubric.passThreshold;
    // A BLOCKED exercise is inconclusive — it can NEVER be a pass (we couldn't verify), so an
    // unverified item is never silently accepted regardless of the model's verdict or score. The
    // harness-overridden status (not the raw self-report) gates the pass.
    const finalStatus = decideStatus(parseExerciseStatus(parsed.exerciseStatus));
    const isBlocked = finalStatus === "blocked";
    const assertions = Array.isArray(parsed.assertions)
      ? parsed.assertions.map((a) => ({
          id: Number((a as { id?: unknown })?.id ?? 0),
          pass: Boolean((a as { pass?: unknown })?.pass),
          evidence: String((a as { evidence?: unknown })?.evidence ?? ""),
        }))
      : [];
    const unrunAssertionIds = unrunIdsFrom(parsed).filter((id) => assertions.some((a) => a.id === id));
    const allUnrun = allAssertionsUnrun(assertions, unrunAssertionIds);
    verdict = {
      assertions,
      unrunAssertionIds,
      scores: parsed.scores,
      weightedTotal: weighted,
      verdict: modelSaidPass && meetsThreshold && !isBlocked && !allUnrun ? "pass" : "fail",
      exerciseStatus: finalStatus,
      blocking: Array.isArray(parsed.blocking) ? parsed.blocking : [],
      notes: parsed.notes ?? "",
    };
  }

  // Observed-run gate: a parsed PASS with ZERO observed mcp__exercise__ activity rests on pure
  // self-report — the override above never fired. Where run_command/http_request ARE the exercise
  // path (cli|web) and `exercise.requireObservedRun` is on, demote the pass to fail with a blocking
  // note. ios/computer-use/custom are exempt (exercising legitimately flows through tools the
  // classifier can't see); failing verdicts and the no-parseable-verdict path are untouched.
  // Backend-aware: the gate can only fire when an observed run was actually POSSIBLE — i.e. the
  // eval backend hosts the in-process MCP server. On a no-inProcessMcp backend (Codex) the server
  // was never attached, so `harnessStatus === "none"` is EXPECTED and must NOT falsely-fail an
  // otherwise-honest pass.
  const mech = ctx.config.exercise.mechanism;
  const observedRunGateApplies = inProcessMcp && ctx.config.exercise.requireObservedRun && (mech === "cli" || mech === "web");
  if (verdict.verdict === "pass" && harnessStatus === "none" && observedRunGateApplies) {
    verdict.verdict = "fail";
    verdict.blocking.push(
      "Unobserved pass: no mcp__exercise__ activity backed this pass; run gating commands via run_command so the harness can observe them."
    );
    warn(`${item.id} round ${round}: pass demoted to fail — no mcp__exercise__ activity observed (mechanism ${mech}).`);
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
  const safeRaw = holdoutLines(holdoutText).length ? redactHoldout(resultText, holdoutText) : resultText;

  const unrunIds = verdict.unrunAssertionIds ?? [];
  const unrun = new Set(unrunIds);
  const failedAssertions = verdict.assertions.filter((a) => !a.pass && !unrun.has(a.id));
  const unrunAssertions = verdict.assertions.filter((a) => unrun.has(a.id));
  const runnableCount = verdict.assertions.length - unrunAssertions.length;
  await writeText(
    ctx.paths.verdictFile(item.id, round, args.runId),
    `# Verdict — ${item.id} round ${round}\n\n- verdict: **${verdict.verdict}**\n- weighted total: **${verdict.weightedTotal}** (threshold ${ctx.config.rubric.passThreshold})\n- scores: design ${verdict.scores.design}, originality ${verdict.scores.originality}, craft ${verdict.scores.craft}, functionality ${verdict.scores.functionality}\n- exercise status: **${verdict.exerciseStatus ?? "ran"}**\n- un-run assertions: ${unrunIds.length ? unrunIds.map((id) => `#${id}`).join(", ") : "_none_"}\n${capNote ? `- ${capNote}\n` : ""}\n## Failed assertions (${failedAssertions.length}/${runnableCount} runnable)\n${failedAssertions.map((a) => `- #${a.id}: ${a.evidence}`).join("\n") || "_none_"}\n\n## Un-run assertions (no signal)\n${unrunAssertions.map((a) => `- #${a.id}: ${a.evidence}`).join("\n") || "_none_"}\n\n## Blocking\n${verdict.blocking.map((b) => `- ${b}`).join("\n") || "_none_"}\n\n## Notes\n${verdict.notes}\n\n---\n\n<details><summary>raw evaluator output</summary>\n\n${safeRaw}\n\n</details>\n`
  );

  if (verdict.verdict === "pass") ok(`${item.id} PASSED round ${round} (${verdict.weightedTotal}).`);
  else warn(`${item.id} FAILED round ${round} (${verdict.weightedTotal}); ${verdict.blocking.length} blocking issue(s).`);

  return { verdict, raw: safeRaw, sessionId: res.sessionId, limitHit: res.limitHit, costUsd, tokens };
}
