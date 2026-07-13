import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
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
        },
      },
    ],
  },
});
