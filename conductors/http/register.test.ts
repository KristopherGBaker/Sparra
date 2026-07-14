import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import type { ParentSummary } from "../core/index.ts";
import type { BridgeConfig } from "./config.ts";
import { registerBridgeRoutes } from "./register.ts";
import { startBridge } from "./server.ts";
import { type SpawnedChild, type SpawnFn } from "./spawn.ts";

const TOKEN = "integration-token";

class FakeChild extends EventEmitter implements SpawnedChild {
  readonly stdout = new EventEmitter() as unknown as SpawnedChild["stdout"];
  readonly stderr = new EventEmitter() as unknown as SpawnedChild["stderr"];
  kill(): boolean {
    return true;
  }
}

function tmpRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "sparra-reg-")));
}

function baseConfig(roots: string[]): BridgeConfig {
  return {
    roots,
    port: 8787,
    lastNJobs: 50,
    auditLogPath: "/tmp/a.log",
    eventsLogPath: "/tmp/events.jsonl",
    allowRemotePlan: false,
    dashboard: true,
  };
}

/** Drive a request straight through a live `http.Server`'s "request" listener — no socket bound.
 *  Carries a valid Bearer token by default; pass `auth: false` to omit it (proving a route is still
 *  gated, or — for `GET /`/`GET /health` — that it works WITHOUT one). */
function hit(
  server: http.Server,
  init: { method?: string; url: string; body?: unknown; auth?: boolean },
): Promise<{ status: number; json: any; text: string | undefined }> {
  const bodyStr = init.body !== undefined ? JSON.stringify(init.body) : undefined;
  const req = Readable.from(bodyStr !== undefined ? [Buffer.from(bodyStr)] : []) as unknown as IncomingMessage;
  Object.assign(req, {
    method: init.method ?? "POST",
    url: init.url,
    headers: {
      ...(init.auth === false ? {} : { authorization: `Bearer ${TOKEN}` }),
      "content-type": "application/json",
    },
    socket: { remoteAddress: "100.64.0.1" },
  });
  return new Promise((resolve) => {
    let status = 0;
    const res = {
      writeHead(code: number) {
        status = code;
        return this;
      },
      end(payload?: string) {
        // The dashboard's GET / responds with raw HTML (not JSON) — parse best-effort so a non-JSON
        // body (e.g. `<!doctype html>...`) resolves as `{json: undefined, text: <raw>}` instead of
        // throwing.
        let json: unknown;
        try {
          json = payload ? JSON.parse(payload) : undefined;
        } catch {
          json = undefined;
        }
        resolve({ status, json, text: payload });
      },
    } as unknown as ServerResponse;
    server.emit("request", req, res);
  });
}

describe("registerBridgeRoutes", () => {
  it("registers every phase + conductor + dashboard route", () => {
    const paths = registerBridgeRoutes().map((r) => `${r.method} ${r.path}`);
    for (const expected of [
      "POST /build",
      "POST /reflect",
      "POST /resume",
      "POST /init",
      "POST /freeze",
      "GET /projects",
      "POST /plan",
      "POST /role",
      "POST /unit",
      "GET /",
      "GET /events",
    ]) {
      expect(paths).toContain(expected);
    }
  });
});

describe("GET / (dashboard) — reachable through startBridge, existing auth UNCHANGED", () => {
  it("serves the dashboard WITHOUT a token through the full live listener", async () => {
    const root = tmpRoot();
    const listen = vi.fn();
    const readAssets = vi.fn(() => ({
      html: "<!doctype html><html><body><!--MARK--></body></html>",
      client: "export const x = 1;",
    }));
    const server = startBridge({
      env: { SPARRA_BRIDGE_TOKEN: TOKEN },
      loadConfig: () => baseConfig([root]),
      listen,
      bridge: {
        readDashboardAssets: () => {
          const assets = readAssets();
          // Substitute the REAL marker so the assembler doesn't throw — this harness only cares
          // about reachability/auth, not the exact inlining (that's dashboard.test.ts's job).
          return { html: assets.html.replace("<!--MARK-->", "/* __SPARRA_DASHBOARD_CLIENT__ */"), client: assets.client };
        },
      },
    });

    const res = await hit(server, { method: "GET", url: "/", auth: false });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/^<!doctype html>/i);
  });

  it("GET /projects (and every other route) STILL returns 401 without a token — the dashboard addition changes NOTHING else", async () => {
    const root = tmpRoot();
    const listen = vi.fn();
    const server = startBridge({
      env: { SPARRA_BRIDGE_TOKEN: TOKEN },
      loadConfig: () => baseConfig([root]),
      listen,
    });

    const noAuth = await hit(server, { method: "GET", url: "/projects", auth: false });
    expect(noAuth.status).toBe(401);
    const withAuth = await hit(server, { method: "GET", url: "/projects", auth: true });
    expect(withAuth.status).toBe(200);

    // GET /health and GET / are the ONLY two unauthenticated paths; every other registered route
    // still demands a token (a regression here would mean the dashboard's public exception leaked).
    const buildNoAuth = await hit(server, { url: "/build", body: { root }, auth: false });
    expect(buildNoAuth.status).toBe(401);
  });
});

describe("startBridge — full surface, no socket, no real spawn/model", () => {
  it("builds the server and reaches BOTH /build and /role through the live listener", async () => {
    const root = tmpRoot();
    const listen = vi.fn();
    const child = new FakeChild();
    const spawn: SpawnFn = () => child;
    const canned: ParentSummary = {
      roleKind: "generator",
      backend: "claude",
      model: "sonnet",
      ok: true,
      verdict: "pass",
      errors: [],
      tokens: 1,
      costUsd: 0,
    };
    const runRole = vi.fn(async () => canned);

    const server = startBridge({
      env: { SPARRA_BRIDGE_TOKEN: TOKEN },
      loadConfig: () => baseConfig([root]),
      listen,
      bridge: { spawn, runRole },
    });
    expect(listen).toHaveBeenCalledOnce();

    const build = await hit(server, { url: "/build", body: { root } });
    expect(build.status).toBe(202);
    expect(build.json.jobId).toBeTruthy();
    // The build holds the shared per-target lock until its child exits; release it before /role
    // (a generator writer) targets the same root.
    child.emit("close", 0);

    const role = await hit(server, { url: "/role", body: { workspace: root, kind: "generator" } });
    expect(role.status).toBe(200);
    expect(role.json).toEqual(canned);
    expect(runRole).toHaveBeenCalledOnce();
  });
});
