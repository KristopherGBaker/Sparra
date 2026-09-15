import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SparraConfig } from "../config.ts";
import { stringProcessEnv } from "./env.ts";
import { ensureSwiftpmCacheDir } from "../util/provision.ts";

/**
 * Default WRITABLE-SCRATCH env layer for the SANDBOXED build sessions — the two judge role-runs
 * (evaluator AND contract-evaluator), the GENERATOR/writer, and the CONTRACT-negotiation sessions.
 * (It began judge-only; U-X extended it to the generator + contract paths so a Swift build/test gate
 * is observable AS SHIPPED there too, not just under the judge.)
 *
 * A read-only Codex sandbox / an unwritable `$HOME` breaks otherwise-innocent tooling BEFORE any
 * Sparra code runs, so a "prove this verify command runs" probe EPERMs at startup and the gate is
 * unobservable:
 *   - the tsx launcher derives its IPC pipe from `os.tmpdir()` (installed tsx 4.x:
 *     `dist/temporary-directory-*.cjs` → `join(os.tmpdir(), 'tsx-<uid>')`, then
 *     `dist/get-pipe-path-*.cjs` → `join(tmpdir, '<pid>.pipe')`), so `node bin/sparra.mjs` dies on
 *     `EPERM` creating the socket;
 *   - Vitest writes `/var/folders/**` temp files and dies at collection;
 *   - clang writes its module cache under `~/.cache/clang/ModuleCache` (unwritable → Swift builds
 *     force a hand-modified `--disable-sandbox` reproduction).
 *
 * Redirecting the temp + cache roots into a per-run writable scratch dir fixes these PATH-writability
 * EPERMs WITHOUT widening the sandbox's write scope over the artifact source (the source-integrity
 * guard still reverts any write to the tracked surface). This layer is DEFAULT — it applies
 * unconditionally to the judge role-runs, independent of the exercise-scratch / workspace-write gating.
 *
 * CAVEAT — this does NOT make tsx IPC sockets (or dev servers) usable under a sandboxed judge: the
 * scratch layer only fixes the socket PATH's writability, not the sandbox's seatbelt POLICY, which
 * denies `listen(2)` on a Unix-domain socket regardless of TMPDIR writability. That known limitation
 * is surfaced to the judge up front via `sandboxCapabilityNotes` / `judgeCapabilityNotesText` below,
 * so socket-dependent exercises are classified UN-RUN instead of re-proved every round.
 */

/** The cache/temp env keys the layer redirects (stable order; consumed by the layer + tests). */
export const JUDGE_SCRATCH_ENV_KEYS = ["TMPDIR", "CLANG_MODULE_CACHE_PATH", "SWIFTPM_CACHE_DIR"] as const;

/** Sub-directory (under the per-run scratch root) each redirected key points at. */
const SUBDIRS: Record<(typeof JUDGE_SCRATCH_ENV_KEYS)[number], string> = {
  TMPDIR: "tmp", // node/tsx/Vitest temp + IPC sockets
  CLANG_MODULE_CACHE_PATH: "clang-module-cache", // clang honors this; overrides ~/.cache/clang/ModuleCache
  SWIFTPM_CACHE_DIR: "swiftpm", // SwiftPM cache root (best-effort; user build.env can override)
};

/**
 * Pure: the env-layer values for a scratch root (no fs). TMPDIR + clang cache always point UNDER
 * `scratchDir` (regenerable per session). `swiftpmDir` overrides where SWIFTPM_CACHE_DIR points — a
 * DURABLE worktree-local cache the prewarm + sibling sessions share; omitted, it falls back UNDER
 * `scratchDir` (the original judge behavior, so `judgeScratchEnvLayer` stays byte-identical).
 */
export function scratchEnvLayer(scratchDir: string, swiftpmDir?: string): Record<string, string> {
  return {
    TMPDIR: path.join(scratchDir, SUBDIRS.TMPDIR),
    CLANG_MODULE_CACHE_PATH: path.join(scratchDir, SUBDIRS.CLANG_MODULE_CACHE_PATH),
    SWIFTPM_CACHE_DIR: swiftpmDir ?? path.join(scratchDir, SUBDIRS.SWIFTPM_CACHE_DIR),
  };
}

