/**
 * `conductors/http/handlers/conductor.ts` — the holdout-safe `/role` and `/unit` endpoints.
 *
 * These are the load-bearing HOLDOUT WALL over HTTP. They delegate to `conductors/core`
 * (`runRole` / `runUnit`) — which already redact to a `ParentSummary` via `toParentSummary` — and
 * NEVER shell out themselves, parse a raw envelope, or read a holdout file. `/role` returns the
 * core's `ParentSummary` VERBATIM (adding no field of its own); `/unit` returns only a projection
 * built solely from decision-relevant, already-redacted fields. Neither ever carries `resultText`,
 * `traceDir`, a raw verdict dump, or holdout text.
 *
 * Every request-supplied path (`root`/`workspace`, `briefPath`, `contractPath`, `holdoutPath`,
 * `worktree`, `unitWorktree`) goes through U1's `resolveWithinAllowlist` BEFORE the core runner is
 * ever called; `holdoutPath` is forwarded as `--holdout <path>` and never opened here.
 */

import { z } from "zod";

import {
  type ContractRoundContext,
  type ParentSummary,
  type RoleRunner,
  type RunRoleSpec,
  type RunUnitConfig,
  type RunUnitResult,
} from "../../core/index.ts";
import { resolveWithinAllowlist } from "../paths.ts";
import type { RouteContext, RouteDefinition, RouteResult } from "../server.ts";
import { TargetLock } from "../spawn.ts";

/** The injected core `runRole` — returns an already-redacted `ParentSummary`. */
export type RunRoleFn = (spec: RunRoleSpec) => Promise<ParentSummary>;
/** The injected core `runUnit`. */
export type RunUnitFn = (
  deps: { runRole: RoleRunner },
  config: RunUnitConfig,
) => Promise<RunUnitResult>;

/** Injected collaborators for the conductor routes. */
export interface ConductorRouteDeps {
  /** Shared per-target mutation lock (created once in `register.ts`). */
  lock: TargetLock;
  /** Core role runner; defaults to `conductors/core`'s `runRole`. */
  runRole?: RunRoleFn;
  /** Core unit runner; defaults to `conductors/core`'s `runUnit`. */
  runUnit?: RunUnitFn;
}

const ROLE_KINDS = [
  "generator",
  "evaluator",
  "reviewer",
  "contract-generator",
  "contract-evaluator",
] as const;

/**
 * The role kinds that WRITE (mutate the target) and therefore acquire the per-target lock. A
 * `generator` produces the implementation; a `contract-generator` model-drafts the contract file.
 * The critics — `evaluator`/`reviewer`/`contract-evaluator` — are read-only and never lock.
 */
const WRITER_KINDS = new Set<(typeof ROLE_KINDS)[number]>(["generator", "contract-generator"]);

const roleSchema = z
  .object({
    root: z.string().optional(),
    workspace: z.string().optional(),
    kind: z.enum(ROLE_KINDS),
    brief: z.string().optional(),
    briefPath: z.string().optional(),
    contractPath: z.string().optional(),
    holdoutPath: z.string().optional(),
    backend: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    worktree: z.string().optional(),
    unitWorktree: z.string().optional(),
    budget: z.number().optional(),
    maxTurns: z.number().optional(),
  })
  .strict()
  .refine((b) => b.root !== undefined || b.workspace !== undefined, {
    message: "one of `root` or `workspace` is required",
  });

