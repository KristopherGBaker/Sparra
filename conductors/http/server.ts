/**
 * `conductors/http/server.ts` — the `node:http` server: routing, auth middleware, JSON/body
 * handling, audit, and the three built-in routes (`/health`, `/jobs/:id`, `/jobs/:id/cancel`).
 *
 * `createServer(deps)` is fully dependency-injected and is THE tested unit. `startBridge()` is the
 * thin entry that assembles real deps from env/config and binds a socket. Trigger endpoints are OUT
 * of scope here — a later unit adds them via the {@link ServerDeps.routes} registration seam without
 * editing the core routing below.
 */

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { appendAudit, createFileAuditSink, UNMATCHED_ROUTE, type AuditEntry } from "./audit.ts";
import { checkBearer, requireBridgeToken } from "./auth.ts";
import { loadBridgeConfig, resolveBind, type BridgeConfig } from "./config.ts";
import { JobStore } from "./jobs.ts";
import { matchedAllowlistRoot, PathGuardError } from "./paths.ts";
import { registerBridgeRoutes, type BridgeRouteDeps } from "./register.ts";

/** Default request body cap (1 MiB) — a remote trigger payload is tiny; anything larger is refused. */
const DEFAULT_MAX_BODY_BYTES = 1_000_000;

/** What a route handler receives. Injected so a later unit's handlers stay pure/testable. */
export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** Parsed `:id`-style params from the route pattern. */
  params: Record<string, string>;
  /** Parsed JSON body (or `undefined` when there was no body). */
  body: unknown;
  remote: string;
  config: BridgeConfig;
  jobs: JobStore;
}

/** What a route handler returns. `root`/`jobId` feed the audit line for this request. */
export interface RouteResult {
  status: number;
  body?: unknown;
  root?: string;
  jobId?: string;
}

export type RouteHandler = (ctx: RouteContext) => RouteResult | Promise<RouteResult>;

/**
 * A single route registration contributed via the {@link ServerDeps.routes} seam.
 *
 * There is deliberately NO caller-settable `public`/auth-exempt flag: only the built-in
 * `GET /health` is unauthenticated. Every route added through this seam ALWAYS requires a valid
 * Bearer token, so a later unit can never (accidentally or otherwise) register an auth-bypass route.
 */
export interface RouteDefinition {
  method: string;
  /** Path pattern with optional `:name` segments, e.g. `/jobs/:id/cancel`. */
  path: string;
  handler: RouteHandler;
}

export interface ServerDeps {
  config: BridgeConfig;
  token: string;
  jobs: JobStore;
  /** Emit one audit line for a request (accepted or rejected). */
  audit: (entry: AuditEntry) => void;
  /** Extra routes contributed by a later unit — merged AFTER the built-ins. Always auth-gated. */
  routes?: RouteDefinition[];
  maxBodyBytes?: number;
}

/**
 * A compiled route. `public` is an INTERNAL flag set ONLY on the built-in `GET /health`; it is not
 * part of {@link RouteDefinition}, so it can never be reached through the registration seam.
 */
interface CompiledRoute {
  method: string;
  path: string;
  handler: RouteHandler;
  segments: string[];
  public: boolean;
}

function compile(route: RouteDefinition & { public?: boolean }): CompiledRoute {
  return {
    method: route.method,
    path: route.path,
    handler: route.handler,
    segments: splitPath(route.path),
    public: route.public === true,
  };
}

function splitPath(path: string): string[] {
  const clean = path.split("?")[0] ?? path;
  return clean.split("/").filter((s) => s.length > 0);
}

/** Match a compiled route's pattern against request segments, capturing `:name` params. */
function matchPattern(
  segments: string[],
  reqSegments: string[],
): Record<string, string> | null {
  if (segments.length !== reqSegments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const reqSeg = reqSegments[i]!;
    if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(reqSeg);
    else if (seg !== reqSeg) return null;
  }
  return params;
}

