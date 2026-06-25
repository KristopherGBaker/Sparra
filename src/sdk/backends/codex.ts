import { color, detail } from "../../util/log.ts";
import { extractJson } from "../../util/extract.ts";
import { TraceWriter } from "../trace.ts";
import {
  registerBackend,
  type AgentBackend,
  type AgentRequest,
  type AgentResult,
  type BackendCapabilities,
  type SessionEvent,
} from "../backend.ts";

/**
 * The Codex backend (OpenAI's coding agent) via @openai/codex-sdk.
 *
 * The SDK is an OPTIONAL peer dependency, imported lazily so the harness runs without
 * it unless a role selects backend "codex". Normalized intent maps onto Codex's NATIVE
 * controls: readOnly/writeScope → ThreadOptions.sandboxMode, outputSchema → TurnOptions
 * .outputSchema, resume → resumeThread. Auth comes from the codex CLI (~/.codex).
 */
class CodexBackend implements AgentBackend {
  readonly id = "codex";
  readonly capabilities: BackendCapabilities = {
    resume: true,
    streaming: true,
    outputSchema: true,
    mcp: true,
    hooks: false, // no tool-call interception; safety is the sandbox
    sandbox: true,
    cost: "tokens", // Codex reports tokens, not USD
  };

  async runTask(req: AgentRequest): Promise<AgentResult> {
    const sandboxMode = req.readOnly ? "read-only" : "workspace-write";
    const header = `# ${req.role}\n\n- backend: \`codex\`\n- model: \`${req.model || "(default)"}\`\n- cwd: \`${req.cwd}\`\n- sandbox: \`${sandboxMode}\`\n${req.resume ? `- resume: \`${req.resume}\`\n` : ""}\n## Task\n\n${req.prompt}\n\n---\n`;
    const trace = TraceWriter.for(req.traceDir, req.role, req.traceSeq, header);

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

    // Lazy, optional import. Non-literal specifier so tsc doesn't require the package.
    let mod: any;
    try {
      const spec = "@openai/codex-sdk";
      mod = await import(spec);
    } catch {
      result.subtype = "error_backend_unavailable";
      result.errors = ["Codex backend requires @openai/codex-sdk (npm i @openai/codex-sdk) and the codex CLI on PATH."];
      await trace.write(`> ${result.errors[0]!}\n\n`);
      return result;
    }

    let usage: any;
    try {
      const Codex = mod.Codex;
      const codex = new Codex(); // auth + defaults from the codex CLI (~/.codex)

      const threadOptions: Record<string, unknown> = {
        sandboxMode,
        workingDirectory: req.cwd,
        skipGitRepoCheck: true,
        approvalPolicy: "never", // autonomous: the sandbox is the boundary, never prompt
      };
      if (req.model) threadOptions.model = req.model;
      const effort = mapEffort(req.effort);
      if (effort) threadOptions.modelReasoningEffort = effort;
      if (req.additionalDirectories?.length) threadOptions.additionalDirectories = req.additionalDirectories;

      const thread = req.resume ? codex.resumeThread(req.resume, threadOptions) : codex.startThread(threadOptions);

      const turnOptions: Record<string, unknown> = {};
      if (req.outputSchema) turnOptions.outputSchema = req.outputSchema;
      if (req.abortController) turnOptions.signal = req.abortController.signal;

      const echo = req.echoActivity ?? !(req.onAssistantText || req.onEvent);
      const wantStream = !!(req.onEvent || req.onAssistantText || echo);

      if (wantStream) {
        const { events } = await thread.runStreamed(req.prompt, turnOptions);
        for await (const ev of events as AsyncIterable<any>) {
          await trace.write("```json\n" + JSON.stringify(ev).slice(0, 1500) + "\n```\n\n");
          if (ev?.type === "thread.started") {
            result.sessionId = ev.thread_id ?? result.sessionId;
            emit(req.onEvent, { kind: "init", sessionId: result.sessionId, model: req.model });
          } else if (ev?.type === "item.completed") {
            const item = ev.item ?? {};
            if (item.type === "agent_message" && item.text) {
              result.resultText = item.text; // final assistant message (JSON when outputSchema)
              req.onAssistantText?.(item.text);
              emit(req.onEvent, { kind: "text", text: item.text });
            } else if (["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(item.type)) {
              const summary = toolSummary(item);
              if (echo) detail(`${color.gray("·")} ${color.cyan(item.type)} ${color.gray(summary)}`);
              emit(req.onEvent, { kind: "tool", name: item.type, summary });
            }
          } else if (ev?.type === "turn.completed") {
            usage = ev.usage;
          } else if (ev?.type === "turn.failed") {
            result.errors.push(ev.error?.message ?? "turn failed");
          } else if (ev?.type === "error") {
            result.errors.push(ev.message ?? "stream error");
          }
        }
        result.sessionId = result.sessionId || (thread.id ?? "");
      } else {
        const turn = await thread.run(req.prompt, turnOptions);
        usage = turn?.usage;
        result.sessionId = thread.id ?? "";
        result.resultText = turn?.finalResponse ?? "";
      }

      result.tokens = totalTokens(usage);
      result.numTurns = 1;
      result.ok = result.errors.length === 0;
      result.subtype = result.ok ? "success" : "error";
      if (req.outputSchema && result.resultText) result.structured = extractJson(result.resultText) ?? undefined;
      emit(req.onEvent, { kind: "result", ok: result.ok, costUsd: 0, subtype: result.subtype });
    } catch (e) {
      result.ok = false;
      result.subtype = "error";
      result.errors = [...result.errors, (e as Error).message];
      await trace.write(`> Codex run failed: ${(e as Error).message}\n\n`);
    }

    return result;
  }
}

function emit(onEvent: ((e: SessionEvent) => void) | undefined, e: SessionEvent): void {
  onEvent?.(e);
}

/** Map the harness effort scale onto Codex's modelReasoningEffort. */
function mapEffort(effort: AgentRequest["effort"]): string | undefined {
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
    case "max":
      return "xhigh";
    default:
      return undefined;
  }
}

function toolSummary(item: any): string {
  if (item.type === "command_execution") return String(item.command ?? "").slice(0, 80);
  if (item.type === "mcp_tool_call") return `${item.server}/${item.tool}`;
  if (item.type === "web_search") return String(item.query ?? "");
  if (item.type === "file_change") return (item.changes ?? []).map((c: any) => c.path).join(", ").slice(0, 80);
  return "";
}

/** Sum Codex's Usage shape (input + cached + output + reasoning), with fallbacks. */
function totalTokens(usage: any): number {
  if (!usage || typeof usage !== "object") return 0;
  if (typeof usage.total_tokens === "number") return usage.total_tokens;
  return (
    Number(usage.input_tokens ?? 0) +
    Number(usage.cached_input_tokens ?? 0) +
    Number(usage.output_tokens ?? 0) +
    Number(usage.reasoning_output_tokens ?? 0)
  );
}

export const codexBackend = new CodexBackend();
registerBackend(codexBackend);
