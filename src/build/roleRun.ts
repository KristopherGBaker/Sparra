import path from "node:path";
import type { Ctx } from "../context.ts";
import type { RoleConfig } from "../config.ts";
import { fill, loadPrompt } from "../prompts.ts";
import { getBackend, runSession } from "../sdk/session.ts";
import type { RunResult, RunSessionParams } from "../sdk/session.ts";
import type { LimitHit } from "../sdk/backend.ts";
import { evaluatorGuard, readOnlyGuard, scopedWriterGuard, type Guard } from "../sdk/guard.ts";
import { skillsForRole } from "../sdk/skills.ts";
import { buildExerciser, exerciseRunInstruction, nativeRunnerGuidance, type Exerciser } from "../sdk/exercise.ts";
import { buildReadDirs } from "./readscope.ts";
import { gateSandbox } from "./sandbox.ts";
import { snapshotArtifact, enforceArtifactIntegrity, realIntegrityDeps, type IntegrityDeps } from "./integrity.ts";
import { randomUUID } from "node:crypto";
import { readHoldout, holdoutSection, assertNoHoldoutLeak, holdoutLines, redactHoldout, makeHoldoutReadDecider } from "./holdout.ts";

// Re-exported for the interactive runner's existing importers (and tests) — the implementation
// now lives in holdout.ts so the autonomous build-loop forbid roles share the exact same wall.
export { makeHoldoutReadDecider };
import { contractModeClauses, deviationPolicy, rubricText, calibrationText, existingTestsText, selfVerifyGuidance } from "./modeText.ts";
import { RE_CRITIQUE_INSTRUCTION } from "./contract.ts";
import { appleConventions, isApplePlatform } from "./swiftConventions.ts";
import { readMemory, memorySection } from "../memory.ts";
import { RUBRIC_CRITERIA, type ExerciseStatus, type Verdict } from "./types.ts";
import { extractJsonWhere } from "../util/extract.ts";
import { exists, readText, writeText, stampFromDate } from "../util/io.ts";
import { addWipWorktree, changedFiles, fileContentHash, isLinkedWorktree, removeWipWorktree } from "../util/git.ts";
import { provisionWorkspaceDeps } from "../util/provision.ts";
import { exerciseScratchEnabled } from "./exerciseScratch.ts";
import { costUsdOrZero } from "./budget.ts";
import { REPORT_REASK_MAX_BUDGET_USD, reportReaskOverrides } from "./jsonReask.ts";
import { normalizeOutCapture } from "./outCapture.ts";
import { mergedBuildEnv } from "./env.ts";
import { createJudgeScratch, judgeSandboxEnv, judgeCapabilityNotesText } from "./judgeScratch.ts";
import { environmentNotesSection } from "../environment.ts";
import { info, warn } from "../util/log.ts";

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

/** The SANDBOXED JUDGE roles: the evaluator and the contract-evaluator. Both run under a native
 *  sandbox and exercise/probe the artifact (`npm test`, `swift build`), so both get the default
 *  writable-scratch env layer AND the isolated-checkout workspace-scratch carve-out. */
