import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /** Run only project test files; never walks into node_modules. */
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**"],
    environment: "node",
    /**
     * Headroom for the real-git / linked-worktree tests (git subprocess spawns: init, commit,
     * worktree add/remove). Under full-suite PARALLEL load these contend for CPU and can exceed
     * vitest's 5s default even though a standalone run finishes in well under a second — the timeout
     * guards against genuine hangs, not against slow-but-real work. Applied globally so no per-test
     * annotation is missed; a true regression still fails, just at 30s instead of 5s.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
