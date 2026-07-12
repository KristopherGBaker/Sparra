/**
 * `conductors/http/audit.ts` — append-only, secret-free request audit log.
 *
 * Every request (accepted OR rejected) emits exactly ONE line. The line is built ONLY from SAFE,
 * server-derived fields — timestamp, remote address, a sanitized HTTP method, the MATCHED ROUTE
 * TEMPLATE (never the raw request path), an optional resolved allowlist root, an optional
 * server-generated job id, and an outcome. It NEVER echoes the raw request target: arbitrary
 * untrusted text (short, plain, unpredictable) can't be pattern-detected, so the defense is
 * STRUCTURAL — we simply never log the raw path/target string. The bearer token, API keys, and
 * request bodies are never among the fields either. The sink is injectable so tests capture lines
 * without disk I/O.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Sentinel logged for a request whose path matched no route (so the raw 404 path is never echoed). */
export const UNMATCHED_ROUTE = "<unmatched>";

/** The allowlisted fields of an audit line. Every field here is SERVER-derived and bounded. */
export interface AuditEntry {
  /** ISO timestamp; defaulted by {@link appendAudit} when omitted. */
  time?: string;
  /** Remote address of the caller (from the socket, not request content). */
  remote: string;
  /** HTTP method — sanitized to a fixed verb allowlist on format. */
  method: string;
  /**
   * The MATCHED route TEMPLATE (e.g. `/jobs/:id/cancel`, `/health`) or {@link UNMATCHED_ROUTE}.
   * This is a server-side constant from the route table — NEVER the raw client-supplied path.
   */
  route: string;
  /**
   * The matched allowlist ENTRY (the operator-configured `roots[i]` from bridge.yaml) the request
   * resolved INTO — identifying WHICH allowlisted project was targeted. The SERVER logs the trusted
   * parent entry only, NEVER the full resolved sub-path (whose tail is arbitrary request-derived
   * text) and NEVER a rejected request's raw client-supplied root (that's omitted).
   */
  root?: string;
  /** Server-generated job id; char-classed + length-capped defensively on format. */
  jobId?: string;
  /** HTTP status code or a short outcome label. */
  result: string | number;
}

/** A sink that receives one already-formatted audit line (no trailing newline). */
export type AuditSink = (line: string) => void;

/** Fixed HTTP-verb allowlist — an unrecognized method is logged as a sentinel, never echoed raw. */
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** Longest job-id we retain in the audit line; a generated id is far shorter than this. */
const MAX_JOB_ID_LEN = 64;

function sanitizeMethod(method: string): string {
  const up = typeof method === "string" ? method.toUpperCase() : "";
  return HTTP_METHODS.has(up) ? up : "<method>";
}

/**
 * Defensively bound a job id: strip anything outside `[A-Za-z0-9_-]` and cap the length. A job id is
 * already a server-generated token, but it reaches us via a URL `:id` param, so we char-class + cap
 * it so arbitrary request bytes can never pass through the audit line.
 */
function sanitizeJobId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, MAX_JOB_ID_LEN);
}

/**
 * Serialize an {@link AuditEntry} to a single JSON line built ONLY from safe, server-derived fields.
 *
 * The raw request path/target is NEVER a field here (that's the structural defense); `route` is the
 * matched template or the {@link UNMATCHED_ROUTE} sentinel, `method` is verb-allowlisted, and any
 * `jobId` is char-classed + length-capped.
 */
export function formatAuditLine(entry: AuditEntry, now: () => Date = () => new Date()): string {
  const record: Record<string, string | number> = {
    time: entry.time ?? now().toISOString(),
    remote: entry.remote,
    method: sanitizeMethod(entry.method),
    route: entry.route,
    result: entry.result,
  };
  if (entry.root !== undefined) record.root = entry.root;
  if (entry.jobId !== undefined) record.jobId = sanitizeJobId(entry.jobId);
  return JSON.stringify(record);
}

/**
 * Append one audit line via `sink`. Defaults to a file sink at `auditLogPath` (append mode, creating
 * the parent directory if needed) when no sink is injected.
 */
export function appendAudit(
  entry: AuditEntry,
  sink: AuditSink,
  now: () => Date = () => new Date(),
): void {
  sink(formatAuditLine(entry, now));
}

/** A file-backed {@link AuditSink}: append mode, creating the parent directory if needed. */
export function createFileAuditSink(auditLogPath: string): AuditSink {
  return (line: string) => {
    mkdirSync(dirname(auditLogPath), { recursive: true });
    appendFileSync(auditLogPath, line + "\n", "utf8");
  };
}
