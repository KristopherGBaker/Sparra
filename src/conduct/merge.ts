import path from "node:path";

import type { Ctx } from "../context.ts";
import type { RunResult, RunSessionParams } from "../sdk/session.ts";
import { detail, info, warn } from "../util/log.ts";
import {
  abortMerge,
  abortRebase,
  addNamedWorktree,
  branchExists,
  currentBranch,
  defaultBranch,
  isDirty,
  listWorktrees,
  mergeCheckedOut,
  rebaseBranch,
  revParse,
} from "../util/git.ts";
import { defaultUnitWorktreeDir, removeUnitWorktree } from "../build/unitWorktree.ts";
import { commitUnit, type ConductCommitGit } from "./commit.ts";
import { buildDecisionRequest, type DecisionRecord, type JudgmentKind } from "./decision.ts";
import { resolveDecision, type DecisionEngineDeps, type TtySeam } from "./decisionEngine.ts";
import { makeOnRequestWritten } from "./decisionParked.ts";
import type { runScriptHooks } from "../scriptHooks.ts";
import { exists } from "../util/io.ts";
import type { BrainDecision, DecisionRequest } from "./decision.ts";
import { RunStateWriter } from "./runState.ts";
import type { ConductRunState, UnitStateEntry } from "./types.ts";

/**
 * `src/conduct/merge.ts` — opt-in commit/merge orchestration for `sparra conduct`.
 *
 * After a unit is ACCEPTED, `--commit` commits its worktree WIP onto its `sparra/<name>` unit branch
 * (see {@link ./commit.ts}). `--merge` (which implies `--commit`) then integrates the accepted
 * branch into a SAFE target — a new/reused run branch `sparra/<runId>` when conduct started FROM the
 * default branch, or the current branch otherwise — NEVER the repo's default branch (that land is the
 * human's job). Rebase+ff is preferred, with a merge-commit fallback. A conflict or a dirty target is
 * routed through the existing {@link ./decisionEngine.ts} as a PARKED decision. On a successful merge
 * the unit worktree is torn down via the existing `removeUnitWorktree` machinery (force-removed only
 * AFTER the branch is merged into the target). `run.json` records `committedSha` + `mergedInto`.
 *
 * Merges into the shared target are SERIALIZED: {@link landAcceptedUnits} processes accepted units
 * one at a time (each `await`ed), so concurrently-completing units never interleave git ops on the
 * target — no lost update, no duplicate.
 */

/** The run branch a default-branch-started conduct run merges accepted units into. `runId` already
 *  carries the `conduct-` prefix, so this reads `sparra/conduct-<stamp>`. Never the default branch. */
export function conductRunBranch(runId: string): string {
  return `sparra/${runId}`;
}

/** The sibling worktree dir the run branch is checked out in (default-branch case). */
export function conductMergeWorktreeDir(root: string, runId: string): string {
  return path.join(path.dirname(root), `${path.basename(root)}-merge-${runId}`);
}

/** Injectable git seam for the merge path (real git by default; fakes in tests). */
export interface LandingGit {
  currentBranch: typeof currentBranch;
  defaultBranch: typeof defaultBranch;
  branchExists: typeof branchExists;
  isDirty: typeof isDirty;
  revParse: typeof revParse;
  listWorktrees: typeof listWorktrees;
  addNamedWorktree: typeof addNamedWorktree;
  rebaseBranch: typeof rebaseBranch;
  abortRebase: typeof abortRebase;
  mergeCheckedOut: typeof mergeCheckedOut;
  abortMerge: typeof abortMerge;
}

export const realLandingGit: LandingGit = {
  currentBranch,
  defaultBranch,
  branchExists,
  isDirty,
  revParse,
  listWorktrees,
  addNamedWorktree,
  rebaseBranch,
  abortRebase,
  mergeCheckedOut,
  abortMerge,
};

