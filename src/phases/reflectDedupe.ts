import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";
import { mapBounded } from "../../conductors/core/bounded.ts";
import { defaultConfig, type ReflectDedupeConfig } from "../config.ts";
import { warn } from "../util/log.ts";
import type { InboxFinding } from "./upstreamTriage.ts";

/**
 * Semantic recurrence matching for the upstream reflect inbox, backed by TypeSafe's Jev model.
 * Owns the (opt-in) pair-judge seam plus the pure scoring/selection helpers `routeUpstreamFinding`
 * (`reflect.ts`) uses. Design invariants, all from the offline experiment:
 *   - ONE comparison per request (a many-candidate state inflates every score in the row);
 *   - TWO questions per request (a Noul "same defect?" + a Choice separating same-area-distinct);
 *   - only the top score band auto-merges; the middle band is surfaced for human triage.
 * Fail-open everywhere: nothing here may drop a finding or throw out of routing.
 */

export type Relation = "same_defect" | "same_area_distinct_defect" | "unrelated";
const RELATIONS: readonly Relation[] = ["same_defect", "same_area_distinct_defect", "unrelated"];

export interface PairVerdict {
  /** Noul probability that the two findings report the same underlying defect (0..1). */
  same: number;
  relation: Relation;
}

/** Judge one (new, live) pair. Rejects on any failure — callers treat a rejection as "no match". */
export type PairJudge = (findingA: string, findingB: string) => Promise<PairVerdict>;

/** The slice of `TypeSafeClient` the judge uses — small so tests inject a fake. */
export interface JevClient {
  systemOne(request: { state: { finding_a: string; finding_b: string }; questions: JevQuestions; model: string }): PromiseLike<unknown>;
}

/** Builds the SDK client. Must not touch the network (the real constructor doesn't). */
export type JevClientFactory = (init: { apiKey: string; model: string }) => JevClient;

/** Each finding is clipped to this many characters (title + body) before a request is built. */
export const MAX_FINDING_CHARS = 1200;

const NOUL_INSTRUCTIONS =
  "Do `finding_a` and `finding_b` report the same underlying harness defect (the same root cause, even if worded differently or seen in a different run)?";
const CHOICE_INSTRUCTIONS = "How are `finding_a` and `finding_b` related?";

function buildQuestions() {
  return {
    same: noul(NOUL_INSTRUCTIONS, {
      true: "Both describe the same broken behavior or root cause; fixing one would fix the other.",
      false: "They describe different problems, even if they touch the same component, role, sandbox, or file.",
    }),
    relation: choice(CHOICE_INSTRUCTIONS, {
      same_defect: "The same bug or gap, reported twice; one fix resolves both.",
      same_area_distinct_defect:
        "They touch the same component, role, sandbox, or budget, but are separate problems needing separate fixes.",
      unrelated: "Different components and different problems.",
    }),
  };
}
type JevQuestions = ReturnType<typeof buildQuestions>;

/** A response failed validation (untrusted external data). Messages never carry response content. */
export class JudgeResponseError extends Error {
  constructor(reason: string) {
    super(`invalid Jev response: ${reason}`);
    this.name = "JudgeResponseError";
  }
}

/**
 * Text sent to the judge: sparra bookkeeping lines (recurrence counters, earlier suggestions) dropped,
 * then clipped to `MAX_FINDING_CHARS` without splitting a surrogate pair.
 */
export function clipFinding(text: string): string {
  const cleaned = text
    .split("\n")
    .filter((l) => !/^<!-- sparra-/.test(l) && !/^POSSIBLE-RECURRENCE-OF:/.test(l))
    .join("\n")
    .trim();
  if (cleaned.length <= MAX_FINDING_CHARS) return cleaned;
  let end = MAX_FINDING_CHARS;
  const last = cleaned.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--; // don't end on a lone high surrogate
  return cleaned.slice(0, end);
}

/** Validate an untrusted `systemOne` response into a `PairVerdict`; throws `JudgeResponseError`. */
function parseVerdict(res: unknown): PairVerdict {
  const answers = (res as { answers?: Record<string, unknown> } | null | undefined)?.answers;
  if (!answers || typeof answers !== "object") throw new JudgeResponseError("missing answers");
  const same = (answers.same as { noul?: unknown } | null | undefined)?.noul;
  if (typeof same !== "number" || !Number.isFinite(same) || same < 0 || same > 1) {
    throw new JudgeResponseError("same score missing or outside [0, 1]");
  }
  const relation = (answers.relation as { choice?: unknown } | null | undefined)?.choice;
  if (typeof relation !== "string" || !RELATIONS.includes(relation as Relation)) {
    throw new JudgeResponseError("relation missing or unknown");
  }
  return { same, relation: relation as Relation };
}

/** The production factory: the key is passed EXPLICITLY (never via `process.env`); SDK logging off. */
export const defaultJevClientFactory: JevClientFactory = ({ apiKey, model }) =>
  new TypeSafeClient({ apiKey, defaultModel: model, logLevel: "off", retry: { maxRetries: 1 } });

/**
 * Build the Jev pair-judge from config, or null when the key env var is unset/empty (dedupe is then
 * unavailable → exact-only routing). The key is read from `process.env[apiKeyEnv]` here and never
 * logged or persisted; no client is constructed without one, and construction makes no network call.
 */
export function createJevJudge(
  cfg: Pick<ReflectDedupeConfig, "model" | "apiKeyEnv">,
  factory: JevClientFactory = defaultJevClientFactory,
): PairJudge | null {
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) return null;
  const client = factory({ apiKey, model: cfg.model });
  return async (findingA, findingB) => {
    const res = await client.systemOne({
      state: { finding_a: clipFinding(findingA), finding_b: clipFinding(findingB) },
      questions: buildQuestions(),
      model: cfg.model,
    });
    return parseVerdict(res);
  };
}

