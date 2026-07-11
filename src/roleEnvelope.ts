import type { RoleKind, RoleRunResult } from "./build/roleRun.ts";

/** The line-anchored marker a `contract-evaluator` emits in its critique to signal the contract is
 *  agreed. Single source of truth: the build-loop negotiator and the envelope builder both use it,
 *  so a conductor reads the structured {@link RunRolePayload.contractAgreed} boolean instead of
 *  re-parsing prose. */
export const CONTRACT_AGREED_MARKER = "CONTRACT: AGREED";

/**
 * The canonical, holdout-safe **runner ↔ conductor contract**.
 *
 * This is the single source of truth for the JSON envelope that BOTH surfaces emit:
 *   - the MCP `run_role` tool (`src/mcp/runRoleServer.ts`), and
 *   - the `sparra role run … --json` / `sparra eval … --json` CLI (`src/phases/role.ts`).
 *
 * Any interactive **conductor host** (Claude Code, Codex, Pi, opencode, …) consumes this envelope
 * and nothing else — the raw role transcript, full verdict dump, and evaluator trace never cross
 * this boundary. Conductor cores (`conductors/**`) import these types so their parent-summary
 * projection stays in lockstep with what the runner actually emits.
 *
 * Holdout-bearing / raw fields carried here for NON-evaluator roles only: `resultText`,
 * `resultDigest`, `traceDir`. The evaluator payload omits them (its raw output/trace can quote
 * holdout evidence). A conductor's parent-summary projection MUST drop all three regardless of role.
 */
export interface RunRolePayload {
  roleKind: RoleKind;
  backend: string;
  model: string;
  sessionId?: string;
  ok: boolean;
  verdict?: NonNullable<RoleRunResult["verdict"]>["verdict"] | null;
  weightedTotal?: number;
  passThreshold?: number;
  blocking?: NonNullable<RoleRunResult["verdict"]>["blocking"];
  failedAssertions?: NonNullable<RoleRunResult["verdict"]>["assertions"];
  resultText?: string;
  resultDigest?: string;
  verdictPath?: string;
  outPath?: string;
  traceDir?: string;
  filesChanged?: number;
  sameModelGrade?: boolean;
  fallbackFrom?: RoleRunResult["fallbackFrom"];
  limitHit?: RoleRunResult["limitHit"];
  hitBudget?: boolean;
  hitMaxTurns?: boolean;
  emptyCompletion?: boolean;
  noProgress?: boolean;
  verifyGateWarning?: string;
  /** `contract-evaluator` role only: true when the critique carried {@link CONTRACT_AGREED_MARKER}
   *  (the contract is agreed), false when it did not, absent for every other role. Lets a conductor
   *  detect agreement from a structured field instead of the holdout-dropped `resultText`. */
  contractAgreed?: boolean;
  unitWorktree?: RoleRunResult["unitWorktree"];
  promptDrift?: PromptDriftNote;
  errors: string[];
  tokens: number;
  costUsd: number;
}

/** Holdout-safe prompt-drift note for the MCP payload: role names + the one-line note ONLY (never a
 *  prompt body, never holdout). `null` when there's nothing actionable to surface. */
export interface PromptDriftNote {
  stale: string[];
  conflict: string[];
  note: string;
}
