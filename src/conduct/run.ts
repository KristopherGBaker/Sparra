import fs from "node:fs";
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
import { landAcceptedUnits, type LandingDeps, type LandingGit } from "./merge.ts";
import type { ConductCommitGit } from "./commit.ts";
import { ensureUnitWorktree, type EnsureUnitWorktreeResult } from "../build/unitWorktree.ts";
import type { removeUnitWorktree } from "../build/unitWorktree.ts";
import { conductRunDir, isSafeRunId, runStatePath, RunStateWriter } from "./runState.ts";
import { deterministicStrategy, type JudgmentStrategy } from "./strategy.ts";
import type { RecoveryCaps } from "./recovery.ts";
import { runUnitHybrid, runUnitLlm, type ConductUnitDeps } from "./unitRunner.ts";
import type { ConductRunState, ConductUnit, UnitOutcome, UnitStateEntry } from "./types.ts";

/**
 * `src/conduct/run.ts` — the conductor core: decompose a prompt into units, then per
 * unit negotiate → generate → cross-model evaluate → decide, all through `conductors/core`
 * (`runUnit` via `runUnitsConcurrently`, over an injected `RoleRunner`). Filesystem is the source
 * of truth: `.sparra/conduct/<runId>/run.json` + per-unit briefs/contracts are written incrementally
 * and atomically, so a crashed run is both inspectable AND resumable in place (`resumeConduct` /
 * `sparra conduct --resume <runId>`). Nothing lands on the user's branch — every
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
  /** Opt-in: after a unit is ACCEPTED, commit its worktree WIP onto its `sparra/<name>` branch. */
  commit?: boolean;
  /** Opt-in (implies `commit`): integrate accepted branches into a safe target (never the default
   *  branch). Rebase+ff preferred, merge-commit fallback, conflicts/dirty target parked. */
  merge?: boolean;
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

  // ── commit/merge landing seams (all injectable so tests run with real-git fakes, no model calls) ──
  /** Injectable git seam for the merge path (rebase/ff/merge/abort/target selection). */
  landingGit?: Partial<LandingGit>;
  /** Injectable git seam for the commit path (changedFiles/diff/commit/rev-parse). */
  commitGit?: Partial<ConductCommitGit>;
  /** Committer session runner (agent-commit mode). Distinct from the decomposer's `runSessionFn`. */
  committerSessionFn?: (p: RunSessionParams) => Promise<RunResult>;
  /** Unit-worktree teardown seam (default real `removeUnitWorktree`). */
  removeUnitWorktreeFn?: typeof removeUnitWorktree;
  /** RESUME: worktree reuse/recreate seam (default real `ensureUnitWorktree`). Used only by
   *  `resumeConduct` to reuse-or-recreate each unit's stable-named worktree before re-entry. */
  ensureUnitWorktreeFn?: typeof ensureUnitWorktree;
}

/** The result of a conduct run: the final run state + where it lives. */
export interface ConductResult {
  runId: string;
  runDir: string;
  state: ConductRunState;
}

/**
 * Wrap a base {@link RoleRunner} so that after EACH role-run its `ParentSummary` is attributed to the
 * owning unit (via the `SPARRA_CONDUCT_UNIT` env tag) and an incremental run.json snapshot lands.
 * Shared by the fresh run and the resume path. Holdout-safe: only allowlisted control fields are read.
 */
function makeTrackedRunRole(
  base: RoleRunner,
  entryByUnit: Map<string, UnitStateEntry>,
  state: ConductRunState,
  writer: RunStateWriter,
): RoleRunner {
  return async (spec: RunRoleSpec) => {
    const summary = await base(spec);
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
      // Persist each graded round's runner-persisted redacted verdict path (paths only), in round
      // order, so a later re-grade (normal OR resumed) can thread it forward as `--prior-blocking`.
      if (summary.roleKind === "evaluator" && summary.verdictPath) {
        (entry.verdictPaths ??= []).push(summary.verdictPath);
      }
      await writer.write(state);
    }
    return summary;
  };
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
  const trackedRunRole = makeTrackedRunRole(baseRunRole, entryByUnit, state, writer);

  // Run-global decision sequence + the conductor brain, both shared between the per-unit brain path
  // and the post-accept merge-landing decisions (so seq never collides across the two).
  const seqRef = { n: 0 };
  const brain = await buildConductBrain(ctx, opts, deps, runDir);

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
      brain,
      seqRef,
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

  // 5. Opt-in commit/merge landing (no flags → this block never runs; behavior is byte-identical to
  // today). `--merge` implies `--commit`. Serialized across accepted units.
  await runLanding(ctx, opts, deps, { runId, runDir, writer, state, brain, seqRef });

  state.status = "completed";
  await writer.write(state);
  const accepted = state.units.filter((u) => u.outcome === "accepted");
  ok(
    `conduct: run ${runId} complete — ${accepted.length}/${state.units.length} unit(s) accepted. ` +
      `Artifacts under ${runDir}.`,
  );
  return { runId, runDir, state };
}

