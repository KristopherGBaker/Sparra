import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type {
  ContractRoundContext,
  RoundContext,
  RunRoleSpec,
} from "../../conductors/core/index.ts";
import type { RoleConfig } from "../config.ts";
import { defaultUnitWorktreeDir } from "../build/unitWorktree.ts";

/**
 * `src/conduct/roleSpecs.ts` — builds the `sparra role run … --json` argv for every conduct role.
 *
 * No model calls: each builder returns a {@link RunRoleSpec} the core `runRole` (or a test fake)
 * executes. Builders are pure argv construction with ONE exception — a contract-generator REVISION
 * round writes a composite revision brief file (the runner rejects `--prior-critique` for
 * contract-generators, so critique text must be inlined; the critique is contract-evaluator output
 * and thus holdout-free by construction). Role identity (`--backend --model --effort`) is sourced from
 * `ctx.config.roles`; the holdout PATH (never contents) rides only on the evaluator spec; the
 * generator identity rides on the evaluator spec as `--baseline-backend/--baseline-model` so the
 * runner can set `sameModelGrade` and the cross-model gate stays effective through the conduct path.
 */

/** Resolve the sparra bin the conduct role-runs spawn: `$SPARRA_BIN` when set, else THIS repo's own
 *  `bin/sparra.mjs` (so a conduct run never depends on a globally-installed `sparra`). */
export function resolveSparraBin(): string {
  const fromEnv = process.env.SPARRA_BIN;
  if (fromEnv) return fromEnv;
  const here = path.dirname(fileURLToPath(import.meta.url)); // <repo>/src/conduct
  return path.resolve(here, "..", "..", "bin", "sparra.mjs");
}

/** Common role-identity flags from a configured {@link RoleConfig}. */
function roleFlags(role: RoleConfig): string[] {
  const args = ["--backend", role.backend ?? "claude", "--model", role.model];
  if (role.effort) args.push("--effort", role.effort);
  return args;
}

/** Prior-critique args (threaded paths only — never contents). */
function priorCritiqueArgs(paths: string[]): string[] {
  return paths.flatMap((p) => ["--prior-critique", p]);
}

/** Per-role-run cap flags (`--budget`/`--max-turns`), threaded onto EVERY spawned role-run — the
 *  contract-generator + contract-evaluator negotiation roles as well as the generator + evaluator.
 *  `--budget 0` (= unlimited) is a real value and is propagated; only an omitted flag adds nothing. */
function capFlags(budget?: number, maxTurns?: number): string[] {
  const args: string[] = [];
  if (budget !== undefined) args.push("--budget", String(budget));
  if (maxTurns !== undefined) args.push("--max-turns", String(maxTurns));
  return args;
}

/** Round>1 feedback / pivot signal rendered into `--brief-text` (mirrors the Pi loop command). */
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

/** Everything a unit's four role specs need. All paths are absolute. */
export interface ConductRoleSpecParams {
  roles: {
    contractGenerator: RoleConfig;
    contractEvaluator: RoleConfig;
    generator: RoleConfig;
    evaluator: RoleConfig;
  };
  /** The source checkout the roles run against (`ctx.root`). */
  workspace: string;
  /** This unit's run-dir subfolder (`<runDir>/<unitId>`). */
  unitDir: string;
  briefPath: string;
  /** Rolling contract file the generator drafts into and the evaluator critiques (`<unitDir>/contract.md`). */
  contractPath: string;
  /** Holdout PATH (never contents); evaluator spec only. */
  holdoutPath?: string;
  /** Stable per-unit worktree name (same across every round of this unit). */
  unitWorktree: string;
  /** Per-role-run USD cap (`--budget`); `0` = unlimited (role-run convention). */
  budget?: number;
  /** Per-role-run turn cap (`--max-turns`). */
  maxTurns?: number;
  /** Tag threaded onto every spec's env so an incremental persister can attribute a role to a unit. */
  unitId: string;
  sparraBin: string;
}

/** Per-round critique file the contract-evaluator writes (its `outPath` threads forward). */
function critiquePath(unitDir: string, round: number): string {
  return path.join(unitDir, `critique-r${round}.md`);
}

/** Write the composite revision brief for a contract-generator REVISION round: the original brief,
 *  a delta instruction, and each prior critique's text (in round order) inlined verbatim. Returns
 *  the new file's path (`<unitDir>/brief.r<round>.md`). Critiques are contract-evaluator output —
 *  holdout-free by construction — so inlining them crosses no wall. */
function writeRevisionBrief(unitDir: string, briefPath: string, ctx: ContractRoundContext): string {
  const original = fs.readFileSync(briefPath, "utf8");
  const critiques = ctx.priorCritiquePaths
    .map((cp, i) => `### Critique ${i + 1} (${path.basename(cp)})\n\n${fs.readFileSync(cp, "utf8")}`)
    .join("\n\n");
  const out = path.join(unitDir, `brief.r${ctx.round}.md`);
  fs.writeFileSync(
    out,
    `${original}\n\n---\nREVISION ROUND ${ctx.round}: revise the existing contract (the file passed via --contract) as a DELTA — address each critique item below, preserve resolved positions unless new evidence is named, and end with a short changelog of what changed.\n\n## Prior critique(s), in order\n\n${critiques}\n`,
  );
  return out;
}

