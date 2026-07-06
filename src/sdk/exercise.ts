import { spawn } from "node:child_process";
import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ExerciseMechanism, SparraConfig } from "../config.ts";
import { mergedBuildEnv, stringProcessEnv } from "../build/env.ts";
import type { ExerciseStatus } from "../build/types.ts";

/** What the evaluator gets to EXERCISE the artifact, chosen by config.exercise.mechanism. */
export interface Exerciser {
  mcpServers: Record<string, McpServerConfig>;
  /** MCP tool globs to auto-allow for the evaluator. */
  allowedTools: string[];
  /** Mechanism-specific guidance injected into the evaluator's task prompt. */
  guidance: string;
  /**
   * The HARNESS's deterministic verdict on whether the exercise actually ran, aggregated from
   * every `run_command`/`http_request` the evaluator invoked through this exerciser:
   * "blocked" if all observations were sandbox/missing-tool/permission blocks, "mixed" if some
   * commands ran and some blocked, "ran" if ≥1 ran and none blocked, "none" if it never used the
   * tools (e.g. it only used raw Bash, which we don't observe). This OVERRIDES the model's
   * self-report so a model can't launder a blocked command into a pass.
   */
  exerciseStatus(): ExerciseStatus | "none";
}

/**
 * Spawn/sandbox/permission signatures that indicate a command DID NOT actually execute (case-
 * insensitive). Deliberately narrow — a passing or normally-failing command can legitimately print
 * "no such file or directory", a bare "not permitted", or "sandbox", so those are EXCLUDED.
 */
const BLOCK_SIGNATURES = [
  "command not found",
  "eperm",
  "operation not permitted",
  "permission denied",
  "requires approval",
] as const;

function hasBlockSignature(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return BLOCK_SIGNATURES.some((sig) => s.includes(sig));
}

/**
 * Pure: classify ONE command result as a real run vs an environment block, in PRECEDENCE ORDER:
 *  1. code===0          → ran (it executed; ignore stderr entirely)
 *  2. timedOut===true   → ran (it executed long enough to be killed — checked BEFORE the -1 rule)
 *  3. code===127        → blocked (shell could not find the command)
 *  4. code===-1 (spawn) → blocked IFF stderr matches a spawn-error signature, else ran
 *  5. code!==0 && stderr matches a block signature → blocked
 *  6. else              → ran (a command that executed and failed, e.g. exit 1/2, is a real run)
 */
export function classifyExerciseExit(r: { code: number; stderr: string; timedOut: boolean }): "blocked" | "ran" {
  if (r.code === 0) return "ran";
  if (r.timedOut) return "ran";
  if (r.code === 127) return "blocked";
  if (r.code === -1) return hasBlockSignature(r.stderr) ? "blocked" : "ran";
  return hasBlockSignature(r.stderr) ? "blocked" : "ran";
}

/** Pure: aggregate per-command classifications — all-blocked stays blocked; ran+blocked is mixed. */
export function exerciseStatusFromObservations(obs: ("blocked" | "ran")[]): ExerciseStatus | "none" {
  const blocked = obs.some((o) => o === "blocked");
  const ran = obs.some((o) => o === "ran");
  if (blocked && ran) return "mixed";
  if (blocked) return "blocked";
  if (ran) return "ran";
  return "none";
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  env: Record<string, string>,
  spawnFn: typeof spawn = spawn
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawnFn(command, { cwd, shell: true, env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = 60_000;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString().slice(0, cap - stdout.length)));
    child.stderr.on("data", (d) => (stderr += d.toString().slice(0, cap - stderr.length)));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e), timedOut });
    });
  });
}

