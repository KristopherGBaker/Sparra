import { readText, writeText } from "./util/io.ts";
import type { Paths } from "./paths.ts";

/**
 * Persistent cross-run memory (.sparra/memory.md): a durable, append-only log of
 * short structured learnings so the autonomous roles don't repeat past mistakes.
 * Repos don't forget. It is capped: when it grows past the limits, the oldest
 * entries collapse into a single summary line so it never grows unbounded.
 */

export type LearningKind = "pivot" | "budget_exceeded" | "passed" | "failed" | "note" | "measure";

export interface Learning {
  /** Work-item id this learning is about (e.g. "item-002"). */
  item: string;
  kind: LearningKind;
  /** One short sentence: what was tried / why it passed or failed. */
  detail: string;
  /** ISO timestamp; optional so callers/tests can stay deterministic. */
  at?: string;
}

export interface MemoryCaps {
  /** Keep at most this many detailed entries; older ones collapse to a summary. */
  maxEntries: number;
  /** Hard cap on the rendered/injected text length. */
  maxChars: number;
}

export const DEFAULT_CAPS: MemoryCaps = { maxEntries: 40, maxChars: 4000 };

const HEADER = `# Sparra memory

Durable cross-run learnings — newest at the bottom. Auto-summarized when over capacity.
The autonomous roles read this at the start of each item so prior failures inform new work.
`;

const SUMMARY_PREFIX = "> older learnings summarized —";
const KINDS: LearningKind[] = ["pivot", "budget_exceeded", "passed", "failed", "note", "measure"];

type Counts = Record<LearningKind, number>;
const emptyCounts = (): Counts => ({ pivot: 0, budget_exceeded: 0, passed: 0, failed: 0, note: 0, measure: 0 });

/** Render a single learning as one compact line. */
export function formatLearning(l: Learning): string {
  const when = l.at ? l.at.slice(0, 10) : ""; // YYYY-MM-DD
  const detail = l.detail.replace(/\s+/g, " ").trim();
  return `- ${when ? `[${when}] ` : ""}${l.item} · ${l.kind.toUpperCase()}: ${detail}`;
}

function kindOf(line: string): LearningKind | null {
  const m = line.match(/·\s+([A-Z_]+):/);
  if (!m) return null;
  const k = m[1]!.toLowerCase() as LearningKind;
  return KINDS.includes(k) ? k : null;
}

function formatSummary(counts: Counts): string {
  const total = KINDS.reduce((a, k) => a + counts[k], 0);
  const parts = KINDS.map((k) => `${k}:${counts[k]}`).join(" ");
  return `${SUMMARY_PREFIX} ${parts} (total ${total})`;
}

function parseSummary(line: string): Counts {
  const c = emptyCounts();
  for (const m of line.matchAll(/(\w+):(\d+)/g)) {
    const k = m[1] as LearningKind;
    if ((KINDS as string[]).includes(k)) c[k] = Number(m[2]);
  }
  return c;
}

function splitMemory(text: string): { summary: string | null; entries: string[] } {
  let summary: string | null = null;
  const entries: string[] = [];
  for (const ln of text.split("\n")) {
    if (ln.startsWith(SUMMARY_PREFIX)) summary = ln;
    else if (ln.startsWith("- ")) entries.push(ln);
  }
  return { summary, entries };
}

function render(entries: string[], summaryLine: string | null): string {
  const body = [summaryLine, ...entries].filter(Boolean).join("\n");
  return `${HEADER}\n${body}\n`;
}

/**
 * Enforce the caps: collapse oldest entries into a (possibly pre-existing) summary
 * line, by entry count first and then by total character length. Pure.
 */
