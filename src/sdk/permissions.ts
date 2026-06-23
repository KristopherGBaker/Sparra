import type { CanUseTool, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionPreset } from "../config.ts";
import { denyBashMutation, denyWriteNotFile } from "./scoping.ts";

/**
 * Map a Sparra permission preset to a base SDK permissionMode. Used by the
 * interactive planner family (which runs with a human present). The autonomous
 * roles use src/sdk/guard.ts instead, which prefers 'auto' and enforces scope via
 * PreToolUse deny-hooks. We never map anything to bypassPermissions.
 */
export function resolvePermissionMode(preset: PermissionPreset): PermissionMode {
  switch (preset) {
    case "plan":
      return "plan";
    case "acceptEdits":
      return "acceptEdits";
    case "bypass": // never honored
    case "auto":
    case "safe-auto":
    case "default":
    default:
      return "default";
  }
}

/**
 * Allow reads/exploration freely, but permit writes ONLY to a single file
 * (e.g. PLAN.md). Used by the interactive planner and the no-question planner
 * sub-runs (log-finding, reconcile) in 'default' mode, where canUseTool is the gate.
 */
export function plannerWriteScope(allowedFile: string, denyBashContains: string[]): CanUseTool {
  return async (toolName, input) => {
    const reason =
      denyWriteNotFile(toolName, input, allowedFile) ?? denyBashMutation(toolName, input, denyBashContains);
    if (reason) return { behavior: "deny", message: reason };
    return { behavior: "allow", updatedInput: input };
  };
}
