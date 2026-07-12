import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  PARENT_SAFE_FIELDS,
  type ParentSummary,
  type RunRoleSpec,
  type RunUnitResult,
} from "../../core/index.ts";
import type { BridgeConfig } from "../config.ts";
import { JobStore } from "../jobs.ts";
import { PathGuardError } from "../paths.ts";
import { registerBridgeRoutes } from "../register.ts";
import type { RouteContext, RouteDefinition, RouteResult } from "../server.ts";
import { TargetLock } from "../spawn.ts";
import { createConductorRoutes, projectRunUnit } from "./conductor.ts";

function tmpRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "sparra-cond-")));
}

function baseConfig(roots: string[]): BridgeConfig {
  return { roots, port: 8787, lastNJobs: 50, auditLogPath: "/tmp/a.log", allowRemotePlan: false, dashboard: true };
}

function getHandler(routes: RouteDefinition[], method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`no route ${method} ${path}`);
  return route.handler;
}

function makeCtx(config: BridgeConfig, jobs: JobStore, body: unknown): RouteContext {
  return {
    req: {} as RouteContext["req"],
    res: {} as RouteContext["res"],
    params: {},
    body,
    remote: "100.64.0.1",
    config,
    jobs,
  };
}

const CANARY: ParentSummary = {
  roleKind: "generator",
  backend: "claude",
  model: "CANARY-MODEL-xyz",
  ok: true,
  verdict: "pass",
  errors: [],
  tokens: 100,
  costUsd: 0.01,
};

describe("/role — spec building per kind", () => {
  const kinds = ["generator", "evaluator", "reviewer", "contract-generator", "contract-evaluator"] as const;
  for (const kind of kinds) {
    it(`builds a correct --kind ${kind} spec with threaded, guarded paths`, async () => {
      const root = tmpRoot();
      let captured: RunRoleSpec | undefined;
      const runRole = vi.fn(async (spec: RunRoleSpec) => {
        captured = spec;
        return CANARY;
      });
      const routes = createConductorRoutes({ lock: new TargetLock(), runRole });
      const handler = getHandler(routes, "POST", "/role");
      await handler(
        makeCtx(baseConfig([root]), new JobStore(), {
          workspace: root,
          kind,
          briefPath: join(root, "BRIEF.md"),
          contractPath: join(root, "CONTRACT.md"),
          holdoutPath: join(root, "HOLDOUT.md"),
          backend: "claude",
          model: "sonnet",
        }),
      );
      expect(captured).toBeDefined();
      const args = captured!.args;
      expect(args.slice(0, 4)).toEqual(["role", "run", "--kind", kind]);
      expect(args).toContain("--json");
      // Every threaded path is the RESOLVED (realpath'd) path under the guarded root.
      expect(args[args.indexOf("--brief") + 1]).toBe(join(root, "BRIEF.md"));
      expect(args[args.indexOf("--contract") + 1]).toBe(join(root, "CONTRACT.md"));
      expect(args[args.indexOf("--holdout") + 1]).toBe(join(root, "HOLDOUT.md"));
      expect(captured!.cwd).toBe(root);
    });
  }

  it("maps inline `brief` to --brief-text (not a path)", async () => {
    const root = tmpRoot();
    let captured: RunRoleSpec | undefined;
    const runRole = vi.fn(async (spec: RunRoleSpec) => {
      captured = spec;
      return CANARY;
    });
    const routes = createConductorRoutes({ lock: new TargetLock(), runRole });
    await getHandler(routes, "POST", "/role")(
      makeCtx(baseConfig([root]), new JobStore(), { workspace: root, kind: "generator", brief: "do the thing" }),
    );
    expect(captured!.args).toContain("--brief-text");
    expect(captured!.args[captured!.args.indexOf("--brief-text") + 1]).toBe("do the thing");
  });
});

