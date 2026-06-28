import { color, detail } from "../../util/log.ts";
import { extractJson } from "../../util/extract.ts";
import { inlineSkillsBlock } from "../skills.ts";
import { TraceWriter } from "../trace.ts";
import {
  registerBackend,
  type AgentBackend,
  type AgentRequest,
  type AgentResult,
  type BackendCapabilities,
  type LimitHit,
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
    skills: false, // no native skill loading; SKILL.md is inlined into the input instead
    cost: "tokens", // Codex reports tokens, not USD
  };

  async runTask(req: AgentRequest): Promise<AgentResult> {
    const sandboxMode = codexSandboxMode(req);
    // Codex's SDK has no system-prompt channel — the input string is the only one. Fold the
    // role's system prompt (and any inlined skills) in ahead of the task, or it's lost.
    const skillsBlock = req.skills?.length ? inlineSkillsBlock(req.skills) : "";
    const input = req.systemPrompt
      ? `${req.systemPrompt}${skillsBlock}\n\n---\n\n${req.prompt}`
      : `${skillsBlock}${req.prompt}`;
    const header = `# ${req.role}\n\n- backend: \`codex\`\n- model: \`${req.model || "(default)"}\`${req.baseUrl ? `\n- endpoint: \`${req.baseUrl}\` (local)` : ""}\n- cwd: \`${req.cwd}\`\n- sandbox: \`${sandboxMode}\`${req.skills?.length ? `\n- skills: ${req.skills.map((s) => s.name).join(", ")}` : ""}\n${req.resume ? `- resume: \`${req.resume}\`\n` : ""}\n## Input\n\n${input}\n\n---\n`;
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
      // Default: auth + defaults from the codex CLI (~/.codex). When a baseUrl is set, point
      // Codex at an OpenAI-compatible endpoint (e.g. local LM Studio) — the model runs locally
      // while Codex still supplies the agentic loop + tools.
      const codexOptions: Record<string, unknown> = {};
      if (req.baseUrl) codexOptions.baseUrl = req.baseUrl;
      if (req.apiKey) codexOptions.apiKey = req.apiKey;
      else if (req.baseUrl) codexOptions.apiKey = "lm-studio"; // local servers ignore the key
      const codex = new Codex(codexOptions);

      const threadOptions: Record<string, unknown> = {
        sandboxMode,
        workingDirectory: req.cwd,
        skipGitRepoCheck: true,
        approvalPolicy: "never", // autonomous: the sandbox is the boundary, never prompt
      };
      if (req.model) threadOptions.model = req.model;
      // The exercising evaluator gets scratch writes (workspace-write) but NEVER network.
      if (req.readOnly && req.exerciseScratch) threadOptions.networkAccessEnabled = false;
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
        const { events } = await thread.runStreamed(input, turnOptions);
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
        const turn = await thread.run(input, turnOptions);
        usage = turn?.usage;
        result.sessionId = thread.id ?? "";
        result.resultText = turn?.finalResponse ?? "";
      }

      result.tokens = totalTokens(usage);
      result.numTurns = 1;
      result.ok = result.errors.length === 0;
      // A SILENT empty completion — no error, but zero tokens and no output — is not a real
      // answer; it's almost always provider unavailability or a usage/session window. Classify it
      // as a limit so the caller falls back / retries instead of mistaking it for a genuine empty
      // result (which would, e.g., parse as a bogus failing verdict and churn the loop).
      if (isEmptyCompletion(result)) {
        result.ok = false;
        result.errors.push("Codex returned an empty completion (0 tokens, no output) — likely provider unavailability or a usage/session limit.");
        result.limitHit = { kind: "session", raw: result.errors[result.errors.length - 1]! };
      }
      result.subtype = result.ok ? "success" : "error";
      // Codex gives no structured reset time — sniff the error strings; the build loop
      // then falls back to fixed-interval polling (no resetAt). (Don't clobber an empty-completion
      // limitHit already set above.)
      if (!result.ok && !result.limitHit) result.limitHit = limitFromErrors(result.errors);
      if (req.outputSchema && result.resultText) result.structured = extractJson(result.resultText) ?? undefined;
      emit(req.onEvent, { kind: "result", ok: result.ok, costUsd: 0, subtype: result.subtype });
    } catch (e) {
      result.ok = false;
      result.subtype = "error";
      result.errors = [...result.errors, (e as Error).message];
      result.limitHit = limitFromErrors(result.errors);
      await trace.write(`> Codex run failed: ${(e as Error).message}\n\n`);
    }

    return result;
  }
}

/** Codex's native sandbox scopes (matches @openai/codex-sdk `SandboxMode`). */
/**
 * A SILENT empty completion — the backend reported success but produced zero tokens and no
 * text. This is almost always provider unavailability or a usage/session window, NOT a genuine
 * empty answer. Pure + exported so the classification is unit-testable without spawning the
 * codex CLI. The caller (runTask) promotes a true here to `limitHit` so `runRole` falls back /
 * retries instead of churning the loop on a bogus failing verdict.
 */
export function isEmptyCompletion(r: { ok: boolean; tokens: number; resultText: string }): boolean {
  return r.ok && r.tokens === 0 && !r.resultText.trim();
}

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/**
 * Map a normalized request's safety intent onto Codex's `ThreadOptions.sandboxMode`.
 * Pure + exported so the decision is unit-testable without spawning the codex CLI.
 *   readOnly → "read-only" ALWAYS (read-only wins over any sandbox knob), EXCEPT the
 *              exerciseScratch carve-out: a read-only role that EXERCISES the artifact needs
 *              writable scratch for test/build tools, so it relaxes to "workspace-write" (network
 *              is forced off in runTask; the runner's source-integrity guard reverts any artifact
 *              write so the evaluator still can't mutate the code it grades).
 *   otherwise → the requested `sandbox`, defaulting to "workspace-write" when unset.
 * The danger-full-access worktree gate lives at the request-construction layer (which can
 * see git state); this backend has none (hooks:false, approvalPolicy:never) and trusts `req`.
 */
export function codexSandboxMode(req: Pick<AgentRequest, "readOnly" | "sandbox" | "exerciseScratch">): CodexSandboxMode {
  if (req.readOnly) return req.exerciseScratch ? "workspace-write" : "read-only";
  return req.sandbox ?? "workspace-write";
}

/** Classify a provider rate/usage limit from Codex error strings (no reset time available). */
function limitFromErrors(errors: string[]): LimitHit | undefined {
  const blob = errors.join(" ").toLowerCase();
  if (/rate.?limit|too many requests|\b429\b|quota|usage limit|overloaded/.test(blob)) {
    return { kind: /usage limit|quota/.test(blob) ? "usage" : "rate", raw: errors.join("; ").slice(0, 300) };
  }
  return undefined;
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
