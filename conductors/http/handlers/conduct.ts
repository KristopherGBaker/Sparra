/**
 * `conductors/http/handlers/conduct.ts` — the `POST /conduct` trigger + `POST /jobs/:id/decision`
 * remote decision-answer endpoints.
 *
 * `POST /conduct` spawns `sparra conduct …` exactly like the other phase triggers (async job, per-target
 * {@link TargetLock}, server-built argv from a STRICT zod body), and — because a conduct run parks
 * important decisions — parses the child's run-START announcement (`src/conduct/announce.ts`) from
 * stdout to associate the job with its run. `GET /jobs/:id` then surfaces that run's still-parked
 * `pendingDecisions` (see `conductors/http/decisions.ts` + `server.ts`). The one endpoint serves both a
 * FRESH run (`prompt`, optionally self-landing via `commit`/`merge`) and a RESUME of a crashed/parked
 * run (`resume: "<runId>"`); EXACTLY ONE of `prompt` | `resume` is required, and a resume body may
 * carry only `root, resume, commit, merge, auto`. A resumed run re-announces, so `pendingDecisions` +
 * `POST /jobs/:id/decision` work identically on it.
 *
 * `POST /jobs/:id/decision` answers a parked decision IN-PROCESS via U2's engine
 * (`writeDecisionAnswer` + `applyFileDecisionToRunState`) — it never shells out to `conduct --decide`
 * and never reimplements the `<seq>.decision.json` write. Both routes are Bearer-gated like every
 * other route; the decision route's audit line records only `{seq, decision, result}` — never the
 * free-text `note`.
 */

import { join } from "node:path";

import { z } from "zod";

import {
  DECISION_PARKED_PREFIX,
  parseDecisionParkedAnnouncement,
  parseRunStartAnnouncement,
  RUN_START_PREFIX,
} from "../../../src/conduct/announce.ts";
import {
  applyFileDecisionToRunState,
  requestExists,
  writeDecisionAnswer,
} from "../../../src/conduct/decisionEngine.ts";
import { isSafeRunId } from "../../../src/conduct/runState.ts";
import { readPendingDecisions } from "../decisions.ts";
import type { EventLog } from "../events.ts";
import type { Job } from "../jobs.ts";
import { resolveWithinAllowlist } from "../paths.ts";
import type { RouteContext, RouteDefinition, RouteResult } from "../server.ts";
import { spawnPhase, TargetLock, type SpawnFn } from "../spawn.ts";

/** Injected collaborators for the conduct routes. */
export interface ConductRouteDeps {
  /** Shared per-target mutation lock (created once in `register.ts`). */
  lock: TargetLock;
  /** Injected child spawner for `spawnPhase`; defaults to `node:child_process`'s `spawn`. */
  spawn?: SpawnFn;
  /** Sparra binary override forwarded to `spawnPhase`. */
  sparraBin?: string;
  /** The SHARED events feed (same instance `GET /events` + the `JobStore` use, wired in
   *  `registerBridgeRoutes`/`startBridge`). When present, a parked decision announced on the conduct
   *  child's stdout is surfaced as a `decision_parked` event; when absent (a test that omits it, or a
   *  direct CLI run), nothing is emitted — byte-identical stdout, no event. */
  eventLog?: EventLog;
}

// --- Strict body schemas (unknown fields rejected; CLI-meaningful value constraints enforced) ------

/** A CLI-meaningful positive integer (`--max-units`/`--concurrency`/`--max-turns`). */
const positiveInt = z.number().int().positive();
/** A CLI-meaningful non-negative number (`--budget`; `0` = unlimited). */
const nonNegativeNumber = z.number().nonnegative();

/** The run-shaping fields the CLI's `--resume` refuses (it accepts only `--commit|--merge|--auto`) —
 *  so a resume body carrying any of them is a fail-closed `400`, never a silently-ignored spawn. */
const RESUME_INCOMPATIBLE_FIELDS = ["mode", "maxUnits", "concurrency", "budget", "maxTurns"] as const;

