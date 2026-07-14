/**
 * `conductors/http/events.ts` — append-only, secret-free bridge lifecycle events feed.
 *
 * Mirrors `audit.ts`'s shape (injectable sink, char-classed/length-capped sanitizers, JSONL on disk),
 * but where `audit.ts` logs one line PER REQUEST for operator forensics, `EventLog` is a bounded
 * IN-MEMORY ring with a monotonic `id` cursor, so a client can `GET /events?since=<cursor>` and learn
 * everything new across ALL jobs in one request instead of polling `GET /jobs/:id` per job per tick.
 *
 * Every field on the wire/in the file is server-derived and defensively bounded — see
 * {@link normalizeEvent}. This module is bridge-only: a direct CLI run never touches it.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One event line. `id`/`ts` are assigned by {@link EventLog} itself; every other field is optional and
 * MUST be treated as request-influenced (bounded via {@link normalizeEvent} before it ever reaches the
 * ring or the sink).
 */
export interface BridgeEvent {
  /** Monotonic, assigned by the log — the cursor unit for `since()`. */
  id: number;
  /** ISO timestamp. */
  ts: string;
  /** `decision_parked` is emitted by the conduct stdout observer (`handlers/conduct.ts`) when a run
   *  parks a judgment point — `runId`+`seq` from the child's announce line, `question`+`kind` from the
   *  realpath-guarded request file. `job_started`/`job_done` are emitted by the `JobStore`. */
  type: "job_started" | "job_done" | "decision_parked";
  jobId?: string;
  root?: string;
  /** Job kind (e.g. `"build"` / `"conduct"`) on `job_started`/`job_done`; the DECISION kind (e.g.
   *  `"merge-blocked"`) on a `decision_parked` event. */
  kind?: string;
  phase?: string;
  /** For `job_done`: `succeeded|failed|canceled` (the job's actual terminal status). */
  status?: string;
  runId?: string;
  seq?: number;
  /** Set only on a `decision_parked` event — holdout-safe by construction (the parked request's own
   *  `ParentSummary`-derived question, read from the realpath-guarded request file, never the wire line). */
  question?: string;
}

/** What a caller passes to {@link EventLog.emit}: every field but `id` (log-assigned) and `ts`
 *  (defaulted from the injected clock unless explicitly given — used by the startup seed path). */
export type BridgeEventInput = Omit<BridgeEvent, "id" | "ts"> & { ts?: string };

/** A sink that receives one already-formatted event line (no trailing newline). */
export type EventSink = (line: string) => void;

/** Longest `jobId` retained on an event — mirrors `audit.ts`'s job-id cap. */
const MAX_JOB_ID_LEN = 64;

/** Generous cap for every other request-influenced string field (`root`/`kind`/`phase`/`status`/
 *  `runId`/`question`) — the point isn't to constrain legitimate content, only to guarantee no
 *  unbounded/control-char/secret-smuggling value ever lands on the wire or in the file. */
const MAX_FIELD_LEN = 500;

const EVENT_TYPES = new Set<BridgeEvent["type"]>(["job_started", "job_done", "decision_parked"]);

/** Strip anything outside `[A-Za-z0-9_-]` and cap the length — identical shape to `audit.ts`'s
 *  `sanitizeJobId`; a job id is server-generated but reaches an event via a request-adjacent field. */
function sanitizeJobId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, MAX_JOB_ID_LEN);
}

/** Strip C0/DEL control characters (`\x00`-`\x1F`, `\x7F`) and cap the length. Used for every
 *  non-jobId string field so no control byte or unbounded value ever reaches the wire/file. */
function boundField(value: string): string {
  // eslint-disable-next-line no-control-regex -- intentionally stripping control bytes
  return value.replace(/[\x00-\x1F\x7F]/g, "").slice(0, MAX_FIELD_LEN);
}

/**
 * The ONE place bounding happens — used by both `emit` (a freshly-assembled candidate) and the seed
 * path (an already allowlist-projected + type-checked record). `id`/`ts`/`type` are passed through
 * (numeric/server-stamped or already-validated by the caller); every other field is sanitized/capped.
 */