/** Everything the landing phase needs beyond the per-unit entries. All I/O/clock/TTY injected. */
export interface LandingDeps {
  /** `commit` → commit only; `merge` → commit + merge (merge implies commit). */
  mode: "commit" | "merge";
  runId: string;
  runDir: string;
  writer: RunStateWriter;
  state: ConductRunState;
  /** Absolute holdout path(s) excluded from every commit. */
  holdoutPaths?: string[];
  git?: Partial<LandingGit>;
  commitGit?: Partial<ConductCommitGit>;
  /** Committer session runner (agent-commit mode); default real `runSession`. */
  runSessionFn?: (p: RunSessionParams) => Promise<RunResult>;
  /** Teardown seam (default real `removeUnitWorktree`). */
  removeUnitWorktreeFn?: typeof removeUnitWorktree;
  // ── decision-engine seams (a conflict / dirty target parks through the SAME engine) ──
  surface: "park" | "park-timeout" | "auto";
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs?: number;
  timeoutSec: number;
  brainJudge?: (req: DecisionRequest) => Promise<BrainDecision | undefined>;
  tty?: TtySeam;
  onDecisionRequest?: (requestPath: string) => void;
  /** The `runScriptHooks` invocation used to fire `onDecisionParked` when a merge-landing decision
   *  parks (default: the real runner). Threaded from `ConductDeps.runScriptHooksFn` so a merge park
   *  fires the hook + announce line identically to the build-loop park sites. */
  runScriptHooksFn?: typeof runScriptHooks;
  /** Run-global monotonic decision sequence (shared with the brain path so seq never collides). */
  seqRef: { n: number };
  /** RESUME only: restrict landing to these unit ids (the ones re-run this invocation), so a resume
   *  never re-commits/re-merges units already landed in a prior process. Absent on a fresh run —
   *  every accepted unit is landed, unchanged. */
  restrictTo?: Set<string>;
}

/** The resolved merge target for this run. */
interface MergeTarget {
  branch: string;
  /** Where `branch` is checked out (the current checkout, or a fresh run-branch worktree). */
  dir: string;
  startedOnDefault: boolean;
}

/** The outcome of merging ONE unit. */
type MergeStatus = "merged" | "parked" | "skipped" | "no-op";

/**
 * Land every ACCEPTED unit: commit its WIP, and (in `merge` mode) integrate its branch into the
 * shared target. Serialized across units. Mutates each unit's `run.json` entry (`committedSha`,
 * `mergedInto`) and records any parked decision. `abort-merge` stops merging remaining units (they
 * stay committed-only); `skip-unit` skips just the current one.
 */
export async function landAcceptedUnits(ctx: Ctx, deps: LandingDeps): Promise<void> {
  const accepted = deps.state.units.filter(
    (u) => u.outcome === "accepted" && (!deps.restrictTo || deps.restrictTo.has(u.id)),
  );
  if (accepted.length === 0) return;

  const gi: LandingGit = { ...realLandingGit, ...deps.git };

  // Resolve the merge target ONCE (merge mode only). A refusal downgrades to commit-only.
  let target: MergeTarget | undefined;
  let mergeMode = deps.mode === "merge";
  if (mergeMode) {
    const resolved = resolveMergeTarget(ctx, deps.runId, gi);
    if (!resolved.ok) {
      warn(`conduct: --merge — ${resolved.reason}; committing only (branches left for you to merge).`);
      mergeMode = false;
    } else {
      target = resolved.target;
    }
  }

  let abortAll = false;
  for (const entry of accepted) {
    // 1. Commit the unit's WIP onto its branch (both --commit and --merge). A successful commit that
    // yields a valid 40-hex SHA is the PREREQUISITE for any merge — we never touch the shared target
    // unless this step produced one.
    const committed = await commitAcceptedUnit(ctx, deps, entry);
    const committedSha = committed?.sha;
    if (isCommitSha(committedSha)) {
      entry.committedSha = committedSha;
      await deps.writer.write(deps.state);
    }

    if (!mergeMode || !target || abortAll) continue;

    // GATE: never begin merge orchestration unless the prerequisite WIP commit SUCCEEDED and produced
    // a valid commit SHA. On a failed / empty commit, route SAFELY — leave the unit's branch and its
    // worktree (with the uncommitted WIP) intact, never set `mergedInto`, never tear anything down.
    // The branch is left for the human to land manually.
    if (!isCommitSha(committedSha)) {
      warn(
        `conduct: unit ${entry.id} WIP was not committed (no valid commit SHA) — skipping merge; ` +
          `its branch + worktree (and WIP) are preserved.`,
      );
      continue;
    }

    // 2. Merge the committed branch into the shared target (serialized — one unit at a time).
    const branch = entry.branch;
    const worktreeDir = unitWorktreeDir(ctx, entry);
    if (!branch || !worktreeDir) {
      detail(`conduct: unit ${entry.id} has no branch/worktree to merge — skipping.`);
      continue;
    }
    const status = await mergeUnitIntoTarget(ctx, deps, gi, entry, branch, worktreeDir, target);
    if (status === "merged") {
      entry.mergedInto = target.branch;
      await deps.writer.write(deps.state);
      await teardownUnitWorktree(ctx, deps, entry, worktreeDir, branch, target.dir);
    } else if (status === "parked") {
      // The park answer decided skip-unit (continue) vs abort-merge (stop). Recorded already.
      if (entry.decisions?.some((d) => d.kind === "merge-blocked" && d.chosen === "abort-merge")) {
        abortAll = true;
      }
    }
    await deps.writer.write(deps.state);
  }
}

