/**
 * `test/http/events.test.ts` — U3: `conductors/http/events.ts`'s `EventLog` (ring + cursor + startup
 * seeding), `formatEventLine`/`normalizeEvent` bounding, `JobStore.onEvent` lifecycle emits, and the
 * `GET /events` handler/route wiring. Everything here is injected-fake (a sink array, a fake
 * `RouteContext`, an injected clock) — no real bin, no socket bind. The ONE exception is a small
 * temp-dir check of `createFileEventSink`/`readEventSeedLines` (real, but trivial, disk I/O) and the
 * live-assembly `startBridge` single-shared-instance test (which necessarily exercises the real file
 * sink `startBridge` wires by default). Because nothing here spawns the real `sparra` CLI or binds a
 * socket, this suite needs no `judgeEnv` guard.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  createFileEventSink,
  EventLog,
  formatEventLine,
  readEventSeedLines,
  type BridgeEvent,
} from "../../conductors/http/events.ts";
import { createEventsRoutes } from "../../conductors/http/handlers/events.ts";
import { JobStore } from "../../conductors/http/jobs.ts";
import { createServer, startBridge, type RouteContext } from "../../conductors/http/server.ts";
import { type SpawnedChild, type SpawnFn } from "../../conductors/http/spawn.ts";

const TOKEN = "events-test-token";

const FIXED_TS = "2026-07-14T00:00:00.000Z";
function fixedNow(): () => Date {
  return () => new Date(FIXED_TS);
}

function tmpRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "sparra-events-")));
}

function fakeCtx(url: string): RouteContext {
  return {
    req: { url } as unknown as RouteContext["req"],
    res: {} as RouteContext["res"],
    params: {},
    body: undefined,
    remote: "100.64.0.1",
    config: {} as RouteContext["config"],
    jobs: {} as RouteContext["jobs"],
  };
}

class FakeChild extends EventEmitter implements SpawnedChild {
  readonly stdout = new EventEmitter() as unknown as SpawnedChild["stdout"];
  readonly stderr = new EventEmitter() as unknown as SpawnedChild["stderr"];
  kill(): boolean {
    return true;
  }
}

/** Drive a request straight through a live `http.Server`'s "request" listener — no socket bound. */
function hit(
  server: http.Server,
  init: { method?: string; url: string; body?: unknown; auth?: boolean },
): Promise<{ status: number; json: any }> {
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
        let json: unknown;
        try {
          json = payload ? JSON.parse(payload) : undefined;
        } catch {
          json = undefined;
        }
        resolve({ status, json });
      },
    } as unknown as ServerResponse;
    server.emit("request", req, res);
  });
}

// --- EventLog: emit / ring / cursor -------------------------------------------------------------

