import os from "node:os";
import { defineConfig } from "vitest/config";

/**
 * Reliability profile for NON-INTERACTIVE runs — CI and the Sparra evaluator snapshot both pipe
 * output, so `process.stdout.isTTY` is false there. Those runs surfaced a TRAILING
 * `Timeout calling "onTaskUpdate"`: the vitest worker→main reporter RPC (child_process IPC with a
 * HARDCODED 60s birpc timeout — not configurable via vitest config) is not serviced at run end, so
 * the process exits NONZERO with ALL files accounted for and NO whole-file abort (the documented
 * whole-file-abort carve-out therefore does not apply).
 *
 * Root cause on a provisioned throwaway worktree: `os.availableParallelism()`/`os.cpus()` OVER-report
 * cores (they ignore the container's cgroup CPU quota), so a `cores−1` fork count OVERSUBSCRIBES the
 * few EFFECTIVE CPUs, starves the main/reporter process, and the final `onTaskUpdate` flush races
 * teardown past 60s. Two prior fork tweaks that trusted the reported core count did not help.
 *
 * Fix, biased to RELIABILITY over speed on the gate, attacking the RPC-flush window itself:
 *   - cap forks at a small ABSOLUTE number (the reported core count is untrustworthy) so the
 *     main process always keeps a CPU to service the reporter RPC;
 *   - a LEAN `dot` reporter — the default reporter's per-file/per-task chatter keeps the main event
 *     loop busy and widens the flush window; `dot` keeps it free so the final flush is serviced;
 *   - generous `teardownTimeout` so a slow final flush/teardown completes instead of being cut off.
 * INTERACTIVE (TTY) dev runs keep the fast prior defaults (cores−1 forks, default reporter) — human
 * DX is unchanged; only the non-interactive gate profile is made conservative.
 */
const interactive = !!process.stdout.isTTY && !process.env.CI;
const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
const MAX_FORKS = interactive ? Math.max(1, cores - 1) : Math.min(2, Math.max(1, cores - 1));
const TEARDOWN_TIMEOUT = 60_000;
const NON_INTERACTIVE_REPORTERS = ["dot"] as const;

export default defineConfig({
  test: {
    environment: "node",
    // Lean reporter on CI/eval (non-TTY) so the main event loop stays free to service the trailing
    // reporter RPC flush; interactive dev keeps the default reporter. Reporters are a run-global
    // option (configured at root), applied across both projects below.
    ...(interactive ? {} : { reporters: [...NON_INTERACTIVE_REPORTERS] }),
    // POOL SIZING IS A RUN-GLOBAL (root) CONCERN — vitest sizes ONE shared tinypool for the whole
    // run from the ROOT `test` config; a `poolOptions.forks.maxForks` nested under a `projects[]`
    // entry is NOT honored for pool size (proved live: a per-project cap left wall-time identical to
    // the uncapped run). Set it here at the root so the cap actually takes effect. See the file-level
    // note for WHY the CI/eval profile caps forks to a small absolute number.
    pool: "forks",
    poolOptions: { forks: { maxForks: MAX_FORKS, minForks: 1 } },
    teardownTimeout: TEARDOWN_TIMEOUT,
    /**
     * `projects` (vitest.dev/guide/projects) is a `test`-scoped option, not a sibling of `test` —
     * placing it outside `test` is silently ignored by Vite/Vitest (it only reads `config.test.*`),
     * which is why an earlier attempt at this split had no effect at all. Vitest's own scheduler
     * (`createPool` in vitest's dist) groups every project's files by `sequence.groupOrder` and
     * runs each group with `for (const group of sortedGroups) { await Promise.all(...) }` — i.e. it
     * fully drains group 0 (`await`s every project in that group) before group 1 is even dispatched.
     * That is a real, structural barrier (verified by instrumenting both projects with start/end
     * timestamps: the real-git project's first test starts only after every group-0 file's teardown
     * has completed).
     *
     * Root-level test options (testTimeout/hookTimeout/environment) do NOT inherit into `projects`
     * entries — each resolves independently and silently falls back to vitest's defaults (5s/10s)
     * if not repeated per project. That gap was reproduced live: under two concurrent `npm test`
     * runs, a subprocess-heavy test in the "unit" project timed out at the 5s default instead of
     * getting headroom. So testTimeout/hookTimeout are set explicitly in BOTH projects below, not
     * just at this (non-inherited) root level.
     */
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts", "conductors/**/*.test.ts"],
          exclude: ["test/unitWorktree.test.ts", "test/conductMerge.test.ts", "node_modules/**"],
          environment: "node",
          sequence: { groupOrder: 0 },
          // Headroom for the many subprocess-spawning tests in this project (git, execFileSync,
          // etc.) under full-suite parallel load; NOT inherited from the root `test` block above.
          testTimeout: 30_000,
          hookTimeout: 30_000,
          teardownTimeout: TEARDOWN_TIMEOUT,
        },
      },
      {
        test: {
          name: "real-git",
          include: ["test/unitWorktree.test.ts", "test/conductMerge.test.ts"],
          environment: "node",
          // Group 1 is not dispatched until group 0 fully drains (see comment above), so real git
          // worktree removal never contends with the parallel unit files for CPU. Kept single-file
          // (there's only one real-git file) with its own bounded per-test timeout to still catch a
          // genuinely hung subprocess — this is isolation, not a retry or a raised global timeout.
          sequence: { groupOrder: 1 },
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
          teardownTimeout: TEARDOWN_TIMEOUT,
        },
      },
    ],
  },
});
