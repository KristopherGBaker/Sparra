/** Pull the last fenced ```json block (or the last bare {...}/[...]) and parse it. */
export function extractJson<T = unknown>(text: string): T | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const body = fences[i]![1]!.trim();
    const parsed = tryParse<T>(body);
    if (parsed !== null) return parsed;
  }
  // Fallback: last balanced object/array in the text.
  const candidate = lastBalanced(text);
  if (candidate) return tryParse<T>(candidate);
  return null;
}

function tryParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function lastBalanced(text: string): string | null {
  const opens = [text.lastIndexOf("{"), text.lastIndexOf("[")].filter((i) => i >= 0);
  if (opens.length === 0) return null;
  const start = Math.min(...opens.map((i) => firstOpen(text, i)));
  for (const open of ["{", "["]) {
    const idx = text.indexOf(open, start);
    if (idx < 0) continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    for (let i = idx; i < text.length; i++) {
      if (text[i] === open) depth++;
      else if (text[i] === close) {
        depth--;
        if (depth === 0) return text.slice(idx, i + 1);
      }
    }
  }
  return null;
}

function firstOpen(text: string, hint: number): number {
  // Walk back to the earliest top-level opening brace/bracket near the hint.
  let i = hint;
  while (i > 0 && text[i] !== "{" && text[i] !== "[") i--;
  return i;
}

/** Does the model output contain an explicit agreement marker? */
export function hasMarker(text: string, marker: string): boolean {
  return new RegExp(`^\\s*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(text);
}
