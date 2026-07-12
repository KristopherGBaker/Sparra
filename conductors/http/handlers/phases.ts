/**
 * `conductors/http/handlers/phases.ts` — the phase trigger endpoints:
 * `/init /freeze /build /reflect /resume` (async jobs), `GET /projects` (read-only, synchronous),
 * and `/plan` (human-freeze-gated write).
 *
 * Every request body is validated with a STRICT `zod` schema (unknown fields rejected), every
 * request-supplied `root` goes through U1's `resolveWithinAllowlist` BEFORE any spawn/read/write, and
 * every mutating phase acquires the per-target {@link TargetLock} (409 on contention). Routes are
 * contributed via U1's registration seam — this file never touches `server.ts` core routing.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import YAML from "yaml";
import { z } from "zod";

import type { BridgeConfig } from "../config.ts";
import type { Job } from "../jobs.ts";
import { resolveWithinAllowlist } from "../paths.ts";
import type { RouteContext, RouteDefinition, RouteResult } from "../server.ts";
import { spawnPhase, TargetLock, type SpawnFn } from "../spawn.ts";

/** A holdout-safe project status line for `GET /projects`. */
export interface ProjectStatus {
  phase: string;
  next: string;
}

/** Injected collaborators for the phase routes. */
export interface PhaseRouteDeps {
  /** Shared per-target mutation lock (created once in `register.ts`). */
  lock: TargetLock;
  /** Injected child spawner for `spawnPhase`; defaults to `node:child_process`'s `spawn`. */
  spawn?: SpawnFn;
  /** Sparra binary override forwarded to `spawnPhase`. */
  sparraBin?: string;
  /** Read-only status source for `GET /projects`; defaults to reading `.sparra/state.json`. */
  statusSource?: (root: string, config: BridgeConfig) => ProjectStatus;
  /** Resolve the TARGET project's docs subfolder for `/plan`; defaults to reading `docsDir` from
   *  `<root>/.sparra/config.yaml` (`""` when absent). */
  docsDir?: (root: string) => string;
}

/** Static "what to do next" hints per phase — server-side constants, never file contents. */
const NEXT_HINT: Record<string, string> = {
  init: "sparra orient (existing) or sparra plan (greenfield)",
  orient: "sparra plan",
  plan: "sparra freeze",
  prototype: "sparra freeze",
  frozen: "sparra build",
  build: "sparra build (resume)",
  done: "sparra reflect",
};

/** Default status source: read only the `phase` control field from `.sparra/state.json` and map it
 *  to a static hint. Never surfaces any other state content (holdout-safe by construction). */
function defaultStatusSource(root: string): ProjectStatus {
  try {
    const raw = readFileSync(join(root, ".sparra", "state.json"), "utf8");
    const data = JSON.parse(raw) as { phase?: unknown };
    const phase = typeof data.phase === "string" ? data.phase : "unknown";
    return { phase, next: NEXT_HINT[phase] ?? "—" };
  } catch {
    return { phase: "uninitialized", next: "sparra init" };
  }
}

/**
 * Default docs-subfolder resolver for `/plan`: read only the `docsDir` field from the TARGET
 * project's `<root>/.sparra/config.yaml`, mirroring `src/config.ts`/`src/paths.ts` (`docsBase` =
 * `root` when `docsDir` is `""`, else `root/docsDir`). Any read/parse failure defaults to `""` (root)
 * — never a leaked file body, just the one control string.
 */
function defaultDocsDir(root: string): string {
  try {
    const raw = readFileSync(join(root, ".sparra", "config.yaml"), "utf8");
    const parsed = YAML.parse(raw) as { docsDir?: unknown } | null;
    return typeof parsed?.docsDir === "string" ? parsed.docsDir : "";
  } catch {
    return "";
  }
}

/** 400 helper for a body that fails its strict schema. */
function invalidBody(): RouteResult {
  return { status: 400, body: { error: "invalid request body" } };
}

