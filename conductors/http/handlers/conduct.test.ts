/**
 * `conductors/http/handlers/conduct.test.ts` — U3: `POST /conduct`, `pendingDecisions` on
 * `GET /jobs/:id`, and `POST /jobs/:id/decision`.
 *
 * Mirrors `phases.test.ts`: a fake spawner (`FakeChild`), direct `createRequestListener` dispatch with
 * `Readable.from` bodies, an injected audit sink, temp dirs only, NO sockets and NO real spawn. The
 * decision path resolves through U2's real engine writing into a temp run dir.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, existsSync, readFileSync, realpathSync, symlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { formatAuditLine, type AuditEntry } from "../audit.ts";
import type { BridgeConfig } from "../config.ts";
import { JobStore } from "../jobs.ts";
import { createRequestListener, type ServerDeps } from "../server.ts";
import { TargetLock, type SpawnedChild, type SpawnFn } from "../spawn.ts";
import { createConductRoutes, type ConductRouteDeps } from "./conduct.ts";
import { EventLog } from "../events.ts";
import { registerBridgeRoutes } from "../register.ts";
import { formatDecisionParkedAnnouncement, formatRunStartAnnouncement } from "../../../src/conduct/announce.ts";

const TOKEN = "s3cr3t";

class FakeChild extends EventEmitter implements SpawnedChild {
  readonly stdout = new EventEmitter() as unknown as SpawnedChild["stdout"];
  readonly stderr = new EventEmitter() as unknown as SpawnedChild["stderr"];
  emitStdout(text: string): void {
    (this.stdout as unknown as EventEmitter).emit("data", Buffer.from(text));
  }
  kill(): boolean {
    return true;
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  options: { cwd?: string };
}

function fakeSpawner(): { spawn: SpawnFn; calls: SpawnCall[]; children: FakeChild[] } {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
}

function baseConfig(roots: string[]): BridgeConfig {
  return {
    roots,
    port: 8787,
    lastNJobs: 50,
    auditLogPath: "/tmp/audit.log",
    eventsLogPath: "/tmp/events.jsonl",
    allowRemotePlan: false,
    dashboard: true,
  };
}

function makeHarness(config: BridgeConfig, conductDeps: ConductRouteDeps, auditLines?: string[]) {
  const jobs = new JobStore();
  const deps: ServerDeps = {
    config,
    token: TOKEN,
    jobs,
    audit: (entry: AuditEntry) => auditLines?.push(formatAuditLine(entry)),
    routes: createConductRoutes(conductDeps),
  };
  return { listener: createRequestListener(deps), jobs };
}

interface Dispatched {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function dispatch(
  listener: (req: IncomingMessage, res: ServerResponse) => void,
  init: { method?: string; url: string; body?: unknown; auth?: boolean | string },
): Promise<Dispatched> {
  const method = init.method ?? "POST";
  const bodyStr = init.body !== undefined ? JSON.stringify(init.body) : undefined;
  const req = Readable.from(bodyStr !== undefined ? [Buffer.from(bodyStr)] : []) as unknown as IncomingMessage;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.auth === undefined || init.auth === true) headers.authorization = `Bearer ${TOKEN}`;
  else if (typeof init.auth === "string") headers.authorization = init.auth;
  Object.assign(req, { method, url: init.url, headers, socket: { remoteAddress: "100.64.0.1" } });
  return new Promise<Dispatched>((resolve, reject) => {
    let statusCode = 0;
    const res = {
      writeHead(code: number) {
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

function tmpRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "sparra-conduct-bridge-")));
}

/** The run dir a conduct child would announce for `root`. */
function runDirFor(root: string, runId = "conduct-fixture"): string {
  return join(root, ".sparra", "conduct", runId);
}

/** Seed a parked decisions dir + a run.json pending record for `seq` under `runDir`. */
function seedParked(
  runDir: string,
  seq: number,
  opts: { options: string[]; def: string; unit?: string; kind?: string; extra?: Record<string, unknown> },
): void {
  const unit = opts.unit ?? "unit-001";
  const kind = opts.kind ?? "unit-exhausted";
  mkdirSync(join(runDir, "decisions"), { recursive: true });
  writeFileSync(
    join(runDir, "decisions", `${seq}.request.json`),
    JSON.stringify({
      id: `${unit}-${seq}`,
      seq,
      unit,
      kind,
      question: "Q?",
      options: opts.options,
      default: opts.def,
      expiresAt: "2026-07-13T00:00:00.000Z",
      ...(opts.extra ?? {}),
    }),
  );
  writeFileSync(
    join(runDir, "run.json"),
    JSON.stringify({
      runId: "conduct-fixture",
      status: "running",
      units: [
        {
          id: unit,
          title: "U",
          outcome: "running",
          briefPath: "b",
          decisions: [
            { seq, unit, kind, question: "Q?", options: opts.options, default: opts.def, status: "pending", requestedAt: "2026-07-13T00:00:00.000Z" },
          ],
        },
      ],
    }),
  );
}

