import path from "node:path";

/** Tools that write to the filesystem. */
export const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function filePathOf(input: any): string | undefined {
  return (input?.file_path ?? input?.path ?? input?.notebook_path) as string | undefined;
}

/**
 * Pure decision helpers shared by both the PreToolUse deny-hooks and the
 * canUseTool callbacks. Each returns a deny-reason string, or null to allow.
 */

/** Deny a write whose target is outside any of writeRoots. */
export function denyWriteOutsideRoots(toolName: string, input: any, writeRoots: string[]): string | null {
  if (!WRITE_TOOLS.has(toolName) || writeRoots.length === 0) return null;
  const fp = filePathOf(input);
  if (!fp) return null;
  const abs = path.isAbsolute(fp) ? fp : path.resolve(writeRoots[0]!, fp);
  const ok = writeRoots.some((r) => within(abs, r));
  return ok ? null : `Write blocked: ${abs} is outside the allowed work scope (${writeRoots.join(", ")}). If this change is genuinely needed, log it as a proposal instead.`;
}

/** Deny any write whose target is not exactly allowedFile. */
export function denyWriteNotFile(toolName: string, input: any, allowedFile: string): string | null {
  if (!WRITE_TOOLS.has(toolName)) return null;
  const fp = filePathOf(input);
  const abs = fp ? (path.isAbsolute(fp) ? fp : path.resolve(path.dirname(allowedFile), fp)) : "";
  return abs === allowedFile ? null : `This phase may only write ${path.basename(allowedFile)} (got ${abs || "?"}).`;
}

/** Deny any write at all (read-only roles). */
export function denyAnyWrite(toolName: string): string | null {
  return WRITE_TOOLS.has(toolName) ? `Read-only phase: ${toolName} is not permitted.` : null;
}

/** Deny dangerous Bash by substring match. */
export function denyBash(toolName: string, input: any, denyContains: string[]): string | null {
  if (toolName !== "Bash") return null;
  const cmd = String(input?.command ?? "");
  const hit = denyContains.find((bad) => bad && cmd.includes(bad));
  return hit ? `Bash blocked: command contains forbidden pattern "${hit}".` : null;
}

/** Deny Bash that mutates the filesystem (for read-only / read-mostly roles). */
export function denyBashMutation(toolName: string, input: any, extra: string[]): string | null {
  if (toolName !== "Bash") return null;
  const cmd = String(input?.command ?? "");
  const mutators = ["rm ", "mv ", "git commit", "git push", "git checkout", ">", ">>", "tee ", "sed -i", ...extra];
  const hit = mutators.find((bad) => bad && cmd.includes(bad));
  return hit ? `Read-mostly phase: Bash mutation blocked ("${hit}").` : null;
}

/**
 * Backend-independent backstop: given the files that actually changed, return those
 * outside every writeRoot. Works whether scoping was enforced by Claude PreToolUse
 * hooks or by Codex's OS sandbox — you verify the result, not the mechanism. Empty
 * writeRoots = unscoped (no violations). Paths are resolved against the first root.
 */
export function writeScopeViolations(changedPaths: string[], writeRoots: string[]): string[] {
  if (writeRoots.length === 0) return [];
  return changedPaths.filter((p) => {
    const abs = path.isAbsolute(p) ? p : path.resolve(writeRoots[0]!, p);
    return !writeRoots.some((r) => within(abs, r));
  });
}

/** Compose deciders: first non-null reason wins; null means allow. */
export function firstDeny(toolName: string, input: any, deciders: Array<(t: string, i: any) => string | null>): string | null {
  for (const d of deciders) {
    const r = d(toolName, input);
    if (r) return r;
  }
  return null;
}