describe("/role — holdout wall", () => {
  it("returns the core ParentSummary VERBATIM with no key outside the parent-safe set", async () => {
    const root = tmpRoot();
    const jobs = new JobStore({ genId: () => "r1" });
    const runRole = vi.fn(async () => CANARY);
    const routes = createConductorRoutes({ lock: new TargetLock(), runRole });
    const res = (await getHandler(routes, "POST", "/role")(
      makeCtx(baseConfig([root]), jobs, { workspace: root, kind: "generator" }),
    )) as RouteResult;
    expect(res.status).toBe(200);
    expect(res.body).toEqual(CANARY); // canary present, verbatim
    // job.result equals the same summary.
    expect(jobs.getJob("r1")!.result).toEqual(CANARY);
    // No key outside the parent-safe allowlist — the handler adds nothing of its own.
    for (const key of Object.keys(res.body as object)) {
      expect(PARENT_SAFE_FIELDS as readonly string[]).toContain(key);
    }
  });

  it("forwards holdoutPath as --holdout and never reads it in-process", async () => {
    const root = tmpRoot();
    let captured: RunRoleSpec | undefined;
    const runRole = vi.fn(async (spec: RunRoleSpec) => {
      captured = spec;
      return CANARY;
    });
    const routes = createConductorRoutes({ lock: new TargetLock(), runRole });
    // A holdout path that DOES NOT EXIST on disk: the guard realpaths only its (existing) ancestor,
    // never opening the leaf. If the handler tried to READ the holdout file, this would throw ENOENT
    // — the clean 200 + the forwarded arg proves the file is never opened in-process.
    const holdoutPath = join(root, "nonexistent-HOLDOUT-sentinel.md");
    const res = (await getHandler(routes, "POST", "/role")(
      makeCtx(baseConfig([root]), new JobStore(), { workspace: root, kind: "evaluator", holdoutPath }),
    )) as RouteResult;
    expect(res.status).toBe(200);
    expect(captured!.args[captured!.args.indexOf("--holdout") + 1]).toBe(holdoutPath);
    expect(JSON.stringify(res.body)).not.toContain("sentinel");
  });
});

describe("/role — path guard before the core runner", () => {
  it("rejects an out-of-allowlist path and NEVER invokes runRole", async () => {
    const root = tmpRoot();
    const runRole = vi.fn(async () => CANARY);
    const routes = createConductorRoutes({ lock: new TargetLock(), runRole });
    await expect(
      getHandler(routes, "POST", "/role")(
        makeCtx(baseConfig([root]), new JobStore(), {
          workspace: root,
          kind: "generator",
          contractPath: "/etc/evil/contract.md",
        }),
      ),
    ).rejects.toBeInstanceOf(PathGuardError);
    expect(runRole).not.toHaveBeenCalled();
  });

  it("rejects a bad body (unknown field / bad kind) with 400", async () => {
    const root = tmpRoot();
    const routes = createConductorRoutes({ lock: new TargetLock(), runRole: async () => CANARY });
    const handler = getHandler(routes, "POST", "/role");
    expect(((await handler(makeCtx(baseConfig([root]), new JobStore(), { workspace: root, kind: "nope" }))) as RouteResult).status).toBe(400);
    expect(((await handler(makeCtx(baseConfig([root]), new JobStore(), { workspace: root, kind: "generator", evil: 1 }))) as RouteResult).status).toBe(400);
    expect(((await handler(makeCtx(baseConfig([root]), new JobStore(), { kind: "generator" }))) as RouteResult).status).toBe(400); // no root/workspace
  });

  it("closes the root/workspace bypass: workspace INSIDE + root OUTSIDE → rejected, runRole NOT called", async () => {
    const root = tmpRoot();
    const runRole = vi.fn(async () => CANARY);
    const routes = createConductorRoutes({ lock: new TargetLock(), runRole });
    // Both target fields supplied: the in-allowlist `workspace` must not launder the outside `root`.
    await expect(
      getHandler(routes, "POST", "/role")(
        makeCtx(baseConfig([root]), new JobStore(), { workspace: root, root: "/etc/evil", kind: "generator" }),
      ),
    ).rejects.toBeInstanceOf(PathGuardError);
    expect(runRole).not.toHaveBeenCalled();
  });

  it("mirror bypass: root INSIDE + workspace OUTSIDE → rejected, runRole NOT called", async () => {
    const root = tmpRoot();
    const runRole = vi.fn(async () => CANARY);
    const routes = createConductorRoutes({ lock: new TargetLock(), runRole });
    await expect(
      getHandler(routes, "POST", "/role")(
        makeCtx(baseConfig([root]), new JobStore(), { root, workspace: "/etc/evil", kind: "generator" }),
      ),
    ).rejects.toBeInstanceOf(PathGuardError);
    expect(runRole).not.toHaveBeenCalled();
  });

  it("a fully-inside request (both root and workspace inside) still succeeds", async () => {
    const root = tmpRoot();
    const runRole = vi.fn(async () => CANARY);
    const routes = createConductorRoutes({ lock: new TargetLock(), runRole });
    const res = (await getHandler(routes, "POST", "/role")(
      makeCtx(baseConfig([root]), new JobStore(), { root, workspace: root, kind: "generator" }),
    )) as RouteResult;
    expect(res.status).toBe(200);
    expect(runRole).toHaveBeenCalledOnce();
  });
});