/** POST /conduct then announce a run so the job has a runDir; returns the jobId + runDir. */
async function conductAndAnnounce(
  listener: (req: IncomingMessage, res: ServerResponse) => void,
  children: FakeChild[],
  root: string,
): Promise<{ jobId: string; runDir: string }> {
  const res = await dispatch(listener, { url: "/conduct", body: { root, prompt: "build a thing" } });
  expect(res.status).toBe(202);
  const runDir = runDirFor(root);
  children.at(-1)!.emitStdout(formatRunStartAnnouncement("conduct-fixture", runDir) + "\n");
  return { jobId: res.json.jobId, runDir };
}

describe("POST /conduct — argv + cwd + lock", () => {
  it("valid body → 202 {jobId}; argv starts `conduct <prompt>` with only server-built flags; cwd=root", async () => {
    const root = tmpRoot();
    const { spawn, calls } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const res = await dispatch(listener, {
      url: "/conduct",
      body: { root, prompt: "make X", auto: true, mode: "llm", maxUnits: 3, concurrency: 1, budget: 5, maxTurns: 80 },
    });
    expect(res.status).toBe(202);
    expect(res.json.jobId).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(1)).toEqual([
      "conduct", "make X", "--auto", "--brain", "llm",
      "--max-units", "3", "--concurrency", "1", "--budget", "5", "--max-turns", "80",
    ]);
    expect(calls[0]!.options.cwd).toBe(root);
  });

  it("minimal body → just `conduct <prompt>` (no stray flags)", async () => {
    const root = tmpRoot();
    const { spawn, calls } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const res = await dispatch(listener, { url: "/conduct", body: { root, prompt: "hi" } });
    expect(res.status).toBe(202);
    expect(calls[0]!.args.slice(1)).toEqual(["conduct", "hi"]);
  });

  it("unknown body field → 400, spawner NOT called; out-of-allowlist root → 403, NOT called", async () => {
    const root = tmpRoot();
    const { spawn, calls } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    expect((await dispatch(listener, { url: "/conduct", body: { root, prompt: "x", evil: 1 } })).status).toBe(400);
    expect((await dispatch(listener, { url: "/conduct", body: { root: "/etc/evil", prompt: "x" } })).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("held TargetLock for the same root → 409 naming holder; released when the fake child settles", async () => {
    const root = tmpRoot();
    const { spawn, calls, children } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const first = await dispatch(listener, { url: "/conduct", body: { root, prompt: "a" } });
    expect(first.status).toBe(202);
    const second = await dispatch(listener, { url: "/conduct", body: { root, prompt: "b" } });
    expect(second.status).toBe(409);
    expect(second.json.jobId).toBe(first.json.jobId);
    children[0]!.emit("close", 0); // child settles → lock released
    const third = await dispatch(listener, { url: "/conduct", body: { root, prompt: "c" } });
    expect(third.status).toBe(202);
    expect(calls.length).toBe(2); // only the two accepted requests ever spawned
  });
});

describe("POST /conduct — commit/merge/resume parity (unit-001)", () => {
  const SAFE_RUN_ID = "conduct-2026-07-13T06-44-18";

  // Assertion 1: fresh commit/merge matrix — deep equality on captured argv (bridge forwards flags
  // verbatim; it does NOT synthesize `--commit` from `--merge`).
  const freshMatrix: Array<[string, Record<string, unknown>, string[]]> = [
    ["commit only", { commit: true }, ["conduct", "p", "--commit"]],
    ["merge only (no synthesized --commit)", { merge: true }, ["conduct", "p", "--merge"]],
    ["commit + merge", { commit: true, merge: true }, ["conduct", "p", "--commit", "--merge"]],
    ["land only (no synthesized --merge/--commit)", { land: true }, ["conduct", "p", "--land"]],
    ["push only (no synthesized --land/--merge/--commit)", { push: true }, ["conduct", "p", "--push"]],
    [
      "commit + merge + land + push (verbatim order)",
      { commit: true, merge: true, land: true, push: true },
      ["conduct", "p", "--commit", "--merge", "--land", "--push"],
    ],
  ];
  for (const [label, extra, expected] of freshMatrix) {
    it(`fresh ${label} → argv deep-equals ${JSON.stringify(expected)}`, async () => {
      const root = tmpRoot();
      const { spawn, calls } = fakeSpawner();
      const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
      const res = await dispatch(listener, { url: "/conduct", body: { root, prompt: "p", ...extra } });
      expect(res.status).toBe(202);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args.slice(1)).toEqual(expected);
    });
  }

  // Assertion 2: resume argv.
  it("resume with auto+commit+merge → argv deep-equals ['conduct','--resume',<id>,'--auto','--commit','--merge']", async () => {
    const root = tmpRoot();
    const { spawn, calls } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const res = await dispatch(listener, {
      url: "/conduct",
      body: { root, resume: SAFE_RUN_ID, auto: true, commit: true, merge: true },
    });
    expect(res.status).toBe(202);
    expect(calls[0]!.args.slice(1)).toEqual([
      "conduct", "--resume", SAFE_RUN_ID, "--auto", "--commit", "--merge",
    ]);
    expect(calls[0]!.options.cwd).toBe(root);
  });

  it("resume with land+push → argv deep-equals ['conduct','--resume',<id>,'--land','--push'] (verbatim, not synthesized)", async () => {
    const root = tmpRoot();
    const { spawn, calls } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const res = await dispatch(listener, { url: "/conduct", body: { root, resume: SAFE_RUN_ID, land: true, push: true } });
    expect(res.status).toBe(202);
    expect(calls[0]!.args.slice(1)).toEqual(["conduct", "--resume", SAFE_RUN_ID, "--land", "--push"]);
  });

  it("bare resume → argv deep-equals ['conduct','--resume',<id>]", async () => {
    const root = tmpRoot();
    const { spawn, calls } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const res = await dispatch(listener, { url: "/conduct", body: { root, resume: SAFE_RUN_ID } });
    expect(res.status).toBe(202);
    expect(calls[0]!.args.slice(1)).toEqual(["conduct", "--resume", SAFE_RUN_ID]);
  });

  // Assertion 3: 400 matrix — each case 400 with ZERO spawns.
  const four00: Array<[string, Record<string, unknown>]> = [
    ["both prompt AND resume", { prompt: "p", resume: SAFE_RUN_ID }],
    ["neither prompt NOR resume", {}],
    ["resume + mode", { resume: SAFE_RUN_ID, mode: "llm" }],
    ["resume + maxUnits", { resume: SAFE_RUN_ID, maxUnits: 3 }],
    ["resume + concurrency", { resume: SAFE_RUN_ID, concurrency: 2 }],
    ["resume + budget", { resume: SAFE_RUN_ID, budget: 5 }],
    ["resume + maxTurns", { resume: SAFE_RUN_ID, maxTurns: 80 }],
    ["unknown field (strict)", { prompt: "p", evil: 1 }],
  ];
  for (const [label, body] of four00) {
    it(`400 (no spawn): ${label}`, async () => {
      const root = tmpRoot();
      const { spawn, calls } = fakeSpawner();
      const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
      const res = await dispatch(listener, { url: "/conduct", body: { root, ...body } });
      expect(res.status, label).toBe(400);
      expect(calls, label).toHaveLength(0);
    });
  }

  // Contrast: `resume + mode` (a run-shaping field) still 400s above, but `resume + land`/`resume +
  // push` are RESUME-COMPATIBLE (the CLI's `--resume` accepts `--land`/`--push` and re-evaluates their
  // gates over the persisted state) → 202, spawned, forwarded verbatim.
  const resumeCompatible: Array<[string, Record<string, unknown>, string[]]> = [
    ["resume + land", { land: true }, ["conduct", "--resume", SAFE_RUN_ID, "--land"]],
    ["resume + push", { push: true }, ["conduct", "--resume", SAFE_RUN_ID, "--push"]],
  ];
  for (const [label, extra, expected] of resumeCompatible) {
    it(`${label} → 202 (NOT 400, contrast with resume + mode), argv deep-equals ${JSON.stringify(expected)}`, async () => {
      const root = tmpRoot();
      const { spawn, calls } = fakeSpawner();
      const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
      const res = await dispatch(listener, { url: "/conduct", body: { root, resume: SAFE_RUN_ID, ...extra } });
      expect(res.status, label).toBe(202);
      expect(calls, label).toHaveLength(1);
      expect(calls[0]!.args.slice(1), label).toEqual(expected);
    });
  }

  // Assertion 4: unsafe runId → 400 BEFORE lock/spawn — zero spawns, JobStore unchanged, lock free.
  const unsafeIds = ["../x", "a/b", "a\\b", "-flag", "..", "x/../y"];
  for (const bad of unsafeIds) {
    it(`unsafe runId ${JSON.stringify(bad)} → 400 before lock/spawn (no side effects)`, async () => {
      const root = tmpRoot();
      const { spawn, calls } = fakeSpawner();
      const lock = new TargetLock();
      const { listener, jobs } = makeHarness(baseConfig([root]), { lock, spawn });
      const before = jobs.listJobs().length;
      const res = await dispatch(listener, { url: "/conduct", body: { root, resume: bad } });
      expect(res.status, bad).toBe(400);
      expect(calls, bad).toHaveLength(0);
      expect(jobs.listJobs().length, bad).toBe(before);
      expect(lock.holder(root), bad).toBeUndefined();
    });
  }

  // Assertion 5: lock-held resume → 409, no new job, no additional spawn.
  it("resume while the target lock is held → 409, no new job/spawn", async () => {
    const root = tmpRoot();
    const { spawn, calls } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const first = await dispatch(listener, { url: "/conduct", body: { root, prompt: "a" } });
    expect(first.status).toBe(202);
    const second = await dispatch(listener, { url: "/conduct", body: { root, resume: SAFE_RUN_ID } });
    expect(second.status).toBe(409);
    expect(second.json.jobId).toBe(first.json.jobId);
    expect(calls).toHaveLength(1); // only the first (fresh) run ever spawned
  });
});

describe("POST /conduct — announce-association on a RESUMED run (assertion 6)", () => {
  const RESUME_ID = "conduct-resume-fixture";

  it("resumed run re-announces → job gains runId+runDir; decision surfaces + resolves", async () => {
    const root = tmpRoot();
    const { spawn, children } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    // Seed the persisted run dir + a parked decision, then resume it.
    const runDir = runDirFor(root, RESUME_ID);
    const res = await dispatch(listener, { url: "/conduct", body: { root, resume: RESUME_ID } });
    expect(res.status).toBe(202);
    const jobId = res.json.jobId;
    // The resume re-announces the same run-START line a fresh run prints.
    children.at(-1)!.emitStdout(formatRunStartAnnouncement(RESUME_ID, runDir) + "\n");
    seedParked(runDir, 1, { options: ["finalize", "abandon"], def: "finalize" });

    const job = await dispatch(listener, { method: "GET", url: `/jobs/${jobId}` });
    expect(job.json.pendingDecisions).toEqual([
      { seq: 1, unit: "unit-001", kind: "unit-exhausted", question: "Q?", options: ["finalize", "abandon"], default: "finalize", expiresAt: "2026-07-13T00:00:00.000Z" },
    ]);
    const answered = await dispatch(listener, { url: `/jobs/${jobId}/decision`, body: { seq: 1, answer: "abandon" } });
    expect(answered.status).toBe(200);
    expect(existsSync(join(runDir, "decisions", "1.decision.json"))).toBe(true);
  });

  it("resumed run whose spawner emits NO announcement → no runId/runDir; decision POST → 404", async () => {
    const root = tmpRoot();
    const { spawn } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const res = await dispatch(listener, { url: "/conduct", body: { root, resume: RESUME_ID } });
    expect(res.status).toBe(202);
    const jobId = res.json.jobId;
    // No announcement emitted → the job never learns its run dir.
    const job = await dispatch(listener, { method: "GET", url: `/jobs/${jobId}` });
    expect(job.json).not.toHaveProperty("pendingDecisions");
    const dec = await dispatch(listener, { url: `/jobs/${jobId}/decision`, body: { seq: 1, answer: "finalize" } });
    expect(dec.status).toBe(404);
  });
});

describe("POST /conduct — malformed value rejection (assertion 18): 400, spawner NOT called", () => {
  const bad: Array<[string, unknown]> = [
    ["mode outside enum", { mode: "bogus" }],
    ["maxUnits 0", { maxUnits: 0 }],
    ["maxUnits negative", { maxUnits: -1 }],
    ["maxUnits non-integer", { maxUnits: 2.5 }],
    ["concurrency 0", { concurrency: 0 }],
    ["concurrency non-integer", { concurrency: 1.5 }],
    ["maxTurns 0", { maxTurns: 0 }],
    ["maxTurns negative", { maxTurns: -10 }],
    ["budget negative", { budget: -1 }],
    ["budget non-numeric", { budget: "x" }],
    ["prompt numeric (wrong type)", { prompt: 123 }],
    ["auto string (wrong type)", { auto: "yes" }],
    ["empty prompt", { prompt: "" }],
  ];
  for (const [label, override] of bad) {
    it(`rejects ${label}`, async () => {
      const root = tmpRoot();
      const { spawn, calls } = fakeSpawner();
      const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
      const body: Record<string, unknown> = { root, prompt: "ok", ...(override as Record<string, unknown>) };
      const res = await dispatch(listener, { url: "/conduct", body });
      expect(res.status, label).toBe(400);
      expect(calls, label).toHaveLength(0);
    });
  }
});

describe("GET /jobs/:id — pendingDecisions projection (assertions 4/5/6)", () => {
  it("associates the run from the child's run-START line, then shows running + the projected pending fields (planted extra dropped)", async () => {
    const root = tmpRoot();
    const { spawn, children } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const { jobId, runDir } = await conductAndAnnounce(listener, children, root);
    // Fabricate a parked decision with a PLANTED extra field that must not survive projection.
    seedParked(runDir, 1, { options: ["finalize", "abandon"], def: "finalize", extra: { secret: "LEAK-9000", context: { verdict: "fail" } } });

    const job = await dispatch(listener, { method: "GET", url: `/jobs/${jobId}` });
    expect(job.status).toBe(200);
    expect(job.json.status).toBe("running"); // parked → still running
    expect(job.json.pendingDecisions).toEqual([
      { seq: 1, unit: "unit-001", kind: "unit-exhausted", question: "Q?", options: ["finalize", "abandon"], default: "finalize", expiresAt: "2026-07-13T00:00:00.000Z" },
    ]);
    expect(JSON.stringify(job.json)).not.toContain("LEAK-9000");
    // internal routing fields never cross the wire.
    expect(job.json).not.toHaveProperty("runDir");
    expect(job.json).not.toHaveProperty("runId");
  });

  it("clear semantics: once <seq>.decision.json appears, that seq is ABSENT from pendingDecisions", async () => {
    const root = tmpRoot();
    const { spawn, children } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const { jobId, runDir } = await conductAndAnnounce(listener, children, root);
    seedParked(runDir, 1, { options: ["finalize", "abandon"], def: "finalize" });
    seedParked(runDir, 2, { options: ["pivot", "abandon"], def: "pivot", unit: "unit-002" });

    // Answer seq 1 → its decision file appears.
    const answered = await dispatch(listener, { url: `/jobs/${jobId}/decision`, body: { seq: 1, answer: "abandon" } });
    expect(answered.status).toBe(200);

    const job = await dispatch(listener, { method: "GET", url: `/jobs/${jobId}` });
    const seqs = (job.json.pendingDecisions as Array<{ seq: number }>).map((d) => d.seq);
    expect(seqs).toEqual([2]); // seq 1 resolved → gone; seq 2 still parked
  });

  it("a non-conduct job (no runDir) exposes NO pendingDecisions field", async () => {
    const root = tmpRoot();
    const { spawn } = fakeSpawner();
    const { listener, jobs } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const job = jobs.createJob({ kind: "conduct", root }); // never announced
    const got = await dispatch(listener, { method: "GET", url: `/jobs/${job.id}` });
    expect(got.json).not.toHaveProperty("pendingDecisions");
  });
});

describe("GET /jobs listing — shared pendingDecisions plumbing + canary absence (assertions 4/5/6)", () => {
  it("a conduct job's listing entry carries the SAME pendingDecisions projection as GET /jobs/:id (shared plumbing)", async () => {
    const root = tmpRoot();
    const { spawn, children } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const { jobId, runDir } = await conductAndAnnounce(listener, children, root);
    seedParked(runDir, 1, { options: ["finalize", "abandon"], def: "finalize" });

    const detail = await dispatch(listener, { method: "GET", url: `/jobs/${jobId}` });
    const listing = await dispatch(listener, { method: "GET", url: "/jobs" });
    expect(listing.status).toBe(200);
    const entry = (listing.json as Array<{ id: string; pendingDecisions?: unknown }>).find((j) => j.id === jobId);
    expect(entry).toBeDefined();
    // IDENTICAL projection, produced by the one shared `projectPendingDecisions` plumbing.
    expect(entry!.pendingDecisions).toEqual(detail.json.pendingDecisions);
    expect(entry!.pendingDecisions).toEqual([
      { seq: 1, unit: "unit-001", kind: "unit-exhausted", question: "Q?", options: ["finalize", "abandon"], default: "finalize", expiresAt: "2026-07-13T00:00:00.000Z" },
    ]);
    // The listing entry has no `log` (detail-only) and no internal routing fields.
    expect(entry).not.toHaveProperty("log");
    expect(entry).not.toHaveProperty("runDir");
    expect(entry).not.toHaveProperty("runId");
  });

  it("a planted holdout canary (in the job log AND the run's request artifact) never appears in the GET /jobs body; a canary-free job still lists (non-vacuous guard)", async () => {
    const root = tmpRoot();
    const { spawn, children } = fakeSpawner();
    const { listener, jobs } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const { jobId, runDir } = await conductAndAnnounce(listener, children, root);
    // Canary in the run's raw request artifact...
    seedParked(runDir, 1, { options: ["finalize", "abandon"], def: "finalize", extra: { secret: "CANARY-LEAK-777", context: { verdict: "fail" } } });
    // ...AND in the job's accumulated (detail-only) log.
    jobs.appendLog(jobId, "streamed phase output CANARY-LEAK-777 more output");

    // A second job WITHOUT the canary must still list — the guard discriminates, it isn't vacuous.
    const cleanJob = jobs.createJob({ kind: "build", root });

    const listing = await dispatch(listener, { method: "GET", url: "/jobs" });
    expect(listing.status).toBe(200);
    // The canary is absent from the ENTIRE serialized listing body (no log field, projected decisions only).
    expect(JSON.stringify(listing.json)).not.toContain("CANARY-LEAK-777");
    const ids = (listing.json as Array<{ id: string }>).map((j) => j.id);
    expect(ids).toContain(jobId); // the canary-carrying job lists (redacted)
    expect(ids).toContain(cleanJob.id); // the canary-free job lists normally
  });
});

describe("run dir is canonicalized + allowlist-guarded (round-2 #16: symlink escape refused)", () => {
  it("a symlinked <runId> dir pointing OUTSIDE the root → no pendingDecisions, decision POST 404 (never followed)", async () => {
    const root = tmpRoot();
    const outside = tmpRoot(); // a DIFFERENT temp tree, NOT in the allowlist
    // Plant a parked decision in the OUTSIDE tree the symlink will point at.
    mkdirSync(join(outside, "decisions"), { recursive: true });
    writeFileSync(
      join(outside, "decisions", "1.request.json"),
      JSON.stringify({ seq: 1, unit: "u", kind: "unit-exhausted", question: "Q?", options: ["finalize"], default: "finalize", expiresAt: "z", secret: "ESCAPE-LEAK" }),
    );
    // Symlink root/.sparra/conduct/conduct-fixture -> outside (an allowlist escape via symlink).
    mkdirSync(join(root, ".sparra", "conduct"), { recursive: true });
    symlinkSync(outside, join(root, ".sparra", "conduct", "conduct-fixture"));

    const { spawn, children } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const res = await dispatch(listener, { url: "/conduct", body: { root, prompt: "x" } });
    expect(res.status).toBe(202);
    const jobId = res.json.jobId;
    // Announce AFTER the symlink exists so the parser's realpath guard sees the escape.
    children.at(-1)!.emitStdout(formatRunStartAnnouncement("conduct-fixture", join(root, ".sparra", "conduct", "conduct-fixture")) + "\n");

    // GET: the escaping run dir is refused → NO pendingDecisions field, and the outside secret never leaks.
    const job = await dispatch(listener, { method: "GET", url: `/jobs/${jobId}` });
    expect(job.json).not.toHaveProperty("pendingDecisions");
    expect(JSON.stringify(job.json)).not.toContain("ESCAPE-LEAK");

    // POST decision: no associated (in-root) run → 404, and NO decision file written into the outside tree.
    const dec = await dispatch(listener, { url: `/jobs/${jobId}/decision`, body: { seq: 1, answer: "finalize" } });
    expect(dec.status).toBe(404);
    expect(existsSync(join(outside, "decisions", "1.decision.json"))).toBe(false);
  });

  it("a runId carrying `..` traversal → run dir not stored (405/404, never resolved outside root)", async () => {
    const root = tmpRoot();
    const { spawn, children } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const res = await dispatch(listener, { url: "/conduct", body: { root, prompt: "x" } });
    const jobId = res.json.jobId;
    children.at(-1)!.emitStdout(formatRunStartAnnouncement("../../../../etc", join(root, ".sparra", "conduct", "x")) + "\n");
    const job = await dispatch(listener, { method: "GET", url: `/jobs/${jobId}` });
    expect(job.json).not.toHaveProperty("pendingDecisions");
    expect((await dispatch(listener, { url: `/jobs/${jobId}/decision`, body: { seq: 1, answer: "finalize" } })).status).toBe(404);
  });
});

describe("POST /jobs/:id/decision — resolution (assertions 7/8/10/11)", () => {
  it("a NON-default option → 200; decision.json written; run.json record resolved with chosen = posted option", async () => {
    const root = tmpRoot();
    const auditLines: string[] = [];
    const { spawn, children } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn }, auditLines);
    const { jobId, runDir } = await conductAndAnnounce(listener, children, root);
    seedParked(runDir, 1, { options: ["finalize", "abandon"], def: "finalize" });

    const res = await dispatch(listener, { url: `/jobs/${jobId}/decision`, body: { seq: 1, answer: "abandon", note: "NOTE-CANARY-42" } });
    expect(res.status).toBe(200);
    expect(res.json.chosen).toBe("abandon");
    expect(existsSync(join(runDir, "decisions", "1.decision.json"))).toBe(true);
    const written = JSON.parse(readFileSync(join(runDir, "decisions", "1.decision.json"), "utf8"));
    expect(written.answer).toBe("abandon");
    const rj = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
    expect(rj.units[0].decisions[0].status).toBe("resolved");
    expect(rj.units[0].decisions[0].chosen).toBe("abandon"); // the posted NON-default option

    // Audit (assertion 10): the decision route's line carries seq + chosen + result, never the note.
    const line = auditLines.find((l) => l.includes("/jobs/:id/decision"));
    expect(line).toBeDefined();
    expect(line).toContain('"seq":1');
    expect(line).toContain('"decision":"abandon"');
    for (const l of auditLines) expect(l).not.toContain("NOTE-CANARY-42");
  });

  it("404 unknown job; 404 unknown seq; 409 double-answer; 400 bad option (no decision file written)", async () => {
    const root = tmpRoot();
    const { spawn, children } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });

    // 404 unknown job
    expect((await dispatch(listener, { url: `/jobs/nope/decision`, body: { seq: 1, answer: "finalize" } })).status).toBe(404);

    const { jobId, runDir } = await conductAndAnnounce(listener, children, root);
    seedParked(runDir, 1, { options: ["finalize", "abandon"], def: "finalize" });

    // 404 unknown seq (no request file for seq 9)
    expect((await dispatch(listener, { url: `/jobs/${jobId}/decision`, body: { seq: 9, answer: "finalize" } })).status).toBe(404);

    // 400 bad option — no decision file written
    const bad = await dispatch(listener, { url: `/jobs/${jobId}/decision`, body: { seq: 1, answer: "not-an-option" } });
    expect(bad.status).toBe(400);
    expect(existsSync(join(runDir, "decisions", "1.decision.json"))).toBe(false);

    // First real answer → 200; a second answer for the same seq → 409
    expect((await dispatch(listener, { url: `/jobs/${jobId}/decision`, body: { seq: 1, answer: "finalize" } })).status).toBe(200);
    const dbl = await dispatch(listener, { url: `/jobs/${jobId}/decision`, body: { seq: 1, answer: "abandon" } });
    expect(dbl.status).toBe(409);
    // first answer stands
    expect(JSON.parse(readFileSync(join(runDir, "decisions", "1.decision.json"), "utf8")).answer).toBe("finalize");
  });

  it("rejects an unknown decision body field (strict schema) → 400", async () => {
    const root = tmpRoot();
    const { spawn, children } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const { jobId, runDir } = await conductAndAnnounce(listener, children, root);
    seedParked(runDir, 1, { options: ["finalize"], def: "finalize" });
    const res = await dispatch(listener, { url: `/jobs/${jobId}/decision`, body: { seq: 1, answer: "finalize", evil: "x" } });
    expect(res.status).toBe(400);
  });
});