/**
 * Acquire the mutation lock for `resolvedRoot` and create the tracking job, or return a 409 naming
 * the current holder. The holder-check → createJob → tryAcquire sequence is fully synchronous (no
 * `await`), so it is atomic in node's single-threaded loop — no window for a racing acquirer.
 */
function acquireOrConflict(
  ctx: RouteContext,
  deps: PhaseRouteDeps,
  resolvedRoot: string,
  kind: string,
): { job: Job } | RouteResult {
  const holder = deps.lock.holder(resolvedRoot);
  if (holder !== undefined) {
    return {
      status: 409,
      body: { error: `target busy: job ${holder} is already running for this root`, jobId: holder },
      jobId: holder,
      root: resolvedRoot,
    };
  }
  const job = ctx.jobs.createJob({ kind, root: resolvedRoot });
  deps.lock.tryAcquire(resolvedRoot, job.id);
  return { job };
}

/** Launch a tracked async phase job and return `{jobId}`. Assumes `resolvedRoot` already passed the
 *  guard and `argv` is fully built. */
function launch(
  ctx: RouteContext,
  deps: PhaseRouteDeps,
  resolvedRoot: string,
  kind: string,
  argv: string[],
): RouteResult {
  const acquired = acquireOrConflict(ctx, deps, resolvedRoot, kind);
  if ("status" in acquired) return acquired;
  const { job } = acquired;

  spawnPhase(
    job,
    {
      ...(deps.sparraBin !== undefined ? { sparraBin: deps.sparraBin } : {}),
      args: argv,
      cwd: resolvedRoot, // ALWAYS the guarded root — the child never runs outside the allowlist
    },
    {
      jobs: ctx.jobs,
      ...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
      // Free the per-target lock when the job settles (close/error/cancel).
      release: () => deps.lock.release(resolvedRoot),
    },
  );

  return { status: 202, body: { jobId: job.id }, jobId: job.id, root: resolvedRoot };
}

// --- Strict body schemas (unknown fields rejected) --------------------------------------------

const buildSchema = z
  .object({
    root: z.string(),
    fresh: z.boolean().optional(),
    only: z.string().optional(),
    step: z.string().optional(),
    budget: z.number().optional(),
    maxTurns: z.number().optional(),
  })
  .strict();

const reflectSchema = z.object({ root: z.string(), apply: z.boolean().optional() }).strict();
const resumeSchema = z.object({ root: z.string() }).strict();
const initSchema = z
  .object({ root: z.string(), mode: z.string().optional(), docs: z.string().optional() })
  .strict();
const freezeSchema = z.object({ root: z.string() }).strict();
const planSchema = z.object({ root: z.string(), content: z.string() }).strict();

/**
 * Build the phase routes. `resolveWithinAllowlist` throws a typed `PathGuardError` (mapped to 400/403
 * by the server) BEFORE any spawn/write, so an out-of-allowlist root is rejected without the spawner
 * ever being called.
 */
