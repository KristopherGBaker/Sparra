import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";
import { mapBounded } from "../../conductors/core/bounded.ts";
import { defaultConfig, type EnvBlockJudgeConfig } from "../config.ts";
import { warn } from "../util/log.ts";
import { assertionKey, assertionKeySet } from "./assertionId.ts";
import type { AssertionId, EnvBlockAnnotation, EnvBlockError, EnvBlockFlag, Verdict } from "./types.ts";

/**
 * Opt-in TypeSafe Jev annotation of FAILED assertions that likely could not EXECUTE in the grader's
 * environment (EPERM, read-only FS, no simulator, a missing tool) — the "couldn't run vs ran-and-failed"
 * split. An evaluator that files such a check under "Failed assertions" instead of `unrunAssertionIds`
 * advances the GAN/assertion pivot streaks toward discarding correct work.
 *
 * The annotation is INFORMATIONAL: it never changes `verdict`, `pass`, scores or `unrunAssertionIds`.
 * Its only behavioral effect is downstream — `pivot.ts` freezes streaks for `auto`-band ids and the
 * conductor is told about them. Fail-open everywhere: nothing here throws out of the evaluator, and
 * ONE `warn` at most is emitted per verdict. Only the holdout-REDACTED `#<id>: <evidence>` string is
 * ever sent (one request per assertion, one state key); the key is passed explicitly, never logged.
 */

/** Evidence is clipped to this many characters before a request is built. */
export const MAX_EVIDENCE_CHARS = 1500;

/** The marker `redactHoldout` leaves in place of a quoted holdout line. */
const HOLDOUT_MARKER = "[redacted: holdout]";

const KINDS = ["environment_blocked", "artifact_defect", "both_blocked_and_defect", "process_or_wording"] as const;

/** The two validated questions — the wording is the offline-experiment wording, verbatim. */
function buildQuestions() {
  return {
    env_only: noul(
      "Does `verdict_item` say only that a check could not execute or be observed in the grader's environment, without reporting any defect in the artifact being graded?",
      {
        true: "The item reports that a check was blocked or could not run in the grader's environment (sandbox denial, EPERM, read-only filesystem, missing tool, no simulator, network, tooling timeout) and claims nothing is wrong with the artifact itself.",
        false: "The item reports a defect, missing behavior, wrong output, or a check that failed because of the artifact's own code, or asks for a change to the artifact — even if it also mentions an environment limitation.",
      },
    ),
    kind: choice("What does `verdict_item` report?", {
      environment_blocked:
        "A check could not execute or be observed in the grader's environment (sandbox, permissions, missing tool or simulator, network, tooling timeout); no artifact defect is claimed.",
      artifact_defect: "The check ran, or the code was inspected, and the artifact is wrong, incomplete, or fails a command because of its own code.",
      both_blocked_and_defect: "It reports an environment limitation AND a separate defect or missing behavior in the artifact.",
      process_or_wording: "A process, contract, or wording complaint with no artifact defect and no environment limitation.",
    }),
  };
}
type EnvBlockQuestions = ReturnType<typeof buildQuestions>;

/** The slice of `TypeSafeClient` the judge uses — small so tests inject a fake. */
export interface EnvBlockClient {
  systemOne(request: { state: { verdict_item: string }; questions: EnvBlockQuestions; model: string }): PromiseLike<unknown>;
}

/** Builds the SDK client. Must not touch the network (the real constructor doesn't). */
export type EnvBlockClientFactory = (init: { apiKey: string; model: string }) => EnvBlockClient;

/** The production factory: the key is passed EXPLICITLY (never via `process.env`); SDK logging off. */
export const defaultEnvBlockClientFactory: EnvBlockClientFactory = ({ apiKey, model }) =>
  new TypeSafeClient({ apiKey, defaultModel: model, logLevel: "off", retry: { maxRetries: 1 } });

/** Injectable clock for the whole-classification timeout, so tests never wait on a real timer. */
export interface EnvBlockTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimer: EnvBlockTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Test seams threaded through `evaluateItem` / `runRole`; production passes nothing. */
export interface EnvBlockDeps {
  clientFactory?: EnvBlockClientFactory;
  timer?: EnvBlockTimer;
}

const isFraction = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

