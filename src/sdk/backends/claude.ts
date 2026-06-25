import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, PermissionMode, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { color, detail } from "../../util/log.ts";
import { extractJson } from "../../util/extract.ts";
import { TraceWriter } from "../trace.ts";
import { readOnlyHooks, scopedWriterHooks } from "../hooks.ts";
import { buildSkillPlugin } from "../skills.ts";
import {
  registerBackend,
  type AgentBackend,
  type AgentRequest,
  type AgentResult,
  type BackendCapabilities,
} from "../backend.ts";

/**
 * The Claude Agent SDK backend. This is the original `runSession` implementation,
 * now behind the AgentBackend seam. Behavior is unchanged for callers that pass the
 * Claude-specific fields (permissionMode/hooks/mcpServers/etc.); it ALSO honors the
 * backend-agnostic intent (writeScope/readOnly/outputSchema) so the same calling
 * convention the Codex backend will use already works here.
 */
class ClaudeBackend implements AgentBackend {
  readonly id = "claude";
  readonly capabilities: BackendCapabilities = {
    resume: true,
    streaming: true,
    outputSchema: false, // emulated via instruct-and-extract below
    mcp: true,
    hooks: true,
    sandbox: false,
    skills: true, // native: declared skills load via plugins + skills, settingSources stays []
    cost: "usd",
  };

  async runTask(req: AgentRequest): Promise<AgentResult> {
    // Resolve safety: prefer caller-supplied native settings; else derive from intent.
    const permissionMode: PermissionMode =
      req.permissionMode ?? (req.readOnly ? "plan" : req.writeScope?.length ? "acceptEdits" : "default");
    let hooks = req.hooks;
    if (!hooks) {
      const deny = req.denyBashContains ?? [];
      if (req.readOnly) hooks = readOnlyHooks(deny);
      else if (req.writeScope?.length) hooks = scopedWriterHooks(req.writeScope, deny);
    }

    // Structured output: Claude has no native schema mode, so instruct + extract.
    let systemPrompt = req.systemPrompt;
    if (req.outputSchema) {
      systemPrompt += `\n\nIMPORTANT: respond with ONLY a single JSON object conforming to this JSON Schema (no prose, no code fences):\n${JSON.stringify(req.outputSchema)}`;
    }

    const header = `# ${req.role}\n\n- backend: \`claude\`\n- model: \`${req.model}\`${req.effort ? ` (effort: ${req.effort})` : ""}\n- cwd: \`${req.cwd}\`\n- permissionMode: \`${permissionMode}\`\n${req.resume ? `- resume: \`${req.resume}\`${req.forkSession ? " (forked)" : ""}\n` : ""}\n## Task\n\n${req.prompt}\n\n---\n`;
    const trace = TraceWriter.for(req.traceDir, req.role, req.traceSeq, header);

    const options: Options = {
      systemPrompt,
      model: req.model,
      cwd: req.cwd,
      permissionMode,
      settingSources: [], // isolate from ambient user/project settings; FS state is explicit
    };
    if (req.effort) options.effort = req.effort;
    if (req.additionalDirectories) options.additionalDirectories = req.additionalDirectories;
    if (req.tools) options.tools = req.tools;
    if (req.allowedTools) options.allowedTools = req.allowedTools;
    if (req.disallowedTools) options.disallowedTools = req.disallowedTools;
    if (req.canUseTool) options.canUseTool = req.canUseTool;
    if (hooks) options.hooks = hooks;
    if (req.mcpServers) options.mcpServers = req.mcpServers;
    if (req.resume) options.resume = req.resume;
    if (req.forkSession) options.forkSession = req.forkSession;
    if (req.maxTurns) options.maxTurns = req.maxTurns;
    if (req.maxBudgetUsd && req.maxBudgetUsd > 0) options.maxBudgetUsd = req.maxBudgetUsd;
    if (req.abortController) options.abortController = req.abortController;

    // Declared skills load as a throwaway local plugin so settingSources can stay [] (no
    // ambient leak): only these skills become discoverable, then enabled by name.
    let skillPlugin: ReturnType<typeof buildSkillPlugin> | undefined;
    if (req.skills?.length) {
      skillPlugin = buildSkillPlugin(req.skills);
      options.plugins = [{ type: "local", path: skillPlugin.path }];
      options.skills = skillPlugin.names;
    }

    const result: AgentResult = {
      ok: false,
      subtype: "unknown",
      resultText: "",
      sessionId: "",
      costUsd: 0,
      tokens: 0,
      numTurns: 0,
      hitMaxTurns: false,
      hitBudget: false,
      errors: [],
      tracePath: trace.file,
    };

    // Console echo is suppressed when a front-end consumes events/text instead.
    const echo = req.echoActivity ?? !(req.onAssistantText || req.onEvent);

    try {
    for await (const msg of query({ prompt: req.prompt, options })) {
      await trace.record(msg as SDKMessage);

      if (msg.type === "system" && (msg as any).subtype === "init") {
        result.sessionId = (msg as any).session_id;
        req.onEvent?.({ kind: "init", sessionId: result.sessionId, model: (msg as any).model });
      } else if (msg.type === "assistant") {
        const content = (msg as any).message?.content ?? [];
        for (const block of content) {
          if (block.type === "text" && block.text) {
            if (req.onAssistantText) req.onAssistantText(block.text);
            req.onEvent?.({ kind: "text", text: block.text });
          } else if (block.type === "tool_use") {
            if (echo) detail(`${color.gray("·")} ${color.cyan(block.name)} ${summarizeToolInput(block.name, block.input)}`);
            req.onEvent?.({ kind: "tool", name: block.name, summary: summarizeToolInput(block.name, block.input).replace(/\x1b\[[0-9;]*m/g, "") });
          }
        }
      } else if (msg.type === "result") {
        const m = msg as any;
        result.subtype = m.subtype;
        result.sessionId = m.session_id ?? result.sessionId;
        result.costUsd = Number(m.total_cost_usd ?? 0);
        result.tokens = totalTokens(m.modelUsage);
        result.numTurns = Number(m.num_turns ?? 0);
        req.onEvent?.({ kind: "result", ok: m.subtype === "success", costUsd: result.costUsd, subtype: m.subtype });
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
    } finally {
      skillPlugin?.cleanup();
    }

    if (req.outputSchema && result.ok) {
      result.structured = extractJson(result.resultText) ?? undefined;
    }

    return result;
  }
}

/** Sum input+output+cache tokens across all models in a result's modelUsage map. */
function totalTokens(modelUsage: any): number {
  if (!modelUsage || typeof modelUsage !== "object") return 0;
  let total = 0;
  for (const u of Object.values(modelUsage) as any[]) {
    total +=
      Number(u?.inputTokens ?? 0) +
      Number(u?.outputTokens ?? 0) +
      Number(u?.cacheReadInputTokens ?? 0) +
      Number(u?.cacheCreationInputTokens ?? 0);
  }
  return total;
}

function summarizeToolInput(name: string, input: any): string {
  if (!input) return "";
  if (name === "Bash") return color.gray(String(input.command ?? "").slice(0, 80));
  if (input.file_path) return color.gray(String(input.file_path));
  if (input.path) return color.gray(String(input.path));
  if (input.pattern) return color.gray(String(input.pattern));
  return "";
}

export const claudeBackend = new ClaudeBackend();
registerBackend(claudeBackend);
