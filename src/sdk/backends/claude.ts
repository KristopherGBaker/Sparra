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
  type LimitHit,
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
      strictMcpConfig: true, // only Sparra's own MCP (the exerciser); ignore ambient/config MCP.
      // NB: settingSources:[]+strictMcpConfig still don't suppress auto-fetched claude.ai cloud
      // connectors (Drive/Gmail/Calendar), so the PreToolUse deny-hook (denyAmbientMcp) is the
      // authoritative block — it rejects any mcp__* call that isn't mcp__exercise__*.
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
      // Delegate the per-message consumption to the testable seam below; it tolerates the
      // SDK's trailing exit-throw once a terminal `result` has been observed (see consumeQuery).
      await consumeQuery(query({ prompt: req.prompt, options }), { result, trace, req, echo });
    } finally {
      skillPlugin?.cleanup();
    }

    if (req.outputSchema && result.ok) {
      result.structured = extractJson(result.resultText) ?? undefined;
    }

    return result;
  }
}

/** Inputs the message-consumption loop needs that aren't on the stream itself. */
interface ConsumeCtx {
  /** Pre-built result object; mutated in place as messages arrive and returned. */
  result: AgentResult;
  trace: TraceWriter;
  req: AgentRequest;
  /** Whether to echo tool activity to the console. */
  echo: boolean;
}

/**
 * Consume the Agent SDK's `query()` async iterator into an `AgentResult`. Extracted from
 * `runTask` as the testable seam (fed a hand-rolled `AsyncIterable<SDKMessage>` in tests).
 *
 * Observed SDK ordering — the fix rests on this, re-validate if `@anthropic-ai/claude-agent-sdk`
 * changes: on an error result `query()` yields the terminal `result` message FIRST (subtype
 * `error_max_turns` / `error_max_budget_usd`, `is_error:true`), THEN — because the CLI process
 * exits non-zero — the iterator THROWS a trailing `Error("Claude Code returned an error result:
 * <text>")` on the next pull. So once we've consumed a terminal `result` we RETURN the populated,
 * resumable result and swallow that trailing throw rather than rejecting (which would lose the
 * `sessionId`/`hitMaxTurns` the interactive resume path needs). The swallow is gated on an EXPLICIT
 * `gotResult` flag — NOT on `sessionId`/init (which is set before any result), so a genuine
 * pre-result failure (spawn/abort) still propagates.
 */
export async function consumeQuery(
  stream: AsyncIterable<SDKMessage>,
  { result, trace, req, echo }: ConsumeCtx,
): Promise<AgentResult> {
  // The SDK emits `rate_limit_event` (plan limits) and retries transient errors itself.
  // Record the latest REJECTED limit; only promote it to result.limitHit if the run
  // ultimately fails (so we don't flag a limit the SDK recovered from).
  let pendingLimit: LimitHit | undefined;
  // Set true ONLY when a terminal `result` message is processed — gates the trailing-throw swallow.
  let gotResult = false;

  try {
    for await (const msg of stream) {
      await trace.record(msg as SDKMessage);

      if (msg.type === "rate_limit_event") {
        const info = (msg as any).rate_limit_info ?? {};
        if (info.status === "rejected" || info.overageStatus === "rejected") {
          pendingLimit = limitFromRateInfo(info);
        }
      } else if (msg.type === "system" && (msg as any).subtype === "init") {
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
        gotResult = true;
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
          // A real provider limit (vs. our own maxTurns/maxBudget caps): prefer the
          // structured rate_limit_event, else sniff the error strings.
          if (!result.hitMaxTurns && !result.hitBudget) {
            result.limitHit = pendingLimit ?? limitFromErrors(result.errors, m.api_error_status);
          }
        }
      }
    }
  } catch (err) {
    // Trailing exit-throw after a terminal result (see the ordering note above): the populated
    // result is the real, resumable outcome — return it rather than reject. If NO terminal result
    // was consumed (genuine pre-result failure: spawn error, abort, etc.) the error propagates.
    if (!gotResult) throw err;
  }

  return result;
}

/** Normalize the SDK's epoch (seconds or ms) to ms. */
function toEpochMs(n: unknown): number | undefined {
  const v = Number(n);
  if (!isFinite(v) || v <= 0) return undefined;
  return v < 1e12 ? v * 1000 : v; // values below ~2001 in ms must be seconds
}

/** Build a LimitHit from a Claude SDKRateLimitInfo. */
function limitFromRateInfo(info: any): LimitHit {
  const type: string | undefined = info.rateLimitType;
  const kind: LimitHit["kind"] = type && /hour|day|overage/.test(type) ? "usage" : "rate";
  return {
    kind,
    resetAt: toEpochMs(info.overageResetsAt ?? info.resetsAt),
    rateLimitType: type,
    raw: JSON.stringify(info).slice(0, 300),
  };
}

/** Fallback: classify a provider limit from error strings / HTTP status when no
 *  structured rate_limit_event arrived (the SDK exhausted its own retries). */
function limitFromErrors(errors: string[], apiStatus?: number | null): LimitHit | undefined {
  if (apiStatus === 429) return { kind: "rate", raw: `http 429` };
  const blob = errors.join(" ").toLowerCase();
  if (/rate.?limit|too many requests|429|overloaded|usage limit/.test(blob)) {
    return { kind: /usage limit/.test(blob) ? "usage" : "rate", raw: errors.join("; ").slice(0, 300) };
  }
  return undefined;
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
