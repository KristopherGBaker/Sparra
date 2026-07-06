import { Writable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadCtxForRole, type Ctx } from "../context.ts";
import { runRole, type RoleKind, type RoleRunRequest, type RoleRunResult } from "../build/roleRun.ts";
import { removeUnitWorktree } from "../build/unitWorktree.ts";
import { promptDrift, summarizePromptDrift } from "../prompts.ts";

/** Holdout-safe prompt-drift note for the MCP payload: role names + the one-line note ONLY (never a
 *  prompt body, never holdout). `null` when there's nothing actionable to surface. */
export interface PromptDriftNote {
  stale: string[];
  conflict: string[];
  note: string;
}

/** The `run_role` tool's argument shape (mirrors the zod schema below). */
export interface RunRoleToolArgs {
  roleKind: RoleKind;
  brief?: string;
  briefPath?: string;
  contractPath?: string;
  priorCritiquePaths?: string[];
  workspace?: string;
  holdoutPath?: string;
  backend?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  out?: string;
  maxBudgetUsd?: number;
  allowVerify?: boolean;
  worktree?: boolean;
  keepWorktree?: boolean;
  unitWorktree?: string;
  expectedHead?: string;
  evalBaseRef?: string;
  resumeSessionId?: string;
  resumeBackend?: string;
}

/**
 * Map the MCP tool args onto a `runRole` request. Pure + exported so the forwarding is
 * unit-testable — the `worktree`→`useWorktree` mapping is the one that, when it was silently
 * dropped, made every `run_role` evaluator exercise run IN-PLACE read-only and false-block on
 * scratch writes (EPERM on node_modules/.vite-temp), so it stays covered by a test.
 */
export function toRunRoleRequest(ctx: Ctx, args: RunRoleToolArgs): RoleRunRequest {
  return {
    ctx,
    roleKind: args.roleKind,
    brief: args.brief,
    briefPath: args.briefPath,
    contractPath: args.contractPath,
    priorCritiquePaths: args.priorCritiquePaths,
    workspace: args.workspace,
    holdoutPath: args.holdoutPath,
    backend: args.backend,
    model: args.model,
    effort: args.effort,
    out: args.out,
    maxBudgetUsd: args.maxBudgetUsd,
    allowVerify: args.allowVerify,
    useWorktree: args.worktree,
    keepWorktree: args.keepWorktree,
    unitWorktree: args.unitWorktree,
    expectedHead: args.expectedHead,
    evalBaseRef: args.evalBaseRef,
    resumeSessionId: args.resumeSessionId,
    resumeBackend: args.resumeBackend,
  };
}

/**
 * Shape the holdout-safe MCP payload from a role result. Pure + exported so the wall-critical
 * split is unit-testable: the EVALUATOR branch (has a verdict) returns the parsed verdict and
 * **omits `traceDir`** (its trace is holdout-bearing); every other role returns its result text
 * plus `traceDir` (holdout-free by scope) so the conductor can tail it for live progress. Neither
 * branch ever carries holdout contents.
 */
export function buildRunRolePayload(
  r: RoleRunResult,
  passThreshold: number,
  drift?: PromptDriftNote | null
): Record<string, unknown> {
  // Only surface the drift note when there's something actionable (a newer default / conflict) —
  // don't add noise to every call. Role names + the note line only; never a body, never holdout.
  const driftField = drift ? { promptDrift: drift } : {};
  return r.verdict
    ? {
        ...driftField,
        roleKind: r.roleKind,
        backend: r.backend,
        model: r.model,
        sessionId: r.sessionId,
        ok: r.ok,
        verdict: r.verdict.verdict,
        weightedTotal: r.verdict.weightedTotal,
        passThreshold,
        blocking: r.verdict.blocking,
        failedAssertions: r.verdict.assertions.filter((a) => !a.pass),
        // The auto-persisted redacted verdict (always written for the evaluator) — surfaced so the
        // conductor/reflect can find it. Distinct from the caller-chosen `outPath`. Holdout-safe:
        // a PATH under .sparra/verdicts/, never verdict/holdout contents.
        verdictPath: r.verdictPath,
        outPath: r.outPath,
        tokens: r.tokens,
        costUsd: r.costUsd,
        limitHit: r.limitHit, // present → provider limit/unavailability: retry/fall back, NOT a real fail
        hitMaxTurns: r.hitMaxTurns, // present → hit the turn cap unfinished: RESUME the session, NOT a fail
        hitBudget: r.hitBudget, // present → stopped on OUR budget cap: RESUME via sessionId, NOT a fail
      }
    : {
        ...driftField,
        roleKind: r.roleKind,
        backend: r.backend,
        model: r.model,
        sessionId: r.sessionId,
        ok: r.ok,
        result: r.resultText,
        // Holdout-free for these roles (holdout is dropped from their scope) — the conductor
        // may tail `<traceDir>/NN-*.md` for live progress. NOT included in the evaluator
        // (verdict) branch above, whose trace is holdout-bearing.
        traceDir: r.traceDir,
        outPath: r.outPath,
        tokens: r.tokens,
        costUsd: r.costUsd,
        limitHit: r.limitHit, // present → provider limit/unavailability: retry/fall back, NOT a real fail
        hitMaxTurns: r.hitMaxTurns, // present → hit the turn cap unfinished: RESUME the session, NOT a fail
        noProgress: r.noProgress, // writer changed no files → blocked reads/brief, NOT a behavioral fail
        emptyCompletion: r.emptyCompletion, // writer's report failed to emit but files changed → work LANDED: resume/accept, NOT a fail
        filesChanged: r.filesChanged, // writer telemetry: newly-changed path count (>0 → work landed)
        hitBudget: r.hitBudget, // present → stopped on OUR budget cap: RESUME via sessionId, NOT a fail
        unitWorktree: r.unitWorktree, // persistent per-unit writer tree {name,dir,branch,created} — reuse next round / tear down on accept
      };
}

