import type { RoleKind, RoleRunResult } from "./build/roleRun.ts";

/** The line-anchored marker a `contract-evaluator` emits in its critique to signal the contract is
 *  agreed. Single source of truth: the build-loop negotiator and the envelope builder both use it,
 *  so a conductor reads the structured {@link RunRolePayload.contractAgreed} boolean instead of
 *  re-parsing prose. */
export const CONTRACT_AGREED_MARKER = "CONTRACT: AGREED";

/**
 * The caveated form. A contract judge that accepts the contract *provided* specific build-time
 * requirements are met is AGREEING — it is not asking for another revision. Before this existed the
 * runner matched only the bare marker, so a critique ending `CONTRACT: AGREED WITH CAVEATS` (with
 * two precisely specified requirements) was reported as `contractAgreed: false`, and a conductor
 * keying off that flag re-opened negotiation on a contract the evaluator had already accepted.
 */
export const CONTRACT_AGREED_WITH_CAVEATS_MARKER = "CONTRACT: AGREED WITH CAVEATS";

/** Agreement is three-state: a caveated agreement is neither a plain agreement nor a rejection. */
export type ContractStatus = "agreed" | "agreed-with-caveats" | "rejected";

export interface ContractAgreement {
  status: ContractStatus;
  /** The requirements attached to a caveated agreement, in the judge's own words (list items
   *  following the marker line). Empty for the other two states. They are REQUIREMENTS ON THE BUILD:
   *  dropping them turns "agreed provided X" into a silent "agreed". */
  caveats: string[];
}

/** How many list items after the marker count as caveats, and how long each may be. */
const MAX_CAVEATS = 10;
const MAX_CAVEAT_LEN = 400;

/**
 * Classify a contract judge's critique WITHOUT re-parsing prose at every call site: the build-loop
 * negotiator, the MCP payload and the `--json` CLI all read this one function.
 *
 * Caveats are the list items ({@link MAX_CAVEATS} max) immediately following the marker line — the
 * form the contract-evaluator prompt asks for. Prose after the marker is not mined for requirements:
 * a judge that writes its conditions as a paragraph yields `agreed-with-caveats` with an empty list,
 * which still beats reporting a flat rejection.
 */
export function parseContractAgreement(text: string): ContractAgreement {
  const lines = (text ?? "").split(/\r?\n/);
  const isMarker = (line: string, marker: string) =>
    new RegExp("^[\\s>#*_`-]*" + marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s.!?,;:*_`)\\]]*$", "i").test(line);
  const at = lines.findIndex((l) => isMarker(l, CONTRACT_AGREED_WITH_CAVEATS_MARKER));
  if (at !== -1) {
    const caveats: string[] = [];
    for (const line of lines.slice(at + 1)) {
      const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)\s*$/.exec(line);
      if (item) caveats.push(item[1]!.slice(0, MAX_CAVEAT_LEN));
      else if (line.trim() !== "") break; // a non-list, non-blank line ends the list
      if (caveats.length >= MAX_CAVEATS) break;
    }
    return { status: "agreed-with-caveats", caveats };
  }
  return { status: lines.some((l) => isMarker(l, CONTRACT_AGREED_MARKER)) ? "agreed" : "rejected", caveats: [] };
}

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
  /** `contract-evaluator` only: where the runner auto-persisted this critique. The loop threads a
   *  prior round's critique into the next by PATH (`priorCritiquePaths`), so a conductor can pass
   *  this straight back without having asked for `out`. Holdout-safe (a path). */
  critiquePath?: string;
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
  /** F1 telemetry: how many `.sparra` references in the conductor-authored brief were neutralized to
   *  the inlined-contract marker on a worktree remap (fenced/inline code spans are exempt, so a QUOTED
   *  `.sparra` reference is preserved and NOT counted). Present (>0) only when a substitution
   *  occurred; absent for an in-place run or a brief with no `.sparra` prose. Holdout-safe (a count). */
  remapCount?: number;
  /** `contract-evaluator` role only: true when the judge AGREED — including a caveated agreement,
   *  which is agreement with requirements attached, not a rejection. False when it did not agree;
   *  absent for every other role. Lets a conductor detect agreement from a structured field instead
   *  of the holdout-dropped `resultText`. Read {@link contractStatus} to tell the two agreement
   *  forms apart, and {@link caveats} for what was attached. */
  contractAgreed?: boolean;
  /** `contract-evaluator` role only: the three-state form of {@link contractAgreed}, so "agreed,
   *  with these requirements" is representable without parsing prose. */
  contractStatus?: ContractStatus;
  /** `contract-evaluator` role only: the requirements attached to a caveated agreement. These bind
   *  the BUILD — a conductor that proceeds must carry them into the contract, not drop them. */
  caveats?: string[];
  /** The guard refused one or more of the role's READ attempts, so its artifact was produced without
   *  an input it went looking for. A conductor should treat this as "check inputs/permissions"
   *  BEFORE reading the artifact as a considered answer — a denied role reconstructs and emits
   *  something plausible rather than stopping. Absent when nothing was refused. */
  degraded?: RoleRunResult["degraded"];
  /** The refused reads behind `degraded` — tool + target PATH only, never file content. */
  deniedInputs?: RoleRunResult["deniedInputs"];
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
