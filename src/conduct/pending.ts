import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { decisionsDir } from "./decisionEngine.ts";
import { isDirectRunFile } from "./runState.ts";

/**
 * `src/conduct/pending.ts` — the ONE holdout-safe `pendingDecisions` projection, shared by every
 * surface that reports a conduct run's still-parked judgment points.
 *
 * A `sparra conduct` run parks a decision by writing `<runDir>/decisions/<seq>.request.json` and
 * resolves it when `<seq>.decision.json` appears (the file protocol in `./decisionEngine.ts`). A
 * "pending" decision is a request file with NO matching decision file. This module reads that dir and
 * projects each still-parked request down to a FIXED allowlist ({@link PendingDecision}) — an
 * allowlist COPY (never a spread), so no field beyond `{seq, unit, kind, question, options, default,
 * expiresAt}` can ride along. Every one of those is `ParentSummary`-derived by construction, so the
 * holdout wall holds. Read-only over the decisions dir; it never touches any other run artifact.
 *
 * Both the CLI `conduct --status` path (`src/phases/conduct.ts`) and the HTTP bridge
 * (`conductors/http/decisions.ts`, which wraps this with its realpath allowlist guard) consume THIS
 * projection, so the two surfaces cannot drift.
 */

/** The exact, allowlisted fields a parked decision exposes. Nothing else crosses. */
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
 * Read `runDir`'s `decisions/` dir and project the still-PARKED requests (a `<seq>.request.json` with
 * no matching `<seq>.decision.json`) to {@link PendingDecision}s, sorted by `seq`. A missing dir or an
 * unparseable request file yields `[]`/skips that seq — never a throw, never a raw field. `runDir`
 * MUST already be a trusted, path-safe directory (the CLI validates it via `isSafeRunId`; the bridge
 * re-asserts its realpath allowlist guard before calling).
 */
export function projectPendingDecisions(runDir: string): PendingDecision[] {
  const dir = decisionsDir(runDir);
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
    const reqPath = join(dir, `${seq}.request.json`);
    // Symlink-redirect guard: a `<seq>.request.json` (or the `decisions/` dir itself) planted as a
    // SYMLINK to a holdout brief/verdict must NOT be followed — its contents would otherwise be
    // JSON-parsed and projected. Requiring the file to resolve to its expected in-tree location
    // refuses any such redirect (leaf-file OR symlinked `decisions/`) fail-closed; a redirect is skipped.
    if (!isDirectRunFile(runDir, "decisions", `${seq}.request.json`)) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(reqPath, "utf8"));
    } catch {
      continue; // a torn/unparseable request file is skipped, never surfaced raw
    }
    // A well-formed-JSON-but-NOT-an-object request (`null`, an array, a bare number/string) is a
    // torn/hostile file: skip it rather than crash on a field access (`null.unit` throws). Only a
    // plain object can carry the allowlist fields, so anything else is treated like an unparseable file.
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) continue;
    pending.push(projectRequest(seq, doc as Record<string, unknown>));
  }
  pending.sort((a, b) => a.seq - b.seq);
  return pending;
}
