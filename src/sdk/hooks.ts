import type { HookCallbackMatcher, HookEvent, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  allowReadInScope,
  allowVerifyBash,
  denyAmbientMcp,
  denyAnyWrite,
  denyBash,
  denyBashMutation,
  denyTreeMutatingGit,
  denyWriteNotFile,
  denyWriteOutsideRoots,
  firstDeny,
} from "./scoping.ts";

type Decider = (toolName: string, input: any) => string | null;
export type HookConfig = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

/** Shared read-scope/extra-deny knobs every role-hook accepts. `readScopes` AUTO-APPROVES
 *  in-scope Read/Glob/Grep so a role can always read its workspace; `extraDeny` lets the runner
 *  compose more deny-deciders (e.g. the holdout-read block) into the SAME hook, so deny still
 *  wins over the read allow. */
export interface RoleHookOpts {
  readScopes?: string[];
  extraDeny?: Decider[];
}

/**
 * Build a PreToolUse deny-hook from a set of deciders. PreToolUse hooks run
 * BEFORE the permission classifier/execution in EVERY permissionMode (default,
 * acceptEdits, auto, even bypass), and a 'deny' decision short-circuits the tool.
 * This is our authoritative scope/safety enforcement, independent of mode.
 */
export function makeDenyHook(deciders: Decider[]): HookConfig {
  return makeGuardHook(deciders, []);
}

/**
 * Like {@link makeDenyHook} but also supports ALLOW-deciders: deny wins first (authoritative
 * scope/safety), then a non-null allow-reason AUTO-APPROVES the tool (bypassing the permission
 * mode), else defer to the permission mode. Used to auto-approve a tightly-constrained set of
 * generator self-verification commands without opening Bash generally. The `allow` path echoes
 * `updatedInput` (unchanged) per the SDK's permission-allow contract.
 */
export function makeGuardHook(denyDeciders: Decider[], allowDeciders: Decider[]): HookConfig {
  return {
    PreToolUse: [
      {
        // no matcher → applies to all tools; we inspect tool_name ourselves
        hooks: [
          async (input) => {
            const pre = input as PreToolUseHookInput;
            const deny = firstDeny(pre.tool_name, pre.tool_input as any, denyDeciders);
            if (deny) {
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: deny,
                },
              };
            }
            const allow = firstDeny(pre.tool_name, pre.tool_input as any, allowDeciders);
            if (allow) {
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "allow",
                  permissionDecisionReason: allow,
                  updatedInput: (pre.tool_input ?? {}) as Record<string, unknown>,
                },
              };
            }
            return {}; // defer to the permissionMode for everything else
          },
        ],
      },
    ],
  };
}

/** Merge several hook configs, concatenating the matcher arrays per event. */
export function mergeHooks(...configs: HookConfig[]): HookConfig {
  const out: HookConfig = {};
  for (const cfg of configs) {
    for (const ev of Object.keys(cfg) as HookEvent[]) {
      const matchers = cfg[ev];
      if (!matchers) continue;
      (out[ev] ??= []).push(...matchers);
    }
  }
  return out;
}

/** Writer scoped to writeRoots; blocks out-of-scope writes and dangerous Bash. When
 *  `verifyCommands` is non-empty, also AUTO-APPROVES those self-contained verification commands
 *  (typecheck/test/build) so the generator can verify its own work — the caller gates this to a
 *  worktree/branch boundary. */
export function scopedWriterHooks(
  writeRoots: string[],
  denyBashContains: string[],
  verifyCommands: string[] = [],
  opts: RoleHookOpts = {}
): HookConfig {
  const { readScopes = [], extraDeny = [] } = opts;
  const deny: Decider[] = [
    (t) => denyAmbientMcp(t),
    (t, i) => denyWriteOutsideRoots(t, i, writeRoots),
    (t, i) => denyBash(t, i, denyBashContains),
    ...extraDeny, // e.g. the holdout-read block — checked BEFORE the read allow below, so deny wins
  ];
  const allow: Decider[] = [];
  if (readScopes.length) allow.push((t, i) => allowReadInScope(t, i, readScopes));
  if (verifyCommands.length) allow.push((t, i) => allowVerifyBash(t, i, verifyCommands, denyBashContains));
  return makeGuardHook(deny, allow);
}

/** Writer permitted to touch only one file (e.g. PLAN.md); blocks Bash mutation. */
export function singleFileHooks(allowedFile: string, denyBashContains: string[]): HookConfig {
  return makeDenyHook([
    (t) => denyAmbientMcp(t),
    (t, i) => denyWriteNotFile(t, i, allowedFile),
    (t, i) => denyBashMutation(t, i, denyBashContains),
  ]);
}

/** Read-only: blocks every write and any Bash mutation. Auto-approves in-scope reads when
 *  `readScopes` is given, so a read-only role can always read its workspace. */
export function readOnlyHooks(denyBashContains: string[], opts: RoleHookOpts = {}): HookConfig {
  const { readScopes = [], extraDeny = [] } = opts;
  const deny: Decider[] = [(t) => denyAmbientMcp(t), (t) => denyAnyWrite(t), (t, i) => denyBashMutation(t, i, denyBashContains), ...extraDeny];
  const allow: Decider[] = readScopes.length ? [(t, i) => allowReadInScope(t, i, readScopes)] : [];
  return makeGuardHook(deny, allow);
}

/** Evaluator: blocks source writes, but allows Bash to exercise the artifact (minus dangerous patterns).
 *  Auto-approves in-scope reads when `readScopes` is given so it can always read the artifact. */
export function evaluatorHooks(denyBashContains: string[], opts: RoleHookOpts = {}): HookConfig {
  const { readScopes = [], extraDeny = [] } = opts;
  const deny: Decider[] = [
    (t) => denyAmbientMcp(t),
    (t) => (denyAnyWrite(t) ? `Evaluator does not edit source (${t} blocked). Exercise via Bash / the exercise tools.` : null),
    (t, i) => denyBash(t, i, denyBashContains),
    // Best-effort raw-Bash residual (like denyBash): deny tree-mutating git so the read-only evaluator
    // can't clobber the worktree it grades. Non-mutating git (status/diff/ls-files/log) stays allowed.
    (t, i) => denyTreeMutatingGit(t, i),
    ...extraDeny,
  ];
  const allow: Decider[] = readScopes.length ? [(t, i) => allowReadInScope(t, i, readScopes)] : [];
  return makeGuardHook(deny, allow);
}
