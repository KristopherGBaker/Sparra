import type { ParentSummary, RunRoleSpec } from "../../conductors/core/index.ts";
import type { RoleConfig } from "../config.ts";

/**
 * `src/conduct/recovery.ts` — the DETERMINISTIC recovery map for `sparra conduct`.
 *
 * A role-run may finish on a provider limit, our own budget/turn cap, or a silent empty completion.
 * None of these is a QUALITY failure — turning them into behavioral FAIL feedback would pollute
 * calibration. Instead they map to a recovery ACTION that reshapes the NEXT role-run:
 *   limitHit                     → switch to the role's configured fallback identity (or, with no
 *                                  fallback, ESCALATE to a human/brain — an ambiguous recovery).
 *   hitBudget / hitMaxTurns      → resume the SAME session with STRICTLY-RAISED caps.
 *   emptyCompletion + files>0    → do not regenerate; proceed straight to evaluate.
 * Deterministic first; the ambiguous case is the one the decision engine/brain resolves.
 */

export type RecoveryAction =
  | { kind: "fallback"; role: RoleConfig }
  | { kind: "resume"; sessionId: string; backend?: string; budget?: number; maxTurns?: number }
  | { kind: "evaluate" }
  | { kind: "ambiguous" }
  | { kind: "none" };

/** The caps the exhausted attempt ran under (from the conduct options / argv). */
export interface RecoveryCaps {
  role?: RoleConfig;
  budget?: number;
  maxTurns?: number;
}

/**
 * Classify what to do after a role summary. PURE. `limitHit` with a configured fallback → switch
 * identity; without one → ambiguous. `hitBudget`/`hitMaxTurns` → resume with raised caps.
 * `emptyCompletion` with files on disk → evaluate (never regenerate). Otherwise no recovery.
 */
export function classifyRecovery(summary: ParentSummary, caps: RecoveryCaps = {}): RecoveryAction {
  if (summary.limitHit) {
    if (caps.role?.fallback) return { kind: "fallback", role: caps.role.fallback };
    return { kind: "ambiguous" };
  }
  if (summary.hitBudget || summary.hitMaxTurns) {
    const raised: RecoveryAction = {
      kind: "resume",
      sessionId: summary.sessionId ?? "",
      ...(caps.role?.backend ? { backend: caps.role.backend } : {}),
    };
    // STRICTLY raise each present, finite, positive cap (0 = unlimited stays unlimited).
    if (caps.budget !== undefined && caps.budget > 0) raised.budget = caps.budget * 2;
    if (caps.maxTurns !== undefined && caps.maxTurns > 0) raised.maxTurns = caps.maxTurns * 2;
    return raised;
  }
  if (summary.emptyCompletion && (summary.filesChanged ?? 0) > 0) {
    return { kind: "evaluate" };
  }
  return { kind: "none" };
}

/** Replace (or append) an argv flag's value, returning a NEW args array. */
function withFlag(args: string[], flag: string, value: string): string[] {
  const out = [...args];
  const i = out.indexOf(flag);
  if (i >= 0 && i + 1 < out.length) {
    out[i + 1] = value;
  } else {
    // Insert before the trailing `--json` if present, else append.
    const j = out.lastIndexOf("--json");
    if (j >= 0) out.splice(j, 0, flag, value);
    else out.push(flag, value);
  }
  return out;
}

/**
 * Build the NEXT role-run spec that applies `action` to the exhausted attempt's `spec`. `fallback`
 * swaps the identity flags; `resume` appends `--resume-session` (+ `--resume-backend`) and the
 * raised caps. `none`/`evaluate`/`ambiguous` return the spec unchanged (no reshaping).
 */
export function buildRecoverySpec(spec: RunRoleSpec, action: RecoveryAction): RunRoleSpec {
  if (action.kind === "fallback") {
    let args = withFlag(spec.args, "--backend", action.role.backend ?? "claude");
    args = withFlag(args, "--model", action.role.model);
    if (action.role.effort) args = withFlag(args, "--effort", action.role.effort);
    return { ...spec, args };
  }
  if (action.kind === "resume") {
    let args = withFlag(spec.args, "--resume-session", action.sessionId);
    if (action.backend) args = withFlag(args, "--resume-backend", action.backend);
    if (action.budget !== undefined) args = withFlag(args, "--budget", String(action.budget));
    if (action.maxTurns !== undefined) args = withFlag(args, "--max-turns", String(action.maxTurns));
    return { ...spec, args };
  }
  return spec;
}
