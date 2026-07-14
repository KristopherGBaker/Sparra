import { describe, it } from "vitest";

/**
 * SINGLE SOURCE OF TRUTH for the `SPARRA_JUDGE_SANDBOX` judge-env skip flag.
 *
 * The adversarial evaluator/judge runs the suite inside a Codex-style OS sandbox that denies
 * `listen(2)` on a Unix-domain socket as POLICY (see `src/build/judgeScratch.ts`). Every suite that
 * spawns the REAL CLI / a `--import tsx` subprocess needs that socket (tsx's IPC pipe, the bridge
 * bind), so under the judge those suites EPERM through no fault of the artifact — the full suite then
 * exits nonzero on the same fixed set every round and the evaluator reports "mixed" forever.
 *
 * When the evaluator/judge session env sets `SPARRA_JUDGE_SANDBOX=1` (wired in `src/build/*` — never
 * on the generator's self-verify), those socket-dependent suites vitest-SKIP *visibly* (counted as
 * pending, never silently filtered), so the full suite is EXPECTED green and a nonzero full-suite exit
 * is a REAL artifact signal again. Flag ABSENT (CI, local, generator self-verify) → byte-identical
 * behavior: the suites run normally.
 *
 * Every affected suite consumes THIS module — no per-file `process.env` reads that can drift.
 */

/** The env variable name — one literal, so a mutation that neuters it trips the pin test. */
export const JUDGE_SANDBOX_ENV = "SPARRA_JUDGE_SANDBOX";

/** True when the evaluator/judge sandbox flag is set (read fresh so callers/tests can inject env). */
export function isJudgeSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[JUDGE_SANDBOX_ENV] === "1";
}

/**
 * `describe` for a suite (or a describe block) whose tests spawn the real bin / a tsx subprocess:
 * skips VISIBLY under the flag, runs normally otherwise. Use for a WHOLE fully-skipped suite, or for
 * just the real-bin describe block(s) inside a mixed suite (its injected/faked blocks keep running).
 */
export const describeRealBin = (isJudgeSandbox() ? describe.skip : describe) as typeof describe;

/**
 * `it` for a single real-bin/tsx-subprocess test inside a MIXED describe block (the surrounding
 * injected tests keep running). Skips VISIBLY under the flag, runs normally otherwise.
 */
export const itRealBin = (isJudgeSandbox() ? it.skip : it) as typeof it;
