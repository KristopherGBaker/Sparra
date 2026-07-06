/**
 * Shared, pure decision for whether an exercising JUDGE (the evaluator OR the contract-evaluator)
 * gets writable workspace scratch.
 *
 * A judge gets writable scratch so a Codex/CLI exercise or verify PROBE can write
 * node_modules/.vite-temp/build artifacts during `npm test` — the source-integrity guard reverts
 * any artifact mutation afterwards. Scratch is granted ONLY when:
 *   - the role is a judge — the evaluator or the contract-evaluator (never a writer/reviewer/
 *     contract-generator role), AND
 *   - the exercise sandbox is `workspace-write`, AND
 *   - the run is on an isolated checkout — either a Sparra build branch (`state.build.branch`) OR a
 *     linked git worktree. The worktree case lets a standalone `sparra eval`/`run_role` on a
 *     worktree get scratch with no `state.json` edit.
 *
 * `isWorktree` may be a thunk so call sites can compute `isLinkedWorktree(...)` LAZILY — it's only
 * evaluated after the cheaper `judge && sandbox === "workspace-write" && !hasBranch` checks pass,
 * so a non-judge role-run never spawns git.
 */
export function exerciseScratchEnabled(args: {
  judge: boolean;
  sandbox: string;
  hasBranch: boolean;
  isWorktree: boolean | (() => boolean);
}): boolean {
  if (!(args.judge && args.sandbox === "workspace-write")) return false;
  if (args.hasBranch) return true;
  return typeof args.isWorktree === "function" ? args.isWorktree() : args.isWorktree;
}
