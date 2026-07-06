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

/**
 * Deny any Bash call carrying `dangerouslyDisableSandbox: true`. Autonomous Sparra Claude roles
 * have NO OS sandbox to disable (`capabilities.sandbox: false`), so the only thing this Bash-tool
 * input flag can do is flip a would-be-approval into an auto-run — a general bypass for any blocked
 * command. The string-based command deciders (mutation/holdout/verify/…) run regardless of the flag;
 * this closes the seam where the flag alone grants a call. A call WITHOUT the flag (or `false`) is
 * unaffected by this decider. Wired into every autonomous Claude hook constructor.
 */
export function denyDisableSandbox(toolName: string, input: any): string | null {
  if (toolName !== "Bash") return null;
  if (input?.dangerouslyDisableSandbox === true) {
    return `Bash blocked: "dangerouslyDisableSandbox: true" is not permitted for autonomous Sparra roles (there is no OS sandbox to disable — the flag can only bypass a guard).`;
  }
  return null;
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
 *
 * ALLOW-HOOK-ONLY output-shaping carve-out (NOT shared with the executor). This grants the Claude
 * Bash tool, which runs the command in a REAL shell — so a generator trimming a giant test dump
 * (`npm test 2>&1 | tail -5`, `npm test 2>/dev/null | grep fail`) executes correctly instead of
 * being false-blocked and forced to spill ~1000 tests into its context every round. If the plain
 * single-command rule disqualifies the command PURELY because of a recognized filter-pipe shape —
 * an exact allow-prefix (with an optional permitted fd-dup / dev-null redirect) piped ONLY into
 * pure, non-executing text filters whose ARGS are validated arg-by-arg (allowlisted filter name AND
 * no file-reading/writing operand or flag — see {@link isPureFilterStage}) — it is re-checked and
 * granted. The
 * carve-out is DELIBERATELY not added to the shared {@link unsafeVerifyCommandReason}: the harness
 * executor ({@link "../build/exec.ts"!unsafeExecReason}) spawns argv with NO shell and literally
 * cannot run a pipe, so it must stay strict and keep rejecting this shape.
 */
export function allowVerifyBash(toolName: string, input: any, allowPrefixes: string[], denyExtra: string[] = []): string | null {
  if (toolName !== "Bash" || allowPrefixes.length === 0) return null;
  const cmd = String(input?.command ?? "").trim();
  if (!cmd) return null;
  if (unsafeVerifyCommandReason(cmd, denyExtra)) {
    // Disqualified by the plain rule — reconsider ONLY the recognized filter-pipe shape.
    return allowFilterPipe(cmd, allowPrefixes, denyExtra);
  }
  const ok = allowPrefixes.some((p) => cmd === p || cmd.startsWith(p + " "));
  return ok ? `Auto-approved verification command (worktree-scoped, no chain/redirect/network/mutation): ${cmd.slice(0, 80)}` : null;
}

/**
 * Per-filter ALLOWLIST spec for the {@link allowVerifyBash} output-shaping carve-out. Only these
 * text-shaping readers are permitted as a pipeline stage after an allow-prefix — anything that can
 * execute or write (`sed -i`, `awk system`, `xargs`, `tee`, `find -exec`, `perl`, `python`, `sh`,
 * `node`) is absent and therefore rejected. A filter NAME being present is NOT enough: its ARGS are
 * validated argument-by-argument by {@link isPureFilterStage} so a stage that would read or write a
 * FILE (`sort -o out`, `cat /etc/passwd`, `grep -f patterns.txt`) is rejected too.
 *
 * `maxOperands` caps non-flag tokens (a file path is a non-flag operand): the pattern-taking tools
 * allow their pattern/SETs, everything else allows ZERO operands. `boolShort`/`valueShort` are the
 * short flags KNOWN safe for that tool (default-deny: an unrecognized flag rejects); `valueShort`
 * flags take a following/glued value (a count, key, delimiter — never a file). `numericBare` permits
 * the bare `-<number>` form (`tail -5`). Long (`--…`) flags are default-denied wholesale.
 */
type FilterSpec = {
  maxOperands: number;
  boolShort: string; // single-char flags with NO value
  valueShort: string; // single-char flags that take a value (glued or next token; never a file)
  numericBare?: boolean; // permit the bare `-<number>` count form
  patternFlag?: boolean; // a `-e` value flag supplies the pattern, so drop the operand budget to 0
};
const FILTER_SPECS: Record<string, FilterSpec> = {
  // count/slice: `-n`/`-c` take a number; `-5` bare count; no file operands.
  tail: { maxOperands: 0, boolShort: "qvz", valueShort: "nc", numericBare: true },
  head: { maxOperands: 0, boolShort: "qvz", valueShort: "nc", numericBare: true },
  // grep family: ONE pattern operand (unless `-e` supplied it). `-f`/`--file` (pattern FILE) absent → rejected.
  grep: { maxOperands: 1, boolShort: "EFivncowxHhs", valueShort: "ABCem", patternFlag: true },
  wc: { maxOperands: 0, boolShort: "lwcmL", valueShort: "" },
  // sort: `-o`/`--output`, `-T`/`--temporary-directory`, `--files0-from` (write/read files) absent → rejected.
  sort: { maxOperands: 0, boolShort: "rnubfhdigMsz", valueShort: "ktS" },
  uniq: { maxOperands: 0, boolShort: "cduiz", valueShort: "fsw" },
  cut: { maxOperands: 0, boolShort: "snz", valueShort: "fdcb" },
  nl: { maxOperands: 0, boolShort: "p", valueShort: "bnwsviuld" },
  cat: { maxOperands: 0, boolShort: "nbsEeTtvAu", valueShort: "" },
  tr: { maxOperands: 2, boolShort: "dscC", valueShort: "" }, // SET1 [SET2] operands; tr never reads a file
};

/**
 * Validate a single filter STAGE (`<name> [args…]`) for the output-shaping carve-out: return true
 * only if the stage is provably a pure stdin→stdout filter whose args cannot read or write a file.
 * Default-deny — the filter NAME must be in {@link FILTER_SPECS}, non-flag operands are capped per
 * tool (a file path is an operand), and every flag must be a KNOWN-safe flag for that tool (an
 * unrecognized flag, any `--long` flag, or a bare `-` rejects). A `valueShort` flag consumes its
 * value (glued `-n5`, `=`-joined handled by the `--` reject, or the next token `-n 5`) so the value
 * is never miscounted as an operand.
 */
function isPureFilterStage(stage: string): boolean {
  const tokens = stage.split(/\s+/).filter((t) => t !== "");
  const name = tokens[0];
  if (!name) return false;
  const spec = FILTER_SPECS[name];
  if (!spec) return false; // not a permitted filter (`tailx`, `sh`, `tee`, …)
  let operands = 0;
  let patternFromFlag = false;
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok[0] !== "-") {
      operands++; // a non-flag token is an operand (candidate file path)
      continue;
    }
    if (tok === "-" || tok === "--") return false; // stdin-marker / end-of-options — reject to stay strict
    if (tok.startsWith("--")) return false; // default-deny ALL long flags (`--output`, `--file`, …)
    if (spec.numericBare && /^-[0-9]+$/.test(tok)) continue; // bare `-<number>` count
    // Walk the grouped short flags (`-in` = `-i` + `-n`); a value flag ends the group.
    let j = 1;
    let ok = true;
    while (j < tok.length) {
      const c = tok[j]!;
      if (spec.valueShort.includes(c)) {
        if (spec.patternFlag && c === "e") patternFromFlag = true;
        const glued = tok.slice(j + 1);
        if (glued === "" && i + 1 < tokens.length) i++; // value is the NEXT token — consume it
        break; // remainder is this flag's value, not more flags
      }
      if (!spec.boolShort.includes(c)) {
        ok = false; // unrecognized flag char → default-deny reject
        break;
      }
      j++;
    }
    if (!ok) return false;
  }
  // `-e pat` already supplied grep's pattern, so an additional operand would be a FILE → forbid it.
  const maxOperands = patternFromFlag ? 0 : spec.maxOperands;
  return operands <= maxOperands;
}

