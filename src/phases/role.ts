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
export async function cmdRoleRun(ctx: Ctx, flags: Record<string, string | boolean>): Promise<void> {
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

  const req: RoleRunRequest = {
    ctx,
    roleKind: kind,
    workspace: typeof flags.workspace === "string" ? (flags.workspace as string) : undefined,
    brief: briefText,
    briefPath,
    contractPath: typeof flags.contract === "string" ? (flags.contract as string) : undefined,
    holdoutPath: typeof flags.holdout === "string" ? (flags.holdout as string) : undefined,
    out: typeof flags.out === "string" ? (flags.out as string) : undefined,
    backend: typeof flags.backend === "string" ? (flags.backend as string) : undefined,
    model: typeof flags.model === "string" ? (flags.model as string) : undefined,
  };

  info(`role=${kind} backend=${req.backend ?? ctx.config.roles[specKey(kind)]?.backend ?? "claude"} workspace=${req.workspace ?? ctx.root}`);
  let res;
  try {
    res = await runRole(req);
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
  if (res.outPath) detail(`wrote: ${res.outPath}`);
  if (res.errors.length) warn(`errors: ${res.errors.join("; ")}`);
  (res.ok ? ok : warn)(`role-run ${res.ok ? "ok" : "not ok"} — ${res.tokens} tokens` + (res.costUsd ? `, $${res.costUsd.toFixed(3)}` : ""));
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