export function capEntries(
  entries: string[],
  existingSummary: string | null,
  caps: MemoryCaps
): { keptEntries: string[]; summaryLine: string | null } {
  const counts = existingSummary ? parseSummary(existingSummary) : emptyCounts();
  let collapsed = !!existingSummary;
  let kept = entries;

  if (entries.length > caps.maxEntries) {
    const overflow = entries.slice(0, entries.length - caps.maxEntries);
    kept = entries.slice(entries.length - caps.maxEntries);
    for (const ln of overflow) {
      const k = kindOf(ln);
      if (k) counts[k] += 1;
    }
    collapsed = true;
  }

  let summaryLine = collapsed ? formatSummary(counts) : null;
  while (kept.length > 1 && render(kept, summaryLine).length > caps.maxChars) {
    const dropped = kept.shift()!;
    const k = kindOf(dropped);
    if (k) counts[k] += 1;
    summaryLine = formatSummary(counts);
  }

  return { keptEntries: kept, summaryLine };
}

/** Append a learning to memory.md, enforcing the caps. Never throws. */
export async function appendLearning(paths: Paths, l: Learning, caps: MemoryCaps = DEFAULT_CAPS): Promise<void> {
  try {
    const text = (await readText(paths.memory)) ?? "";
    const { summary, entries } = splitMemory(text);
    entries.push(formatLearning(l));
    const { keptEntries, summaryLine } = capEntries(entries, summary, caps);
    await writeText(paths.memory, render(keptEntries, summaryLine));
  } catch {
    // memory is best-effort; never break the build over it
  }
}

/**
 * True when memory.md already holds a learning of `kind` for `item`. The acceptance finisher
 * uses this as an idempotency guard: `appendLearning` is append-only (not idempotent), so a
 * crash AFTER the write but BEFORE its durable flag saves would otherwise re-append a duplicate
 * on resume. Checking the file (not the flag) makes the memory step exactly-once even when the
 * flag-save is lost. Reads the live entries (post-summary-collapse), so a recent passed line is
 * always seen.
 */
export async function hasLearning(paths: Paths, item: string, kind: LearningKind): Promise<boolean> {
  const text = await readText(paths.memory);
  if (!text) return false;
  const needle = `${item} · ${kind.toUpperCase()}:`;
  return splitMemory(text).entries.some((ln) => ln.includes(needle));
}

/**
 * Distinguishing marker every distilled-technique `note` line begins with, so its once-only dedup
 * can key on THIS (not the `note` kind, which the abandonment/blocked/escalation/inconclusive
 * learnings also use). Read this in memory.md as `… · NOTE: technique: <what fixed it>`.
 */
export const TECHNIQUE_MARKER = "technique:";
/** Hard char cap on a distilled technique detail (marker included). Small — it's one transferable line. */
export const TECHNIQUE_CAP = 200;

/** Durable item state the pure distiller reads — item id, terminal status, last report, attempt ledger. */
export interface TechniqueInput {
  item: string;
  status: "passed" | "failed";
  lastReport?: string;
  attempts?: { round: number; approach: string; failure: string }[];
}

// A whole sentence that is pure bookkeeping (score/cost/round tally) — never transferable, dropped.
const BOOKKEEPING_SENTENCE = /\b(scored?|accepted in round|budget|spent|pivot)\b|\$\s*\d/i;
// Residual score/cost tokens scrubbed from a surviving sentence, defensively (the token "score" and
// any score-adjacent number never leak, but legitimate non-score numbers — "2 passes", an API name — stay).
const SCORE_TOKENS: RegExp[] = [
  /\bscored?\b[^.;\n]*?\b\d+\b/gi, // "scored 87", "score of 87"
  /\bscored?\b/gi,
  /\$\s*\d[\d,]*(?:\.\d+)?/g, // "$0.41"
];
// Substrings that hint a sentence describes HOW something was fixed/built (a transferable technique),
// used only to RANK candidate sentences so the salient one survives the 2-line cap.
const TECHNIQUE_HINTS = [
  "fix", "use", "add", "seed", "annotat", "guard", "wrap", "mock", "stub", "apply", "await",
  "order", "before", "after", "inject", "actor", "cap", "redact", "dedup", "key", "escape",
  "handle", "ensure", "call", "assert", "pattern", "approach", "replace", "strip", "match",
  "parse", "race", "timeout", "flag", "hook", "gate", "await", "isolate", "reset",
];

const sentencesOf = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

