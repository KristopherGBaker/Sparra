/**
 * Shared, pure decision for the sandbox an exercising JUDGE (the evaluator OR the contract-evaluator)
 * runs its EXERCISE under — the single truth table behind both `exerciseScratch` (writable scratch)
 * and the full-access carve-out.
 *
 * A judge is `readOnly` intent, so its sandbox is `read-only` UNLESS it needs to actually RUN the
 * artifact. It is relaxed ONLY when:
 *   - the role is a judge — the evaluator or the contract-evaluator (never a writer/reviewer/
 *     contract-generator role), AND
 *   - `exercise.sandbox` requests a writable mode (`workspace-write` or `danger-full-access`), AND
 *   - the run is on an isolated checkout — either a Sparra build branch (`state.build.branch`) OR a
 *     linked git worktree. The worktree case lets a standalone `sparra eval`/`run_role` on a
 *     worktree get scratch with no `state.json` edit.
 *
 * The relaxed mode is the one requested:
 *   - `workspace-write` — the default. Test/build tools can write scratch (node_modules/.vite-temp,
 *     tsc/test caches) and network is forced off.
 *   - `danger-full-access` — opt-in, for exercises the Seatbelt profile blocks OUTRIGHT rather than
 *     merely failing to write: an iOS/macOS gate needs CoreSimulatorService XPC (and `xcodebuild`
 *     needs both that and writes), which no amount of writable scratch enables. The OS sandbox is
 *     lifted entirely, so — unlike `workspace-write` — network cannot be withheld from the judge.
 *     The isolated checkout is then the ONLY boundary, which is why it is gated identically.
 *
 * In every relaxed mode the runner arms the source-integrity guard, which reverts (and FAILS on) any
 * write the judge makes to the artifact surface — so a relaxed judge still cannot mutate the code it
 * grades.
 *
 * `isWorktree` may be a thunk so call sites can compute `isLinkedWorktree(...)` LAZILY — it's only
 * evaluated after the cheaper `judge && <writable mode> && !hasBranch` checks pass, so a non-judge
 * role-run never spawns git.
 */

/** The effective sandbox for a judge's exercise (mirrors Codex's `ThreadOptions.sandboxMode`). */
export type ExerciseSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface ExerciseSandboxArgs {
  judge: boolean;
  sandbox: string;
  hasBranch: boolean;
  isWorktree: boolean | (() => boolean);
}

/** The effective exercise sandbox. `read-only` whenever any gate above fails. */
export function exerciseSandboxMode(args: ExerciseSandboxArgs): ExerciseSandboxMode {
  const requested =
    args.sandbox === "workspace-write" || args.sandbox === "danger-full-access" ? args.sandbox : null;
  if (!args.judge || requested === null) return "read-only";
  // `hasBranch` first so the lazy worktree probe is skipped when a branch already proves isolation.
  const isolated = args.hasBranch || (typeof args.isWorktree === "function" ? args.isWorktree() : args.isWorktree);
  return isolated ? requested : "read-only";
}

/** Whether the judge gets writable scratch — true for EVERY relaxed mode (both writable modes can
 *  write, so both need the scratch env layer AND the source-integrity guard armed). */
export function exerciseScratchEnabled(args: ExerciseSandboxArgs): boolean {
  return exerciseSandboxMode(args) !== "read-only";
}

/**
 * Warning for an OS-sandboxed judge (Codex) about to exercise a Swift/Xcode project without full
 * access. Its `read-only`/`workspace-write` sandbox refuses CoreSimulator XPC, SwiftPM's own nested
 * sandbox, and SwiftLint/clang cache writes outside the workspace, so the build/test gates come back
 * UN-RUN instead of graded — across past runs 83% of such verdicts had un-run gates, against 3% under
 * `danger-full-access`. Returns `undefined` when the judge has no OS sandbox (Claude), already has full
 * access, isn't on a Swift/Xcode project (`apple`, or `exercise.mechanism: ios`), or when the
 * full-access request was just refused (`fullAccessRefusalWarning` already explains that case).
 */
export function appleSandboxWarning(args: {
  hasOsSandbox: boolean;
  mode: ExerciseSandboxMode;
  apple: boolean;
  mechanism: string;
  refused: boolean;
  roleLabel: string;
}): string | undefined {
  if (!args.hasOsSandbox || args.mode === "danger-full-access" || args.refused) return undefined;
  if (!args.apple && args.mechanism !== "ios") return undefined;
  return (
    `${args.roleLabel} will exercise a Swift/Xcode project under the '${args.mode}' OS sandbox, which ` +
    `refuses xcodebuild/CoreSimulator, SwiftPM's own sandbox, and SwiftLint/clang cache writes — expect ` +
    `its build and test gates to come back UN-RUN instead of graded. Set exercise.sandbox: ` +
    `danger-full-access (honored only on a git worktree or Sparra build branch; the integrity guard ` +
    `still reverts artifact writes, but network is not withheld).`
  );
}

/**
 * Loud-refusal text for an `exercise.sandbox: danger-full-access` that the boundary gate DENIED —
 * the exercise mirror of `gateSandbox`'s warning for write roles. Full access is an explicit opt-in
 * taken to make a specific gate runnable (an iOS build), so silently handing back a read-only judge
 * would present an UN-RUN gate as a graded one. Returns `undefined` whenever nothing was refused —
 * the default `workspace-write` falling back to read-only on an in-place run is the documented
 * everyday path and stays silent.
 */
export function fullAccessRefusalWarning(args: {
  requested: string;
  mode: ExerciseSandboxMode;
  roleLabel: string;
}): string | undefined {
  if (args.requested !== "danger-full-access" || args.mode !== "read-only") return undefined;
  return (
    `Refusing 'danger-full-access' exercise sandbox for ${args.roleLabel}: this run has no isolated ` +
    `checkout (no Sparra build branch and not a linked git worktree), which is the only safety ` +
    `boundary for full access. The exercise runs READ-ONLY, so a gate that needs writes or ` +
    `CoreSimulatorService XPC (e.g. an iOS build) will be UN-RUN, not graded. Build on a ` +
    `worktree/branch (git.strategy: worktree) to enable it.`
  );
}
