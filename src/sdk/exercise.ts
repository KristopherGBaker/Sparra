import { spawn } from "node:child_process";
import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ExerciseMechanism, SparraConfig } from "../config.ts";

/** What the evaluator gets to EXERCISE the artifact, chosen by config.exercise.mechanism. */
export interface Exerciser {
  mcpServers: Record<string, McpServerConfig>;
  /** MCP tool globs to auto-allow for the evaluator. */
  allowedTools: string[];
  /** Mechanism-specific guidance injected into the evaluator's task prompt. */
  guidance: string;
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true });
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
  const { cli, scheme, simulator } = config.exercise.ios;
  const schemeHint = scheme ? `"${scheme}"` : "(discover it with the CLI)";
  const simHint = simulator || "(pick an available simulator)";
  if (!cli.trim()) {
    return `This is an Apple-platform app. Use run_command/Bash to drive xcodebuild + xcrun simctl (scheme: ${schemeHint}, simulator: "${simHint}"). Build, boot the simulator, install & launch, then exercise. Pipe \`xcodebuild\` through \`xcbeautify -qq\` for concise logs — \`set -o pipefail; xcodebuild … | xcbeautify -qq\` (pipefail so a build failure still surfaces; re-run without \`-qq\`/xcbeautify for full logs when diagnosing; if xcbeautify isn't installed, use plain xcodebuild — don't fail over it). For UI work, screenshot with \`xcrun simctl io booted screenshot <file>\` INTO the artifact dir and OPEN it with the Read tool to judge the UI visually; back every UI assertion with a screenshot you viewed — no evidence → FAIL. Native builds are slow: pass a generous timeout_ms (up to the 600000 max).`;
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

Every UI assertion in the contract must be backed by a screenshot you viewed or a hierarchy entry you found. No evidence → FAIL.`;
}

/**
 * Build the exerciser for a given mechanism. The artifact directory (the cwd the
 * generator built into) is captured so commands run in the right place.
 */
export function buildExerciser(config: SparraConfig, artifactDir: string): Exerciser {
  const mech: ExerciseMechanism = config.exercise.mechanism;

  const runCommand = tool(
    "run_command",
    "Run a shell command against the built artifact and capture exit code, stdout, and stderr. Use this to EXERCISE the artifact and assert on real behavior — do not just read the diff.",
    {
      command: z.string().describe("Shell command to execute in the artifact directory"),
      timeout_ms: z.number().optional().describe("Timeout in ms (default 60000, max 600000 — native builds are slow)"),
    },
    async (args) => {
      const timeout = Math.min(args.timeout_ms ?? 60_000, 600_000);
      const r = await runShell(args.command, artifactDir, timeout);
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
        return block(`${args.method ?? "GET"} ${args.url}\n[status: ${res.status}]\n\n${text}`);
      } catch (e) {
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

  return {
    mcpServers: { exercise: server },
    allowedTools: ["mcp__exercise__run_command", ...(mech === "web" ? ["mcp__exercise__http_request"] : [])],
    guidance: guidanceByMech[mech],
  };
}