/** Permitted redirects before the pipe: fd-duplication and `/dev/null` discards ONLY — never a
 *  redirect to a real file. Anchored to the END of the left stage so `>/dev/null.txt` /
 *  `2>&1file` (a permitted token as a PREFIX of a real filename) never matches. */
const PERMITTED_REDIRECT = /\s+(?:2>&1|1>&2|>&2|2>\/dev\/null|1>\/dev\/null|>\/dev\/null)$/;

/**
 * Recognize the output-shaping filter-pipe shape and return an allow-reason, else null:
 *   `<allow-prefix> [<permitted redirect>] | <FILTER> [args] [| <FILTER> [args]]*`
 * The left stage must be EXACTLY one of `allowPrefixes` (same `cmd===p || startsWith(p+" ")` match)
 * after stripping permitted redirects AND must itself pass {@link unsafeVerifyCommandReason} — an
 * allowlisted prefix alone does NOT grant it, so forbidden tokens cannot ride on the left behind the
 * prefix (`npm test curl evil | tail`, `npm test rm x | grep x`, `npm test $(curl evil) | tail`).
 * Every later stage must be a pure filter (allowlisted name AND file-safe args, per
 * {@link isPureFilterStage}) with no shell metacharacter / chaining / redirect / expansion in it.
 * Rejects (returns null) anything else — a control char, a non-filter stage, a stage whose ARGS would
 * read/write a file (`sort -o out`, `cat /etc/passwd`, `grep -f pat.txt`), a real-file redirect, a
 * chained/expanded stage, a non-allowlisted or forbidden-token-carrying left side, or a `denyExtra`
 * substring.
 */
