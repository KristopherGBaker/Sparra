import { getBackend } from "./backend.ts";
import "./backends/claude.ts"; // side-effect: registers the "claude" backend
import type { AgentRequest, AgentResult } from "./backend.ts";

// Back-compat names: the rest of the harness still talks in terms of "sessions".
export type { SessionEvent, AgentBackend, AgentRequest, AgentResult, BackendCapabilities } from "./backend.ts";
export { getBackend, listBackends, registerBackend } from "./backend.ts";
export type RunSessionParams = AgentRequest;
export type RunResult = AgentResult;

/**
 * The single choke point for talking to a coding agent. Every role goes through here,
 * so tracing, usage accounting, and result extraction are uniform — and the backend
 * (Claude today; Codex/others next) is a pluggable detail. The filesystem (cwd) is the
 * shared state between sessions; nothing is held in memory across calls.
 */
export async function runSession(p: AgentRequest): Promise<AgentResult> {
  return getBackend(p.backend).runTask(p);
}