/** Sanitize without warning: the normalized block plus the names of every invalid field. */
function sanitizeConfig(cfg: Partial<EnvBlockJudgeConfig> | null | undefined): { out: EnvBlockJudgeConfig; bad: string[] } {
  const def = defaultConfig().evaluator.envBlockJudge;
  const src = (cfg && typeof cfg === "object" ? cfg : {}) as Record<string, unknown>;
  const bad: string[] = [];
  const out: EnvBlockJudgeConfig = { ...def };
  if (src.enabled !== undefined) {
    if (typeof src.enabled === "boolean") out.enabled = src.enabled;
    else bad.push("enabled");
  }
  for (const k of ["model", "apiKeyEnv"] as const) {
    if (src[k] === undefined) continue;
    if (typeof src[k] === "string" && (src[k] as string).trim() !== "") out[k] = src[k] as string;
    else bad.push(k);
  }
  for (const k of ["autoNoul", "autoConfidence", "suspectNoul"] as const) {
    if (src[k] === undefined) continue;
    if (isFraction(src[k])) out[k] = src[k] as number;
    else bad.push(k);
  }
  if (out.suspectNoul > out.autoNoul) {
    bad.push("suspectNoul (above autoNoul)");
    out.suspectNoul = def.suspectNoul;
    out.autoNoul = def.autoNoul;
  }
  for (const k of ["concurrency", "timeoutMs"] as const) {
    if (src[k] === undefined) continue;
    if (Number.isInteger(src[k]) && (src[k] as number) > 0) out[k] = src[k] as number;
    else bad.push(k);
  }
  return { out, bad };
}

const invalidConfigMessage = (bad: string[]) =>
  `invalid ${bad.join(", ")} — using defaults for ${bad.length === 1 ? "it" : "them"}`;

/**
 * Sanitize a possibly-hand-edited `evaluator.envBlockJudge` block: every bad value falls back to its
 * default and ONE `warn` names them all. Never throws.
 */
export function normalizeEnvBlockJudgeConfig(cfg: Partial<EnvBlockJudgeConfig> | null | undefined): EnvBlockJudgeConfig {
  const { out, bad } = sanitizeConfig(cfg);
  if (bad.length > 0) warn(`evaluator.envBlockJudge: ${invalidConfigMessage(bad)}.`);
  return out;
}

/** A validated Jev answer for one assertion. */
export interface EnvBlockAnswer {
  noul: number;
  choice: string;
  confidence: number;
}

/** Validate an untrusted `systemOne` response; `undefined` when ANY of the three fields is unusable. */
export function parseEnvBlockAnswer(res: unknown): EnvBlockAnswer | undefined {
  const answers = (res as { answers?: Record<string, unknown> } | null | undefined)?.answers;
  if (!answers || typeof answers !== "object") return undefined;
  const score = (answers.env_only as { noul?: unknown } | null | undefined)?.noul;
  const kind = (answers.kind as { choice?: unknown; confidence?: unknown } | null | undefined) ?? undefined;
  if (!isFraction(score)) return undefined;
  if (typeof kind?.choice !== "string" || !(KINDS as readonly string[]).includes(kind.choice)) return undefined;
  if (!isFraction(kind.confidence)) return undefined;
  return { noul: score, choice: kind.choice, confidence: kind.confidence };
}

/** Band for a validated answer: `auto` needs all three thresholds; `suspect` is noul ≥ suspectNoul, not auto. */
export function classifyBand(
  a: EnvBlockAnswer,
  cfg: Pick<EnvBlockJudgeConfig, "autoNoul" | "autoConfidence" | "suspectNoul">,
): "auto" | "suspect" | undefined {
  if (a.noul >= cfg.autoNoul && a.choice === "environment_blocked" && a.confidence >= cfg.autoConfidence) return "auto";
  return a.noul >= cfg.suspectNoul ? "suspect" : undefined;
}

/** Clip to `MAX_EVIDENCE_CHARS` without leaving a lone high surrogate at the cut. */
export function clipEvidence(text: string): string {
  if (text.length <= MAX_EVIDENCE_CHARS) return text;
  let end = MAX_EVIDENCE_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end);
}

/** The ids the judge placed in the `auto` band (empty when there is no annotation). */
export function autoEnvBlockedIds(verdict: Pick<Verdict, "envBlock">): AssertionId[] {
  return (verdict.envBlock?.assertions ?? []).filter((a) => a.band === "auto").map((a) => a.id);
}

/** Same ids as a key set (compare by `assertionKey`). */
export function autoEnvBlockedKeys(verdict: Pick<Verdict, "envBlock">): Set<string> {
  return assertionKeySet(autoEnvBlockedIds(verdict));
}

/** The persisted-verdict markdown section for the annotation ("" when the field is absent, so a
 *  judge-off verdict renders byte-identically). Starts with a blank line; ends without a newline. */
export function renderEnvBlockSection(envBlock: EnvBlockAnnotation | undefined): string {
  if (!envBlock) return "";
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const lines = envBlock.assertions.map((a) => `- #${a.id} (${a.band}, noul ${round2(a.noul)})`);
  return `\n\n## Likely environment-blocked (Jev, informational)\n${lines.join("\n") || "_none_"}`;
}

/** Failure precedence when several kinds occur in one verdict — independent of completion order. */
const ERROR_PRECEDENCE: readonly EnvBlockError[] = ["timeout", "request-failed", "invalid-response"];

type Outcome = { answer: EnvBlockAnswer } | { error: EnvBlockError };

