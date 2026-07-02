import { spawn } from "node:child_process";
import path from "node:path";
import { unsafeVerifyCommandReason } from "../sdk/scoping.ts";

/**
 * Harness-side (NO-model) command executor + the pure helpers around it:
 *   - `runVerifyCommand` — run ONE contract verify command with cwd=workspace, bounded
 *     output and a timeout. NO SHELL: the command is tokenized (whitespace split after
 *     validation) and spawned as argv directly, so shell expansion (`rm${IFS}x`, `$(…)`,
 *     backticks) never executes. It inherits the generator self-verify SAFETY rule
 *     (`unsafeVerifyCommandReason` in src/sdk/scoping.ts — shared, not duplicated) PLUS
 *     executor-only rejections (shell metacharacters; argv[0]-basename deny): a command
 *     that fails any rule is REPORTED as unsafe and never spawned.
 *   - `extractVerifyCommands` — pull the commands out of a contract's
 *     "## I will verify by" section (backticked or plain list items), bounded to that
 *     section (stops at the next heading).
 *   - `classifyExec` — usage error (command not found / unknown flag / usage text)
 *     vs. behavioral failure vs. ok.
 * Consumers: the contract verify-PROBE (src/build/contract.ts) and the flakiness
 * RERUN gate (src/phases/build.ts). Both take the executor as an injectable dep.
 */

/** Outcome of one executor invocation. `ran: false` ⇒ the safety rule rejected it (never spawned). */
export type ExecOutcome =
  | { ran: false; command: string; unsafeReason: string }
  | { ran: true; command: string; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };

/** The injectable executor seam shared by the probe and the rerun gate. */
export type CommandExecutor = (workspace: string, command: string) => Promise<ExecOutcome>;

/** Per-stream output cap (chars) — enough to diagnose, small enough for a prompt. */
export const EXEC_OUTPUT_CAP = 8_000;
/** Default per-command timeout. Verify commands are typecheck/test-sized, not builds-of-the-world. */
export const EXEC_TIMEOUT_MS = 300_000;

/**
 * Shell metacharacters / expansion tokens. The executor spawns argv DIRECTLY (no shell), so any
 * command that NEEDS shell syntax is not a safe contracted verify command (npm test, tsc --noEmit,
 * vitest run x.ts are all plain invocations) — reject it pre-spawn rather than pass it through
 * where a shell somewhere might interpret it. `rm${IFS}victim.txt` dies here on the `$`.
 */
const SHELL_METACHARS = /[$`;&|><(){}'"~\\\n\r]/;

/**
 * argv[0] basenames that never qualify as a contracted verify command — mutation, escalation,
 * network, VCS, package-runner, and shell/eval escapes (`sh -c …` or `node -e …` would reintroduce
 * the very interpretation dropping `shell: true` removes). BASENAME match, not substring: bare
 * `rm` and `/bin/rm` both hit; `rmdir-check-tool` does not.
 */
const DENY_ARGV0 = new Set([
  "rm", "rmdir", "mv", "cp", "dd", "chmod", "chown", "ln", "kill", "sudo",
  "curl", "wget", "git", "npx", "sh", "bash", "zsh", "env", "xargs",
]);

/**
 * The executor's full pre-spawn safety rule: the shared self-verify disqualifiers
 * ({@link unsafeVerifyCommandReason}) PLUS the executor-only rejections that exist because this
 * runner tokenizes and spawns argv itself — shell metacharacters/expansion tokens, denied argv[0]
 * basenames, and `node -e/--eval`. Returns the human-readable reason, or null when safe to spawn.
 */
export function unsafeExecReason(cmd: string): string | null {
  if (!cmd) return "empty command";
  const shared = unsafeVerifyCommandReason(cmd);
  if (shared) return shared;
  const meta = cmd.match(SHELL_METACHARS);
  if (meta) return `contains shell metacharacter "${meta[0]}" — the executor spawns argv directly (no shell), so shell syntax/expansion is never interpreted`;
  const argv = cmd.split(/\s+/);
  const base = path.basename(argv[0]!);
  if (DENY_ARGV0.has(base)) return `argv[0] "${base}" is denied for the harness executor (mutation/network/VCS/shell escape)`;
  if (base === "node" && argv.some((a) => a === "-e" || a === "--eval")) {
    return `"node -e/--eval" is an eval escape — denied for the harness executor`;
  }
  return null;
}

/** The real executor. Safety rule first (never spawn an unsafe command — see
 *  {@link unsafeExecReason}), then a NO-SHELL child process: the validated command is
 *  whitespace-tokenized and spawned as argv with cwd=workspace, so nothing is ever
 *  shell-interpreted (no chaining, no redirect, no `${IFS}`/`$(…)` expansion). */
export async function runVerifyCommand(
  workspace: string,
  command: string,
  opts: { timeoutMs?: number; outputCap?: number; spawnFn?: typeof spawn } = {}
): Promise<ExecOutcome> {
  const cmd = command.trim();
  const unsafe = unsafeExecReason(cmd);
  if (unsafe) return { ran: false, command: cmd, unsafeReason: unsafe };
  const cap = opts.outputCap ?? EXEC_OUTPUT_CAP;
  const spawnFn = opts.spawnFn ?? spawn; // injectable so tests can PROVE an unsafe command never spawns
  const argv = cmd.split(/\s+/); // safe: SHELL_METACHARS already rejected anything quote/expansion-shaped
  return await new Promise<ExecOutcome>((resolve) => {
    const child = spawnFn(argv[0]!, argv.slice(1), { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? EXEC_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => { if (stdout.length < cap) stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { if (stderr.length < cap) stderr += d.toString(); });
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      resolve({ ran: true, command: cmd, exitCode, stdout: stdout.slice(0, cap), stderr: stderr.slice(0, cap), timedOut });
    };
    child.on("error", (e) => {
      // Spawn-level failure (ENOENT — argv[0] not on PATH) — treat like "command not found".
      clearTimeout(timer);
      resolve({ ran: true, command: cmd, exitCode: 127, stdout: "", stderr: String(e.message ?? e).slice(0, cap), timedOut });
    });
    child.on("close", (code) => finish(code));
  });
}

/**
 * Extract the runnable commands from a contract's "## I will verify by" section — and ONLY
 * that section (stops at the next heading of any level). Two shapes per line:
 *   - a backticked command (in prose or a list item): the FIRST backtick span is the command
 *     (later spans are expected outputs, e.g. "prints \`5\`");
 *   - a plain list item with no backticks: the item text up to a "→"/"->" annotation.
 * A contract without the section (or with no commands) yields [] — no probe, no gate.
 */
export function extractVerifyCommands(contractMd: string): string[] {
  const lines = contractMd.split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s+I will verify by\b/i.test(l.trim()));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^#{1,6}\s/.test(line.trim())) break; // next heading → section over
    const backtick = line.match(/`([^`]+)`/);
    if (backtick) {
      const cmd = backtick[1]!.trim();
      if (cmd) out.push(cmd);
      continue;
    }
    const listItem = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/);
    if (listItem) {
      const cmd = listItem[1]!.split(/→|->/)[0]!.trim();
      if (cmd) out.push(cmd);
    }
  }
  return out;
}

