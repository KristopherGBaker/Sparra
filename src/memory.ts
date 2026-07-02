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