/**
 * Build the four spec functions a conduct unit hands to core `runUnit`: contract-generator +
 * contract-evaluator (the negotiation), then generator + evaluator (the build cycle). Every spec
 * carries `cwd: workspace`, the repo `sparraBin`, and the unit-id env tag.
 */
export function buildUnitRoleSpecs(p: ConductRoleSpecParams): {
  contractGeneratorSpec: (ctx: ContractRoundContext) => RunRoleSpec;
  contractEvaluatorSpec: (ctx: ContractRoundContext) => RunRoleSpec;
  generatorSpec: (ctx: RoundContext) => RunRoleSpec;
  /** Like `generatorSpec` but with an explicit generator role (for 2nd-pivot ESCALATION) and an
   *  optional brief-path override (for a GENERALIZED-spec revision — a NEW file, never edited). */
  generatorSpecFor: (role: RoleConfig, ctx: RoundContext, briefPath?: string) => RunRoleSpec;
  evaluatorSpec: (ctx: RoundContext) => RunRoleSpec;
} {
  const env = { SPARRA_CONDUCT_UNIT: p.unitId };
  const base = (args: string[], cwd = p.workspace): RunRoleSpec => ({
    args,
    cwd,
    sparraBin: p.sparraBin,
    env,
  });
  const gen = p.roles.generator;
  const worktreeDir = defaultUnitWorktreeDir(p.workspace, p.unitWorktree);

  const contractGeneratorSpec = (ctx: ContractRoundContext): RunRoleSpec =>
    base([
      "role",
      "run",
      "--kind",
      "contract-generator",
      ...roleFlags(p.roles.contractGenerator),
      "--brief",
      // The runner rejects --prior-critique for contract-generators (re-critique threading is
      // contract-evaluator-only), so a REVISION round inlines the critique text into a composite
      // revision brief — a NEW file per round, the original brief is never edited.
      ctx.priorCritiquePaths.length > 0
        ? writeRevisionBrief(p.unitDir, p.briefPath, ctx)
        : p.briefPath,
      "--out",
      p.contractPath,
      ...capFlags(p.budget, p.maxTurns),
      "--json",
    ]);

  const contractEvaluatorSpec = (ctx: ContractRoundContext): RunRoleSpec =>
    base([
      "role",
      "run",
      "--kind",
      "contract-evaluator",
      ...roleFlags(p.roles.contractEvaluator),
      // The runner requires a brief for every kind except `evaluator`; the critique also needs it
      // to judge the contract against what was actually asked.
      "--brief",
      p.briefPath,
      "--contract",
      p.contractPath,
      "--out",
      critiquePath(p.unitDir, ctx.round),
      ...priorCritiqueArgs(ctx.priorCritiquePaths),
      ...capFlags(p.budget, p.maxTurns),
      "--json",
    ]);

  const generatorSpecFor = (role: RoleConfig, ctx: RoundContext, briefPath = p.briefPath): RunRoleSpec => {
    const args = [
      "role",
      "run",
      "--kind",
      "generator",
      ...roleFlags(role),
      "--brief",
      briefPath,
      "--contract",
      p.contractPath,
      "--unit-worktree",
      p.unitWorktree,
    ];
    const briefText = feedbackBriefText(ctx);
    if (briefText) args.push("--brief-text", briefText);
    args.push(...capFlags(p.budget, p.maxTurns), "--json");
    return base(args);
  };
  const generatorSpec = (ctx: RoundContext): RunRoleSpec => generatorSpecFor(gen, ctx);

  const evaluatorSpec = (): RunRoleSpec => {
    const args = [
      "role",
      "run",
      "--kind",
      "evaluator",
      ...roleFlags(p.roles.evaluator),
      // Grade the unit's PERSISTENT worktree (the generator's write boundary) in place.
      "--workspace",
      worktreeDir,
      "--contract",
      p.contractPath,
      // Cross-model gate: carry the GENERATOR's identity so the runner sets sameModelGrade when the
      // evaluator's post-fallback identity collapses onto it.
      "--baseline-backend",
      gen.backend ?? "claude",
      "--baseline-model",
      gen.model,
    ];
    // Holdout PATH only (never opened here) — evaluator-only.
    if (p.holdoutPath !== undefined) args.push("--holdout", p.holdoutPath);
    args.push(...capFlags(p.budget, p.maxTurns), "--json");
    return base(args);
  };

  return { contractGeneratorSpec, contractEvaluatorSpec, generatorSpec, generatorSpecFor, evaluatorSpec };
}

/** The spec-builder bundle returned by {@link buildUnitRoleSpecs}. */
export type UnitRoleSpecs = ReturnType<typeof buildUnitRoleSpecs>;
