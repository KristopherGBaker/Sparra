import path from "node:path";
import type { Ctx } from "../context.ts";
import type { RoleConfig } from "../config.ts";
import { fill, loadPrompt } from "../prompts.ts";
import { runSession } from "../sdk/session.ts";
import type { RunResult, RunSessionParams } from "../sdk/session.ts";
import type { LimitHit } from "../sdk/backend.ts";
import { evaluatorGuard, readOnlyGuard, scopedWriterGuard, type Guard } from "../sdk/guard.ts";
import { skillsForRole } from "../sdk/skills.ts";
import { buildExerciser, type Exerciser } from "../sdk/exercise.ts";
import { buildReadDirs } from "./readscope.ts";
import { gateSandbox } from "./sandbox.ts";
import { snapshotArtifact, enforceArtifactIntegrity, realIntegrityDeps, type IntegrityDeps } from "./integrity.ts";
import { randomUUID } from "node:crypto";
import { readHoldout, holdoutSection, assertNoHoldoutLeak, holdoutLines, redactHoldout, makeHoldoutReadDecider } from "./holdout.ts";

// Re-exported for the interactive runner's existing importers (and tests) — the implementation
// now lives in holdout.ts so the autonomous build-loop forbid roles share the exact same wall.
export { makeHoldoutReadDecider };
import { contractModeClauses, deviationPolicy, rubricText, calibrationText, existingTestsText, selfVerifyGuidance } from "./modeText.ts";
import { appleConventions, isApplePlatform } from "./swiftConventions.ts";
import { readMemory, memorySection } from "../memory.ts";
import { RUBRIC_CRITERIA, type Verdict } from "./types.ts";
import { extractJsonWhere } from "../util/extract.ts";
import { exists, readText, writeText, stampFromDate } from "../util/io.ts";
import { changedFiles, isLinkedWorktree } from "../util/git.ts";
import { provisionWorkspaceDeps } from "../util/provision.ts";
import { exerciseScratchEnabled } from "./exerciseScratch.ts";
import { warn } from "../util/log.ts";

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
  /** Injectable for tests; defaults to the real `buildExerciser` (evaluator role only). Lets a test
   *  assert the harness-status override without driving a live model through run_command. */
  buildExerciserFn?: (config: Ctx["config"], workspace: string) => Exerciser;
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
async function roleSystemPrompt(ctx: Ctx, kind: RoleKind, exerciseGuidance: string, allowVerify = false): Promise<string> {
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

/** Parse + normalize an evaluator verdict the same way the build loop does.
 *  `harnessStatus` is the exerciser's deterministic verdict on whether the exercise actually ran
 *  (from real `run_command`/`http_request` exit codes); when it's not "none" it OVERRIDES the
 *  model's self-reported `exerciseStatus`, so a model can't launder a harness-observed block into a
 *  pass — and so a blocked-but-unparseable verdict carries "blocked", not the hardcoded "ran". */
function parseVerdict(ctx: Ctx, resultText: string, harnessStatus: "blocked" | "ran" | "none" = "none"): Verdict {
  const decide = (modelStatus: "blocked" | "ran"): "blocked" | "ran" =>
    harnessStatus !== "none" ? harnessStatus : modelStatus;
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
      blocking: ["Evaluator did not produce a parseable JSON verdict; re-run."],
      notes: "no verdict parsed",
    };
  }
  for (const c of RUBRIC_CRITERIA) {
    const v = Number(parsed.scores[c] ?? 0);
    parsed.scores[c] = Math.max(0, Math.min(100, isFinite(v) ? v : 0));
  }
  const weighted = computeWeighted(ctx, parsed.scores);
  const finalStatus = decide(parsed.exerciseStatus === "blocked" ? "blocked" : "ran");
  // A BLOCKED exercise is inconclusive — it can NEVER be a pass (we couldn't verify), regardless of
  // what the model claimed or the score, so an unverified item is never silently accepted. The
  // harness-overridden status (not the raw self-report) gates the pass.
  const meets = weighted >= ctx.config.rubric.passThreshold && parsed.verdict === "pass" && finalStatus !== "blocked";
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
    exerciseStatus: finalStatus,
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
    provision(ctx.root, workspace, ctx.config.git.provisionDeps);
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
    evaluator,
    sandbox: ctx.config.exercise.sandbox,
    hasBranch: !!ctx.store.data.build.branch,
    isWorktree: onLinkedWorktree,
  });
  const integrityDeps = req.integrityDeps ?? realIntegrityDeps();

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

  // For a WRITER role, record the workspace's changed-file set BEFORE the run, so we can detect a
  // generator that finished without changing anything (the permission-starved / blocked no-progress
  // case) and surface a distinct signal instead of a silent FAIL.
  const isWriter = spec.guard === "writer";
  const listChanges = req.changedFilesFn ?? changedFiles;
  const writerBefore = isWriter ? new Set(listChanges(workspace)) : undefined;

  // Backend-agnostic request shared across attempts. Backend-specific fields (backend/model/effort/
  // baseUrl/apiKey/resume/traceSeq) are filled per attempt in the fallback loop below.
  const commonReq = {
    role: `role-run-${roleKind}`,
    prompt: task,
    systemPrompt: system,
    cwd: workspace,
    additionalDirectories: readDirs,
    tools: spec.tools,
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
    ...(exerciser ? { allowedTools: exerciser.allowedTools, mcpServers: exerciser.mcpServers } : {}),
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
  let res!: RunResult;
  let ranRole: RoleConfig = role;
  for (let i = 0; i < chain.length; i++) {
    const attempt = chain[i]!;
    const be = attempt.backend ?? "claude";
    if (i > 0 && limitedBackends.has(be)) continue; // a fallback on an already-limited backend can't help
    ranRole = attempt;
    res = await run({
      ...commonReq,
      backend: attempt.backend,
      model: attempt.model,
      effort: attempt.effort,
      baseUrl: attempt.baseUrl,
      apiKey: attempt.apiKey,
      resume: resumeFor(be),
      traceSeq: (req.traceSeq ?? 1) + i,
    });
    if (!res.limitHit) break; // a real (non-limit) result — done, even if it's a failure
    limitedBackends.add(be);
    const next = chain.slice(i + 1).find((f) => !limitedBackends.has(f.backend ?? "claude"));
    warn(
      `role-run-${roleKind}: ${be}/${attempt.model} hit a ${res.limitHit.kind} limit (or empty completion)` +
        (next ? ` — falling back to ${next.backend ?? "claude"}/${next.model}.` : " — no usable fallback left; surfacing the limit.")
    );
  }

  const result: RoleRunResult = {
    ok: res.ok,
    roleKind,
    backend: ranRole.backend ?? "claude",
    model: ranRole.model,
    resultText: res.resultText,
    sessionId: res.sessionId,
    costUsd: res.costUsd,
    tokens: res.tokens,
    errors: res.errors,
    limitHit: res.limitHit,
    // A turn-cap stop is "unfinished", not "wrong" — surface it so the conductor resumes the
    // session (like the build loop) instead of failing. Suppress under a limit (the cap wasn't
    // the real reason the run stopped).
    hitMaxTurns: res.hitMaxTurns && !res.limitHit ? true : undefined,
  };

  // No-progress fast-fail: a writer that changed NO file (no new/edited path appeared) didn't
  // build anything — almost always permission starvation or a blocked brief, not a real "the work
  // is wrong" outcome. Surface it distinctly, but never over a real limit OR a turn-cap (where
  // doing nothing yet is expected and the right move is resume, not "investigate the brief"). The
  // conductor treats this like `limitHit`: investigate, don't feed back as a FAIL.
  if (isWriter && writerBefore && !res.limitHit && !res.hitMaxTurns) {
    const after = listChanges(workspace);
    const progressed = after.some((p) => !writerBefore.has(p));
    if (!progressed) {
      result.noProgress = true;
      const msg =
        `role-run-${roleKind}: writer changed no files — likely blocked reads/Bash or an unactionable brief, ` +
        `not a behavioral failure. Check the brief is actionable and the workspace is readable; re-run.`;
      if (!result.errors.includes(msg)) result.errors = [...result.errors, msg];
      warn(msg);
    }
  }

  if (evaluator) {
    // Redact any holdout the evaluator quoted, so it can't reach the conductor via
    // the returned verdict or the `--out` file (the evaluator may cite holdout in
    // evidence/blocking/notes — it's allowed to see it; the conductor is not).
    // The harness — not the model's self-report — decides whether run_command/http_request
    // verifications actually ran; override feeds the pass gate above and the pivot/build branches.
    const verdict = redactVerdict(parseVerdict(ctx, res.resultText, exerciser?.exerciseStatus()), holdoutText);
    // Source-integrity guard: revert any artifact write the evaluator made during the exercise; if
    // it mutated the surface, FORCE the verdict to fail (a verdict from an evaluator that edited the
    // code it grades cannot be trusted).
    if (snap) {
      const mutated = enforceArtifactIntegrity(workspace, snap, integrityDeps);
      if (mutated.length) {
        verdict.verdict = "fail";
        verdict.blocking.unshift(
          `Integrity violation: the evaluator wrote ${mutated.length} artifact file(s) during exercise (reverted): ${mutated.join(", ")}. Verdict cannot be trusted.`
        );
        warn(`Integrity violation for role-run-${roleKind}: evaluator wrote ${mutated.length} artifact file(s) (reverted): ${mutated.join(", ")}.`);
      }
    }
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
