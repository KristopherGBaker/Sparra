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
import { cmdPrompts } from "./phases/prompts.ts";
import { cmdRoleRun } from "./phases/role.ts";

interface Args {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parse(argv: string[]): Args {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-k") {
      flags.k = argv[++i] ?? "";
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

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
  build [--fresh] [--only <item-id>] [--step contract,round]
                                                Phase C: autonomous generator/evaluator loop (resumable; --step pauses for human steering)
  reflect [--apply] [--run <runId>]             self-improvement: propose/apply prompt edits from traces
  prompts [status|sync] [--role <r>] [--dry-run] compare/sync .sparra/prompts with the built-in defaults
  batch [-k N]                                  run N builds of the frozen plan; summarize failures
  status                                        show phase, items, and the suggested next command
  new ["<title>"]                               start a fresh plan→build cycle (archives the finished one)
  role run --kind <r> [--backend b] [--brief f|--brief-text s] [--contract f] [--holdout f] [--out f] [--workspace d]
                                                run ONE role once on a chosen backend (holdout wall enforced) — the cross-model seam
  eval [dir] [--contract f] [--backend b] [--holdout f] [--out f]
                                                grade a work-in-progress tree with a standalone evaluator (alias for: role run --kind evaluator)
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
  if (cmd === "role" || cmd === "eval") {
    const roleCtx = await loadCtxForRole(root);
    if (cmd === "role") {
      if (positionals[1] === "run") await cmdRoleRun(roleCtx, flags);
      else {
        err(`Unknown role subcommand: ${positionals[1] ?? "(none)"} (try: role run)`);
        process.exitCode = 1;
      }
    } else {
      // alias: `sparra eval [dir] [--contract f] [--holdout f] [--backend b] [--out f]`
      // — a standalone evaluator on a WIP tree (defaults the brief).
      const evalFlags: Record<string, string | boolean> = { ...flags, kind: "evaluator" };
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
      await cmdBuild(ctx, { fresh: !!flags.fresh, only: flags.only as string | undefined, step: flags.step != null ? parseSteps(flags.step) : undefined });
      break;
    case "reflect":
      await cmdReflect(ctx, { apply: !!flags.apply, run: flags.run as string | undefined });
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