/** Pure: the default env-layer values for a scratch root (no fs). Each points UNDER `scratchDir`. */
export function judgeScratchEnvLayer(scratchDir: string): Record<string, string> {
  return scratchEnvLayer(scratchDir);
}

/**
 * Merge the scratch layer into the build env with the documented precedence:
 *   process.env (base) < scratch defaults < user `build.env` (wins).
 * So a user override of TMPDIR/CLANG_MODULE_CACHE_PATH/SWIFTPM_CACHE_DIR beats the default, every
 * unrelated `process.env` value is preserved, and (unlike `mergedBuildEnv`) the result is ALWAYS a
 * map — the scratch keys must reach the SDK even when `build.env` is empty. `swiftpmDir` (when given)
 * routes SWIFTPM_CACHE_DIR at the durable worktree-local cache; omitted → under `scratchDir`.
 */
export function sandboxEnv(
  config: SparraConfig,
  scratchDir: string,
  opts: { swiftpmDir?: string; src?: NodeJS.ProcessEnv } = {}
): Record<string, string> {
  const buildEnv = config.build.env ?? {};
  return { ...stringProcessEnv(opts.src ?? process.env), ...scratchEnvLayer(scratchDir, opts.swiftpmDir), ...buildEnv };
}

/** Back-compat thin wrapper (the JUDGE call shape): SWIFTPM_CACHE_DIR lands under `scratchDir`. */
export function judgeSandboxEnv(
  config: SparraConfig,
  scratchDir: string,
  src: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return sandboxEnv(config, scratchDir, { src });
}

/**
 * Assemble the writable-scratch session env every SANDBOXED build session uses — the generator, the
 * contract-negotiation sessions, AND the two judge roles. Creates a FRESH per-session scratch root
 * (ephemeral TMPDIR + clang cache) and points SWIFTPM_CACHE_DIR at the DURABLE worktree-local cache
 * keyed on `workspaceDir` (so an offline `swift build` reuses the state the provisioning prewarm
 * produced). Precedence is preserved: process.env < scratch defaults < user `build.env`.
 */
export function createSandboxSessionEnv(config: SparraConfig, workspaceDir: string): Record<string, string> {
  return sandboxEnv(config, createJudgeScratch(), { swiftpmDir: ensureSwiftpmCacheDir(workspaceDir) });
}

/** The env flag an EVALUATOR/JUDGE session sets so its socket-dependent test suites vitest-SKIP
 *  (test/helpers/judgeEnv.ts is the consumer). NEVER set on generator/self-verify paths. */
export const JUDGE_SANDBOX_FLAG = "SPARRA_JUDGE_SANDBOX";

/**
 * Layer `SPARRA_JUDGE_SANDBOX=1` onto an evaluator/judge session env. Under this flag every suite
 * that spawns the real CLI / a tsx subprocess (Unix-socket-dependent — denied by the sandbox policy)
 * SKIPS visibly instead of EPERM-failing, so the full suite is EXPECTED green and a nonzero full-suite
 * exit is a REAL artifact signal — EXCEPT the runner worker/reporter-RPC-timeout signature carved out
 * in `runnerLimitations` (whole-file aborts on onTaskUpdate/onCollected with zero failing assertions =
 * CPU saturation → UN-RUN). Applied ONLY to sandboxed-judge sessions (evaluator +
 * contract-evaluator) — never the generator, whose self-verify must keep running everything it can.
 */
export function withJudgeSandboxFlag(env: Record<string, string>): Record<string, string> {
  return { ...env, [JUDGE_SANDBOX_FLAG]: "1" };
}

/**
 * Create a fresh per-run scratch root (and each redirected sub-dir) on disk, returning its path.
 * Kept SHORT (`sprj-<8hex>`): tsx builds its Unix-domain IPC socket UNDER `TMPDIR`, and socket paths
 * cap at ~104 chars — a long name here would re-break the very thing the redirect fixes.
 */
