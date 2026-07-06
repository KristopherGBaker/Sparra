import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SparraConfig } from "../config.ts";
import { stringProcessEnv } from "./env.ts";

/**
 * Default WRITABLE-SCRATCH env layer for the SANDBOXED JUDGE role-runs (the evaluator AND the
 * contract-evaluator).
 *
 * A read-only Codex sandbox / an unwritable `$HOME` breaks otherwise-innocent tooling BEFORE any
 * Sparra code runs, so a "prove this verify command runs" probe EPERMs at startup and the gate is
 * unobservable:
 *   - the tsx launcher derives its IPC pipe from `os.tmpdir()` (installed tsx 4.x:
 *     `dist/temporary-directory-*.cjs` → `join(os.tmpdir(), 'tsx-<uid>')`, then
 *     `dist/get-pipe-path-*.cjs` → `join(tmpdir, '<pid>.pipe')`), so `node bin/sparra.mjs` dies on
 *     `EPERM` creating the socket;
 *   - Vitest writes `/var/folders/**` temp files and dies at collection;
 *   - clang writes its module cache under `~/.cache/clang/ModuleCache` (unwritable → Swift builds
 *     force a hand-modified `--disable-sandbox` reproduction).
 *
 * Redirecting the temp + cache roots into a per-run writable scratch dir fixes all of these WITHOUT
 * widening the sandbox's write scope over the artifact source (the source-integrity guard still
 * reverts any write to the tracked surface). This layer is DEFAULT — it applies unconditionally to
 * the judge role-runs, independent of the exercise-scratch / workspace-write gating.
 */

/** The cache/temp env keys the layer redirects (stable order; consumed by the layer + tests). */
export const JUDGE_SCRATCH_ENV_KEYS = ["TMPDIR", "CLANG_MODULE_CACHE_PATH", "SWIFTPM_CACHE_DIR"] as const;

/** Sub-directory (under the per-run scratch root) each redirected key points at. */
const SUBDIRS: Record<(typeof JUDGE_SCRATCH_ENV_KEYS)[number], string> = {
  TMPDIR: "tmp", // node/tsx/Vitest temp + IPC sockets
  CLANG_MODULE_CACHE_PATH: "clang-module-cache", // clang honors this; overrides ~/.cache/clang/ModuleCache
  SWIFTPM_CACHE_DIR: "swiftpm", // SwiftPM cache root (best-effort; user build.env can override)
};

/** Pure: the default env-layer values for a scratch root (no fs). Each points UNDER `scratchDir`. */
export function judgeScratchEnvLayer(scratchDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of JUDGE_SCRATCH_ENV_KEYS) out[key] = path.join(scratchDir, SUBDIRS[key]);
  return out;
}

/**
 * Merge the default scratch layer into the build env with the documented precedence:
 *   process.env (base) < scratch defaults < user `build.env` (wins).
 * So a user override of TMPDIR/CLANG_MODULE_CACHE_PATH/SWIFTPM_CACHE_DIR beats the default, every
 * unrelated `process.env` value is preserved, and (unlike `mergedBuildEnv`) the result is ALWAYS a
 * map — the scratch keys must reach the SDK even when `build.env` is empty.
 */
export function judgeSandboxEnv(
  config: SparraConfig,
  scratchDir: string,
  src: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const buildEnv = config.build.env ?? {};
  return { ...stringProcessEnv(src), ...judgeScratchEnvLayer(scratchDir), ...buildEnv };
}

/**
 * Create a fresh per-run scratch root (and each redirected sub-dir) on disk, returning its path.
 * Kept SHORT (`sprj-<8hex>`): tsx builds its Unix-domain IPC socket UNDER `TMPDIR`, and socket paths
 * cap at ~104 chars — a long name here would re-break the very thing the redirect fixes.
 */
export function createJudgeScratch(baseDir: string = os.tmpdir()): string {
  const dir = path.join(baseDir, `sprj-${randomUUID().slice(0, 8)}`);
  for (const key of JUDGE_SCRATCH_ENV_KEYS) fs.mkdirSync(path.join(dir, SUBDIRS[key]), { recursive: true });
  return dir;
}
