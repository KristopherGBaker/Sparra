/**
 * `conductors/http/decisions.ts` — the holdout-safe `pendingDecisions` projection for a conduct job.
 *
 * A `sparra conduct` run parks a judgment point by writing `<runDir>/decisions/<seq>.request.json`
 * and resolves it when `<seq>.decision.json` appears (U2's file protocol — `src/conduct/decisionEngine.ts`).
 * `GET /jobs/:id` surfaces the still-PARKED requests (a request file with no matching decision file)
 * for a conduct job, projected to a fixed allowlist so no request-file field beyond
 * `{seq, unit, kind, question, options, default, expiresAt}` ever crosses the bridge — every field is
 * `ParentSummary`-derived by U2's construction, so the holdout wall holds. This is a READ-ONLY
 * projection of the decisions dir only; it never reads any other run artifact.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { decisionsDir } from "../../src/conduct/decisionEngine.ts";
import { resolveWithinAllowlist } from "./paths.ts";

/** The exact, allowlisted fields a parked decision exposes over HTTP. Nothing else crosses. */
export interface PendingDecision {
  seq: number;
  unit: string;
  kind: string;
  question: string;
  options: string[];
  default: string;
  expiresAt: string;
}

const REQUEST_RE = /^(\d+)\.request\.json$/;
const DECISION_RE = /^(\d+)\.decision\.json$/;

/** Coerce an unknown to a plain string, or `""` — never passes a non-string through. */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Project a parsed request document down to EXACTLY {@link PendingDecision} — an allowlist COPY (never
 *  a spread), so a planted extra field in the request file can't ride along. */
function projectRequest(seq: number, doc: Record<string, unknown>): PendingDecision {
  const options = Array.isArray(doc.options) ? doc.options.filter((o): o is string => typeof o === "string") : [];
  return {
    seq,
    unit: str(doc.unit),
    kind: str(doc.kind),
    question: str(doc.question),
    options,
    default: str(doc.default),
    expiresAt: str(doc.expiresAt),
  };
}

/**
 * Read the run's `decisions/` dir and project the still-PARKED requests (a `<seq>.request.json` with
 * no matching `<seq>.decision.json`) to {@link PendingDecision}s, sorted by `seq`. A missing dir, an
 * unparseable request file, or a non-conduct job all yield `[]` — never a throw, never a raw field.
 *
 * `runDir` is re-asserted through the realpath guard ({@link resolveWithinAllowlist}) BEFORE any read,
 * so a stored run dir that resolves outside the allowlist (e.g. via a symlink) surfaces NO decisions
 * rather than being followed out of root.
 */
export function readPendingDecisions(runDir: string, roots: string[]): PendingDecision[] {
  let safeRunDir: string;
  try {
    safeRunDir = resolveWithinAllowlist(runDir, roots);
  } catch {
    return [];
  }
  const dir = decisionsDir(safeRunDir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const answered = new Set<number>();
  const requestSeqs: number[] = [];
  for (const name of entries) {
    const dm = DECISION_RE.exec(name);
    if (dm) {
      answered.add(Number(dm[1]));
      continue;
    }
    const rm = REQUEST_RE.exec(name);
    if (rm) requestSeqs.push(Number(rm[1]));
  }

  const pending: PendingDecision[] = [];
  for (const seq of requestSeqs) {
    if (answered.has(seq)) continue; // already resolved — clear semantics: absent from pending
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(readFileSync(join(dir, `${seq}.request.json`), "utf8")) as Record<string, unknown>;
    } catch {
      continue; // a torn/unparseable request file is skipped, never surfaced raw
    }
    pending.push(projectRequest(seq, doc));
  }
  pending.sort((a, b) => a.seq - b.seq);
  return pending;
}
