import path from "node:path";

/** Tools that write to the filesystem. */
export const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Read-only tools a build role may always use within its read scope. */
export const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);

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

/**
 * Deny ambient MCP tools that leak into a session despite `settingSources: []` — most
 * notably claude.ai cloud connectors (Google Drive, Gmail, Calendar), which are auto-fetched
 * from the logged-in account rather than from a settings file. Sparra's own in-process
 * server (`mcp__exercise__*`) is the only MCP an autonomous build agent should ever call.
 */
export function denyAmbientMcp(toolName: string): string | null {
  if (toolName.startsWith("mcp__") && !toolName.startsWith("mcp__exercise__")) {
    return `MCP tool "${toolName}" is not available to Sparra build agents (ambient connectors are blocked; only the exercise tools are allowed).`;
  }
  return null;
}

/**
 * Deny TREE-MUTATING git via raw Bash (for the read-only evaluator). The evaluator may freely run
 * inspecting git (`git status`/`diff`/`ls-files`/`log`) to read the artifact, but must NOT clobber
 * the worktree it grades — a `git clean -xfd` / `git checkout -- .` / `git reset --hard` would wipe
 * the generator's output and trip the source-integrity guard. BEST-EFFORT, exactly like {@link denyBash}:
 * a shell can evade substring matching (the authoritative wall is the isolated worktree + integrity
 * snapshot), so this only shrinks the obvious raw-Bash residual.
 */
export const TREE_MUTATING_GIT = ["git clean", "git checkout", "git reset", "git restore", "git stash"];
export function denyTreeMutatingGit(toolName: string, input: any): string | null {
  if (toolName !== "Bash") return null;
  const cmd = String(input?.command ?? "");
  const hit = TREE_MUTATING_GIT.find((bad) => cmd.includes(bad));
  return hit ? `Read-only evaluator: tree-mutating git blocked ("${hit}"). Use non-mutating git (status/diff/log) to inspect.` : null;
}

/** Deny dangerous Bash by substring match. */
export function denyBash(toolName: string, input: any, denyContains: string[]): string | null {
  if (toolName !== "Bash") return null;
  const cmd = String(input?.command ?? "");
  const hit = denyContains.find((bad) => bad && cmd.includes(bad));
  return hit ? `Bash blocked: command contains forbidden pattern "${hit}".` : null;
}

/**
 * ALLOW-decider: auto-approve a SAFE, self-contained verification command (typecheck/test/build)
 * so the generator can verify its own work instead of writing blind. Returns an allow-reason when
 * the Bash command starts with one of `allowPrefixes` AND contains no command-chaining, redirect,
 * network, mutation, or commit token — otherwise null (defer to the permission mode; not granted).
 * The disqualifier list, not a sandbox, is the guarantee on a hooks-only backend (Claude); the
 * caller gates this to a worktree/branch boundary.
 */
export function allowVerifyBash(toolName: string, input: any, allowPrefixes: string[], denyExtra: string[] = []): string | null {
  if (toolName !== "Bash" || allowPrefixes.length === 0) return null;
  const cmd = String(input?.command ?? "").trim();
  if (!cmd) return null;
  if (unsafeVerifyCommandReason(cmd, denyExtra)) return null;
  const ok = allowPrefixes.some((p) => cmd === p || cmd.startsWith(p + " "));
  return ok ? `Auto-approved verification command (worktree-scoped, no chain/redirect/network/mutation): ${cmd.slice(0, 80)}` : null;
}

/**
 * THE self-verify safety rule, shared by the generator's `allowVerifyBash` allow-hook and the
 * harness-side command executor (`src/build/exec.ts`): only a single, self-contained verification
 * command qualifies. Returns a human-readable reason when `cmd` is DISQUALIFIED (chaining,
 * redirect, network install, mutation, commit, control chars), or null when it is safe.
 */
export function unsafeVerifyCommandReason(cmd: string, denyExtra: string[] = []): string | null {
  // Any ASCII control char (newline, CR, tab, …) disqualifies — a newline is a shell command
  // separator, so `npm test\ntouch pwned` must NOT slip through a prefix/safety check.
  if (/[\x00-\x1f]/.test(cmd)) return "contains a control character (shell command separator)";
  // Anything that could chain, redirect, reach the network, mutate the tree, install, or commit
  // disqualifies — only a single, self-contained verification command is granted.
  const disqualify = [
    "&&", "||", ";", "|", "`", "$(", ">", "<", "rm ", "mv ", "cp ", "tee ", "sed -i", "chmod ", "chown ",
    "git commit", "git push", "git reset", "git checkout", "git clean", "git rm",
    "curl", "wget", "nc ", "ssh ", "scp ", "npm install", "npm i ", "npm ci", "npm publish",
    "yarn add", "pnpm add", "pip install", "sudo ",
    ...denyExtra,
  ];
  const hit = disqualify.find((b) => b && cmd.includes(b));
  return hit ? `contains forbidden token "${hit}" (chain/redirect/network/mutation/commit)` : null;
}

/**
 * ALLOW-decider: auto-approve a READ tool (Read/Glob/Grep) whose explicit target is within the
 * role's read scope, so a generator/evaluator can ALWAYS read its own workspace regardless of the
 * resolved permission mode or a model classifier (the failure mode where a writer had every
 * Read/Grep denied and produced nothing). Deny-deciders run FIRST in the same hook, so a holdout /
 * `.sparra` read is still denied before this can grant it — keep the holdout decider in the deny
 * list. A read with NO explicit path (a Glob/Grep over the cwd) is NOT auto-granted here (it could
 * surface a cwd-resident holdout); it defers to the permission mode, so this never broadens scope
 * beyond an explicit in-scope target.
 */
export function allowReadInScope(toolName: string, input: any, readScopes: string[]): string | null {
  if (!READ_TOOLS.has(toolName) || readScopes.length === 0) return null;
  const target = (input?.file_path ?? input?.path) as string | undefined;
  if (!target) return null; // pathless search → defer to the permission mode (don't broaden)
  const abs = path.isAbsolute(target) ? target : path.resolve(readScopes[0]!, target);
  return readScopes.some((r) => within(abs, r)) ? `Auto-approved in-scope ${toolName}: ${abs}` : null;
}

/** Deny Bash that mutates the filesystem (for read-only / read-mostly roles). */
export function denyBashMutation(toolName: string, input: any, extra: string[]): string | null {
  if (toolName !== "Bash") return null;
  const cmd = String(input?.command ?? "");
  const mutators = ["rm ", "mv ", "git commit", "git push", "git checkout", "tee ", "sed -i", ...extra];
  const hit = mutators.find((bad) => bad && cmd.includes(bad));
  if (hit) return `Read-mostly phase: Bash mutation blocked ("${hit}").`;
  // A redirect only mutates when it targets a real file — strip harmless fd-dups (`2>&1`)
  // and `/dev/null` targets first, THEN a remaining bare `>`/`>>` means a file write.
  const stripped = cmd.replace(/\d*>&(?:\d+|-)(?![\w.-])|[0-9&]*>{1,2}\s*\/dev\/null(?![\w.-])/g, "");
  if (/>/.test(stripped)) return `Read-mostly phase: Bash mutation blocked (file redirect ">").`;
  return null;
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
