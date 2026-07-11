import { spawn } from "node:child_process";
import process from "node:process";

import type { RunRolePayload } from "../../src/roleEnvelope.ts";
import { type ParentSummary, toParentSummary } from "./summary.ts";

/** How to invoke one Sparra role via its CLI/JSON surface. */
export interface RunRoleSpec {
  /** Argv for the sparra CLI, e.g. `["role","run","--kind","evaluator","--json"]` or
   *  `["eval", dir, "--contract", c, "--json"]`. `--json` is appended if absent. */
  args: string[];
  /** The sparra binary. Defaults to `$SPARRA_BIN` or `"sparra"` (resolved on PATH). A path ending
   *  in `.mjs`/`.cjs`/`.js` is run with the current node; `.ts` via the local `tsx` — so a test can
   *  point at a stub without a shebang. */
  sparraBin?: string;
  cwd?: string;
  /** Extra env for the child (merged over `process.env`). */
  env?: NodeJS.ProcessEnv;
}

function resolveCommand(bin: string, args: string[]): { command: string; commandArgs: string[] } {
  if (/\.ts$/.test(bin)) {
    // Run a TypeScript entry the same way Sparra's own bins do.
    return { command: process.execPath, commandArgs: ["--import", "tsx", bin, ...args] };
  }
  if (/\.[cm]?js$/.test(bin)) {
    return { command: process.execPath, commandArgs: [bin, ...args] };
  }
  return { command: bin, commandArgs: args };
}

/** Parse the canonical envelope from a `--json` run's stdout. sparra emits one payload on stdout
 *  (human logs go to stderr); we parse the whole buffer, falling back to the last JSON-shaped line
 *  so a stray leading line can't defeat us. */
function parsePayload(stdout: string, bin: string): RunRolePayload {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as RunRolePayload;
  } catch {
    const lines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line && line.startsWith("{") && line.endsWith("}")) {
        try {
          return JSON.parse(line) as RunRolePayload;
        } catch {
          /* keep scanning older lines */
        }
      }
    }
    throw new Error(`sparra "${bin}" did not print a parseable JSON envelope on stdout`);
  }
}

/**
 * Spawn one Sparra role via the CLI/JSON surface and return the FULL canonical envelope.
 *
 * The child's stdout/stderr are consumed entirely inside this function; stderr is used only to build
 * an error on failure and is never returned. Prefer {@link runRole} unless you genuinely need the
 * holdout-bearing payload (see {@link runRoleRaw}).
 */
function spawnRole(spec: RunRoleSpec): Promise<RunRolePayload> {
  const bin = spec.sparraBin ?? process.env.SPARRA_BIN ?? "sparra";
  const args = spec.args.includes("--json") ? spec.args : [...spec.args, "--json"];
  const { command, commandArgs } = resolveCommand(bin, args);

  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: spec.cwd,
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => reject(new Error(`failed to spawn sparra "${bin}": ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`sparra "${bin}" exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
        return;
      }
      try {
        resolve(parsePayload(stdout, bin));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

/**
 * Run one Sparra role and return ONLY the parent-safe {@link ParentSummary}. This is the
 * holdout-safe default a conductor should use: the raw envelope (with any holdout-bearing field) is
 * parsed and dropped inside this call — it never reaches the caller.
 */
export async function runRole(spec: RunRoleSpec): Promise<ParentSummary> {
  return toParentSummary(await spawnRole(spec));
}

/**
 * Escape hatch that returns BOTH the full `payload` and the redacted `summary`. Named "Raw" because
 * `payload` may carry holdout-bearing fields — only use it in code that stays inside the isolation
 * boundary (e.g. {@link ./roleWorker.ts}, or runner-side persistence) and never forwards `payload`
 * into a parent conductor's context.
 */
export async function runRoleRaw(
  spec: RunRoleSpec,
): Promise<{ payload: RunRolePayload; summary: ParentSummary }> {
  const payload = await spawnRole(spec);
  return { payload, summary: toParentSummary(payload) };
}
