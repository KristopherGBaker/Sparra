/**
 * Robust JSON extraction from noisy LLM output. Real agent transcripts (especially
 * an evaluator that runs many commands) contain dozens of ``` fences and incidental
 * JSON snippets, so "grab the last fenced block" is unreliable. We collect ALL
 * parseable JSON values (from fenced blocks AND a string-aware balanced scan) and
 * let callers pick by shape.
 */

function tryParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** Every parseable JSON object/array found in the text, in source order. */
export function extractAllJson(text: string): unknown[] {
  const out: unknown[] = [];

  // 1) Fenced ``` blocks (with or without a language tag).
  for (const m of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    const parsed = tryParse(m[1]!.trim());
    if (parsed !== null && typeof parsed === "object") out.push(parsed);
  }

  // 2) String-aware balanced scan for top-level { } and [ ] regions. Tracks string
  //    literals/escapes so braces inside strings don't throw off the balance.
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end > i) {
      const parsed = tryParse(text.slice(i, end + 1));
      if (parsed !== null && typeof parsed === "object") {
        out.push(parsed);
        i = end; // skip past this region
      }
    }
  }

  return out;
}

/** The last parseable JSON value (back-compat default). */
export function extractJson<T = unknown>(text: string): T | null {
  const all = extractAllJson(text);
  return all.length ? (all[all.length - 1] as T) : null;
}

/** The last parseable JSON value that matches a shape predicate (e.g. a verdict). */
export function extractJsonWhere<T = unknown>(text: string, pred: (v: any) => boolean): T | null {
  const all = extractAllJson(text);
  for (let i = all.length - 1; i >= 0; i--) {
    if (pred(all[i])) return all[i] as T;
  }
  return null;
}

/**
 * Does the model output contain an explicit agreement marker on its OWN line?
 *
 * Line-anchored, so the marker embedded in a sentence ("not CONTRACT: AGREED yet")
 * does NOT match — but tolerant of decoration an evaluator commonly adds around an
 * otherwise-clean marker line: leading list/quote/emphasis prefixes and trailing
 * whitespace / terminal punctuation / emphasis. This is why "CONTRACT: AGREED." (a
 * stray trailing period — a recurring false-negative) and "**CONTRACT: AGREED**"
 * both count, while "CONTRACT: AGREED, pending fixes" (trailing words) still does not.
 */
export function hasMarker(text: string, marker: string): boolean {
  const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lead = "[\\s>#*_`-]*"; // leading whitespace / list / quote / emphasis decoration
  const trail = "[\\s.!?,;:*_`)\\]]*"; // trailing whitespace / punctuation / closing emphasis
  return new RegExp("^" + lead + esc + trail + "$", "m").test(text);
}