function normalizeEvent(candidate: BridgeEvent): BridgeEvent {
  const out: BridgeEvent = { id: candidate.id, ts: candidate.ts, type: candidate.type };
  if (candidate.jobId !== undefined) out.jobId = sanitizeJobId(candidate.jobId);
  if (candidate.root !== undefined) out.root = boundField(candidate.root);
  if (candidate.kind !== undefined) out.kind = boundField(candidate.kind);
  if (candidate.phase !== undefined) out.phase = boundField(candidate.phase);
  if (candidate.status !== undefined) out.status = boundField(candidate.status);
  if (candidate.runId !== undefined) out.runId = boundField(candidate.runId);
  if (candidate.question !== undefined) out.question = boundField(candidate.question);
  if (candidate.seq !== undefined && Number.isFinite(candidate.seq)) out.seq = candidate.seq;
  return out;
}

/** Serialize a {@link BridgeEvent} to one JSON line, normalizing it first — safe to call standalone
 *  (not just from `emit`), since it never trusts the caller already bounded the fields. */
export function formatEventLine(e: BridgeEvent): string {
  return JSON.stringify(normalizeEvent(e));
}

/** A file-backed {@link EventSink}: append mode, creating the parent directory if needed — identical
 *  shape to `audit.ts`'s `createFileAuditSink`. */
export function createFileEventSink(path: string): EventSink {
  return (line: string) => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line + "\n", "utf8");
  };
}

/**
 * Read a seed file's lines for {@link EventLog}'s startup seeding, WITHOUT parsing/validating them
 * (that's the log's job, so it can apply the exact same allowlist + `normalizeEvent` bounding). An
 * absent file yields `[]`; blank lines are dropped. Keeps disk I/O at the edge — `EventLog` itself
 * never touches `fs`.
 */
export function readEventSeedLines(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The exact allowlisted keys of a wire {@link BridgeEvent} — anything else on a parsed seed record is
 *  untrusted in its entirety (see {@link projectSeedRecord}). */
const KNOWN_EVENT_KEYS = new Set([
  "id",
  "ts",
  "type",
  "jobId",
  "root",
  "kind",
  "phase",
  "status",
  "runId",
  "seq",
  "question",
]);

/** String fields projected (with a runtime `typeof` check) from a seed record, beyond `id`/`ts`/`type`/`seq`. */
const SEED_STRING_FIELDS = ["jobId", "root", "kind", "phase", "status", "runId", "question"] as const;

/**
 * Project a parsed seed line onto the EXACT `BridgeEvent` allowlist with runtime type checks.
 * TypeScript types don't constrain parsed JSON, so a seed line carrying an extra key (`token`,
 * `authorization`, …) — even alongside an otherwise-valid `id`/`type` — is untrusted IN ITS ENTIRETY
 * and dropped WHOLE (never partially salvaged). Returns `undefined` for anything malformed.
 */
function projectSeedRecord(raw: unknown): BridgeEvent | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!KNOWN_EVENT_KEYS.has(key)) return undefined;
  }
  if (typeof rec.id !== "number" || !Number.isFinite(rec.id)) return undefined;
  if (typeof rec.ts !== "string") return undefined;
  if (typeof rec.type !== "string" || !EVENT_TYPES.has(rec.type as BridgeEvent["type"])) return undefined;

  const out: BridgeEvent = { id: rec.id, ts: rec.ts, type: rec.type as BridgeEvent["type"] };
  for (const key of SEED_STRING_FIELDS) {
    if (rec[key] !== undefined) {
      if (typeof rec[key] !== "string") return undefined;
      out[key] = rec[key] as string;
    }
  }
  if (rec.seq !== undefined) {
    if (typeof rec.seq !== "number" || !Number.isFinite(rec.seq)) return undefined;
    out.seq = rec.seq;
  }
  return out;
}

