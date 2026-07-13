import path from "node:path";
import process from "node:process";

import {
  mapBounded,
  runUnitsConcurrently,
  type ParentSummary,
  type RoleRunner,
  type RunRoleSpec,
  type RunUnitConfig,
  type RunUnitResult,
  type UnitJob,
} from "../../conductors/core/index.ts";
import { runRole as coreRunRole } from "../../conductors/core/index.ts";
import { newRunId, type Ctx } from "../context.ts";
import { formatRunStartAnnouncement } from "./announce.ts";
import { loadPrompt } from "../prompts.ts";
import { mergedBuildEnv } from "../build/env.ts";
import { runSession, type RunResult, type RunSessionParams } from "../sdk/session.ts";
import { exists, writeText } from "../util/io.ts";
import { detail, info, ok, warn } from "../util/log.ts";
import { makeBrain, type Brain } from "./brain.ts";
import { decomposeConduct } from "./decompose.ts";
import {
  buildDecisionRequest,
  type DecisionRecord,
  type DecisionSource,
  type DecisionVia,
  type JudgmentKind,
} from "./decision.ts";
import {
  makeReadlineTty,
  resolveDecision,
  type DecisionEngineDeps,
  type TtySeam,
} from "./decisionEngine.ts";
import { buildUnitRoleSpecs, resolveSparraBin, type UnitRoleSpecs } from "./roleSpecs.ts";
import { conductRunDir, RunStateWriter } from "./runState.ts";
import { deterministicStrategy, type JudgmentStrategy } from "./strategy.ts";
import type { RecoveryCaps } from "./recovery.ts";
import { runUnitHybrid, runUnitLlm, type ConductUnitDeps } from "./unitRunner.ts";
import type { ConductRunState, ConductUnit, UnitStateEntry } from "./types.ts";

/**
 * `src/conduct/run.ts` — the conductor core: decompose a prompt into units, then per
 * unit negotiate → generate → cross-model evaluate → decide, all through `conductors/core`
 * (`runUnit` via `runUnitsConcurrently`, over an injected `RoleRunner`). Filesystem is the source
 * of truth: `.sparra/conduct/<runId>/run.json` + per-unit briefs/contracts are written incrementally
 * and atomically, so a crashed run is still inspectable. Nothing lands on the user's branch — every
 * unit generates on its own persistent `sparra/<name>` unit worktree.
 */

export interface ConductOptions {
  prompt: string;
  /** Max units after decompose clamp (default 4, set by the CLI). */
  maxUnits: number;
  /** Bounded concurrency across units (default 2). */
  concurrency: number;
  /** Per-role-run USD cap; `0` = unlimited. */
  budget?: number;
  /** Per-role-run turn cap. */
  maxTurns?: number;
  /** Decompose + write briefs only — no role spend beyond the decomposer. */
  dryRun: boolean;
  /** Conductor brain mode. Absent → the plain deterministic path (U1, unchanged). `hybrid` consults
   *  the brain/decision engine at the five judgment points; `llm` drives turn-by-turn. */
  brain?: "hybrid" | "llm";
  /** How judgment-point decisions surface (default from config, `park-timeout`). */
  surface?: "park" | "park-timeout" | "auto";
  /** Seconds a parked decision waits before auto-resolving under `park-timeout`. */
  timeoutSec?: number;
}

export interface ConductDeps {
  /** Isolated role runner (default: core `runRole` spawning `sparra role run … --json`). */
  runRole?: RoleRunner;
  /** Decomposer session runner (default: real `runSession`). */
  runSessionFn?: (p: RunSessionParams) => Promise<RunResult>;
  /** Judgment strategy consulted at each build-cycle decision (default: deterministic). */
  strategy?: JudgmentStrategy;
  /** Override the spawned sparra bin (default: `resolveSparraBin()`). */
  sparraBin?: string;

  // ── U2 conductor-brain + decision-engine seams (all injectable so tests run with no live calls) ──
  /** The conductor brain. A `Brain` object uses it directly; `null` forces NO brain (deterministic
   *  policy at judgment points); `undefined` builds one from `brainSessionFn` when `opts.brain` set. */
  brain?: Brain | null;
  /** Session runner the brain is built over (default: real `runSession`). Distinct from the
   *  decomposer's `runSessionFn` so a test fakes them independently. */
  brainSessionFn?: (p: RunSessionParams) => Promise<RunResult>;
  /** Clock (ms) for decision expiry — injectable for deterministic timeout tests. */
  now?: () => number;
  /** Poll delay (default a real timer). Tests inject an immediate/clock-advancing sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Poll cadence in ms (default 500). */
  pollMs?: number;
  /** Terminal answer channel (production: readline when stdin is a TTY). */
  tty?: TtySeam;
  /** Test seam: every written `*.request.json` path. */
  onDecisionRequest?: (requestPath: string) => void;
  /** Test seam: every brain prompt (holdout-safety assertions). */
  onBrainPrompt?: (prompt: string) => void;
}