/** The built-in routes. Kept here (not exported/hardcoded elsewhere) so the seam stays the only way in. */
function builtinRoutes(): Array<RouteDefinition & { public?: boolean }> {
  return [
    {
      method: "GET",
      path: "/health",
      public: true,
      handler: () => ({ status: 200, body: { ok: true } }),
    },
    {
      method: "GET",
      path: "/jobs/:id",
      handler: ({ params, jobs }) => {
        const id = params.id!;
        const job = jobs.getJob(id);
        if (!job) return { status: 404, body: { error: "job not found" }, jobId: id };
        return { status: 200, body: job, jobId: id, ...(job.root ? { root: job.root } : {}) };
      },
    },
    {
      method: "POST",
      path: "/jobs/:id/cancel",
      handler: ({ params, jobs }) => {
        const id = params.id!;
        const job = jobs.cancelJob(id);
        if (!job) return { status: 404, body: { error: "job not found" }, jobId: id };
        return { status: 200, body: job, jobId: id, ...(job.root ? { root: job.root } : {}) };
      },
    },
  ];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

type BodyOutcome =
  | { kind: "ok"; value: unknown }
  | { kind: "too-large" }
  | { kind: "malformed" };

/** Read + JSON-parse the request body with a hard size cap. */
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<BodyOutcome> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overLimit = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Stop BUFFERING once the cap is exceeded (bounding memory), but keep draining the stream so
        // the caller can still write a clean 413 response instead of the socket being reset.
        overLimit = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overLimit) {
        resolve({ kind: "too-large" });
        return;
      }
      if (total === 0) {
        resolve({ kind: "ok", value: undefined });
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve({ kind: "ok", value: JSON.parse(text) });
      } catch {
        resolve({ kind: "malformed" });
      }
    });
    req.on("error", () => resolve({ kind: "malformed" }));
  });
}

/**
 * Build the `node:http` request handler from injected deps. Exposed so tests can drive the handler
 * DIRECTLY (fake `IncomingMessage`/`ServerResponse`) with no socket; used internally by
 * {@link createServer}.
 *
 * FAIL-CLOSED at construction: an unset/empty `deps.token` throws here (not deferred to
 * `startBridge`), so a server can never be constructed in an allow-all state.
 */
