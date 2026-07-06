import process from "node:process";
import { loadCtx, loadCtxForRole } from "./context.ts";
import type { Mode } from "./state.ts";
import { banner, color, err, info } from "./util/log.ts";
import { cmdInit } from "./phases/init.ts";
import { cmdOrient } from "./phases/orient.ts";
import { cmdPlan } from "./phases/plan.ts";
import { cmdSnapshot, cmdFreeze } from "./phases/freeze.ts";
import { cmdPrototype, cmdLogFinding } from "./phases/prototype.ts";
import { cmdBuild } from "./phases/build.ts";
import { parseSteps } from "./build/interactive.ts";
import { cmdReflect } from "./phases/reflect.ts";
import { cmdBatch } from "./phases/batch.ts";
import { cmdStatus } from "./phases/status.ts";
import { cmdNew } from "./phases/new.ts";
import { cmdFinish } from "./phases/finish.ts";
import { cmdClean } from "./phases/clean.ts";
import { cmdPrompts } from "./phases/prompts.ts";
import { cmdRoleRun } from "./phases/role.ts";
import { cmdMeasure } from "./phases/measure.ts";
import { promptDrift, summarizePromptDrift } from "./prompts.ts";
import { parse } from "./util/args.ts";

const HELP = `${color.bold("sparra")} — autonomous build harness on the Claude Agent SDK

${color.bold("Flow:")}  0 ORIENT → A PLAN ⇄ B PROTOTYPE → freeze → C BUILD → reflect

${color.bold("Commands")}
  init [--mode greenfield|existing] [--force] [--docs <dir>]
                                                detect project type, scaffold .sparra/ (--docs: subfolder for PLAN.md etc.)
  orient [--light]                              Phase 0: map an existing codebase → CODEBASE_MAP.md
  plan                                          Phase A: collaborative planning interview (co-edit PLAN.md)
  prototype "<idea>"                            Phase B: throwaway prototype in isolation
  log-finding <FINDINGS.md>                     fold prototype findings back into PLAN.md
  snapshot                                      checkpoint PLAN.md (+ CODEBASE_MAP.md)
  freeze                                        FREEZE GATE: lock the plan as build input (your decision)
  build [--fresh] [--only <item-id>] [--step contract,round,commit,item]
                                                Phase C: autonomous generator/evaluator loop (resumable; --step pauses for human steering)
  reflect [--apply] [--run <runId>] [--traces <glob-or-dir>]
                                                self-improvement: propose/apply prompt edits from build or role-run traces
  reflect --upstream [--done <ids>] [--wontdo <ids>] [--reason "<text>"] [--clear]
                                                list harness-level findings (global 1-based index) in the shared inbox (~/.sparra/reflections); --done/--wontdo triage individual findings to archive/; --clear archives ALL
  prompts [status|sync|audit [--apply] [--source default|effective]] [--role <r>] [--dry-run]
                                                compare/sync .sparra/prompts with the built-in defaults; audit = concision review (--apply coverage-gated; --source default audits DEFAULT_PROMPTS, report-only)
  batch [-k N]                                  run N builds of the frozen plan; summarize failures
  status                                        show phase, items, and the suggested next command
  new ["<title>"]                               start a fresh plan→build cycle (archives the finished one)
  finish [--pr|--merge --yes] [--teardown] [--force] [--branch <name>] [--new "<title>"]
                                                close out a cycle: land the Sparra branch (PR/ff-only), tear down, archive
  clean [--yes] [--force]                       prune stale sparra worktrees/branches (dry-run by default)
  role run --kind <r> [--backend b] [--model m] [--effort low|medium|high|xhigh|max] [--brief f|--brief-text s] [--contract f] [--prior-critique f]… [--holdout f] [--out f] [--workspace d] [--budget <usd>] [--verify] [--worktree [--keep-worktree]]
                                                run ONE role once on a chosen backend (holdout wall enforced) — the cross-model seam (--budget overrides build.maxBudgetUsdPerItem, 0 = unlimited; --verify lets an in-place generator auto-run build.verifyCommands; --worktree runs an evaluator/reviewer/contract-evaluator in a temp WIP-snapshot worktree, torn down after — --keep-worktree retains it; repeatable --prior-critique inlines prior-round critique files into a contract-evaluator re-critique, .sparra/ paths OK)
  eval [dir] [--contract f] [--backend b] [--model m] [--effort x] [--holdout f] [--out f] [--budget <usd>] [--worktree [--keep-worktree]]
                                                grade a work-in-progress tree with a standalone evaluator (alias for: role run --kind evaluator; --worktree gives the exercise writable scratch in a temp worktree that mirrors your WIP)
  measure [dir] [--worktree [--keep-worktree]] [--set-baseline] [--out f]
                                                run the project's own measure.command on a tree, parse its JSON metrics, diff against the baseline (in .sparra/measure/), flag regressions — a signal, never a gate (default compare-only; --set-baseline updates the baseline; --worktree mirrors your WIP)
  resume                                        continue whatever phase you're in, from disk
  help                                          this

${color.bold("Config:")} .sparra/config.yaml (rubric weights, pivot N/threshold, per-role models,
        permission mode, exercise mechanism, deviation strictness, git strategy, …)

${color.bold("Auth:")}  needs an Anthropic credential — set ANTHROPIC_API_KEY or log in via Claude Code.`;