export function createJudgeScratch(baseDir: string = os.tmpdir()): string {
  const dir = path.join(baseDir, `sprj-${randomUUID().slice(0, 8)}`);
  for (const key of JUDGE_SCRATCH_ENV_KEYS) fs.mkdirSync(path.join(dir, SUBDIRS[key]), { recursive: true });
  return dir;
}

// ── KNOWN sandbox-capability matrix (surfaced to sandboxed judges up front) ──────────────────────
//
// The writable-scratch layer above fixes PATH-writability EPERMs (Vitest temp, clang cache, tsx's
// socket PATH), but it does NOT lift the sandbox's seatbelt POLICY. The Codex evaluator sandbox
// denies `listen(2)` on a Unix-domain socket even inside a writable scratch TMPDIR — proved TWICE in
// one cycle with a raw `net.createServer().listen()` probe (an EPERM from the policy, not from path
// permissions). So any exercise needing a socket LISTENER (a tsx-launched CLI smoke that IPCs over a
// `.pipe`, a dev server) systematically UN-RUNs under a sandboxed judge, regardless of TMPDIR
// writability — and every evaluator re-discovers and re-proves it. A live HARNESS-side probe can't
// confirm the judge's sandbox (the harness process runs OUTSIDE that sandbox), so we ship this KNOWN
// matrix and surface it to the judge instead of asking it to re-prove the limitation each round.

/**
 * What the graded project is actually built with — the notes below are only TRUE for some stacks.
 *
 * The sandbox-limit and runner-limit blocks were emitted unconditionally, so a Swift/iOS judge whose
 * gates are `make verify`, `xcodebuild` and `swift test` received a page about
 * `net.createServer().listen()`, "a tsx-launched CLI smoke that IPCs over a .pipe", and vitest's
 * worker-RPC timeout. That is not merely wasted tokens: it told the judge the full suite is "EXPECTED
 * green" under a flag the project never reads, and handed it a ready-made UN-RUN classification keyed
 * to a runner it will never invoke — a misclassification aimed straight at the gates it must grade.
 */
export interface JudgeStack {
  /** A Node project (a `package.json` at the workspace root). */
  node: boolean;
  /** Runs vitest (a dependency entry, or a `vitest.config.*`). */
  vitest: boolean;
  /**
   * The project CONSUMES `SPARRA_JUDGE_SANDBOX` — i.e. its socket-dependent suites really do skip
   * under the flag. The "full suite is EXPECTED green" claim holds ONLY then; asserted anywhere else
   * it is a false promise. Detected from the documented shared helper / a vitest entry point.
   */
  judgeSandboxSeam: boolean;
}

/** Files that can wire the judge-sandbox flag, cheapest first. Bounded: no tree walk. */
const SEAM_FILES = ["test/helpers/judgeEnv.ts", "vitest.setup.ts", "vitest.config.ts", "package.json"];

