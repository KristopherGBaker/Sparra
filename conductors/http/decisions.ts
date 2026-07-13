/**
 * `conductors/http/decisions.ts` — the bridge's realpath-guarded wrapper over the SHARED
 * `pendingDecisions` projection.
 *
 * A `sparra conduct` run parks a judgment point by writing `<runDir>/decisions/<seq>.request.json`
 * and resolves it when `<seq>.decision.json` appears. `GET /jobs/:id` surfaces the still-PARKED
 * requests for a conduct job. The projection itself (request files minus resolved seqs, allowlist
 * fields, seq-sorted, torn-file tolerant) lives ONCE in `src/conduct/pending.ts`, so this bridge
 * surface and the CLI `conduct --status` surface cannot drift. Here we add ONLY the bridge's extra
 * concern: re-assert the realpath allowlist guard on the stored `runDir` BEFORE any read, so a run
 * dir that resolves outside the allowlist (e.g. via a symlink) surfaces NO decisions rather than
 * being followed out of root.
 */

import { projectPendingDecisions, type PendingDecision } from "../../src/conduct/pending.ts";
import { resolveWithinAllowlist } from "./paths.ts";

export type { PendingDecision };

/**
 * Read the run's still-PARKED decisions for the bridge. `runDir` is re-asserted through the realpath
 * guard ({@link resolveWithinAllowlist}) BEFORE the shared {@link projectPendingDecisions} reads it —
 * a stored run dir that escapes the allowlist yields `[]` rather than being followed out of root.
 */
export function readPendingDecisions(runDir: string, roots: string[]): PendingDecision[] {
  let safeRunDir: string;
  try {
    safeRunDir = resolveWithinAllowlist(runDir, roots);
  } catch {
    return [];
  }
  return projectPendingDecisions(safeRunDir);
}