/**
 * The MCP `run_role` server — the *interactive* surface of the role-runner for a
 * Claude Code session. The conductor calls `run_role` instead of shelling out, so
 * the holdout boundary is enforced server-side: the conductor passes a holdout
 * PATH, never contents, and the server returns only normalized artifacts — for the
 * evaluator, the parsed VERDICT (never the raw evaluator output, which could quote
 * holdout). It works config-less (no `sparra init` needed) — a missing `.sparra/`
 * yields a default-backed context; an existing `.sparra/` config (per-role backends,
 * rubric) is honored unchanged.
 *
 * Wire it into Claude Code as an MCP server pointed at your project root, e.g.:
 *   { "mcpServers": { "sparra-run": { "command": "node",
 *       "args": ["<sparra>/bin/sparra-run-mcp.mjs", "--root", "<project>"] } } }
 */

const RUN_ROLE_DESC =
  "Run ONE Sparra role once on a chosen backend (claude/codex/…), with the holdout wall enforced " +
  "server-side. Roles: generator (writes), evaluator (grades + exercises, read-only), " +
  "contract-generator/contract-evaluator (negotiate 'done', read-only), reviewer (code review, read-only). " +
  "Pass the holdout by PATH only — its contents are never returned, and only the evaluator ever sees them. " +
  "For the evaluator the result is the normalized verdict; the conductor reads verdicts, not holdout.";