const isFraction = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

/**
 * Sanitize a possibly-hand-edited `reflect.dedupe` block. Every bad value falls back to its default;
 * ONE `warn` names them all. Never throws.
 */
export function normalizeDedupeConfig(cfg: Partial<ReflectDedupeConfig> | null | undefined): ReflectDedupeConfig {
  const def = defaultConfig().reflect.dedupe;
  const src = (cfg && typeof cfg === "object" ? cfg : {}) as Record<string, unknown>;
  const bad: string[] = [];
  const out: ReflectDedupeConfig = { ...def, enabled: src.enabled === true };

  for (const k of ["model", "apiKeyEnv"] as const) {
    if (src[k] === undefined) continue;
    if (typeof src[k] === "string" && (src[k] as string).trim() !== "") out[k] = src[k] as string;
    else bad.push(k);
  }
  for (const k of ["autoThreshold", "suggestThreshold"] as const) {
    if (src[k] === undefined) continue;
    if (isFraction(src[k])) out[k] = src[k] as number;
    else bad.push(k);
  }
  if (out.suggestThreshold > out.autoThreshold) {
    bad.push("suggestThreshold (above autoThreshold)");
    out.suggestThreshold = def.suggestThreshold;
    out.autoThreshold = def.autoThreshold;
  }
  if (src.concurrency !== undefined) {
    if (Number.isInteger(src.concurrency) && (src.concurrency as number) >= 1) out.concurrency = src.concurrency as number;
    else bad.push("concurrency");
  }
  if (src.maxSuggestions !== undefined) {
    if (Number.isInteger(src.maxSuggestions) && (src.maxSuggestions as number) >= 0) out.maxSuggestions = src.maxSuggestions as number;
    else bad.push("maxSuggestions");
  }
  if (bad.length > 0) warn(`reflect.dedupe: invalid ${bad.join(", ")} — using defaults for ${bad.length === 1 ? "it" : "them"}.`);
  return out;
}

/** A live finding that scored ≥ suggestThreshold against a new finding. */
export interface Candidate {
  finding: InboxFinding;
  same: number;
}

/** Per-new-finding outcome: the auto-merge target, or the suggestions to surface. */
export interface DedupeDecision {
  mergeInto: Candidate | null;
  suggestions: Candidate[];
}

/**
 * Pure decision over one new finding's verdicts (`verdicts[i]` is against `live[i]`, null = failed
 * pair). Depends only on scores and live-inbox order — never on completion timing.
 */
export function decide(live: InboxFinding[], verdicts: (PairVerdict | null)[], cfg: ReflectDedupeConfig): DedupeDecision {
  const scored: (Candidate & { order: number; relation: Relation })[] = [];
  verdicts.forEach((v, order) => {
    if (v) scored.push({ finding: live[order]!, same: v.same, relation: v.relation, order });
  });
  const byScore = (a: { same: number; order: number }, b: { same: number; order: number }) => b.same - a.same || a.order - b.order;

  const auto = scored.filter((c) => c.same >= cfg.autoThreshold && c.relation === "same_defect").sort(byScore)[0];
  if (auto) return { mergeInto: { finding: auto.finding, same: auto.same }, suggestions: [] };

  const suggestions = scored
    .filter((c) => c.same >= cfg.suggestThreshold)
    .sort(byScore)
    .slice(0, cfg.maxSuggestions)
    .map((c) => ({ finding: c.finding, same: c.same }));
  return { mergeInto: null, suggestions };
}

/**
 * Judge every new finding against every live finding (bounded concurrency, one request per pair) and
 * decide each. A pair whose judge rejects counts as "no match"; `failures` + the distinct error names
 * let the caller emit ONE summarizing warn.
 */
export async function judgeNewFindings(
  newTexts: string[],
  live: InboxFinding[],
  judge: PairJudge,
  cfg: ReflectDedupeConfig,
): Promise<{ decisions: DedupeDecision[]; failures: number; errorNames: string[] }> {
  const pairs = newTexts.flatMap((_, n) => live.map((_l, l) => ({ n, l })));
  const errorNames = new Set<string>();
  let failures = 0;
  const results = await mapBounded(
    pairs,
    async ({ n, l }) => {
      try {
        return await judge(newTexts[n]!, live[l]!.text);
      } catch (e) {
        failures++;
        errorNames.add(e instanceof Error ? e.name : "non-Error rejection");
        return null;
      }
    },
    { concurrency: cfg.concurrency },
  );
  const decisions = newTexts.map((_, n) => decide(live, results.slice(n * live.length, (n + 1) * live.length), cfg));
  return { decisions, failures, errorNames: [...errorNames] };
}

/** Insert `POSSIBLE-RECURRENCE-OF:` lines directly under a finding's `###` heading (prepended when none). */
export function withSuggestions(segText: string, suggestions: Candidate[]): string {
  if (suggestions.length === 0) return segText;
  const lines = suggestions.map((s) => `POSSIBLE-RECURRENCE-OF: ${s.finding.title} (p=${s.same.toFixed(2)})`).join("\n");
  if (!/^###(?:\s|$)/.test(segText)) return lines + (segText.length > 0 ? "\n" + segText : "");
  const nl = segText.indexOf("\n");
  return nl < 0 ? `${segText}\n${lines}` : `${segText.slice(0, nl + 1)}${lines}\n${segText.slice(nl + 1)}`;
}
