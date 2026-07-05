import path from "node:path";
import { createHash } from "node:crypto";
import type { Ctx } from "../context.ts";
import { newRunId } from "../context.ts";
import type { ItemState } from "../state.ts";
import { banner, color, detail, info, ok, step, warn } from "../util/log.ts";
import { appendText, exists, readText } from "../util/io.ts";
import { prepareWorkspace, changedFiles } from "../util/git.ts";
import { provisionWorkspaceDeps } from "../util/provision.ts";
import { commitItem } from "../build/commit.ts";
import { writeScopeViolations } from "../sdk/scoping.ts";
import { ensureAutoProbed } from "../sdk/guard.ts";
import { decompose } from "../build/decompose.ts";
import { negotiateContract } from "../build/contract.ts";
import { generateItem } from "../build/generate.ts";
import { evaluateItem } from "../build/evaluate.ts";
import { reviewItem } from "../build/review.ts";
import type { ReviewOutput } from "../build/review.ts";
import type { Deviation } from "../build/generate.ts";
import { updateStreaksAndDecide } from "../build/pivot.ts";
import { maybeResetWorkspace } from "../build/reset.ts";
import { recordAttempt, attemptFailure, renderPriorAttempts, APPROACH_CAP } from "../build/attempts.ts";
import { renderPatchFeedback, renderPivotFeedback, renderBlockedFeedback } from "../build/feedback.ts";
import { budgetExceeded, tokensExceeded, remainingBudget, costUsdOrZero, zeroCostTokenFallbackExceeded } from "../build/budget.ts";
import { waitForLimit } from "../build/autoRestart.ts";
import { recordDeviations, reconcilePlan } from "../build/reconcile.ts";
import { measureAcceptedItem, renderMeasureLearning } from "../build/measure.ts";
import { diffClaims, renderClaimGap } from "../build/claims.ts";
import { assertNoHoldoutLeak, readHoldout, redactHoldout } from "../build/holdout.ts";
import { classifyExec, extractVerifyCommands, renderExecOutcome, rerunVerifyCommands, runVerifyCommand, type CommandExecutor } from "../build/exec.ts";
import { mergedBuildEnv } from "../build/env.ts";
import {
  writeContractPause,
  writeRoundPause,
  readRoundDecision,
  writeCommitPause,
  readCommitDecision,
  writeItemPause,
  readItemDecision,
  pauseDirRel,
  type Step,
  type Decision,
} from "../build/interactive.ts";
import type { LimitHit } from "../sdk/backend.ts";
import { appendLearning, readMemory, hasLearning } from "../memory.ts";
import { promptDrift, summarizePromptDrift } from "../prompts.ts";
import type { WorkItem } from "../build/types.ts";
import type { RoleConfig } from "../config.ts";

/** Injectable seams so the build orchestration is testable without the SDK/git. */
export interface BuildDeps {
  ensureAutoProbed: typeof ensureAutoProbed;
  prepareWorkspace: typeof prepareWorkspace;
  decompose: typeof decompose;
  negotiateContract: typeof negotiateContract;
  generateItem: typeof generateItem;
  evaluateItem: typeof evaluateItem;
  reviewItem: typeof reviewItem;
  recordDeviations: typeof recordDeviations;
  reconcilePlan: typeof reconcilePlan;
  appendLearning: typeof appendLearning;
  readMemory: typeof readMemory;
  commitItem: typeof commitItem;
  waitForLimit: typeof waitForLimit;
  provisionWorkspaceDeps: typeof provisionWorkspaceDeps;
  /** Gate-checked workspace reset on a pivot (destructive; see build/reset.ts). */
  maybeResetWorkspace: typeof maybeResetWorkspace;
  /** No-model safe executor for the contract verify-probe + flakiness rerun gate. */
  execVerifyCommand: CommandExecutor;
  /** Config-gated post-accept measure step (injectable so build.test.ts can fake the whole run). */
  measureAccepted: typeof measureAcceptedItem;
}

const defaultDeps: BuildDeps = {
  ensureAutoProbed,
  prepareWorkspace,
  decompose,
  negotiateContract,
  generateItem,
  evaluateItem,
  reviewItem,
  recordDeviations,
  reconcilePlan,
  appendLearning,
  readMemory,
  commitItem,
  waitForLimit,
  provisionWorkspaceDeps,
  maybeResetWorkspace,
  execVerifyCommand: runVerifyCommand,
  measureAccepted: measureAcceptedItem,
};

/** Provider account a role runs against — the granularity a rate/usage limit applies to.
 *  (Claude's plan window is account-wide across models, so we key by backend, not model.) */
const backendKey = (r: RoleConfig): string => r.backend ?? "claude";

/** Walk a role's fallback chain and return the first whose backend is NOT in a limit window.
 *  Falls back to the primary (which will then trigger a wait) when all are limited. */
function pickRole(
  primary: RoleConfig,
  limited: Map<string, number>,
  now: number
): { role: RoleConfig; usedFallback: boolean } {
  let r: RoleConfig | undefined = primary;
  let usedFallback = false;
  for (let guard = 0; r && guard < 10; guard++) {
    const until = limited.get(backendKey(r));
    if (!until || until <= now) return { role: r, usedFallback };
    r = r.fallback;
    usedFallback = true;
  }
  return { role: primary, usedFallback: false }; // every model in the chain is limited → wait
}

/** True when `role` has any fallback in its chain on a backend that isn't currently limited. */
function hasAvailableFallback(role: RoleConfig, limited: Map<string, number>, now: number): boolean {
  let r = role.fallback;
  for (let guard = 0; r && guard < 10; guard++) {
    const until = limited.get(backendKey(r));
    if (!until || until <= now) return true;
    r = r.fallback;
  }
  return false;
}

function freshItemState(): ItemState {
  return { status: "pending", round: 0, pivots: 0, criterionFailStreak: {}, costUsd: 0, tokensUsed: 0 };
}

