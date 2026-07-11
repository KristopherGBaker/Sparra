import process from "node:process";

import { runRole } from "./roleClient.ts";

/**
 * The process-boundary isolation primitive.
 *
 * A MODEL-driven conductor host (a Pi agent session, an opencode subagent) shells out to this entry
 * so the raw role envelope never enters the PARENT process at all — only this process ever parses
 * it, and only the redacted summary crosses its stdout. (A PROGRAM conductor that calls
 * {@link ./roleClient.ts}'s `runRole` in-process is also safe, since the raw payload is dropped
 * before return; this worker is the extra, host-neutral boundary for the model-driven case.)
 *
 * Usage: `tsx conductors/core/roleWorker.ts -- <sparra args>`
 *   e.g. `... -- eval . --contract c.md --backend claude --model sonnet`
 * `SPARRA_BIN` selects the sparra binary (default `sparra` on PATH); a stub for tests.
 */
export async function roleWorkerMain(argv: string[]): Promise<string> {
  // Accept an optional `--` separator so a leading `--` is never forwarded to the role binary.
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const summary = await runRole({ args });
  return JSON.stringify(summary);
}

// Only auto-run when invoked directly, not when imported (e.g. by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  roleWorkerMain(process.argv.slice(2))
    .then((json) => {
      // The ONLY thing this process writes to stdout — the parent parses exactly this.
      process.stdout.write(json + "\n");
    })
    .catch((err: unknown) => {
      // Errors go to stderr; stdout stays reserved for the summary JSON.
      process.stderr.write(`roleWorker error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