/** Commit one accepted unit's WIP; returns the branch tip sha or undefined. */
async function commitAcceptedUnit(
  ctx: Ctx,
  deps: LandingDeps,
  entry: UnitStateEntry,
): Promise<{ sha?: string } | undefined> {
  const worktreeDir = unitWorktreeDir(ctx, entry);
  if (!worktreeDir) {
    detail(`conduct: unit ${entry.id} has no unit worktree — nothing to commit.`);
    return undefined;
  }
  const res = await commitUnit(ctx, {
    unit: { id: entry.id, title: entry.title, ...(entry.score !== undefined ? { score: entry.score } : {}) },
    runId: deps.runId,
    worktreeDir,
    ...(deps.holdoutPaths ? { holdoutPaths: deps.holdoutPaths } : {}),
    agentCommits: ctx.config.git.agentCommits,
    traceDir: path.join(deps.runDir, entry.id),
    ...(deps.runSessionFn ? { runSessionFn: deps.runSessionFn } : {}),
    ...(deps.commitGit ? { git: deps.commitGit } : {}),
  });
  if (res.ok) info(`conduct: committed unit ${entry.id} WIP (${res.commits} commit(s)) → ${res.sha?.slice(0, 8)}.`);
  return res.ok ? { ...(res.sha ? { sha: res.sha } : {}) } : undefined;
}

/**
 * Rebase+ff (preferred) with a merge-commit fallback. A dirty target parks BEFORE any git op begins.
 * A rebase conflict falls back to a merge commit; if that also conflicts it is aborted (target
 * restored) and parked. Returns the merge disposition.
 */
async function mergeUnitIntoTarget(
  ctx: Ctx,
  deps: LandingDeps,
  gi: LandingGit,
  entry: UnitStateEntry,
  branch: string,
  worktreeDir: string,
  target: MergeTarget,
): Promise<MergeStatus> {
  // A dirty target → PARK before beginning ANY rebase/merge on it.
  if (gi.isDirty(target.dir)) {
    warn(`conduct: merge target ${target.branch} is dirty — parking unit ${entry.id}.`);
    return parkMergeDecision(ctx, deps, entry, target);
  }

  const message =
    `merge: land conduct unit ${entry.id} into ${target.branch}\n\n` +
    `${entry.title}\n\nSparra-Unit: ${entry.id} · conduct ${deps.runId}` +
    (entry.score !== undefined ? ` · score ${entry.score}` : "");

  // Prefer rebase+ff: replay the unit branch on top of the target, then fast-forward the target.
  const rebased = gi.rebaseBranch(worktreeDir, target.branch);
  if (rebased.ok) {
    // The rebase REWROTE the unit branch's commits onto the target, so the branch tip changed. The
    // pre-rebase `committedSha` is now dangling — record the SURVIVING rebased tip instead, so A14's
    // `committedSha` is the commit that actually lands (== the target tip after ff, or a parent of the
    // merge commit in the ff-failed fallback below) and stays reachable from `mergedInto` even after
    // the unit branch is torn down. See {@link teardownUnitWorktree}.
    await refreshCommittedShaAfterRebase(deps, entry, gi, worktreeDir);
    const ff = gi.mergeCheckedOut(target.dir, branch, {});
    if (ff.ok) {
      info(`conduct: merged unit ${entry.id} into ${target.branch} (rebase+ff).`);
      return "merged";
    }
    // FF failed post-rebase (should be rare) — fall through to the merge-commit fallback below.
    detail(`conduct: ff after rebase failed for ${entry.id} (${ff.out.trim()}); trying merge commit.`);
  } else {
    // Leave no in-progress rebase behind. The branch is restored to its pre-rebase tip, so the
    // recorded `committedSha` still matches it and becomes a parent of the merge commit below.
    gi.abortRebase(worktreeDir);
  }

  // Merge-commit fallback: a real merge commit on the target.
  const merged = gi.mergeCheckedOut(target.dir, branch, { noFf: true, message });
  if (merged.ok) {
    info(`conduct: merged unit ${entry.id} into ${target.branch} (merge commit).`);
    return "merged";
  }
  // Genuine conflict — abort so the target is left byte-identical, then PARK.
  gi.abortMerge(target.dir);
  warn(`conduct: merge conflict landing unit ${entry.id} into ${target.branch} — parking.`);
  return parkMergeDecision(ctx, deps, entry, target);
}