/**
 * Classify the FAILED, RUNNABLE assertions of an already-redacted verdict. Resolves to the annotation
 * to attach as `verdict.envBlock`, or `undefined` when the judge is off, has no key, or had nothing to
 * ask (a passing/blocked verdict, no failed runnable assertion). Never throws and never mutates `verdict`.
 */
export async function annotateEnvBlock(
  verdict: Verdict,
  cfgIn: Partial<EnvBlockJudgeConfig> | null | undefined,
  deps: EnvBlockDeps = {},
): Promise<EnvBlockAnnotation | undefined> {
  const rawEnabled = (cfgIn as { enabled?: unknown } | null | undefined)?.enabled;
  if (rawEnabled !== true) {
    // A non-boolean `enabled` normalizes to the default (off) — say so once; false/absent stays silent.
    if (rawEnabled !== undefined && rawEnabled !== false) {
      warn(`evaluator.envBlockJudge: ${invalidConfigMessage(sanitizeConfig(cfgIn).bad)}.`);
    }
    return undefined;
  }
  // At most ONE warn per verdict: every cause (config, key, request failures) is collected here.
  const notes: string[] = [];
  try {
    return await classify(verdict, cfgIn, deps, notes);
  } catch {
    // Belt and braces: `classify` handles every expected failure itself.
    notes.push("classification failed unexpectedly — the verdict is unaffected");
    return undefined;
  } finally {
    if (notes.length > 0) warn(`evaluator.envBlockJudge: ${notes.join("; ")}.`);
  }
}

async function classify(
  verdict: Verdict,
  cfgIn: Partial<EnvBlockJudgeConfig> | null | undefined,
  deps: EnvBlockDeps,
  notes: string[],
): Promise<EnvBlockAnnotation | undefined> {
  const { out: cfg, bad } = sanitizeConfig(cfgIn);
  if (bad.length > 0) notes.push(invalidConfigMessage(bad));
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) {
    notes.push(`enabled but $${cfg.apiKeyEnv} is unset or empty — environment-block annotation skipped`);
    return undefined;
  }
  if (verdict.verdict === "pass" || verdict.exerciseStatus === "blocked") return undefined;
  const unrun = assertionKeySet(verdict.unrunAssertionIds);
  const failed = verdict.assertions.filter((a) => !a.pass && !unrun.has(assertionKey(a.id)));
  if (failed.length === 0) return undefined;
  const toSend = failed.filter((a) => !a.evidence.includes(HOLDOUT_MARKER));
  if (toSend.length === 0) return { model: cfg.model, assertions: [] };

  let client: EnvBlockClient;
  try {
    client = (deps.clientFactory ?? defaultEnvBlockClientFactory)({ apiKey, model: cfg.model });
  } catch {
    notes.push("classification incomplete (request-failed) — the verdict is unaffected");
    return { model: cfg.model, assertions: [], error: "request-failed" };
  }

  const questions = buildQuestions();
  const outcomes: (Outcome | undefined)[] = toSend.map(() => undefined);
  let expired = false;
  const work = mapBounded(
    toSend,
    async (a, i) => {
      if (expired) return;
      try {
        const res = await client.systemOne({
          state: { verdict_item: `#${a.id}: ${clipEvidence(a.evidence)}` },
          questions,
          model: cfg.model,
        });
        const answer = parseEnvBlockAnswer(res);
        outcomes[i] = answer ? { answer } : { error: "invalid-response" };
      } catch {
        outcomes[i] = { error: "request-failed" };
      }
    },
    { concurrency: cfg.concurrency },
  );

  // ONE budget for the whole classification: whatever finished by then keeps its result.
  const timer = deps.timer ?? realTimer;
  let handle: unknown;
  const timedOut = new Promise<"timeout">((resolve) => {
    handle = timer.set(() => resolve("timeout"), cfg.timeoutMs);
  });
  let timeout = false;
  try {
    timeout = (await Promise.race([work.then(() => "done" as const), timedOut])) === "timeout";
    if (timeout) {
      // Let requests that had already settled record their outcome before the snapshot.
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
  } finally {
    expired = true;
    timer.clear(handle);
  }

  const flags: EnvBlockFlag[] = [];
  const errors = new Set<EnvBlockError>();
  toSend.forEach((a, i) => {
    const o = outcomes[i];
    if (!o) {
      errors.add("timeout");
    } else if ("error" in o) {
      errors.add(o.error);
    } else {
      const band = classifyBand(o.answer, cfg);
      if (band) flags.push({ id: a.id, noul: o.answer.noul, choice: o.answer.choice, confidence: o.answer.confidence, band });
    }
  });
  const error = ERROR_PRECEDENCE.find((e) => errors.has(e));
  if (error) notes.push(`classification incomplete (${error}) — the verdict is unaffected`);
  return { model: cfg.model, assertions: flags, ...(error ? { error } : {}) };
}
