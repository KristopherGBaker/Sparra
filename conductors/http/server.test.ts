import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { UNMATCHED_ROUTE, type AuditEntry } from "./audit.ts";
import type { BridgeConfig } from "./config.ts";
import { JobStore } from "./jobs.ts";
import { PathGuardError } from "./paths.ts";
import {
  createRequestListener,
  createServer,
  startBridge,
  type RouteDefinition,
  type ServerDeps,
} from "./server.ts";

const TOKEN = "s3cr3t-token-value";

function baseConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    roots: ["/tmp/root"],
    port: 8787,
    lastNJobs: 50,
    auditLogPath: "/tmp/audit.log",
    allowRemotePlan: false,
    ...overrides,
  };
}

interface Harness {
  listener: (req: IncomingMessage, res: ServerResponse) => void;
  jobs: JobStore;
  audit: AuditEntry[];
}

function makeHarness(partial: Partial<ServerDeps> = {}): Harness {
  const jobs = partial.jobs ?? new JobStore();
  const audit: AuditEntry[] = [];
  const deps: ServerDeps = {
    config: partial.config ?? baseConfig(),
    token: partial.token ?? TOKEN,
    jobs,
    audit: partial.audit ?? ((e) => audit.push(e)),
    ...(partial.routes ? { routes: partial.routes } : {}),
    ...(partial.maxBodyBytes !== undefined ? { maxBodyBytes: partial.maxBodyBytes } : {}),
  };
  return { listener: createRequestListener(deps), jobs, audit };
}

