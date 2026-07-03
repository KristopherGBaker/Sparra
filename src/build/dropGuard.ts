import { redactHoldout } from "./holdout.ts";

/**
 * Runner-side assertion-DROP guard for contract revisions (round>1). A revision must PATCH the
 * standing contract, not rewrite it from the critique: an assertion that VANISHES old→new without
 * the answered critique naming it is an UNCITED DROP — the lossy-revision bug. Pure helpers,
 * mirroring src/build/exec.ts's `extractVerifyCommands` (extraction + a text heuristic, no model,
 * directly unit-tested); wired into `negotiateContract` like the verify-probe.
 */

/**
 * Extract the assertion texts from a contract's "## Assertions" section — and ONLY that section
 * (stops at the next heading of any level). Numbered or bulleted list items; continuation lines
 * (a wrapped item, until a blank line) fold into the item. [] when the section is absent.
 */
export function extractAssertions(contractMd: string): string[] {
  const lines = contractMd.split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s+Assertions\b/i.test(l.trim()));
  if (start < 0) return [];
  const out: string[] = [];
  let cur = "";
  let openItem = false; // true while the current item can still absorb continuation lines
  const flush = () => {
    const t = cur.trim();
    if (t) out.push(t);
    cur = "";
  };
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^#{1,6}\s/.test(line.trim())) break; // next heading → section over
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (item) {
      flush();
      cur = item[1]!;
      openItem = true;
    } else if (!line.trim()) {
      openItem = false; // a blank line closes continuation (but keeps the item for the next flush)
    } else if (openItem) {
      cur += " " + line.trim(); // a wrapped continuation of the current item
    }
  }
  flush();
  return out;
}

/**
 * Generic/structural tokens that carry no discriminating signal in a contract assertion — a
 * critique that shares ONLY these with a dropped assertion has NOT named it. English function
 * words plus contract-domain filler (assertion/contract/verify/…). Small and concrete on purpose.
 */
const GENERIC_TOKENS = new Set([
  // English function words
  "the", "a", "an", "and", "or", "but", "not", "no", "of", "to", "in", "on", "for", "with", "by",
  "is", "are", "be", "it", "its", "as", "at", "that", "this", "when", "then", "than", "must",
  "should", "each", "every", "any", "all", "from", "into", "via", "per", "if", "so", "do", "does",
  "done", "was", "were", "has", "have", "will", "can", "may",
  // contract-domain filler
  "assertion", "assertions", "contract", "contracts", "item", "items", "round", "rounds", "verify",
  "verified", "check", "checks", "works", "work", "scope", "section", "proposal", "revision",
  "point", "points", "test", "tests", "value", "output", "command", "commands",
]);

/**
 * Significant (discriminating) tokens of a text: distinct lowercased alphanumeric tokens ≥3 chars
 * that are not generic filler. The unit of both the citation and the still-covered heuristics.
 */
export function significantTokens(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    const t = raw.trim();
    if (t.length < 3 || GENERIC_TOKENS.has(t)) continue;
    seen.add(t);
  }
  return [...seen];
}

/** ≥min(2,|sig|) of `sig` present in `hayTokens` — the shared "did this text name that one?" test. */
function tokenOverlapNames(sig: string[], hayTokens: Set<string>): boolean {
  if (sig.length === 0) return true; // nothing distinctive to claim un-named → don't over-flag
  const overlap = sig.filter((t) => hayTokens.has(t)).length;
  return overlap >= Math.min(2, sig.length);
}

/**
 * Does `critique` cite `assertion` (item #`index`, 1-based, in the OLD proposal)? Cited when the
 * critique references it by NUMBER (`assertion 4`, `CUT #4`) OR quotes it verbatim (substring) OR
 * shares ≥min(2,|sig|) of its significant tokens. Bias: err toward "NOT cited" (flag the drop) — a
 * spurious bounce wastes one round, an unflagged drop recreates the lossy-revision bug.
 */
export function critiqueCites(critique: string, assertion: string, index: number): boolean {
  const crit = critique.toLowerCase();
  // Explicit numeric reference to the assertion's position — "assertion 4", "assertions 3 and 4",
  // "CUT #4". The generator numbers its assertions, so a critique names them by number.
  const nums = new Set<number>();
  for (const m of crit.matchAll(/\bassertions?\s*#?\s*(\d+)/g)) nums.add(Number(m[1]));
  for (const m of crit.matchAll(/#\s*(\d+)/g)) nums.add(Number(m[1]));
  if (nums.has(index)) return true;
  // Verbatim quote of a meaningful chunk of the assertion.
  const norm = assertion.toLowerCase().trim();
  if (norm.length >= 12 && crit.includes(norm)) return true;
  // Significant-token overlap.
  return tokenOverlapNames(significantTokens(assertion), new Set(significantTokens(critique)));
}

/**
 * Is `oldA` still COVERED by some assertion in `newList` (reworded/expanded/superset — not dropped)?
 * Covered when a new assertion equals it, contains it verbatim, or shares ≥min(2,|sig|) significant
 * tokens. Keeps a legitimate patch (reword within citation, add-only superset) from false-bouncing.
 */
function stillCovered(oldA: string, newList: string[]): boolean {
  const sig = significantTokens(oldA);
  const oldNorm = oldA.toLowerCase().trim();
  for (const n of newList) {
    const nNorm = n.toLowerCase().trim();
    if (nNorm === oldNorm) return true;
    if (oldNorm.length >= 8 && nNorm.includes(oldNorm)) return true;
    if (tokenOverlapNames(sig, new Set(significantTokens(n)))) return true;
  }
  return false;
}

/**
 * UNCITED DROPS: assertions present in `oldProposal` that are (a) NOT still covered by any assertion
 * in `newProposal` AND (b) NOT cited by `answeredCritique` (the critique the reviser was answering).
 * These are the silent, lossy drops the guard bounces; a cited or reworded assertion is not flagged.
 */
export function findUncitedDrops(oldProposal: string, newProposal: string, answeredCritique: string): string[] {
  const oldAsserts = extractAssertions(oldProposal);
  const newAsserts = extractAssertions(newProposal);
  const dropped: string[] = [];
  oldAsserts.forEach((a, i) => {
    if (stillCovered(a, newAsserts)) return;
    if (critiqueCites(answeredCritique, a, i + 1)) return; // 1-based: the generator's own numbering
    dropped.push(a);
  });
  return dropped;
}

/**
 * Build the holdout-redacted DROP-GUARD report fed into the next generator round's critique context
 * (mirrors the verify-probe report). Redaction happens HERE, so the report can never carry a holdout
 * line into generator-visible text — tested at this construction boundary.
 */
export function buildDropGuardReport(dropped: string[], holdoutText: string): string {
  const body =
    `HARNESS DROP-GUARD: the agreement is void — this revision silently dropped ${dropped.length} previously-agreed assertion(s) that no critique point named. A revision PATCHES the standing contract: RESTORE each verbatim, or JUSTIFY the drop by naming the critique point that authorizes it:\n` +
    dropped.map((d) => `- ${d}`).join("\n");
  return redactHoldout(body, holdoutText);
}