/** The unit outcomes a `--resume` RE-ENTERS (mid-flight or errored). Everything else — `accepted`,
 *  `dry-run`, and the deliberate terminals (`abandoned`/`exhausted`/`inconclusive`/…) — is skipped. */
const RESUMABLE_OUTCOMES: ReadonlySet<UnitOutcome> = new Set(["pending", "running", "error"]);

/** Options for `sparra conduct --resume` (a subset of `ConductOptions` — the rest is loaded from the
 *  persisted `run.json`). */
export interface ResumeConductOptions {
  commit?: boolean;
  merge?: boolean;
  surface?: "park" | "park-timeout" | "auto";
  timeoutSec?: number;
}

/** The result of a resume attempt: the run was unknown, had nothing to continue, or was resumed. */
export type ResumeConductResult =
  | { status: "unknown-run"; runId: string; runDir: string }
  | { status: "nothing-to-do"; runId: string; runDir: string; state: ConductRunState }
  | { status: "resumed"; runId: string; runDir: string; state: ConductRunState };

/**
 * Resume a persisted conduct run IN PLACE: reload `.sparra/conduct/<runId>/run.json`, skip
 * accepted/dry-run units, re-enter pending/running/error units at the correct stage (an agreed/forced
 * contract file → straight to generate with NO contract role-run; otherwise renegotiate from the
 * persisted brief), reuse-or-recreate each unit worktree by its stable `<runId>-<unitId>` name, and
 * APPEND to the same run.json (monotonic decision seq continuing from the persisted max; a per-resume
 * `resumedAt`). Composes with `--commit`/`--merge` and the decision engine unchanged; prior parked
 * decisions stay answerable and a resume re-parks anything unresolved. No decomposer runs.
 *
 * An unknown runId returns `{ status: "unknown-run" }` with ZERO side effects (no run dir touched).
 * A run with no re-enterable units (e.g. a terminal all-accepted `completed`) is a no-op.
 */
