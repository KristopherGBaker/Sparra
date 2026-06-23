import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  HookCallbackMatcher,
  HookEvent,
  McpServerConfig,
  Options,
  PermissionMode,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { color, detail } from "../util/log.ts";
import { TraceWriter } from "./trace.ts";

export interface RunSessionParams {
  /** Human-readable role, used for the trace filename and logs. */
  role: string;
  /** The user prompt / task for this session. */
  prompt: string;
  /** Replaces the system prompt entirely (loaded from prompts/<role>.md). */
  systemPrompt: string;
  model: string;
  effort?: Options["effort"];
  cwd: string;
  additionalDirectories?: string[];

  tools?: string[]; // base tool allowlist (built-ins)
  allowedTools?: string[]; // auto-approved (incl. mcp__server__tool globs)
  disallowedTools?: string[];
  permissionMode: PermissionMode;
  canUseTool?: CanUseTool;
  /** PreToolUse (etc.) deny-hooks — the authoritative scope/safety enforcement. */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  mcpServers?: Record<string, McpServerConfig>;

  resume?: string;
  forkSession?: boolean;
  maxTurns?: number;
  maxBudgetUsd?: number;

  /** Where to write the transcript markdown, and the seq number within the run. */
  traceDir: string;
  traceSeq: number;

  /** Called with each assistant text block as it streams (for live interactive UX). */
  onAssistantText?: (text: string) => void;
  /** Structured event stream for non-console front-ends (e.g. the Ink TUI). */
  onEvent?: (e: SessionEvent) => void;
  /** Print a compact live activity line for tool use (default true for non-interactive). */
  echoActivity?: boolean;
  abortController?: AbortController;
}

export type SessionEvent =
  | { kind: "init"; sessionId: string; model: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "result"; ok: boolean; costUsd: number; subtype: string };

export interface RunResult {
  ok: boolean;
  subtype: string;
  resultText: string;
  sessionId: string;
  costUsd: number;
  numTurns: number;
  hitMaxTurns: boolean;
  hitBudget: boolean;
  errors: string[];
  tracePath: string;
}

/**
 * The single choke point for talking to the Agent SDK. Every role goes through
 * here so tracing, usage accounting, and result extraction are uniform. The
 * filesystem (cwd) is the shared state between sessions; nothing is held in
 * memory across calls.
 */
export async function runSession(p: RunSessionParams): Promise<RunResult> {
  const header = `# ${p.role}\n\n- model: \`${p.model}\`${p.effort ? ` (effort: ${p.effort})` : ""}\n- cwd: \`${p.cwd}\`\n- permissionMode: \`${p.permissionMode}\`\n${p.resume ? `- resume: \`${p.resume}\`${p.forkSession ? " (forked)" : ""}\n` : ""}\n## Task\n\n${p.prompt}\n\n---\n`;
  const trace = TraceWriter.for(p.traceDir, p.role, p.traceSeq, header);

  const options: Options = {
    systemPrompt: p.systemPrompt,
    model: p.model,
    cwd: p.cwd,
    permissionMode: p.permissionMode,
    settingSources: [], // isolate from ambient user/project settings; FS state is explicit
  };
  if (p.effort) options.effort = p.effort;
  if (p.additionalDirectories) options.additionalDirectories = p.additionalDirectories;
  if (p.tools) options.tools = p.tools;
  if (p.allowedTools) options.allowedTools = p.allowedTools;
  if (p.disallowedTools) options.disallowedTools = p.disallowedTools;
  if (p.canUseTool) options.canUseTool = p.canUseTool;
  if (p.hooks) options.hooks = p.hooks;
  if (p.mcpServers) options.mcpServers = p.mcpServers;
  if (p.resume) options.resume = p.resume;
  if (p.forkSession) options.forkSession = p.forkSession;
  if (p.maxTurns) options.maxTurns = p.maxTurns;
  if (p.maxBudgetUsd && p.maxBudgetUsd > 0) options.maxBudgetUsd = p.maxBudgetUsd;
  if (p.abortController) options.abortController = p.abortController;

  const result: RunResult = {
    ok: false,
    subtype: "unknown",
    resultText: "",
    sessionId: "",
    costUsd: 0,
    numTurns: 0,
    hitMaxTurns: false,
    hitBudget: false,
    errors: [],
    tracePath: trace.file,
  };

  // Console echo is suppressed when a front-end consumes events/text instead.
  const echo = p.echoActivity ?? !(p.onAssistantText || p.onEvent);

  for await (const msg of query({ prompt: p.prompt, options })) {
    await trace.record(msg as SDKMessage);

    if (msg.type === "system" && (msg as any).subtype === "init") {
      result.sessionId = (msg as any).session_id;
      p.onEvent?.({ kind: "init", sessionId: result.sessionId, model: (msg as any).model });
    } else if (msg.type === "assistant") {
      const content = (msg as any).message?.content ?? [];
      for (const block of content) {
        if (block.type === "text" && block.text) {
          if (p.onAssistantText) p.onAssistantText(block.text);
          p.onEvent?.({ kind: "text", text: block.text });
        } else if (block.type === "tool_use") {
          if (echo) detail(`${color.gray("·")} ${color.cyan(block.name)} ${summarizeToolInput(block.name, block.input)}`);
          p.onEvent?.({ kind: "tool", name: block.name, summary: summarizeToolInput(block.name, block.input).replace(/\x1b\[[0-9;]*m/g, "") });
        }
      }
    } else if (msg.type === "result") {
      const m = msg as any;
      result.subtype = m.subtype;
      result.sessionId = m.session_id ?? result.sessionId;
      result.costUsd = Number(m.total_cost_usd ?? 0);
      result.numTurns = Number(m.num_turns ?? 0);
      p.onEvent?.({ kind: "result", ok: m.subtype === "success", costUsd: result.costUsd, subtype: m.subtype });
      if (m.subtype === "success") {
        result.ok = true;
        result.resultText = m.result ?? "";
      } else {
        result.errors = m.errors ?? [m.subtype];
        result.hitMaxTurns = m.subtype === "error_max_turns";
        result.hitBudget = m.subtype === "error_max_budget_usd";
      }
    }
  }

  return result;
}

function summarizeToolInput(name: string, input: any): string {
  if (!input) return "";
  if (name === "Bash") return color.gray(String(input.command ?? "").slice(0, 80));
  if (input.file_path) return color.gray(String(input.file_path));
  if (input.path) return color.gray(String(input.path));
  if (input.pattern) return color.gray(String(input.pattern));
  return "";
}
