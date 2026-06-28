import type { HookCallbackMatcher, HookEvent, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  allowVerifyBash,
  denyAmbientMcp,
  denyAnyWrite,
  denyBash,
  denyBashMutation,
  denyWriteNotFile,
  denyWriteOutsideRoots,
  firstDeny,
} from "./scoping.ts";

type Decider = (toolName: string, input: any) => string | null;
export type HookConfig = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

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
export function scopedWriterHooks(writeRoots: string[], denyBashContains: string[], verifyCommands: string[] = []): HookConfig {
  const deny: Decider[] = [
    (t) => denyAmbientMcp(t),
    (t, i) => denyWriteOutsideRoots(t, i, writeRoots),
    (t, i) => denyBash(t, i, denyBashContains),
  ];
  const allow: Decider[] = verifyCommands.length ? [(t, i) => allowVerifyBash(t, i, verifyCommands, denyBashContains)] : [];
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

/** Read-only: blocks every write and any Bash mutation. */
export function readOnlyHooks(denyBashContains: string[]): HookConfig {
  return makeDenyHook([(t) => denyAmbientMcp(t), (t) => denyAnyWrite(t), (t, i) => denyBashMutation(t, i, denyBashContains)]);
}

/** Evaluator: blocks source writes, but allows Bash to exercise the artifact (minus dangerous patterns). */
export function evaluatorHooks(denyBashContains: string[]): HookConfig {
  return makeDenyHook([
    (t) => denyAmbientMcp(t),
    (t) => (denyAnyWrite(t) ? `Evaluator does not edit source (${t} blocked). Exercise via Bash / the exercise tools.` : null),
    (t, i) => denyBash(t, i, denyBashContains),
  ]);
}