/** The result of a conduct run: the final run state + where it lives. */
export interface ConductResult {
  runId: string;
  runDir: string;
  state: ConductRunState;
}

/** Sum `costUsd` over a list of summaries. */
function sumCost(summaries: ParentSummary[]): number {
  return summaries.reduce((acc, s) => acc + (s.costUsd ?? 0), 0);
}

/** Every role summary a unit produced (contract + build cycle), for cost/score/worktree derivation. */
function unitSummaries(r: RunUnitResult): ParentSummary[] {
  const out: ParentSummary[] = [];
  for (const round of r.contract.rounds) {
    if (round.generator) out.push(round.generator);
    out.push(round.evaluator);
  }
  for (const round of r.cycle?.rounds ?? []) {
    out.push(round.generator, round.evaluator);
  }
  return out;
}

/** Finalize a unit entry from its `RunUnitResult` — authoritative over the incremental snapshot. */
function finalizeFromResult(entry: UnitStateEntry, r: RunUnitResult): void {
  entry.outcome = r.outcome;
  entry.contractAgreed = r.contract.agreed;
  entry.contractForced = !r.contract.agreed;
  const summaries = unitSummaries(r);
  entry.cost = sumCost(summaries);
  const finalVerdict = r.cycle?.finalVerdict;
  const lastEval = r.cycle?.rounds.at(-1)?.evaluator;
  const score = finalVerdict?.weightedTotal ?? lastEval?.weightedTotal;
  if (score !== undefined) entry.score = score;
  // Worktree/branch come from a build-cycle generator summary's unitWorktree (never hardcoded).
  const genWt = r.cycle?.rounds.map((rd) => rd.generator.unitWorktree).find((w) => w);
  if (genWt) {
    entry.worktree = genWt.name;
    entry.branch = genWt.branch;
  }
}

/**
 * Run the full conduct flow. Pure over its injected deps (no live model / spawn / network when a
 * fake `runRole` + `runSessionFn` are supplied). Returns the final state; `run.json` is also
 * persisted incrementally under `.sparra/conduct/<runId>/`.
 */
