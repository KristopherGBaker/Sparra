import { runRole as coreRunRole, type ParentSummary, type RunRoleSpec } from "../core/index.ts";

/**
 * Pi-DEPENDENCY-FREE tool logic for the `sparra_role` Pi tool.
 *
 * This module imports NO `@earendil-works/*` and NO `typebox` — it is the tested, offline-safe
 * core of the Pi adapter. The actual Pi extension ({@link ./extension.ts}) is a thin wrapper that
 * hands a tool's raw params to {@link runSparraRoleForTool} and renders its `text` output.
 *
 * Reuses `conductors/core`'s `runRole` for the CLI spawn + holdout redaction — this file does not
 * reimplement either.
 */

/** Structured input for the `sparra_role` tool. Mirrors the shape a model-driven caller (or the
 *  Pi tool's typed params) would supply; kept independent of any Pi/typebox type so this stays
 *  Pi-free. */
export interface SparraRoleToolInput {
  /** Optional label for the role being run (documentation/echo only — not passed to sparra unless
   *  present in `args`). */
  roleKind?: string;
  /** Argv for the sparra CLI, e.g. `["role","run","--kind","evaluator"]` or `["eval", dir,
   *  "--contract", c]`. `--json` is appended by the core `runRole` if absent. */
  args: string[];
  /** The sparra binary. Defaults to `$SPARRA_BIN` / `"sparra"` (see `conductors/core/roleClient`). */
  sparraBin?: string;
  cwd?: string;
  /** Path to a holdout file. Only the PATH is ever forwarded (as `--holdout <path>`); the adapter
   *  never reads this file itself. */
  holdoutPath?: string;
}

/** Output of the tool: the holdout-safe summary plus a compact, human/model-readable rendering. */
export interface SparraRoleToolOutput {
  summary: ParentSummary;
  /** Compact holdout-safe text: verdict / weightedTotal / passThreshold / blocking count /
   *  verdictPath / flags. NEVER includes `resultText`, `resultDigest`, `traceDir`, or any raw
   *  evaluator/generator transcript — only the fields on {@link ParentSummary}. */
  text: string;
}

/** Injectable dependencies, for offline testing against a stub `runRole`. */
export interface RunSparraRoleForToolDeps {
  runRole?: typeof coreRunRole;
}

function buildSpec(input: SparraRoleToolInput): RunRoleSpec {
  const args = input.holdoutPath ? [...input.args, "--holdout", input.holdoutPath] : [...input.args];
  const spec: RunRoleSpec = { args };
  if (input.sparraBin !== undefined) spec.sparraBin = input.sparraBin;
  if (input.cwd !== undefined) spec.cwd = input.cwd;
  return spec;
}

/**
 * Collect the control-flag fields present on the summary into short labels, e.g.
 * `["limitHit=rate","noProgress"]` → `"limitHit=rate, noProgress"`. Each field is handled per its
 * REAL {@link ParentSummary} type (some are booleans, some are short strings, some — `fallbackFrom`,
 * `limitHit`, `unitWorktree`, `promptDrift` — are small objects) rather than a generic
 * boolean-or-string check, so an object-valued field's mere presence isn't silently swallowed.
 * Only ever reads {@link ParentSummary} fields — never anything holdout-bearing.
 */
function renderFlags(summary: ParentSummary): string {
  const flags: string[] = [];
  if (summary.sameModelGrade === true) flags.push("sameModelGrade");
  if (summary.fallbackFrom) {
    const { backend, model } = summary.fallbackFrom;
    flags.push(`fallbackFrom=${backend}${model ? `/${model}` : ""}`);
  }
  if (summary.limitHit) flags.push(`limitHit=${summary.limitHit.kind}`);
  if (summary.hitBudget === true) flags.push("hitBudget");
  if (summary.hitMaxTurns === true) flags.push("hitMaxTurns");
  if (summary.emptyCompletion === true) flags.push("emptyCompletion");
  if (summary.noProgress === true) flags.push("noProgress");
  if (summary.verifyGateWarning) flags.push(`verifyGateWarning=${summary.verifyGateWarning}`);
  if (summary.unitWorktree) flags.push(`unitWorktree=${summary.unitWorktree.name}`);
  if (summary.promptDrift) flags.push("promptDrift");
  return flags.length > 0 ? flags.join(", ") : "none";
}

/** Render a {@link ParentSummary} into the compact, holdout-safe text a tool caller sees. */
export function renderSummaryText(summary: ParentSummary): string {
  const blockingCount = Array.isArray(summary.blocking) ? summary.blocking.length : 0;
  const lines = [
    `verdict: ${summary.verdict ?? "unknown"}`,
    `weightedTotal: ${summary.weightedTotal ?? "n/a"}`,
    `passThreshold: ${summary.passThreshold ?? "n/a"}`,
    `blocking: ${blockingCount}`,
    `verdictPath: ${summary.verdictPath ?? "n/a"}`,
    `flags: ${renderFlags(summary)}`,
  ];
  return lines.join("\n");
}

/**
 * Build a {@link RunRoleSpec} from `input` and run it via `conductors/core`'s `runRole` (or
 * `deps.runRole`, for offline tests). Returns ONLY the redacted {@link ParentSummary} plus a
 * compact text rendering — never the raw envelope.
 *
 * A `holdoutPath` is forwarded as `--holdout <path>` in the spec's args; this function never opens
 * or reads that file — the path crosses the process boundary and the sparra CLI child (or the
 * evaluator role inside it) is the only thing that ever reads it.
 */
export async function runSparraRoleForTool(
  input: SparraRoleToolInput,
  deps?: RunSparraRoleForToolDeps,
): Promise<SparraRoleToolOutput> {
  const runRole = deps?.runRole ?? coreRunRole;
  const spec = buildSpec(input);
  const summary = await runRole(spec);
  return { summary, text: renderSummaryText(summary) };
}