const conductSchema = z
  .object({
    root: z.string(),
    // EXACTLY ONE of `prompt` | `resume` (enforced below). `prompt` starts a fresh run; `resume`
    // continues a persisted `<runId>` in place. Run-shaping fields are fresh-run only.
    prompt: z.string().min(1).optional(),
    resume: z.string().min(1).optional(),
    auto: z.boolean().optional(),
    // Landing flags forwarded verbatim to the CLI (which owns `--merge` ⇒ `--commit`); valid on both
    // fresh and resume runs.
    commit: z.boolean().optional(),
    merge: z.boolean().optional(),
    mode: z.enum(["hybrid", "llm"]).optional(),
    maxUnits: positiveInt.optional(),
    concurrency: positiveInt.optional(),
    budget: nonNegativeNumber.optional(),
    maxTurns: positiveInt.optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    const hasPrompt = b.prompt !== undefined;
    const hasResume = b.resume !== undefined;
    // EXACTLY ONE of `prompt` | `resume` — both or neither is a 400 (fail-closed).
    if (hasPrompt === hasResume) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "exactly one of `prompt` or `resume` is required" });
      return;
    }
    // A resume body may carry ONLY `root, resume, commit, merge, auto` — any run-shaping field
    // alongside `resume` is a 400 (the CLI's `--resume` accepts only `--commit|--merge|--auto`).
    if (hasResume) {
      for (const field of RESUME_INCOMPATIBLE_FIELDS) {
        if (b[field] !== undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `\`${field}\` is not allowed with \`resume\`` });
        }
      }
    }
  });

const decisionSchema = z
  .object({
    seq: z.number().int().positive(),
    answer: z.string().min(1),
    note: z.string().optional(),
  })
  .strict();

/** 400 for a body that fails its strict schema. */
function invalidBody(): RouteResult {
  return { status: 400, body: { error: "invalid request body" } };
}

/** Build the `sparra conduct` argv from a validated body — ONLY server-mapped flags, never client
 *  text beyond the prompt/runId positional and enum/numeric values. `--commit`/`--merge` are forwarded
 *  verbatim (the CLI owns `--merge` ⇒ `--commit`; the bridge never synthesizes one from the other). A
 *  `resume` body maps to `["conduct","--resume",<runId>, …resume-compatible flags]`. */
function buildConductArgv(b: z.infer<typeof conductSchema>): string[] {
  if (b.resume !== undefined) {
    const argv = ["conduct", "--resume", b.resume];
    if (b.auto) argv.push("--auto");
    if (b.commit) argv.push("--commit");
    if (b.merge) argv.push("--merge");
    return argv;
  }
  const argv = ["conduct", b.prompt!];
  if (b.auto) argv.push("--auto");
  if (b.mode !== undefined) argv.push("--brain", b.mode);
  if (b.maxUnits !== undefined) argv.push("--max-units", String(b.maxUnits));
  if (b.concurrency !== undefined) argv.push("--concurrency", String(b.concurrency));
  if (b.budget !== undefined) argv.push("--budget", String(b.budget));
  if (b.maxTurns !== undefined) argv.push("--max-turns", String(b.maxTurns));
  if (b.commit) argv.push("--commit");
  if (b.merge) argv.push("--merge");
  return argv;
}

/**
 * Canonicalize the run dir for `runId`: DERIVE the exact expected `<root>/.sparra/conduct/<runId>`
 * path (never trust the child's announced `runDir` string) and run it through the bridge's realpath
 * guard ({@link resolveWithinAllowlist}) so a `..` in the runId OR a symlink planted at the run dir
 * that escapes the allowlist is rejected. Returns the realpathed, in-root path, or `undefined` when
 * it can't be canonicalized safely.
 */
export function canonicalRunDir(resolvedRoot: string, runId: string, roots: string[]): string | undefined {
  try {
    return resolveWithinAllowlist(join(resolvedRoot, ".sparra", "conduct", runId), roots);
  } catch {
    return undefined;
  }
}