const unitSchema = z
  .object({
    root: z.string().optional(),
    workspace: z.string().optional(),
    brief: z.string().optional(),
    briefPath: z.string().optional(),
    contractPath: z.string().optional(),
    holdoutPath: z.string().optional(),
    backend: z.string().optional(),
    generatorModel: z.string().optional(),
    evaluatorModel: z.string().optional(),
    effort: z.string().optional(),
    worktree: z.string().optional(),
    unitWorktree: z.string().optional(),
    budget: z.number().optional(),
    maxTurns: z.number().optional(),
    maxRounds: z.number().optional(),
    contractRounds: z.number().optional(),
    proceedIfNotAgreed: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.root !== undefined || b.workspace !== undefined, {
    message: "one of `root` or `workspace` is required",
  })
  // A /unit run ALWAYS negotiates a contract first, and the contract-evaluator (like every non-
  // `evaluator` role) requires a brief. Reject a request that supplies neither `briefPath` nor an
  // inline `brief` up front (→ 400) — before any job/lock/runUnit launch — rather than letting the
  // contract-evaluator argv fail the pre-model validation deep inside the unit.
  .refine((b) => b.briefPath !== undefined || b.brief !== undefined, {
    message: "one of `brief` or `briefPath` is required (the contract-evaluator needs a brief)",
  });

function invalidBody(): RouteResult {
  return { status: 400, body: { error: "invalid request body" } };
}

/** The holdout-safe `/unit` projection: built SOLELY from decision-relevant, already-redacted fields.
 *  Never carries raw `ContractRoundRecord`/`RoundRecord` contents, `resultText`, `traceDir`, a raw
 *  verdict dump, or holdout text. */
export interface UnitProjection {
  outcome: RunUnitResult["outcome"];
  contract: { agreed: boolean; rounds: number };
  cycle?: { outcome: string; rounds: number; finalVerdict?: ParentSummary };
}

/** Project a full `RunUnitResult` down to the holdout-safe {@link UnitProjection}. */
export function projectRunUnit(result: RunUnitResult): UnitProjection {
  const projection: UnitProjection = {
    outcome: result.outcome,
    contract: { agreed: result.contract.agreed, rounds: result.contract.rounds.length },
  };
  if (result.cycle) {
    projection.cycle = {
      outcome: result.cycle.outcome,
      rounds: result.cycle.rounds.length,
      // finalVerdict is itself a ParentSummary — already redacted by core. Nothing else crosses.
      ...(result.cycle.finalVerdict ? { finalVerdict: result.cycle.finalVerdict } : {}),
    };
  }
  return projection;
}

/** Build the `/role` RunRoleSpec, resolving EVERY path field through the guard before it is threaded
 *  into argv. Throws `PathGuardError` (→ 400/403) before the core runner is reached. Exported for the
 *  argv-acceptance seam test (`test/argvAcceptance.test.ts`), which feeds its emitted argv through the
 *  real CLI parser/validator. */
export function buildRoleSpec(
  b: z.infer<typeof roleSchema>,
  roots: string[],
): { spec: RunRoleSpec; target: string } {
  // Guard EVERY supplied target field INDEPENDENTLY: a request that smuggles an out-of-allowlist
  // `root` behind an in-allowlist `workspace` (or vice versa) must be rejected before the core runs —
  // resolving only `workspace ?? root` would leave the other field unchecked (the allowlist bypass).
  const resolvedRoot = b.root !== undefined ? resolveWithinAllowlist(b.root, roots) : undefined;
  const resolvedWorkspace =
    b.workspace !== undefined ? resolveWithinAllowlist(b.workspace, roots) : undefined;
  const target = (resolvedWorkspace ?? resolvedRoot)!;
  const args = ["role", "run", "--kind", b.kind];
  if (b.backend !== undefined) args.push("--backend", b.backend);
  if (b.model !== undefined) args.push("--model", b.model);
  if (b.effort !== undefined) args.push("--effort", b.effort);
  if (b.briefPath !== undefined) args.push("--brief", resolveWithinAllowlist(b.briefPath, roots));
  if (b.brief !== undefined) args.push("--brief-text", b.brief);
  if (b.contractPath !== undefined)
    args.push("--contract", resolveWithinAllowlist(b.contractPath, roots));
  // holdoutPath is forwarded as an ARG and NEVER opened here — the core runner reads it inside the
  // isolation boundary; it must never be read in-process.
  if (b.holdoutPath !== undefined)
    args.push("--holdout", resolveWithinAllowlist(b.holdoutPath, roots));
  if (b.worktree !== undefined) args.push("--worktree", resolveWithinAllowlist(b.worktree, roots));
  if (b.unitWorktree !== undefined)
    args.push("--unit-worktree", resolveWithinAllowlist(b.unitWorktree, roots));
  if (b.budget !== undefined) args.push("--budget", String(b.budget));
  if (b.maxTurns !== undefined) args.push("--max-turns", String(b.maxTurns));
  args.push("--json");
  return { spec: { args, cwd: target }, target };
}

/** Build the `/unit` RunUnitConfig, resolving every path field through the guard up front. The three
 *  specs it produces drive the core `runUnit`'s contract-evaluator → generator → evaluator roles.
 *  Exported for the argv-acceptance seam test (`test/argvAcceptance.test.ts`). */
export function buildUnitConfig(
  b: z.infer<typeof unitSchema>,
  roots: string[],
): { config: RunUnitConfig; target: string } {
  // Guard BOTH `root` and `workspace` independently (see buildRoleSpec) — resolving only one leaves
  // the other as an unchecked allowlist bypass.
  const resolvedRoot = b.root !== undefined ? resolveWithinAllowlist(b.root, roots) : undefined;
  const resolvedWorkspace =
    b.workspace !== undefined ? resolveWithinAllowlist(b.workspace, roots) : undefined;
  const target = (resolvedWorkspace ?? resolvedRoot)!;
  const contract = b.contractPath !== undefined ? resolveWithinAllowlist(b.contractPath, roots) : undefined;
  const brief = b.briefPath !== undefined ? resolveWithinAllowlist(b.briefPath, roots) : undefined;
  const holdout = b.holdoutPath !== undefined ? resolveWithinAllowlist(b.holdoutPath, roots) : undefined;
  const worktree = b.worktree !== undefined ? resolveWithinAllowlist(b.worktree, roots) : undefined;
  const unitWorktree =
    b.unitWorktree !== undefined ? resolveWithinAllowlist(b.unitWorktree, roots) : undefined;
  const backend = b.backend ?? "claude";
  const genModel = b.generatorModel ?? "sonnet";
  const evalModel = b.evaluatorModel ?? "opus";

  const config: RunUnitConfig = {
    contract: {
      contractEvaluatorSpec: (ctx: ContractRoundContext): RunRoleSpec => {
        const args = ["role", "run", "--kind", "contract-evaluator", "--backend", backend, "--model", evalModel];
        // The runner requires a brief for every kind except `evaluator`; a contract-evaluator argv
        // without a brief is rejected pre-model. Thread the request's brief — `--brief <path>` for a
        // briefPath, `--brief-text <s>` for an inline brief — so the emitted argv is accepted by the
        // real CLI parser/validator. The unitSchema refine guarantees at least one is present.
        if (brief !== undefined) args.push("--brief", brief);
        if (b.brief !== undefined) args.push("--brief-text", b.brief);
        if (contract !== undefined) args.push("--contract", contract);
        args.push("--json", ...ctx.priorCritiquePaths.flatMap((p) => ["--prior-critique", p]));
        return { args, cwd: target };
      },
      ...(b.contractRounds !== undefined ? { maxRounds: b.contractRounds } : {}),
    },
    generatorSpec: (): RunRoleSpec => {
      const args = ["role", "run", "--kind", "generator", "--backend", backend, "--model", genModel];
      if (brief !== undefined) args.push("--brief", brief);
      if (b.brief !== undefined) args.push("--brief-text", b.brief);
      if (contract !== undefined) args.push("--contract", contract);
      if (worktree !== undefined) args.push("--worktree", worktree);
      if (unitWorktree !== undefined) args.push("--unit-worktree", unitWorktree);
      if (b.budget !== undefined) args.push("--budget", String(b.budget));
      if (b.maxTurns !== undefined) args.push("--max-turns", String(b.maxTurns));
      args.push("--json");
      return { args, cwd: target };
    },
    evaluatorSpec: (): RunRoleSpec => {
      const args = ["role", "run", "--kind", "evaluator", "--backend", backend, "--model", evalModel];
      if (contract !== undefined) args.push("--contract", contract);
      // holdout is forwarded as an arg and read by the core runner INSIDE isolation — never here.
      if (holdout !== undefined) args.push("--holdout", holdout);
      args.push("--json");
      return { args, cwd: target };
    },
    ...(b.proceedIfNotAgreed ? { proceedIfNotAgreed: true } : {}),
  };
  if (b.maxRounds !== undefined) config.maxRounds = b.maxRounds;
  return { config, target };
}

/** A 409 result naming the current lock holder. */
function conflict(holder: string, target: string): RouteResult {
  return {
    status: 409,
    body: { error: `target busy: job ${holder} is already running for this target`, jobId: holder },
    jobId: holder,
    root: target,
  };
}

/** Build the conductor routes (`/role`, `/unit`). */
export function createConductorRoutes(deps: ConductorRouteDeps): RouteDefinition[] {
  // Lazily default to the real core runners so importing this module never forces a spawn.
  const getRunRole = async (): Promise<RunRoleFn> =>
    deps.runRole ?? (await import("../../core/index.ts")).runRole;
  const getRunUnit = async (): Promise<RunUnitFn> =>
    deps.runUnit ?? ((await import("../../core/index.ts")).runUnit as unknown as RunUnitFn);

  return [
    {
      method: "POST",
      path: "/role",
      handler: async (ctx: RouteContext): Promise<RouteResult> => {
        const parsed = roleSchema.safeParse(ctx.body);
        if (!parsed.success) return invalidBody();
        // Resolve paths FIRST — a bad path throws (→400/403) before any lock or core call.
        const { spec, target } = buildRoleSpec(parsed.data, ctx.config.roots);

        const isWriter = WRITER_KINDS.has(parsed.data.kind);
        if (isWriter) {
          const holder = deps.lock.holder(target);
          if (holder !== undefined) return conflict(holder, target);
        }

        const job = ctx.jobs.createJob({ kind: `role:${parsed.data.kind}`, root: target });
        if (isWriter) {
          deps.lock.tryAcquire(target, job.id);
          ctx.jobs.registerCancel(job.id, () => deps.lock.release(target));
        }

        const runRole = await getRunRole();
        try {
          // The summary is core's ParentSummary VERBATIM — we add no field of our own.
          const summary = await runRole(spec);
          job.result = summary;
          ctx.jobs.finish(job.id, { status: "succeeded" });
          return { status: 200, body: summary, jobId: job.id, root: target };
        } catch (err) {
          ctx.jobs.finish(job.id, { status: "failed" });
          throw err;
        } finally {
          if (isWriter) deps.lock.release(target);
        }
      },
    },
    {
      method: "POST",
      path: "/unit",
      handler: async (ctx: RouteContext): Promise<RouteResult> => {
        const parsed = unitSchema.safeParse(ctx.body);
        if (!parsed.success) return invalidBody();
        const { config, target } = buildUnitConfig(parsed.data, ctx.config.roots);

        // Every /unit call is a WRITER — acquire the per-target lock.
        const holder = deps.lock.holder(target);
        if (holder !== undefined) return conflict(holder, target);

        const job = ctx.jobs.createJob({ kind: "unit", root: target });
        deps.lock.tryAcquire(target, job.id);
        ctx.jobs.registerCancel(job.id, () => deps.lock.release(target));

        const runRole = await getRunRole();
        const runUnit = await getRunUnit();
        try {
          const result = await runUnit({ runRole }, config);
          const projection = projectRunUnit(result);
          job.result = projection;
          ctx.jobs.finish(job.id, { status: "succeeded" });
          return { status: 200, body: projection, jobId: job.id, root: target };
        } catch (err) {
          ctx.jobs.finish(job.id, { status: "failed" });
          throw err;
        } finally {
          deps.lock.release(target);
        }
      },
    },
  ];
}