describe("EventLog.emit", () => {
  it("assigns monotonically increasing ids from 1, sets ts from the injected clock, calls sink once with formatEventLine(event)", () => {
    const lines: string[] = [];
    const log = new EventLog({ sink: (l) => lines.push(l), now: fixedNow() });
    const e1 = log.emit({ type: "job_started", jobId: "a", kind: "build" });
    const e2 = log.emit({ type: "job_done", jobId: "a", status: "succeeded" });
    expect(e1.id).toBe(1);
    expect(e2.id).toBe(2);
    expect(e1.ts).toBe(FIXED_TS);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(formatEventLine(e1));
    expect(lines[1]).toBe(formatEventLine(e2));
  });

  it("CONTRAST: accepts a NUMERIC (epoch-ms) clock too — does NOT throw, and yields a valid ISO ts", () => {
    // The Date-clock case above uses `now: fixedNow()` (`() => Date`); EventLogOptions.now also
    // accepts `() => number` (epoch milliseconds) — e.g. a bare `Date.now` or a fixed `() => 0`.
    const log = new EventLog({ now: () => 0 });
    expect(() => log.emit({ type: "job_started", jobId: "x" })).not.toThrow();
    const e = log.emit({ type: "job_started", jobId: "y" });
    expect(e.ts).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("EventLog ring bound + since() cursor math", () => {
  it("with ringSize:3, 5 emits keeps only the last 3 but cursor still reflects the highest id (no regression)", () => {
    const log = new EventLog({ ringSize: 3, now: fixedNow() });
    for (let i = 0; i < 5; i++) log.emit({ type: "job_started", jobId: `j${i}` });

    const all = log.since(0);
    expect(all.events.map((e) => e.id)).toEqual([3, 4, 5]);
    expect(all.cursor).toBe(5);

    const from3 = log.since(3);
    expect(from3.events.map((e) => e.id)).toEqual([4, 5]);
    expect(from3.cursor).toBe(5);

    const from5 = log.since(5);
    expect(from5.events).toEqual([]);
    expect(from5.cursor).toBe(5);
  });

  it("since(cursor) delta math over an un-evicted ring: ids 1..5, various cursors", () => {
    const log = new EventLog({ now: fixedNow() });
    for (let i = 0; i < 5; i++) log.emit({ type: "job_started", jobId: `j${i}` });

    expect(log.since(3).events.map((e) => e.id)).toEqual([4, 5]);
    expect(log.since(3).cursor).toBe(5);
    expect(log.since(5).events).toEqual([]);
    expect(log.since(5).cursor).toBe(5);
    expect(log.since(0).events.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
    // A negative cursor also returns everything retained.
    expect(log.since(-1).events.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

// --- Bounding: ALL SIX request-influenced fields, ring AND sink ---------------------------------

describe("normalization bounds every request-influenced field (ring AND sink/file, emit AND seed path)", () => {
  const CTRL = "\x00\n\r";
  const bigJobId = "j!@#/" + "A".repeat(100) + CTRL;
  const bigRoot = "/root" + CTRL + "B".repeat(600) + CTRL;
  const bigQuestion = "Q" + CTRL + "C".repeat(600) + CTRL;
  const bigKind = "kind" + CTRL + "D".repeat(600) + CTRL;
  const bigPhase = "phase" + CTRL + "E".repeat(600) + CTRL;
  const bigStatus = "status" + CTRL + "F".repeat(600) + CTRL;

  function assertBounded(e: BridgeEvent): void {
    expect(e.jobId).toBeDefined();
    expect(e.jobId!.length).toBeLessThanOrEqual(64);
    expect(e.jobId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    for (const field of ["root", "question", "kind", "phase", "status"] as const) {
      const value = e[field] as string;
      expect(value).toBeDefined();
      expect(value.length).toBeLessThanOrEqual(500);
      expect(value).not.toMatch(/[\x00-\x1F\x7F]/);
    }
  }

  it("emit path: bounded in since() ring output AND in the parsed sink line", () => {
    const lines: string[] = [];
    const log = new EventLog({ sink: (l) => lines.push(l), now: fixedNow() });
    log.emit({
      type: "job_started",
      jobId: bigJobId,
      root: bigRoot,
      question: bigQuestion,
      kind: bigKind,
      phase: bigPhase,
      status: bigStatus,
    });

    const [ringEvent] = log.since(0).events;
    assertBounded(ringEvent!);

    const parsedLine = JSON.parse(lines[0]!) as BridgeEvent;
    assertBounded(parsedLine);
  });

  it("seed path: the SAME normalization is observable — a seeded record with identical oversized/control-char fields is bounded identically", () => {
    const seedLine = JSON.stringify({
      id: 1,
      ts: FIXED_TS,
      type: "job_started",
      jobId: bigJobId,
      root: bigRoot,
      question: bigQuestion,
      kind: bigKind,
      phase: bigPhase,
      status: bigStatus,
    });
    const log = new EventLog({ seedLines: [seedLine] });
    const [seeded] = log.since(0).events;
    assertBounded(seeded!);
  });
});

// --- Startup seeding: allowlist security + skip-on-malformed ------------------------------------

describe("EventLog startup seeding", () => {
  it("a whole-record extra-key seed line (e.g. a smuggled token/authorization) is DROPPED WHOLE — its id never appears", () => {
    const good = JSON.stringify({ id: 5, ts: FIXED_TS, type: "job_started", jobId: "ok" });
    const evilToken = JSON.stringify({
      id: 6,
      ts: FIXED_TS,
      type: "job_started",
      jobId: "ok2",
      token: "s3cr3t-should-never-appear",
    });
    const evilAuth = JSON.stringify({
      id: 7,
      ts: FIXED_TS,
      type: "job_done",
      status: "succeeded",
      authorization: "Bearer leak",
    });
    const log = new EventLog({ seedLines: [good, evilToken, evilAuth] });
    const { events } = log.since(0);
    expect(events.map((e) => e.id)).toEqual([5]);
    const joined = JSON.stringify(events);
    expect(joined).not.toContain("s3cr3t-should-never-appear");
    expect(joined).not.toContain("Bearer leak");
    expect(joined).not.toContain("token");
    expect(joined).not.toContain("authorization");
  });

  it("malformed JSON and wrong-typed fields (bad id, unknown type) are skipped WITHOUT throwing", () => {
    const malformedJson = "{not valid json";
    const wrongIdType = JSON.stringify({ id: "not-a-number", ts: FIXED_TS, type: "job_started" });
    const unknownType = JSON.stringify({ id: 9, ts: FIXED_TS, type: "something_else" });
    const good = JSON.stringify({ id: 10, ts: FIXED_TS, type: "job_done", status: "failed" });
    expect(
      () => new EventLog({ seedLines: [malformedJson, wrongIdType, unknownType, good] }),
    ).not.toThrow();
    const log = new EventLog({ seedLines: [malformedJson, wrongIdType, unknownType, good] });
    expect(log.since(0).events.map((e) => e.id)).toEqual([10]);
  });

  it("valid seed ids 1..4 → next emit gets id 5; the seeded events are served via since(0)", () => {
    const seedLines = [1, 2, 3, 4].map((id) =>
      JSON.stringify({ id, ts: FIXED_TS, type: "job_started", jobId: `seed-${id}` }),
    );
    const log = new EventLog({ seedLines, now: fixedNow() });
    expect(log.since(0).events.map((e) => e.id)).toEqual([1, 2, 3, 4]);
    const next = log.emit({ type: "job_done", jobId: "new", status: "succeeded" });
    expect(next.id).toBe(5);
    expect(log.since(0).events.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

// --- formatEventLine + file sink + seed reader ---------------------------------------------------

describe("formatEventLine", () => {
  it("is pure JSON round-trippable", () => {
    const e: BridgeEvent = { id: 1, ts: FIXED_TS, type: "job_started", jobId: "a", kind: "build" };
    const line = formatEventLine(e);
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual(e);
  });
});

describe("readEventSeedLines", () => {
  it("returns [] for an absent file", () => {
    expect(readEventSeedLines(join(tmpRoot(), "does-not-exist.jsonl"))).toEqual([]);
  });

  it("reads a temp file with 3 lines (one blank) → 2 non-empty lines", () => {
    const dir = tmpRoot();
    const path = join(dir, "seed.jsonl");
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(path, "line-one\n\nline-two\n", "utf8");
    expect(readEventSeedLines(path)).toEqual(["line-one", "line-two"]);
  });
});

describe("createFileEventSink", () => {
  it("creates the parent directory and appends line + newline", () => {
    const dir = join(tmpRoot(), "nested", "deeper");
    const path = join(dir, "events.jsonl");
    const sink = createFileEventSink(path);
    sink('{"id":1}');
    sink('{"id":2}');
    const text = readFileSync(path, "utf8");
    expect(text).toBe('{"id":1}\n{"id":2}\n');
  });
});

// --- JobStore.onEvent ------------------------------------------------------------------------

describe("JobStore.onEvent", () => {
  function seqIds(): () => string {
    let n = 0;
    return () => `job-${n++}`;
  }

  it("createJob emits job_started {jobId,kind,root}", () => {
    const events: any[] = [];
    const store = new JobStore({ genId: seqIds(), onEvent: (e) => events.push(e) });
    store.createJob({ kind: "build", root: "/r" });
    expect(events).toEqual([{ type: "job_started", jobId: "job-0", kind: "build", root: "/r" }]);
  });

  it("finish emits job_done with the ACTUAL terminal status — both succeeded and failed tested as a contrast pair", () => {
    const events: any[] = [];
    const store = new JobStore({ genId: seqIds(), onEvent: (e) => events.push(e) });
    store.createJob({ kind: "a" });
    store.createJob({ kind: "b" });
    events.length = 0; // drop the two job_started events; isolate finish's emit
    store.finish("job-0", { status: "succeeded" });
    store.finish("job-1", { status: "failed" });
    expect(events).toEqual([
      { type: "job_done", jobId: "job-0", status: "succeeded" },
      { type: "job_done", jobId: "job-1", status: "failed" },
    ]);
  });

  it("cancelJob emits job_done status:canceled", () => {
    const events: any[] = [];
    const store = new JobStore({ genId: seqIds(), onEvent: (e) => events.push(e) });
    store.createJob({ kind: "a", root: "/r" });
    events.length = 0;
    store.cancelJob("job-0");
    expect(events).toEqual([{ type: "job_done", jobId: "job-0", status: "canceled", root: "/r" }]);
  });

  it("finish/cancelJob on an UNKNOWN id emits NOTHING", () => {
    const events: any[] = [];
    const store = new JobStore({ genId: seqIds(), onEvent: (e) => events.push(e) });
    store.finish("nope", { status: "succeeded" });
    store.cancelJob("also-nope");
    expect(events).toEqual([]);
  });

  it("a store with no onEvent emits nothing — existing behavior unchanged", () => {
    const store = new JobStore({ genId: seqIds() });
    expect(() => {
      store.createJob({ kind: "a" });
      store.finish("job-0", { status: "succeeded" });
      store.createJob({ kind: "b" });
      store.cancelJob("job-1");
    }).not.toThrow();
  });
});

// --- GET /events handler ------------------------------------------------------------------------

describe("GET /events handler (fake RouteContext, no socket)", () => {
  it("since=2 → events with id>2 + cursor; no query → all; non-numeric/negative since → treated as 0", async () => {
    const log = new EventLog({ now: fixedNow() });
    log.emit({ type: "job_started", jobId: "a" });
    log.emit({ type: "job_started", jobId: "b" });
    log.emit({ type: "job_started", jobId: "c" });
    const [route] = createEventsRoutes({ eventLog: log });

    const since2 = await route!.handler(fakeCtx("/events?since=2"));
    expect((since2.body as any).events.map((e: BridgeEvent) => e.id)).toEqual([3]);
    expect((since2.body as any).cursor).toBe(3);

    const noQuery = await route!.handler(fakeCtx("/events"));
    expect((noQuery.body as any).events).toHaveLength(3);

    const nonNumeric = await route!.handler(fakeCtx("/events?since=abc"));
    expect((nonNumeric.body as any).events).toHaveLength(3);

    const negative = await route!.handler(fakeCtx("/events?since=-1"));
    expect((negative.body as any).events).toHaveLength(3);

    expect(route!.method).toBe("GET");
    expect(route!.path).toBe("/events");
  });

  it("is Bearer-gated through the real server (401 without a token, 200 with one)", async () => {
    const log = new EventLog();
    log.emit({ type: "job_started", jobId: "a" });
    const audit: unknown[] = [];
    const server = createServer({
      config: {
        roots: ["/tmp"],
        port: 8787,
        lastNJobs: 50,
        auditLogPath: "/tmp/a.log",
        eventsLogPath: "/tmp/e.jsonl",
        allowRemotePlan: false,
        dashboard: true,
      },
      token: TOKEN,
      jobs: new JobStore(),
      audit: (e) => audit.push(e),
      routes: createEventsRoutes({ eventLog: log }),
    });

    const noAuth = await hit(server, { method: "GET", url: "/events", auth: false });
    expect(noAuth.status).toBe(401);
    const withAuth = await hit(server, { method: "GET", url: "/events", auth: true });
    expect(withAuth.status).toBe(200);
    expect(withAuth.json.events).toHaveLength(1);
  });
});

// --- Single shared instance: startBridge wires ONE EventLog to BOTH the JobStore and the route -----

describe("startBridge shares ONE EventLog between JobStore and the /events route", () => {
  it("a job created through the live-assembled JobStore is observed by the SAME /events route", async () => {
    const dir = tmpRoot();
    const listen = vi.fn();
    const child = new FakeChild();
    const spawn: SpawnFn = () => child;

    const server = startBridge({
      env: { SPARRA_BRIDGE_TOKEN: TOKEN },
      loadConfig: () => ({
        roots: [dir],
        port: 8787,
        lastNJobs: 50,
        auditLogPath: join(dir, "audit.log"),
        eventsLogPath: join(dir, "events.jsonl"),
        allowRemotePlan: false,
        dashboard: true,
      }),
      listen,
      bridge: { spawn },
    });
    expect(listen).toHaveBeenCalledOnce();

    const build = await hit(server, { url: "/build", body: { root: dir } });
    expect(build.status).toBe(202);
    const jobId = build.json.jobId as string;
    child.emit("close", 0);

    const events = await hit(server, { method: "GET", url: "/events?since=0" });
    expect(events.status).toBe(200);
    const started = events.json.events.find(
      (e: BridgeEvent) => e.type === "job_started" && e.jobId === jobId,
    );
    expect(started).toBeDefined();
  });
});
