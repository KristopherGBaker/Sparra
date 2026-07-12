/**
 * `conductors/http` — a LOCAL HTTP bridge that lets a remote agent (over Tailscale) trigger Sparra on
 * this Mac. This module ships the SAFETY SPINE + server skeleton only:
 *   - {@link ./config.ts} — `loadBridgeConfig` + `resolveBind` (never a public wildcard).
 *   - {@link ./auth.ts}   — fail-closed Bearer auth (`checkBearer`, `requireBridgeToken`).
 *   - {@link ./paths.ts}  — `resolveWithinAllowlist`: the single path choke point (realpath + prefix).
 *   - {@link ./jobs.ts}   — the in-memory, bounded `JobStore`.
 *   - {@link ./audit.ts}  — append-only, secret-free request audit.
 *   - {@link ./server.ts} — the `node:http` server, routing, middleware, and built-in job/health
 *                           routes, plus the `registerRoute` seam a LATER unit plugs trigger
 *                           endpoints into (without editing core routing).
 */

export {
  loadBridgeConfig,
  resolveBind,
  type BridgeConfig,
  type LoadBridgeConfigDeps,
  type ResolveBindDeps,
} from "./config.ts";

export { checkBearer, requireBridgeToken } from "./auth.ts";

export {
  resolveWithinAllowlist,
  isWithinAllowlistedRoot,
  matchedAllowlistRoot,
  PathGuardError,
} from "./paths.ts";

export {
  JobStore,
  type Job,
  type JobStatus,
  type CreateJobInput,
  type FinishInput,
  type JobStoreOptions,
} from "./jobs.ts";

export {
  appendAudit,
  formatAuditLine,
  createFileAuditSink,
  UNMATCHED_ROUTE,
  type AuditEntry,
  type AuditSink,
} from "./audit.ts";

export {
  createServer,
  createRequestListener,
  startBridge,
  type RouteContext,
  type RouteResult,
  type RouteHandler,
  type RouteDefinition,
  type ServerDeps,
  type StartBridgeDeps,
} from "./server.ts";