export async function resumeConduct(
  ctx: Ctx,
  runId: string,
  opts: ResumeConductOptions = {},
  deps: ConductDeps = {},
): Promise<ResumeConductResult> {
  const runDir = conductRunDir(ctx.paths.dir, runId);
  const statePath = runStatePath(runDir);
  // Validate the runId as an OPAQUE identifier BEFORE trusting any path built from it: a `../`,
  // separator, or otherwise-unsafe id can never reach `exists()`/a write, so resume cannot escape
  // `.sparra/conduct/` or mutate an unrelated `run.json`. An unsafe (or simply unknown) id is rejected
  // with ZERO side effects — `path.join` above is pure, and `exists()` runs only for a safe id.
  if (!isSafeRunId(runId) || !exists(statePath)) return { status: "unknown-run", runId, runDir };

  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as ConductRunState;
  const now = () => new Date().toISOString();
  const writer = new RunStateWriter(runDir);

  const reenter = state.units.filter((u) => RESUMABLE_OUTCOMES.has(u.outcome));
  if (reenter.length === 0) {
    ok(
      `conduct --resume ${runId}: nothing to do — no pending/running/error unit to continue ` +
        `(${state.units.filter((u) => u.outcome === "accepted").length}/${state.units.length} accepted).`,
    );
    return { status: "nothing-to-do", runId, runDir, state };
  }

  // Record THIS resume (append; never overwrite prior resume stamps).
  (state.resumedAt ??= []).push(now());

  const entryByUnit = new Map<string, UnitStateEntry>();
  for (const u of state.units) entryByUnit.set(u.id, u);
  const reenterIds = new Set(reenter.map((u) => u.id));

  // Reconstruct run options from the persisted state; a plain (brainless) run resumes deterministic.
  const runOpts: ConductOptions = {
    prompt: state.prompt,
    maxUnits: state.maxUnits,
    concurrency: state.concurrency,
    dryRun: false,
    brain: state.brain ?? "hybrid",
    surface: opts.surface ?? state.decisionSurface ?? ctx.config.conduct.decisions.surface,
    timeoutSec: opts.timeoutSec ?? ctx.config.conduct.decisions.timeoutSec,
    ...(opts.commit || opts.merge ? { commit: true } : {}),
    ...(opts.merge ? { merge: true } : {}),
  };

  // Decision seq continues MONOTONICALLY from the persisted max (every prior decision, all units).
  const maxSeq = state.units.reduce(
    (m, u) => (u.decisions ?? []).reduce((mm, d) => Math.max(mm, d.seq), m),
    0,
  );
  const seqRef = { n: maxSeq };

  state.status = "running";
  state.brain = runOpts.brain;
  state.decisionSurface = runOpts.surface;
  await writer.write(state);

  info(formatRunStartAnnouncement(runId, runDir));

  const strategy = deps.strategy ?? deterministicStrategy;
  const sparraBin = deps.sparraBin ?? resolveSparraBin();
  // A plain (no-brain) run resumes WITHOUT a live conductor brain (deterministic policy); a
  // brain-mode run rebuilds it. An injected brain always wins (tests).
  let brain: Brain | undefined;
  if (deps.brain) brain = deps.brain;
  else if (deps.brain === null) brain = undefined;
  else if (state.brain) brain = await buildConductBrain(ctx, runOpts, deps, runDir);

  // Recover any UNRESOLVED persisted parked decision BEFORE re-entering units: re-surface it with a
  // fresh seq above the persisted max, answerable through the real `conduct --decide` path, and BLOCK
  // resume progress until it is answered (park) or auto-resolves (auto/park-timeout). This unblocks a
  // run that crashed mid-decision. `seqRef` already sits at the persisted max, so every recovered
  // decision (and everything after) is strictly above it. The RECOVERED ANSWER is then APPLIED to
  // control flow — a recovered `abandon`/`accept` STOPS the unit here (marked + excluded from
  // re-entry below) rather than being resolved-then-ignored while generation proceeds anyway.
  const recovered = await recoverParkedDecisions(ctx, runOpts, deps, { runDir, state, writer, brain, seqRef });

  // Apply recovered terminal decisions to resumed units (only ones actually re-entering — a leftover
  // parked decision on an already-terminal unit is retired, never used to re-decide that unit).
  const stopped = new Set<string>();
  for (const [unitId, outcome] of recovered) {
    if (!reenterIds.has(unitId)) continue;
    const entry = entryByUnit.get(unitId);
    if (!entry) continue;
    entry.outcome = outcome;
    delete entry.error;
    stopped.add(unitId);
    info(`conduct --resume: unit ${unitId} ${outcome} by recovered parked decision — not re-run.`);
  }
  await writer.write(state);

  // The units to actually re-run this resume: re-enterable AND not stopped by a recovered decision.
  const active = reenter.filter((u) => !stopped.has(u.id));

  // Reconstruct the units to continue (brief text from disk — NO decomposer role ever runs).
  const units: ConductUnit[] = active.map((entry) => ({
    id: entry.id,
    title: entry.title,
    summary: "",
    brief: exists(entry.briefPath) ? fs.readFileSync(entry.briefPath, "utf8") : "",
  }));

  // Per-unit re-entry plan + reuse/recreate the stable-named worktrees (only for units we re-run).
  const ensureWt = deps.ensureUnitWorktreeFn ?? ensureUnitWorktree;
  const resumePlanByUnit = new Map<string, UnitResumePlan>();
  for (const entry of active) {
    const contractReady =
      !!entry.contractPath &&
      exists(entry.contractPath) &&
      (entry.contractAgreed === true || entry.contractForced === true);
    resumePlanByUnit.set(entry.id, {
      seedVerdictPaths: [...(entry.verdictPaths ?? [])],
      ...(contractReady
        ? { resumeContract: { agreed: entry.contractAgreed ?? false, forced: entry.contractForced ?? false } }
        : {}),
    });
    const wtName = `${runId}-${entry.id}`;
    try {
      // RESUME reuses each stable worktree, but VERIFIES it is still a live tree on the expected
      // branch (`reverifyReuse`): a stale registry entry (dir removed, or now on another branch) is
      // repaired/recreated under the SAME identity rather than handed back pointing at nothing.
      const wt: EnsureUnitWorktreeResult = await ensureWt(ctx, wtName, ctx.root, { reverifyReuse: true });
      detail(`conduct --resume: unit ${entry.id} worktree ${wtName} ${wt.created ? "recreated" : "reused"} (${wt.dir}).`);
    } catch (e) {
      warn(
        `conduct --resume: unit ${entry.id} worktree ${wtName} not pre-provisioned ` +
          `(${e instanceof Error ? e.message : String(e)}); the generator role will (re)create it.`,
      );
    }
    // Re-enter clean: clear the prior error and reset to pending so the tracked runner flips it.
    entry.outcome = "pending";
    delete entry.error;
  }
  await writer.write(state);

  info(`conduct --resume: continuing ${units.length} unit(s) in run ${runId} (${runOpts.brain} mode).`);

  const baseRunRole = deps.runRole ?? coreRunRole;
  const trackedRunRole = makeTrackedRunRole(baseRunRole, entryByUnit, state, writer);

  await runBrainUnits(ctx, runOpts, deps, {
    runId,
    runDir,
    units,
    entryByUnit,
    state,
    writer,
    strategy,
    sparraBin,
    trackedRunRole,
    brain,
    seqRef,
    resumePlanByUnit,
  });

  // Land ONLY the units re-run this resume — never re-commit/re-merge prior-run accepted units.
  await runLanding(ctx, runOpts, deps, {
    runId,
    runDir,
    writer,
    state,
    brain,
    seqRef,
    restrictTo: new Set(reenter.map((u) => u.id)),
  });

  state.status = "completed";
  await writer.write(state);
  const accepted = state.units.filter((u) => u.outcome === "accepted");
  ok(
    `conduct --resume ${runId}: continued — ${accepted.length}/${state.units.length} unit(s) accepted. ` +
      `Artifacts under ${runDir}.`,
  );
  return { status: "resumed", runId, runDir, state };
}