describe("/role — mutation lock (conductor WRITER)", () => {
  it("a pending generator holds the lock → a second writer 409s → releases → accepted", async () => {
    const root = tmpRoot();
    let release!: (s: ParentSummary) => void;
    const deferred = new Promise<ParentSummary>((r) => (release = r));
    const runRole = vi.fn(() => deferred);
    const routes = createConductorRoutes({ lock: new TargetLock(), runRole });
    const handler = getHandler(routes, "POST", "/role");
    const jobs = new JobStore();

    // First generator: synchronous portion acquires the lock, then awaits the pending runRole.
    const p1 = handler(makeCtx(baseConfig([root]), jobs, { workspace: root, kind: "generator" }));
    // Second writer for the SAME target → 409 (fails if conductor locking isn't wired).
    const second = (await handler(makeCtx(baseConfig([root]), jobs, { workspace: root, kind: "generator" }))) as RouteResult;
    expect(second.status).toBe(409);
    expect(second.body).toHaveProperty("jobId");

    release(CANARY);
    expect(((await p1) as RouteResult).status).toBe(200);

    // After release a fresh writer is accepted.
    const third = (await handler(makeCtx(baseConfig([root]), jobs, { workspace: root, kind: "generator" }))) as RouteResult;
    expect(third.status).toBe(200);
  });

  it("read-only kinds (evaluator/reviewer/contract-evaluator) do NOT take the lock", async () => {
    const root = tmpRoot();
    let release!: (s: ParentSummary) => void;
    const deferred = new Promise<ParentSummary>((r) => (release = r));
    const runRole = vi.fn(() => deferred);
    const routes = createConductorRoutes({ lock: new TargetLock(), runRole });
    const handler = getHandler(routes, "POST", "/role");
    const jobs = new JobStore();
    // Two concurrent evaluators on the same target — neither should 409.
    const p1 = handler(makeCtx(baseConfig([root]), jobs, { workspace: root, kind: "evaluator" }));
    const p2 = handler(makeCtx(baseConfig([root]), jobs, { workspace: root, kind: "reviewer" }));
    release(CANARY);
    expect(((await p1) as RouteResult).status).toBe(200);
    expect(((await p2) as RouteResult).status).toBe(200);
  });

  it("SHARED lock: a pending conductor writer 409s a PHASE writer for the same target", async () => {
    const root = tmpRoot();
    let release!: (s: ParentSummary) => void;
    const deferred = new Promise<ParentSummary>((r) => (release = r));
    // Shared registry across phase + conductor routes.
    const routes = registerBridgeRoutes({
      runRole: () => deferred,
      spawn: () => {
        throw new Error("phase writer must be blocked BEFORE spawning");
      },
    });
    const jobs = new JobStore();
    const role = getHandler(routes, "POST", "/role");
    const build = getHandler(routes, "POST", "/build");
    const p1 = role(makeCtx(baseConfig([root]), jobs, { workspace: root, kind: "generator" }));
    const phase = (await build(makeCtx(baseConfig([root]), jobs, { root }))) as RouteResult;
    expect(phase.status).toBe(409);
    release(CANARY);
    await p1;
  });
});

describe("/unit — config drives contract-evaluator → generator → evaluator", () => {
  it("hands runUnit a config whose three spec builders carry the right --kind and paths", async () => {
    const root = tmpRoot();
    let capturedConfig: Parameters<NonNullable<Parameters<typeof createConductorRoutes>[0]["runUnit"]>>[1] | undefined;
    const runUnit = vi.fn(async (_deps: unknown, config: any) => {
      capturedConfig = config;
      return { outcome: "contract-not-agreed", contract: { agreed: false, rounds: [], critiquePaths: [] } } as RunUnitResult;
    });
    const routes = createConductorRoutes({ lock: new TargetLock(), runUnit: runUnit as never });
    await getHandler(routes, "POST", "/unit")(
      makeCtx(baseConfig([root]), new JobStore(), {
        workspace: root,
        briefPath: join(root, "BRIEF.md"),
        contractPath: join(root, "CONTRACT.md"),
        holdoutPath: join(root, "HOLDOUT.md"),
        backend: "claude",
        generatorModel: "sonnet",
        evaluatorModel: "opus",
      }),
    );
    expect(capturedConfig).toBeDefined();
    const ce = capturedConfig!.contract.contractEvaluatorSpec({ round: 1, priorCritiquePaths: [] });
    const gen = capturedConfig!.generatorSpec({ round: 1, feedback: [], pivoting: false });
    const evl = capturedConfig!.evaluatorSpec({ round: 1, feedback: [], pivoting: false });
    expect(ce.args.slice(0, 4)).toEqual(["role", "run", "--kind", "contract-evaluator"]);
    expect(gen.args.slice(0, 4)).toEqual(["role", "run", "--kind", "generator"]);
    expect(evl.args.slice(0, 4)).toEqual(["role", "run", "--kind", "evaluator"]);
    // Guarded, resolved paths threaded into the specs.
    expect(gen.args[gen.args.indexOf("--brief") + 1]).toBe(join(root, "BRIEF.md"));
    expect(ce.args[ce.args.indexOf("--contract") + 1]).toBe(join(root, "CONTRACT.md"));
    expect(evl.args[evl.args.indexOf("--holdout") + 1]).toBe(join(root, "HOLDOUT.md"));
  });

  it("rejects an out-of-allowlist path and NEVER invokes runUnit", async () => {
    const root = tmpRoot();
    const runUnit = vi.fn();
    const routes = createConductorRoutes({ lock: new TargetLock(), runUnit: runUnit as never });
    await expect(
      getHandler(routes, "POST", "/unit")(
        makeCtx(baseConfig([root]), new JobStore(), { workspace: root, contractPath: "/etc/evil.md" }),
      ),
    ).rejects.toBeInstanceOf(PathGuardError);
    expect(runUnit).not.toHaveBeenCalled();
  });

  it("closes the root/workspace bypass: workspace INSIDE + root OUTSIDE → rejected, runUnit NOT called", async () => {
    const root = tmpRoot();
    const runUnit = vi.fn();
    const routes = createConductorRoutes({ lock: new TargetLock(), runUnit: runUnit as never });
    await expect(
      getHandler(routes, "POST", "/unit")(
        makeCtx(baseConfig([root]), new JobStore(), { workspace: root, root: "/etc/evil" }),
      ),
    ).rejects.toBeInstanceOf(PathGuardError);
    expect(runUnit).not.toHaveBeenCalled();
  });
});

