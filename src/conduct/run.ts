import path from "node:path";

import {
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
import type { RunResult, RunSessionParams } from "../sdk/session.ts";
import { exists, writeText } from "../util/io.ts";
import { info, ok, warn } from "../util/log.ts";
import { decomposeConduct } from "./decompose.ts";
import { buildUnitRoleSpecs, resolveSparraBin } from "./roleSpecs.ts";
import { conductRunDir, RunStateWriter } from "./runState.ts";
import { deterministicStrategy, type JudgmentStrategy } from "./strategy.ts";
import type { ConductRunState, ConductUnit, UnitStateEntry } from "./types.ts";

/**
 * `src/conduct/run.ts` — the deterministic conductor core: decompose a prompt into units, then per
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

  // 3. Build one bounded-concurrent unit job per unit.
  const strategy = deps.strategy ?? deterministicStrategy;
  const sparraBin = deps.sparraBin ?? resolveSparraBin();
  const jobs: UnitJob[] = units.map((unit) => ({
    id: unit.id,
    config: buildUnitConfig(ctx, unit, runId, runDir, opts, sparraBin, strategy),
  }));

  // 4. Incremental persister: after EACH role, attribute it to its unit (via the env tag) and
  //    persist a snapshot, so a crashed run shows completed units' fields + a non-final status.
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

  // 5. Run the units bounded-concurrently through core `runUnitsConcurrently`.
  info(`conduct: running ${jobs.length} unit(s), concurrency ${opts.concurrency}.`);
  const results = await runUnitsConcurrently({ runRole: trackedRunRole }, jobs, {
    concurrency: opts.concurrency,
  });

  // 6. Finalize each unit from its authoritative result.
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

  state.status = "completed";
  await writer.write(state);
  const accepted = state.units.filter((u) => u.outcome === "accepted");
  ok(
    `conduct: run ${runId} complete — ${accepted.length}/${state.units.length} unit(s) accepted. ` +
      `Artifacts under ${runDir}.`,
  );
  return { runId, runDir, state };
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
  const unitDir = path.join(runDir, unit.id);
  const unitWorktree = `${runId}-${unit.id}`;
  const specs = buildUnitRoleSpecs({
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