/** Opt-in commit/merge landing, shared by the fresh run and the resume path. No flags → no-op
 *  (byte-identical to a report-only run). `--merge` implies `--commit`; accepted units are serialized.
 *  `restrictTo`, when present (resume), lands ONLY the units re-run this invocation — prior-run
 *  accepted units are left as they were. */
async function runLanding(
  ctx: Ctx,
  opts: ConductOptions,
  deps: ConductDeps,
  p: {
    runId: string;
    runDir: string;
    writer: RunStateWriter;
    state: ConductRunState;
    brain: Brain | undefined;
    seqRef: { n: number };
    restrictTo?: Set<string>;
  },
): Promise<void> {
  if (!opts.commit && !opts.merge) return;
  const surface = opts.surface ?? ctx.config.conduct.decisions.surface;
  const timeoutSec = opts.timeoutSec ?? ctx.config.conduct.decisions.timeoutSec;
  const nowMs = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const landingDeps: LandingDeps = {
    mode: opts.merge ? "merge" : "commit",
    runId: p.runId,
    runDir: p.runDir,
    writer: p.writer,
    state: p.state,
    ...(hasHoldout(ctx) ? { holdoutPaths: [ctx.paths.holdout, ctx.paths.frozenHoldout] } : {}),
    ...(deps.landingGit ? { git: deps.landingGit } : {}),
    ...(deps.commitGit ? { commitGit: deps.commitGit } : {}),
    ...(deps.committerSessionFn ? { runSessionFn: deps.committerSessionFn } : {}),
    ...(deps.removeUnitWorktreeFn ? { removeUnitWorktreeFn: deps.removeUnitWorktreeFn } : {}),
    surface,
    nowMs,
    sleep,
    ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
    timeoutSec,
    ...(p.brain ? { brainJudge: (r) => p.brain!.judge(r) } : {}),
    ...(deps.tty ? { tty: deps.tty } : {}),
    ...(deps.onDecisionRequest ? { onDecisionRequest: deps.onDecisionRequest } : {}),
    ...(p.restrictTo ? { restrictTo: p.restrictTo } : {}),
    seqRef: p.seqRef,
  };
  await landAcceptedUnits(ctx, landingDeps);
}