/** How an executed verify command's outcome reads:
 *    usage      — the COMMAND ITSELF is broken as written (not found / unknown flag / usage text);
 *    behavioral — it ran but the thing it checks failed (expected pre-build, a real fail post-build);
 *    ok         — exit 0. Unsafe (never-ran) outcomes are the caller's business, not classified here. */
export type ExecClass = "ok" | "usage" | "behavioral";

const USAGE_PATTERNS = [
  /command not found/i,
  /: not found\b/i,
  /is not recognized as an internal or external command/i,
  /unknown (?:option|flag|command|argument|subcommand)/i,
  /unrecognized (?:option|argument|subcommand)/i,
  /invalid (?:option|flag)/i,
  /illegal option/i,
  /^\s*usage:/im,
];

/** Classify an executed outcome. Exit 127 is the shell's "command not found"; any nonzero exit
 *  whose output carries a usage signature is a usage error; other nonzero → behavioral. */
export function classifyExec(o: { exitCode: number | null; stdout: string; stderr: string }): ExecClass {
  if (o.exitCode === 0) return "ok";
  if (o.exitCode === 127) return "usage";
  const text = `${o.stderr}\n${o.stdout}`;
  return USAGE_PATTERNS.some((p) => p.test(text)) ? "usage" : "behavioral";
}

/** Render one outcome for feedback/negotiation context (command + exit + capped output). */
export function renderExecOutcome(o: ExecOutcome, perStreamCap = 600): string {
  if (!o.ran) return `\`${o.command}\` — NOT RUN (unsafe for the harness executor: ${o.unsafeReason})`;
  const bits = [`\`${o.command}\` → exit ${o.exitCode}${o.timedOut ? " (timed out)" : ""}`];
  if (o.stderr.trim()) bits.push(`stderr: ${o.stderr.trim().slice(0, perStreamCap)}`);
  if (o.stdout.trim()) bits.push(`stdout: ${o.stdout.trim().slice(0, perStreamCap)}`);
  return bits.join("\n");
}

/** One command's rerun-gate summary across K runs. */
export interface RerunResult {
  command: string;
  /** Exit codes of the runs that actually executed (empty for unsafe — never run). */
  exitCodes: (number | null)[];
  /** all-zero → "ok"; all-nonzero → "failing" (failing-as-shipped); mixed → "flaky";
   *  "unsafe" = the safety rules rejected the CONTRACTED command (never ran) — the contract's
   *  "only all-runs-exit-0 keeps the pass" can never be witnessed, so it demotes like failing. */
  status: "ok" | "flaky" | "failing" | "unsafe";
  /** Rendered output of the worst (last failing) run, for feedback. */
  detail: string;
}

/** RERUN GATE core: run each verify command `reruns` times via the injected executor.
 *  ANY non-ok result — flaky, failing, or unsafe — prevents a clean pass (the caller demotes). */
export async function rerunVerifyCommands(
  workspace: string,
  commands: string[],
  reruns: number,
  exec: CommandExecutor
): Promise<RerunResult[]> {
  const results: RerunResult[] = [];
  for (const command of commands) {
    const exitCodes: (number | null)[] = [];
    let detail = "";
    let unsafe = false;
    for (let i = 0; i < reruns; i++) {
      const o = await exec(workspace, command);
      if (!o.ran) {
        unsafe = true;
        detail = renderExecOutcome(o);
        break; // unsafe is deterministic — don't retry it
      }
      exitCodes.push(o.exitCode);
      if (o.exitCode !== 0) detail = renderExecOutcome(o);
    }
    const status: RerunResult["status"] = unsafe
      ? "unsafe"
      : exitCodes.every((c) => c === 0)
      ? "ok"
      : exitCodes.every((c) => c !== 0)
      ? "failing"
      : "flaky";
    results.push({ command, exitCodes, status, detail });
  }
  return results;
}
