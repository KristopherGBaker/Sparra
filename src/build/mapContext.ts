/**
 * Item-targeted CODEBASE_MAP context.
 *
 * The generator and contract-generator prompts inject a bounded slice of CODEBASE_MAP. Blindly
 * taking the head (`map.slice(0, cap)`) drops the seams a mid-tier model needs when they sit past
 * the cut. When the decomposer names the paths most relevant to an item (`WorkItem.relevantPaths`),
 * this single-source helper PREFERS the map section(s) mentioning those paths over the head-slice,
 * and prepends a short listing of the named files. It NEVER injects file bodies — a listing only.
 *
 * When nothing is named (absent/empty), behavior is byte-for-byte today's: `map.slice(0, cap)`.
 */

/** A markdown heading line (`#`..`######` + space) — the section delimiter. */
const HEADING = /^#{1,6}\s/;

/** Split a CODEBASE_MAP into sections delimited by markdown headings (preamble before the first
 *  heading is its own section). Original text is preserved so a selected section is injected verbatim. */
function splitSections(map: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of map.split("\n")) {
    if (HEADING.test(line) && current.length) {
      sections.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) sections.push(current.join("\n"));
  return sections;
}

/**
 * Assemble the CODEBASE_MAP context for one work item, bounded by `cap`.
 * - `relevantPaths` absent/empty → returns `map.slice(0, cap)` UNCHANGED (today's behavior).
 * - present → "Files most relevant to this item:" listing of the named paths, PLUS the map
 *   section(s) mentioning any named path (preferred over the head-slice); falls back to the
 *   head-slice when no section matches. Never throws on unknown/nonexistent paths.
 */
export function selectMapContext(
  map: string,
  relevantPaths: string[] | undefined,
  cap: number
): string {
  const paths = Array.isArray(relevantPaths)
    ? relevantPaths.filter((p): p is string => typeof p === "string" && p.length > 0)
    : [];
  if (paths.length === 0) return map.slice(0, cap);

  const listing = `Files most relevant to this item:\n${paths.map((p) => `- ${p}`).join("\n")}\n\n`;
  const relevant = splitSections(map).filter((s) => paths.some((p) => s.includes(p)));
  // Prefer the matching sections; fall back to the head content (head-slice-shaped) when none match.
  const body = listing + (relevant.length ? relevant.join("\n") : map);
  return body.slice(0, cap);
}
