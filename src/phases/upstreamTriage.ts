import path from "node:path";
import { appendText, readDir, readText, removeFile, writeText } from "../util/io.ts";

/**
 * Per-finding triage for the harness-level reflection inbox. A single inbox `.md` file (one per
 * reflect run) may carry several harness findings; this module splits a file into individual findings
 * so the user can mark each done/wontdo and have only the un-triaged ones resurface next run.
 *
 * The PARSER (`parseInbox`) is a pure, side-effect-free function (string → segments). All filesystem
 * work lives in the I/O helpers below and uses `src/util/io.ts`.
 */

export type Disposition = "done" | "wontdo";

/**
 * An ordered piece of an inbox file. `text` is the segment's lines joined with "\n"; concatenating all
 * segments' `text` with "\n" reproduces the original file byte-for-byte (no reflow/normalization), so
 * splicing a finding out and re-emitting the rest is byte-faithful for every untouched line.
 */
export type Segment =
  | { kind: "text"; text: string }
  | { kind: "finding"; title: string | null; text: string };

/** ATX heading: 1–6 leading `#` followed by whitespace or end-of-line. */
const HEADING_RE = /^(#{1,6})(?:\s|$)/;

function headingLevel(line: string): number | null {
  const m = HEADING_RE.exec(line);
  return m ? m[1]!.length : null;
}

/**
 * Split an inbox markdown string into ordered segments. A FINDING = an ATX `###` heading line plus its
 * body — the lines from that heading until the next heading of level ≤ 3 (`#`, `##`, or `###`) or EOF.
 * Text before the first `###`, and any `#`/`##` section bodies, are non-finding `text` segments. A file
 * with NO `###` heading yields exactly ONE finding spanning the whole file (today's file granularity).
 */
export function parseInbox(content: string): Segment[] {
  const lines = content.split("\n");
  if (!lines.some((l) => headingLevel(l) === 3)) {
    return [{ kind: "finding", title: null, text: content }];
  }
  const segments: Segment[] = [];
  let buf: string[] = [];
  const flushText = (): void => {
    if (buf.length) {
      segments.push({ kind: "text", text: buf.join("\n") });
      buf = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (headingLevel(line) === 3) {
      flushText();
      const title = line.replace(/^###\s*/, "").trim();
      const block: string[] = [line];
      i++;
      while (i < lines.length) {
        const lvl = headingLevel(lines[i]!);
        if (lvl !== null && lvl <= 3) break;
        block.push(lines[i]!);
        i++;
      }
      segments.push({ kind: "finding", title, text: block.join("\n") });
    } else {
      buf.push(line);
      i++;
    }
  }
  flushText();
  return segments;
}

/** Re-emit segments back into a file body (inverse of `parseInbox` for the kept segments). */
export function emitSegments(segments: Segment[]): string {
  return segments.map((s) => s.text).join("\n");
}

export interface InboxFinding {
  /** 1-based index across the whole inbox, in file-sorted then in-file order (matches the listing). */
  globalIndex: number;
  file: string;
  /** Position of this finding within its file's segment list (for splicing). */
  segIndex: number;
  /** Display title — the `###` heading text, or the filename for the whole-file fallback. */
  title: string;
  /** The verbatim finding block. */
  text: string;
}

export interface InboxFile {
  file: string;
  segments: Segment[];
}

export interface LoadedInbox {
  files: InboxFile[];
  findings: InboxFinding[];
}

/** Read every inbox `.md` file (sorted), parse it, and assign each finding a global 1-based index. */
export async function loadInbox(dir: string): Promise<LoadedInbox> {
  const names = readDir(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  const files: InboxFile[] = [];
  const findings: InboxFinding[] = [];
  let g = 0;
  for (const name of names) {
    const content = (await readText(path.join(dir, name))) ?? "";
    const segments = parseInbox(content);
    files.push({ file: name, segments });
    segments.forEach((seg, segIndex) => {
      if (seg.kind === "finding") {
        g++;
        findings.push({ globalIndex: g, file: name, segIndex, title: seg.title ?? name, text: seg.text });
      }
    });
  }
  return { files, findings };
}

function archiveMarker(disposition: Disposition, reason: string | undefined, ts: string): string {
  const r = reason && reason.trim() ? ` reason="${reason.trim()}"` : "";
  return `<!-- sparra-triage disposition=${disposition} at=${ts}${r} -->`;
}

export interface TriageRequest {
  dir: string;
  done: number[];
  wontdo: number[];
  reason?: string;
  /** Injectable clock so the archive timestamp is deterministic under test. */
  now?: () => Date;
}

export interface TriageResult {
  archived: { globalIndex: number; file: string; title: string; disposition: Disposition }[];
  /** Files whose residual had zero `###` findings left and were moved out of the inbox entirely. */
  filesMovedWhole: string[];
}

/**
 * Splice the marked findings out of their source files and append each (verbatim, under a disposition
 * marker) to `archive/<source-filename>`. Untriaged findings + all non-finding text stay in the inbox.
 * A source file left with no `###` findings (including the whole-file-fallback file) is removed from the
 * inbox entirely. ALL input is validated BEFORE any filesystem write, so invalid input changes nothing.
 */
export async function triageUpstream(req: TriageRequest): Promise<TriageResult> {
  const now = req.now ?? ((): Date => new Date());
  const { files, findings } = await loadInbox(req.dir);
  const total = findings.length;

  // ── validate (atomic): any failure throws BEFORE we touch the filesystem ──
  if (req.done.length + req.wontdo.length === 0) {
    throw new Error("triage needs at least one index via --done or --wontdo");
  }
  if (total === 0) {
    throw new Error("the harness-level inbox is empty; nothing to triage");
  }
  const seen = new Set<number>();
  for (const id of [...req.done, ...req.wontdo]) {
    if (!Number.isInteger(id) || id < 1 || id > total) {
      throw new Error(`index ${id} is out of range (valid: 1..${total})`);
    }
  }
  const doneSet = new Set(req.done);
  for (const id of req.wontdo) {
    if (doneSet.has(id)) throw new Error(`index ${id} given to BOTH --done and --wontdo`);
  }
  for (const id of [...req.done, ...req.wontdo]) {
    if (seen.has(id)) throw new Error(`index ${id} listed more than once`);
    seen.add(id);
  }

  const disposition = (id: number): Disposition => (doneSet.has(id) ? "done" : "wontdo");
  const ts = now().toISOString();

  // group the selected findings by their source file
  const selectedByFile = new Map<string, InboxFinding[]>();
  for (const f of findings) {
    if (seen.has(f.globalIndex)) {
      const list = selectedByFile.get(f.file) ?? [];
      list.push(f);
      selectedByFile.set(f.file, list);
    }
  }

  const result: TriageResult = { archived: [], filesMovedWhole: [] };
  for (const [file, selected] of selectedByFile) {
    const entry = files.find((x) => x.file === file)!;
    const archivePath = path.join(req.dir, "archive", file);
    const removeSeg = new Set<number>();
    for (const f of [...selected].sort((a, b) => a.segIndex - b.segIndex)) {
      await appendText(archivePath, `\n${archiveMarker(disposition(f.globalIndex), req.reason, ts)}\n${f.text}\n`);
      removeSeg.add(f.segIndex);
      result.archived.push({ globalIndex: f.globalIndex, file, title: f.title, disposition: disposition(f.globalIndex) });
    }
    const remaining = entry.segments.filter((_, idx) => !removeSeg.has(idx));
    if (remaining.some((s) => s.kind === "finding")) {
      await writeText(path.join(req.dir, file), emitSegments(remaining));
    } else {
      // No findings remain — move the file out of the inbox entirely (keep any residual non-finding text).
      const residual = emitSegments(remaining);
      if (residual.trim()) await appendText(archivePath, `\n${residual}\n`);
      await removeFile(path.join(req.dir, file));
      result.filesMovedWhole.push(file);
    }
  }
  return result;
}