describe("stdout observer → decision_parked events (U4 assertions 8/9/10/11/12)", () => {
  /** A distinct question string that appears NOWHERE in the fed stdout — proves the event's `question`
   *  is read from the request FILE, not smuggled off the (runId+seq-only) announce line. */
  const FILE_QUESTION = "FILE-ONLY-QUESTION-9xZ-should-not-be-on-the-wire";

  it("assertion 8: run-START then decision-parked line + seeded request → exactly ONE decision_parked event; question/kind from the FILE", async () => {
    const root = tmpRoot();
    const eventLog = new EventLog();
    const { spawn, children } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn, eventLog });
    const res = await dispatch(listener, { url: "/conduct", body: { root, prompt: "x" } });
    expect(res.status).toBe(202);
    const jobId = res.json.jobId;
    const runDir = runDirFor(root);
    const child = children.at(-1)!;
    child.emitStdout(formatRunStartAnnouncement("conduct-fixture", runDir) + "\n");
    // Seed the parked request with a DISTINCT question + kind that live ONLY in the file.
    seedParked(runDir, 1, { options: ["skip-unit", "abort-merge"], def: "skip-unit", kind: "merge-blocked", extra: { question: FILE_QUESTION } });
    child.emitStdout(formatDecisionParkedAnnouncement("conduct-fixture", 1) + "\n");

    const events = eventLog.since(0).events.filter((e) => e.type === "decision_parked");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "decision_parked", jobId, runId: "conduct-fixture", seq: 1, question: FILE_QUESTION, kind: "merge-blocked" });
    // The distinct question came from the file — it never rode the (runId+seq-only) announce line.
    expect(events[0]!.root).toBe(root);
  });

  it("assertion 9(a): decision-parked line with NO prior run-START → zero events (fail closed)", async () => {
    const root = tmpRoot();
    const eventLog = new EventLog();
    const { spawn, children } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn, eventLog });
    await dispatch(listener, { url: "/conduct", body: { root, prompt: "x" } });
    const runDir = runDirFor(root);
    seedParked(runDir, 1, { options: ["finalize"], def: "finalize" });
    // Emit the decision-parked line WITHOUT ever emitting run-START.
    children.at(-1)!.emitStdout(formatDecisionParkedAnnouncement("conduct-fixture", 1) + "\n");
    expect(eventLog.since(0).events.filter((e) => e.type === "decision_parked")).toHaveLength(0);
  });

  it("assertion 9(b): decision-parked line whose runId ≠ recorded runId → zero events", async () => {
    const root = tmpRoot();
    const eventLog = new EventLog();
    const { spawn, children } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn, eventLog });
    await dispatch(listener, { url: "/conduct", body: { root, prompt: "x" } });
    const runDir = runDirFor(root);
    const child = children.at(-1)!;
    child.emitStdout(formatRunStartAnnouncement("conduct-fixture", runDir) + "\n");
    seedParked(runDir, 1, { options: ["finalize"], def: "finalize" });
    child.emitStdout(formatDecisionParkedAnnouncement("some-OTHER-run", 1) + "\n");
    expect(eventLog.since(0).events.filter((e) => e.type === "decision_parked")).toHaveLength(0);
  });

  it("assertion 9(c): request file absent/unreadable → zero events (fail closed)", async () => {
    const root = tmpRoot();
    const eventLog = new EventLog();
    const { spawn, children } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn, eventLog });
    await dispatch(listener, { url: "/conduct", body: { root, prompt: "x" } });
    const runDir = runDirFor(root);
    const child = children.at(-1)!;
    child.emitStdout(formatRunStartAnnouncement("conduct-fixture", runDir) + "\n");
    // NO seedParked — the request file for seq 1 does not exist.
    child.emitStdout(formatDecisionParkedAnnouncement("conduct-fixture", 1) + "\n");
    expect(eventLog.since(0).events.filter((e) => e.type === "decision_parked")).toHaveLength(0);
  });

  it("assertion 10: same line twice (incl. split across chunks) → ONE event; a distinct seq → a second", async () => {
    const root = tmpRoot();
    const eventLog = new EventLog();
    const { spawn, children } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn, eventLog });
    await dispatch(listener, { url: "/conduct", body: { root, prompt: "x" } });
    const runDir = runDirFor(root);
    const child = children.at(-1)!;
    child.emitStdout(formatRunStartAnnouncement("conduct-fixture", runDir) + "\n");
    seedParked(runDir, 1, { options: ["finalize"], def: "finalize" });
    const line1 = formatDecisionParkedAnnouncement("conduct-fixture", 1);
    // First delivery SPLIT across two chunks (proves line-buffering assembles it).
    child.emitStdout(line1.slice(0, 10));
    child.emitStdout(line1.slice(10) + "\n");
    // Second delivery of the SAME line (whole) — must be de-duped.
    child.emitStdout(line1 + "\n");
    expect(eventLog.since(0).events.filter((e) => e.type === "decision_parked" && e.seq === 1)).toHaveLength(1);
    // A distinct seq → a second event.
    seedParked(runDir, 2, { options: ["pivot"], def: "pivot", unit: "unit-002" });
    child.emitStdout(formatDecisionParkedAnnouncement("conduct-fixture", 2) + "\n");
    const parked = eventLog.since(0).events.filter((e) => e.type === "decision_parked");
    expect(parked.map((e) => e.seq).sort()).toEqual([1, 2]);
  });

  it("assertion 11: the SAME line stream still records runId/runDir (run-START regression) — pendingDecisions surface", async () => {
    const root = tmpRoot();
    const eventLog = new EventLog();
    const { spawn, children } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn, eventLog });
    const res = await dispatch(listener, { url: "/conduct", body: { root, prompt: "x" } });
    const jobId = res.json.jobId;
    const runDir = runDirFor(root);
    const child = children.at(-1)!;
    child.emitStdout(formatRunStartAnnouncement("conduct-fixture", runDir) + "\n");
    seedParked(runDir, 1, { options: ["finalize", "abandon"], def: "finalize" });
    child.emitStdout(formatDecisionParkedAnnouncement("conduct-fixture", 1) + "\n");
    // run-START recording still works exactly as before (pendingDecisions surfaced from the recorded dir).
    const job = await dispatch(listener, { method: "GET", url: `/jobs/${jobId}` });
    expect((job.json.pendingDecisions as Array<{ seq: number }>).map((d) => d.seq)).toEqual([1]);
  });

  it("assertion 12: parser events land on the SAME EventLog served by GET /events (registerBridgeRoutes wiring)", async () => {
    const root = tmpRoot();
    const eventLog = new EventLog();
    const { spawn, children } = fakeSpawner();
    const jobs = new JobStore();
    const listener = createRequestListener({
      config: baseConfig([root]),
      token: TOKEN,
      jobs,
      audit: () => {},
      routes: registerBridgeRoutes({ lock: new TargetLock(), spawn, eventLog }),
    });
    const res = await dispatch(listener, { url: "/conduct", body: { root, prompt: "x" } });
    expect(res.status).toBe(202);
    const runDir = runDirFor(root);
    const child = children.at(-1)!;
    child.emitStdout(formatRunStartAnnouncement("conduct-fixture", runDir) + "\n");
    seedParked(runDir, 1, { options: ["finalize"], def: "finalize", extra: { question: FILE_QUESTION } });
    child.emitStdout(formatDecisionParkedAnnouncement("conduct-fixture", 1) + "\n");
    // Read the event back THROUGH the GET /events route — same shared instance.
    const feed = await dispatch(listener, { method: "GET", url: "/events?since=0" });
    expect(feed.status).toBe(200);
    const parked = (feed.json.events as Array<{ type: string; seq?: number; question?: string }>).filter((e) => e.type === "decision_parked");
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ seq: 1, question: FILE_QUESTION });
  });
});

describe("auth (assertion 9): 401 with no/wrong bearer, no side effects", () => {
  it("POST /conduct without/with wrong bearer → 401, spawner NOT called", async () => {
    const root = tmpRoot();
    const { spawn, calls } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    expect((await dispatch(listener, { url: "/conduct", body: { root, prompt: "x" }, auth: false })).status).toBe(401);
    expect((await dispatch(listener, { url: "/conduct", body: { root, prompt: "x" }, auth: "Bearer wrong" })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("POST /jobs/:id/decision without bearer → 401, no decision file written", async () => {
    const root = tmpRoot();
    const { spawn, children } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const { jobId, runDir } = await conductAndAnnounce(listener, children, root);
    seedParked(runDir, 1, { options: ["finalize"], def: "finalize" });
    const res = await dispatch(listener, { url: `/jobs/${jobId}/decision`, body: { seq: 1, answer: "finalize" }, auth: false });
    expect(res.status).toBe(401);
    expect(existsSync(join(runDir, "decisions", "1.decision.json"))).toBe(false);
  });
});
