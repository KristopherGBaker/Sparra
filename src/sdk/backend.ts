import type {
  CanUseTool,
  HookCallbackMatcher,
  HookEvent,
  McpServerConfig,
  Options,
  PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * The agent-backend seam. Every model-driven step in the harness goes through an
 * AgentBackend, so the orchestration engine (plan/contract/generate/evaluate/pivot/
 * budget/memory) is independent of WHICH coding agent executes a task. The Claude
 * Agent SDK is one backend; Codex (and others) slot in as peers behind this same
 * interface.
 */

/** Structured event stream surfaced to non-console front-ends (e.g. the Ink TUI). */
export type SessionEvent =
  | { kind: "init"; sessionId: string; model: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "result"; ok: boolean; costUsd: number; subtype: string };

/** What a backend can do — the engine uses the richest path available and degrades. */
export interface BackendCapabilities {
  /** Can resume a prior session/thread by id. */
  resume: boolean;
  /** Streams incremental events (text/tool/usage) during a run. */
  streaming: boolean;
  /** Native structured output from a JSON Schema (vs. instruct-and-extract). */
  outputSchema: boolean;
  /** Can mount MCP servers as tools for the agent. */
  mcp: boolean;
  /** Tool-call interception hooks (pre/post). */
  hooks: boolean;
  /** Native OS-level sandbox for write/exec scoping. */
  sandbox: boolean;
  /** Loads agent skills natively (vs. inlining their SKILL.md into the prompt). */
  skills: boolean;
  /** What cost figure the backend reports. */
  cost: "usd" | "tokens" | "none";
}

/** A resolved agent skill: its name, directory, and SKILL.md contents. */
export interface ResolvedSkill {
  name: string;
  dir: string;
  skillMd: string;
}

/**
 * A normalized request to a backend.
 *
 * Prefer the BACKEND-AGNOSTIC intent fields (`writeScope`, `readOnly`, `outputSchema`):
 * each backend satisfies them however it can — Claude via PreToolUse hooks + permission
 * mode, Codex via its OS sandbox. The Claude-specific fields below the divider are a
 * pass-through escape hatch the current Claude callers already use (pre-built hooks /
 * permission mode / MCP servers); a backend that doesn't understand them ignores them.
 */
export interface AgentRequest {
  /** Human-readable role; used for the trace filename and logs. */
  role: string;
  prompt: string;
  systemPrompt: string;
  model: string;
  effort?: Options["effort"];
  cwd: string;
  additionalDirectories?: string[];
  tools?: string[];
  /** Agent skills to make available to this role (native where supported, else inlined). */
  skills?: ResolvedSkill[];

  // ── Backend-agnostic safety intent ──
  /** Directories the agent may write to (Claude → scoped hooks, Codex → workspace-write). */
  writeScope?: string[];
  /** No writes at all — evaluator / plan-only roles (Claude → plan mode, Codex → read-only). */
  readOnly?: boolean;
  /** Bash substrings always denied. */
  denyBashContains?: string[];
  /** Optional JSON Schema for structured output (native where supported, else emulated). */
  outputSchema?: Record<string, unknown>;

  // ── Limits ──
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Per-task token ceiling — the portable budget lever (Codex reports tokens, not USD). */
  maxTokens?: number;

  resume?: string;
  /** Which backend to run on (default "claude"). */
  backend?: string;
  /** Point the backend at an OpenAI-compatible endpoint (e.g. local LM Studio). Codex only. */
  baseUrl?: string;
  apiKey?: string;

  /** Where to write the transcript markdown, and the seq number within the run. */
  traceDir: string;
  traceSeq: number;

  onAssistantText?: (text: string) => void;
  onEvent?: (e: SessionEvent) => void;
  echoActivity?: boolean;
  abortController?: AbortController;

  // ── Claude-specific pass-through (escape hatch; new code should prefer the intent fields) ──
  permissionMode?: PermissionMode;
  canUseTool?: CanUseTool;
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  mcpServers?: Record<string, McpServerConfig>;
  allowedTools?: string[];
  disallowedTools?: string[];
  forkSession?: boolean;
}

/** A normalized result from a backend. */
export interface AgentResult {
  ok: boolean;
  subtype: string;
  resultText: string;
  /** Parsed structured output when `outputSchema` was requested and produced. */
  structured?: unknown;
  sessionId: string;
  costUsd: number;
  /** Total tokens used (input+output+cache), summed across models. */
  tokens: number;
  numTurns: number;
  hitMaxTurns: boolean;
  hitBudget: boolean;
  errors: string[];
  tracePath: string;
}

export interface AgentBackend {
  readonly id: string;
  readonly capabilities: BackendCapabilities;
  runTask(req: AgentRequest): Promise<AgentResult>;
}

const registry = new Map<string, AgentBackend>();

/** Register a backend implementation under its id (e.g. "claude", "codex"). */
export function registerBackend(backend: AgentBackend): void {
  registry.set(backend.id, backend);
}

/** Look up a backend by id (defaults to "claude"). Throws if not registered. */
export function getBackend(id = "claude"): AgentBackend {
  const b = registry.get(id);
  if (!b) {
    throw new Error(`Unknown agent backend "${id}". Registered: ${[...registry.keys()].join(", ") || "(none)"}`);
  }
  return b;
}

/** Ids of all registered backends. */
export function listBackends(): string[] {
  return [...registry.keys()];
}
