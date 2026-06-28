import { Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadCtxForRole } from "../context.ts";
import { runRole, type RoleKind } from "../build/roleRun.ts";

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
      workspace: z.string().optional().describe("Working dir / artifact dir (default: project root)."),
      holdoutPath: z.string().optional().describe("Holdout file PATH (evaluator-only). Contents are never returned."),
      backend: z.string().optional().describe("Backend override: claude | codex | … (default: the role's config)."),
      model: z.string().optional().describe("Model override."),
      out: z.string().optional().describe("Where to write the verdict/result on disk."),
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
        const r = await runRole({
          ctx,
          roleKind: args.roleKind as RoleKind,
          brief: args.brief,
          briefPath: args.briefPath,
          contractPath: args.contractPath,
          workspace: args.workspace,
          holdoutPath: args.holdoutPath,
          backend: args.backend,
          model: args.model,
          out: args.out,
          resumeSessionId: args.resumeSessionId,
          resumeBackend: args.resumeBackend,
        });
        // Never return holdout: evaluator → verdict summary only; others → result text.
        const payload = r.verdict
          ? {
              roleKind: r.roleKind,
              backend: r.backend,
              model: r.model,
              sessionId: r.sessionId,
              ok: r.ok,
              verdict: r.verdict.verdict,
              weightedTotal: r.verdict.weightedTotal,
              passThreshold: ctx.config.rubric.passThreshold,
              blocking: r.verdict.blocking,
              failedAssertions: r.verdict.assertions.filter((a) => !a.pass),
              outPath: r.outPath,
              tokens: r.tokens,
              costUsd: r.costUsd,
              limitHit: r.limitHit, // present → provider limit/unavailability: retry/fall back, NOT a real fail
            }
          : {
              roleKind: r.roleKind,
              backend: r.backend,
              model: r.model,
              sessionId: r.sessionId,
              ok: r.ok,
              result: r.resultText,
              outPath: r.outPath,
              tokens: r.tokens,
              costUsd: r.costUsd,
              limitHit: r.limitHit, // present → provider limit/unavailability: retry/fall back, NOT a real fail
              noProgress: r.noProgress, // writer changed no files → blocked reads/brief, NOT a behavioral fail
            };
        return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
      } catch (e) {
        // Holdout-leak and other failures surface as a (sanitized) tool error.
        return { content: [{ type: "text" as const, text: `run_role failed: ${(e as Error).message}` }], isError: true };
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

startRunRoleServer(rootFromArgv()).catch((e) => {
  process.stderr.write(`sparra-run MCP server failed: ${(e as Error).message}\n`);
  process.exit(1);
});