export async function cmdBuild(
  ctx: Ctx,
  opts: { fresh?: boolean; only?: string; workspaceOverride?: string; quiet?: boolean; step?: Step[] } = {},
  depOverrides: Partial<BuildDeps> = {}
): Promise<{ passed: number; failed: number; budgetExceeded: number; total: number; runId: string }> {
  const d: BuildDeps = { ...defaultDeps, ...depOverrides };
  banner("Phase C · AUTONOMOUS BUILD");
  const b = ctx.store.data;

  if (b.phase !== "frozen" && b.phase !== "build" && b.phase !== "done") {
    warn(`Build requires a frozen plan. Current phase: ${b.phase}. Run \`sparra freeze\` first.`);
    return { passed: 0, failed: 0, budgetExceeded: 0, total: 0, runId: "" };
  }
  if (!exists(ctx.paths.frozenPlan) && !exists(ctx.paths.plan)) {
    warn("No plan found to build from.");
    return { passed: 0, failed: 0, budgetExceeded: 0, total: 0, runId: "" };
  }

  // Surface prompt drift once at build start via the shared summarizer, so this note reads
  // identically to the role-runner / loop note (single source of truth). Only ACTIONABLE drift is
  // surfaced — a newer default (`stale`, adoptable) or a `conflict` — since the build reads the
  // local copies under .sparra/prompts/. Pure local edits are intentional and stay quiet.
  if (!opts.quiet) {
    const summary = summarizePromptDrift(await promptDrift(ctx.paths));
    if (summary.actionable && summary.line) info(`Note: ${summary.line}.`);
  }

  // Run id + workspace (resumable).
  if (opts.fresh || !b.build.runId) {
    b.build.runId = newRunId("build");
    b.build.traceSeq = 0;
    b.build.items = {};
    b.build.workspaceDir = undefined;
    // A fresh run must not inherit a prior run's interactive mode or a stale pause.
    b.build.step = undefined;
    b.build.paused = undefined;
  }
  const runId = b.build.runId!;
  const traceDir = ctx.paths.traceDir(runId);
  await ctx.store.transition("build", true);
  await d.ensureAutoProbed(ctx);

  if (!b.build.workspaceDir) {
    if (opts.workspaceOverride) {
      b.build.workspaceDir = opts.workspaceOverride;
      b.build.workspaceNote = `isolated workspace ${path.relative(ctx.root, opts.workspaceOverride)}`;
    } else {
      const ws = d.prepareWorkspace(ctx.root, ctx.config.git.strategy, ctx.config.git.branchPrefix, runId);
      b.build.workspaceDir = ws.dir;
      b.build.branch = ws.branch;
      b.build.workspaceNote = ws.note;
    }
    // Provision the repo's deps into the isolated worktree so the generator's verify commands and
    // the evaluator's `npm test` can run there. Gated to the worktree boundary (NOT `b.build.branch`,
    // which a workspace override never sets) — an in-place run already has the deps. Non-fatal.
    if (b.build.workspaceDir !== ctx.root) {
      d.provisionWorkspaceDeps(ctx.root, b.build.workspaceDir!, ctx.config.git.provisionDeps);
    }
    await ctx.store.save();
  }
  const workspaceDir = b.build.workspaceDir!;
  info(`run: ${runId}`);
  detail(`workspace: ${b.build.workspaceNote}`);
  detail(`exercise mechanism: ${ctx.config.exercise.mechanism} · deviation: ${ctx.store.data.mode}/${ctx.config.deviation.strictness}`);

  // Warn on the classic "I re-froze but build did nothing" trap: the frozen plan changed,
  // but the run isn't being re-decomposed, so the old (already-passed) items are reused.
  const planText = (await readText(ctx.paths.frozenPlan)) ?? (await readText(ctx.paths.plan)) ?? "";
  const planHash = createHash("sha1").update(planText).digest("hex").slice(0, 12);
  if (!opts.fresh && exists(ctx.paths.workitemsFile) && b.build.lastBuiltPlanHash && b.build.lastBuiltPlanHash !== planHash) {
    warn("The frozen plan changed since these work items were decomposed.");
    info("Re-run with `sparra build --fresh` to rebuild from the new plan, or `sparra new` to start a fresh cycle. (Continuing with the existing items for now.)");
  }

  // Decompose (idempotent).
  const allItems = await d.decompose(ctx, traceDir, opts.fresh, workspaceDir);
  b.build.lastBuiltPlanHash = planHash;
  await ctx.store.save();
  if (allItems.length === 0) {
    await ctx.store.transition("done", true);
    return { passed: 0, failed: 0, budgetExceeded: 0, total: 0, runId };
  }
  const items = opts.only ? allItems.filter((i) => i.id === opts.only) : allItems;

  // A single interactive pause is in flight at a time. Refuse a `--only` that would skip it
  // (which would orphan or overwrite the pause); resume the paused item first, or start fresh.
  if (b.build.paused && opts.only && opts.only !== b.build.paused.itemId) {
    warn(
      `Item ${b.build.paused.itemId} is paused at an interactive checkpoint — resume it first ` +
        `(\`sparra build\` without --only) or restart with \`sparra build --fresh\`.`
    );
    return { passed: 0, failed: 0, budgetExceeded: 0, total: 0, runId };
  }

  const nextSeq = () => {
    b.build.traceSeq = (b.build.traceSeq ?? 0) + 1;
    return b.build.traceSeq;
  };

  let totalCost = 0;
  const cap = ctx.config.build.maxBudgetUsdPerItem; // 0 = unlimited (opt-out)
  const tokenCap = ctx.config.build.maxTokensPerItem; // 0 = unlimited (opt-out)
  const zeroCostTokenCap = ctx.config.build.zeroCostTokenCap; // 0 = unlimited (opt-out)
  const overZeroCostFallback = (s: ItemState) =>
    zeroCostTokenFallbackExceeded({
      usdCap: cap,
      explicitTokenCap: tokenCap,
      zeroCostTokenCap,
      spentUsd: s.costUsd ?? 0,
      usedTokens: s.tokensUsed ?? 0,
    });
  const overBudget = (s: ItemState) => budgetExceeded(cap, s.costUsd ?? 0) || tokensExceeded(tokenCap, s.tokensUsed ?? 0) || overZeroCostFallback(s);
  const stamp = () => new Date().toISOString();
  const effectiveTokenCapName = (): string => {
    if (tokenCap > 0) return `build.maxTokensPerItem (${tokenCap} tokens)`;
    if (zeroCostTokenCap > 0) return `build.zeroCostTokenCap (${zeroCostTokenCap} tokens)`;
    return "no token cap (build.maxTokensPerItem=0, build.zeroCostTokenCap=0)";
  };
  const warnZeroCostUsdIneffective = (itemId: string, s: ItemState): void => {
    if (cap <= 0 || (s.tokensUsed ?? 0) <= 0 || (s.costUsd ?? 0) > 0) return;
    warn(
      `${itemId}: USD cap did not bind because reported cost was zero or unknown; effective token bound: ${effectiveTokenCapName()}.`
    );
  };

  // Auto-restart / fallback state (the "heartbeat"). limitedUntil tracks which backends are in
  // a limit window; it survives a process restart via b.build.limitedRoles.
  const ar = ctx.config.build.autoRestart;
  let restarts = b.build.restarts ?? 0;
  let stopRun = false;
  const limitedUntil = new Map<string, number>(Object.entries(b.build.limitedRoles ?? {}));
  const persistLimits = () => {
    b.build.limitedRoles = Object.fromEntries(limitedUntil);
  };

  // Interactive checkpoints (`sparra build --step=contract,round`). Empty set = fully
  // autonomous: every interactive branch below is skipped, so behavior is unchanged.
  const steps = new Set<Step>(opts.step ?? b.build.step ?? []);
  if (opts.step) {
    b.build.step = [...steps];
    await ctx.store.save();
  }
  let pausedRun = false;
  let humanStop = false; // an `item`-gate "stop" decision ended this run cleanly (resumable)

  // A holdout-free summary of the change about to be committed (file paths only), for the
  // commit checkpoint's pause.md. Never reads holdout content — the holdout file itself is
  // excluded from the listing (it's evaluator-only machinery).
  const commitPlanText = (): string => {
    const holdoutRel = [ctx.paths.holdout, ctx.paths.frozenHoldout]
      .map((p) => path.relative(workspaceDir, p))
      .filter((p) => p && !p.startsWith(".."));
    const files = changedFiles(workspaceDir)
      .map((p) => path.relative(workspaceDir, p))
      .filter((f) => !holdoutRel.includes(f));
    const cap = 50;
    const shown = files.slice(0, cap).map((f) => `- ${f}`);
    if (files.length > cap) shown.push(`- …(+${files.length - cap} more)`);
    return shown.join("\n");
  };

  // ── Interactive: ITEM gate. Pause before advancing to the NEXT item (never after the last
  // item in this run). Returns true when a pause was written (caller sets pausedRun + breaks). ──
  const maybeItemGate = async (it: WorkItem, st: ItemState): Promise<boolean> => {
    if (!steps.has("item")) return false;
    const idx = items.findIndex((i) => i.id === it.id);
    if (idx < 0 || idx >= items.length - 1) return false; // not found, or the last item → no pause
    await writeItemPause(ctx, { runId, itemId: it.id, itemTitle: it.title, status: st.status, holdoutText: await readHoldout(ctx) });
    b.build.paused = { kind: "item", itemId: it.id, round: st.round };
    await ctx.store.save();
    info(`${it.id}: paused after the item (${st.status}) — decide in ${pauseDirRel(ctx, runId, it.id)}/decision.json, then \`sparra build\`.`);
    return true;
  };

  // The "passed" memory line for an autonomously-accepted item, reconstructable from durable
  // state alone — so a resume that finishes a crashed/deferred acceptance records the same
  // learning the inline accept would have (a commit-gate / crash defers the memory step to a
  // later run where the round verdict is no longer in scope). `overrideReason` is durable, so
  // a human override keeps its wording across a resume too.
  const passedDetail = (st: ItemState): string =>
    st.overrideReason
      ? `human-accepted round ${st.round} OVERRIDING evaluator (score ${st.lastScore ?? 0}): ${st.overrideReason}`
      : `accepted in round ${st.round} (score ${st.lastScore ?? 0}); $${(st.costUsd ?? 0).toFixed(3)} spent${st.pivots ? `, ${st.pivots} pivot(s)` : ""}.`;

  // True once every acceptance side effect has been resolved for a passed item.
  const acceptanceComplete = (a: NonNullable<ItemState["acceptance"]>): boolean =>
    !!a.reconciled && !!a.committed && !!a.memoryAppended;

  // ── Idempotent acceptance finisher. The SINGLE path both accept routes funnel through, so a
  // process kill anywhere between "mark passed" and the reconcile/commit/memory side effects can
  // neither LOSE nor DOUBLE them. Each step is guarded by its durable sub-state flag and
  // persisted the instant the flag flips, so a resume re-drives only the unfinished steps.
  //   "done"   → all side effects resolved
  //   "paused" → parked at the commit gate (caller sets pausedRun + breaks; resume finishes it) ──
  const finishAcceptance = async (
    st: ItemState,
    item: WorkItem,
    deviations: Deviation[],
    opts: { overrideReason?: string; memoryDetail?: string } = {}
  ): Promise<"done" | "paused"> => {
    // Mark passed + open the acceptance ledger ATOMICALLY: a crash anywhere after this save is
    // recoverable (status="passed" with an incomplete ledger drives the top-of-loop resume).
    if (st.status !== "passed" || !st.acceptance) {
      st.status = "passed";
      st.acceptance ??= {};
      // Persist the deviations BEFORE opening acceptance: crash-recovery at the top of the loop
      // re-drives the finisher with `st.lastDeviations`, so without this a recovered accept would
      // reconcile/commit with LOST deviation context. (On a re-entry — status already passed with
      // a ledger — this block is skipped, so the stored deviations are never clobbered.)
      st.lastDeviations = deviations;
      if (opts.overrideReason) st.overrideReason = opts.overrideReason;
      await ctx.store.save();
    }
    const acc = st.acceptance!;

    // 1) reconcile (exactly once).
    if (!acc.reconciled) {
      await d.reconcilePlan(ctx, item, deviations, traceDir, nextSeq());
      acc.reconciled = true;
      await ctx.store.save();
    }

    // 1.5) measure — OPTIONAL, config-gated, exactly once (guarded by `!acc.measured`), positioned
    //      AFTER reconcile and BEFORE the commit. NON-BLOCKING by design: it never changes `status`
    //      and never prevents the commit — a regression is a SIGNAL (artifact + memory line + reflect
    //      feed), not a gate. Runs the command with cwd = the WORKTREE holding the accepted artifact
    //      (`workspaceDir`); the baseline lives under the MAIN repo `.sparra` so it survives worktree
    //      teardown (see build/measure.ts). `measured` is NOT in `acceptanceComplete` (a disabled
    //      project must still complete acceptance), and is persisted the instant it flips.
    if (!acc.measured && ctx.config.measure.enabled && ctx.config.measure.command) {
      try {
        const mr = await d.measureAccepted(ctx, workspaceDir);
        const summary = renderMeasureLearning(mr);
        await d.appendLearning(ctx.paths, { item: item.id, kind: "measure", detail: summary, at: stamp() });
        if (mr.regressions.length) {
          warn(
            `${item.id}: measure flagged ${mr.regressions.length} regression(s) — SIGNAL only, commit proceeds` +
              (mr.reportPath ? ` (report: ${path.relative(ctx.root, mr.reportPath)})` : "") + "."
          );
        } else {
          detail(`${item.id}: ${summary}`);
        }
      } catch (e) {
        // Measure is a signal; a failure here must never block the commit or reopen the item.
        warn(`${item.id}: measure step errored (non-fatal, commit proceeds): ${(e as Error).message}`);
      }
      acc.measured = true;
      await ctx.store.save();
    }

    // 2) commit — resolved exactly once (committed | human-skipped | N/A).
    if (!acc.committed) {
      const autoCommit = ctx.config.git.autoCommit && !!b.build.branch;
      const gate = steps.has("commit") && autoCommit;
      const parked = b.build.paused?.itemId === item.id && b.build.paused.kind === "commit";
      if (gate && !parked) {
        // Item A's commit gate: accepted (passed) but defer the commit to the human. Stash the
        // deviations so the resume can build the commit; leave `committed` unset (not resolved).
        st.lastDeviations = deviations;
        await writeCommitPause(ctx, { runId, itemId: item.id, itemTitle: item.title, planText: commitPlanText(), holdoutText: await readHoldout(ctx) });
        b.build.paused = { kind: "commit", itemId: item.id, round: st.round };
        await ctx.store.save();
        return "paused";
      }
      // Resolve: gate off → commit (when autoCommit); gate on → honour the human's commit/skip.
      const decision = parked ? await readCommitDecision(ctx, runId, item.id) : "commit";
      if (decision === "commit" && autoCommit) {
        const cr = await d.commitItem(ctx, { item, deviations, runId, workspaceDir, traceDir, traceSeq: nextSeq() });
        detail(cr.commits ? `committed ${item.id} (${cr.commits} commit${cr.commits > 1 ? "s" : ""}) → ${b.build.branch}` : `commit skipped (${item.id})`);
      } else if (parked) {
        detail(`${item.id}: commit skipped by human (item stays passed).`);
      }
      if (parked) b.build.paused = undefined;
      // Flag-AFTER-effect (deliberate): `committed` is saved only once commitItem has returned.
      // Setting it BEFORE the commit would risk LOSING the commit on a crash (worse than a re-run).
      // The cost is that a kill in the post-commit / pre-save window resumes here and re-invokes
      // commitItem — but that is a NO-OP: the change was committed on the pre-crash attempt, so the
      // working tree is clean and commitItem finds nothing to stage (returns `{ commits: 0 }`). The
      // NET effect across the crash is therefore exactly one commit object, never two.
      acc.committed = true;
      await ctx.store.save();
    }

    // 3) memory (exactly once). The flag alone can't guarantee this: a crash AFTER the append but
    // BEFORE the flag saves would re-append on resume (appendLearning is append-only). So dedup on
    // the durable artifact — skip if a `passed` line for this item already exists — which holds
    // even when the flag-save was lost.
    if (!acc.memoryAppended) {
      if (!(await hasLearning(ctx.paths, item.id, "passed"))) {
        await d.appendLearning(ctx.paths, { item: item.id, kind: "passed", detail: opts.memoryDetail ?? passedDetail(st), at: stamp() });
      }
      acc.memoryAppended = true;
      await ctx.store.save();
    }
    return "done";
  };

  // Accept an item on a human decision (--step mode): drive the idempotent finisher (reconcile →
  // commit → memory). Mirrors the autonomous accept minus the review gate — the human IS the gate
  // here. Returns "commit-paused" when the commit gate deferred the commit (the caller must break).
  const acceptItem = async (
    st: ItemState,
    item: WorkItem,
    deviations: Deviation[],
    overrideReason?: string
  ): Promise<"done" | "commit-paused"> => {
    const memoryDetail = overrideReason
      ? `human-accepted round ${st.round} OVERRIDING evaluator (score ${st.lastScore ?? 0}): ${overrideReason}`
      : `human-accepted round ${st.round} (score ${st.lastScore ?? 0}).`;
    const res = await finishAcceptance(st, item, deviations, { overrideReason, memoryDetail });
    ok(`${item.id} accepted by human${overrideReason ? " (override)" : ""} in round ${st.round}.`);
    if (res === "paused") {
      info(`${item.id}: paused before commit — review ${pauseDirRel(ctx, runId, item.id)}/pause.md, then \`sparra build\`.`);
      return "commit-paused";
    }
    return "done";
  };

  // Called after every generator/evaluator session. On a provider rate/usage limit it either
  // switches to a fallback model or waits the window out, then asks the caller to redo the round.
  //   "none"  → no limit (or auto-restart off): proceed normally
  //   "retry" → handled (fell back, or waited): redo this round (role is re-picked at the top)
  //   "halt"  → out of restarts: stop the run cleanly (resume later with `sparra build`)
  const onLimit = async (
    st: ItemState,
    roleUsed: RoleConfig,
    hit: LimitHit | undefined,
    label: string
  ): Promise<"none" | "retry" | "halt"> => {
    if (!hit || !ar.enabled) return "none";
    const key = backendKey(roleUsed);
    const until = hit.resetAt ?? Date.now() + ar.pollSec * 1000;
    limitedUntil.set(key, until);
    persistLimits();
    st.round = Math.max(0, st.round - 1); // a limit isn't a failed attempt — give the round back

    // Prefer an immediate switch to an available fallback model over sleeping.
    if (hasAvailableFallback(roleUsed, limitedUntil, Date.now())) {
      warn(`${label}: ${key} hit a ${hit.kind} limit — switching to a fallback model.`);
      await ctx.store.save();
      return "retry";
    }
    // No fallback available → wait for the window to reopen (bounded by maxRestarts).
    if (restarts >= ar.maxRestarts) {
      warn(`${label}: ${key} ${hit.kind} limit and maxRestarts (${ar.maxRestarts}) reached — stopping. Re-run \`sparra build\` to resume.`);
      return "halt";
    }
    b.build.restarts = ++restarts;
    b.build.waitingUntil = until;
    await ctx.store.save(); // checkpoint BEFORE sleeping: a kill mid-wait still resumes from disk
    await d.waitForLimit(hit, ar, (m) => detail(m));
    limitedUntil.delete(key); // window assumed reopened after the wait
    b.build.waitingUntil = undefined;
    persistLimits();
    await ctx.store.save();
    return "retry";
  };

  for (const item of items) {
    const st = (b.build.items[item.id] ??= freshItemState());
    if (st.costUsd == null) st.costUsd = 0;
    if (st.tokensUsed == null) st.tokensUsed = 0;

    // ── Crash-recovery + commit-gate resume. Detected BEFORE the passed/abandoned/budget skip
    // below, because the item is already `passed` — skipping it would drop any acceptance side
    // effect that never ran. A passed item with an INCOMPLETE acceptance ledger (a kill between
    // "mark passed" and reconcile/commit/memory, OR a deferred commit gate) finishes the
    // remaining effects here via the idempotent finisher; each runs exactly once. (A legacy
    // passed item predating the ledger has no `acceptance` and is treated as already-finished.) ──
    if (st.status === "passed" && st.acceptance && !acceptanceComplete(st.acceptance)) {
      const res = await finishAcceptance(st, item, (st.lastDeviations ?? []) as Deviation[], { memoryDetail: passedDetail(st) });
      if (res === "paused") { pausedRun = true; break; } // still waiting on the commit gate
      // The item is already passed — fall through to the item gate, then the passed-skip.
      if (await maybeItemGate(item, st)) { pausedRun = true; break; }
    }

    // ── Interactive: resume an ITEM pause. The item is already terminal; apply continue/stop. ──
    if (b.build.paused?.itemId === item.id && b.build.paused.kind === "item") {
      const decision = await readItemDecision(ctx, runId, item.id);
      b.build.paused = undefined;
      await ctx.store.save();
      if (decision === "stop") {
        info(`${item.id}: run stopped by human — \`sparra build\` resumes from the next item.`);
        humanStop = true;
        break;
      }
      // continue → fall through to the terminal-status skip, which advances to the next item.
    }

    // A FAILED item that exhausted its rounds is terminal under the ITEM gate: on resume it must
    // be advanced PAST (an item-gate "stop" then a later `sparra build` lands on the NEXT item),
    // never re-contracted/rebuilt. Scoped to `steps.has("item")` so the autonomous failed-item
    // retry-on-resume semantics are unchanged.
    const exhaustedFail = st.status === "failed" && st.round >= ctx.config.build.maxRoundsPerItem;
    if (
      st.status === "passed" ||
      st.status === "abandoned" ||
      st.status === "budget_exceeded" ||
      (steps.has("item") && exhaustedFail)
    ) {
      detail(`${item.id} already ${st.status} — skipping.`);
      continue;
    }
    b.build.currentItem = item.id;

    step(`${item.id}: ${item.title}`);
    if (!depsSatisfied(item, b.build.items)) {
      warn(`${item.id} has unmet dependencies (${item.dependsOn.join(", ")}); attempting anyway.`);
    }

    // Prior cross-run learnings — read once per item, threaded into every role.
    const priorLearnings = await d.readMemory(ctx.paths);

    // Hybrid generation: items tagged `gen: "local"` route to the optional local generator
    // (e.g. a local LM Studio model) for trivially-simple/privacy-sensitive work; everything
    // else uses the main generator. Falls back with a warning if no local generator is set.
    const genRole =
      item.gen === "local" && ctx.config.roles.generatorLocal
        ? ctx.config.roles.generatorLocal
        : ctx.config.roles.generator;
    if (item.gen === "local" && !ctx.config.roles.generatorLocal) {
      warn(`${item.id} tagged gen:local but roles.generatorLocal is unset — using the main generator.`);
    } else if (genRole !== ctx.config.roles.generator) {
      detail(`${item.id} → local generator (${genRole.model}${genRole.baseUrl ? ` @ ${genRole.baseUrl}` : ""}).`);
    }

    // Halt this item (not the run) when its accumulated cost OR tokens cross the cap.
    const haltOnBudget = async (phase: string): Promise<void> => {
      st.status = "budget_exceeded";
      await ctx.store.save();
      const which = tokensExceeded(tokenCap, st.tokensUsed ?? 0)
        ? `${st.tokensUsed} tokens ≥ cap ${tokenCap}`
        : overZeroCostFallback(st)
        ? `${st.tokensUsed} tokens ≥ build.zeroCostTokenCap ${zeroCostTokenCap} (USD cap ineffective: zero/unknown reported cost)`
        : `$${(st.costUsd ?? 0).toFixed(3)} ≥ cap $${cap}`;
      warn(`${item.id} halted on budget: ${which} (during ${phase}).`);
      await d.appendLearning(ctx.paths, {
        item: item.id,
        kind: "budget_exceeded",
        detail: `halted (${phase}) at ${which}; spent $${(st.costUsd ?? 0).toFixed(3)} / ${st.tokensUsed ?? 0} tokens; best score ${st.lastScore ?? 0} in ${st.round} round(s).`,
        at: stamp(),
      });
    };

    // 1) Negotiate the "done" contract.
    st.status = "contracting";
    await ctx.store.save();
    const contract = await d.negotiateContract(ctx, item, traceDir, nextSeq(), priorLearnings, workspaceDir, undefined, d.execVerifyCommand);
    // negotiateContract advanced the global seq via its own writes; bump our counter past it.
    b.build.traceSeq = (b.build.traceSeq ?? 0) + contract.tracesUsed;

    // ── Interactive: CONTRACT checkpoint ──
    if (b.build.paused?.itemId === item.id && b.build.paused.kind === "contract") {
      // Resuming a contract pause: negotiateContract re-read (and leak-checked) the
      // possibly human-edited contract above. Acknowledge and proceed to generation.
      st.contractAcked = true;
      b.build.paused = undefined;
      await ctx.store.save();
      info(`${item.id}: contract acknowledged — building.`);
    } else if (steps.has("contract") && !st.contractAcked) {
      await writeContractPause(ctx, { runId, itemId: item.id, itemTitle: item.title, contractFile: ctx.paths.contractFile(item.id) });
      b.build.paused = { kind: "contract", itemId: item.id, round: st.round };
      await ctx.store.save();
      info(`${item.id}: paused at the contract — review ${pauseDirRel(ctx, runId, item.id)}/pause.md, then \`sparra build\`.`);
      pausedRun = true;
      break;
    }

    // 2) Generate ↔ evaluate loop with GAN pivots, bounded by the per-item budget.
    st.status = "building";
    let feedback: string | undefined;
    let fresh = false;
    // (Q7c) Assertion ids where the generator's assertionsClaimed contradicted an evaluator
    // verdict this item — accumulated across rounds; surfaced as one memory note on completion.
    const claimGapIds: number[] = [];
    // Whether the most recent round's exercise was BLOCKED (inconclusive) rather than a real fail —
    // used so the terminal message doesn't call an unverifiable item a behavioral failure.
    let lastBlocked = false;
    // Resume only a generator session from the SAME backend as the role we're about to run —
    // a session id isn't portable, so a fallback to another provider must start fresh.
    const resumeFor = (key: string): string | undefined =>
      !fresh && st.generatorBackend === key ? st.generatorSessionId : undefined;

    // ── Interactive: apply a pending ROUND decision (resume) ──
    if (b.build.paused?.itemId === item.id && b.build.paused.kind === "round") {
      const res = await readRoundDecision(ctx, runId, item.id);
      const wasFail = (st.lastScore ?? 0) < ctx.config.rubric.passThreshold;
      if (res.decision === "accept" && wasFail && !res.reason.trim()) {
        // Overriding a FAILED round requires a recorded reason — stay paused until provided.
        warn(`${item.id}: accept overrides a FAILED round — add a "reason" to ${pauseDirRel(ctx, runId, item.id)}/decision.json, then \`sparra build\`.`);
        pausedRun = true;
        break;
      }
      b.build.paused = undefined;
      if (res.decision === "abandon") {
        st.status = "abandoned";
        await d.appendLearning(ctx.paths, { item: item.id, kind: "note", detail: `human-abandoned round ${st.round} (score ${st.lastScore ?? 0}).`, at: stamp() });
        await ctx.store.save();
        warn(`${item.id}: abandoned by human.`);
        if (await maybeItemGate(item, st)) { pausedRun = true; break; }
        continue;
      }
      if (res.decision === "accept") {
        // An override reason is persisted to memory.md, which is injected into future
        // generators — so leak-check it too (not just feedback.md).
        if (wasFail) {
          try {
            assertNoHoldoutLeak("accept reason", res.reason, await readHoldout(ctx));
          } catch {
            throw new Error(`${item.id}: your accept reason contains holdout content — remove it (holdout is evaluator-only).`);
          }
        }
        const accepted = await acceptItem(st, item, (st.lastDeviations ?? []) as Deviation[], wasFail ? res.reason.trim() : undefined);
        if (accepted === "commit-paused") { pausedRun = true; break; }
        if (await maybeItemGate(item, st)) { pausedRun = true; break; }
        continue;
      }
      // continue / pivot → steer the next generation round (leak-check human-edited feedback first)
      try {
        assertNoHoldoutLeak("interactive feedback", res.feedback, await readHoldout(ctx));
      } catch {
        throw new Error(`${item.id}: your feedback.md contains holdout content — remove it (holdout is evaluator-only).`);
      }
      if (res.decision === "pivot") {
        st.pivots += 1;
        st.criterionFailStreak = {};
        // Ledger the discarded attempt from durable fields (the round's GenerateOutput/Verdict
        // belong to the process that paused; lastReport/lastScore survived the resume).
        recordAttempt(st, {
          round: st.round,
          approach: st.lastReport ?? "",
          failure: `human pivot after round ${st.round} (score ${st.lastScore ?? 0})${res.feedback ? `: ${res.feedback}` : ""}`,
        });
        fresh = true;
        feedback = res.feedback || "GAN PIVOT: discard the previous approach and rebuild from scratch with a fundamentally different design.";
        warn(`${item.id}: human pivot → rebuilding from scratch (pivot #${st.pivots}).`);
      } else {
        fresh = false;
        feedback = res.feedback;
        detail(`${item.id}: human continue → patching for round ${st.round + 1}.`);
      }
    }

    while (st.round < ctx.config.build.maxRoundsPerItem) {
      if (overBudget(st)) {
        await haltOnBudget("pre-round");
        break;
      }
      st.round += 1;
      // Quality escalation (per-item, one-way): once the item has accumulated
      // `build.escalateAfterRounds` FAILED rounds, switch its generator to the role's configured
      // `escalation` for the remaining rounds. Quality-triggered — distinct from the
      // limit-triggered `fallback` below, which applies unchanged to the escalated role too.
      const escalateAfter = ctx.config.build.escalateAfterRounds;
      if (!st.escalated && genRole.escalation && escalateAfter > 0 && (st.failedRounds ?? 0) >= escalateAfter) {
        st.escalated = true;
        // New session for the new role (round feedback carries the context) — same rule as a
        // backend switch: never resume the pre-escalation session into the escalated model.
        st.generatorSessionId = undefined;
        st.generatorBackend = undefined;
        info(`${item.id}: escalating generator to ${genRole.escalation.model} after ${st.failedRounds} failed round(s).`);
        await d.appendLearning(ctx.paths, {
          item: item.id,
          kind: "note",
          detail: `escalated generator to ${genRole.escalation.model} after ${st.failedRounds} failed round(s) (quality escalation).`,
          at: stamp(),
        });
        await ctx.store.save();
      }
      const activeGenRole = st.escalated && genRole.escalation ? genRole.escalation : genRole;
      // Pick the generator role, swapping to a fallback model when the primary's backend is in
      // a limit window. activeGenRole is the (possibly local, possibly escalated) primary;
      // pickRole applies that role's own fallback chain.
      const genPick = pickRole(activeGenRole, limitedUntil, Date.now());
      const genKey = backendKey(genPick.role);
      if (genPick.usedFallback) info(`${item.id}: ${backendKey(activeGenRole)} limited — generating with fallback ${genPick.role.model}.`);
      // A FAILED round advances the escalation counter — but not when this round's generation ran
      // on a limit-triggered fallback (a limit isn't a quality signal about the primary), and
      // never for blocked rounds (which take a different branch below).
      const noteFailedRound = () => {
        if (!genPick.usedFallback) st.failedRounds = (st.failedRounds ?? 0) + 1;
      };
      // ── Real pivot (Q6): a fresh restart must not re-anchor on the failed attempt's files.
      // The reset runs BEFORE the fresh generateItem and only when every anchor gate holds
      // (config + live git state — see build/reset.ts); any gate false → no reset (today's
      // behavior). A reset FAILURE halts the item — never generate on a dirty tree. ──
      if (fresh) {
        let rr;
        try {
          rr = d.maybeResetWorkspace({
            workspaceDir,
            persistedWorkspaceDir: b.build.workspaceDir,
            recordedBranch: b.build.branch,
            branchPrefix: ctx.config.git.branchPrefix, // ownership gate: never reset a non-Sparra branch
            resetWorkspaceEnabled: ctx.config.pivot.resetWorkspace,
            autoCommit: ctx.config.git.autoCommit,
          });
        } catch (e) {
          const msg = (e as Error).message;
          st.status = "failed";
          await d.appendLearning(ctx.paths, {
            item: item.id,
            kind: "note",
            detail: `round ${st.round}: pivot workspace reset FAILED — ${msg.slice(0, 200)}`,
            at: stamp(),
          });
          await ctx.store.save();
          throw new Error(`${item.id}: pivot workspace reset failed — halting rather than generating on a dirty tree: ${msg}`);
        }
        if (rr.reset) detail(`${item.id}: workspace reset to the item-start state for the fresh restart.`);
        else detail(`${item.id}: fresh restart without a workspace reset (${rr.reason}).`);
      }
      const gen = await d.generateItem({
        ctx,
        item,
        contractText: contract.text,
        workspaceDir,
        traceDir,
        traceSeq: nextSeq(),
        feedback,
        resumeSessionId: resumeFor(genKey),
        fresh,
        priorAttempts: fresh ? renderPriorAttempts(st.attempts) : undefined,
        priorLearnings,
        role: genPick.role,
        maxBudgetUsd: remainingBudget(cap, st.costUsd ?? 0),
      });
      const genCost = costUsdOrZero(gen.costUsd);
      totalCost += genCost;
      st.costUsd = (st.costUsd ?? 0) + genCost;
      st.tokensUsed = (st.tokensUsed ?? 0) + gen.tokens;
      st.generatorSessionId = gen.sessionId;
      st.generatorBackend = genKey;
      st.lastReport = gen.report.slice(0, APPROACH_CAP); // durable, for a human pivot on resume
      await ctx.store.save();

      const gl = await onLimit(st, genPick.role, gen.limitHit, `${item.id} generate`);
      if (gl === "halt") { stopRun = true; break; }
      if (gl === "retry") continue;

      // Sandbox-first backstop: whatever scoped the writes (Claude hooks / Codex
      // sandbox), verify nothing escaped the work scope into the repo. Harness-managed
      // paths are allowed; anything else is a real escape.
      const escapes = writeScopeViolations(changedFiles(ctx.root), [
        workspaceDir,
        ctx.paths.dir,
        ctx.paths.plan,
        ctx.paths.changelog,
        ctx.paths.proposals,
        ctx.paths.codebaseMap,
        ctx.paths.prototypes,
      ]);
      if (escapes.length) {
        warn(
          `${item.id}: ${escapes.length} write(s) ESCAPED the work scope: ${escapes.slice(0, 5).map((p) => path.relative(ctx.root, p)).join(", ")}${escapes.length > 5 ? ` …(+${escapes.length - 5})` : ""}`
        );
      }

      if (overBudget(st)) {
        await haltOnBudget("generate");
        break;
      }

      const dev = await d.recordDeviations(ctx, item, gen.deviations);

      // ── Pre-evaluator PREFLIGHT gate (config-gated, no model). BETWEEN generation and the
      // adversarial evaluator: run the contract's OWN "I will verify by" commands once via the
      // safe executor. On a DETERMINISTIC behavioral failure (ran, nonzero, not usage/unsafe) skip
      // the evaluator this round and bounce back to the generator with the (holdout-redacted)
      // command output — a generation that fails its own gates never costs a full evaluator
      // session. Capped at ONE bounce before the evaluator MUST run (durable `preflightBounces`,
      // reset once the evaluator runs), so preflight can never loop the item without the evaluator
      // weighing in. all-green / usage (broken command) / unsafe (never-ran) fall through to the
      // evaluator unchanged — only a real gate failure short-circuits. Round accounting mirrors a
      // failed eval round: it reuses this round's `st.round` increment and counts as a failed round.
      if (ctx.config.build.preflightVerify && (st.preflightBounces ?? 0) === 0) {
        const preflightOutcomes = [];
        for (const command of extractVerifyCommands(contract.text)) {
          preflightOutcomes.push(
            await d.execVerifyCommand(workspaceDir, command, {
              allowPrefixes: ctx.config.build.verifyCommands, // same opt-in the rerun gate passes
              env: mergedBuildEnv(ctx.config),
            })
          );
        }
        // A bounce fires ONLY on a real behavioral fail (ran + nonzero + not a usage signature).
        // usage (command broken as written) and unsafe/never-ran are NOT gate failures here.
        const preflightFails = preflightOutcomes.filter((o) => o.ran && classifyExec(o) === "behavioral");
        if (preflightFails.length) {
          st.preflightBounces = (st.preflightBounces ?? 0) + 1;
          noteFailedRound();
          warn(
            `${item.id}: PREFLIGHT bounce in round ${st.round} — ${preflightFails.length} of the contract's own verify command(s) failed deterministically; skipping the evaluator this round.`
          );
          await d.appendLearning(ctx.paths, {
            item: item.id,
            kind: "failed",
            detail: `round ${st.round}: preflight bounce — ${preflightFails.map((o) => o.command).join("; ").slice(0, 200)}`,
            at: stamp(),
          });
          await ctx.store.save();
          if (st.round < ctx.config.build.maxRoundsPerItem) {
            // Frame it as a PREFLIGHT failure (not an evaluator verdict) and route it through the
            // SAME holdout-redaction wall the evaluator feedback uses.
            feedback = redactHoldout(
              `PREFLIGHT FAILURE — your OWN verify commands failed deterministically BEFORE evaluation (this is NOT an adversarial-evaluator verdict). The harness ran the contract's "I will verify by" commands via the safe executor and one or more failed; fix these so your own gates pass, then generation proceeds to the evaluator:\n${preflightFails.map((o) => renderExecOutcome(o)).join("\n")}`,
              await readHoldout(ctx)
            );
            fresh = false;
          }
          continue; // skip evaluateItem this round — bounce straight back to the generator
        }
      }

      const evalPick = pickRole(ctx.config.roles.evaluator, limitedUntil, Date.now());
      if (evalPick.usedFallback) info(`${item.id}: ${backendKey(ctx.config.roles.evaluator)} limited — evaluating with fallback ${evalPick.role.model}.`);
      const ev = await d.evaluateItem({
        ctx,
        item,
        contractText: contract.text,
        workspaceDir,
        round: st.round,
        traceDir,
        traceSeq: nextSeq(),
        priorLearnings,
        role: evalPick.role,
        maxBudgetUsd: remainingBudget(cap, st.costUsd ?? 0),
      });
      const evCost = costUsdOrZero(ev.costUsd);
      totalCost += evCost;
      st.costUsd = (st.costUsd ?? 0) + evCost;
      st.tokensUsed = (st.tokensUsed ?? 0) + ev.tokens;

      const el = await onLimit(st, evalPick.role, ev.limitHit, `${item.id} evaluate`);
      if (el === "halt") { stopRun = true; break; }
      if (el === "retry") continue;

      // The evaluator weighed in this round — clear the consecutive preflight-bounce counter so a
      // LATER generation can preflight-bounce again (the cap is one bounce per evaluator round).
      st.preflightBounces = 0;

      st.lastScore = ev.verdict.weightedTotal;

      // (Q7c) Calibration gap: pure claims-vs-verdict diff. Omitted/empty assertionsClaimed is a
      // complete no-op. The gap carries assertion ids + count ONLY (never evaluator/holdout text),
      // so the verdict's holdout-redaction flow is untouched; it lands in the round's verdict
      // data + artifact and the run log here, and in one memory note on item completion below.
      const claimGap = diffClaims(gen.assertionsClaimed, ev.verdict.assertions);
      if (claimGap.count > 0) {
        ev.verdict.claimMismatches = claimGap;
        await appendText(ctx.paths.verdictFile(item.id, st.round), renderClaimGap(claimGap));
        warn(
          `${item.id} round ${st.round}: calibration gap — the generator claimed the opposite of the evaluator on ${claimGap.count} assertion(s) (ids ${claimGap.ids.join(", ")}).`
        );
        for (const id of claimGap.ids) if (!claimGapIds.includes(id)) claimGapIds.push(id);
      }

      // ── Interactive: ROUND checkpoint — defer accept/pivot/continue to the human ──
      if (steps.has("round")) {
        st.lastEvaluatedRound = st.round;
        st.lastDeviations = gen.deviations;
        const passing = ev.verdict.verdict === "pass";
        const roundBlocked = ev.verdict.exerciseStatus === "blocked";
        const defaultFeedback = passing
          ? ""
          : `${roundBlocked ? "NOTE: the exercise was BLOCKED (inconclusive — it could not run; environment, not the artifact), so this is not a behavioral failure. Make the artifact exercisable, or accept/abandon as appropriate.\n\n" : ""}${renderPatchFeedback(ev.verdict)}`;
        await writeRoundPause(ctx, {
          runId,
          itemId: item.id,
          itemTitle: item.title,
          round: st.round,
          verdict: ev.verdict,
          holdoutText: await readHoldout(ctx),
          defaultDecision: (passing ? "accept" : "continue") as Decision,
          defaultFeedback,
        });
        b.build.paused = { kind: "round", itemId: item.id, round: st.round };
        await ctx.store.save();
        info(`${item.id}: paused after round ${st.round} (${ev.verdict.verdict}) — decide in ${pauseDirRel(ctx, runId, item.id)}/decision.json, then \`sparra build\`.`);
        pausedRun = true;
        break;
      }

      if (ev.verdict.verdict === "pass") {
        // Flakiness RERUN gate (no model): re-run the contract's verify commands K times. ANY
        // non-ok result prevents a clean pass — mixed exits = FLAKY, deterministic nonzero =
        // failing-as-shipped, UNSAFE (safety rules rejected it, never ran — the contracted
        // command can never be witnessed exiting 0) — demoted with the command + output as
        // blocking feedback.
        const reruns = ctx.config.build.flakinessReruns;
        const rerunBad =
          reruns > 0
            ? (
                await rerunVerifyCommands(
                  workspaceDir,
                  extractVerifyCommands(contract.text),
                  reruns,
                  d.execVerifyCommand,
                  ctx.config.build.verifyCommands, // explicit opt-in past the executor's argv[0] allowlist
                  mergedBuildEnv(ctx.config)
                )
              ).filter((r) => r.status !== "ok")
            : [];
        if (rerunBad.length) {
          const holdout = await readHoldout(ctx);
          const describe = (r: (typeof rerunBad)[number]) =>
            r.status === "flaky"
              ? "FLAKY (mixed exits across reruns)"
              : r.status === "unsafe"
              ? "UNSAFE for the harness executor (never ran — contract verify commands must be single self-contained commands the harness can run)"
              : "FAILING-AS-SHIPPED (nonzero on every rerun)";
          const lines = rerunBad.map(
            (r) => `- \`${r.command}\` is ${describe(r)}${r.exitCodes.length ? ` [exits: ${r.exitCodes.join(", ")}]` : ""}\n${r.detail}`
          );
          warn(`${item.id}: pass demoted by the rerun gate — ${rerunBad.length} verify command(s) did not stay green over ${reruns} rerun(s).`);
          noteFailedRound();
          await d.appendLearning(ctx.paths, {
            item: item.id,
            kind: "failed",
            detail: `round ${st.round}: pass demoted by rerun gate — ${rerunBad.map((r) => `${r.command} (${r.status})`).join("; ").slice(0, 200)}`,
            at: stamp(),
          });
          if (overBudget(st)) {
            await haltOnBudget("rerun-gate");
            break;
          }
          if (st.round >= ctx.config.build.maxRoundsPerItem) break;
          // Blocking feedback through the existing (holdout-redacted) feedback path.
          feedback = redactHoldout(
            `Your implementation passed the evaluator, but the HARNESS RERUN GATE demoted it: the contract's verify commands must be harness-runnable and exit 0 on EVERY rerun (${reruns}×). Fix the flakiness/failure/unsafe command — rerun-to-green does not pass:\n${lines.join("\n")}`,
            holdout
          );
          fresh = false;
          continue;
        }
        // Optional independent code-review gate on the (behaviorally passing) change.
        const review: ReviewOutput | null = ctx.config.review.enabled
          ? await d.reviewItem({
              ctx,
              item,
              contractText: contract.text,
              workspaceDir,
              round: st.round,
              traceDir,
              traceSeq: nextSeq(),
              maxBudgetUsd: remainingBudget(cap, st.costUsd ?? 0),
            })
          : null;
        if (review) {
          const reviewCost = costUsdOrZero(review.costUsd);
          totalCost += reviewCost;
          st.costUsd = (st.costUsd ?? 0) + reviewCost;
          st.tokensUsed = (st.tokensUsed ?? 0) + review.tokens;
          await ctx.store.save();
        }

        if (!review || review.blocking.length === 0) {
          // Drive the idempotent finisher: mark passed → reconcile → commit (only onto the
          // Sparra branch, never your main; opt-in) → memory. The durable ledger makes a kill
          // anywhere in here lose nothing and double nothing — a resume completes the rest.
          const memoryDetail = `accepted in round ${st.round} (score ${ev.verdict.weightedTotal}${review ? ", code review clean" : ""}); $${(st.costUsd ?? 0).toFixed(3)} spent${st.pivots ? `, ${st.pivots} pivot(s)` : ""}.`;
          const res = await finishAcceptance(st, item, gen.deviations, { memoryDetail });
          ok(`${item.id} accepted in round ${st.round} (score ${ev.verdict.weightedTotal}${review ? " + code review" : ""}). cumulative $${totalCost.toFixed(3)}`);
          if (res === "paused") {
            // ── Interactive: COMMIT gate — accepted (passed); the commit is deferred to the human. ──
            info(`${item.id}: paused before commit — review ${pauseDirRel(ctx, runId, item.id)}/pause.md, then \`sparra build\`.`);
            pausedRun = true;
            break;
          }
          break;
        }

        // Behaviorally passing but code review blocked → fail the round with review feedback.
        warn(`${item.id}: exercise passed but code review found ${review.blocking.length} blocking issue(s) in round ${st.round}.`);
        noteFailedRound();
        await d.appendLearning(ctx.paths, {
          item: item.id,
          kind: "failed",
          detail: `round ${st.round}: code review blocked — ${review.blocking.slice(0, 3).join("; ").slice(0, 200)}`,
          at: stamp(),
        });
        if (overBudget(st)) {
          await haltOnBudget("review");
          break;
        }
        if (st.round >= ctx.config.build.maxRoundsPerItem) break;
        feedback = `Your implementation runs and meets the contract, but an independent CODE REVIEW found blocking issues that must be fixed before it's accepted:\n${review.blocking.map((b) => `- ${b}`).join("\n")}`;
        fresh = false;
        continue;
      }

      // A BLOCKED exercise is inconclusive (environment, not the artifact): don't pivot, don't
      // advance the fail streak, keep the score — just surface it and steer toward exercisability.
      const blocked = ev.verdict.exerciseStatus === "blocked";
      lastBlocked = blocked;
      if (blocked) {
        warn(`${item.id}: exercise BLOCKED in round ${st.round} — could not verify (environment, not the artifact); not a behavioral fail, not pivoting.`);
        await d.appendLearning(ctx.paths, {
          item: item.id,
          kind: "note",
          detail: `round ${st.round}: exercise BLOCKED (inconclusive) — ${(ev.verdict.blocking.slice(0, 2).join("; ") || ev.verdict.notes).slice(0, 200)}`,
          at: stamp(),
        });
        await ctx.store.save();
        if (overBudget(st)) {
          await haltOnBudget("evaluate");
          break;
        }
        if (st.round >= ctx.config.build.maxRoundsPerItem) break;
        feedback = renderBlockedFeedback(ev.verdict);
        fresh = false;
        continue;
      }
      const unrunIds = new Set(ev.verdict.unrunAssertionIds ?? []);
      const allUnrun =
        ev.verdict.assertions.length > 0 &&
        ev.verdict.assertions.every((a) => unrunIds.has(a.id));
      if (allUnrun) {
        warn(`${item.id}: all contract assertions were UN-RUN in round ${st.round} — no behavioral signal; not counting as a failed round or pivoting.`);
        await d.appendLearning(ctx.paths, {
          item: item.id,
          kind: "note",
          detail: `round ${st.round}: all assertions UN-RUN (inconclusive) — ${(ev.verdict.notes || ev.verdict.blocking.join("; ")).slice(0, 200)}`,
          at: stamp(),
        });
        await ctx.store.save();
        if (overBudget(st)) {
          await haltOnBudget("evaluate");
          break;
        }
        if (st.round >= ctx.config.build.maxRoundsPerItem) break;
        feedback = `The evaluator could not execute any contract assertion in its environment; this is UN-RUN/no-signal, not a behavioral failure.\n${renderPatchFeedback(ev.verdict)}`;
        fresh = false;
        continue;
      }

      noteFailedRound();
      const decision = updateStreaksAndDecide(st, ev.verdict, ctx.config);
      st.criterionFailStreak = decision.streaks;
      await ctx.store.save();

      if (overBudget(st)) {
        await haltOnBudget("evaluate");
        break;
      }
      if (st.round >= ctx.config.build.maxRoundsPerItem) break;

      if (decision.pivot) {
        st.pivots += 1;
        st.criterionFailStreak = {};
        // Attempt ledger: what this discarded attempt tried (the generator's own report) and why
        // it failed (top blocking items — Verdict fields only, already holdout-redacted). The
        // NEXT fresh generate renders these as PRIOR ATTEMPTS so it can't repeat the approach.
        recordAttempt(st, { round: st.round, approach: gen.report, failure: attemptFailure(ev.verdict) });
        await ctx.store.save();
        fresh = true;
        feedback = renderPivotFeedback(ev.verdict, {
          criterion: decision.criterion ?? "(criterion)",
          threshold: ctx.config.pivot.threshold,
          rounds: ctx.config.pivot.N,
        });
        warn(`${item.id}: GAN pivot on "${decision.criterion}" → restarting from scratch (pivot #${st.pivots}).`);
        await d.appendLearning(ctx.paths, {
          item: item.id,
          kind: "pivot",
          detail: `criterion "${decision.criterion}" stayed <${ctx.config.pivot.threshold} for ${ctx.config.pivot.N} rounds → rebuilt from scratch (pivot #${st.pivots}). Blocking: ${(ev.verdict.blocking.join("; ") || ev.verdict.notes || "n/a").slice(0, 200)}`,
          at: stamp(),
        });
      } else {
        fresh = false;
        feedback = renderPatchFeedback(ev.verdict);
        detail(`${item.id}: patching for round ${st.round + 1}.`);
      }
      void dev;
    }
    if (stopRun || pausedRun) break; // provider limit OR interactive checkpoint — resumable

    // (Q7c) The item just completed (terminal either way): one memory note when any evaluated
    // round showed a claims-vs-verdict calibration gap, so future generators self-report honestly.
    if (claimGapIds.length) {
      await d.appendLearning(ctx.paths, {
        item: item.id,
        kind: "note",
        detail: `calibration gap: the generator's assertionsClaimed contradicted the evaluator on ${claimGapIds.length} assertion(s) (ids ${claimGapIds.join(", ")}) — self-reported passes ran hot; verify before claiming.`,
        at: stamp(),
      });
    }
    warnZeroCostUsdIneffective(item.id, st);

    // `haltOnBudget`/pass mutate st.status through a closure, which defeats TS's
    // flow narrowing here — read it back through the declared union.
    const finalStatus = st.status as ItemState["status"];
    if (finalStatus !== "passed" && finalStatus !== "budget_exceeded") {
      st.status = "failed";
      if (lastBlocked) {
        // Inconclusive, not a behavioral failure: the exercise never ran, so we couldn't verify.
        warn(`${item.id} is INCONCLUSIVE — the exercise was BLOCKED (could not run; environment, not the artifact) and it was never verified within ${ctx.config.build.maxRoundsPerItem} rounds. Needs human attention; not a behavioral failure.`);
        await d.appendLearning(ctx.paths, {
          item: item.id,
          kind: "note",
          detail: `INCONCLUSIVE after ${ctx.config.build.maxRoundsPerItem} rounds — exercise BLOCKED (never ran); not verified, not a behavioral failure. $${(st.costUsd ?? 0).toFixed(3)} spent.`,
          at: stamp(),
        });
      } else {
        warn(`${item.id} did not pass within ${ctx.config.build.maxRoundsPerItem} rounds (best score ${st.lastScore ?? 0}).`);
        await d.appendLearning(ctx.paths, {
          item: item.id,
          kind: "failed",
          detail: `did not pass in ${ctx.config.build.maxRoundsPerItem} rounds; best score ${st.lastScore ?? 0}, ${st.pivots} pivot(s), $${(st.costUsd ?? 0).toFixed(3)} spent.`,
          at: stamp(),
        });
      }
    }
    await ctx.store.save();

    // ── Interactive: ITEM gate — pause before advancing to the next item (the item just
    // terminalized: passed / failed / budget_exceeded). No pause after the final item. ──
    if (await maybeItemGate(item, st)) { pausedRun = true; break; }
  }

  // Stopped at the human's request (`item` gate "stop"): stay in phase "build" — NOT done —
  // with no pause set, so a plain `sparra build` resumes from the NEXT item.
  if (humanStop) {
    await ctx.store.save();
    banner("BUILD STOPPED — by you");
    info("Stopped at your request. Re-run `sparra build` to resume from the next item.");
    const states0 = Object.values(b.build.items);
    return {
      passed: states0.filter((s) => s.status === "passed").length,
      failed: states0.filter((s) => s.status === "failed").length,
      budgetExceeded: states0.filter((s) => s.status === "budget_exceeded").length,
      total: items.length,
      runId,
    };
  }

  // Summary.
  const states = Object.values(b.build.items);
  const passed = states.filter((s) => s.status === "passed").length;
  const failed = states.filter((s) => s.status === "failed").length;
  const budgetHalted = states.filter((s) => s.status === "budget_exceeded").length;

  // Paused at an interactive checkpoint (`--step`): stay in phase "build" — NOT done — and tell
  // the human what to edit. Resume with `sparra build` once they've recorded a decision.
  if (pausedRun) {
    await ctx.store.save();
    banner("BUILD PAUSED — waiting for you");
    info(
      `Paused at an interactive checkpoint. Review/edit the steering folder under ` +
        `${path.relative(ctx.root, path.join(ctx.paths.dir, "interactive", runId))}, then re-run \`sparra build\` to continue.`
    );
    return { passed, failed, budgetExceeded: budgetHalted, total: items.length, runId };
  }

  // Paused on a provider limit (auto-restart exhausted): stay in phase "build" — NOT done — so
  // the work is resumable. State (including the mid-flight item and limit windows) is on disk.
  if (stopRun) {
    await ctx.store.save();
    banner("BUILD PAUSED — provider limit");
    warn(`Paused after ${restarts} auto-restart wait(s) (maxRestarts ${ar.maxRestarts}). State is saved; re-run \`sparra build\` to resume from where it stopped.`);
    return { passed, failed, budgetExceeded: budgetHalted, total: items.length, runId };
  }

  // An interactive pause set by a PRIOR run can survive if this run didn't touch that item
  // (e.g. `--only <other>`). Don't mark the build done — that would orphan the pause; stay in
  // phase "build" so a plain `sparra build` resumes the paused item.
  if (b.build.paused) {
    await ctx.store.save();
    banner("BUILD — paused item remains");
    warn(
      `Item ${b.build.paused.itemId} is still paused at an interactive checkpoint (not part of this run). ` +
        `Run \`sparra build\` (no --only) to resume it, or \`sparra build --fresh\` to start over.`
    );
    return { passed, failed, budgetExceeded: budgetHalted, total: items.length, runId };
  }

  b.build.currentItem = undefined;
  await ctx.store.transition("done", true);

  banner("BUILD COMPLETE");
  ok(
    `${passed}/${items.length} items passed${failed ? `, ${failed} failed` : ""}${budgetHalted ? `, ${budgetHalted} over budget` : ""}. cumulative $${totalCost.toFixed(3)}`
  );
  for (const item of items) {
    const s = b.build.items[item.id];
    const mark =
      s?.status === "passed"
        ? color.green("✓")
        : s?.status === "failed"
        ? color.red("✗")
        : s?.status === "budget_exceeded"
        ? color.yellow("$")
        : color.yellow("•");
    detail(
      `${mark} ${item.id} ${item.title} — ${s?.status} (rounds ${s?.round}, pivots ${s?.pivots}, score ${s?.lastScore ?? "-"}, $${(s?.costUsd ?? 0).toFixed(3)}, ${s?.tokensUsed ?? 0} tok)`
    );
  }
  info(`traces:    ${path.relative(ctx.root, traceDir)}`);
  info(`changelog: ${path.relative(ctx.root, ctx.paths.changelog)}`);
  if (exists(ctx.paths.proposals)) info(`proposals: ${path.relative(ctx.root, ctx.paths.proposals)} (out-of-scope items for you)`);
  if (b.build.branch) {
    info(`Work is on branch ${color.bold(b.build.branch)} — Sparra did NOT commit to your main branch.`);
    detail(b.build.workspaceNote ?? "");
  }
  info("Review the work, then `sparra reflect` to improve the prompts from this run's traces.");

  return { passed, failed, budgetExceeded: budgetHalted, total: items.length, runId };
}

function depsSatisfied(item: WorkItem, items: Record<string, ItemState>): boolean {
  return item.dependsOn.every((d) => items[d]?.status === "passed");
}

/** Read frozen plan for callers that want a quick sanity check. */
export async function frozenPlanExists(ctx: Ctx): Promise<boolean> {
  return (await readText(ctx.paths.frozenPlan)) != null;
}