function isSandboxedJudge(kind: RoleKind): boolean {
  return kind === "evaluator" || kind === "contract-evaluator";
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
  /** Re-critique input for a `contract-evaluator` run: paths to this contract's PRIOR-round
   *  critiques, in round order (Round 1 first). The RUNNER — trusted, unlike the role — reads each
   *  file itself and inlines it (labeled `--- Round N critique ---`) ahead of the contract text,
   *  prefixed with the autonomous loop's `RE_CRITIQUE_INSTRUCTION`, so a fresh evaluator session
   *  grades the DELTA instead of relitigating settled points. Because the runner does the read, a
   *  path under `.sparra/` works even though the role's own readscope excludes it. A missing/
   *  unreadable path FAILS CLOSED (throws, naming the path) — bad conductor input, not a silent
   *  skip. Meaningful only for `contract-evaluator`; supplying it to any other role kind is a hard
   *  error. Absent/empty → today's behavior, byte-for-byte. */
  priorCritiquePaths?: string[];
  /** Holdout file (evaluator-only). Defaults to the project holdout. Pass a PATH, never contents.
   *  If given and missing, the run FAILS CLOSED (throws) rather than silently running without it. */
  holdoutPath?: string;
  /** Where to write the normalized verdict (evaluator) / result (others). */
  out?: string;
  /** Backend/model/effort overrides; else the role's config defaults. */
  backend?: string;
  model?: string;
  effort?: RoleConfig["effort"];
  /** Per-call USD budget override (the per-session cap). When omitted, falls back to
   *  `build.maxBudgetUsdPerItem` (behavior unchanged). `0` means unlimited (see budget.ts) —
   *  threaded with nullish-coalescing so a supplied `0` is preserved, not dropped. */
  maxBudgetUsd?: number;
  /** Opt the writer/generator role into the `allowVerifyBash` allow-hook even on an in-place run
   *  that has no `build.branch` — so an interactive `run_role` (the `/sparra-loop` path) can auto-run
   *  its project's `build.verifyCommands` (typecheck/test/build) on a hooks-only backend without each
   *  gate hitting the permission wall. Reuses the SAME strict allow-decider; the opt-in only drops the
   *  branch precondition. Default (undefined/false) preserves today's behavior. No-op for non-writer
   *  roles (only `scopedWriterGuard` consumes it). */
  allowVerify?: boolean;
  /** Run the role in a TEMPORARY linked git worktree snapshotted from the CURRENT working tree of
   *  the selected workspace (WIP-faithful: uncommitted tracked edits, untracked non-ignored files,
   *  tracked deletions) — so an in-place `sparra eval` gets writable exercise scratch (the
   *  linked-worktree branch of `exerciseScratchEnabled`) without manual `git worktree add` +
   *  node_modules copying. Read-only judge roles only (evaluator, reviewer); a WRITER is rejected
   *  (the generator gets its build worktree via the full loop). Torn down after the run. */
  useWorktree?: boolean;
  /** With `useWorktree`: keep the temp worktree after the run (its path is printed) instead of
   *  removing it — for inspecting exactly what was graded. */
  keepWorktree?: boolean;
  /** Source dir for dep provisioning (node_modules etc.) into a linked-worktree workspace. The
   *  temp-worktree wrapper sets this to the SELECTED source dir (the dir the worktree was
   *  snapshotted from) so `sparra eval <other-dir> --worktree` provisions THAT project's deps —
   *  never ctx.root's. Defaults to ctx.root (the pre-existing behavior for a plain
   *  `role run --workspace <linked-worktree>`, whose worktrees are cut from ctx.root). */
  depSourceDir?: string;
  /** Resume a prior role-run's backend session — so an iterate round (e.g. re-running the
   *  generator with feedback) doesn't re-read the whole worktree from scratch. Pass the
   *  `sessionId` AND `backend` returned by the previous RoleRunResult. A session id isn't
   *  portable across backends, so on a backend switch the resume is IGNORED (fresh session +
   *  a warning). Mirrors the build loop's generatorSessionId/generatorBackend. */
  resumeSessionId?: string;
  resumeBackend?: string;
  /** Injectable for tests; defaults to the real backend session. */
  runSessionFn?: (p: RunSessionParams) => Promise<RunResult>;
  /** Injectable for tests; defaults to the real COW dep provisioner. Lets a test assert the
   *  worktree-workspace gets node_modules provisioned without a real `cp`. */
  provisionFn?: typeof provisionWorkspaceDeps;
  /** Injectable for tests; defaults to the real git/fs source-integrity deps. */
  integrityDeps?: IntegrityDeps;
  /** Injectable for tests; lists the workspace's changed/untracked files (abs paths) — used to
   *  detect a writer that produced ZERO file changes (the permission-starved no-progress case).
   *  Defaults to `changedFiles` (git status --porcelain). */
  changedFilesFn?: (workspace: string) => string[];
  /** Injectable for tests; content-hashes a single file (abs path) so writer progress is detected
   *  by per-file CONTENT comparison, not path-set membership — an edit to a file already dirty at
   *  run start (the normal continuation/fix-round case) is real progress. Called ONLY on the union
   *  of the before/after changed-file sets (bounded cost; clean untouched files are never read).
   *  Defaults to `fileContentHash` (sha-256 of the bytes, or `ABSENT_CONTENT` if unreadable). */
  hashFileFn?: (file: string) => string;
  /** Injectable for tests; defaults to the real `buildExerciser` (evaluator role only). Lets a test
   *  assert the harness-status override without driving a live model through run_command. */
  buildExerciserFn?: (config: Ctx["config"], workspace: string, opts?: { inProcessMcp?: boolean }) => Exerciser;
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
  /** Path the AUTO-PERSISTED, holdout-redacted verdict was written to (evaluator role only). Always
   *  set for an evaluator run — independent of `out` — so an interactive/loop cycle leaves
   *  evaluator-side evidence (scores, failed assertions, blocking reasons) on disk for `sparra
   *  reflect`, whose bundle rightly excludes the holdout-bearing evaluator traces. Uniquely named,
   *  so runs that reuse item ids never clobber each other. */
  verdictPath?: string;
  /** Dir the run streamed its transcript to (`NN-role.md` inside). For a non-evaluator role this
   *  is holdout-free (holdout is dropped from its scope) and the conductor may tail it for live
   *  progress; the EVALUATOR's trace dir is holdout-bearing and is NOT exposed over MCP. */
  traceDir: string;
  sessionId: string;
  costUsd: number;
  tokens: number;
  errors: string[];
  /** Set when the FINAL attempt still hit a provider rate/usage/session limit (or an empty
   *  completion classified as one). The conductor should treat this as "retry / fall back",
   *  NOT as a behavioral failure to feed back to the generator. Auto-fallback via
   *  `roles.<role>.fallback` is tried first; this is set only if the whole chain was exhausted. */
  limitHit?: LimitHit;
  /** Set for a WRITER role (generator) that finished WITHOUT changing any file — the
   *  permission-starved / blocked-brief signature (the failure where every read was denied and the
   *  run produced nothing while burning tokens). Like `limitHit`, the conductor should treat this
   *  as "investigate the brief/permissions", NOT a behavioral FAIL to feed back to the generator.
   *  Never set when `limitHit` is (a limited run legitimately did nothing). */
  noProgress?: boolean;
  /** Set when the run stopped at the per-session turn cap (`build.maxTurnsPerSession`) with work
   *  unfinished — NOT a behavioral failure. The conductor should RESUME the same session
   *  (`resumeSessionId` + `resumeBackend` = this result's `sessionId`/`backend`) to continue where
   *  it left off, exactly as the build loop does, rather than re-reading the workspace or treating
   *  it as a FAIL. */
  hitMaxTurns?: boolean;
  /** Set for a WRITER role whose run ended with an empty completion (the backend's explicit
   *  marker) or a budget-cap death, but whose files DID change — the work LANDED; only the
   *  completion report failed to emit. NOT a behavioral failure and NOT a limit ("nothing ran"):
   *  the conductor should RESUME the session (`resumeSessionId` + `resumeBackend` = this result's
   *  `sessionId`/`backend`) to re-emit the report, or accept the landed work as-is — never re-run
   *  the item from scratch (a second generator would clobber what landed) and never feed it back
   *  as a FAIL. */
  emptyCompletion?: boolean;
  /** ALWAYS populated for a WRITER role, however the run ended: the count of newly-changed paths
   *  (present after the run that were not in the pre-run snapshot). Telemetry, not a
   *  classification flag — >0 means work landed on disk, so the conductor can distinguish "empty
   *  result but the work is there" from "empty and nothing happened" without a git probe of its
   *  own. */
  filesChanged?: number;
  /** Set when the run stopped on OUR OWN per-call USD cap (`maxBudgetUsd` /
   *  `build.maxBudgetUsdPerItem`) — not a provider `limitHit`, not a turn cap. Telemetry, not a
   *  behavioral failure: the conductor should RESUME the same session via this result's
   *  `sessionId`/`backend` (raising the cap if warranted) rather than re-running or treating it
   *  as a FAIL. */
  hitBudget?: boolean;
}

/** True when `text` carries a parseable GENERATOR completion report — a JSON block with a
 *  `report`/`deviations` field (the writer's self-report shape, mirroring `generate.ts`'s
 *  `isReport`). Used to decide whether a turn-capped writer forfeited its report: empty text,
 *  prose with no JSON, and incidental/wrong-shape JSON all return false (→ recover via re-ask),
 *  while a properly-shaped report returns true (→ nothing to recover). */
function hasCompletionReport(text: string): boolean {
  const isReport = (v: any) => v && typeof v === "object" && ("report" in v || "deviations" in v);
  return !!extractJsonWhere(text, isReport);
}

/** Recompute the weighted rubric total ourselves (don't trust model arithmetic). */
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

/** Fill the union of placeholders the standard role prompts use. Unknown placeholders are
 *  left visible (a misconfigured custom prompt should be obvious, not silently blanked). */
