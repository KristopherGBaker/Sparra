import os from "node:os";
import path from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  runRole as coreRunRole,
  runUnit,
  type BuildCycleResult,
  type ContractRoundContext,
  type ContractRoundRecord,
  type RoleRunner,
  type RoundContext,
  type RoundRecord,
  type RunUnitConfig,
  type RunUnitResult,
} from "../core/index.ts";

/**
 * `conductors/pi/loopCommand.ts` — the Pi `/sparra-loop` command: wires the host-agnostic
 * `conductors/core/contract.ts`'s `runUnit` to a Pi slash command, so `/sparra-loop` drives the FULL
 * unit — contract negotiation → generate → cross-model evaluate → decide — not just the build cycle.
 *
 * PI-RUNTIME-FREE: the only import from `@earendil-works/pi-coding-agent` here is the TYPE-ONLY
 * `ExtensionAPI`/`ExtensionCommandContext` (erased at build time by `import type`), so importing
 * this module never loads the Pi SDK — it stays testable and safe to import from a plain test, same
 * as `roleRunner.ts`. The real Pi extension entrypoint (`extension.ts`) is the only file that
 * imports `@earendil-works/*` as a runtime value. `node:os`/`node:path` are plain node built-ins, not
 * Pi/typebox, so they don't break that invariant.
 *
 * Cross-model gate: the generator spec defaults to a different model than the evaluator AND
 * contract-evaluator specs (`sonnet` / `opus`), so `decideFromEvaluation`'s `sameModelGrade` check
 * has a genuine chance to hold rather than being trivially defeated by both roles running the same
 * model. The contract-evaluator runs on the evaluator model too — it is the adversarial critic of the
 * generator's proposed contract, same as the evaluator is the adversarial critic of the generator's
 * implementation.
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
  contractRounds?: number;
  proceedIfNotAgreed: boolean;
}

const DEFAULT_GENERATOR_MODEL = "sonnet";
const DEFAULT_EVALUATOR_MODEL = "opus";
const DEFAULT_BACKEND = "claude";
const DEFAULT_CONTRACT_ROUNDS = 3;

/**
 * Parse `/sparra-loop --brief <path> --contract <path> [--holdout <path>] [--generator-model m]
 * [--evaluator-model m] [--backend b] [--max-rounds n] [--contract-rounds n]
 * [--proceed-if-not-agreed]`. Unknown/malformed input throws with a usage message rather than
 * silently guessing a brief/contract path. `--proceed-if-not-agreed` is a boolean flag — it takes no
 * value.
 */
