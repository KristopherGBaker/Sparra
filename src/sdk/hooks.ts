import type { HookCallbackMatcher, HookEvent, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  allowReadInScope,
  allowVerifyBash,
  denyAmbientMcp,
  denyAnyWrite,
  denyBash,
  denyBashMutation,
  denyDisableSandbox,
  denyTreeMutatingGit,
  denyWriteNotFile,
  denyWriteOutsideRoots,
  firstDeny,
} from "./scoping.ts";

type Decider = (toolName: string, input: any) => string | null;
export type HookConfig = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

/** One tool call this guard refused, as the runner sees it. Paths/tool names only — never content. */
export interface GuardDenial {
  tool: string;
  /** The path/pattern/command the call named, truncated. "" when the input carried none. */
  target: string;
  /** The deny message the role was given. */
  reason: string;
}

/** Shared read-scope/extra-deny knobs every role-hook accepts. `readScopes` AUTO-APPROVES
 *  in-scope Read/Glob/Grep so a role can always read its workspace; `extraDeny` lets the runner
 *  compose more deny-deciders (e.g. the holdout-read block) into the SAME hook, so deny still
 *  wins over the read allow. `onDeny` observes every refusal this guard makes, so the runner can
 *  report a role that was starved of an input instead of leaving the conductor to infer it from
 *  prose three rounds later (see `RoleRunResult.degraded`). */
export interface RoleHookOpts {
  readScopes?: string[];
  extraDeny?: Decider[];
  onDeny?: (denial: GuardDenial) => void;
}

/** The field of a tool input that names what the call targets (first match wins). */
const TARGET_FIELDS = ["file_path", "path", "pattern", "glob", "command", "url"] as const;
/** Extract the target a refused call named, for the denial record. Never returns tool CONTENT. */
export function denialTarget(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  for (const f of TARGET_FIELDS) if (typeof i[f] === "string" && i[f]) return String(i[f]).slice(0, 300);
  return "";
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
export function makeGuardHook(
  denyDeciders: Decider[],
  allowDeciders: Decider[],
  onDeny?: (denial: GuardDenial) => void
): HookConfig {
  return {
    PreToolUse: [
      {
        // no matcher → applies to all tools; we inspect tool_name ourselves
        hooks: [
          async (input) => {
            const pre = input as PreToolUseHookInput;
            const deny = firstDeny(pre.tool_name, pre.tool_input as any, denyDeciders);
            if (deny) {
              onDeny?.({ tool: pre.tool_name, target: denialTarget(pre.tool_input), reason: deny });
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
  const { readScopes = [], extraDeny = [], onDeny } = opts;
  const deny: Decider[] = [
    (t) => denyAmbientMcp(t),
    (t, i) => denyDisableSandbox(t, i),
    (t, i) => denyWriteOutsideRoots(t, i, writeRoots),
    (t, i) => denyBash(t, i, denyBashContains),
    ...extraDeny, // e.g. the holdout-read block — checked BEFORE the read allow below, so deny wins
  ];
  const allow: Decider[] = [];
  if (readScopes.length) allow.push((t, i) => allowReadInScope(t, i, readScopes));
  if (verifyCommands.length) allow.push((t, i) => allowVerifyBash(t, i, verifyCommands, denyBashContains));
  return makeGuardHook(deny, allow, onDeny);
}

/** Writer permitted to touch only one file (e.g. PLAN.md); blocks Bash mutation. */
export function singleFileHooks(allowedFile: string, denyBashContains: string[]): HookConfig {
  return makeDenyHook([
    (t) => denyAmbientMcp(t),
    (t, i) => denyDisableSandbox(t, i),
    (t, i) => denyWriteNotFile(t, i, allowedFile),
    (t, i) => denyBashMutation(t, i, denyBashContains),
  ]);
}

/** Read-only: blocks every write and any Bash mutation. Auto-approves in-scope reads when
 *  `readScopes` is given, so a read-only role can always read its workspace. When `verifyCommands`
 *  is non-empty, also AUTO-APPROVES those narrowly-allowlisted verification commands (the shared
 *  `allowVerifyBash` grammar) — the caller gates this to an isolated worktree boundary; empty (the
 *  default) is behaviorally identical to the original read-only-only hook. */
export function readOnlyHooks(denyBashContains: string[], verifyCommands: string[] = [], opts: RoleHookOpts = {}): HookConfig {
  const { readScopes = [], extraDeny = [], onDeny } = opts;
  const deny: Decider[] = [(t) => denyAmbientMcp(t), (t, i) => denyDisableSandbox(t, i), (t) => denyAnyWrite(t), (t, i) => denyBashMutation(t, i, denyBashContains), ...extraDeny];
  const allow: Decider[] = [];
  if (readScopes.length) allow.push((t, i) => allowReadInScope(t, i, readScopes));
  if (verifyCommands.length) allow.push((t, i) => allowVerifyBash(t, i, verifyCommands, denyBashContains));
  return makeGuardHook(deny, allow, onDeny);
}

/** Read-only contract judge with narrowly allowlisted verification Bash. A thin named alias over
 *  {@link readOnlyHooks} with `verifyCommands` threaded through — ONE deny chain, no drift risk
 *  between the two (an empty `verifyCommands` list makes this byte-identical to `readOnlyHooks`).
 *  Callers must gate `verifyCommands` to an isolated worktree boundary. */
export function contractEvaluatorHooks(denyBashContains: string[], verifyCommands: string[], opts: RoleHookOpts = {}): HookConfig {
  return readOnlyHooks(denyBashContains, verifyCommands, opts);
}

/** Evaluator: blocks source writes, but allows Bash to exercise the artifact (minus dangerous patterns).
 *  Auto-approves in-scope reads when `readScopes` is given so it can always read the artifact. */
export function evaluatorHooks(denyBashContains: string[], opts: RoleHookOpts = {}): HookConfig {
  const { readScopes = [], extraDeny = [], onDeny } = opts;
  const deny: Decider[] = [
    (t) => denyAmbientMcp(t),
    (t, i) => denyDisableSandbox(t, i),
    (t) => (denyAnyWrite(t) ? `Evaluator does not edit source (${t} blocked). Exercise via Bash / the exercise tools.` : null),
    (t, i) => denyBash(t, i, denyBashContains),
    // Best-effort raw-Bash residual (like denyBash): deny tree-mutating git so the read-only evaluator
    // can't clobber the worktree it grades. Non-mutating git (status/diff/ls-files/log) stays allowed.
    (t, i) => denyTreeMutatingGit(t, i),
    ...extraDeny,
  ];
  const allow: Decider[] = readScopes.length ? [(t, i) => allowReadInScope(t, i, readScopes)] : [];
  return makeGuardHook(deny, allow, onDeny);
}