async function roleSystemPrompt(
  ctx: Ctx,
  kind: RoleKind,
  exerciseGuidance: string,
  allowVerify = false,
  inProcessMcp = true
): Promise<string> {
  const template = await loadPrompt(ctx.paths, SPECS[kind].promptName);
  return fill(template, {
    MODE: ctx.store.data.mode,
    DEVIATION: ctx.config.deviation.strictness,
    DEVIATION_POLICY: deviationPolicy(ctx),
    EXERCISE_GUIDANCE: exerciseGuidance,
    // Backend-aware PROCESS-step run-instruction (evaluator template only): threaded per attempt so a
    // Codex evaluator's STATIC prompt carries no phantom `mcp__exercise__` mandate. Default true keeps
    // the base (non-attempt) assembly and every non-evaluator role byte-identical.
    EXERCISE_RUN_INSTRUCTION: exerciseRunInstruction(inProcessMcp),
    EXISTING_TESTS: existingTestsText(ctx),
    RUBRIC: rubricText(ctx),
    CALIBRATION: calibrationText(ctx),
    ASSERTION_MIN: String(ctx.config.contract.assertionMin),
    ASSERTION_MAX: String(ctx.config.contract.assertionMax),
    MODE_CLAUSES: contractModeClauses(ctx),
    SELF_VERIFY: selfVerifyGuidance(ctx, allowVerify),
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

/**
 * Compose the re-critique block a `contract-evaluator` run inlines AHEAD of the contract text — the
 * interactive analogue of the autonomous loop's re-critique seam (`negotiateContract`). The RUNNER
 * (trusted) reads each prior-round critique itself, so a `.sparra/`-resident path works even though
 * the role's own readscope excludes it; the shared `RE_CRITIQUE_INSTRUCTION` (imported from
 * `contract.ts`, never duplicated) prefixes the critiques, each labeled `--- Round N critique ---`
 * in the GIVEN order (Round 1 = the first path). "" when no paths were supplied (today's behavior).
 *
 * Fail-closed: a missing/unreadable path throws (naming it) rather than silently dropping a round,
 * and the option is meaningful ONLY for `contract-evaluator` — supplying it to any other role kind
 * is a hard error (bad conductor input). The composed text is later covered by `assertNoHoldoutLeak`
 * (contract-evaluator is a forbid role), so an inlined critique carrying a holdout line still throws.
 */
async function resolvePriorCritiqueBlock(req: RoleRunRequest): Promise<string> {
  const paths = req.priorCritiquePaths;
  if (!paths || paths.length === 0) return "";
  if (req.roleKind !== "contract-evaluator") {
    throw new Error(
      `priorCritiquePaths is only meaningful for a contract-evaluator run (re-critique rounds); rejected for "${req.roleKind}". Drop it.`
    );
  }
  const labeled: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i]!;
    const text = await readText(p);
    if (text == null) {
      throw new Error(`prior-critique path not found or unreadable: ${p} (refusing to re-critique without the round it names).`);
    }
    labeled.push(`--- Round ${i + 1} critique ---\n${text}`);
  }
  return `${RE_CRITIQUE_INSTRUCTION}\n\nPRIOR CRITIQUES (verify each is resolved):\n${labeled.join("\n\n")}\n\n`;
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

/** Strip holdout quotes from a verdict's conductor-facing strings (the evaluator may
 *  quote holdout; that must not reach the conductor via `--out` or the MCP payload). */
function redactVerdict(v: Verdict, holdoutText: string): Verdict {
  if (!holdoutLines(holdoutText).length) return v;
  return {
    ...v,
    blocking: v.blocking.map((b) => redactHoldout(b, holdoutText)),
    notes: redactHoldout(v.notes, holdoutText),
    // Rebuild each assertion to the exact schema (no spread) so no stray field survives.
    assertions: v.assertions.map((a) => ({ id: a.id, pass: a.pass, evidence: redactHoldout(a.evidence, holdoutText) })),
  };
}

/** Render the interactive verdict markdown — the EXACT bytes written to `--out` today (extracted so
 *  the auto-persisted file reuses the identical header, keeping `--out` byte-unchanged). */
function renderInteractiveVerdict(roleKind: RoleKind, role: RoleConfig, verdict: Verdict, threshold: number): string {
  const unrun = new Set(verdict.unrunAssertionIds ?? []);
  const failed = verdict.assertions.filter((a) => !a.pass && !unrun.has(a.id));
  return `# Verdict — ${roleKind} (${role.backend ?? "claude"}/${role.model})\n\n- verdict: **${verdict.verdict}**\n- weighted total: **${verdict.weightedTotal}** (threshold ${threshold})\n- scores: design ${verdict.scores.design}, originality ${verdict.scores.originality}, craft ${verdict.scores.craft}, functionality ${verdict.scores.functionality}\n- exercise status: **${verdict.exerciseStatus ?? "ran"}**\n- un-run assertions: ${verdict.unrunAssertionIds?.length ? verdict.unrunAssertionIds.map((id) => `#${id}`).join(", ") : "_none_"}\n\n## Failed assertions (${failed.length}/${verdict.assertions.length - (verdict.unrunAssertionIds?.length ?? 0)} runnable)\n${failed.map((a) => `- #${a.id}: ${a.evidence}`).join("\n") || "_none_"}\n\n## Un-run assertions (no signal)\n${verdict.assertions.filter((a) => verdict.unrunAssertionIds?.includes(a.id)).map((a) => `- #${a.id}: ${a.evidence}`).join("\n") || "_none_"}\n\n## Blocking\n${verdict.blocking.map((b) => `- ${b}`).join("\n") || "_none_"}\n\n## Notes\n${verdict.notes}\n`;
}

/** Parse + normalize an evaluator verdict the same way the build loop does.
 *  `harnessStatus` is the exerciser's deterministic verdict on whether the exercise actually ran
 *  (from real `run_command`/`http_request` exit codes); when it's not "none" it OVERRIDES the
 *  model's self-reported `exerciseStatus`, so a model can't launder a harness-observed block into a
 *  pass — and so a blocked-but-unparseable verdict carries "blocked", not the hardcoded "ran". */
export function parseVerdict(ctx: Ctx, resultText: string, harnessStatus: ExerciseStatus | "none" = "none"): Verdict {
  const decide = (modelStatus: ExerciseStatus): ExerciseStatus => (harnessStatus !== "none" ? harnessStatus : modelStatus);
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
      // A missing verdict is a real failure, not a block — UNLESS the harness observed a blocked
      // exercise (then it's inconclusive, not a behavioral fail to feed back).
      exerciseStatus: decide("ran"),
      unrunAssertionIds: [],
      blocking: ["Evaluator did not produce a parseable JSON verdict; re-run."],
      notes: "no verdict parsed",
    };
  }
  for (const c of RUBRIC_CRITERIA) {
    const v = Number(parsed.scores[c] ?? 0);
    parsed.scores[c] = Math.max(0, Math.min(100, isFinite(v) ? v : 0));
  }
  // Anchor functionality to the assertion outcomes (rubric.anchorFunctionality) — the SAME cap
  // the autonomous evaluator applies (evaluate.ts), so an interactive eval scores an artifact
  // identically: with any FAILED assertion, functionality is CEILINGED at
  // round(100 × passed/total) — a cap only lowers, never raises, so an already-low score
  // stands. Zero assertions → no cap (nothing to anchor to; also guards the division). Applied
  // BEFORE computeWeighted so the weighted total reflects it; the interactive Verdict has no
  // capNote channel, so the note is appended to `notes` below.
  let capNote = "";
  const assertions = Array.isArray(parsed.assertions)
    ? parsed.assertions.map((a) => ({
        id: Number((a as { id?: unknown })?.id ?? 0),
        pass: Boolean((a as { pass?: unknown })?.pass),
        evidence: String((a as { evidence?: unknown })?.evidence ?? ""),
      }))
    : [];
  const unrunAssertionIds = unrunIdsFrom(parsed).filter((id) => assertions.some((a) => a.id === id));
  if (ctx.config.rubric.anchorFunctionality) {
    const runnable = runnableAssertions(assertions, unrunAssertionIds);
    const passed = runnable.filter((a) => a.pass).length;
    if (runnable.length > 0 && passed < runnable.length) {
      const cap = Math.round((100 * passed) / runnable.length);
      if (parsed.scores.functionality > cap) {
        capNote = `functionality capped at ${cap} (model scored ${parsed.scores.functionality}; ${passed}/${runnable.length} assertions passed${unrunAssertionIds.length ? `; ${unrunAssertionIds.length} un-run excluded` : ""} — rubric.anchorFunctionality)`;
        parsed.scores.functionality = cap;
      }
    }
  }
  const weighted = computeWeighted(ctx, parsed.scores);
  const finalStatus = decide(parseExerciseStatus(parsed.exerciseStatus));
  // A BLOCKED exercise is inconclusive — it can NEVER be a pass (we couldn't verify), regardless of
  // what the model claimed or the score, so an unverified item is never silently accepted. The
  // harness-overridden status (not the raw self-report) gates the pass.
  const allUnrun = assertions.length > 0 && runnableAssertions(assertions, unrunAssertionIds).length === 0;
  const meets = weighted >= ctx.config.rubric.passThreshold && parsed.verdict === "pass" && finalStatus !== "blocked" && !allUnrun;
  // Normalize to the EXACT schema — the evaluator's JSON is untrusted model output, so
  // drop any extra properties (e.g. a smuggled `holdoutQuote`) that would otherwise ride
  // through to conductor-facing artifacts.
  return {
    assertions,
    unrunAssertionIds,
    scores: parsed.scores,
    weightedTotal: weighted,
    verdict: meets ? "pass" : "fail",
    exerciseStatus: finalStatus,
    blocking: (Array.isArray(parsed.blocking) ? parsed.blocking : []).map((b) => String(b)),
    notes: [String(parsed.notes ?? ""), capNote].filter(Boolean).join(" | "),
  };
}

