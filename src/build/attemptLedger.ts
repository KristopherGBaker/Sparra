import path from "node:path";
import fs from "node:fs";
import type { Paths } from "../paths.ts";
import { appendText, readTextSync } from "../util/io.ts";

/**
 * `src/build/attemptLedger.ts` — the typed, durable, APPEND-ONLY per-round ATTEMPT LEDGER for both
 * loops (`sparra build` and each `sparra conduct` unit). Distinct from the prompt-facing
 * `build/attempts.ts` ledger (which records only GAN pivots for the "PRIOR ATTEMPTS" injection): this
 * one records EVERY decided round as inspectable, reconstructable-lineage data — "what was tried, what
 * did it score, why was it kept or abandoned" — so a human or a later role never has to re-read traces.
 *
 * REDACTION WALL (same as feedback.ts / attempts.ts): a record's `reason` is built ONLY from
 * already-holdout-redacted material (Verdict blocking/notes, redacted feedback, redacted preflight/halt
 * text). NEVER pass raw evaluator/session output, an evaluator trace dir, or holdout content in here.
 *
 * DURABILITY: one JSONL file per item/unit (`ATTEMPT_LEDGER_BASENAME`) under a run-scoped dir on disk
 * (the filesystem is Sparra's source of truth — `state.json` is mutable + gitignored, so the ledger is
 * a first-class artifact). Records are append-only: a later append never rewrites an earlier byte, and
 * a crash/replay of an already-recorded round is a no-op (dedup on the round number), so an interrupted
 * loop that re-drives a persisted round decision produces no duplicate and never overwrites history.
 */

/** The artifact filename (a single pinned basename, used for both loops). */
export const ATTEMPT_LEDGER_BASENAME = "attempts.jsonl";

/** Max chars for a record's redacted `reason` — one round can't flood a status projection. */
export const REASON_CAP = 300;

/** The evaluated GENERATION this round ran (describes the round's INPUT, never the loop's later choice).
 *  `initial` = round 1; `patch` = descends from the prior round; `pivot` = a fresh restart (new descent). */
export type AttemptKind = "initial" | "patch" | "pivot";

/** What the loop DID after grading this round (describes the OUTCOME; distinct from `kind` — a `patch`
 *  round may carry `decision: "pivot"`). Nullable-eval decisions (budget-halt, terminal-inconclusive,
 *  preflight continue-patch) carry no score/verdict. */
export type AttemptDecision =
  | "accept"
  | "continue-patch"
  | "pivot"
  | "abandon"
  | "budget-halt"
  | "terminal-inconclusive"
  | "terminal-fail"
  | "human-accept"
  | "human-abandon";

/** One durable attempt-ledger record. `score`/`verdict`/`verdictPath` are NULLABLE (absent when no
 *  evaluation happened this round — a pre-eval budget halt, a preflight bounce, a blocked/all-un-run
 *  inconclusive, or a conduct summary lacking a weightedTotal) — never fabricated. */
export interface AttemptLedgerRecord {
  /** `a<seq>` — 1-based append ordinal within THIS ledger; unique + stable. */
  attemptId: string;
  /** The attemptId this round descends from (patch → prior round; pivot/initial → null root). */
  parentAttemptId: string | null;
  /** Descent line: initial = 0; patch inherits its parent's; a pivot opens a NEW line (max + 1). */
  lineage: number;
  round: number;
  kind: AttemptKind;
  decision: AttemptDecision;
  /** Weighted total for the round's grade, or null when no evaluation happened. */
  score: number | null;
  verdict: "pass" | "fail" | null;
  /** The runner-persisted redacted verdict artifact path (never contents), or null. */
  verdictPath: string | null;
  /** Non-empty, ≤ REASON_CAP chars, derived only from redacted decision input. */
  reason: string;
  /** Cumulative (or per-round) USD cost when available, else null. */
  cost: number | null;
  at: string;
}

/** The caller-supplied fields for one append; lineage/attemptId are computed from the existing ledger. */
export interface AttemptInput {
  round: number;
  kind: AttemptKind;
  decision: AttemptDecision;
  score?: number | null;
  verdict?: "pass" | "fail" | null;
  verdictPath?: string | null;
  reason?: string;
  cost?: number | null;
  at?: string;
}

/** The on-disk ledger path for a BUILD item (`.sparra/runs/<runId>/<itemId>/attempts.jsonl`). */
export function buildAttemptLedgerPath(paths: Paths, runId: string, itemId: string): string {
  return path.join(paths.runs, runId, itemId, ATTEMPT_LEDGER_BASENAME);
}

/** The on-disk ledger path for a CONDUCT unit (`<runDir>/<unitId>/attempts.jsonl`). */
export function conductAttemptLedgerPath(runDir: string, unitId: string): string {
  return path.join(runDir, unitId, ATTEMPT_LEDGER_BASENAME);
}

