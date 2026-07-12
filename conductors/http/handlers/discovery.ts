/**
 * `conductors/http/handlers/discovery.ts` — OPT-IN recursive Sparra-project discovery for
 * `GET /projects` (see `phases.ts`).
 *
 * When `config.discoverProjects` is on, `phases.ts` calls {@link discoverAllProjects} instead of
 * reporting one bare entry per allowlisted root. It walks each root up to `config.discoverDepth`
 * (root itself = depth `0`) and reports every directory that contains a `.sparra/` as its own
 * project, stopping the walk once a project is found (a `.sparra/` nested below an already-found
 * project is not a second entry).
 *
 * Safety is structural, not a bolt-on check: `readdirSync(dir, {withFileTypes:true})` classifies
 * entries via `lstat` semantics, so a symlink's `isDirectory()` is `false` regardless of what it
 * points to. This module therefore NEVER recurses into a symlinked entry and NEVER treats a
 * symlinked `.sparra` as a project marker — which defeats both symlink CYCLES (an ancestor loop can
 * never be traversed, since a symlink is simply skipped) and symlink ESCAPES (a link pointing outside
 * the allowlisted root is skipped before it is ever realpath'd). Every path this module ever visits
 * is reached via a chain of plain, non-symlink directory joins starting from the allowlisted root's
 * OWN realpath, so every reported `root` is guaranteed to remain genuinely under it.
 *
 * The walk is iterative (an explicit stack, not recursion) so a deep/wide fixture can't blow the call
 * stack, and is bounded by {@link MAX_DISCOVERED_PROJECTS} across the whole request.
 */

import { readdirSync, realpathSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";

import type { BridgeConfig } from "../config.ts";
import type { ProjectStatus } from "./phases.ts";

/** Directory names never descended into — keeps a big tree walk fast and skips noise that would
 *  otherwise dominate results (dependency trees, VCS internals, build output). `.sparra` itself is
 *  deliberately NOT in this list — that's the marker we're looking FOR. */
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  ".next",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "DerivedData",
]);

/** Hard cap on discovered projects across the WHOLE request (all allowlisted roots combined) — a
 *  pathological tree can never produce unbounded output. */
export const MAX_DISCOVERED_PROJECTS = 500;

/** One discovered project, pre-status-read. */
interface StackEntry {
  dir: string;
  depth: number;
}

/** Read `dir`'s entries; any failure (ENOENT, EACCES, …) is treated as "no children, no project"
 *  rather than aborting the whole walk. */
function safeReaddir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Walk ONE allowlisted root (already realpath'd) up to `maxDepth` levels below it, returning the
 * absolute path of every discovered project directory — capped at `remainingCap` entries.
 */
function walkRoot(realRoot: string, maxDepth: number, remainingCap: number): string[] {
  const found: string[] = [];
  const stack: StackEntry[] = [{ dir: realRoot, depth: 0 }];

  while (stack.length > 0 && found.length < remainingCap) {
    const entry = stack.pop();
    if (entry === undefined) break;
    const { dir, depth } = entry;
    const entries = safeReaddir(dir);

    const isProject = entries.some((e) => e.name === ".sparra" && e.isDirectory());
    if (isProject) {
      found.push(dir);
      continue; // stop descending below a found project
    }

    if (depth >= maxDepth) continue; // depth-bounded: never look deeper than configured

    for (const e of entries) {
      // `isDirectory()` reflects the entry's OWN type (lstat-based), so a symlink is `false` here
      // even when it points at a real directory — it is silently excluded, never recursed into.
      if (!e.isDirectory()) continue;
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      stack.push({ dir: join(dir, e.name), depth: depth + 1 });
    }
  }

  return found;
}

/** Injected collaborators for discovery (mirrors `PhaseRouteDeps.statusSource`). */
export interface DiscoveryDeps {
  /** Read-only status source; same shape/contract as `PhaseRouteDeps.statusSource`. */
  statusSource: (root: string, config: BridgeConfig) => ProjectStatus;
}

/**
 * Recursively discover every Sparra project under `config.roots`, bounded by
 * `config.discoverDepth` (default `3`) and {@link MAX_DISCOVERED_PROJECTS}. Deterministic: results
 * are sorted by `root`. Each allowlisted root is realpath'd ONCE up front (trusted operator config,
 * mirroring `resolveWithinAllowlist`'s treatment of `roots`) — every path visited after that is a
 * plain, verified-non-symlink directory join, so containment holds by construction.
 */
export function discoverAllProjects(
  config: BridgeConfig,
  deps: DiscoveryDeps,
): Array<{ root: string; phase: string; next: string }> {
  const maxDepth = config.discoverDepth ?? 3;
  const discovered: string[] = [];

  for (const root of config.roots) {
    if (discovered.length >= MAX_DISCOVERED_PROJECTS) break;
    let realRoot: string;
    try {
      realRoot = realpathSync(resolve(root));
    } catch {
      continue; // a configured root that doesn't currently exist yields no projects, not a crash
    }
    const remaining = MAX_DISCOVERED_PROJECTS - discovered.length;
    discovered.push(...walkRoot(realRoot, maxDepth, remaining));
  }

  const sorted = discovered.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted.map((root) => {
    const status = deps.statusSource(root, config);
    return { root, phase: status.phase, next: status.next };
  });
}