const hintScore = (s: string): number => {
  const lc = s.toLowerCase();
  return TECHNIQUE_HINTS.reduce((n, h) => n + (lc.includes(h) ? 1 : 0), 0);
};

const scrubScore = (s: string): string => {
  let out = s;
  for (const re of SCORE_TOKENS) out = out.replace(re, "");
  return out.replace(/\s{2,}/g, " ").replace(/\s+([.;,])/g, "$1").trim();
};

/**
 * Pure, deterministic technique distiller: from ONLY durable item state (id, terminal status, the
 * generator's last report, the attempt ledger) return a single 1–2-line transferable TECHNIQUE — what
 * FIXED (or was tried on) the item — marked with `TECHNIQUE_MARKER` and capped to `TECHNIQUE_CAP`, or
 * `null` when there's nothing to distill (empty/absent report AND no attempts, or only bookkeeping).
 * No model call, no randomness, no clock — identical input always yields an identical string. The
 * output never carries the token "score", bookkeeping phrasing, or a score-adjacent number, but does
 * NOT strip legitimate non-score numbers (an API name, "2 passes").
 */
export function distillTechnique(input: TechniqueInput): string | null {
  // Both durable fields feed the distiller: the last report first, then each recorded attempt's
  // approach/failure — so a FAILED item with an empty report still distills from its history.
  const sources: string[] = [];
  if (input.lastReport?.trim()) sources.push(input.lastReport);
  for (const a of input.attempts ?? []) {
    if (a.approach?.trim()) sources.push(a.approach);
    else if (a.failure?.trim()) sources.push(a.failure);
  }
  if (sources.length === 0) return null;

  const candidates = sentencesOf(sources.join(" ")).filter((s) => !BOOKKEEPING_SENTENCE.test(s));
  if (candidates.length === 0) return null;

  // Rank by technique-hint density (stable index tie-break for determinism), keep the top 2, then
  // restore their original order so the line reads naturally and preserves the distinctive terms.
  const ranked = candidates
    .map((s, i) => ({ s, i, score: hintScore(s) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 2)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s);

  const body = scrubScore(ranked.join(" "));
  if (!body) return null;
  const detail = `${TECHNIQUE_MARKER} ${body}`;
  return detail.length > TECHNIQUE_CAP ? detail.slice(0, TECHNIQUE_CAP).trimEnd() : detail;
}

/**
 * True when memory.md already holds a distilled-technique `note` (a `TECHNIQUE_MARKER` line) for
 * `item`. The terminal distillation uses this as its once-only idempotency guard — keyed on the
 * MARKER, not `hasLearning(item, "note")`, which would collide with the other `note` learnings and
 * let an unrelated note suppress the technique (or a resume double-append it). File-based, so it
 * holds even when a durable flag save was lost to a crash.
 */
export async function hasTechniqueNote(paths: Paths, item: string): Promise<boolean> {
  const text = await readText(paths.memory);
  if (!text) return false;
  const needle = `${item} · NOTE:`;
  return splitMemory(text).entries.some((ln) => ln.includes(needle) && ln.includes(TECHNIQUE_MARKER));
}

/** Read memory.md back as injectable text (most-recent-first cap by chars). Returns "" if empty. */
export async function readMemory(paths: Paths, caps: MemoryCaps = DEFAULT_CAPS): Promise<string> {
  const text = await readText(paths.memory);
  if (!text) return "";
  const { summary, entries } = splitMemory(text);
  const lines = [summary, ...entries].filter(Boolean) as string[];
  if (lines.length === 0) return "";
  let out = lines.join("\n");
  if (out.length > caps.maxChars) out = out.slice(out.length - caps.maxChars);
  return out;
}

/**
 * Wrap memory text as a prompt section for the autonomous roles. Pure, so the
 * prompt-assembly is testable. Returns "" when there is nothing to inject.
 */
export function memorySection(memoryText: string): string {
  if (!memoryText.trim()) return "";
  return `\nPRIOR LEARNINGS (durable memory from earlier items/runs — heed these; do not repeat past mistakes):\n---\n${memoryText.trim()}\n---\n`;
}