/**
 * Run a single Sparra role once, enforcing the holdout wall, and return a normalized
 * result (a verdict for the evaluator). The interactive surface never receives holdout
 * contents — only this runner materializes them, and only for the evaluator.
 *
 * `useWorktree` routes through the temp-worktree wrapper below (a WIP-faithful isolated
 * checkout, torn down after the run); the default stays the in-place run, unchanged.
 */
export async function runRole(req: RoleRunRequest): Promise<RoleRunResult> {
  if (req.useWorktree) return runRoleInTempWorktree(req);
  return runRoleInPlace(req);
}

/** Injectable seams for the temp-worktree wrapper — tests use a throwaway git repo + a fake
 *  inner runner; no live model, no recursive real evaluation. */
export interface TempWorktreeDeps {
  /** The inner role runner the wrapper delegates to (defaults to the real in-place run). */
  runRoleFn?: (req: RoleRunRequest) => Promise<RoleRunResult>;
  addWorktreeFn?: typeof addWipWorktree;
  removeWorktreeFn?: typeof removeWipWorktree;
  /** Where to create the temp worktree for a given source dir (defaults to a uniquely-stamped
   *  SIBLING of the source, so a COW dep copy stays on the same volume). */
  worktreeDirFn?: (src: string) => string;
}

/**
 * `sparra eval --worktree` / `role run --worktree`: run a read-only judge role (evaluator,
 * reviewer) in a TEMPORARY linked git worktree snapshotted from the CURRENT working tree of the
 * SELECTED workspace (`req.workspace`, else ctx.root) — WIP-faithful, so grading matches exactly
 * what the user is building. The inner run's `workspace` IS the worktree, so the existing
 * linked-worktree paths (dep provisioning, exercise scratch, source-integrity revert) apply
 * unchanged, and the user's REAL tree is never written to. Teardown (scoped to the temp dir only —
 * it can never touch uncommitted work in the main tree) runs even when the role throws;
 * `keepWorktree` retains the dir and prints its path.
 */
export async function runRoleInTempWorktree(req: RoleRunRequest, deps: TempWorktreeDeps = {}): Promise<RoleRunResult> {
  const { ctx, roleKind } = req;
  if (roleKind !== "evaluator" && roleKind !== "reviewer" && roleKind !== "contract-evaluator") {
    throw new Error(
      `--worktree is supported only for the read-only judge roles (evaluator, reviewer, contract-evaluator); rejected for "${roleKind}" — ` +
        `a generator gets its build worktree via the full loop (\`sparra build\`). Drop --worktree, or use --workspace to point at an existing checkout.`
    );
  }
  const src = req.workspace ?? ctx.root; // the SELECTED source dir — never blindly ctx.root
  const wtDir = (deps.worktreeDirFn ?? defaultTempWorktreeDir)(src);
  const added = (deps.addWorktreeFn ?? addWipWorktree)(src, wtDir);
  if (!added.ok) throw new Error(`--worktree: could not snapshot ${src} into a temp worktree: ${added.out.trim()}`);
  info(`role-run-${roleKind}: temp eval worktree ${wtDir} (WIP snapshot of ${src})`);
  const run = deps.runRoleFn ?? runRoleInPlace;
  try {
    // Deps are provisioned FROM the selected source dir (`src`, the dir the worktree was
    // snapshotted from) — never blindly ctx.root, which is a DIFFERENT project when the user
    // ran `sparra eval <other-dir> --worktree`.
    return await run({ ...req, workspace: wtDir, useWorktree: false, depSourceDir: src });
  } finally {
    if (req.keepWorktree) {
      info(`--keep-worktree: retained temp eval worktree at ${wtDir}`);
    } else {
      const removed = (deps.removeWorktreeFn ?? removeWipWorktree)(src, wtDir);
      if (!removed.ok) warn(`--worktree teardown failed for ${wtDir}: ${removed.out.trim()}`);
    }
  }
}

/** Unique sibling dir for the temp worktree (same volume as the source, so COW dep copies stay cheap). */
function defaultTempWorktreeDir(src: string): string {
  return path.join(path.dirname(src), `${path.basename(src)}-eval-${stampFromDate(new Date())}-${randomUUID().slice(0, 6)}`);
}