export function parseLoopCommandArgs(args: string): LoopCommandArgs {
  const tokens = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
  const flags = new Map<string, string>();
  let proceedIfNotAgreed = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "--proceed-if-not-agreed") {
      proceedIfNotAgreed = true;
      continue;
    }
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
        "[--generator-model m] [--evaluator-model m] [--backend b] [--max-rounds n] " +
        "[--contract-rounds n] [--proceed-if-not-agreed]",
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

  const contractRoundsRaw = flags.get("contract-rounds");
  let contractRounds: number | undefined;
  if (contractRoundsRaw !== undefined) {
    contractRounds = Number.parseInt(contractRoundsRaw, 10);
    if (!Number.isFinite(contractRounds) || contractRounds <= 0) {
      throw new Error(
        `/sparra-loop: --contract-rounds must be a positive integer, got "${contractRoundsRaw}"`,
      );
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
    ...(contractRounds !== undefined ? { contractRounds } : {}),
    proceedIfNotAgreed,
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

/** Where round N's contract-evaluator critique is written. Only the PATH is ever threaded onward
 *  (via `ContractRoundContext.priorCritiquePaths`) — this file never opens it. */
function critiquePath(round: number, critiqueDir: string): string {
  return path.join(critiqueDir, `sparra-loop-critique-round-${round}.md`);
}

/** Build the `RunUnitConfig` for one `/sparra-loop` invocation: a contract-negotiation phase (the
 *  adversarial `contract-evaluator`, on the evaluator model) composed with the existing cross-model
 *  generator/evaluator build-cycle specs over the sparra CLI's `role run`/`eval` surface.
 *  `opts.critiqueDir` overrides where per-round critiques are written (default `os.tmpdir()`) — a
 *  test seam so a run never scribbles into a real tmp dir. */
export function buildRunUnitConfig(
  parsed: LoopCommandArgs,
  opts?: { critiqueDir?: string },
): RunUnitConfig {
  const critiqueDir = opts?.critiqueDir ?? os.tmpdir();

  const config: RunUnitConfig = {
    contract: {
      contractEvaluatorSpec: (ctx: ContractRoundContext) => {
        const args = [
          "role",
          "run",
          "--kind",
          "contract-evaluator",
          "--backend",
          parsed.backend,
          "--model",
          parsed.evaluatorModel,
          // The runner requires a brief for every kind except `evaluator`; a contract-evaluator argv
          // without --brief is rejected pre-model (the historical missing-`--brief` bug). Thread the
          // parsed brief path so the emitted argv is accepted by the real CLI parser/validator.
          "--brief",
          parsed.brief,
          "--contract",
          parsed.contract,
          "--out",
          critiquePath(ctx.round, critiqueDir),
          "--json",
          ...ctx.priorCritiquePaths.flatMap((p) => ["--prior-critique", p]),
        ];
        return { args };
      },
      maxRounds: parsed.contractRounds ?? DEFAULT_CONTRACT_ROUNDS,
    },
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
    proceedIfNotAgreed: parsed.proceedIfNotAgreed,
  };
  if (parsed.maxRounds !== undefined) config.maxRounds = parsed.maxRounds;
  return config;
}

/** One line per contract round: `contract round N: agreed=<bool> (contractAgreed=…)`. */
function renderContractRoundLine(round: ContractRoundRecord): string {
  return `contract round ${round.round}: agreed=${round.agreed} (contractAgreed=${round.evaluator.contractAgreed ?? "unknown"})`;
}

/** One line per build-cycle round: `round N: <decision> (verdict=..., weightedTotal=.../passThreshold=...)`. */
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

/** Render the full holdout-safe unit report: contract-negotiation rounds + agreement line, then (if
 *  the cycle ran) the per-round build-cycle lines, then the terminal outcome. Only `ParentSummary`
 *  fields flow through — never a raw transcript, holdout content, or evaluator trace directory. */
export function renderUnitReport(result: RunUnitResult): string {
  const lines = result.contract.rounds.map(renderContractRoundLine);
  lines.push(
    `contract: ${result.contract.agreed ? "agreed" : "not-agreed"} after ${result.contract.rounds.length} round(s)`,
  );
  if (result.cycle) {
    lines.push(...result.cycle.rounds.map(renderRoundLine));
  }
  lines.push(`outcome: ${result.outcome}`);
  return lines.join("\n");
}

/** Register the `/sparra-loop` command on the given Pi extension host. `deps.runRole` lets a test
 *  inject a scripted runner without ever loading Pi or spawning a real `sparra` process. */
export function registerSparraLoopCommand(pi: ExtensionAPI, deps?: { runRole?: RoleRunner }): void {
  const runRole = deps?.runRole ?? coreRunRole;
  pi.registerCommand("sparra-loop", {
    description:
      "Run a full Sparra unit (negotiate contract → generate → cross-model evaluate → decide) as a " +
      "program: /sparra-loop --brief <path> --contract <path> [--holdout <path>] " +
      "[--generator-model m] [--evaluator-model m] [--backend b] [--max-rounds n] " +
      "[--contract-rounds n] [--proceed-if-not-agreed]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      let parsed: LoopCommandArgs;
      try {
        parsed = parseLoopCommandArgs(args);
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
        return;
      }

      const config = buildRunUnitConfig(parsed);
      const result = await runUnit({ runRole }, config);
      ctx.ui.notify(renderUnitReport(result), result.outcome === "accepted" ? "info" : "warning");
    },
  });
}