/**
 * After a successful rebase rewrote the unit branch onto the target, update `entry.committedSha` to
 * the branch's new (surviving) tip and persist it. Keeps A14's `committedSha` equal to the commit
 * that actually lands and reachable from `mergedInto` — never a dangling pre-rebase SHA. A no-op if
 * the tip can't be re-resolved (leaves the prior sha, which is at worst an ancestor of the new tip).
 */
async function refreshCommittedShaAfterRebase(
  deps: LandingDeps,
  entry: UnitStateEntry,
  gi: LandingGit,
  worktreeDir: string,
): Promise<void> {
  const tip = gi.revParse(worktreeDir, "HEAD") ?? undefined;
  if (isCommitSha(tip) && tip !== entry.committedSha) {
    entry.committedSha = tip;
    await deps.writer.write(deps.state);
  }
}

/** Surface a `merge-blocked` PARKED decision through the existing decision engine + audit trail. */
async function parkMergeDecision(
  ctx: Ctx,
  deps: LandingDeps,
  entry: UnitStateEntry,
  target: MergeTarget,
): Promise<MergeStatus> {
  const seq = (deps.seqRef.n += 1);
  const requestedAt = new Date(deps.nowMs()).toISOString();
  const req = buildDecisionRequest({
    seq,
    unit: entry.id,
    kind: "merge-blocked" as JudgmentKind,
    nowMs: deps.nowMs(),
    timeoutSec: deps.timeoutSec,
    passThreshold: ctx.config.rubric.passThreshold,
  });

  const pending: DecisionRecord = {
    seq,
    unit: entry.id,
    kind: "merge-blocked",
    question: req.question,
    options: req.options,
    default: req.default,
    status: "pending",
    requestedAt,
  };
  (entry.decisions ??= []).push(pending);
  await deps.writer.write(deps.state);
  detail(`conduct: merge decision #${seq} on ${entry.id} — awaiting ${req.options.join("/")} (default ${req.default}).`);

  const engine: DecisionEngineDeps = {
    surface: deps.surface,
    runDir: deps.runDir,
    nowMs: deps.nowMs,
    sleep: deps.sleep,
    ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
    ...(deps.brainJudge ? { brainJudge: deps.brainJudge } : {}),
    ...(deps.tty ? { tty: deps.tty } : {}),
    // On park: announce line (stdout) + always-fired best-effort onDecisionParked hook + the preserved
    // onDecisionRequest test seam, as a caught fire-and-forget (the seam stays sync).
    onRequestWritten: makeOnRequestWritten(
      ctx,
      { ...(deps.runScriptHooksFn ? { runScriptHooksFn: deps.runScriptHooksFn } : {}), ...(deps.onDecisionRequest ? { onDecisionRequest: deps.onDecisionRequest } : {}) },
      { runId: deps.runId, runDir: deps.runDir },
    ),
  };
  const res = await resolveDecision(req, engine);

  pending.status = "resolved";
  pending.chosen = res.answer;
  pending.source = res.source;
  pending.via = res.via;
  if (res.rationale) pending.rationale = res.rationale;
  if (res.note) pending.note = res.note;
  pending.resolvedAt = new Date(deps.nowMs()).toISOString();
  await deps.writer.write(deps.state);
  info(`conduct: merge decision #${seq} on ${entry.id} → "${res.answer}" (target ${target.branch} unchanged).`);
  return "parked";
}

