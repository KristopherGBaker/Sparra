import type { ParentSummary } from "../../conductors/core/index.ts";
import type { RoleConfig } from "../config.ts";
import type { RunResult, RunSessionParams } from "../sdk/session.ts";
import { extractJson } from "../util/extract.ts";
import type { BrainDecision, DecisionRequest } from "./decision.ts";

/**
 * `src/conduct/brain.ts` — the LLM CONDUCTOR brain for `sparra conduct`.
 *
 * The brain replicates an experienced human conducting /sparra-loop: at a judgment point (hybrid
 * mode) it picks one offered option; in `llm` mode it drives turn-by-turn by choosing the next
 * action. It runs IN-PROCESS via an injectable `runSessionFn` (real {@link runSession} in
 * production, a scripted fake in tests) and answers with STRICT JSON, re-asking ONCE on malformed
 * output (the `build.jsonReask` pattern) before giving up (→ the caller's deterministic fallback).
 *
 * HOLDOUT WALL: the brain sees ONLY holdout-safe material — the `DecisionRequest`/`DriveContext`
 * this module builds carry `ParentSummary`-derived scalars, the brief/contract it authored, and run
 * state. It never receives holdout text, an evaluator trace, or a raw verdict.
 */

/** The set of llm-drive actions the brain may choose from turn-to-turn. */
export const DRIVE_ACTIONS = [
  "run",
  "revise",
  "pivot",
  "escalate",
  "finalize",
  "accept",
  "abandon",
  "surface",
] as const;
export type DriveAction = (typeof DRIVE_ACTIONS)[number];

/** A holdout-safe snapshot of the run the brain reasons over in llm-drive mode. */
export interface DriveContext {
  unit: string;
  round: number;
  maxRounds: number;
  contractAgreed: boolean;
  /** The latest evaluator summary (holdout-safe), if any round has run. */
  last?: ParentSummary;
}

export interface BrainDeps {
  runSessionFn: (p: RunSessionParams) => Promise<RunResult>;
  role: RoleConfig;
  systemPrompt: string;
  /** A holdout-free cwd for the read-only brain session (e.g. the run dir). */
  cwd: string;
  traceDir: string;
  /** Re-ask once on malformed JSON (mirrors `build.jsonReask`). */
  jsonReask: boolean;
  env?: Record<string, string>;
  /** Test seam: every prompt the brain sends is passed here (holdout-safety assertions). */
  onPrompt?: (prompt: string) => void;
}

const ANSWER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: {
    answer: { type: "string" },
    rationale: { type: "string" },
    feedback: { type: "string" },
  },
};

/** The conductor brain: `judge` a judgment point, or `drive` the next llm turn. */
export interface Brain {
  judge(req: DecisionRequest): Promise<BrainDecision | undefined>;
  drive(ctx: DriveContext): Promise<BrainDecision | undefined>;
}

/** Build a brain over an injectable `runSessionFn`. */
export function makeBrain(deps: BrainDeps): Brain {
  let seq = 0;

  /** Run one strict-JSON ask, re-asking ONCE (same session) on malformed output. */
  async function ask(prompt: string, valid: (a: string) => boolean): Promise<BrainDecision | undefined> {
    deps.onPrompt?.(prompt);
    const first = await session(prompt);
    let parsed = parse(first);
    if ((!parsed || !valid(parsed.answer)) && deps.jsonReask && !first.limitHit) {
      const reaskPrompt =
        "Your previous reply was not valid JSON matching the required shape. Re-emit ONLY a single " +
        'fenced json block: { "answer": "<one offered option>", "rationale": "<one sentence>" }.';
      deps.onPrompt?.(reaskPrompt);
      const second = await session(reaskPrompt, first.sessionId);
      parsed = parse(second);
    }
    if (!parsed || !valid(parsed.answer)) return undefined;
    return parsed;
  }

  function session(prompt: string, resume?: string): Promise<RunResult> {
    seq += 1;
    return deps.runSessionFn({
      role: "conductor",
      prompt,
      systemPrompt: deps.systemPrompt,
      backend: deps.role.backend,
      model: deps.role.model,
      effort: deps.role.effort,
      cwd: deps.cwd,
      tools: [],
      readOnly: true,
      outputSchema: ANSWER_SCHEMA,
      ...(deps.env ? { env: deps.env } : {}),
      ...(resume ? { resume } : {}),
      traceDir: deps.traceDir,
      traceSeq: seq,
    });
  }

  return {
    async judge(req: DecisionRequest): Promise<BrainDecision | undefined> {
      return ask(buildJudgePrompt(req), (a) => req.options.includes(a));
    },
    async drive(ctx: DriveContext): Promise<BrainDecision | undefined> {
      const d = await ask(buildDrivePrompt(ctx), (a) => (DRIVE_ACTIONS as readonly string[]).includes(a));
      return d;
    },
  };
}

/** Parse the brain's structured or fenced-JSON reply into a {@link BrainDecision}. */
function parse(res: RunResult): BrainDecision | undefined {
  const raw =
    (res.structured as BrainDecision | undefined) ?? extractJson<BrainDecision>(res.resultText) ?? undefined;
  if (!raw || typeof raw.answer !== "string") return undefined;
  const out: BrainDecision = { answer: raw.answer };
  if (typeof raw.rationale === "string") out.rationale = raw.rationale;
  if (typeof raw.feedback === "string") out.feedback = raw.feedback;
  return out;
}

/** A holdout-safe prompt for a judgment point. */
export function buildJudgePrompt(req: DecisionRequest): string {
  const ctxLines = req.context
    ? Object.entries(req.context).map(([k, v]) => `- ${k}: ${String(v)}`)
    : [];
  return [
    `Judgment point [${req.kind}] on unit ${req.unit}.`,
    req.question,
    `Options (pick exactly one): ${req.options.join(", ")}.`,
    ...(ctxLines.length > 0 ? ["Signals:", ...ctxLines] : []),
    `Answer JSON: { "answer": "<option>", "rationale": "<one sentence>" }.`,
  ].join("\n");
}

/** A holdout-safe prompt for an llm-drive turn. */
export function buildDrivePrompt(ctx: DriveContext): string {
  const lines = [
    `Drive unit ${ctx.unit}. Round ${ctx.round} of ${ctx.maxRounds}. Contract agreed: ${ctx.contractAgreed}.`,
  ];
  if (ctx.last) {
    if (ctx.last.verdict !== undefined) lines.push(`Last verdict: ${ctx.last.verdict}.`);
    if (ctx.last.weightedTotal !== undefined) lines.push(`Last score: ${ctx.last.weightedTotal}.`);
    if (ctx.last.blocking && ctx.last.blocking.length > 0) {
      lines.push(`Open blocking: ${ctx.last.blocking.join("; ")}.`);
    }
  }
  lines.push(`Choose the NEXT action: ${DRIVE_ACTIONS.join(", ")}.`);
  lines.push(`Answer JSON: { "answer": "<action>", "feedback": "<one line, only for revise>" }.`);
  return lines.join("\n");
}