export function createPhaseRoutes(deps: PhaseRouteDeps): RouteDefinition[] {
  const statusSource = deps.statusSource ?? ((root) => defaultStatusSource(root));

  return [
    {
      method: "POST",
      path: "/build",
      handler: (ctx) => {
        const parsed = buildSchema.safeParse(ctx.body);
        if (!parsed.success) return invalidBody();
        const b = parsed.data;
        const root = resolveWithinAllowlist(b.root, ctx.config.roots);
        const argv = ["build"];
        if (b.fresh) argv.push("--fresh");
        if (b.only !== undefined) argv.push("--only", b.only);
        if (b.step !== undefined) argv.push("--step", b.step);
        if (b.budget !== undefined) argv.push("--budget", String(b.budget));
        if (b.maxTurns !== undefined) argv.push("--max-turns", String(b.maxTurns));
        return launch(ctx, deps, root, "build", argv);
      },
    },
    {
      method: "POST",
      path: "/reflect",
      handler: (ctx) => {
        const parsed = reflectSchema.safeParse(ctx.body);
        if (!parsed.success) return invalidBody();
        const b = parsed.data;
        const root = resolveWithinAllowlist(b.root, ctx.config.roots);
        const argv = ["reflect"];
        if (b.apply) argv.push("--apply");
        return launch(ctx, deps, root, "reflect", argv);
      },
    },
    {
      method: "POST",
      path: "/resume",
      handler: (ctx) => {
        const parsed = resumeSchema.safeParse(ctx.body);
        if (!parsed.success) return invalidBody();
        const root = resolveWithinAllowlist(parsed.data.root, ctx.config.roots);
        return launch(ctx, deps, root, "resume", ["resume"]);
      },
    },
    {
      method: "POST",
      path: "/init",
      handler: (ctx) => {
        const parsed = initSchema.safeParse(ctx.body);
        if (!parsed.success) return invalidBody();
        const b = parsed.data;
        const root = resolveWithinAllowlist(b.root, ctx.config.roots);
        const argv = ["init"];
        if (b.mode !== undefined) argv.push("--mode", b.mode);
        if (b.docs !== undefined) argv.push("--docs", b.docs);
        return launch(ctx, deps, root, "init", argv);
      },
    },
    {
      method: "POST",
      path: "/freeze",
      handler: (ctx) => {
        const parsed = freezeSchema.safeParse(ctx.body);
        if (!parsed.success) return invalidBody();
        const root = resolveWithinAllowlist(parsed.data.root, ctx.config.roots);
        return launch(ctx, deps, root, "freeze", ["freeze"]);
      },
    },
    {
      method: "GET",
      path: "/projects",
      // READ-ONLY: no mutation, no lock, synchronous. Reports only the `phase` control field + a
      // static hint per allowlisted root — never any holdout-bearing state content.
      handler: (ctx) => {
        const projects = ctx.config.roots.map((root) => {
          const status = statusSource(root, ctx.config);
          return { root, phase: status.phase, next: status.next };
        });
        return { status: 200, body: { projects } };
      },
    },
    {
      method: "POST",
      path: "/plan",
      handler: (ctx) => {
        // The human freeze gate is NOT bypassable by default: absent/false → 403, before any parse
        // or write. Only an operator flipping `allowRemotePlan` opens this.
        if (!ctx.config.allowRemotePlan) {
          return { status: 403, body: { error: "remote plan writes are disabled" } };
        }
        // Strict schema: a client-supplied filename/path/target is an UNKNOWN field → 400. The server
        // alone computes the write target, so a remote caller can never steer WHERE the write lands.
        const parsed = planSchema.safeParse(ctx.body);
        if (!parsed.success) return invalidBody();
        const b = parsed.data;
        const root = resolveWithinAllowlist(b.root, ctx.config.roots);

        // /plan is a WRITER: it must join the SAME per-target mutation lock as the phase spawns, so a
        // PLAN.md write can never race a `sparra build`/`reflect`/… mutating the same root's state.
        // A held target → 409 naming the holder; we hold the lock only for the synchronous write.
        const acquired = acquireOrConflict(ctx, deps, root, "plan");
        if ("status" in acquired) return acquired;
        const { job } = acquired;
        try {
          // Server-computed target = the project's docs base + PLAN.md, mirroring src/paths.ts
          // (`docsBase` = root, or root/docsDir when the project configures one) — NOT `.sparra/`.
          const docsDir = (deps.docsDir ?? defaultDocsDir)(root);
          const docsBase = docsDir ? join(root, docsDir) : root;
          // Re-check the computed target through the guard so even a config-supplied docsDir can never
          // escape the allowlist (e.g. a `../` traversal in docsDir is rejected here).
          const target = resolveWithinAllowlist(join(docsBase, "PLAN.md"), ctx.config.roots);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, b.content, "utf8");
          ctx.jobs.finish(job.id, { status: "succeeded" });
          return { status: 200, body: { ok: true }, jobId: job.id, root };
        } catch (err) {
          ctx.jobs.finish(job.id, { status: "failed" });
          throw err;
        } finally {
          deps.lock.release(root);
        }
      },
    },
  ];
}
