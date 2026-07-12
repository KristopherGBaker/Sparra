import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import type { BridgeConfig } from "../config.ts";
import { JobStore } from "../jobs.ts";
import { createRequestListener, type ServerDeps } from "../server.ts";
import { TargetLock, type SpawnedChild, type SpawnFn } from "../spawn.ts";
import { createPhaseRoutes, type PhaseRouteDeps } from "./phases.ts";

const TOKEN = "s3cr3t";

class FakeChild extends EventEmitter implements SpawnedChild {
  readonly stdout = new EventEmitter() as unknown as SpawnedChild["stdout"];
  readonly stderr = new EventEmitter() as unknown as SpawnedChild["stderr"];
  kill(): boolean {
    return true;
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  options: { cwd?: string; env?: NodeJS.ProcessEnv };
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

function baseConfig(roots: string[], overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    roots,
    port: 8787,
    lastNJobs: 50,
    auditLogPath: "/tmp/audit.log",
    allowRemotePlan: false,
    dashboard: true,
    ...overrides,
  };
}

function makeHarness(config: BridgeConfig, phaseDeps: PhaseRouteDeps) {
  const jobs = new JobStore();
  const deps: ServerDeps = {
    config,
    token: TOKEN,
    jobs,
    audit: () => {},
    routes: createPhaseRoutes(phaseDeps),
  };
  return { listener: createRequestListener(deps), jobs };
}

interface Dispatched {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function dispatch(
  listener: (req: IncomingMessage, res: ServerResponse) => void,
  init: { method?: string; url: string; body?: unknown; auth?: boolean },
): Promise<Dispatched> {
  const method = init.method ?? "POST";
  const bodyStr = init.body !== undefined ? JSON.stringify(init.body) : undefined;
  const req = Readable.from(bodyStr !== undefined ? [Buffer.from(bodyStr)] : []) as unknown as IncomingMessage;
  Object.assign(req, {
    method,
    url: init.url,
    headers: init.auth === false ? {} : { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    socket: { remoteAddress: "100.64.0.1" },
  });
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
  return realpathSync(mkdtempSync(join(tmpdir(), "sparra-bridge-")));
}

describe("phases — argv + cwd", () => {
  it("/build threads all flags and spawns with cwd = the resolved guarded root", async () => {
    const root = tmpRoot();
    const { spawn, calls } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const res = await dispatch(listener, {
      url: "/build",
      body: { root, fresh: true, only: "U2", step: "generate", budget: 5, maxTurns: 80 },
    });
    expect(res.status).toBe(202);
    expect(res.json.jobId).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(1)).toEqual([
      "build",
      "--fresh",
      "--only",
      "U2",
      "--step",
      "generate",
      "--budget",
      "5",
      "--max-turns",
      "80",
    ]);
    expect(calls[0]!.options.cwd).toBe(root);
  });

  it("/reflect, /resume, /init, /freeze spawn the right argv with cwd = resolved root", async () => {
    const root = tmpRoot();
    const { spawn, calls, children } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });

    // Each mutating phase holds the per-target lock until its child exits, so close between requests.
    await dispatch(listener, { url: "/reflect", body: { root, apply: true } });
    children.at(-1)!.emit("close", 0);
    await dispatch(listener, { url: "/resume", body: { root } });
    children.at(-1)!.emit("close", 0);
    await dispatch(listener, { url: "/init", body: { root, mode: "existing", docs: "docs" } });
    children.at(-1)!.emit("close", 0);
    await dispatch(listener, { url: "/freeze", body: { root } });

    expect(calls.map((c) => c.args.slice(1))).toEqual([
      ["reflect", "--apply"],
      ["resume"],
      ["init", "--mode", "existing", "--docs", "docs"],
      ["freeze"],
    ]);
    // cwd is the resolved guarded root for every phase (spot-check /init, the 3rd call).
    expect(calls[2]!.options.cwd).toBe(root);
  });

  it("omits optional flags when absent (/build minimal, /reflect without --apply)", async () => {
    const root = tmpRoot();
    const { spawn, calls, children } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    await dispatch(listener, { url: "/build", body: { root } });
    children.at(-1)!.emit("close", 0); // release the lock before the next request on the same root
    await dispatch(listener, { url: "/reflect", body: { root } });
    expect(calls[0]!.args.slice(1)).toEqual(["build"]);
    expect(calls[1]!.args.slice(1)).toEqual(["reflect"]);
  });
});