/**
 * RESUME: recover every UNRESOLVED persisted parked decision. A run that crashed while a decision was
 * parked leaves a `status: "pending"` record in `run.json`. On resume each is RE-SURFACED under a
 * fresh seq (strictly above the persisted max, since `seqRef` starts at that max) as a NEW pending
 * record, resolved through the SAME decision engine as a live judgment point — so it is answerable by
 * the real `sparra conduct --decide <runId> <newSeq> <answer>` path (which writes the `<newSeq>` file
 * the poller here reads). Under `park` this BLOCKS resume until answered; under `auto`/`park-timeout`
 * it auto-resolves. The stale pending record is transitioned to resolved in place (carrying the same
 * answer + a note pointing at the recovering seq) so one interrupted decision never lingers pending.
 *
 * Returns a map of unit id → the TERMINAL outcome a recovered answer implies (`abandon` → `abandoned`,
 * `accept`/`accept-anyway` → `accepted`), so the caller can STOP those units instead of resolving a
 * decision and then re-running the unit to a different outcome anyway. Non-terminal answers (finalize,
 * revise-brief, pivot, retry, wait, …) leave the unit to re-enter and continue normally.
 */
async function recoverParkedDecisions(
  ctx: Ctx,
  opts: ConductOptions,
  deps: ConductDeps,
  p: {
    runDir: string;
    state: ConductRunState;
    writer: RunStateWriter;
    brain: Brain | undefined;
    seqRef: { n: number };
  },
): Promise<Map<string, UnitOutcome>> {
  const terminal = new Map<string, UnitOutcome>();
  // Snapshot the stale pending records FIRST (we append new pending records below — never re-scan the
  // growing array, or a just-appended recovery record would itself look stale).
  const stale: Array<{ entry: UnitStateEntry; rec: DecisionRecord }> = [];
  for (const entry of p.state.units) {
    for (const rec of entry.decisions ?? []) {
      if (rec.status === "pending") stale.push({ entry, rec });
    }
  }
  if (stale.length === 0) return terminal;

  const surface = opts.surface ?? ctx.config.conduct.decisions.surface;
  const timeoutSec = opts.timeoutSec ?? ctx.config.conduct.decisions.timeoutSec;
  const nowMs = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (const { entry, rec } of stale) {
    const seq = (p.seqRef.n += 1); // strictly above the persisted max
    const requestedAt = new Date(nowMs()).toISOString();
    const req = buildDecisionRequest({
      seq,
      unit: rec.unit,
      kind: rec.kind,
      nowMs: nowMs(),
      timeoutSec,
      passThreshold: ctx.config.rubric.passThreshold,
    });
    const pending: DecisionRecord = {
      seq,
      unit: rec.unit,
      kind: rec.kind,
      question: req.question,
      options: req.options,
      default: req.default,
      status: "pending",
      requestedAt,
    };
    (entry.decisions ??= []).push(pending);
    await p.writer.write(p.state);
    info(
      `conduct --resume: recovering parked decision (was #${rec.seq}, ${rec.kind}) on ${rec.unit} ` +
        `as #${seq} — answer with \`sparra conduct --decide ${p.state.runId} ${seq} <answer>\`.`,
    );

    const tty: TtySeam | undefined =
      deps.tty ?? (surface !== "auto" && process.stdin.isTTY ? makeReadlineTty() : undefined);
    const engine: DecisionEngineDeps = {
      surface,
      runDir: p.runDir,
      nowMs,
      sleep,
      ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
      ...(p.brain ? { brainJudge: (r) => p.brain!.judge(r) } : {}),
      ...(tty ? { tty } : {}),
      ...(deps.onDecisionRequest ? { onRequestWritten: deps.onDecisionRequest } : {}),
    };
    const res = await resolveDecision(req, engine);

    // Resolve the RE-SURFACED record.
    pending.status = "resolved";
    pending.chosen = res.answer;
    pending.source = res.source;
    pending.via = res.via;
    if (res.rationale) pending.rationale = res.rationale;
    if (res.note) pending.note = res.note;
    pending.resolvedAt = new Date(nowMs()).toISOString();
    // Retire the STALE record in place (carry the same answer + a recovery note) so no interrupted
    // decision lingers pending after a resume.
    rec.status = "resolved";
    rec.chosen = res.answer;
    rec.source = res.source;
    rec.via = res.via;
    rec.note = `recovered on resume as #${seq}`;
    rec.resolvedAt = pending.resolvedAt;
    await p.writer.write(p.state);
    info(`conduct --resume: parked decision #${seq} on ${rec.unit} → "${res.answer}" (source ${res.source}, via ${res.via}).`);

    // Map a TERMINAL recovered answer onto the unit's outcome so the caller stops it. `abandon`
    // always terminates; `accept`/`accept-anyway` finalize the unit as accepted. (A later stale
    // record on the same unit can only ESCALATE to abandon, never downgrade an abandon to accept.)
    const outcome = terminalOutcomeFor(res.answer);
    if (outcome) {
      const prior = terminal.get(rec.unit);
      if (!(prior === "abandoned" && outcome === "accepted")) terminal.set(rec.unit, outcome);
    }
  }
  return terminal;
}