/** Detect the graded project's stack from its workspace. Cheap (a handful of stats + small reads). */
export function detectJudgeStack(workspaceDir: string): JudgeStack {
  const read = (rel: string): string | null => {
    try {
      return fs.readFileSync(path.join(workspaceDir, rel), "utf8");
    } catch {
      return null;
    }
  };
  const pkg = read("package.json");
  const vitestConfig = ["vitest.config.ts", "vitest.config.js", "vitest.config.mts", "vitest.config.mjs"].some(
    (f) => read(f) !== null
  );
  return {
    node: pkg !== null,
    vitest: vitestConfig || (pkg !== null && /["']vitest["']\s*:/.test(pkg)),
    judgeSandboxSeam: SEAM_FILES.some((f) => read(f)?.includes(JUDGE_SANDBOX_FLAG) ?? false),
  };
}

/** A stack that claims nothing — the safe default when no workspace is known. */
export const UNKNOWN_JUDGE_STACK: JudgeStack = { node: false, vitest: false, judgeSandboxSeam: false };

/** The Codex-style sandbox modes a judge can run under (see `AgentRequest.sandbox` + `readOnly`). */
export type JudgeSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** One capability the sandbox is KNOWN to deny as policy (surfaced so judges classify, not re-prove). */
export interface DeniedCapability {
  /** Stable id, e.g. `unix-domain-socket-listen`. */
  capability: string;
  /** One-line human description of what's denied and why (policy, not path writability). */
  detail: string;
}

/**
 * Pure: the KNOWN-denied capabilities for a judge, keyed on (backend OS-sandbox, sandbox mode,
 * scratch enabled). No probing, exec, or fs access — a static matrix.
 *
 *   - No OS sandbox (Claude judges, `hasOsSandbox: false`) → no sandbox-policy rows (nothing is
 *     policy-denied); the LOAD-based runner-limitation note still renders via
 *     `sandboxCapabilityNotesText`, so a Claude judge is NOT left without an injected block.
 *   - A fully-lifted sandbox (`danger-full-access`, gated to a worktree/branch) → no sandbox-policy
 *     rows (the runner-limitation note still renders).
 *   - `read-only` AND `workspace-write` (Codex judges) → unix-domain-socket LISTEN is denied by
 *     seatbelt policy, INDEPENDENT of `scratchEnabled`/TMPDIR writability (see the file-level note).
 *
 * `scratchEnabled` is accepted (and deliberately ignored for the UDS row) to document that the
 * writable-scratch layer does NOT change this verdict — the deny is policy, not path permission.
 */
export function sandboxCapabilityNotes(args: {
  backendId: string;
  hasOsSandbox: boolean;
  sandboxMode: JudgeSandboxMode;
  scratchEnabled: boolean;
  /** The graded project's stack. Omitted → claims nothing stack-specific. */
  stack?: JudgeStack;
}): DeniedCapability[] {
  if (!args.hasOsSandbox) return [];
  if (args.sandboxMode === "danger-full-access") return [];
  const stack = args.stack ?? UNKNOWN_JUDGE_STACK;
  // The DENY is a sandbox-policy fact, true for any stack — a dev server, a language server, an
  // IPC-based test runner. Only the EXAMPLES and the vitest-skip promise are Node-specific.
  const nodeExample = stack.node
    ? ` — so a tsx-launched CLI smoke that IPCs over a .pipe, or any dev-server bind, cannot run under this ${args.sandboxMode} judge`
    : ` — so any gate that binds a socket (a dev server, an IPC-based runner) cannot run under this ${args.sandboxMode} judge`;
  const skipPromise = stack.judgeSandboxSeam
    ? ` This session runs the suite with SPARRA_JUDGE_SANDBOX=1, so those socket-dependent suites vitest-SKIP ` +
      `(visibly counted, never silently filtered) instead of EPERM-failing — the full suite is therefore ` +
      `EXPECTED green, and a NONZERO full-suite exit is a REAL artifact signal, not an environment limit.`
    : ` A gate that fails ONLY on this deny is environment-blocked (UN-RUN), never an artifact FAIL.`;
  const caps: DeniedCapability[] = [
    {
      capability: "unix-domain-socket-listen",
      detail:
        `listen(2) on a Unix-domain socket is denied by the ${args.backendId} sandbox POLICY even inside a ` +
        `writable scratch TMPDIR (proved with a raw net.createServer().listen() probe)${nodeExample}.` +
        skipPromise,
    },
  ];
  // vitest/vite specifics belong only to a project that runs vitest.
  if (args.sandboxMode === "read-only" && stack.vitest) {
    caps.push({
      capability: "vitest-vite-temp-write",
      detail:
        `vitest/vite writes cache files to the read-only checkout's node_modules/.vite-temp/ ` +
        `(e.g. vitest.config.ts.timestamp-*), producing EPERM. Classify as a sandbox limit ` +
        `(UN-RUN / environment-blocked) — not a code FAIL; do not re-prove or request a carve-out.`,
    });
  }
  return caps;
}

// ── KNOWN runner (test-runner) LOAD limitations (surfaced to EVERY judge that runs the suite) ─────
//
// Distinct from the sandbox-policy matrix above: this is a CPU/LOAD limitation of the vitest RUNNER
// itself, not a seatbelt POLICY deny. Under CPU saturation (a constrained few-core eval worktree, or
// other concurrent load on the machine) vitest's OWN worker/reporter RPC times out — whole
// FILES abort with `Timeout calling "onTaskUpdate"`/`onCollected` and ZERO individual failing
// assertions. Because it is load, not policy, it hits EVERY judge that runs the suite — including a
// no-OS-sandbox Claude judge that has no sandbox-policy rows — so it is surfaced through the same
// injected block, independent of backend/sandbox mode. (Prompt-side rule: src/prompts.ts.)

/** One KNOWN test-runner LOAD limitation surfaced to every judge that runs the suite (backend- and
 *  sandbox-independent — a runner CPU-saturation flake, NOT a sandbox-policy deny). */
export interface RunnerLimitation {
  /** Stable id, e.g. `vitest-worker-rpc-timeout`. */
  id: string;
  /** Signature + required UN-RUN classification + isolation-rerun confirmation + probe alignment. */
  detail: string;
}

/**
 * Pure: the KNOWN test-runner LOAD limitations surfaced to EVERY judge that runs the suite (including
 * a no-OS-sandbox Claude judge). Independent of backend / sandbox mode — a runner CPU-saturation
 * flake, not a sandbox-policy deny. No probing, exec, or fs access — a static list.
 */
export function runnerLimitations(stack: JudgeStack = UNKNOWN_JUDGE_STACK): RunnerLimitation[] {
  if (!stack.vitest) return []; // the signature below is vitest's own worker/reporter RPC
  return [
    {
      id: "vitest-worker-rpc-timeout",
      detail:
        `Under CPU saturation (a constrained few-core eval worktree, or other concurrent load on the ` +
        `machine) vitest's OWN worker/reporter RPC times out: whole test FILES abort with ` +
        `\`Timeout calling "onTaskUpdate"\` (or \`onCollected\`) and ZERO individual failing assertions. ` +
        `Decisive signature: whole-file aborts + that worker/reporter-RPC-timeout error + ZERO failing ` +
        `test ASSERTIONS. Required classification: runner CPU saturation → environment / UN-RUN — this ` +
        `is NEVER an artifact FAIL. Confirm by RE-RUNNING the aborted file(s) IN ISOLATION: green ⇒ the ` +
        `gate is SATISFIED. The UN-RUN carve-out holds ONLY on the COMPLETE signature (RPC timeout + ` +
        `whole-file abort + zero individual assertion failures) AND a PASSING isolation rerun; an ` +
        `isolation rerun that produces a REAL assertion failure / nonzero result does NOT satisfy the ` +
        `carve-out and REMAINS an artifact signal. Concurrent-probe alignment: when this documented ` +
        `flake applies, put the concurrent-load repetition on the FOCUSED / diff-touched suites, NOT a ` +
        `second simultaneous FULL suite (which manufactures exactly this saturation).`,
    },
  ];
}

/**
 * Render the KNOWN runner LOAD-limitation list into a prompt block. Always non-empty — every judge
 * that runs the suite receives it (a no-OS-sandbox Claude judge included), because the flake is
 * runner CPU saturation, not a sandbox-policy deny that could be absent.
 */
export function runnerLimitationsText(stack: JudgeStack = UNKNOWN_JUDGE_STACK): string {
  const limits = runnerLimitations(stack);
  if (!limits.length) return ""; // a non-vitest project never meets this flake
  const lines = limits
    .map((l) => `- ${l.id}: ${l.detail}`)
    .join("\n");
  return (
    `\nKNOWN RUNNER LIMITS (test-runner CPU/LOAD limits — apply to EVERY judge that runs the suite, ` +
    `including a no-OS-sandbox Claude judge; NOT sandbox-policy denies):\n${lines}\n`
  );
}

/**
 * Render the known-capability matrix into a short prompt block for the judge's task. The
 * sandbox-policy section is present only for a judge with policy denies; the KNOWN RUNNER LIMITS
 * section (runner CPU-saturation flake) is ALWAYS appended, so a no-OS-sandbox Claude judge still
 * receives an injected block. The instruction is CLASSIFY, don't re-prove: a gate failing ONLY on a
 * listed denied capability is environment-blocked / UN-RUN (cite the error as evidence), never an
 * artifact FAIL; spend at MOST ONE confirming probe — no multi-round re-proving of a known limitation.
 */
export function sandboxCapabilityNotesText(caps: DeniedCapability[], stack: JudgeStack = UNKNOWN_JUDGE_STACK): string {
  // The SPARRA_JUDGE_SANDBOX paragraph is a promise about what the PROJECT'S suite does under the
  // flag. Asserted to a project that never reads it, it is false — and worse than noise, since it
  // pre-authorizes an UN-RUN classification for a runner that will never be invoked.
  const suiteBlock = stack.judgeSandboxSeam
    ? `\n\nThis session runs the test suite with SPARRA_JUDGE_SANDBOX=1: every socket-dependent real-bin/tsx ` +
      `suite vitest-SKIPS visibly under that flag, so the FULL suite is EXPECTED green here. A NONZERO ` +
      `full-suite exit is therefore a REAL artifact signal — NOT auto-classifiable as UN-RUN / ` +
      `environment-blocked / "mixed" — investigate the actual failing test.` +
      (stack.vitest
        ? ` EXCEPTION: the worker/reporter-RPC-timeout signature in KNOWN RUNNER LIMITS below (whole files ` +
          `aborting on \`Timeout calling "onTaskUpdate"\`/\`onCollected\` with zero failing assertions) is runner ` +
          `CPU saturation, so it does NOT count as that REAL artifact signal — classify it UN-RUN per that entry.`
        : "")
    : "";
  const sandboxBlock =
    caps.length === 0
      ? ""
      : `\nKNOWN SANDBOX CAPABILITY LIMITS (policy denies, independent of path/TMPDIR writability — do NOT re-prove):\n` +
        `${caps.map((c) => `- ${c.capability}: ${c.detail}`).join("\n")}${suiteBlock}\n\n` +
        `If some OTHER gate fails ONLY because of a listed denied capability, classify THAT one ` +
        `environment-blocked / UN-RUN (cite the exact error as evidence) — it is NOT an artifact FAIL. Spend ` +
        `AT MOST ONE confirming probe; do not re-prove a known limitation across multiple rounds. A live ` +
        `harness-side probe is impossible (the harness runs OUTSIDE your sandbox), so this matrix is the source of truth.\n`;
  return sandboxBlock + runnerLimitationsText(stack);
}

/**
 * Where a judge that wants to WRITE something is supposed to write it.
 *
 * Writing an adversarial probe is a legitimate and valuable thing for a judge to do — on one project
 * a later evaluator found a real data-loss defect precisely by writing a round-trip test. But the
 * artifact tree is off limits: the source-integrity guard reverts any write to the graded surface
 * and marks the verdict untrustworthy, which is correct and worked exactly as designed in the field
 * (an evaluator's `EvaluatorAdversarialTests.swift` was caught, reverted, and the verdict distrusted).
 * The gap was upstream of the guard: nothing ever TOLD the judge where its writable scratch was, so a
 * judge that wanted a probe kept reaching for the only tree it knew about.
 *
 * `$TMPDIR` is redirected per-session to a scratch root OUTSIDE the workspace (see the file header),
 * so `mktemp -d` already lands in the right place — the judge just has to know that, and know that a
 * probe needing to compile inside a package must take a COPY of the tree with it.
 *
 * Emitted only for a judge that can actually write (a read-only sandbox blocks writes anyway, so the
 * paragraph would be noise there).
 */
export function judgeWriteScratchText(): string {
  return (
    `\nWRITABLE SCRATCH (your writes have a home — the artifact tree is not it):\n` +
    `- \`$TMPDIR\` is redirected for this session to a scratch root OUTSIDE the workspace. \`mktemp -d\` ` +
    `lands there. Put probes, fixtures, helper scripts, screenshots, build output and derived data there.\n` +
    `- The graded tree is INTEGRITY-GUARDED: any write to a tracked or new source file is reverted and ` +
    `your verdict is reported untrustworthy — so a probe written INTO the artifact costs you the whole ` +
    `evaluation, however good the probe was.\n` +
    `- To exercise a probe that must compile inside the project (a test in a package, a fixture a build ` +
    `reads), COPY the tree into \`$(mktemp -d)\` and work in the copy; cite it as evidence normally.\n`
  );
}

/**
 * Convenience for the injection sites: the capability-notes block for a judge on `backendId` with a
 * given sandbox mode + scratch state. `hasOsSandbox` is resolved by the caller from the backend
 * registry (keeps THIS module free of an sdk import). Always returns the KNOWN RUNNER LIMITS block
 * (the runner CPU-saturation flake) — so even a no-OS-sandbox Claude judge with no sandbox-policy
 * rows receives an injected block; a policy-denied judge additionally gets the sandbox-limits block.
 */
export function judgeCapabilityNotesText(args: {
  backendId: string;
  hasOsSandbox: boolean;
  sandboxMode: JudgeSandboxMode;
  scratchEnabled: boolean;
  /** The graded project's workspace — its stack decides which notes are TRUE here. Omitted (or a
   *  workspace with no Node/vitest evidence) → no Node-ecosystem instructions are emitted at all. */
  workspaceDir?: string;
}): string {
  const stack = args.workspaceDir ? detectJudgeStack(args.workspaceDir) : UNKNOWN_JUDGE_STACK;
  return (
    sandboxCapabilityNotesText(sandboxCapabilityNotes({ ...args, stack }), stack) +
    // Only a judge that CAN write needs telling where to put it.
    (args.scratchEnabled ? judgeWriteScratchText() : "")
  );
}

/**
 * Told-not-inferred note for a contract-evaluator that HAS the verify-Bash allow-hook wired for
 * this run (an isolated-worktree boundary with `verifyCommands` non-empty — see
 * `negotiateContract`/`runRoleInPlace`'s `contractEvaluatorGuard` wiring). Without this the judge
 * has no way to know Bash is even usable here (the shared `allowVerifyBash` grammar is
 * conservative and silent on rejection) and would default to classifying every configured command
 * UN-RUN, the same as the read-only boundary — re-litigating a capability the harness already
 * proved rather than exercising it. Returns "" when there is nothing to run (empty list), so a
 * read-only/in-place judge gets no note.
 */
export function contractEvaluatorVerifyNoteText(verifyCommands: string[]): string {
  if (!verifyCommands.length) return "";
  return (
    `\nVERIFICATION AVAILABLE on this run: you CAN run the project's configured checks via Bash to ` +
    `confirm a proposed "I will verify by" command actually works AS WRITTEN, instead of classifying ` +
    `it UN-RUN. Use these commands AS WRITTEN: ${verifyCommands.slice(0, 6).join(", ")} — run them, ` +
    `READ the output. Auto-approved Bash shapes: (a) the exact listed command (a \`<cmd> -- <args>\` ` +
    `suffix is fine — it still starts with the allowed command); (b) a leading LITERAL env-var ` +
    `assignment (plain identifier key, metacharacter-free value); (c) piping into a read-only text ` +
    `filter (\`| tail\`, \`| head\`, \`| grep\`, \`| wc -l\`). Anything else — chaining (\`&&\`/\`;\`), ` +
    `file redirects, \`cd X &&\`/\`git -C <abs>\` wrapping, subshell/command-substitution, installs, ` +
    `network, or a command not on this list — is NOT auto-approved and will be denied.\n`
  );
}