export async function runConduct(
  ctx: Ctx,
  opts: ConductOptions,
  deps: ConductDeps = {},
): Promise<ConductResult> {
  const runId = newRunId("conduct");
  const runDir = conductRunDir(ctx.paths.dir, runId);
  const writer = new RunStateWriter(runDir);
  const now = () => new Date().toISOString();

  // Run-START announcement (BEFORE any unit work): a stable, documented `runId → runDir` line the
  // HTTP bridge parses from child stdout to associate a spawned conduct job with its run — the
  // run-END `run: <runId> → <runDir>` summary lands only after every unit has finished.
  info(formatRunStartAnnouncement(runId, runDir));

  const state: ConductRunState = {
    runId,
    prompt: opts.prompt,
    status: "pending",
    createdAt: now(),
    updatedAt: now(),
    maxUnits: opts.maxUnits,
    concurrency: opts.concurrency,
    dryRun: opts.dryRun,
    units: [],
  };

  // 1. Decompose (the ONE role that always runs, even on --dry-run).
  const units = await decomposeConduct(
    ctx,
    { prompt: opts.prompt, maxUnits: opts.maxUnits, traceDir: runDir },
    deps.runSessionFn,
  );
  if (units.length === 0) {
    state.status = "error";
    await writer.write(state);
    warn("conduct: decomposition produced no units — nothing to run.");
    return { runId, runDir, state };
  }

  // 2. Write each unit's brief + seed its run.json entry.
  const entryByUnit = new Map<string, UnitStateEntry>();
  for (const unit of units) {
    const unitDir = path.join(runDir, unit.id);
    const briefPath = path.join(unitDir, "brief.md");
    await writeText(briefPath, unit.brief);
    const entry: UnitStateEntry = {
      id: unit.id,
      title: unit.title,
      outcome: opts.dryRun ? "dry-run" : "pending",
      briefPath,
      contractPath: path.join(unitDir, "contract.md"),
    };
    state.units.push(entry);
    entryByUnit.set(unit.id, entry);
  }

  state.status = opts.dryRun ? "dry-run" : "running";
  await writer.write(state);

  if (opts.dryRun) {
    ok(`conduct: dry run — decomposed ${units.length} unit(s), briefs written under ${runDir}.`);
    return { runId, runDir, state };
  }

  // 3. Shared seams: judgment strategy + spawned bin + the incremental role-run persister.
  const strategy = deps.strategy ?? deterministicStrategy;
  const sparraBin = deps.sparraBin ?? resolveSparraBin();

  // Incremental persister: after EACH role, attribute it to its unit (via the env tag) and persist
  // a snapshot, so a crashed run shows completed units' fields + a non-final status.
  const baseRunRole = deps.runRole ?? coreRunRole;
  const trackedRunRole: RoleRunner = async (spec: RunRoleSpec) => {
    const summary = await baseRunRole(spec);
    const unitId = spec.env?.SPARRA_CONDUCT_UNIT as string | undefined;
    const entry = unitId ? entryByUnit.get(unitId) : undefined;
    if (entry) {
      if (entry.outcome === "pending") entry.outcome = "running";
      entry.cost = (entry.cost ?? 0) + (summary.costUsd ?? 0);
      if (summary.weightedTotal !== undefined) entry.score = summary.weightedTotal;
      if (summary.unitWorktree) {
        entry.worktree = summary.unitWorktree.name;
        entry.branch = summary.unitWorktree.branch;
      }
      await writer.write(state);
    }
    return summary;
  };

  if (opts.brain) {
    // 3b/4b/5b. Conductor-brain path: hybrid/llm per-unit orchestration + the decision engine.
    state.brain = opts.brain;
    state.decisionSurface = opts.surface ?? ctx.config.conduct.decisions.surface;
    await writer.write(state);
    await runBrainUnits(ctx, opts, deps, {
      runId,
      runDir,
      units,
      entryByUnit,
      state,
      writer,
      strategy,
      sparraBin,
      trackedRunRole,
    });
  } else {
    // 4. Deterministic path (U1): one bounded-concurrent core `runUnit` per unit.
    const jobs: UnitJob[] = units.map((unit) => ({
      id: unit.id,
      config: buildUnitConfig(ctx, unit, runId, runDir, opts, sparraBin, strategy),
    }));
    info(`conduct: running ${jobs.length} unit(s), concurrency ${opts.concurrency}.`);
    const results = await runUnitsConcurrently({ runRole: trackedRunRole }, jobs, {
      concurrency: opts.concurrency,
    });
    for (const res of results) {
      const entry = entryByUnit.get(res.id);
      if (!entry) continue;
      if ("error" in res) {
        entry.outcome = "error";
        entry.error = res.error;
      } else {
        finalizeFromResult(entry, res.result);
      }
    }
  }

  state.status = "completed";
  await writer.write(state);
  const accepted = state.units.filter((u) => u.outcome === "accepted");
  ok(
    `conduct: run ${runId} complete — ${accepted.length}/${state.units.length} unit(s) accepted. ` +
      `Artifacts under ${runDir}.`,
  );
  return { runId, runDir, state };
}

/** Build one unit's four role-spec builders (shared by the deterministic + brain paths). */
function buildUnitSpecs(
  ctx: Ctx,
  unit: ConductUnit,
  runId: string,
  runDir: string,
  opts: ConductOptions,
  sparraBin: string,
): UnitRoleSpecs {
  const unitDir = path.join(runDir, unit.id);
  const unitWorktree = `${runId}-${unit.id}`;
  return buildUnitRoleSpecs({
    roles: {
      contractGenerator: ctx.config.roles.contractGenerator,
      contractEvaluator: ctx.config.roles.contractEvaluator,
      generator: ctx.config.roles.generator,
      evaluator: ctx.config.roles.evaluator,
    },
    workspace: ctx.root,
    unitDir,
    briefPath: path.join(unitDir, "brief.md"),
    contractPath: path.join(unitDir, "contract.md"),
    ...(hasHoldout(ctx) ? { holdoutPath: ctx.paths.holdout } : {}),
    unitWorktree,
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    unitId: unit.id,
    sparraBin,
  });
}

/** Build the core `RunUnitConfig` for one unit: the contract negotiation (generator + evaluator) +
 *  the generate → evaluate → decide build cycle, with the injected judgment strategy wired in. */