/** Injectable opts for {@link EventLog}, mirroring `JobStoreOptions`'s injection style. */
export interface EventLogOptions {
  /** Receives each formatted line. Default: no-op (a live bridge wires a {@link createFileEventSink}). */
  sink?: EventSink;
  /** Injected clock — EITHER a Date-returning clock (default `() => new Date()`) OR an epoch-
   *  milliseconds NUMERIC clock (e.g. `() => Date.now()` or a fixed `() => 0`) — so `ts` is
   *  deterministic in tests either way. Normalized to an ISO string in ONE place, {@link toIsoString}. */
  now?: (() => number) | (() => Date);
  /** Bounded in-memory retention; oldest evicted past it. Default ~1000. */
  ringSize?: number;
  /** Raw lines (e.g. from {@link readEventSeedLines}) used to seed `nextId` + the ring at startup, so
   *  cursors survive a bridge restart. */
  seedLines?: string[];
}

const DEFAULT_RING_SIZE = 1000;

/** Normalize the injected clock's return value — a `Date` OR a number (epoch milliseconds) — to an
 *  ISO string. The ONE place `ts` is stamped from `now`, so both clock shapes `EventLogOptions.now`
 *  allows (`() => Date` and `() => number`) are handled identically here. */
function toIsoString(value: number | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * In-memory, bounded, cursor-addressable ring of {@link BridgeEvent}s. Free of direct `fs`/clock access
 * except through the injected `sink`/`now` seams — only {@link createFileEventSink} and
 * {@link readEventSeedLines} touch disk.
 */
export class EventLog {
  private readonly sink: EventSink;
  private readonly now: () => number | Date;
  private readonly ringSize: number;
  private ring: BridgeEvent[] = [];
  private nextId = 1;
  /** The highest id ever emitted/seeded — survives ring eviction so a cursor never regresses. */
  private maxId = 0;

  constructor(options: EventLogOptions = {}) {
    this.sink = options.sink ?? (() => {});
    this.now = options.now ?? (() => new Date());
    this.ringSize = Math.max(1, options.ringSize ?? DEFAULT_RING_SIZE);
    if (options.seedLines && options.seedLines.length > 0) this.seed(options.seedLines);
  }

  /**
   * Startup seeding: `JSON.parse` each line (skip on throw), project onto the exact allowlist with
   * runtime types (drop the WHOLE record on any extra key or wrong-typed field), then run every valid
   * record through the SAME `normalizeEvent` bounding `emit` uses. `nextId` becomes `max(valid id)+1`;
   * the ring keeps the last `ringSize` valid events.
   */
  private seed(lines: string[]): void {
    const valid: BridgeEvent[] = [];
    let maxId = 0;
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const projected = projectSeedRecord(parsed);
      if (projected === undefined) continue;
      const normalized = normalizeEvent(projected);
      valid.push(normalized);
      if (normalized.id > maxId) maxId = normalized.id;
    }
    this.ring = valid.slice(-this.ringSize);
    this.maxId = maxId;
    this.nextId = maxId + 1;
  }

  /** Assign the next monotonic `id` + `ts` (from the injected clock unless `partial.ts` is given),
   *  bound every field via `normalizeEvent`, push onto the ring (evicting the oldest past `ringSize`),
   *  emit the formatted line to `sink`, and return the full stored event. */
  emit(partial: BridgeEventInput): BridgeEvent {
    const id = this.nextId++;
    const ts = partial.ts ?? toIsoString(this.now());
    const normalized = normalizeEvent({ ...partial, id, ts });
    this.ring.push(normalized);
    if (this.ring.length > this.ringSize) this.ring.shift();
    if (normalized.id > this.maxId) this.maxId = normalized.id;
    this.sink(formatEventLine(normalized));
    return normalized;
  }

  /**
   * Every retained event with `id > cursor`, plus `cursor` = the highest id ever emitted/seeded so
   * far (NOT just what's retained) — so a polling client's cursor never regresses even past ring
   * eviction. `cursor <= 0` returns everything still in the ring.
   */
  since(cursor: number): { events: BridgeEvent[]; cursor: number } {
    const events = cursor > 0 ? this.ring.filter((e) => e.id > cursor) : [...this.ring];
    return { events, cursor: this.maxId };
  }
}
