import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { Ctx } from "../context.ts";
import { warn, detail } from "../util/log.ts";
import { readTextSync } from "../util/io.ts";
import { probeAutoSupported } from "./capabilities.ts";
import { evaluatorHooks, mergeHooks, readOnlyHooks, scopedWriterHooks, singleFileHooks, type HookConfig, type RoleHookOpts } from "./hooks.ts";
import { makeFormatHook, type FormatOptions } from "./format.ts";

/**
 * Resolve the autonomous permissionMode per the user's policy:
 *   - prefer 'auto' (model-classifier) when available on the plan,
 *   - else 'acceptEdits',
 *   - NEVER 'bypassPermissions' (warn + fall back if configured),
 *   - 'plan' is honored as-is (read-only exploration).
 * In all cases a PreToolUse deny-hook (below) is the real scope/safety enforcement.
 */
export function autonomousPermissionMode(ctx: Ctx): PermissionMode {
  const mode = ctx.config.permission.mode;
  if (mode === "bypass") {
    warn("permission.mode 'bypass' is not allowed; using the safe fallback instead.");
    return ctx.store.data.autoSupported ? "auto" : "acceptEdits";
  }
  if (mode === "plan") return "plan";
  if (mode === "acceptEdits") return "acceptEdits";
  // 'auto' (default), and legacy 'safe-auto'/'default' → auto-if-available, else acceptEdits
  return ctx.store.data.autoSupported ? "auto" : "acceptEdits";
}

/**
 * Probe 'auto' availability once and cache it in state. No-op if already known or not needed.
 *
 * `probe` defaults to the real live SDK probe (`probeAutoSupported`); inject a fake in tests
 * to stay offline. `persist` defaults to `true` (write the result to `state.json` via
 * `store.save()` — the build phase relies on this caching); pass `persist: false` to set
 * `autoSupported` IN MEMORY only, so a synthesized greenfield store never litters `.sparra/`.
 */
export async function ensureAutoProbed(
  ctx: Ctx,
  opts: { probe?: (cwd: string) => Promise<boolean>; persist?: boolean } = {}
): Promise<void> {
  const wantsAuto = ["auto", "safe-auto", "default", "bypass"].includes(ctx.config.permission.mode);
  if (!wantsAuto) return;
  if (typeof ctx.store.data.autoSupported === "boolean") return;
  const probe = opts.probe ?? probeAutoSupported;
  const persist = opts.persist ?? true;
  detail("probing whether 'auto' permission mode is available on your plan…");
  const ok = await probe(ctx.root);
  ctx.store.data.autoSupported = ok;
  if (persist) await ctx.store.save();
  detail(ok ? "auto permission mode available → using it." : "auto not available → falling back to acceptEdits + deny-hook.");
}

export interface Guard {
  permissionMode: PermissionMode;
  hooks: HookConfig;
}

/** Resolve format-hook options from config + project mode + the codebase map. */
export function formatOptions(ctx: Ctx): FormatOptions {
  const f = ctx.config.format;
  const map = readTextSync(ctx.paths.frozenMap) ?? readTextSync(ctx.paths.codebaseMap);
  return { enabled: f.enabled, command: f.command, autodetect: f.autodetect, mode: ctx.store.data.mode, codebaseMap: map, workspaceRoot: ctx.root };
}

/** Writer scoped to writeRoots (generator, prototyper, reflector output dir).
 *  Pass `{ format: true }` to also run the PostToolUse formatter on written files.
 *  Pass `{ verify: true }` to let the generator auto-run its project's verification commands
 *  (`build.verifyCommands`) — ENABLED ONLY on a git worktree/branch boundary (the same wall that
 *  gates Codex full-access), so an in-place run never auto-approves Bash execution. */
export function scopedWriterGuard(
  ctx: Ctx,
  writeRoots: string[],
  opts: { format?: boolean; verify?: boolean } & RoleHookOpts = {}
): Guard {
  const verifyCommands = opts.verify && ctx.store.data.build.branch ? ctx.config.build.verifyCommands : [];
  let hooks = scopedWriterHooks(writeRoots, ctx.config.permission.denyBashContains, verifyCommands, {
    readScopes: opts.readScopes,
    extraDeny: opts.extraDeny,
  });
  if (opts.format) hooks = mergeHooks(hooks, makeFormatHook(formatOptions(ctx)));
  return { permissionMode: autonomousPermissionMode(ctx), hooks };
}

/** Writer permitted to touch a single file (planner-family, when run autonomously). */
export function singleFileGuard(ctx: Ctx, allowedFile: string): Guard {
  return { permissionMode: autonomousPermissionMode(ctx), hooks: singleFileHooks(allowedFile, ctx.config.permission.denyBashContains) };
}

/** Read-only roles (orient, decompose, contract negotiation). */
export function readOnlyGuard(ctx: Ctx, opts: RoleHookOpts = {}): Guard {
  return { permissionMode: autonomousPermissionMode(ctx), hooks: readOnlyHooks(ctx.config.permission.denyBashContains, opts) };
}

/** Evaluator: no source writes, but may exercise via Bash + exercise MCP. */
export function evaluatorGuard(ctx: Ctx, opts: RoleHookOpts = {}): Guard {
  return { permissionMode: autonomousPermissionMode(ctx), hooks: evaluatorHooks(ctx.config.permission.denyBashContains, opts) };
}
