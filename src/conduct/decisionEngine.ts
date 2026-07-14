import fsp from "node:fs/promises";
import path from "node:path";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { ensureDir } from "../util/io.ts";
import type { BrainDecision, DecisionRecord, DecisionRequest, DecisionResolution } from "./decision.ts";
import { runStatePath } from "./runState.ts";

/**
 * `src/conduct/decisionEngine.ts` — the decision engine: surface a judgment point to a human via
 * the FILESYSTEM (the source of truth), a terminal (TTY readline), or resolve it automatically.
 *
 *   auto         → never park; the brain decides (deterministic policy when no brain).
 *   park         → write `<seq>.request.json`, poll for `<seq>.decision.json` (and a TTY answer),
 *                  first answer wins.
 *   park-timeout → park, but after `expiresAt` the brain (or deterministic policy) decides.
 *
 * Every payload is holdout-safe by construction (built from `ParentSummary`-derived material in
 * {@link ./decision.ts}). All I/O + clock + TTY are injected so tests run with no real sleeps.
 */

/** A terminal answer channel (production: readline; tests: a scripted fake). */
export interface TtySeam {
  /** Resolve with the human's typed answer. Never rejects on cancel — stays pending. */
  question(prompt: string): Promise<string>;
  /** Close the underlying handle so the event loop can exit (no leaked readline). */
  cancel(): void;
}

export interface DecisionEngineDeps {
  surface: "park" | "park-timeout" | "auto";
  /** The run directory; requests/decisions live under `<runDir>/decisions/`. */
  runDir: string;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Poll cadence in ms (default 500). */
  pollMs?: number;
  /** Present iff a brain is configured. Returns a decision, or undefined (invalid after reask). */
  brainJudge?: (req: DecisionRequest) => Promise<BrainDecision | undefined>;
  /** A TTY channel when stdin is a terminal. */
  tty?: TtySeam;
  /** Called synchronously the moment a request is written (a decision PARKS), with the written
   *  request path AND the parked request itself. Backward-compatible: a single-arg consumer simply
   *  ignores the extra `req`. The conduct side routes this through `handleDecisionParked` (announce
   *  line + `onDecisionParked` hook) and still preserves the pre-existing `onDecisionRequest` seam. */
  onRequestWritten?: (requestPath: string, req: DecisionRequest) => void;
}

/** The `decisions/` subfolder of a run dir. */
export function decisionsDir(runDir: string): string {
  return path.join(runDir, "decisions");
}
function requestPath(runDir: string, seq: number): string {
  return path.join(decisionsDir(runDir), `${seq}.request.json`);
}
function decisionPath(runDir: string, seq: number): string {
  return path.join(decisionsDir(runDir), `${seq}.decision.json`);
}

/** Resolve one decision per the configured surface. Never parks under `auto`. */
export async function resolveDecision(
  req: DecisionRequest,
  deps: DecisionEngineDeps,
): Promise<DecisionResolution> {
  if (deps.surface === "auto") {
    return decideAuto(req, deps, "auto");
  }
  return park(req, deps);
}

/** Brain-decides (source `brain`) or deterministic (`auto-deterministic` / `brain-fallback`). */
async function decideAuto(
  req: DecisionRequest,
  deps: DecisionEngineDeps,
  via: "auto" | "timeout",
): Promise<DecisionResolution> {
  if (deps.brainJudge) {
    const d = await deps.brainJudge(req);
    if (d && req.options.includes(d.answer)) {
      return { answer: d.answer, source: "brain", via, ...(d.rationale ? { rationale: d.rationale } : {}) };
    }
    // Brain consulted but its JSON was invalid after the reask → deterministic fallback.
    return { answer: req.default, source: "brain-fallback", via, rationale: "brain output invalid; deterministic default" };
  }
  return { answer: req.default, source: "auto-deterministic", via, rationale: "no brain configured; deterministic default" };
}