/** Trim + cap the reason; fall back to a safe placeholder so a record is never empty-reasoned. */
function cleanReason(reason: string | undefined): string {
  const t = (reason ?? "").replace(/\s+/g, " ").trim();
  const body = t || "(no decision detail recorded)";
  return body.length > REASON_CAP ? body.slice(0, REASON_CAP - 1).trimEnd() + "…" : body;
}

/** Read the ledger back as parsed records (tolerant of a missing file / a torn trailing line). A
 *  missing ledger is NOT an error — it returns []. */
export function readAttemptLedger(file: string): AttemptLedgerRecord[] {
  const text = readTextSync(file);
  if (text == null) return [];
  const out: AttemptLedgerRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as AttemptLedgerRecord);
    } catch {
      // A torn trailing line (crash mid-append) is skipped, not fatal — the ledger stays readable.
    }
  }
  return out;
}

/** Compute the lineage triple ({attemptId, parentAttemptId, lineage}) for a new record given the
 *  existing ones and the round's kind. Pure — the exact schema the contract pins. */
function computeLineage(
  existing: AttemptLedgerRecord[],
  kind: AttemptKind,
): { attemptId: string; parentAttemptId: string | null; lineage: number } {
  const attemptId = `a${existing.length + 1}`;
  const prev = existing[existing.length - 1];
  if (kind === "initial" || !prev) {
    return { attemptId, parentAttemptId: null, lineage: 0 };
  }
  if (kind === "pivot") {
    const maxLineage = existing.reduce((m, r) => Math.max(m, r.lineage), 0);
    return { attemptId, parentAttemptId: null, lineage: maxLineage + 1 };
  }
  // patch → descend from the immediately prior round, same descent line.
  return { attemptId, parentAttemptId: prev.attemptId, lineage: prev.lineage };
}

/**
 * Append one record. Append-only + crash-safe:
 *  - dedup on the round number: if a record for `input.round` already exists, this is a no-op (an
 *    identical replay after a crash makes no duplicate; a CONFLICTING later decision leaves the
 *    existing record UNCHANGED — history is never rewritten). Returns the existing record.
 *  - otherwise computes attemptId/parentAttemptId/lineage from the existing ledger and appends one
 *    JSON line, leaving every earlier byte intact.
 * Best-effort: a persistence hiccup never breaks the loop (the ledger is inspectable telemetry, not a
 * gate) — callers may ignore the returned promise's rejection via `.catch`, but this fn itself only
 * rejects on a genuine write error.
 */
export async function appendAttempt(file: string, input: AttemptInput): Promise<AttemptLedgerRecord> {
  const existing = readAttemptLedger(file);
  const dup = existing.find((r) => r.round === input.round);
  if (dup) return dup; // already recorded this round — never overwrite, never duplicate.

  const { attemptId, parentAttemptId, lineage } = computeLineage(existing, input.kind);
  const record: AttemptLedgerRecord = {
    attemptId,
    parentAttemptId,
    lineage,
    round: input.round,
    kind: input.kind,
    decision: input.decision,
    score: input.score ?? null,
    verdict: input.verdict ?? null,
    verdictPath: input.verdictPath ?? null,
    reason: cleanReason(input.reason),
    cost: input.cost ?? null,
    at: input.at ?? new Date().toISOString(),
  };
  await appendText(file, JSON.stringify(record) + "\n");
  return record;
}

/** Best-effort append that swallows its own errors — the ledger is telemetry, never a gate. Used at
 *  the build/conduct decision seams so a disk hiccup can never break acceptance or terminalization. */
export async function recordAttemptLedger(file: string, input: AttemptInput): Promise<void> {
  try {
    await appendAttempt(file, input);
  } catch {
    // Ledger persistence is best-effort — a failure here must never break the loop.
  }
}

/** Render one compact human-readable ledger line for `sparra status --attempts` /
 *  `conduct --status --attempts`. Metadata + paths only (holdout-safe by construction — the record
 *  is already built from redacted fields). */
export function renderAttemptLine(r: AttemptLedgerRecord): string {
  const evalPart =
    r.score !== null || r.verdict !== null
      ? `${r.verdict ?? "-"}/${r.score ?? "-"}`
      : "unevaluated";
  const lineageRef = r.parentAttemptId ? `${r.parentAttemptId}→${r.attemptId}` : `${r.attemptId} (root)`;
  const costPart = r.cost !== null ? ` $${r.cost.toFixed(3)}` : "";
  return (
    `r${r.round} ${r.kind} [${lineageRef} L${r.lineage}] ${evalPart} → ${r.decision}${costPart} — ${r.reason}`
  );
}

/** True when the ledger file exists on disk (a fast presence check for surfacing). */
export function attemptLedgerExists(file: string): boolean {
  return fs.existsSync(file);
}
