import type { Ctx } from "../context.ts";
import { runRole, type RoleKind, type RoleRunRequest } from "../build/roleRun.ts";
import { banner, detail, err, info, ok, warn } from "../util/log.ts";

const VALID_KINDS: RoleKind[] = ["generator", "contract-generator", "contract-evaluator", "evaluator", "reviewer"];

/**
 * `sparra role run` — run a single Sparra role once on a chosen backend, with the
 * holdout wall enforced by the runner. The scriptable/headless form of the seam
 * (the MCP `run_role` tool is the interactive surface). Holdout is passed by PATH;
 * the runner is the only thing that reads it, and only for the evaluator.
 */
export async function cmdRoleRun(ctx: Ctx, flags: Record<string, string | boolean | string[]>, runRoleFn: typeof runRole = runRole): Promise<void> {
  banner("sparra role run");
  const kind = String(flags.kind ?? flags.role ?? "") as RoleKind;
  if (!VALID_KINDS.includes(kind)) {
    err(`--kind must be one of: ${VALID_KINDS.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const briefText = typeof flags["brief-text"] === "string" ? (flags["brief-text"] as string) : undefined;
  const briefPath = typeof flags.brief === "string" ? (flags.brief as string) : undefined;
  // The evaluator can grade a WIP tree with a default brief; other roles need one.
  if (!briefText && !briefPath && kind !== "evaluator") {
    err("provide a brief: --brief <file> or --brief-text \"…\"");
    process.exitCode = 1;
    return;
  }

  const req = roleRequestFromFlags(ctx, kind, flags, { briefText, briefPath });

  info(`role=${kind} backend=${req.backend ?? ctx.config.roles[specKey(kind)]?.backend ?? "claude"} workspace=${req.workspace ?? ctx.root}`);
  let res;
  try {
    res = await runRoleFn(req);
  } catch (e) {
    // A thrown error here is most often the holdout wall firing — that's a feature.
    err((e as Error).message);
    process.exitCode = 1;
    return;
  }

  if (res.verdict) {
    const v = res.verdict;
    (v.verdict === "pass" ? ok : warn)(`verdict: ${v.verdict} (${v.weightedTotal}/${ctx.config.rubric.passThreshold}); ${v.blocking.length} blocking`);
  }
  // The auto-persisted redacted verdict (evaluator) — surfaced separately from a caller `--out`.
  if (res.verdictPath) detail(`verdict persisted: ${res.verdictPath}`);
  if (res.outPath) detail(`wrote: ${res.outPath}`);
  if (res.errors.length) warn(`errors: ${res.errors.join("; ")}`);
  // Not-a-fail signals — the same names/meanings as the MCP payload, so a scripted conductor
  // reading CLI output gets the identical resume-or-accept guidance.
  if (res.filesChanged !== undefined) detail(`filesChanged: ${res.filesChanged}`);
  if (res.emptyCompletion)
    warn(`emptyCompletion: true — work LANDED (${res.filesChanged ?? 0} file(s) changed) but the report failed to emit; resume sessionId=${res.sessionId} or accept the landed work — NOT a behavioral fail`);
  if (res.hitBudget) warn(`hitBudget: true — stopped on the per-call budget cap; resume sessionId=${res.sessionId} (backend=${res.backend})`);
  (res.ok ? ok : warn)(`role-run ${res.ok ? "ok" : "not ok"} — ${res.tokens} tokens` + (res.costUsd ? `, $${res.costUsd.toFixed(3)}` : ""));
}

/**
 * Map parsed CLI flags onto a `RoleRunRequest` — a small PURE helper (no model call, no IO) so the
 * CLI-surface→request plumbing is unit-testable. `brief`/`briefPath` are resolved by the caller
 * (it also validates them); everything else is read off `flags` here.
 */
export function roleRequestFromFlags(
  ctx: Ctx,
  kind: RoleKind,
  flags: Record<string, string | boolean | string[]>,
  brief: { briefText?: string; briefPath?: string }
): RoleRunRequest {
  return {
    ctx,
    roleKind: kind,
    workspace: typeof flags.workspace === "string" ? (flags.workspace as string) : undefined,
    brief: brief.briefText,
    briefPath: brief.briefPath,
    contractPath: typeof flags.contract === "string" ? (flags.contract as string) : undefined,
    // `--prior-critique <path>` (repeatable) → prior-round critique files for a contract-evaluator
    // re-critique. The parser collapses a single occurrence to a string and repeats to an array, so
    // normalize both to a string[] (a bare `--prior-critique` with no value is dropped).
    priorCritiquePaths: priorCritiquePathsFromFlag(flags["prior-critique"]),
    holdoutPath: typeof flags.holdout === "string" ? (flags.holdout as string) : undefined,
    out: typeof flags.out === "string" ? (flags.out as string) : undefined,
    backend: typeof flags.backend === "string" ? (flags.backend as string) : undefined,
    model: typeof flags.model === "string" ? (flags.model as string) : undefined,
    effort: parseEffort(flags.effort),
    maxBudgetUsd: parseBudget(flags.budget),
    // `--verify` (a bare boolean flag) opts the GENERATOR into in-place self-verify of
    // build.verifyCommands. Parsed as a real boolean (`=== true`), never a stray "true" string;
    // a no-op on the `eval` alias (the evaluator isn't a writer, so verifyInPlace is unused).
    allowVerify: flags.verify === true ? true : undefined,
    // `--worktree` (bare boolean) runs a read-only judge role (evaluator/reviewer) in a TEMPORARY
    // linked worktree snapshotted from the selected workspace's WIP, so the exercise gets writable
    // scratch; `--keep-worktree` retains it for inspection. Same strict boolean parse as --verify.
    useWorktree: flags.worktree === true ? true : undefined,
    keepWorktree: flags["keep-worktree"] === true ? true : undefined,
  };
}

/** Normalize the repeatable `--prior-critique` flag into a `priorCritiquePaths` array (given order
 *  preserved), or undefined when absent. The generic CLI parser yields a bare string for one
 *  occurrence and a string[] for several; a value-less `--prior-critique` (parsed as boolean `true`)
 *  contributes no path. */
function priorCritiquePathsFromFlag(flag: string | boolean | string[] | undefined): string[] | undefined {
  const paths = (Array.isArray(flag) ? flag : [flag]).filter((v): v is string => typeof v === "string");
  return paths.length ? paths : undefined;
}

/** Parse a `--budget <usd>` flag into a per-call USD cap, or undefined (use the config default).
 *  `0` is preserved (it means unlimited per budget.ts); a non-numeric value is ignored. */
function parseBudget(flag: string | boolean | string[] | undefined): number | undefined {
  if (typeof flag !== "string") return undefined;
  const n = Number(flag);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** Parse a `--effort` flag into a valid RoleConfig effort, or undefined (use the role's config). */
function parseEffort(flag: string | boolean | string[] | undefined): RoleRunRequest["effort"] {
  if (typeof flag !== "string") return undefined;
  return (EFFORTS as readonly string[]).includes(flag) ? (flag as RoleRunRequest["effort"]) : undefined;
}

/** Map a roleKind to its config key (for the info line). */
function specKey(kind: RoleKind): "generator" | "contractGenerator" | "contractEvaluator" | "evaluator" | "reviewer" {
  switch (kind) {
    case "contract-generator":
      return "contractGenerator";
    case "contract-evaluator":
      return "contractEvaluator";
    case "generator":
      return "generator";
    case "evaluator":
      return "evaluator";
    case "reviewer":
      return "reviewer";
  }
}