function block(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Guidance for Apple-platform apps. Drives the `xcodebuildmcp` CLI (preferred over
 * raw xcodebuild/xcrun/simctl) and — crucially — exploits the fact that the
 * evaluator is multimodal: it screenshots the running UI and READS the image to
 * judge it, and uses the UI hierarchy for deterministic assertions. The CLI is
 * help-first, so we tell the evaluator to discover commands rather than guess
 * (Sparra runs with settingSources:[], so the user's own CLI skill is not loaded).
 */
export function iosGuidance(config: SparraConfig): string {
  const { cli, scheme, simulator, platform, visual } = config.exercise.ios;
  const schemeHint = scheme ? `"${scheme}"` : "(discover it with the CLI)";
  const simHint = simulator || "(pick an available simulator)";
  // macOS apps have NO simulator: build & run the .app on the host, and observe/drive the UI
  // via an XCUITest target (the simulator screenshot/ui-automation tooling does not apply).
  if (platform === "macos") return macosGuidance(cli, schemeHint);
  // The VISUAL-VERIFICATION recipe (screenshots + animation contact sheets) is stated ONCE here and
  // appended to whichever iOS guidance we return — but only when the knob is on, so knob-off iOS
  // output stays byte-identical to before this capability existed.
  const visualTail = visual ? visualRecipe() : "";
  if (!cli.trim()) {
    return `This is an Apple-platform app. Use run_command/Bash to drive xcodebuild + xcrun simctl (scheme: ${schemeHint}, simulator: "${simHint}"). Build, boot the simulator, install & launch, then exercise. Pipe \`xcodebuild\` through \`xcbeautify -qq\` for concise logs — \`set -o pipefail; xcodebuild … | xcbeautify -qq\` (pipefail so a build failure still surfaces; re-run without \`-qq\`/xcbeautify for full logs when diagnosing; if xcbeautify isn't installed, use plain xcodebuild — don't fail over it). For UI work, screenshot with \`xcrun simctl io booted screenshot <file>\` INTO the artifact dir and OPEN it with the Read tool to judge the UI visually; back every UI assertion with a screenshot you viewed — no evidence → FAIL unless the gate could not execute for an environment reason (mark UN-RUN). Native builds are slow: pass a generous timeout_ms (up to the 600000 max).${visualTail}`;
  }
  return `This is an Apple-platform app (iOS/macOS/etc.). EXERCISE the real running app — never grade the diff.

Drive the \`${cli}\` CLI via run_command (preferred over raw xcodebuild/xcrun/simctl). It is HELP-FIRST — discover commands and args from the CLI itself instead of guessing or memorizing tool names:
  ${cli} --help
  ${cli} tools
  ${cli} <workflow> --help
First verify it exists (\`${cli} --help\`); if it is missing, fall back to xcodebuild/xcrun/simctl and say so in your notes (do not fail the evaluation over tooling).

Build & run (scheme: ${schemeHint}, simulator: "${simHint}"):
- RESOLVE THE SIMULATOR FIRST: list what's actually installed (\`xcrun simctl list devices available\`, or the CLI's sim-list). If the configured simulator is blank or not installed on this machine, pick an available iPhone simulator and use it — note which one. Do NOT fail because a specific model name isn't present (device line-ups change yearly).
- If the project is defined with XcodeGen (a project.yml is present) and the .xcodeproj is missing or stale, run \`xcodegen generate\` first.
- Prefer the combined build-and-run for simulator run intent; do not chain build then build-and-run. For macOS, build and launch the .app.
- Build into a TEMPORARY derived-data path (e.g. \`-derivedDataPath "$(mktemp -d)"\`) — do not write build output into the project directory.
- If you fall back to raw \`xcodebuild\`, pipe it through \`xcbeautify -qq\` for concise logs: \`set -o pipefail; xcodebuild … | xcbeautify -qq\` (pipefail so a build failure still fails the command). Re-run without \`-qq\`/xcbeautify for full output when a build error needs diagnosing; if xcbeautify isn't installed, use plain xcodebuild — don't fail over it. (\`xcbeautify\` also tidies \`swift build\`/\`swift test\` output.)
- Native builds can exceed 60s — pass a generous timeout_ms to run_command (up to the 600000 max).

For UI changes (the important part — you are MULTIMODAL, use it):
- SANITY-CHECK THE SCREEN SIZE FIRST. If the app reports a legacy frame (e.g. 320x480 or 375x667) on a modern simulator, or the screenshot shows black bars top/bottom, the app is LETTERBOXED because it has no launch screen — that is an APP DEFECT (it doesn't render fullscreen AND it breaks coordinate-based tap/type, making input land off-target). Flag it as a real craft defect; do NOT write off off-target taps as a tooling problem. The fix is a launch screen (e.g. INFOPLIST_KEY_UILaunchScreen_Generation=YES or a UILaunchScreen Info.plist entry).
- Write screenshots and any helper scripts to a TEMP scratch dir (e.g. \`$(mktemp -d)\`), not the project directory.
- Capture a screenshot of the relevant screen/state, then OPEN it with the Read tool and actually LOOK: judge layout, spacing, states, and whether the change matches the contract.
- Drive real flows with the CLI's UI automation (tap / type / swipe / gesture) to reach the states the contract describes — don't just inspect the launch screen.
- Use the UI hierarchy / describe-ui output for DETERMINISTIC assertions (e.g. "a control labelled 'Sign In' is visible and enabled") and cite it as evidence. Screenshots justify taste; the hierarchy justifies pass/fail.
- Capture logs when behavior is dynamic.

Every UI assertion in the contract must be backed by a screenshot you viewed or a hierarchy entry you found. No evidence → FAIL unless the gate could not execute for an environment reason (mark UN-RUN).${visualTail}`;
}

/**
 * The VISUAL-VERIFICATION recipe appended to iOS guidance when `exercise.ios.visual` is on. Stated
 * ONCE (single source of truth — docs quote it, the generator side carries only the launch-arg
 * clause): a static screenshot chain, an animation `recordVideo`→ffmpeg contact-sheet chain the
 * multimodal evaluator READS, the timing caveats that make animation capture actually work, the
 * `#if DEBUG` launch-arg deterministic-reach convention, the honest boundary the evidence must
 * state, and the UN-RUN semantics for every visual gate (never a fail, never a fallback pass).
 * Prefixed with a leading blank line so it appends cleanly to the guidance body.
 */
function visualRecipe(): string {
  return `

VISUAL VERIFICATION (exercise.ios.visual is ON — you are MULTIMODAL; code review is BLIND to layout/motion, so back Simulator-runnable UI/animation contract claims with captures you READ):
- STATIC UI (screenshot): boot a simulator (\`xcrun simctl boot <udid>\`), build into a repo-local derived-data dir (\`-derivedDataPath\` at a repo-local path) — when you drive raw \`xcodebuild\` for an unsigned Simulator build pass \`CODE_SIGNING_ALLOWED=NO\` (unsigned Sim + SPM resource bundles) — then \`xcrun simctl install <udid> <app>\`, \`xcrun simctl launch <udid> <bundle> <launch-args>\`, and \`xcrun simctl io <udid> screenshot <file>.png\`. READ the PNG with the Read tool and judge it; complement the pixels with an accessibility-hierarchy dump for deterministic assertions.
- ANIMATION / TRANSITION (contact sheet): record around a scripted trigger with \`xcrun simctl io <udid> recordVideo --codec=h264 <file>.mov\` (h264, NOT hevc — ffmpeg decode compatibility), then tile frames into ONE image: \`ffmpeg -i <clip> -vf "fps=N,scale=W:-2,tile=CxR" <sheet>.png\` — always \`scale=W:-2\` for the height (the \`-2\` auto-picks an EVEN height; a \`-1\`/odd output height makes ffmpeg fail). READ that single contact sheet and judge the start→mid→end geometry. Two-pass: a COARSE sheet over the FULL clip to LOCATE the motion, then a DENSE sheet over a NARROW window around the transition to JUDGE it.
- TIMING: \`window.layer.speed\` does NOT slow SYSTEM-driven transitions (e.g. a UINavigation \`preferredTransition = .zoom\`) — only a custom \`UIViewControllerAnimatedTransitioning\` animator with an EXPLICIT duration is slow-mo-able; the Simulator's ⌘T Slow-Animations toggle is GUI-only (not CLI-scriptable). A system transition can be ~0.15s, so capture at HIGH fps and sample DENSELY around the window (accept a sparse peak).
- DETERMINISTIC REACH: use the app's \`#if DEBUG\` launch-arg hooks via \`simctl launch … <args>\` to jump straight to the state under test (set a feature flag, skip onboarding, seed a fixture, optionally auto-trigger the interaction) — don't hand-navigate.
- HONEST BOUNDARY — your evidence MUST state this and never imply more: these captures PROVE geometry / layout / nav structure / transition shape ONLY. They do NOT prove motion feel, jank, frame pacing (120 Hz), gesture interruptibility, or Simulator-gated GPU/ML (Metal / Neural Engine) paths — never claim those from a screenshot or contact sheet.
- UN-RUN semantics (ALL visual gates): if the Simulator is unavailable (or \`recordVideo\`/\`ffmpeg\` for an animation gate), the affected visual gates — static screenshot gates INCLUDED — are UN-RUN (environment-blocked), never FAILED and never passed via a weaker fallback. A screenshot only SUPPLEMENTS a static-UI check; it NEVER substitutes for an animation gate.`;
}

/**
 * Guidance for a macOS app (no simulator). xcodebuildmcp's screenshot / ui-automation suite is
 * SIMULATOR-ONLY, and its `macos` workflow has no UI tools — so a Mac app's UI is observed and
 * driven through an XCUITest target (run via `macos test`), whose XCUIScreenshots we extract from
 * the .xcresult and READ, plus a live `screencapture`. XCUITest is the deterministic spine;
 * AX/osascript synthetic events are avoided (they need interactive Accessibility permission).
 */
function macosGuidance(cli: string, schemeHint: string): string {
  const drive = cli.trim() ? `the \`${cli}\` macos workflow via run_command` : "xcodebuild + the macOS tools";
  return `This is a macOS app (no iOS Simulator — you build and run the real \`.app\` on THIS Mac). EXERCISE the running app — never grade the diff.

Drive ${drive}. xcodebuildmcp's \`screenshot\`/\`ui-automation\` tools are SIMULATOR-ONLY and DO NOT work here; its \`macos\` workflow (build / build-and-run / launch / stop / test / get-app-path) does. It is HELP-FIRST — discover commands/args from the CLI (\`${cli || "xcodebuild"} --help\`, \`${cli} macos --help\`) rather than guessing; if \`${cli}\` is missing, fall back to raw \`xcodebuild\` and say so in notes (don't fail over tooling).

Build & run (scheme: ${schemeHint}):
- If a project.yml is present (XcodeGen) and the .xcodeproj is missing/stale, run \`xcodegen generate\` first.
- Build into a TEMPORARY derived-data path (\`-derivedDataPath "$(mktemp -d)"\`); don't write build output into the project dir. Pipe raw \`xcodebuild\` through \`xcbeautify -qq\` — \`set -o pipefail; xcodebuild … | xcbeautify -qq\` (pipefail so a failure still fails; re-run verbose to diagnose; plain xcodebuild if xcbeautify is absent).
- Native builds are slow — pass a generous timeout_ms (up to the 600000 max).
- Launch with any required env/launch-args (e.g. a sample-data flag the contract names) by running the binary directly: \`ENV=1 "<app>/Contents/MacOS/<exe>" &\` (get <app> via \`${cli} macos get-app-path\` or the build settings), or via the CLI's macos launch.

Observe & DRIVE the UI — the macOS way (you are MULTIMODAL; use it):
- DETERMINISTIC SPINE = XCUITest. Run the app's UI-test target (\`${cli} macos test\`, or \`set -o pipefail; xcodebuild test -scheme ${schemeHint} -only-testing:<UITestTarget> -resultBundlePath "$(mktemp -d)/r.xcresult" -destination 'platform=macOS' | xcbeautify -qq\`). XCUITest drives the real app — \`XCUIApplication\`, element queries, and \`.typeKey\`/\`.typeText\` for keyboard flows (Space/Delete/arrows) — and asserts. Pass/fail rides on these results. A committed UI test that crashes or doesn't run AS SHIPPED is a real defect (BROKEN HARNESS), not a pass.
- READ the visual evidence: XCUITest attaches \`XCUIScreenshot\`s — extract them from the .xcresult (\`xcrun xcresulttool export attachments --path <r>.xcresult --output-path <dir>\`, or \`xcrun xcresulttool get --path <r>.xcresult --format json\` to find attachment ids) and OPEN the PNGs with the Read tool. Actually LOOK: layout, spacing, states, and whether it matches the contract.
- LIVE visual sanity: with the app launched, \`screencapture -x -o <file>\` (whole screen) or window-targeted (\`-l<windowID>\` from \`CGWindowListCopyWindowInfo\`/\`osascript\`) into a TEMP dir, then Read it. Screenshots justify taste; XCUITest assertions justify pass/fail.
- Capture logs when behavior is dynamic. Don't rely on AX/osascript synthetic events as the drive mechanism (they need interactive Accessibility permission and are unreliable headless) — use XCUITest.

Every UI assertion in the contract must be backed by an XCUITest assertion you ran or a screenshot you viewed. No evidence → FAIL unless the gate could not execute for an environment reason (mark UN-RUN).`;
}

/**
 * Preamble prepended to the exercise guidance for an evaluator backend that CANNOT host the
 * in-process exercise MCP server (`BackendCapabilities.inProcessMcp === false`, e.g. Codex). It
 * states the honest boundary: there is no `mcp__exercise__*` tool, the harness cannot observe or
 * classify exit codes, so the evaluator exercises via its OWN native command runner and sets
 * `exerciseStatus` truthfully from what it actually ran. Stated ONCE here (single source of truth).
 */
const NATIVE_RUNNER_PREAMBLE =
  "NOTE — this evaluator backend cannot host the in-process exercise MCP server, so there is NO harness exercise tool available and the harness CANNOT observe or classify exit codes for you. Exercise the artifact via your OWN native command runner (your shell/Bash), assert on real exit codes and output, and set `exerciseStatus` HONESTLY from what you actually ran and saw — do NOT claim a harness-observed run.";

/**
 * The evaluator base-template PROCESS-step run-instruction ({{EXERCISE_RUN_INSTRUCTION}}), made
 * backend-aware so a no-in-process-MCP evaluator (Codex) never carries the phantom
 * `mcp__exercise__run_command` mandate in its STATIC system prompt. Single source of truth, filled at
 * BOTH assembly sites (roleRun.ts `roleSystemPrompt`, evaluate.ts).
 * - `inProcessMcp === true`  → run gates via the harness `mcp__exercise__run_command` (it classifies
 *   exit codes + sets exerciseStatus). Unchanged from before this capability existed.
 * - `inProcessMcp === false` → run gates via the native command runner; the harness cannot classify
 *   exit codes here, so `exerciseStatus` is self-reported honestly. Contains ZERO `mcp__exercise__`
 *   token (assertion 5).
 */
export function exerciseRunInstruction(inProcessMcp: boolean): string {
  return inProcessMcp
    ? "Run via `mcp__exercise__run_command` (not raw Bash) so the harness classifies exit codes and sets exerciseStatus — Bash-run commands are unobserved and fall back to self-report."
    : "Run gates via your native command runner (your shell/Bash): this backend has no harness exercise tool, so the harness cannot classify exit codes for you — set exerciseStatus HONESTLY from what you actually ran (do not claim a harness-observed run).";
}

/**
 * Rewrite mechanism guidance for a no-in-process-MCP backend: strip every `mcp__exercise__*` /
 * bare `run_command`/`http_request` tool reference (those tools don't exist there) into a
 * native-command-runner reference, and prepend the honest-report preamble. The SUBSTANCE (exercise
 * real behavior, assert on exit codes/output, don't grade the diff) is unchanged — only the
 * tool-reference wording. Branched ONCE here so per-mechanism strings aren't duplicated.
 */
export function nativeRunnerGuidance(guidance: string): string {
  const rewritten = guidance
    .replaceAll("mcp__exercise__run_command", "your shell/Bash")
    .replaceAll("mcp__exercise__http_request", "your shell (e.g. curl)")
    .replaceAll("http_request", "your shell (e.g. curl)")
    .replaceAll("run_command", "your shell/Bash");
  return `${NATIVE_RUNNER_PREAMBLE}\n\n${rewritten}`;
}

/**
 * Build the exerciser for a given mechanism. The artifact directory (the cwd the
 * generator built into) is captured so commands run in the right place.
 *
 * `inProcessMcp` (default true) reflects whether the EVALUATOR backend can host the in-process
 * exercise MCP server. When false (e.g. a Codex evaluator), the `guidance` is rewritten to drop the
 * phantom `mcp__exercise__*` tool mandate and instruct exercising via the native runner instead —
 * the caller ALSO must not attach `mcpServers`/`allowedTools` (they'd be silently dropped). Default
 * true keeps the Claude path byte-for-byte.
 */
export function buildExerciser(
  config: SparraConfig,
  artifactDir: string,
  opts: { spawnFn?: typeof spawn; inProcessMcp?: boolean } = {}
): Exerciser {
  const mech: ExerciseMechanism = config.exercise.mechanism;
  const env = mergedBuildEnv(config) ?? stringProcessEnv();

  // Harness-owned observation log: one classification per tool invocation. The TEXT returned to the
  // model is unchanged (additive); this is what makes the harness — not the model's self-report —
  // authoritative for whether a run_command/http_request exercise actually ran.
  const observations: ("blocked" | "ran")[] = [];

  const runCommand = tool(
    "run_command",
    "Run a shell command against the built artifact and capture exit code, stdout, and stderr. Use this to EXERCISE the artifact and assert on real behavior — do not just read the diff.",
    {
      command: z.string().describe("Shell command to execute in the artifact directory"),
      timeout_ms: z.number().optional().describe("Timeout in ms (default 60000, max 600000 — native builds are slow)"),
    },
    async (args) => {
      const timeout = Math.min(args.timeout_ms ?? 60_000, 600_000);
      const r = await runShell(args.command, artifactDir, timeout, env, opts.spawnFn);
      observations.push(classifyExerciseExit(r));
      return block(
        `$ ${args.command}\n[cwd: ${artifactDir}]\n[exit code: ${r.code}${r.timedOut ? " — TIMED OUT" : ""}]\n\n--- stdout ---\n${r.stdout || "(empty)"}\n\n--- stderr ---\n${r.stderr || "(empty)"}`
      );
    }
  );

  const httpRequest = tool(
    "http_request",
    "Make an HTTP request against a running web artifact and return status + body snippet.",
    {
      url: z.string().describe("Full URL to request"),
      method: z.string().optional().describe("HTTP method (default GET)"),
      body: z.string().optional().describe("Request body"),
    },
    async (args) => {
      try {
        const res = await fetch(args.url, { method: args.method ?? "GET", body: args.body });
        const text = (await res.text()).slice(0, 8000);
        observations.push("ran"); // the request reached a server and returned — a real exercise
        return block(`${args.method ?? "GET"} ${args.url}\n[status: ${res.status}]\n\n${text}`);
      } catch (e) {
        // A failed fetch (e.g. connection refused) is classified like a spawn error: only a block
        // signature counts as blocked; an ordinary connection failure is a real (failed) run.
        observations.push(classifyExerciseExit({ code: -1, stderr: String(e), timedOut: false }));
        return { ...block(`Request failed: ${String(e)}`), isError: true };
      }
    }
  );

  const tools = mech === "web" ? [runCommand, httpRequest] : [runCommand];
  const server = createSdkMcpServer({ name: "exercise", version: "0.1.0", tools });

  const guidanceByMech: Record<ExerciseMechanism, string> = {
    cli: `This is a CLI tool. Exercise it with mcp__exercise__run_command: invoke the built binary/entrypoint with real arguments, assert on exit codes and stdout/stderr. Test the happy path AND error paths (bad flags, missing args, edge inputs). If it's a SwiftPM package, pipe \`swift build\`/\`swift test\` through \`xcbeautify -qq\` for concise logs — \`set -o pipefail; swift test … | xcbeautify -qq\` (pipefail so a failure still fails the command); re-run plain/verbose to diagnose, and use the plain command if xcbeautify isn't installed (don't fail over tooling).`,
    web: `This is a web app. If a server must be running, start it (config.exercise.web.startCommand: "${config.exercise.web.startCommand}") with run_command in the background, then probe ${config.exercise.web.baseUrl} via mcp__exercise__http_request. Assert on status codes and response bodies. (For richer UI flows, a Playwright/Chrome MCP can be wired in via config.)`,
    ios: iosGuidance(config),
    "computer-use": `Exercise the artifact end-to-end as a user would, via run_command and any available automation. Assert on observable behavior, not source.`,
    custom: `Use this project-specific exercise recipe with run_command:\n${config.exercise.customRecipe || "(no customRecipe configured)"}`,
  };

  const inProcessMcp = opts.inProcessMcp ?? true;
  return {
    mcpServers: { exercise: server },
    allowedTools: ["mcp__exercise__run_command", ...(mech === "web" ? ["mcp__exercise__http_request"] : [])],
    guidance: inProcessMcp ? guidanceByMech[mech] : nativeRunnerGuidance(guidanceByMech[mech]),
    exerciseStatus: () => exerciseStatusFromObservations(observations),
  };
}
