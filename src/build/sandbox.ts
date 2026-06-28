import { warn } from "../util/log.ts";
import type { RoleConfig } from "../config.ts";

/** A write role's requested native-sandbox scope (the `roles.<role>.sandbox` knob). */
export type SandboxIntent = NonNullable<RoleConfig["sandbox"]>;

/**
 * Safety gate for the native-sandbox knob, applied at the request-construction layer — the
 * only place that can see whether the build runs on a git worktree/branch boundary
 * (`ctx.store.data.build.branch`). The Codex backend runs `hooks:false` +
 * `approvalPolicy:"never"`, so that worktree IS the only boundary; the gate therefore can't
 * live in the backend.
 *
 * "danger-full-access" lifts the OS sandbox, so it is honored ONLY when a branch is set. On an
 * in-place / greenfield-no-git run (no branch) it is downgraded to "workspace-write" with a
 * LOUD warning — never silently granted. "workspace-write" (and unset) pass through unchanged,
 * so the default path is provably identical to today.
 */
export function gateSandbox(args: {
  requested?: SandboxIntent;
  /** Whether the build is on a git worktree/branch boundary (`ctx.store.data.build.branch`). */
  hasBranch: boolean;
  /** Role label for the warning (e.g. "generator-item-001"). */
  roleLabel: string;
}): SandboxIntent | undefined {
  const { requested, hasBranch, roleLabel } = args;
  if (requested === "danger-full-access" && !hasBranch) {
    warn(
      `Refusing 'danger-full-access' sandbox for ${roleLabel}: this build has no git worktree/branch boundary ` +
        `(in-place or greenfield-no-git run), which is the only safety boundary for full access. ` +
        `Downgrading to 'workspace-write'. Build on a worktree/branch (git.strategy: worktree) to enable it.`
    );
    return "workspace-write";
  }
  return requested;
}