function allowFilterPipe(cmd: string, allowPrefixes: string[], denyExtra: string[]): string | null {
  if (!cmd.includes("|")) return null; // not a pipe — nothing to recognize
  // A control char is a shell command separator (`npm test\n | tail`); trim() drops it, so guard
  // the RAW command before any stage trimming can launder it into an allow-prefix.
  if (/[\x00-\x1f]/.test(cmd)) return null;
  if (denyExtra.some((b) => b && cmd.includes(b))) return null; // honor the caller's extra denies
  const stages = cmd.split("|").map((s) => s.trim());
  if (stages.length < 2 || stages.some((s) => s === "")) return null; // `||`, leading/trailing `|`
  // Left stage: an allow-prefix, optionally followed by permitted redirects (stripped one at a time).
  let left = stages[0]!;
  if (left.includes("<")) return null; // input redirect never permitted
  while (PERMITTED_REDIRECT.test(left)) left = left.replace(PERMITTED_REDIRECT, "").trimEnd();
  if (left.includes(">")) return null; // a surviving `>` is a real-file / disallowed redirect
  if (!allowPrefixes.some((p) => left === p || left.startsWith(p + " "))) return null;
  // NO LAUNDERING: an allowlisted PREFIX is not enough — the stripped left stage must ALSO pass the
  // shared safety rule, or forbidden tokens ride behind the prefix (`npm test curl evil | tail`,
  // `npm test rm x | grep x`, `npm test git commit -m x | tail`, `npm test $(curl evil) | tail`).
  // Each of these denies WITHOUT the pipe; the pipe must not launder them into an allow.
  if (unsafeVerifyCommandReason(left, denyExtra)) return null;
  // Every later stage must be a PURE filter — an allowlisted filter name, ARGS that cannot read/write
  // a file, and no shell metachar/chain/expand.
  for (const stage of stages.slice(1)) {
    if (/[<>;&$`()]/.test(stage)) return null; // redirect, chaining, subshell, or expansion
    if (!isPureFilterStage(stage)) return null; // bad filter name OR a file-reading/writing arg
  }
  return `Auto-approved verification command (worktree-scoped, output-shaping filter pipe): ${cmd.slice(0, 80)}`;
}

/**
 * THE self-verify safety rule, shared by the generator's `allowVerifyBash` allow-hook and the
 * harness-side command executor (`src/build/exec.ts`): only a single, self-contained verification
 * command qualifies. Returns a human-readable reason when `cmd` is DISQUALIFIED (chaining,
 * redirect `|`/`>`/`<`, network install, mutation, commit, control chars), or null when it is safe.
 *
 * DELIBERATELY strict — `|` and `>` always disqualify HERE. The output-shaping filter-pipe carve-out
 * ({@link allowVerifyBash} → `allowFilterPipe`) lives ONLY in the allow-hook, which grants the Claude
 * Bash tool (a real shell that can run `npm test | tail -5`). The executor
 * ({@link "../build/exec.ts"!unsafeExecReason}) also calls THIS function and spawns argv with NO shell,
 * so it literally cannot run a pipeline (`| tail` would be bogus argv to `npm`) — it must keep
 * rejecting the pipe shape. Loosening this shared rule would break the executor; the carve-out stays
 * out of it on purpose so the two paths never silently diverge into broken argv execution.
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