interface Dispatched {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

interface RequestInit {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  remote?: string;
}

/**
 * Drive the request listener DIRECTLY with a fake IncomingMessage (a real Readable carrying the body)
 * and a fake ServerResponse — NO socket is ever opened.
 */
function dispatch(
  listener: (req: IncomingMessage, res: ServerResponse) => void,
  init: RequestInit,
): Promise<Dispatched> {
  const { method = "GET", url, headers = {}, body, remote = "100.64.0.1" } = init;
  // A real Readable so the handler's `data`/`end` stream parsing runs exactly as in production.
  const req = Readable.from(body !== undefined ? [Buffer.from(body)] : []) as unknown as IncomingMessage;
  Object.assign(req, {
    method,
    url,
    headers,
    socket: { remoteAddress: remote },
  });

  return new Promise<Dispatched>((resolve, reject) => {
    let statusCode = 0;
    const res = {
      writeHead(code: number, _headers?: Record<string, string>) {
        statusCode = code;
        return this;
      },
      end(payload?: string) {
        try {
          resolve({ status: statusCode, json: payload ? JSON.parse(payload) : undefined });
        } catch (e) {
          reject(e);
        }
      },
    } as unknown as ServerResponse;
    listener(req, res);
  });
}

function authHeaders(token = TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

describe("server — construction fail-closed", () => {
  it("createServer THROWS on an empty token (no allow-all construction)", () => {
    expect(() => createServer({ ...harnessDeps(), token: "" })).toThrow(/fail-closed/);
  });

  it("createRequestListener THROWS on a missing token", () => {
    const { token: _omit, ...withoutToken } = harnessDeps();
    expect(() => createRequestListener(withoutToken as ServerDeps)).toThrow(/fail-closed/);
  });
});

function harnessDeps(): ServerDeps {
  return {
    config: baseConfig(),
    token: TOKEN,
    jobs: new JobStore(),
    audit: () => {},
  };
}

describe("server — health + auth", () => {
  it("GET /health returns 200 {ok:true} with NO token", async () => {
    const h = makeHarness();
    const res = await dispatch(h.listener, { url: "/health" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
  });

  it("a non-health route returns 401 with no token", async () => {
    const h = makeHarness();
    const res = await dispatch(h.listener, { url: "/jobs/whatever" });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: "unauthorized" });
  });

  it("a non-health route returns 401 with an INVALID token", async () => {
    const h = makeHarness();
    const res = await dispatch(h.listener, { url: "/jobs/whatever", headers: authHeaders("wrong") });
    expect(res.status).toBe(401);
  });
});

describe("server — built-in job routes", () => {
  it("GET /jobs/:id returns the job JSON or 404", async () => {
    const jobs = new JobStore({ genId: () => "abc" });
    jobs.createJob({ kind: "build", root: "/tmp/root/x" });
    const h = makeHarness({ jobs });
    const ok = await dispatch(h.listener, { url: "/jobs/abc", headers: authHeaders() });
    expect(ok.status).toBe(200);
    expect(ok.json.kind).toBe("build");
    const missing = await dispatch(h.listener, { url: "/jobs/nope", headers: authHeaders() });
    expect(missing.status).toBe(404);
  });

  it("POST /jobs/:id/cancel cancels + returns the job, or 404", async () => {
    const jobs = new JobStore({ genId: () => "abc" });
    jobs.createJob({ kind: "build" });
    const cancel = vi.fn();
    jobs.registerCancel("abc", cancel);
    const h = makeHarness({ jobs });
    const res = await dispatch(h.listener, { method: "POST", url: "/jobs/abc/cancel", headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("canceled");
    expect(cancel).toHaveBeenCalledOnce();
    const missing = await dispatch(h.listener, {
      method: "POST",
      url: "/jobs/none/cancel",
      headers: authHeaders(),
    });
    expect(missing.status).toBe(404);
  });
});

describe("server — cross-cutting behaviors", () => {
  it("404 for an unknown path (authed)", async () => {
    const h = makeHarness();
    const res = await dispatch(h.listener, { url: "/nope", headers: authHeaders() });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "not found" });
  });

  it("405 for a wrong method on a known path", async () => {
    const h = makeHarness();
    const res = await dispatch(h.listener, { method: "POST", url: "/jobs/abc", headers: authHeaders() });
    expect(res.status).toBe(405);
    expect(res.json).toEqual({ error: "method not allowed" });
  });

  it("400 on malformed JSON body", async () => {
    const routes: RouteDefinition[] = [
      { method: "POST", path: "/echo", handler: ({ body }) => ({ status: 200, body }) },
    ];
    const h = makeHarness({ routes });
    const res = await dispatch(h.listener, {
      method: "POST",
      url: "/echo",
      headers: authHeaders(),
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "malformed JSON body" });
  });

  it("413 when the body exceeds the size cap", async () => {
    const routes: RouteDefinition[] = [
      { method: "POST", path: "/echo", handler: ({ body }) => ({ status: 200, body }) },
    ];
    const h = makeHarness({ routes, maxBodyBytes: 16 });
    const res = await dispatch(h.listener, {
      method: "POST",
      url: "/echo",
      headers: authHeaders(),
      body: JSON.stringify({ big: "x".repeat(1000) }),
    });
    expect(res.status).toBe(413);
  });

  it("500 on an uncaught handler exception, with an {error} shape and no leaked message", async () => {
    const routes: RouteDefinition[] = [
      {
        method: "GET",
        path: "/boom",
        handler: () => {
          throw new Error("kaboom");
        },
      },
    ];
    const h = makeHarness({ routes });
    const res = await dispatch(h.listener, { url: "/boom", headers: authHeaders() });
    expect(res.status).toBe(500);
    expect(res.json.error).toBeDefined();
    expect(res.json.error).not.toContain("kaboom");
  });

  it("maps a typed PathGuardError to its httpStatus (403)", async () => {
    const routes: RouteDefinition[] = [
      {
        method: "GET",
        path: "/guarded",
        handler: () => {
          throw new PathGuardError("outside root", 403);
        },
      },
    ];
    const h = makeHarness({ routes });
    const res = await dispatch(h.listener, { url: "/guarded", headers: authHeaders() });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: "outside root" });
  });

  it("maps a typed PathGuardError to 400 for invalid input", async () => {
    const routes: RouteDefinition[] = [
      {
        method: "GET",
        path: "/guarded",
        handler: () => {
          throw new PathGuardError("empty path", 400);
        },
      },
    ];
    const h = makeHarness({ routes });
    const res = await dispatch(h.listener, { url: "/guarded", headers: authHeaders() });
    expect(res.status).toBe(400);
  });
});