async function main(): Promise<void> {
  const { positionals, flags } = parse(process.argv.slice(2));
  const cmd = positionals[0] ?? "help";
  const root = (flags.root as string) || process.cwd();

  if (cmd === "help" || flags.help) {
    process.stdout.write(HELP + "\n");
    return;
  }

  if (cmd === "init") {
    await cmdInit(root, {
      mode: flags.mode as Mode | undefined,
      force: !!flags.force,
      docs: typeof flags.docs === "string" ? flags.docs : undefined,
    });
    return;
  }

  // Standalone role-runner surfaces work WITHOUT `sparra init`: they resolve a
  // config-less, default-backed context (existing `.sparra/` is still honored).
  if (cmd === "role" || cmd === "eval" || cmd === "measure") {
    const roleCtx = await loadCtxForRole(root);
    // Surface a newer-default (`stale`) / conflicting prompt once on the standalone role-runner
    // path, so a fresh `sparra eval` / `role run` / `measure` learns an adoptable default exists
    // (the build phase already does this via the same summarizer). Quiet when non-actionable.
    const roleDrift = summarizePromptDrift(await promptDrift(roleCtx.paths));
    if (roleDrift.actionable && roleDrift.line) info(`Note: ${roleDrift.line}.`);
    if (cmd === "role") {
      if (positionals[1] === "run") await cmdRoleRun(roleCtx, flags);
      else {
        err(`Unknown role subcommand: ${positionals[1] ?? "(none)"} (try: role run)`);
        process.exitCode = 1;
      }
    } else if (cmd === "measure") {
      // `sparra measure [dir] [--worktree] [--set-baseline] [--out f]` — run the project's own
      // measurement harness on a tree and diff against the stored baseline (mirrors `eval --worktree`).
      await cmdMeasure(roleCtx, {
        dir: typeof flags.dir === "string" ? flags.dir : positionals[1],
        worktree: flags.worktree === true,
        keepWorktree: flags["keep-worktree"] === true,
        setBaseline: flags["set-baseline"] === true,
        out: typeof flags.out === "string" ? flags.out : undefined,
      });
    } else {
      // alias: `sparra eval [dir] [--contract f] [--holdout f] [--backend b] [--out f]`
      // — a standalone evaluator on a WIP tree (defaults the brief).
      const evalFlags: Record<string, string | boolean | string[]> = { ...flags, kind: "evaluator" };
      if (typeof evalFlags.workspace !== "string" && positionals[1]) evalFlags.workspace = positionals[1];
      await cmdRoleRun(roleCtx, evalFlags);
    }
    return;
  }

  // All other commands need an initialized project.
  const ctx = await loadCtx(root);

  switch (cmd) {
    case "orient":
      await cmdOrient(ctx, { light: !!flags.light });
      break;
    case "plan":
      await cmdPlan(ctx);
      break;
    case "prototype":
      await cmdPrototype(ctx, positionals.slice(1).join(" "));
      break;
    case "log-finding":
      await cmdLogFinding(ctx, positionals[1]);
      break;
    case "snapshot":
      await cmdSnapshot(ctx);
      break;
    case "freeze":
      await cmdFreeze(ctx);
      break;
    case "build":
      await cmdBuild(ctx, { fresh: !!flags.fresh, only: flags.only as string | undefined, step: flags.step != null ? parseSteps(flags.step as string | boolean | undefined) : undefined });
      break;
    case "reflect":
      await cmdReflect(ctx, {
        apply: !!flags.apply,
        run: flags.run as string | undefined,
        upstream: !!flags.upstream,
        clear: !!flags.clear,
        traces: typeof flags.traces === "string" ? flags.traces : undefined,
        done: flags.done as string | boolean | undefined,
        wontdo: flags.wontdo as string | boolean | undefined,
        reason: typeof flags.reason === "string" ? flags.reason : undefined,
      });
      break;
    case "batch":
      await cmdBatch(ctx, { k: flags.k ? Number(flags.k) : undefined });
      break;
    case "status":
      cmdStatus(ctx);
      break;
    case "prompts":
      await cmdPrompts(ctx, positionals.slice(1), flags);
      break;
    case "new":
      await cmdNew(ctx, positionals.slice(1).join(" "));
      break;
    case "finish":
      await cmdFinish(ctx, {
        pr: !!flags.pr,
        merge: !!flags.merge,
        yes: !!flags.yes,
        teardown: !!flags.teardown,
        force: !!flags.force,
        branch: typeof flags.branch === "string" ? flags.branch : undefined,
        new: flags.new === undefined ? undefined : typeof flags.new === "string" ? flags.new : "",
      });
      break;
    case "clean":
      await cmdClean(ctx, { yes: !!flags.yes, force: !!flags.force });
      break;
    case "resume":
      await resume(ctx);
      break;
    default:
      err(`Unknown command: ${cmd}`);
      process.stdout.write("\n" + HELP + "\n");
      process.exitCode = 1;
  }
}

async function resume(ctx: Awaited<ReturnType<typeof loadCtx>>): Promise<void> {
  const phase = ctx.store.data.phase;
  banner(`resume (phase: ${phase})`);
  switch (phase) {
    case "orient":
      await cmdOrient(ctx, {});
      break;
    case "plan":
    case "prototype":
      await cmdPlan(ctx);
      break;
    case "frozen":
    case "build":
      await cmdBuild(ctx, {});
      break;
    default:
      info("Nothing in progress. Run `sparra status` to see options.");
      cmdStatus(ctx);
  }
}

main().catch((e) => {
  err((e as Error).message ?? String(e));
  if (process.env.SPARRA_DEBUG) console.error(e);
  process.exitCode = 1;
});