/** The in-place role run — the pre-`--worktree` behavior, byte-for-byte. */
async function runRoleInPlace(req: RoleRunRequest): Promise<RoleRunResult> {
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

  // A LINKED-WORKTREE workspace gets BOTH dep provisioning (here) and exercise scratch (Item E,
  // below). Probe `isLinkedWorktree` ONCE and reuse — but only when the workspace differs from the
  // ctx root, so the common in-place case (workspace === ctx.root) never spawns git.
  const onLinkedWorktree = workspace !== ctx.root && isLinkedWorktree(workspace);

  // Provision dep dirs (node_modules) into the worktree so the evaluator's exercise and the
  // generator's verify commands run there without a slow network `npm install`. The full build loop
  // already provisions its build worktree (phases/build.ts); the standalone eval/run_role path never
  // did, so a `sparra eval <worktree>` paid a full install. COW-cheap + idempotent (skips dirs
  // already present); worktree-gated so an arbitrary --workspace dir is never clobbered.
  const provision = req.provisionFn ?? provisionWorkspaceDeps;
  if (onLinkedWorktree && ctx.config.git.provisionDeps.enabled) {
    // Source = the dir the worktree came from: `depSourceDir` when the temp-worktree wrapper cut
    // it from a non-default workspace, else ctx.root (the build loop's own worktrees).
    provision(req.depSourceDir ?? ctx.root, workspace, ctx.config.git.provisionDeps);
  }

  // Optional session resume (e.g. iterating the generator) — only honored when the attempt's
  // backend matches the prior session's; a session id isn't portable across backends (so a
  // fallback to a different backend below naturally starts fresh).
  const resumeFor = (be: string): string | undefined =>
    req.resumeSessionId && (!req.resumeBackend || req.resumeBackend === be) ? req.resumeSessionId : undefined;
  if (req.resumeSessionId && req.resumeBackend && req.resumeBackend !== (role.backend ?? "claude")) {
    warn(
      `role-run-${roleKind}: ignoring resumeSessionId (belongs to backend "${req.resumeBackend}", not "${role.backend ?? "claude"}"; session ids aren't portable) — starting fresh.`
    );
  }

  // Resolve the contract first so a default brief can be gated on its presence (below).
  const contract = req.contract ?? (req.contractPath ? (await readText(req.contractPath)) ?? "" : "");

  let brief = req.brief ?? (req.briefPath ? (await readText(req.briefPath)) ?? "" : "");
  if (!brief.trim()) {
    // Read-only JUDGE roles can synthesize a default brief from their inputs (workspace/contract) —
    // so a config-less `run_role`/`sparra-loop` call needn't hand-write one. Only WRITERS/proposers
    // (generator, contract-generator) must be briefed explicitly. A contract-evaluator still needs
    // *something* to critique, so it requires either a brief or a contract.
    if (isEvaluator(roleKind)) brief = `Evaluate the artifact in ${workspace} against the contract.`;
    else if (roleKind === "reviewer")
      brief = `Review the changes in ${workspace} for correctness, safety, and maintainability.`;
    else if (roleKind === "contract-evaluator") {
      if (!contract.trim())
        throw new Error(`runRole(contract-evaluator) requires a contract (contract or contractPath) to critique, or an explicit brief.`);
      brief = `Critique the proposed "done" contract for fidelity, proportionality, satisfiability, and gameability.`;
    } else throw new Error(`runRole(${roleKind}) requires a non-empty brief (brief or briefPath).`);
  }

  // The runner — not the conductor — is the only context that reads holdout.
  const holdoutText = await resolveHoldout(req);
  const evaluator = isEvaluator(roleKind);

  const exerciser = evaluator ? (req.buildExerciserFn ?? buildExerciser)(ctx.config, workspace) : undefined;
  const system = await roleSystemPrompt(ctx, roleKind, exerciser?.guidance ?? "", req.allowVerify);

  // The exercising evaluator (only) gets writable scratch on an isolated-checkout boundary (a Sparra
  // build branch OR a linked git worktree) so a Codex exercise can write node_modules/.vite-temp etc.;
  // the source-integrity guard reverts any artifact write it makes. Other read-only roles (reviewer,
  // contract-*) never get it. `onLinkedWorktree` was probed once above (git-free for in-place runs).
  const exerciseScratch = exerciseScratchEnabled({
    judge: isSandboxedJudge(roleKind),
    sandbox: ctx.config.exercise.sandbox,
    hasBranch: !!ctx.store.data.build.branch,
    isWorktree: onLinkedWorktree,
  });
  const integrityDeps = req.integrityDeps ?? realIntegrityDeps();

  // Default writable-scratch env layer for the sandboxed judge roles (evaluator + contract-evaluator):
  // redirect TMPDIR / clang+SwiftPM caches into a per-run scratch dir so a read-only Codex sandbox /
  // unwritable $HOME doesn't EPERM Vitest temp writes, the tsx IPC socket PATH, or clang's ModuleCache
  // before the exercise/verify probe even runs. NB: PATH writability only — the sandbox still denies
  // unix-socket LISTEN as policy (see the per-attempt capability notes below), so a tsx-launched
  // socket smoke still UN-RUNs. Other roles keep the plain merged build env.
  const sessionEnv = isSandboxedJudge(roleKind)
    ? judgeSandboxEnv(ctx.config, createJudgeScratch())
    : mergedBuildEnv(ctx.config);

  // Parity context the real roles inject (cheap reads; improves single-shot fidelity).
  const memory = memorySection(await readMemory(ctx.paths));
  const conventions = roleKind === "generator" || roleKind === "reviewer" ? await conventionsBlock(ctx) : "";

  // Prior-round critiques (contract-evaluator re-critique) — read RUNNER-side, inlined AHEAD of the
  // contract text, labeled by round. Throws on a bad path / wrong role kind before any backend call.
  const priorCritiqueBlock = await resolvePriorCritiqueBlock(req);
  const contractBlock = contract.trim() ? `\nAGREED CONTRACT (satisfy/grade against THIS):\n---\n${contract.trim()}\n---\n` : "";
  const environment = roleKind === "generator" ? await environmentNotesSection(ctx.paths) : "";
  let task = `${brief.trim()}\n${environment}${priorCritiqueBlock}${contractBlock}${conventions}${memory}`;
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

  // Forbid roles never get the holdout/.sparra scope granted as readable; the evaluator
  // (allowed to see holdout) keeps the full scope. This shrinks the off-disk read residual
  // (esp. on Codex, which ignores the deny-hook below).
  const readDirs = buildReadDirs(ctx, workspace, { excludeHoldoutScope: !evaluator });

  // Guard: Claude-side permission/hooks. A role can ALWAYS read its own workspace + granted
  // read dirs (auto-approved in-hook, mode-independent), so a writer never silently starves
  // on denied reads. For forbid roles the holdout-read block is folded in as an extra DENY
  // decider — it runs BEFORE the read allow in the same hook, so a holdout/.sparra read still
  // loses even though in-scope reads are granted.
  const readScopes = [workspace, ...(readDirs ?? [])];
  const extraDeny = evaluator ? [] : [makeHoldoutReadDecider(ctx, workspace, req.holdoutPath)];
  const guard: Guard =
    spec.guard === "writer"
      ? scopedWriterGuard(ctx, [workspace], { format: true, verify: true, verifyInPlace: req.allowVerify, readScopes, extraDeny })
      : spec.guard === "evaluator"
        ? evaluatorGuard(ctx, { readScopes, extraDeny })
        : readOnlyGuard(ctx, { readScopes, extraDeny });

  // Reduced-surface, not closed: if a forbid role's readable scope (its cwd or a granted
  // dir) still contains a PRESENT holdout AND it runs on a hooks-ignoring backend (Codex),
  // the on-disk read can't be denied — warn loudly. The prompt-wall + verdict redaction
  // remain the guarantees; we do NOT hard-refuse (that would break legitimate in-place runs).
  if (!evaluator && (role.backend ?? "claude") === "codex") {
    const holdoutFiles = [req.holdoutPath, ctx.paths.holdout, ctx.paths.frozenHoldout]
      .filter((p): p is string => Boolean(p) && exists(p as string))
      .map((p) => path.resolve(p));
    const scopes = [path.resolve(workspace), ...(readDirs ?? []).map((d) => path.resolve(d))];
    const within = (child: string, parent: string) => {
      const rel = path.relative(parent, child);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    };
    const reachable = holdoutFiles.some((f) => scopes.some((s) => within(f, s)));
    if (reachable) {
      warn(
        `role-run-${roleKind}: holdout is reachable on disk for this Codex (hooks-ignoring) role — ` +
          `the .sparra read-scope exclusion can't cover the cwd-resident holdout, and Codex ignores the deny-hook. ` +
          `The prompt-wall (assertNoHoldoutLeak) + verdict redaction are the only guarantees here.`
      );
    }
  }

  // Unique trace dir so repeated role runs don't overwrite each other. Evaluator traces
  // contain holdout by design (the evaluator is allowed to see it) — they live in a
  // role-run subdir; the conductor reads verdicts, not evaluator traces.
  const traceDir =
    req.traceDir ?? path.join(ctx.paths.traces, `role-run-${roleKind}-${stampFromDate(new Date())}-${randomUUID().slice(0, 8)}`);

  // Snapshot the artifact surface before an exercise that may write (Codex workspace-write); the
  // source-integrity guard reverts + reports any artifact mutation the evaluator makes below.
  const snap = exerciseScratch ? snapshotArtifact(workspace, integrityDeps) : undefined;

  // For a WRITER role, snapshot the CONTENT of every file dirty at run start, so we can detect a
  // generator that made no real change (the permission-starved / blocked no-progress case) and
  // surface a distinct signal instead of a silent FAIL. Path-set membership alone is a false
  // signal on continuation/fix rounds — the workspace is already dirty, so a real edit to an
  // already-changed file doesn't grow the set. Per-file content comparison catches it. The
  // snapshot is bounded to git-reported changed files; clean untouched files are never read.
  const isWriter = spec.guard === "writer";
  const listChanges = req.changedFilesFn ?? changedFiles;
  const hashFile = req.hashFileFn ?? fileContentHash;
  const writerBefore = isWriter ? new Map(listChanges(workspace).map((p) => [p, hashFile(p)])) : undefined;

  // Backend-agnostic request shared across attempts. Backend-specific fields (backend/model/effort/
  // baseUrl/apiKey/resume/traceSeq) are filled per attempt in the fallback loop below.
  const commonReq = {
    role: `role-run-${roleKind}`,
    prompt: task,
    systemPrompt: system,
    cwd: workspace,
    additionalDirectories: readDirs,
    tools: spec.tools,
    env: sessionEnv,
    skills: skillsForRole(ctx, spec.skillsName),
    // Backend-agnostic safety intent so Codex sandboxes correctly (it ignores Claude hooks):
    // only the generator may write; every other role is read-only. A write role's native-sandbox
    // scope comes from the role config, gated to a git worktree/branch boundary for full access.
    ...(spec.guard === "writer"
      ? {
          writeScope: [workspace],
          sandbox: gateSandbox({
            requested: role.sandbox,
            hasBranch: !!ctx.store.data.build.branch,
            roleLabel: `role-run-${roleKind}`,
          }),
        }
      : { readOnly: true, ...(exerciseScratch ? { exerciseScratch: true } : {}) }),
    // NB: the exercise `mcpServers`/`allowedTools` are NOT attached here — they're gated per attempt
    // on the attempt backend's `inProcessMcp` capability (a fallback may switch backends), so a
    // no-in-process-MCP backend (Codex) never gets a server that would be silently dropped.
    ...guard,
    maxTurns: ctx.config.build.maxTurnsPerSession,
    // Per-call override (nullish-coalesce so a supplied `0` = unlimited survives); else the per-item cap.
    maxBudgetUsd: req.maxBudgetUsd ?? ctx.config.build.maxBudgetUsdPerItem,
    traceDir,
  };

  // Auto-fallback on a provider limit (or an empty completion classified as one) — mirror the
  // build loop's per-role `fallback`, so an interactive run_role doesn't dead-end on a limited
  // backend. Try the chain in order, skipping a fallback whose backend already hit a limit.
  const chain: RoleConfig[] = [];
  for (let r: RoleConfig | undefined = role; r; r = r.fallback) chain.push(r);
  const limitedBackends = new Set<string>();
  // Real content changes for a writer, via the SAME writerBefore snapshot machinery as the
  // no-progress probe (no second git-scan path). A file counts iff its CURRENT content differs
  // from its pre-run snapshot: a newly-changed/created file (absent from the snapshot) counts, a
  // file dirty-at-start-but-untouched does NOT, and a file rewritten to its snapshot bytes does
  // NOT. Content is read ONLY for the union of the before/after changed sets — clean untouched
  // files (in neither set) are never hashed. Recomputed after the final attempt below.
  const countNewChanges = (): number => {
    if (!writerBefore) return 0;
    let n = 0;
    // Paths that entered git's dirty set DURING the run (in `after`, absent from the pre-run
    // snapshot) definitely changed — a file can't become dirty/untracked without diverging from
    // its committed state — so they count without a content read.
    for (const p of listChanges(workspace)) if (!writerBefore.has(p)) n++;
    // Paths dirty at run START need a CONTENT comparison against their snapshot: still-dirty-but-
    // edited counts, dirty-but-untouched does NOT, and a rewrite back to the snapshot bytes does
    // NOT. Only this pre-run set is hashed here — clean untouched files are never read.
    for (const [p, before] of writerBefore) if (before !== hashFile(p)) n++;
    return n;
  };
  let res!: RunResult;
  let ranRole: RoleConfig = role;
  for (let i = 0; i < chain.length; i++) {
    const attempt = chain[i]!;
    const be = attempt.backend ?? "claude";
    if (i > 0 && limitedBackends.has(be)) continue; // a fallback on an already-limited backend can't help
    ranRole = attempt;
    // Backend-aware exercise wiring for THIS attempt (a fallback may switch backends): attach the
    // in-process exercise server + tools ONLY when the attempt backend can HOST it; on a backend
    // without inProcessMcp (Codex) the server would be silently dropped, so we attach nothing and
    // hand the evaluator native-runner guidance instead. Recomputed per attempt so a Claude→Codex
    // (or Codex→Claude) fallback gets the right tools + guidance, never a statically-chosen one.
    const attemptInProcessMcp = getBackend(be).capabilities.inProcessMcp;
    const attemptSystem = exerciser
      ? await roleSystemPrompt(
          ctx,
          roleKind,
          attemptInProcessMcp ? exerciser.guidance : nativeRunnerGuidance(exerciser.guidance),
          req.allowVerify,
          attemptInProcessMcp
        )
      : system;
    // KNOWN sandbox-capability matrix for a sandboxed JUDGE on THIS attempt's backend (empty for a
    // no-OS-sandbox Claude backend, and for non-judge roles). Recomputed per attempt so a Claude→Codex
    // fallback gets the notes and a Codex→Claude fallback drops them. Tells the judge that e.g.
    // unix-domain-socket LISTEN is policy-denied even with a writable scratch TMPDIR → UN-RUN, not FAIL.
    const attemptTask = isSandboxedJudge(roleKind)
      ? task +
        judgeCapabilityNotesText({
          backendId: be,
          hasOsSandbox: getBackend(be).capabilities.sandbox,
          sandboxMode: exerciseScratch ? "workspace-write" : "read-only",
          scratchEnabled: exerciseScratch,
        })
      : task;
    res = await run({
      ...commonReq,
      prompt: attemptTask,
      systemPrompt: attemptSystem,
      ...(exerciser && attemptInProcessMcp ? { allowedTools: exerciser.allowedTools, mcpServers: exerciser.mcpServers } : {}),
      backend: attempt.backend,
      model: attempt.model,
      effort: attempt.effort,
      baseUrl: attempt.baseUrl,
      apiKey: attempt.apiKey,
      resume: resumeFor(be),
      traceSeq: (req.traceSeq ?? 1) + i,
    });
    if (!res.limitHit) break; // a real (non-limit) result — done, even if it's a failure
    // A WRITER's empty completion (the backend's EXPLICIT marker, not re-inferred from
    // tokens/text) whose files DID change means the work LANDED and only the report failed to
    // emit — a fallback generator would clobber it. STOP the chain; classification below clears
    // the ec's limitHit and surfaces `emptyCompletion` instead. A genuine limit, or an ec with
    // zero changed files (nothing ran), still falls back as before.
    if (isWriter && res.emptyCompletion && countNewChanges() > 0) {
      warn(
        `role-run-${roleKind}: ${be}/${attempt.model} returned an empty completion but files DID change — ` +
          `work landed; NOT falling back (a second writer would clobber it).`
      );
      break;
    }
    limitedBackends.add(be);
    const next = chain.slice(i + 1).find((f) => !limitedBackends.has(f.backend ?? "claude"));
    warn(
      `role-run-${roleKind}: ${be}/${attempt.model} hit a ${res.limitHit.kind} limit (or empty completion)` +
        (next ? ` — falling back to ${next.backend ?? "claude"}/${next.model}.` : " — no usable fallback left; surfacing the limit.")
    );
  }

  // The writer change-set probe runs REGARDLESS of how the run ended — `filesChanged` is always
  // populated for a writer, so the conductor can tell "empty but work landed" from "empty and
  // nothing happened" on every branch (limit, turn cap, budget death, clean).
  const filesChanged = isWriter && writerBefore ? countNewChanges() : undefined;
  const emptyText = !res.resultText.trim();
  const costUsd = costUsdOrZero(res.costUsd);
  const effectiveUsdCap = req.maxBudgetUsd ?? ctx.config.build.maxBudgetUsdPerItem;
  if (effectiveUsdCap > 0 && costUsd <= 0) {
    const tokenBound =
      ctx.config.build.maxTokensPerItem > 0
        ? `build.maxTokensPerItem (${ctx.config.build.maxTokensPerItem} tokens)`
        : ctx.config.build.zeroCostTokenCap > 0
        ? `build.zeroCostTokenCap (${ctx.config.build.zeroCostTokenCap} tokens)`
        : "no token cap configured (build.maxTokensPerItem=0, build.zeroCostTokenCap=0)";
    warn(
      `role-run-${roleKind}: USD cap $${effectiveUsdCap} cannot bind because reported cost was zero or unknown; effective token bound: ${tokenBound}.`
    );
  }

  const result: RoleRunResult = {
    ok: res.ok,
    roleKind,
    backend: ranRole.backend ?? "claude",
    model: ranRole.model,
    resultText: res.resultText,
    traceDir,
    sessionId: res.sessionId,
    costUsd,
    tokens: res.tokens,
    errors: res.errors,
    // Preserved telemetry (never suppressed by classification): the writer change count and the
    // our-own-budget-cap stop (the conductor resumes via `sessionId` on a budget death).
    filesChanged,
    hitBudget: res.hitBudget ? true : undefined,
  };

  // Classification — a strict top-down matrix, FIRST match wins; at most ONE of the flags
  // (limitHit / hitMaxTurns / emptyCompletion / noProgress) is set. An empty completion is
  // identified ONLY by the backend's explicit `res.emptyCompletion` marker — never re-inferred
  // from tokens/text, which a genuine limit can also exhibit.
  if (res.limitHit && !res.emptyCompletion) {
    // 1. A GENUINE provider limit — stays, and suppresses a co-occurring turn cap (the limit is
    //    the real reason the run stopped; existing precedence).
    result.limitHit = res.limitHit;
  } else if (res.hitMaxTurns) {
    // 2. Turn cap with no genuine limit — "unfinished", not "wrong": the conductor resumes.
    result.hitMaxTurns = true;
  } else if ((res.emptyCompletion || res.hitBudget) && emptyText && (filesChanged ?? 0) > 0) {
    // 3. Empty completion OR budget death, but the writer's files DID change — the work LANDED;
    //    only the report failed to emit. An ec's limitHit is CLEARED (this is not "nothing ran").
    result.emptyCompletion = true;
    const msg =
      `role-run-${roleKind}: run ended without a usable report (${res.emptyCompletion ? "empty completion" : "budget cap"}) ` +
      `but ${filesChanged} file(s) changed — the work LANDED. Resume the session (sessionId=${res.sessionId}) to re-emit ` +
      `the report, or accept the landed work; do NOT re-run or treat as a FAIL.`;
    if (!result.errors.includes(msg)) result.errors = [...result.errors, msg];
    warn(msg);
  } else if (res.emptyCompletion) {
    // 4. Empty completion with NO changed files — nothing ran; keep the limit classification
    //    (retry/fall back), NOT noProgress (the brief was never really attempted).
    result.limitHit = res.limitHit;
  } else if (res.hitBudget) {
    // 5. Budget death with no landed work — no classification flag; the `hitBudget` telemetry
    //    (already set above) + `sessionId` are the resume signal.
  } else if (isWriter && writerBefore && (filesChanged ?? 0) === 0) {
    // 6. A CLEAN run (no limit/cap/budget) where the writer changed no files — the
    //    permission-starved / blocked-brief signature. The conductor treats this like `limitHit`:
    //    investigate the brief/permissions, don't feed back as a FAIL.
    result.noProgress = true;
    const msg =
      `role-run-${roleKind}: writer changed no files — likely blocked reads/Bash or an unactionable brief, ` +
      `not a behavioral failure. Check the brief is actionable and the workspace is readable; re-run.`;
    if (!result.errors.includes(msg)) result.errors = [...result.errors, msg];
    warn(msg);
  }
  // 7. Normal success — no classification flag.

  // One-shot report re-ask (build.jsonReask) — the interactive analogue of generate.ts's re-ask.
  // Two cap-death shapes forfeit the report while the work LANDED (filesChanged>0), and both are a
  // REPORT problem, not a work problem, so we resume the SAME session ONCE, tightly capped, to
  // re-emit only the final report block:
  //   (a) a branch-3 empty-completion / budget-cap death (empty result text), and
  //   (b) a branch-2 TURN-CAP death whose partial reply carries no parseable completion report —
  //       empty text, prose with no JSON, or incidental/wrong-shape JSON (`hasCompletionReport`
  //       is the robust, un-gameable test; a properly-shaped report is NOT re-asked).
  // Gated to OUR-OWN-cap deaths (neither carries `res.limitHit`): a session already under a provider
  // limit (the Codex empty-completion promotes to one, and the fallback chain deliberately STOPPED
  // on it) can't be resumed usefully, so it's left to the conductor exactly as today. On a usable
  // reply the report surfaces and `emptyCompletion` clears while `hitMaxTurns` STAYS true — the cap
  // telemetry (hitBudget/hitMaxTurns + the recorded notes) stays truthful, so the summary still says
  // the cap hit and the report came from a re-ask; on a failed/disabled re-ask, today's behavior
  // stands (flags surface, the conductor decides). Never fires without landed work and never more
  // than once (no loop).
  const turnCapNoReport =
    result.hitMaxTurns === true && isWriter && (filesChanged ?? 0) > 0 && !hasCompletionReport(res.resultText);
  if ((result.emptyCompletion || turnCapNoReport) && !res.limitHit && ctx.config.build.jsonReask) {
    const reaskBudget = effectiveUsdCap > 0 ? Math.min(effectiveUsdCap, REPORT_REASK_MAX_BUDGET_USD) : REPORT_REASK_MAX_BUDGET_USD;
    const retry = await run({
      ...commonReq,
      backend: ranRole.backend,
      model: ranRole.model,
      effort: ranRole.effort,
      baseUrl: ranRole.baseUrl,
      apiKey: ranRole.apiKey,
      traceSeq: (req.traceSeq ?? 1) + chain.length,
      ...reportReaskOverrides({
        role: `role-run-${roleKind}-reask`,
        sessionId: res.sessionId,
        tightCap: { maxBudgetUsd: reaskBudget },
      }),
    });
    result.costUsd += costUsdOrZero(retry.costUsd);
    result.tokens += retry.tokens;
    if (retry.resultText.trim() && !retry.emptyCompletion && !retry.limitHit) {
      // The report was recovered — surface it and clear the empty-report flag, but KEEP the cap
      // telemetry (hitBudget, hitMaxTurns, filesChanged) so the summary still records that a cap was
      // hit and the report came from a re-ask. `hitMaxTurns` is deliberately left set on the turn-cap
      // path: recovery never launders a capped run as complete.
      result.resultText = retry.resultText;
      result.emptyCompletion = undefined;
      const recovered =
        `role-run-${roleKind}: recovered the final report via a one-shot re-ask (build.jsonReask) after the cap — ` +
        `the cap telemetry above still stands.`;
      if (!result.errors.includes(recovered)) result.errors = [...result.errors, recovered];
      info(recovered);
    }
  }

  // Source-integrity guard for ANY scratch-enabled judge (evaluator OR contract-evaluator running
  // under workspace-write): detect + REVERT any write to the tracked artifact surface the judge made
  // during its exercise/verify probe, and report the mutated paths. Computed ONCE here so both the
  // evaluator (verdict-forcing) and the contract-evaluator (error-reporting) branches share it.
  const mutatedArtifacts = snap ? enforceArtifactIntegrity(workspace, snap, integrityDeps) : [];

  if (evaluator) {
    // Redact any holdout the evaluator quoted, so it can't reach the conductor via
    // the returned verdict or the `--out` file (the evaluator may cite holdout in
    // evidence/blocking/notes — it's allowed to see it; the conductor is not).
    // The harness — not the model's self-report — decides whether run_command/http_request
    // verifications actually ran; override feeds the pass gate above and the pivot/build branches.
    const verdict = redactVerdict(parseVerdict(ctx, res.resultText, exerciser?.exerciseStatus()), holdoutText);
    // If the evaluator mutated the artifact surface, FORCE the verdict to fail (a verdict from an
    // evaluator that edited the code it grades cannot be trusted). The write was already reverted.
    if (mutatedArtifacts.length) {
      verdict.verdict = "fail";
      verdict.blocking.unshift(
        `Integrity violation: the evaluator wrote ${mutatedArtifacts.length} artifact file(s) during exercise (reverted): ${mutatedArtifacts.join(", ")}. Verdict cannot be trusted.`
      );
      warn(`Integrity violation for role-run-${roleKind}: evaluator wrote ${mutatedArtifacts.length} artifact file(s) (reverted): ${mutatedArtifacts.join(", ")}.`);
    }
    result.verdict = verdict;
    result.ok = res.ok && verdict.verdict === "pass";
    const header = renderInteractiveVerdict(roleKind, role, verdict, ctx.config.rubric.passThreshold);
    // Auto-persist the redacted verdict to a UNIQUELY-named file under .sparra/verdicts/ — always,
    // without the caller passing `out` — so an interactive/loop cycle leaves evaluator-side evidence
    // for `sparra reflect` (whose bundle excludes the holdout-bearing evaluator traces). The token
    // (timestamp + random suffix) keeps two role-runs grading the same item — even across process
    // restarts — from clobbering each other. The redacted raw output is appended in a details block;
    // it too is holdout-scrubbed (`safeRaw`), so NO section carries verbatim holdout. `writeText`
    // creates the dir lazily, so a config-less run (no .sparra/config.yaml) doesn't break.
    const token = `${stampFromDate(new Date())}-${randomUUID().slice(0, 8)}`;
    const verdictPath = ctx.paths.roleRunVerdictFile(roleKind, token);
    const safeRaw = holdoutLines(holdoutText).length ? redactHoldout(result.resultText, holdoutText) : result.resultText;
    await writeText(verdictPath, `${header}\n---\n\n<details><summary>raw evaluator output</summary>\n\n${safeRaw}\n\n</details>\n`);
    result.verdictPath = verdictPath;
    if (req.out) {
      // `out` is a SEPARATE, caller-chosen destination — byte-identical to today (header only, no raw
      // block) — and distinct from the auto-persisted `verdictPath` above.
      await writeText(req.out, header);
      result.outPath = req.out;
    }
  } else {
    // A non-evaluator scratch-enabled judge (the contract-evaluator on an isolated checkout) has no
    // verdict, but the same integrity boundary applies: if it wrote the artifact surface during a
    // verify probe under workspace-write, the write is already reverted — report it and FAIL the run
    // (a critique from a role that edited the code it critiques cannot be trusted).
    if (mutatedArtifacts.length) {
      result.ok = false;
      const msg =
        `Integrity violation: role-run-${roleKind} wrote ${mutatedArtifacts.length} artifact file(s) during its verify probe (reverted): ${mutatedArtifacts.join(", ")}. ` +
        `A scratch-enabled judge may write ONLY gitignored build/test scratch, never the tracked source.`;
      if (!result.errors.includes(msg)) result.errors = [...result.errors, msg];
      warn(msg);
    }
    if (req.out) {
      // `result.resultText` (not the raw `res.resultText`) so a report recovered by the cap-death
      // re-ask above is what lands in the --out file; identical to `res.resultText` otherwise.
      await writeText(req.out, normalizeOutCapture(result.resultText).text);
      result.outPath = req.out;
    }
  }

  return result;
}
