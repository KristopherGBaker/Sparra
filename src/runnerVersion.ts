import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The identity of the Sparra CODE answering a request — not the project it is working on.
 *
 * The `sparra-run` MCP server is a long-lived stdio subprocess: it imports `src/**` once, at launch,
 * and `tsx` does not hot-reload. So a guard/prompt/loop fix landed on disk does NOT reach a server
 * that was already running, and nothing in the envelope said which code produced it. Field cost: two
 * `degraded` contract-generator runs whose denials a holdout fix had already addressed, and no way to
 * tell whether the run had the fix — "confirm whether the fix covers this, AND whether the server
 * needs a restart" was unanswerable from the artifacts.
 *
 * Stamped into the `run_role` envelope so staleness is a fact you can read rather than a hypothesis:
 * compare it against `git -C <sparra> rev-parse --short HEAD` and restart the server if they differ.
 */

/** Sparra's own package root (where this file's package.json lives) — NOT the graded project. */
function packageRoot(): string {
  // src/runnerVersion.ts → <pkg>/src → <pkg>
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** Pure: the stamp for a version + optional commit. `0.1.0+20b5c9f`, or just `0.1.0`. */
export function formatRunnerVersion(version: string, commit?: string | null): string {
  return commit ? `${version}+${commit}` : version;
}

let cached: string | undefined;

/**
 * `<package version>+<short HEAD>` for the running code, computed once per process (the answer
 * cannot change without a restart, which is the whole point). Best-effort throughout: a missing
 * package.json yields `unknown`, and a non-git install simply omits the commit.
 */
export function runnerVersion(): string {
  if (cached !== undefined) return cached;
  const root = packageRoot();
  let version = "unknown";
  try {
    version = (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version as string) || "unknown";
  } catch {
    // not installed from a readable package — the commit below is still worth having
  }
  let commit: string | null = null;
  try {
    commit = execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // installed from a tarball / no git — version alone
  }
  cached = formatRunnerVersion(version, commit || null);
  return cached;
}
