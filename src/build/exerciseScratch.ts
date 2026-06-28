/**
 * Shared, pure decision for whether the exercising evaluator gets writable scratch.
 *
 * The exercising evaluator (only) gets writable scratch so a Codex/CLI exercise can write
 * node_modules/.vite-temp/build artifacts during `npm test` — the source-integrity guard reverts
 * any artifact mutation afterwards. Scratch is granted ONLY when:
 *   - the role is the evaluator (never a writer/reviewer/contract role), AND
 *   - the exercise sandbox is `workspace-write`, AND
 *   - the run is on an isolated checkout — either a Sparra build branch (`state.build.branch`) OR a
 *     linked git worktree. The worktree case lets a standalone `sparra eval`/`run_role` on a
 *     worktree get scratch with no `state.json` edit.
 *
 * `isWorktree` may be a thunk so call sites can compute `isLinkedWorktree(...)` LAZILY — it's only
 * evaluated after the cheaper `evaluator && sandbox === "workspace-write" && !hasBranch` checks
 * pass, so a non-evaluator role-run never spawns git.
 */
export function exerciseScratchEnabled(args: {
  evaluator: boolean;
  sandbox: string;
  hasBranch: boolean;
  isWorktree: boolean | (() => boolean);
}): boolean {
  if (!(args.evaluator && args.sandbox === "workspace-write")) return false;
  if (args.hasBranch) return true;
  return typeof args.isWorktree === "function" ? args.isWorktree() : args.isWorktree;
}