/** The terminal unit outcome a recovered parked-decision answer implies, or `undefined` when the
 *  answer means "keep going" (the unit re-enters and continues its build). */
function terminalOutcomeFor(answer: string): UnitOutcome | undefined {
  if (answer === "abandon") return "abandoned";
  if (answer === "accept" || answer === "accept-anyway") return "accepted";
  return undefined;
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
  /** The conductor brain (built once in `runConduct`), or undefined for deterministic policy. */
  brain: Brain | undefined;
  /** Run-global monotonic decision sequence (shared with the landing phase so seq never collides). */
  seqRef: { n: number };
  /** RESUME only: per-unit re-entry plan (skip-contract state + seed verdict paths). Absent on a
   *  fresh run — every unit negotiates from scratch and seeds no prior verdicts. */
  resumePlanByUnit?: Map<string, UnitResumePlan>;
}

/** RESUME: how one unit re-enters on `conduct --resume`. */
export interface UnitResumePlan {
  /** Present → skip the contract phase and reuse the persisted contract file with this state. */
  resumeContract?: { agreed: boolean; forced: boolean };
  /** Prior rounds' persisted redacted verdict paths to seed `--prior-blocking` on the re-grade. */
  seedVerdictPaths: string[];
}

/**
 * Build the conductor brain once (holdout-safe, read-only), shared by the per-unit brain path and
 * the post-accept merge-landing decisions. `deps.brain === null` forces NO brain (deterministic
 * policy at every judgment point); a supplied `deps.brain` is used as-is; otherwise one is built from
 * `deps.brainSessionFn` (real `runSession` by default) when `opts.brain` is set.
 */
async function buildConductBrain(
  ctx: Ctx,
  opts: ConductOptions,
  deps: ConductDeps,
  runDir: string,
): Promise<Brain | undefined> {
  if (!opts.brain) return undefined;
  if (deps.brain === null) return undefined;
  if (deps.brain) return deps.brain;
  return makeBrain({
    runSessionFn: deps.brainSessionFn ?? runSession,
    role: ctx.config.roles.conductor,
    systemPrompt: await loadPrompt(ctx.paths, "conductor"),
    cwd: runDir,
    traceDir: runDir,
    jsonReask: ctx.config.build.jsonReask,
    env: mergedBuildEnv(ctx.config),
    ...(deps.onBrainPrompt ? { onPrompt: deps.onBrainPrompt } : {}),
  });
}

/**
 * The conductor-brain path: run each unit's hybrid/llm orchestration bounded-concurrently, wiring the
 * decision engine (park/timeout/auto) at each judgment point and recording every decision into
 * `run.json`. The brain + decision-sequence counter are supplied by `runConduct` (shared with the
 * landing phase).
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

  const brain = p.brain;
  const nextSeq = () => (p.seqRef.n += 1);

  const runOne = async (unit: ConductUnit): Promise<void> => {
    const entry = p.entryByUnit.get(unit.id)!;
    const plan = p.resumePlanByUnit?.get(unit.id);
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
      ...(plan?.resumeContract ? { resumeContract: plan.resumeContract } : {}),
      ...(plan?.seedVerdictPaths?.length ? { seedVerdictPaths: plan.seedVerdictPaths } : {}),
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