describe("server — route registration seam + real dispatch", () => {
  it("a later-unit route is reachable with parsed :id param and JSON body", async () => {
    const routes: RouteDefinition[] = [
      {
        method: "POST",
        path: "/things/:id",
        handler: ({ params, body }) => ({ status: 201, body: { id: params.id, echo: body } }),
      },
    ];
    const h = makeHarness({ routes });
    const res = await dispatch(h.listener, {
      method: "POST",
      url: "/things/42",
      headers: authHeaders(),
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ id: "42", echo: { hello: "world" } });
  });

  it("a registered route WITHOUT a token is still gated (401) — no public escape via the seam", async () => {
    const routes: RouteDefinition[] = [
      { method: "GET", path: "/secret", handler: () => ({ status: 200, body: { ok: true } }) },
    ];
    const h = makeHarness({ routes });
    // No auth header at all → must be 401, never reachable.
    expect((await dispatch(h.listener, { url: "/secret" })).status).toBe(401);
    // A registered route that tried to smuggle `public: true` still gets NO auth exemption: the
    // field is not part of RouteDefinition, so even when present it is ignored by the router.
    const sneaky = makeHarness({
      routes: [
        {
          method: "GET",
          path: "/sneaky",
          public: true,
          handler: () => ({ status: 200, body: { ok: true } }),
        } as RouteDefinition,
      ],
    });
    expect((await dispatch(sneaky.listener, { url: "/sneaky" })).status).toBe(401);
    // …and WITH a token it works normally, proving the route itself is wired.
    expect((await dispatch(sneaky.listener, { url: "/sneaky", headers: authHeaders() })).status).toBe(200);
  });
});

