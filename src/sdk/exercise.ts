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
      timeout_ms: z.number().optional().describe("Timeout in ms (default 60000, max 180000)"),
    },
    async (args) => {
      const timeout = Math.min(args.timeout_ms ?? 60_000, 180_000);
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
    cli: `This is a CLI tool. Exercise it with mcp__exercise__run_command: invoke the built binary/entrypoint with real arguments, assert on exit codes and stdout/stderr. Test the happy path AND error paths (bad flags, missing args, edge inputs).`,
    web: `This is a web app. If a server must be running, start it (config.exercise.web.startCommand: "${config.exercise.web.startCommand}") with run_command in the background, then probe ${config.exercise.web.baseUrl} via mcp__exercise__http_request. Assert on status codes and response bodies. (For richer UI flows, a Playwright/Chrome MCP can be wired in via config.)`,
    ios: `This is an Apple-platform app. Use run_command to drive xcrun simctl / xcodebuild test (scheme: "${config.exercise.ios.scheme}", simulator: "${config.exercise.ios.simulator}"). Build, boot the simulator, run XCUITests, and assert on test results. (XcodeBuildMCP can be wired in via config for accessibility automation.)`,
    "computer-use": `Exercise the artifact end-to-end as a user would, via run_command and any available automation. Assert on observable behavior, not source.`,
    custom: `Use this project-specific exercise recipe with run_command:\n${config.exercise.customRecipe || "(no customRecipe configured)"}`,
  };

  return {
    mcpServers: { exercise: server },
    allowedTools: ["mcp__exercise__run_command", ...(mech === "web" ? ["mcp__exercise__http_request"] : [])],
    guidance: guidanceByMech[mech],
  };
}
