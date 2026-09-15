import fs from "node:fs";
import path from "node:path";
import { getBackend } from "./backend.ts";
import "./backends/claude.ts"; // side-effect: registers the "claude" backend
import "./backends/codex.ts"; // side-effect: registers the "codex" backend (SDK loaded lazily)
import type { AgentRequest, AgentResult, SessionEvent } from "./backend.ts";

// Back-compat names: the rest of the harness still talks in terms of "sessions".
export type { SessionEvent, AgentBackend, AgentRequest, AgentResult, BackendCapabilities } from "./backend.ts";
export { getBackend, listBackends, registerBackend } from "./backend.ts";
export type RunSessionParams = AgentRequest;
export type RunResult = AgentResult;

/**
 * One session's identity, written the moment the backend reports it — NOT when the session ends.
 *
 * A session id returned only in the result is lost exactly when it is worth the most. Three field
 * deaths in two days (two MCP client aborts after 1800s of silence, one provider session limit)
 * each returned NO `sessionId`, so `resumeSessionId` was unavailable and the only recovery was to
 * re-invoke fresh — in one case abandoning 442 lines of compiling production code, in another 864
 * lines of tests plus captures and a real layout bug already fixed. The work always survived in the
 * unit worktree; only the handle to the session that produced it did not. Written at INIT, an
 * aborted run is RESUMABLE rather than merely restartable.
 */
export interface SessionStartRecord {
  /** Role label (also the trace filename stem). */
  role: string;
  backend: string;
  model: string;
  /** What to pass back as `resume` / `resumeSessionId`. */
  sessionId: string;
  traceSeq: number;
  cwd: string;
  /** ISO timestamp of the backend's init event. */
  startedAt: string;
  /** Present when this session itself resumed another (a re-ask, a continued generator). */
  resumedFrom?: string;
}

/** The append-only sidecar every session's start record lands in, beside that run's trace files. */
export const SESSIONS_FILE = "sessions.jsonl";

/** Where `SESSIONS_FILE` lives for a trace dir. Exported so diagnostics/tests agree on the path. */
export function sessionsPath(traceDir: string): string {
  return path.join(traceDir, SESSIONS_FILE);
}

/** Pure: one JSONL line for a record (stable key order, newline-terminated). */
export function formatSessionRecord(r: SessionStartRecord): string {
  return JSON.stringify(r) + "\n";
}

/** Best-effort read of a trace dir's start records (skipping any unparseable line). Empty when the
 *  sidecar is absent — a run that died before its backend ever reported an init. */
export function readSessionRecords(traceDir: string): SessionStartRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionsPath(traceDir), "utf8");
  } catch {
    return [];
  }
  const out: SessionStartRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SessionStartRecord);
    } catch {
      // a torn final line (killed mid-append) is not a reason to lose the records before it
    }
  }
  return out;
}

/** Append a start record. Best-effort and SYNCHRONOUS: the point is that it survives a kill -9 a
 *  moment later, and a sidecar failure must never take down the session it is describing. */
function appendSessionRecord(traceDir: string, r: SessionStartRecord): void {
  try {
    fs.mkdirSync(traceDir, { recursive: true });
    fs.appendFileSync(sessionsPath(traceDir), formatSessionRecord(r));
  } catch {
    // best-effort only
  }
}

/**
 * Wrap a request's `onEvent` so the backend's `init` event ALSO persists the session identity to
 * `<traceDir>/sessions.jsonl` before any work happens. Backend-agnostic by construction — it hangs
 * off the one event every backend already emits (Claude's `system/init`, Codex's `thread.started`),
 * so a new backend inherits it. Exported for the unit test; `runSession` applies it to every call.
 */
export function withSessionRecording(p: AgentRequest): AgentRequest {
  if (!p.traceDir) return p; // nowhere durable to put it
  const traceDir = p.traceDir;
  const inner = p.onEvent;
  const onEvent = (e: SessionEvent) => {
    if (e.kind === "init" && e.sessionId) {
      appendSessionRecord(traceDir, {
        role: p.role,
        backend: p.backend ?? "claude",
        model: e.model || p.model,
        sessionId: e.sessionId,
        traceSeq: p.traceSeq,
        cwd: p.cwd,
        startedAt: new Date().toISOString(),
        ...(p.resume ? { resumedFrom: p.resume } : {}),
      });
    }
    inner?.(e);
  };
  // Both backends derive their console echo from whether a front-end is consuming events
  // (`req.echoActivity ?? !(onAssistantText || onEvent)`). Adding an onEvent here would silently
  // mute every autonomous role's activity log, so PIN the decision the caller's own request made.
  const echoActivity = p.echoActivity ?? !(p.onAssistantText || p.onEvent);
  return { ...p, onEvent, echoActivity };
}

/**
 * The single choke point for talking to a coding agent. Every role goes through here,
 * so tracing, usage accounting, session-id persistence, and result extraction are uniform — and the
 * backend (Claude today; Codex/others next) is a pluggable detail. The filesystem (cwd) is the
 * shared state between sessions; nothing is held in memory across calls.
 */
export async function runSession(p: AgentRequest): Promise<AgentResult> {
  const req = withSessionRecording(p);
  return getBackend(req.backend).runTask(req);
}
