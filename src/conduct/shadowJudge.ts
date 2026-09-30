import { TypeSafeClient, choice } from "@typesafe-ai/sdk";
import type { ShadowJudgeConfig } from "../config.ts";
import { defaultConfig } from "../config.ts";
import { warn } from "../util/log.ts";
import type { DecisionRequest, JudgmentKind } from "./decision.ts";
import type { DecisionEngineDeps } from "./decisionEngine.ts";

/**
 * `src/conduct/shadowJudge.ts` — SHADOW-MODE TypeSafe Jev judgment on `sparra conduct` decisions.
 *
 * A {@link DecisionRequest} is exactly the shape of a Jev Choice question (a question, a closed option
 * list, scalar context). At every judgment point the engine also asks Jev and RECORDS its choice,
 * probabilities and confidence beside the real resolution (`DecisionRecord.shadow`), so a later,
 * confidence-gated integration can be calibrated. Jev never decides anything here: a shadow error,
 * timeout, invalid response or missing key is recorded (or skipped) and NEVER changes or fails a
 * decision. Only the holdout-safe request fields — kind, question, scalar context — are sent.
 */

/** A validated Jev Choice answer. */
export interface ShadowVerdict {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

/** The slice of `TypeSafeClient` the shadow judge uses — small so tests inject a fake. */
export interface ShadowClient {
  systemOne(request: {
    state: { kind: string; question: string; context: NonNullable<DecisionRequest["context"]> };
    questions: { decision: ReturnType<typeof choice> };
    model: string;
  }): PromiseLike<unknown>;
}

/** Builds the SDK client. Must not touch the network (the real constructor doesn't). */
export type ShadowClientFactory = (init: { apiKey: string; model: string }) => ShadowClient;

/** The production factory: the key is passed EXPLICITLY (never via `process.env`); SDK logging off. */
export const defaultShadowClientFactory: ShadowClientFactory = ({ apiKey, model }) =>
  new TypeSafeClient({ apiKey, defaultModel: model, logLevel: "off", retry: { maxRetries: 1 } });

/** A response failed validation (untrusted external data). Messages never carry response content. */
export class ShadowResponseError extends Error {
  constructor(reason: string) {
    super(`invalid Jev response: ${reason}`);
    this.name = "ShadowResponseError";
  }
}

/** One-sentence description per option of every judgment kind (the Choice criteria). A test pins that
 *  this covers every option in `JUDGMENT_OPTIONS`, so a new option can't silently lack a description. */
export const SHADOW_OPTION_DESCRIPTIONS: Record<JudgmentKind, Record<string, string>> = {
  "contract-nonconvergence": {
    "finalize": "Accept the contract as it currently stands and build against it.",
    "revise-brief": "Send the unit back to have its brief revised before negotiating the contract again.",
    "abandon": "Stop working on this unit.",
  },
  "unit-exhausted": {
    "pivot": "Try a different approach to the unit, guided by the failures so far.",
    "generalize-spec": "Rewrite the brief in more general terms so the generator stops overfitting to specific evaluator findings.",
    "abandon": "Stop working on this unit.",
  },
  "contract-defect": {
    "strike-assertion": "Deactivate the one persistently failing assertion as a contract defect and re-evaluate the existing artifact.",
    "pivot": "Treat the failure as real and fall through to the ordinary exhausted outcome.",
    "abandon": "Stop working on this unit.",
  },
  "gate-collapse": {
    "abandon": "Stop working on this unit because no distinct grader is available.",
    "accept-anyway": "Accept the unit even though the cross-model gate had no distinct grader.",
    "retry": "Retry the evaluation in the hope of getting a distinct grader.",
  },
  "recovery": {
    "wait": "Wait for the provider limit or budget to recover, then continue.",
    "fallback": "Switch to a fallback model or backend and continue.",
    "abandon": "Stop working on this unit.",
  },
  "borderline-accept": {
    "accept": "Accept the borderline passing result as it is.",
    "revise": "Run one more revision round to strengthen the borderline result.",
    "abandon": "Stop working on this unit.",
  },
  "merge-blocked": {
    "skip-unit": "Skip merging only this unit and keep its worktree for a human to merge by hand.",
    "abort-merge": "Stop merging this unit and every remaining accepted unit in the run.",
  },
  "land-blocked": {
    "skip-land": "Acknowledge the blocked landing and leave the default branch untouched for a human to land.",
  },
};

const CHOICE_INSTRUCTIONS = "Given `context`, which option should the conductor choose for `question`?";

/** The Choice question for a request: criteria keys are EXACTLY `req.options`. */
function buildQuestion(req: DecisionRequest): ReturnType<typeof choice> {
  const table = SHADOW_OPTION_DESCRIPTIONS[req.kind] ?? {};
  const criteria: Record<string, string> = {};
  for (const o of req.options) criteria[o] = table[o] ?? o;
  return choice(CHOICE_INSTRUCTIONS, criteria);
}

const isFraction = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

/** Validate an untrusted `systemOne` response into a {@link ShadowVerdict}; throws `ShadowResponseError`. */
export function parseShadowVerdict(options: readonly string[], res: unknown): ShadowVerdict {
  return validateShadowAnswer(options, (res as { answers?: { decision?: unknown } } | null | undefined)?.answers?.decision);
}

/** Validate one untrusted Choice answer against the request's options (also applied by the engine to
 *  whatever an injected judge returns); throws `ShadowResponseError`. */
export function validateShadowAnswer(options: readonly string[], raw: unknown): ShadowVerdict {
  const answer = raw as { choice?: unknown; probabilities?: unknown; confidence?: unknown } | null | undefined;
  if (!answer || typeof answer !== "object") throw new ShadowResponseError("missing answer");
  const picked = answer.choice;
  if (typeof picked !== "string" || !options.includes(picked)) throw new ShadowResponseError("choice missing or not an option");
  const probs = answer.probabilities;
  if (!probs || typeof probs !== "object" || Array.isArray(probs)) throw new ShadowResponseError("probabilities missing");
  const keys = Object.keys(probs);
  if (keys.length !== options.length || !options.every((o) => Object.hasOwn(probs, o))) {
    throw new ShadowResponseError("probabilities do not match the options");
  }
  const probabilities: Record<string, number> = {};
  for (const o of options) {
    const p = (probs as Record<string, unknown>)[o];
    if (!isFraction(p)) throw new ShadowResponseError("probability outside [0, 1]");
    probabilities[o] = p;
  }
  if (!isFraction(answer.confidence)) throw new ShadowResponseError("confidence missing or outside [0, 1]");
  return { choice: picked, probabilities, confidence: answer.confidence };
}

/** The per-run shadow judge: the ask, plus what the engine needs to bound and report it. */
export interface ShadowJudge {
  model: string;
  /** How long the engine waits for the shadow AFTER the real resolution. */
  timeoutMs: number;
  /** Ask Jev about one request. Rejects on any failure (`ShadowResponseError` = invalid response). */
  judge(req: DecisionRequest): Promise<ShadowVerdict>;
  /** Report a failed shadow — warns at most ONCE per run. */
  noteFailure(error: string): void;
}

/** The engine seams for a shadow judge (empty when there is none — nothing is passed, nothing changes). */
export function shadowEngineDeps(
  shadow: ShadowJudge | undefined,
): Pick<DecisionEngineDeps, "shadowJudge" | "shadowModel" | "shadowTimeoutMs" | "onShadowError"> {
  if (!shadow) return {};
  return {
    shadowJudge: (req) => shadow.judge(req),
    shadowModel: shadow.model,
    shadowTimeoutMs: shadow.timeoutMs,
    onShadowError: (error) => shadow.noteFailure(error),
  };
}

/** Sanitize a possibly-hand-edited `conduct.shadowJudge` block: bad values → defaults, ONE `warn`. */
export function normalizeShadowJudgeConfig(cfg: Partial<ShadowJudgeConfig> | null | undefined): ShadowJudgeConfig {
  const def = defaultConfig().conduct.shadowJudge;
  const src = (cfg && typeof cfg === "object" ? cfg : {}) as Record<string, unknown>;
  const bad: string[] = [];
  const out: ShadowJudgeConfig = { ...def, enabled: src.enabled === true };
  for (const k of ["model", "apiKeyEnv"] as const) {
    if (src[k] === undefined) continue;
    if (typeof src[k] === "string" && (src[k] as string).trim() !== "") out[k] = src[k] as string;
    else bad.push(k);
  }
  if (src.timeoutMs !== undefined) {
    if (Number.isInteger(src.timeoutMs) && (src.timeoutMs as number) > 0) out.timeoutMs = src.timeoutMs as number;
    else bad.push("timeoutMs");
  }
  if (bad.length > 0) warn(`conduct.shadowJudge: invalid ${bad.join(", ")} — using defaults for ${bad.length === 1 ? "it" : "them"}.`);
  return out;
}

/**
 * Build the run's shadow judge from config, or `undefined` when disabled or the key env var is
 * unset/empty (ONE `warn` naming the variable, never a value). The key is read from
 * `process.env[apiKeyEnv]`, handed explicitly to the factory, and never logged or persisted; no client
 * is constructed without a key, and construction makes no network call.
 */
export function createShadowJudge(
  cfg: Partial<ShadowJudgeConfig> | null | undefined,
  factory: ShadowClientFactory = defaultShadowClientFactory,
): ShadowJudge | undefined {
  if ((cfg as { enabled?: unknown } | null | undefined)?.enabled !== true) return undefined;
  const { model, apiKeyEnv, timeoutMs } = normalizeShadowJudgeConfig(cfg);
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    warn(`conduct.shadowJudge: enabled but $${apiKeyEnv} is unset or empty — shadow judgment skipped for this run.`);
    return undefined;
  }
  const client = factory({ apiKey, model });
  let warned = false;
  return {
    model,
    timeoutMs,
    async judge(req) {
      const res = await client.systemOne({
        state: { kind: req.kind, question: req.question, context: req.context ?? {} },
        questions: { decision: buildQuestion(req) },
        model,
      });
      return parseShadowVerdict(req.options, res);
    },
    noteFailure(error) {
      if (warned) return;
      warned = true;
      warn(`conduct.shadowJudge: a shadow judgment failed (${error}) — recorded in run.json; decisions are unaffected.`);
    },
  };
}