/** Park to the filesystem (+ TTY), first answer wins; `park-timeout` auto-resolves past `expiresAt`. */
async function park(req: DecisionRequest, deps: DecisionEngineDeps): Promise<DecisionResolution> {
  await ensureDir(decisionsDir(deps.runDir));
  const rp = requestPath(deps.runDir, req.seq);
  await fsp.writeFile(rp, JSON.stringify(req, null, 2) + "\n", "utf8");
  deps.onRequestWritten?.(rp, req);

  const pollMs = deps.pollMs ?? 500;
  const expiresAtMs = Date.parse(req.expiresAt);

  // Fire the TTY question once; track its answer without blocking the file poll.
  let ttyAnswer: string | undefined;
  if (deps.tty) {
    void deps.tty.question(`${req.question} [${req.options.join("/")}] (default ${req.default}) › `).then(
      (a) => {
        ttyAnswer = a.trim();
      },
      () => undefined,
    );
  }

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const fileAnswer = await readDecisionFile(deps.runDir, req.seq);
      if (fileAnswer && req.options.includes(fileAnswer.answer)) {
        return { answer: fileAnswer.answer, source: "file", via: "park", ...(fileAnswer.note ? { note: fileAnswer.note } : {}) };
      }
      if (ttyAnswer !== undefined) {
        const answer = ttyAnswer === "" ? req.default : ttyAnswer;
        if (req.options.includes(answer)) {
          return { answer, source: "tty", via: "park" };
        }
        // Invalid TTY input: fall through to keep polling.
        ttyAnswer = undefined;
      }
      if (deps.surface === "park-timeout" && deps.nowMs() >= expiresAtMs) {
        return decideAuto(req, deps, "timeout");
      }
      await deps.sleep(pollMs);
    }
  } finally {
    deps.tty?.cancel();
  }
}

/** Read a `<seq>.decision.json` if present + parseable, else undefined. */
async function readDecisionFile(runDir: string, seq: number): Promise<{ answer: string; note?: string } | undefined> {
  try {
    const raw = await fsp.readFile(decisionPath(runDir, seq), "utf8");
    const parsed = JSON.parse(raw) as { answer?: unknown; note?: unknown };
    if (typeof parsed.answer !== "string") return undefined;
    return { answer: parsed.answer, ...(typeof parsed.note === "string" ? { note: parsed.note } : {}) };
  } catch {
    return undefined;
  }
}

/** The `sparra conduct --decide` outcome: the written path, or why it was rejected. */
export type DecideWriteResult =
  | { ok: true; path: string }
  | { ok: false; reason: "already-resolved" | "bad-option"; validOptions?: string[] };

/**
 * ATOMICALLY write a decision answer file (the `sparra conduct --decide` target). The `answer` is
 * validated against the parked request's `options`, and the write uses the exclusive `wx` flag so an
 * ALREADY-RESOLVED decision can never be overwritten — a second answer for the same seq is rejected
 * (`already-resolved`), so one seq yields exactly one durable answer. Then the run's `run.json` audit
 * record for that seq is transitioned pending → resolved (best-effort; the running poller reaches the
 * SAME resolution from the file, so the record stays single).
 */