/**
 * A stdout observer that surfaces BOTH conduct announce lines (line-buffered across chunks):
 *
 *  - The FIRST run-START line records `runId` + the CANONICAL (realpath-guarded) run dir onto the job
 *    (recorded ONCE — a job has one run). The child-announced `runDir` text is never trusted — the dir
 *    is derived from `runId` under the guarded root and realpath-validated, so a symlink escaping the
 *    allowlist yields NO stored `runDir` (decision reads/writes then 404 rather than following the
 *    symlink out of root).
 *  - EACH decision-parked line (which arrive later and repeatedly) is turned into a `decision_parked`
 *    event on the shared `eventLog` — but ONLY runId+seq are ever trusted from the line: `question`/
 *    `kind` come from the realpath-guarded request FILE (`readPendingDecisions`) under the allowlisted
 *    root. FAIL CLOSED — no recorded `runDir`, a foreign `runId`, an unreadable/guard-rejected request,
 *    or no `eventLog` wired ⇒ NOTHING is emitted for that decision. A given `(runId, seq)` is emitted at
 *    most once per job (a resume re-announce / split chunk never double-emits).
 *
 * Never stops scanning (decision-parked lines follow the run-START line) and never mutates the output.
 */
function makeAnnouncementParser(
  job: Job,
  resolvedRoot: string,
  roots: string[],
  eventLog?: EventLog,
): (chunk: string) => void {
  let buffer = "";
  let runStartSeen = false;
  const emittedSeqs = new Set<number>();
  return (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);

      if (!runStartSeen && line.includes(RUN_START_PREFIX)) {
        const ann = parseRunStartAnnouncement(line);
        if (!ann) continue;
        runStartSeen = true; // record the run's id/dir exactly once — a job has one run
        const canonical = canonicalRunDir(resolvedRoot, ann.runId, roots);
        if (canonical !== undefined) {
          job.runId = ann.runId;
          job.runDir = canonical;
        }
        continue;
      }

      if (eventLog && line.includes(DECISION_PARKED_PREFIX)) {
        const ann = parseDecisionParkedAnnouncement(line);
        if (!ann) continue;
        // Fail closed: only for THIS job's recorded run, and only once per seq.
        if (job.runId === undefined || job.runDir === undefined) continue;
        if (ann.runId !== job.runId) continue;
        if (emittedSeqs.has(ann.seq)) continue;
        // `question`/`kind` come ONLY from the realpath-guarded request file — never the line text.
        const parked = readPendingDecisions(job.runDir, roots).find((d) => d.seq === ann.seq);
        if (!parked) continue; // unreadable / guard-rejected / already-resolved ⇒ emit nothing
        emittedSeqs.add(ann.seq);
        eventLog.emit({
          type: "decision_parked",
          jobId: job.id,
          ...(job.root ? { root: job.root } : {}),
          runId: ann.runId,
          seq: ann.seq,
          ...(parked.question ? { question: parked.question } : {}),
          ...(parked.kind ? { kind: parked.kind } : {}),
        });
      }
    }
  };
}