/** Tear down a merged unit's worktree via the existing rm-worktree machinery (force — its branch is
 *  merged into the RUN target, not the default branch, so the merged-into-default check is bypassed). */
async function teardownUnitWorktree(
  ctx: Ctx,
  deps: LandingDeps,
  entry: UnitStateEntry,
  worktreeDir: string,
  branch: string,
  targetDir: string,
): Promise<void> {
  const name = entry.worktree;
  if (!name) return;
  const remove = deps.removeUnitWorktreeFn ?? removeUnitWorktree;
  // The unit worktree was created in a subprocess, so the parent's registry may not know it — seed a
  // registry entry (idempotent) so the existing teardown machinery can act on it.
  const registry = ctx.store.data.build.unitWorktrees ?? {};
  if (!registry[name]) {
    ctx.store.data.build.unitWorktrees = { ...registry, [name]: { dir: worktreeDir, branch, src: ctx.root } };
    await ctx.store.save();
  }
  void targetDir;
  const res = await remove(ctx, name, { force: true });
  if (res.ok) detail(`conduct: tore down unit worktree ${name} after merge.`);
  else warn(`conduct: unit worktree ${name} teardown after merge had warnings: ${res.message}`);
}

/**
 * Resolve the safe merge target. Started on the default branch → a new/reused run branch
 * `sparra/<runId>` checked out in a fresh sibling worktree; started on a non-default branch → that
 * branch (checked out in the current checkout). NEVER the default branch. Refuses (commit-only) if
 * the default branch can't be resolved, or the current branch equals it AND the run worktree can't
 * be created.
 */
export function resolveMergeTarget(
  ctx: Ctx,
  runId: string,
  gi: LandingGit,
): { ok: true; target: MergeTarget } | { ok: false; reason: string } {
  const cur = gi.currentBranch(ctx.root);
  const def = gi.defaultBranch(ctx.root);
  if (!cur) return { ok: false, reason: "could not resolve the current branch" };
  if (!def) return { ok: false, reason: "could not resolve the default branch (refusing to guess a safe target)" };

  if (cur !== def) {
    // Non-default branch: merge into it, in place.
    return { ok: true, target: { branch: cur, dir: ctx.root, startedOnDefault: false } };
  }

  // Default branch: never touch it — create/reuse the run branch in a sibling worktree.
  const branch = conductRunBranch(runId);
  const dir = conductMergeWorktreeDir(ctx.root, runId);
  if (exists(dir)) {
    // A prior unit in this run (or a resumed run) may have created the run worktree — but a
    // same-named foreign dir might also exist. Before reusing it, VALIDATE against git ground truth
    // that `dir` is a live linked worktree OF THIS repo checked out on EXACTLY our run branch. Reuse
    // only on an exact match; anything else (a plain dir, a worktree on another branch, a worktree of
    // another repo) is NOT ours → refuse and commit-only rather than risk merging into a foreign tree.
    const match = gi.listWorktrees(ctx.root).find((w) => path.resolve(w.path) === path.resolve(dir));
    if (match && match.branch === branch) {
      return { ok: true, target: { branch, dir, startedOnDefault: true } };
    }
    return {
      ok: false,
      reason:
        `run worktree ${dir} already exists but is not a live ${branch} worktree of this repo ` +
        `(${match ? `checked out on ${match.branch ?? "a detached HEAD"}` : "not a registered worktree"}); ` +
        `refusing to reuse it`,
    };
  }
  const added = gi.addNamedWorktree(ctx.root, dir, branch);
  if (!added.ok) return { ok: false, reason: `could not create the run worktree ${dir} on ${branch}: ${added.out.trim()}` };
  return { ok: true, target: { branch, dir, startedOnDefault: true } };
}

/** The deterministic unit worktree dir for an entry (name-derived; the WIP lives here). */
function unitWorktreeDir(ctx: Ctx, entry: UnitStateEntry): string | undefined {
  return entry.worktree ? defaultUnitWorktreeDir(ctx.root, entry.worktree) : undefined;
}

/** A valid git commit SHA (40-hex) — the commit step MUST produce one before any merge may begin. */
function isCommitSha(sha: string | undefined): sha is string {
  return typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha);
}