describe("server — audit per request, secret-free", () => {
  it("emits exactly one line per request for success AND every rejection, never leaking the token", async () => {
    const jobs = new JobStore({ genId: () => "abc" });
    jobs.createJob({ kind: "build", root: "/tmp/root/x" });
    const routes: RouteDefinition[] = [
      {
        method: "GET",
        path: "/boom",
        handler: () => {
          throw new Error("kaboom");
        },
      },
      { method: "POST", path: "/echo", handler: ({ body }) => ({ status: 200, body }) },
    ];
    const h = makeHarness({ jobs, routes });

    await dispatch(h.listener, { url: "/health" }); // 200
    await dispatch(h.listener, { url: "/jobs/abc", headers: authHeaders() }); // 200 + root
    await dispatch(h.listener, { url: "/jobs/whatever" }); // 401
    await dispatch(h.listener, { url: "/nope", headers: authHeaders() }); // 404
    await dispatch(h.listener, { method: "POST", url: "/jobs/abc", headers: authHeaders() }); // 405
    await dispatch(h.listener, { method: "POST", url: "/echo", headers: authHeaders(), body: "{bad" }); // 400
    await dispatch(h.listener, { url: "/boom", headers: authHeaders() }); // 500

    const results = h.audit.map((e) => e.result);
    expect(results).toEqual([200, 200, 401, 404, 405, 400, 500]);
    expect(h.audit).toHaveLength(7);
    // Each line carries the matched route TEMPLATE (or the `<unmatched>` sentinel), never the raw
    // request path (`/jobs/whatever`, `/nope` must NOT appear).
    expect(h.audit.map((e) => e.route)).toEqual([
      "/health",
      "/jobs/:id",
      UNMATCHED_ROUTE, // 401 rejected before routing
      UNMATCHED_ROUTE, // 404 unknown path
      "/jobs/:id", // 405 path matched, wrong method
      "/echo",
      "/boom",
    ]);
    // Audit logs the matched allowlist ENTRY ("/tmp/root"), not the resolved sub-path ("/tmp/root/x").
    expect(h.audit[1]!.root).toBe("/tmp/root");
    expect(h.audit[1]!.jobId).toBe("abc");
    const joined = JSON.stringify(h.audit);
    expect(joined).not.toContain(TOKEN);
    expect(joined).not.toContain("Bearer");
    expect(joined).not.toContain("whatever");
    expect(joined).not.toContain("nope");
  });

  it("STRUCTURAL: adversarial request paths never reach the FORMATTED line — accepted AND rejected", async () => {
    // Drive real requests through the server with unpredictable, PLAIN (non-secret-shaped) path text
    // plus bearer/api-key-shaped values, and assert the formatted audit line (what hits the file)
    // logs only the server-side route template / sentinel — never the raw target.
    const { formatAuditLine, UNMATCHED_ROUTE: SENTINEL } = await import("./audit.ts");
    const lines: string[] = [];
    const audit = (e: AuditEntry) => lines.push(formatAuditLine(e));
    const routes: RouteDefinition[] = [
      { method: "POST", path: "/things/:id", handler: () => ({ status: 200, body: { ok: true } }) },
    ];
    const h = makeHarness({ routes, audit });

    const plain = "correct-horse-battery-staple-unpredictable";
    const bearer = "AbCdEf0123456789AbCdEf0123456789";
    const apiKey = "sk-ABCDEF1234567890ghijkl";

    // (accepted) matched route, param carries adversarial text
    await dispatch(h.listener, { method: "POST", url: `/things/${plain}${apiKey}`, headers: authHeaders() });
    // (rejected 404) unmatched path carries plain + bearer text
    await dispatch(h.listener, { url: `/leak/${plain}/${bearer}`, headers: authHeaders() });
    // (rejected 401) no token, path carries a `Bearer` fragment
    await dispatch(h.listener, { url: `/x/Bearer/${bearer}` });

    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("/things/:id"); // accepted → template
    expect(lines[1]).toContain(SENTINEL); // 404 → sentinel
    expect(lines[2]).toContain(SENTINEL); // 401 → sentinel
    const joined = lines.join("\n");
    // Non-vacuous: if the logger echoed the raw path, these WOULD appear. ("things" is intentionally
    // NOT probed — it's a legitimate part of the /things/:id template, not raw client input.)
    for (const bad of [plain, bearer, apiKey, "leak"]) {
      expect(joined).not.toContain(bad);
    }
  });

  it("logs the matched allowlist ENTRY (trusted parent), NOT the arbitrary resolved sub-path", async () => {
    const { formatAuditLine } = await import("./audit.ts");
    const lines: string[] = [];
    const audit = (e: AuditEntry) => lines.push(formatAuditLine(e));
    // config.roots = ["/tmp/root"]. The accepted request resolves to a SUB-PATH under that entry
    // whose tail is arbitrary/unpredictable text — that tail must NOT reach the audit line.
    const subPathTail = "SOMErandomsubdir-unpredictable-AbCdEf0123456789";
    const resolvedSubPath = `/tmp/root/${subPathTail}`;
    const routes: RouteDefinition[] = [
      // accepted: resolved root is a sub-path UNDER the allowlist entry /tmp/root
      { method: "GET", path: "/ok", handler: () => ({ status: 200, body: { ok: true }, root: resolvedSubPath }) },
    ];
    const h = makeHarness({ routes, audit });

    await dispatch(h.listener, { url: "/ok", headers: authHeaders() });

    expect(lines.length).toBe(1);
    // Logs the trusted allowlist ENTRY, not the resolved sub-path.
    expect(JSON.parse(lines[0]!).root).toBe("/tmp/root");
    // Non-vacuous: if the full resolved sub-path were logged, this arbitrary tail WOULD appear.
    expect(lines[0]).not.toContain(subPathTail);
    expect(lines[0]).not.toContain("SOMErandomsubdir");
    expect(lines[0]).not.toContain("AbCdEf0123456789");
  });

  it("OMITS a raw client root on rejection (never echoed), keeps the entry on success", async () => {
    const { formatAuditLine } = await import("./audit.ts");
    const lines: string[] = [];
    const audit = (e: AuditEntry) => lines.push(formatAuditLine(e));
    // A handler that (like a buggy later unit) returns a raw client-supplied root on a REJECTED
    // request must NOT get it echoed; an accepted request logs the matched allowlist entry.
    const adversarialRoot = "/etc/evil/holdout-plaintext-xyz-AbCdEf0123456789AbCdEf0123456789";
    const routes: RouteDefinition[] = [
      { method: "GET", path: "/ok", handler: () => ({ status: 200, body: { ok: true }, root: "/tmp/root/proj" }) },
      { method: "GET", path: "/bad", handler: () => ({ status: 403, body: { error: "nope" }, root: adversarialRoot }) },
    ];
    const h = makeHarness({ routes, audit });

    await dispatch(h.listener, { url: "/ok", headers: authHeaders() });
    await dispatch(h.listener, { url: "/bad", headers: authHeaders() });

    expect(lines.length).toBe(2);
    // Accepted → the matched allowlist ENTRY is present.
    expect(JSON.parse(lines[0]!).root).toBe("/tmp/root");
    // Rejected → root omitted, adversarial text absent.
    expect(JSON.parse(lines[1]!).root).toBeUndefined();
    expect(lines[1]).not.toContain("evil");
    expect(lines[1]).not.toContain("holdout-plaintext-xyz");
    expect(lines[1]).not.toContain("AbCdEf0123456789"); // bearer-shaped tail of the raw root
  });

  it("uses the SOCKET remote address for `remote`, never a spoofable X-Forwarded-For header", async () => {
    const { formatAuditLine } = await import("./audit.ts");
    const lines: string[] = [];
    const audit = (e: AuditEntry) => lines.push(formatAuditLine(e));
    const h = makeHarness({ audit });
    await dispatch(h.listener, {
      url: "/health",
      remote: "100.64.0.7",
      headers: { "x-forwarded-for": "evil-spoof-198.51.100.9", "x-real-ip": "evil-spoof-2" },
    });
    expect(JSON.parse(lines[0]!).remote).toBe("100.64.0.7");
    expect(lines[0]).not.toContain("evil-spoof");
  });
});

