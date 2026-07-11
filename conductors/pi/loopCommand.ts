import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  runBuildCycle,
  runRole as coreRunRole,
  type BuildCycleConfig,
  type BuildCycleResult,
  type RoleRunner,
  type RoundContext,
  type RoundRecord,
} from "../core/index.ts";

/**
 * `conductors/pi/loopCommand.ts` — the Pi `/sparra-loop` command: wires the host-agnostic
 * `conductors/core/loop.ts` build-cycle orchestrator to a Pi slash command.
 *
 * PI-RUNTIME-FREE: the only import from `@earendil-works/pi-coding-agent` here is the TYPE-ONLY
 * `ExtensionAPI`/`ExtensionCommandContext` (erased at build time by `import type`), so importing
 * this module never loads the Pi SDK — it stays testable and safe to import from a plain test, same
 * as `roleRunner.ts`. The real Pi extension entrypoint (`extension.ts`) is the only file that
 * imports `@earendil-works/*` as a runtime value.
 *
 * Cross-model gate: the generator and evaluator specs below default to DIFFERENT models
 * (`sonnet` / `opus`), so `decideFromEvaluation`'s `sameModelGrade` check has a genuine chance to
 * hold rather than being trivially defeated by both roles running the same model.
 */

/** Parsed `/sparra-loop <args>` invocation. */
interface LoopCommandArgs {
  brief: string;
  contract: string;
  holdout?: string;
  generatorModel: string;
  evaluatorModel: string;
  backend: string;
  maxRounds?: number;
}

const DEFAULT_GENERATOR_MODEL = "sonnet";
const DEFAULT_EVALUATOR_MODEL = "opus";
const DEFAULT_BACKEND = "claude";

/**
 * Parse `/sparra-loop --brief <path> --contract <path> [--holdout <path>] [--generator-model m]
 * [--evaluator-model m] [--backend b] [--max-rounds n]`. Unknown/malformed input throws with a
 * usage message rather than silently guessing a brief/contract path.
 */
export function parseLoopCommandArgs(args: string): LoopCommandArgs {
  const tokens = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
  const flags = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok?.startsWith("--")) {
      const name = tok.slice(2);
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`/sparra-loop: --${name} requires a value`);
      }
      flags.set(name, value);
      i++;
    }
  }

  const brief = flags.get("brief");
  const contract = flags.get("contract");
  if (!brief || !contract) {
    throw new Error(
      "/sparra-loop: usage: /sparra-loop --brief <path> --contract <path> [--holdout <path>] " +
        "[--generator-model m] [--evaluator-model m] [--backend b] [--max-rounds n]",
    );
  }

  const maxRoundsRaw = flags.get("max-rounds");
  let maxRounds: number | undefined;
  if (maxRoundsRaw !== undefined) {
    maxRounds = Number.parseInt(maxRoundsRaw, 10);
    if (!Number.isFinite(maxRounds) || maxRounds <= 0) {
      throw new Error(`/sparra-loop: --max-rounds must be a positive integer, got "${maxRoundsRaw}"`);
    }
  }

  return {
    brief,
    contract,
    holdout: flags.get("holdout"),
    generatorModel: flags.get("generator-model") ?? DEFAULT_GENERATOR_MODEL,
    evaluatorModel: flags.get("evaluator-model") ?? DEFAULT_EVALUATOR_MODEL,
    backend: flags.get("backend") ?? DEFAULT_BACKEND,
    ...(maxRounds !== undefined ? { maxRounds } : {}),
  };
}

/** Render the round-N context (prior blocking feedback + a pivot signal) into `--brief-text`, so the
 *  generator round's args carry it without this file ever reading/writing a file itself. On round 1
 *  (no feedback, not pivoting) this is `undefined` — the generator runs off `--brief` alone. */
function feedbackBriefText(ctx: RoundContext): string | undefined {
  if (ctx.feedback.length === 0 && !ctx.pivoting) return undefined;
  const lines = [`Round ${ctx.round}.`];
  if (ctx.pivoting) {
    lines.push(
      "PIVOT: the prior approach failed repeatedly — try a genuinely different approach, not a " +
        "small patch on the same one.",
    );
  }
  if (ctx.feedback.length > 0) {
    lines.push("Address this prior round's blocking feedback:");
    for (const line of ctx.feedback) lines.push(`- ${line}`);
  }
  return lines.join("\n");
}

/** Build the `BuildCycleConfig` for one `/sparra-loop` invocation: cross-model generator/evaluator
 *  specs over the sparra CLI's `role run`/`eval` surface. */
export function buildLoopConfig(parsed: LoopCommandArgs): BuildCycleConfig {
  const config: BuildCycleConfig = {
    generatorSpec: (ctx) => {
      const args = [
        "role",
        "run",
        "--kind",
        "generator",
        "--backend",
        parsed.backend,
        "--model",
        parsed.generatorModel,
        "--brief",
        parsed.brief,
        "--contract",
        parsed.contract,
        "--json",
      ];
      const briefText = feedbackBriefText(ctx);
      if (briefText) args.push("--brief-text", briefText);
      return { args };
    },
    evaluatorSpec: () => {
      const args = [
        "eval",
        ".",
        "--contract",
        parsed.contract,
        "--backend",
        parsed.backend,
        "--model",
        parsed.evaluatorModel,
        "--json",
      ];
      if (parsed.holdout) args.push("--holdout", parsed.holdout);
      return { args };
    },
  };
  if (parsed.maxRounds !== undefined) config.maxRounds = parsed.maxRounds;
  return config;
}

/** One line per round: `round N: <decision> (verdict=..., weightedTotal=.../passThreshold=...)`. */
function renderRoundLine(round: RoundRecord): string {
  const ev = round.evaluator;
  return (
    `round ${round.round}: ${round.decision} ` +
    `(verdict=${ev.verdict ?? "unknown"}, weightedTotal=${ev.weightedTotal ?? "n/a"}, ` +
    `passThreshold=${ev.passThreshold ?? "n/a"})`
  );
}

/** Render the full holdout-safe cycle report: only `ParentSummary`-derived fields — never a raw
 *  transcript, holdout content, or evaluator trace directory. */
export function renderLoopReport(result: BuildCycleResult): string {
  const lines = result.rounds.map(renderRoundLine);
  lines.push(`outcome: ${result.outcome}`);
  return lines.join("\n");
}

/** Register the `/sparra-loop` command on the given Pi extension host. `deps.runRole` lets a test
 *  inject a scripted runner without ever loading Pi or spawning a real `sparra` process. */
export function registerSparraLoopCommand(pi: ExtensionAPI, deps?: { runRole?: RoleRunner }): void {
  const runRole = deps?.runRole ?? coreRunRole;
  pi.registerCommand("sparra-loop", {
    description:
      "Run the Sparra build cycle (generate → cross-model evaluate → decide) as a program: " +
      "/sparra-loop --brief <path> --contract <path> [--holdout <path>] [--generator-model m] " +
      "[--evaluator-model m] [--backend b] [--max-rounds n]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      let parsed: LoopCommandArgs;
      try {
        parsed = parseLoopCommandArgs(args);
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
        return;
      }

      const config = buildLoopConfig(parsed);
      const result = await runBuildCycle({ runRole }, config);
      ctx.ui.notify(renderLoopReport(result), result.outcome === "accepted" ? "info" : "warning");
    },
  });
}
