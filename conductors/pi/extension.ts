import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { runSparraRoleForTool } from "./roleRunner.ts";
import { registerSparraLoopCommand } from "./loopCommand.ts";

/**
 * The real Pi extension entrypoint. Registers the `sparra_role` tool, which runs one Sparra role
 * (contract-generator / generator / evaluator / etc.) via `conductors/pi/roleRunner.ts` and hands
 * back ONLY the holdout-redacted summary — never a raw evaluator transcript or `HOLDOUT.md`
 * content. Also registers the `/sparra-loop` command (see `conductors/pi/loopCommand.ts`), which
 * drives the full generate → cross-model evaluate → decide cycle over `conductors/core/loop.ts`.
 *
 * This file is the only place in `conductors/pi` that imports `@earendil-works/pi-coding-agent` and
 * `typebox` at the top level; it is Pi's own entrypoint (loaded by the `pi` process itself), never
 * imported by a test. See `conductors/pi/roleRunner.ts` and `conductors/pi/loopCommand.ts` for the
 * Pi-free logic this wraps.
 */

const SparraRoleParams = Type.Object({
  args: Type.Array(Type.String(), {
    description:
      'Argv for the sparra CLI, e.g. ["role","run","--kind","evaluator"] or ["eval", ".", "--contract", "contract.md"].',
  }),
  roleKind: Type.Optional(
    Type.String({ description: "Optional label for the role being run (documentation only)." }),
  ),
  sparraBin: Type.Optional(
    Type.String({ description: 'The sparra binary to invoke. Defaults to "sparra" on PATH.' }),
  ),
  holdoutPath: Type.Optional(
    Type.String({
      description:
        "Path to a holdout file. Only the path is forwarded to sparra as --holdout <path>; " +
        "this tool never reads the file's contents.",
    }),
  ),
});

// Passed directly into `defineTool` (rather than through an intermediate annotated variable) so
// TypeScript's contextual typing infers `execute`'s `params` from `parameters: SparraRoleParams`
// itself — the pattern `defineTool`'s own doc comment recommends to avoid widening.
const sparraRoleTool = defineTool({
  name: "sparra_role",
  label: "Sparra role",
  description:
    "Run one Sparra role (contract-generator / generator / evaluator / reviewer / etc.) via the " +
    "sparra CLI, in an isolated process. Returns ONLY the holdout-redacted parent-safe summary " +
    "(verdict, weightedTotal, passThreshold, blocking count, verdictPath, flags) — the raw role " +
    "transcript, holdout contents, and evaluator trace directory are never returned to the caller.",
  parameters: SparraRoleParams,
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const out = await runSparraRoleForTool(params);
    return {
      content: [{ type: "text" as const, text: out.text }],
      details: { summary: out.summary },
    };
  },
});

/** Register the `sparra_role` tool and the `/sparra-loop` command on the given Pi extension host. */
export default function sparraConductorExtension(pi: ExtensionAPI): void {
  pi.registerTool(sparraRoleTool);
  registerSparraLoopCommand(pi);
}