/** Build the conduct routes (`POST /conduct`, `POST /jobs/:id/decision`). */
export function createConductRoutes(deps: ConductRouteDeps): RouteDefinition[] {
  return [
    {
      method: "POST",
      path: "/conduct",
      handler: (ctx: RouteContext): RouteResult => {
        const parsed = conductSchema.safeParse(ctx.body);
        if (!parsed.success) return invalidBody();
        // A `resume` runId must be a safe, single-segment id BEFORE any lock or spawn — an unsafe id
        // (`..`, a path separator, arg-injection) is a 400 with ZERO side effects. The CLI re-validates,
        // but the bridge must not spawn a child just to have it exit 1.
        if (parsed.data.resume !== undefined && !isSafeRunId(parsed.data.resume)) {
          return invalidBody();
        }
        // Resolve the root through the guard BEFORE any lock or spawn — a bad root throws (→400/403)
        // and the spawner is never called.
        const root = resolveWithinAllowlist(parsed.data.root, ctx.config.roots);

        // Conduct MUTATES the target (writes `.sparra/conduct/…`), so it takes the per-target lock.
        const holder = deps.lock.holder(root);
        if (holder !== undefined) {
          return {
            status: 409,
            body: { error: `target busy: job ${holder} is already running for this root`, jobId: holder },
            jobId: holder,
            root,
          };
        }

        const argv = buildConductArgv(parsed.data);
        const job = ctx.jobs.createJob({ kind: "conduct", root });
        deps.lock.tryAcquire(root, job.id);

        spawnPhase(
          job,
          {
            ...(deps.sparraBin !== undefined ? { sparraBin: deps.sparraBin } : {}),
            args: argv,
            cwd: root, // ALWAYS the guarded root — the child never runs outside the allowlist
          },
          {
            jobs: ctx.jobs,
            ...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
            release: () => deps.lock.release(root),
            // Learn the run's id/dir from the child's run-START line so `pendingDecisions` +
            // `/jobs/:id/decision` can find its decisions dir — realpath-guarded against symlink escape.
            // The SAME observer surfaces each decision-parked line as a `decision_parked` event on the
            // shared events feed (`question`/`kind` from the guarded request file, never the line).
            onStdout: makeAnnouncementParser(job, root, ctx.config.roots, deps.eventLog),
          },
        );

        return { status: 202, body: { jobId: job.id }, jobId: job.id, root };
      },
    },
    {
      method: "POST",
      path: "/jobs/:id/decision",
      handler: async (ctx: RouteContext): Promise<RouteResult> => {
        const id = ctx.params.id!;
        const job = ctx.jobs.getJob(id);
        // 404 unknown job, OR a job with no associated run (not a conduct job / run not yet announced).
        if (!job || job.runDir === undefined) {
          return { status: 404, body: { error: "job or run not found" }, jobId: id };
        }
        // Re-assert the realpath guard at USE time (defense in depth): never follow a stored runDir that
        // now resolves outside the allowlist (e.g. a symlink swapped in after the run was announced).
        let runDir: string;
        try {
          runDir = resolveWithinAllowlist(job.runDir, ctx.config.roots);
        } catch {
          return { status: 404, body: { error: "job or run not found" }, jobId: id };
        }

        const parsed = decisionSchema.safeParse(ctx.body);
        if (!parsed.success) return invalidBody();
        const { seq, answer, note } = parsed.data;

        // 404 unknown seq: no parked request for this seq in the run's decisions dir.
        if (!(await requestExists(runDir, seq))) {
          return { status: 404, body: { error: `no parked decision #${seq}` }, jobId: id, root: job.root };
        }

        // Resolve IN-PROCESS via U2's engine — the atomic `wx` write validates the answer against the
        // parked request's options and rejects a double-answer; NO shell-out, NO reimplemented protocol.
        const result = await writeDecisionAnswer(runDir, seq, answer, note);
        if (!result.ok) {
          if (result.reason === "bad-option") {
            return {
              status: 400,
              body: { error: "invalid answer for this decision", validOptions: result.validOptions ?? [] },
              jobId: id,
              root: job.root,
            };
          }
          // already-resolved → 409
          return { status: 409, body: { error: `decision #${seq} is already resolved` }, jobId: id, root: job.root };
        }

        // `writeDecisionAnswer` already transitioned run.json pending → resolved; re-apply defensively
        // (idempotent — an already-resolved record is left untouched) so the run's audit trail is
        // consistent even if the file existed before its run.json record did.
        await applyFileDecisionToRunState(runDir, seq, answer, note);

        // Audit records the seq + chosen option key + result ONLY — never the free-text note.
        return {
          status: 200,
          body: { ok: true, seq, chosen: answer },
          jobId: id,
          ...(job.root ? { root: job.root } : {}),
          seq,
          decision: answer,
        };
      },
    },
  ];
}
