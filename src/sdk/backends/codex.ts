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
 * The SDK is an OPTIONAL peer dependency: it's imported lazily so the harness runs
 * without it unless a role actually selects backend "codex". The normalized safety
 * intent maps onto Codex's NATIVE controls — readOnly/writeScope → OS sandbox mode,
 * outputSchema → real schema enforcement, resume → thread resumption.
 *
 * NOTE: the live path requires `npm i @openai/codex-sdk` plus the `codex` CLI on PATH
 * and OpenAI auth; it is exercised by config, not by the test suite.
 */
class CodexBackend implements AgentBackend {
  readonly id = "codex";
  readonly capabilities: BackendCapabilities = {
    resume: true,
    streaming: true,
    outputSchema: true, // native JSON-schema output
    mcp: true,
    hooks: false, // no tool-call interception; safety is the sandbox
    sandbox: true,
    cost: "tokens", // Codex reports tokens, not USD
  };

  async runTask(req: AgentRequest): Promise<AgentResult> {
    const header = `# ${req.role}\n\n- backend: \`codex\`\n- model: \`${req.model}\`\n- cwd: \`${req.cwd}\`\n- sandbox: \`${req.readOnly ? "read-only" : "workspace-write"}\`\n${req.resume ? `- resume: \`${req.resume}\`\n` : ""}\n## Task\n\n${req.prompt}\n\n---\n`;
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

    try {
      const Codex = mod.Codex;
      const codex = new Codex({
        config: {
          model: req.model,
          // Normalized intent → Codex's native OS sandbox.
          sandbox_mode: req.readOnly ? "read-only" : "workspace-write",
        },
      });

      const thread = req.resume
        ? codex.resumeThread(req.resume)
        : codex.startThread({ workingDirectory: req.cwd, skipGitRepoCheck: true });

      const echo = req.echoActivity ?? !(req.onAssistantText || req.onEvent);
      let usage: any;

      if (this.capabilities.streaming && (req.onEvent || req.onAssistantText || echo)) {
        const stream = thread.runStreamed(req.prompt);
        for await (const ev of stream as AsyncIterable<any>) {
          await trace.write("```json\n" + JSON.stringify(ev).slice(0, 2000) + "\n```\n\n");
          if (ev?.type === "item.completed") {
            const item = ev.item ?? {};
            if (item.type === "text" && item.text) {
              if (req.onAssistantText) req.onAssistantText(item.text);
              emit(req.onEvent, { kind: "text", text: item.text });
            } else if (item.type) {
              if (echo) detail(`${color.gray("·")} ${color.cyan(String(item.type))}`);
              emit(req.onEvent, { kind: "tool", name: String(item.type), summary: "" });
            }
          } else if (ev?.type === "turn.completed") {
            usage = ev.usage;
            result.resultText = ev.finalResponse ? String(ev.finalResponse) : result.resultText;
          }
        }
        result.sessionId = thread.id ?? "";
      } else {
        const run = await thread.run(req.prompt, req.outputSchema ? { outputSchema: req.outputSchema } : undefined);
        usage = run?.usage;
        result.sessionId = thread.id ?? "";
        result.resultText = stringifyFinal(run?.finalResponse);
        if (req.outputSchema && run?.finalResponse != null) result.structured = run.finalResponse;
      }

      result.tokens = totalTokens(usage);
      result.numTurns = 1;
      result.ok = true;
      result.subtype = "success";
      if (req.outputSchema && result.structured == null) result.structured = extractJson(result.resultText) ?? undefined;
      emit(req.onEvent, { kind: "result", ok: true, costUsd: 0, subtype: "success" });
    } catch (e) {
      result.subtype = "error";
      result.errors = [(e as Error).message];
      await trace.write(`> Codex run failed: ${(e as Error).message}\n\n`);
    }

    return result;
  }
}

function emit(onEvent: ((e: SessionEvent) => void) | undefined, e: SessionEvent): void {
  onEvent?.(e);
}

function stringifyFinal(final: unknown): string {
  if (final == null) return "";
  return typeof final === "string" ? final : JSON.stringify(final);
}

/** Best-effort token total across the various usage shapes the SDK may report. */
function totalTokens(usage: any): number {
  if (!usage || typeof usage !== "object") return 0;
  if (typeof usage.total === "number") return usage.total;
  if (typeof usage.total_tokens === "number") return usage.total_tokens;
  const input = Number(usage.input_tokens ?? usage.inputTokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.outputTokens ?? 0);
  const cached = Number(usage.cached_input_tokens ?? usage.cacheReadInputTokens ?? 0);
  return input + output + cached;
}

export const codexBackend = new CodexBackend();
registerBackend(codexBackend);