describe("/unit — holdout-safe projection", () => {
  it("projects contract-not-agreed to exactly {outcome, contract:{agreed,rounds}} with no cycle", async () => {
    const root = tmpRoot();
    const jobs = new JobStore({ genId: () => "u1" });
    const raw = {
      outcome: "contract-not-agreed",
      contract: {
        agreed: false,
        rounds: [{ round: 1, evaluator: { roleKind: "contract-evaluator" }, agreed: false, RAWSENTINEL: "leak-me" }],
        critiquePaths: ["/secret/critique.md"],
      },
    } as unknown as RunUnitResult;
    const routes = createConductorRoutes({ lock: new TargetLock(), runUnit: async () => raw });
    const res = (await getHandler(routes, "POST", "/unit")(
      makeCtx(baseConfig([root]), jobs, { workspace: root }),
    )) as RouteResult;
    expect(res.body).toEqual({ outcome: "contract-not-agreed", contract: { agreed: false, rounds: 1 } });
    expect(res.body).not.toHaveProperty("cycle");
    const asStr = JSON.stringify(res.body);
    expect(asStr).not.toContain("leak-me");
    expect(asStr).not.toContain("critiquePaths");
    expect(asStr).not.toContain("secret");
    expect(jobs.getJob("u1")!.result).toEqual(res.body);
  });

  it("projects an accepted outcome to {outcome, contract, cycle:{outcome,rounds,finalVerdict}} and drops raw round contents", async () => {
    const root = tmpRoot();
    const finalVerdict: ParentSummary = {
      roleKind: "evaluator",
      backend: "opus",
      model: "opus",
      ok: true,
      verdict: "pass",
      errors: [],
      tokens: 5,
      costUsd: 0.001,
    };
    const raw = {
      outcome: "accepted",
      contract: { agreed: true, rounds: [{ round: 1 }, { round: 2 }], critiquePaths: [] },
      cycle: {
        outcome: "accepted",
        rounds: [{ round: 1, decision: "accept", generator: {}, evaluator: {}, resultText: "HOLDOUT-LEAK-zzz" }],
        finalVerdict,
      },
    } as unknown as RunUnitResult;
    const projected = projectRunUnit(raw);
    expect(projected).toEqual({
      outcome: "accepted",
      contract: { agreed: true, rounds: 2 },
      cycle: { outcome: "accepted", rounds: 1, finalVerdict },
    });
    expect(JSON.stringify(projected)).not.toContain("HOLDOUT-LEAK");
    expect(JSON.stringify(projected)).not.toContain("decision");

    // Exact projected key set at the endpoint.
    const routes = createConductorRoutes({ lock: new TargetLock(), runUnit: async () => raw });
    const res = (await getHandler(routes, "POST", "/unit")(
      makeCtx(baseConfig([root]), new JobStore(), { workspace: root }),
    )) as RouteResult;
    expect(Object.keys(res.body as object).sort()).toEqual(["contract", "cycle", "outcome"]);
    expect(Object.keys((res.body as { cycle: object }).cycle).sort()).toEqual(["finalVerdict", "outcome", "rounds"]);
  });
});