function buildUnitConfig(
  ctx: Ctx,
  unit: ConductUnit,
  runId: string,
  runDir: string,
  opts: ConductOptions,
  sparraBin: string,
  strategy: JudgmentStrategy,
): RunUnitConfig {
  const specs = buildUnitSpecs(ctx, unit, runId, runDir, opts, sparraBin);

  const config: RunUnitConfig = {
    contract: {
      contractGeneratorSpec: specs.contractGeneratorSpec,
      contractEvaluatorSpec: specs.contractEvaluatorSpec,
      maxRounds: ctx.config.contract.maxNegotiationRounds,
    },
    generatorSpec: specs.generatorSpec,
    evaluatorSpec: specs.evaluatorSpec,
    maxRounds: ctx.config.build.maxRoundsPerItem,
    pivotAfterFailures: ctx.config.pivot.N,
    requireCrossModel: true,
    decide: strategy.decide,
    // Non-convergence proceeds with the latest proposal (forced finalization), recorded as forced.
    proceedIfNotAgreed: true,
  };
  return config;
}

/** True when the project has a holdout file on disk. Only its PATH ever reaches an evaluator spec —
 *  the content is never read here (holdout wall). */
function hasHoldout(ctx: Ctx): boolean {
  return exists(ctx.paths.holdout);
}

/** A PASS within this many points of threshold is a BORDERLINE accept (a judgment point). */
const BORDERLINE_MARGIN = 5;

/** The shared context a brain run threads through its per-unit orchestration. */
interface BrainRunParams {
  runId: string;
  runDir: string;
  units: ConductUnit[];
  entryByUnit: Map<string, UnitStateEntry>;
  state: ConductRunState;
  writer: RunStateWriter;
  strategy: JudgmentStrategy;
  sparraBin: string;
  trackedRunRole: RoleRunner;
}

/**
 * The conductor-brain path: build the brain once (holdout-safe, read-only), then run each unit's
 * hybrid/llm orchestration bounded-concurrently, wiring the decision engine (park/timeout/auto) at
 * each judgment point and recording every decision into `run.json`.
 */