export function createRequestListener(
  deps: ServerDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  if (typeof deps.token !== "string" || deps.token.length === 0) {
    throw new Error(
      "createServer: token is unset or empty — refusing to build an allow-all Sparra bridge (fail-closed auth)",
    );
  }
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  // Built-ins may carry the internal `public` flag (only `GET /health` sets it). Registered routes
  // are re-projected to method/path/handler ONLY, so a smuggled `public: true` on a caller's object
  // is dropped and can never grant an auth exemption through the seam.
  const routes: CompiledRoute[] = [
    ...builtinRoutes().map(compile),
    ...(deps.routes ?? []).map((r) => compile({ method: r.method, path: r.path, handler: r.handler })),
  ];

  return (req, res) => {
    void handle(req, res);
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const rawUrl = req.url ?? "/";
    const path = rawUrl.split("?")[0] ?? rawUrl;
    const remote = req.socket.remoteAddress ?? "unknown";
    const reqSegments = splitPath(path);

    // Determine audit fields as we go; always emit exactly one line, whatever the outcome. The
    // audit line NEVER carries the raw request path — only the matched route TEMPLATE (or the
    // `<unmatched>` sentinel), so arbitrary untrusted request bytes can't reach the audit file.
    let auditRoute = UNMATCHED_ROUTE;
    let auditRoot: string | undefined;
    let auditJobId: string | undefined;
    let status = 500;
    const emit = () => {
      const entry: AuditEntry = { remote, method, route: auditRoute, result: status };
      // Log the matched allowlist ENTRY (the trusted operator-configured parent the request resolved
      // INTO), NOT the full resolved sub-path — the portion below the entry is arbitrary
      // request-derived text and must never reach the audit line. `undefined` (no match / rejected)
      // omits the field entirely. `remote` is the socket address (not a spoofable header);
      // `method`/`route`/`jobId` are sanitized/bounded in formatAuditLine.
      const matchedRoot =
        auditRoot !== undefined ? matchedAllowlistRoot(auditRoot, deps.config.roots) : undefined;
      if (matchedRoot !== undefined) entry.root = matchedRoot;
      if (auditJobId !== undefined) entry.jobId = auditJobId;
      deps.audit(entry);
    };

    try {
      // A public route (GET /health) is served without auth.
      const publicMatch = routes.find(
        (r) => r.public && r.method === method && matchPattern(r.segments, reqSegments),
      );
      if (publicMatch) {
        auditRoute = publicMatch.path;
        const params = matchPattern(publicMatch.segments, reqSegments)!;
        const result = await publicMatch.handler({
          req,
          res,
          params,
          body: undefined,
          remote,
          config: deps.config,
          jobs: deps.jobs,
        });
        status = result.status;
        sendJson(res, result.status, result.body);
        return;
      }

      // Everything else requires a valid bearer token BEFORE we reveal routing details.
      if (!checkBearer(req.headers.authorization, deps.token)) {
        status = 401;
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      const pathMatches = routes.filter((r) => matchPattern(r.segments, reqSegments));
      if (pathMatches.length === 0) {
        // Leave auditRoute as the `<unmatched>` sentinel — never echo the raw 404 path.
        status = 404;
        sendJson(res, 404, { error: "not found" });
        return;
      }
      // A path matched (even if the method didn't): log its server-side template, not the raw path.
      auditRoute = pathMatches[0]!.path;
      const route = pathMatches.find((r) => r.method === method);
      if (!route) {
        status = 405;
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }

      // Parse the body (with cap) for methods that carry one.
      let body: unknown;
      if (method !== "GET" && method !== "HEAD") {
        const outcome = await readJsonBody(req, maxBodyBytes);
        if (outcome.kind === "too-large") {
          status = 413;
          sendJson(res, 413, { error: "request body too large" });
          return;
        }
        if (outcome.kind === "malformed") {
          status = 400;
          sendJson(res, 400, { error: "malformed JSON body" });
          return;
        }
        body = outcome.value;
      }

      const params = matchPattern(route.segments, reqSegments)!;
      const result = await route.handler({
        req,
        res,
        params,
        body,
        remote,
        config: deps.config,
        jobs: deps.jobs,
      });
      auditRoot = result.root;
      auditJobId = result.jobId;
      status = result.status;
      sendJson(res, result.status, result.body);
    } catch (err) {
      // Typed path-guard errors map to their own status; anything else is an internal 500.
      if (err instanceof PathGuardError) {
        status = err.httpStatus;
        sendJson(res, err.httpStatus, { error: err.message });
      } else {
        status = 500;
        sendJson(res, 500, { error: "internal server error" });
      }
    } finally {
      emit();
    }
  }
}

/** Create the injectable, tested `http.Server`. Pure w.r.t. env/disk — every dependency is passed in. */
export function createServer(deps: ServerDeps): http.Server {
  return http.createServer(createRequestListener(deps));
}

/** Injectable seams for {@link startBridge} so a test verifies the flow without binding a socket. */
export interface StartBridgeDeps {
  env?: NodeJS.ProcessEnv;
  loadConfig?: () => BridgeConfig;
  audit?: (entry: AuditEntry) => void;
  /** Explicit route table override. When omitted, the full bridge surface is built via
   *  {@link registerBridgeRoutes} using {@link StartBridgeDeps.bridge}. */
  routes?: RouteDefinition[];
  /** Injectable seams (spawner, core runners, status source) for the trigger endpoints — lets a test
   *  build the running server without a real `sparra` spawn or model call. */
  bridge?: BridgeRouteDeps;
  /** Bind seam — defaults to `server.listen(port, host)`. */
  listen?: (server: http.Server, port: number, host: string) => void;
}

/**
 * Real entry point: assemble deps from env/config, FAIL CLOSED on an empty token, resolve a
 * non-wildcard bind, and listen. `createServer` stays the pure tested unit; this wires the world to
 * it.
 */
export function startBridge(deps: StartBridgeDeps = {}): http.Server {
  const env = deps.env ?? process.env;
  const config = deps.loadConfig ? deps.loadConfig() : loadBridgeConfig({ env });
  // Fail-closed: throws on unset/empty SPARRA_BRIDGE_TOKEN before anything binds.
  const token = requireBridgeToken(env);
  const bindAddr = resolveBind(config, { env });
  const jobs = new JobStore({ lastNJobs: config.lastNJobs });
  const audit =
    deps.audit ??
    ((entry: AuditEntry) => appendAudit(entry, createFileAuditSink(config.auditLogPath)));

  // Trigger endpoints are added through the registration seam — NOT by editing core routing above.
  // When a caller doesn't pass an explicit `routes` table, build the full bridge surface here so the
  // live server exposes every phase + conductor endpoint.
  const routes = deps.routes ?? registerBridgeRoutes(deps.bridge ?? {});

  const server = createServer({
    config,
    token,
    jobs,
    audit,
    routes,
  });

  const listen = deps.listen ?? ((s, port, host) => s.listen(port, host));
  listen(server, config.port, bindAddr);
  return server;
}