describe("phases — strict schema", () => {
  it("rejects an unknown body field with 400 and never spawns", async () => {
    const root = tmpRoot();
    const { spawn, calls } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const res = await dispatch(listener, { url: "/build", body: { root, evil: "x" } });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects a wrong-typed field (fresh as string) with 400", async () => {
    const root = tmpRoot();
    const { spawn, calls } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const res = await dispatch(listener, { url: "/build", body: { root, fresh: "yes" } });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("phases — allowlist enforced before spawn", () => {
  it("a root OUTSIDE the allowlist returns 403 and NEVER spawns", async () => {
    const root = tmpRoot();
    const { spawn, calls } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const res = await dispatch(listener, { url: "/build", body: { root: "/etc/evil" } });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("a `..` traversal escaping the root returns 403 and never spawns", async () => {
    const root = tmpRoot();
    const { spawn, calls } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const res = await dispatch(listener, { url: "/build", body: { root: join(root, "..", "..", "etc") } });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe("phases — per-target mutation lock (phase writer)", () => {
  it("a held phase lock 409s a second phase request, then accepts after release", async () => {
    const root = tmpRoot();
    const { spawn, calls, children } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });

    const first = await dispatch(listener, { url: "/build", body: { root } });
    expect(first.status).toBe(202);
    const holder = first.json.jobId;

    // Second request for the SAME target while the first is in flight (child hasn't closed): 409.
    const second = await dispatch(listener, { url: "/reflect", body: { root } });
    expect(second.status).toBe(409);
    expect(second.json.jobId).toBe(holder);

    // First job's child exits → lock releases → a later mutating request is accepted.
    children[0]!.emit("close", 0);
    const third = await dispatch(listener, { url: "/build", body: { root } });
    expect(third.status).toBe(202);
    expect(calls.length).toBe(2); // only the two accepted requests ever spawned
  });

  it("a DIFFERENT target is not blocked by a lock on another root", async () => {
    const rootA = tmpRoot();
    const rootB = tmpRoot();
    const { spawn } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([rootA, rootB]), { lock: new TargetLock(), spawn });
    expect((await dispatch(listener, { url: "/build", body: { root: rootA } })).status).toBe(202);
    expect((await dispatch(listener, { url: "/build", body: { root: rootB } })).status).toBe(202);
  });
});

describe("phases — GET /projects (read-only)", () => {
  it("reports {root, phase, next} per allowlisted root from the injected status source", async () => {
    const rootA = tmpRoot();
    const rootB = tmpRoot();
    const statusSource = (root: string) => ({ phase: root === rootA ? "build" : "plan", next: "n" });
    const { spawn, calls } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([rootA, rootB]), {
      lock: new TargetLock(),
      spawn,
      statusSource,
    });
    const res = await dispatch(listener, { method: "GET", url: "/projects" });
    expect(res.status).toBe(200);
    expect(res.json.projects).toEqual([
      { root: rootA, phase: "build", next: "n" },
      { root: rootB, phase: "plan", next: "n" },
    ]);
    expect(calls).toHaveLength(0); // read-only: no spawn
  });
});

describe("phases — /plan gate + confinement", () => {
  it("returns 403 when allowRemotePlan is false", async () => {
    const root = tmpRoot();
    const { spawn } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root]), { lock: new TargetLock(), spawn });
    const res = await dispatch(listener, { url: "/plan", body: { root, content: "x" } });
    expect(res.status).toBe(403);
  });

  it("returns 400 on an unknown body field even when enabled (no client-supplied target)", async () => {
    const root = tmpRoot();
    const { spawn } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root], { allowRemotePlan: true }), {
      lock: new TargetLock(),
      spawn,
    });
    const res = await dispatch(listener, {
      url: "/plan",
      body: { root, content: "x", filename: "../../etc/passwd" },
    });
    expect(res.status).toBe(400);
  });

  it("with docsDir '' (no config), writes <root>/PLAN.md — NOT <root>/.sparra/PLAN.md", async () => {
    const root = tmpRoot();
    const { spawn } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root], { allowRemotePlan: true }), {
      lock: new TargetLock(),
      spawn,
    });
    const res = await dispatch(listener, { url: "/plan", body: { root, content: "# The Plan\n" } });
    expect(res.status).toBe(200);
    expect(readFileSync(join(root, "PLAN.md"), "utf8")).toBe("# The Plan\n");
    // The old (wrong) `.sparra/PLAN.md` location must NOT be written.
    expect(existsSync(join(root, ".sparra", "PLAN.md"))).toBe(false);
    // Confined to the single file — the root gained exactly PLAN.md.
    expect(readdirSync(root)).toEqual(["PLAN.md"]);
  });

  it("honors the project's configured docsDir: writes <root>/docs/PLAN.md, not the root or .sparra", async () => {
    const root = tmpRoot();
    // The TARGET project configures docsDir: "docs" in its real .sparra/config.yaml.
    mkdirSync(join(root, ".sparra"), { recursive: true });
    writeFileSync(join(root, ".sparra", "config.yaml"), "docsDir: docs\n", "utf8");
    const { spawn } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root], { allowRemotePlan: true }), {
      lock: new TargetLock(),
      spawn,
    });
    const res = await dispatch(listener, { url: "/plan", body: { root, content: "# Docs Plan\n" } });
    expect(res.status).toBe(200);
    expect(readFileSync(join(root, "docs", "PLAN.md"), "utf8")).toBe("# Docs Plan\n");
    // NOT the root, NOT .sparra — proves docsDir resolution actually happened (fails if removed).
    expect(existsSync(join(root, "PLAN.md"))).toBe(false);
    expect(existsSync(join(root, ".sparra", "PLAN.md"))).toBe(false);
    expect(readdirSync(join(root, "docs"))).toEqual(["PLAN.md"]);
  });

  it("joins the shared per-target lock: a held /build blocks /plan with 409 (not a 200 write)", async () => {
    const root = tmpRoot();
    const { spawn, children } = fakeSpawner();
    const { listener } = makeHarness(baseConfig([root], { allowRemotePlan: true }), {
      lock: new TargetLock(),
      spawn,
    });
    // A /build acquires the target lock and stays in flight (its fake child never closes).
    const build = await dispatch(listener, { url: "/build", body: { root } });
    expect(build.status).toBe(202);
    // /plan for the SAME target must 409 (naming the holder) rather than writing PLAN.md.
    const plan = await dispatch(listener, { url: "/plan", body: { root, content: "should not write" } });
    expect(plan.status).toBe(409);
    expect(plan.json.jobId).toBe(build.json.jobId);
    expect(existsSync(join(root, "PLAN.md"))).toBe(false);
    // After the build releases, /plan is accepted and writes.
    children[0]!.emit("close", 0);
    const after = await dispatch(listener, { url: "/plan", body: { root, content: "ok\n" } });
    expect(after.status).toBe(200);
    expect(readFileSync(join(root, "PLAN.md"), "utf8")).toBe("ok\n");
  });
});