async function runBrainUnits(
  ctx: Ctx,
  opts: ConductOptions,
  deps: ConductDeps,
  p: BrainRunParams,
): Promise<void> {
  const surface = opts.surface ?? ctx.config.conduct.decisions.surface;
  const timeoutSec = opts.timeoutSec ?? ctx.config.conduct.decisions.timeoutSec;
  const nowMs = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // Build the brain once. `null` forces NO brain (deterministic policy at judgment points).
  let brain: Brain | undefined;
  if (deps.brain === null) {
    brain = undefined;
  } else if (deps.brain) {
    brain = deps.brain;
  } else {
    brain = makeBrain({
      runSessionFn: deps.brainSessionFn ?? runSession,
      role: ctx.config.roles.conductor,
      systemPrompt: await loadPrompt(ctx.paths, "conductor"),
      cwd: p.runDir,
      traceDir: p.runDir,
      jsonReask: ctx.config.build.jsonReask,
      env: mergedBuildEnv(ctx.config),
      ...(deps.onBrainPrompt ? { onPrompt: deps.onBrainPrompt } : {}),
    });
  }

  let seq = 0;
  const nextSeq = () => (seq += 1);

  const runOne = async (unit: ConductUnit): Promise<void> => {
    const entry = p.entryByUnit.get(unit.id)!;
    const unitDir = path.join(p.runDir, unit.id);
    const specs = buildUnitSpecs(ctx, unit, p.runId, p.runDir, opts, p.sparraBin);

    const record = (rec: DecisionRecord): void => {
      (entry.decisions ??= []).push(rec);
    };

    const judge = async (
      kind: JudgmentKind,
      summary?: ParentSummary,
    ): ReturnType<ConductUnitDeps["judge"]> => {
      const s = nextSeq();
      const requestedAt = new Date(nowMs()).toISOString();
      const req = buildDecisionRequest({
        seq: s,
        unit: unit.id,
        kind,
        nowMs: nowMs(),
        timeoutSec,
        ...(summary ? { summary } : {}),
        passThreshold: ctx.config.rubric.passThreshold,
      });
      // AUDIT TRAIL step 1: append the PENDING record + persist run.json + phase-log the request BEFORE
      // waiting for an answer, so an in-flight (parked) decision is durably inspectable.
      const pending: DecisionRecord = {
        seq: s,
        unit: unit.id,
        kind,
        question: req.question,
        options: req.options,
        default: req.default,
        status: "pending",
        requestedAt,
      };
      record(pending);
      await p.writer.write(p.state);
      detail(`conduct: decision #${s} [${kind}] on ${unit.id} — awaiting ${req.options.join("/")} (default ${req.default})`);

      // Production: when parking on a real terminal, offer an inline readline prompt too (first
      // answer wins, file vs TTY). Tests inject `deps.tty` (a fake seam) instead.
      const tty: TtySeam | undefined =
        deps.tty ?? (surface !== "auto" && process.stdin.isTTY ? makeReadlineTty() : undefined);
      const engine: DecisionEngineDeps = {
        surface,
        runDir: p.runDir,
        nowMs,
        sleep,
        ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
        ...(brain ? { brainJudge: (r) => brain!.judge(r) } : {}),
        ...(tty ? { tty } : {}),
        ...(deps.onDecisionRequest ? { onRequestWritten: deps.onDecisionRequest } : {}),
      };
      const res = await resolveDecision(req, engine);

      // AUDIT TRAIL step 2: transition the SAME record pending → resolved (in place, matched by seq),
      // so one seq yields exactly one durable record. Phase-log the resolution.
      pending.status = "resolved";
      pending.chosen = res.answer;
      pending.source = res.source;
      pending.via = res.via;
      if (res.rationale) pending.rationale = res.rationale;
      if (res.note) pending.note = res.note;
      pending.resolvedAt = new Date(nowMs()).toISOString();
      await p.writer.write(p.state);
      info(`conduct: decision #${s} [${kind}] → "${res.answer}" (source ${res.source}, via ${res.via})`);
      return res;
    };

    const noteDecision = (
      kind: JudgmentKind,
      answer: string,
      source: DecisionSource,
      via: DecisionVia,
      rationale?: string,
    ): void => {
      const at = new Date(nowMs()).toISOString();
      const s = nextSeq();
      record({
        seq: s,
        unit: unit.id,
        kind,
        question: `(auto) ${kind}`,
        options: [],
        default: answer,
        status: "resolved",
        chosen: answer,
        ...(rationale ? { rationale } : {}),
        source,
        via,
        requestedAt: at,
        resolvedAt: at,
      });
      detail(`conduct: decision #${s} [${kind}] → "${answer}" (source ${source}, via ${via})`);
    };

    const writeGeneralizedBrief = async (round: number): Promise<string> => {
      const gp = path.join(unitDir, `brief.generalized.r${round}.md`);
      await writeText(
        gp,
        `# Generalized brief (revision at round ${round})\n\n` +
          `Repeated rounds bounced on the SAME assertion — generalize the acceptance criteria to the ` +
          `underlying intent rather than the literal wording.\n\n(Original brief: ${entry.briefPath})\n`,
      );
      return gp;
    };

    const unitDeps: ConductUnitDeps = {
      runRole: p.trackedRunRole,
      specs,
      decide: p.strategy.decide,
      ...(brain ? { brain } : {}),
      judge,
      noteDecision,
      writeGeneralizedBrief,
      recoveryCaps: {
        role: ctx.config.roles.generator,
        ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
        ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
      },
      generatorRole: ctx.config.roles.generator,
      unit: unit.id,
      contractMaxRounds: ctx.config.contract.maxNegotiationRounds,
      maxRounds: ctx.config.build.maxRoundsPerItem,
      pivotAfterFailures: ctx.config.pivot.N,
      requireCrossModel: true,
      passThreshold: ctx.config.rubric.passThreshold,
      borderlineMargin: BORDERLINE_MARGIN,
    };

    try {
      const result =
        opts.brain === "llm" ? await runUnitLlm(unitDeps) : await runUnitHybrid(unitDeps);
      entry.outcome = result.outcome;
      entry.contractAgreed = result.contractAgreed;
      entry.contractForced = result.contractForced;
      if (result.finalVerdict?.weightedTotal !== undefined) {
        entry.score = result.finalVerdict.weightedTotal;
      }
    } catch (e) {
      entry.outcome = "error";
      entry.error = e instanceof Error ? e.message : String(e);
    }
    await p.writer.write(p.state);
  };

  info(`conduct: running ${p.units.length} unit(s) in ${opts.brain} mode, concurrency ${opts.concurrency}.`);
  await mapBounded(p.units, runOne, { concurrency: opts.concurrency });
}
