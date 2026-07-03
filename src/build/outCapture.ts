import { warn } from "../util/log.ts";

export interface NormalizedOutCapture {
  text: string;
  strippedPreamble: boolean;
  headingFound: boolean;
}

export function normalizeOutCapture(raw: string): NormalizedOutCapture {
  const firstHeading = firstMarkdownHeadingStart(raw);
  if (firstHeading != null) {
    return {
      text: `${raw.slice(firstHeading).trimEnd()}\n`,
      strippedPreamble: firstHeading > 0,
      headingFound: true,
    };
  }

  if (raw.trim().length === 0) {
    return { text: raw, strippedPreamble: false, headingFound: false };
  }

  warn("out capture found no markdown heading; writing trimmed raw completion.");
  return { text: `${raw.trim()}\n`, strippedPreamble: false, headingFound: false };
}

function firstMarkdownHeadingStart(raw: string): number | null {
  let inFence = false;
  let lineStart = 0;

  while (lineStart <= raw.length) {
    const lineEnd = raw.indexOf("\n", lineStart);
    const end = lineEnd === -1 ? raw.length : lineEnd;
    const line = raw.slice(lineStart, end);

    if (line.startsWith("```")) {
      inFence = !inFence;
    } else if (!inFence && /^#{1,6}\s/.test(line)) {
      return lineStart;
    }

    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }

  return null;
}