describe("startBridge — fail-closed + bind", () => {
  it("THROWS on an empty token before binding", () => {
    const listen = vi.fn();
    expect(() =>
      startBridge({
        env: { SPARRA_BRIDGE_TOKEN: "" },
        loadConfig: () => baseConfig(),
        listen,
      }),
    ).toThrow(/unset or empty/);
    expect(listen).not.toHaveBeenCalled();
  });

  it("resolves a non-wildcard bind and calls listen(port, bindAddr)", () => {
    const listen = vi.fn();
    const audit = vi.fn();
    startBridge({
      env: { SPARRA_BRIDGE_TOKEN: TOKEN, SPARRA_BRIDGE_BIND: "100.64.0.1" },
      loadConfig: () => baseConfig({ port: 9191 }),
      audit,
      listen,
    });
    expect(listen).toHaveBeenCalledOnce();
    const [, port, host] = listen.mock.calls[0]!;
    expect(port).toBe(9191);
    expect(host).toBe("100.64.0.1");
  });

  it("THROWS rather than binding when config yields a wildcard", () => {
    const listen = vi.fn();
    expect(() =>
      startBridge({
        env: { SPARRA_BRIDGE_TOKEN: TOKEN },
        loadConfig: () => baseConfig({ bind: "0.0.0.0" }),
        listen,
      }),
    ).toThrow(/wildcard/);
    expect(listen).not.toHaveBeenCalled();
  });
});