export async function writeDecisionAnswer(
  runDir: string,
  seq: number,
  answer: string,
  note?: string,
): Promise<DecideWriteResult> {
  const req = await readRequest(runDir, seq);
  if (req && Array.isArray(req.options) && req.options.length > 0 && !req.options.includes(answer)) {
    return { ok: false, reason: "bad-option", validOptions: req.options };
  }
  await ensureDir(decisionsDir(runDir));
  const p = decisionPath(runDir, seq);
  try {
    await fsp.writeFile(p, JSON.stringify({ answer, ...(note ? { note } : {}) }, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx", // exclusive create — fail if the decision already exists (already resolved)
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return { ok: false, reason: "already-resolved" };
    throw e;
  }
  await applyFileDecisionToRunState(runDir, seq, answer, note, req);
  return { ok: true, path: p };
}

/** The parked-request fields the CLI needs (options for validation, unit/kind for the audit record). */
interface RequestDoc {
  seq?: number;
  unit?: string;
  kind?: DecisionRecord["kind"];
  question?: string;
  options?: string[];
  default?: string;
  requestedAt?: string;
}

/** Read a `<seq>.request.json` if present + parseable, else undefined. */
export async function readRequest(runDir: string, seq: number): Promise<RequestDoc | undefined> {
  try {
    return JSON.parse(await fsp.readFile(requestPath(runDir, seq), "utf8")) as RequestDoc;
  } catch {
    return undefined;
  }
}

/**
 * Transition (or append) the `run.json` audit record for `seq` to `resolved` with `source: "file"`.
 * Idempotent: an already-`resolved` record is left untouched, so a poller that also observes the file
 * decision can't double-resolve. Written atomically (temp + rename). Best-effort — a missing/torn
 * run.json is a no-op (the decision file itself is the source of truth the poller reads).
 */
export async function applyFileDecisionToRunState(
  runDir: string,
  seq: number,
  answer: string,
  note?: string,
  req?: RequestDoc,
): Promise<void> {
  const statePath = runStatePath(runDir);
  let state: { units?: Array<Record<string, unknown>>; updatedAt?: string };
  try {
    state = JSON.parse(await fsp.readFile(statePath, "utf8"));
  } catch {
    return;
  }
  const at = new Date().toISOString();
  const resolve = (rec: Record<string, unknown>): void => {
    if (rec.status === "resolved") return; // idempotent — never overwrite an existing resolution
    rec.chosen = answer;
    rec.source = "file";
    rec.via = "park";
    if (note) rec.note = note;
    rec.resolvedAt = at;
    rec.status = "resolved";
  };

  let found = false;
  for (const u of state.units ?? []) {
    const decisions = (u.decisions as Array<Record<string, unknown>> | undefined) ?? [];
    const rec = decisions.find((d) => d.seq === seq);
    if (rec) {
      resolve(rec);
      found = true;
      break;
    }
  }
  if (!found) {
    // No pending record on disk yet (e.g. resolved before the poller persisted it): append one to
    // the request's unit so the audit trail still carries exactly one resolved record.
    const request = req ?? (await readRequest(runDir, seq));
    const unitId = request?.unit;
    const u = (state.units ?? []).find((x) => x.id === unitId);
    if (u) {
      const decisions = (u.decisions as Array<Record<string, unknown>> | undefined) ?? [];
      const record: DecisionRecord = {
        seq,
        unit: unitId ?? "",
        kind: request?.kind ?? "unit-exhausted",
        question: request?.question ?? "",
        options: request?.options ?? [],
        default: request?.default ?? answer,
        status: "resolved",
        requestedAt: request?.requestedAt ?? at,
        chosen: answer,
        source: "file",
        via: "park",
        ...(note ? { note } : {}),
        resolvedAt: at,
      };
      decisions.push(record as unknown as Record<string, unknown>);
      u.decisions = decisions;
    }
  }
  state.updatedAt = at;
  const tmp = `${statePath}.tmp.${process.pid}.decide`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await fsp.rename(tmp, statePath);
}

/** A real terminal answer channel over `node:readline` — used when stdin is a TTY. `cancel` closes
 *  the interface so a file-answer win doesn't leave a dangling readline keeping the loop alive. */
export function makeReadlineTty(): TtySeam {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  return {
    question: (prompt: string) => rl.question(prompt),
    cancel: () => rl.close(),
  };
}

/** True iff a `<seq>.request.json` exists (a parked, unanswered decision). */
export async function requestExists(runDir: string, seq: number): Promise<boolean> {
  try {
    await fsp.access(requestPath(runDir, seq));
    return true;
  } catch {
    return false;
  }
}