export async function startRunRoleServer(root: string): Promise<void> {
  // Keep stdout pristine for the JSON-RPC protocol: give the transport the REAL
  // stdout and redirect everything else (Sparra's console logs) to stderr.
  const realWrite = process.stdout.write.bind(process.stdout);
  const protocolOut = new Writable({
    write(chunk, encoding, callback) {
      return realWrite(chunk as Buffer | string, encoding as BufferEncoding, callback) as unknown as void;
    },
  });
  process.stdout.write = ((chunk: unknown, enc?: unknown, cb?: unknown) =>
    (process.stderr.write as (...a: unknown[]) => boolean)(chunk, enc, cb)) as typeof process.stdout.write;

  const server = new McpServer({ name: "sparra-run", version: "0.1.0" });

  server.tool(
    "run_role",
    RUN_ROLE_DESC,
    {
      roleKind: z.enum(["generator", "contract-generator", "contract-evaluator", "evaluator", "reviewer"]),
      brief: z.string().optional().describe("Task brief (inline). Provide this or briefPath."),
      briefPath: z.string().optional().describe("Path to a task-brief file."),
      contractPath: z.string().optional().describe("Path to the agreed contract."),
      priorCritiquePaths: z
        .array(z.string())
        .optional()
        .describe(
          "contract-evaluator re-critique ONLY: paths to this contract's prior-round critiques, in round order (Round 1 first). The runner reads them itself and inlines them (labeled by round, prefixed with the RE-CRITIQUE instruction) ahead of the contract — so a fresh evaluator grades the DELTA, not from scratch. Paths under .sparra/ work (the runner's read isn't subject to the role's readscope). A missing path fails the run; supplying it to another role is an error."
        ),
      workspace: z.string().optional().describe("Working dir / artifact dir (default: project root)."),
      holdoutPath: z.string().optional().describe("Holdout file PATH (evaluator-only). Contents are never returned."),
      backend: z.string().optional().describe("Backend override: claude | codex | … (default: the role's config)."),
      model: z.string().optional().describe("Model override."),
      effort: z
        .enum(["low", "medium", "high", "xhigh", "max"])
        .optional()
        .describe("Reasoning-effort override (default: the role's config). Raise (e.g. xhigh) for a tougher adversarial pass."),
      out: z.string().optional().describe("Where to write the verdict/result on disk."),
      maxBudgetUsd: z
        .number()
        .optional()
        .describe("Per-call USD budget override for THIS run; overrides build.maxBudgetUsdPerItem. 0 = unlimited. Omit to use the config default."),
      allowVerify: z
        .boolean()
        .optional()
        .describe("Generator-only: let an in-place run (no build.branch) auto-run the project's build.verifyCommands (typecheck/test/build) via the same strict allow-hook, so self-verify gates don't hit the permission wall. No-op for read-only roles."),
      worktree: z
        .boolean()
        .optional()
        .describe("Read-only judge roles (evaluator/reviewer/contract-evaluator): run in a TEMPORARY linked git worktree snapshotted from `workspace`'s WIP (torn down after). Gives the exercise/verify probe WRITABLE scratch + provisioned deps so `npm test`/build tools run — an in-place eval stays read-only and false-blocks on scratch writes (EPERM on node_modules/.vite-temp etc.). Use whenever the evaluator (or a contract-evaluator proving verify commands) will exercise the tree."),
      keepWorktree: z
        .boolean()
        .optional()
        .describe("With `worktree`: retain the temp worktree after the run (its path is printed) instead of tearing it down."),
      unitWorktree: z
        .string()
        .optional()
        .describe(
          "GENERATOR only: run in a PERSISTENT, NAMED per-unit git worktree (created on first use on a `sparra/<name>` branch, deps provisioned, reused across this unit's rounds so the generator's WIP survives round→round). Distinct from `worktree` (the judges' throwaway snapshot) and mutually exclusive with it. The returned `unitWorktree` {name,dir,branch} tells you where the WIP lives — reuse it next round with the SAME name; tear it down with `remove_unit_worktree` on accept/abandon. Lets parallel generators run iff distinct names/workspaces."
        ),
      expectedHead: z
        .string()
        .optional()
        .describe("Judge roles only (evaluator/reviewer/contract-evaluator): the commit SHA the brief cites as the artifact to grade. VERIFIED before launch against the source checkout's HEAD (worktree run) or the workspace HEAD (in place); a mismatch aborts naming both SHAs, so a judge never grades the wrong tree. A match injects a provenance header."),
      evalBaseRef: z
        .string()
        .optional()
        .describe("Judge roles only: a base ref that scopes the changed-files judgment to THIS unit (`<base>..HEAD` + the source tree's current WIP), so a worktree snapshot bundling another unit's uncommitted WIP doesn't fail scope/deviation assertions on foreign files. An unresolvable ref aborts pre-launch."),
      resumeSessionId: z
        .string()
        .optional()
        .describe("Resume a prior run's session (e.g. iterating the generator) — pass the `sessionId` from a previous run_role result so it doesn't re-read the workspace from scratch."),
      resumeBackend: z
        .string()
        .optional()
        .describe("The `backend` of that prior session. Resume is ignored (fresh session) if it differs from this call's backend — session ids aren't portable across backends."),
    },
    async (args) => {
      try {
        const ctx = await loadCtxForRole(root);
        const r = await runRole(toRunRoleRequest(ctx, args));
        // Surface a newer-default (`stale`) / conflicting prompt to the /sparra-loop conductor, so
        // a fresh loop learns an adoptable default exists. Holdout-safe: role names + the note line
        // ONLY (never a prompt body, never holdout), and only when actionable.
        const summary = summarizePromptDrift(await promptDrift(ctx.paths));
        const drift: PromptDriftNote | null =
          summary.actionable && summary.line ? { stale: summary.stale, conflict: summary.conflict, note: summary.line } : null;
        // Never return holdout: evaluator → verdict summary only; others → result text. The
        // holdout-safe field split (incl. evaluator omitting `traceDir`) lives in buildRunRolePayload.
        const payload = buildRunRolePayload(r, ctx.config.rubric.passThreshold, drift);
        return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
      } catch (e) {
        // Holdout-leak and other failures surface as a (sanitized) tool error.
        return { content: [{ type: "text" as const, text: `run_role failed: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    "remove_unit_worktree",
    "Tear down a PERSISTENT per-unit generator worktree created via run_role's `unitWorktree` (on accept/abandon). " +
      "By DEFAULT refuses a dirty tree (uncommitted WIP) and an unmerged branch — pass `force: true` to override each. " +
      "An unknown name lists the known ones. Removes the worktree, deletes its `sparra/<name>` branch, and drops the registry entry.",
    {
      name: z.string().describe("The unitWorktree name to dispose of."),
      force: z.boolean().optional().describe("Override the dirty-tree and unmerged-branch refusals (force-remove + `branch -D`)."),
    },
    async (args) => {
      try {
        const ctx = await loadCtxForRole(root);
        const r = await removeUnitWorktree(ctx, args.name, { force: args.force });
        return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }], isError: !r.ok };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `remove_unit_worktree failed: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  await server.connect(new StdioServerTransport(process.stdin, protocolOut));
}

/** CLI entry: `node bin/sparra-run-mcp.mjs [--root <dir>]`. */
function rootFromArgv(): string {
  const i = process.argv.indexOf("--root");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : process.cwd();
}

// Auto-start only when run as the entry point (the bin execs this file via tsx); stay importable
// so buildRunRolePayload can be unit-tested without launching the stdio server.
const isEntry = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  startRunRoleServer(rootFromArgv()).catch((e) => {
    process.stderr.write(`sparra-run MCP server failed: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
