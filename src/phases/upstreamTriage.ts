import path from "node:path";
import { appendText, exists, readDir, readText, removeFile, writeText } from "../util/io.ts";

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
 * Marker stored inside a finding segment's text to track how many times the finding has been
 * surfaced (re-observed). Must be on its own line and match this exact format.
 * Backward-compat: a finding with NO marker is treated as recurrence 1 everywhere.
 */
const RECURRENCE_MARKER_RE = /^<!-- sparra-recurrence n=(\d+) -->$/m;

/**
 * Parse the recurrence count from a finding's text. Returns the marker's `n` when present, else 1
 * for a legacy finding with no marker. A malformed or absent marker never throws — defaults to 1.
 */
export function parseRecurrence(text: string): number {
  const m = RECURRENCE_MARKER_RE.exec(text);
  if (!m) return 1;
  const n = parseInt(m[1]!, 10);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 1 ? n : 1;
}

/**
 * Increment a single finding's recurrence counter in-place within a file's raw content string.
 * Pure — takes the file content and the segment index of the target finding; returns the updated
 * content. Byte-faithful to every untouched line (other segments are never modified). A legacy
 * marker-less finding gets its marker created at n=2; a marked finding is bumped by 1.
 */
export function incrementFinding(content: string, segIndex: number): string {
  const segments = parseInbox(content);
  const seg = segments[segIndex];
  if (!seg || seg.kind !== "finding") return content; // defensive

  const current = parseRecurrence(seg.text);
  const newMarkerLine = `<!-- sparra-recurrence n=${current + 1} -->`;

  let newText: string;
  if (RECURRENCE_MARKER_RE.test(seg.text)) {
    // Replace the existing marker line in place
    newText = seg.text.replace(RECURRENCE_MARKER_RE, newMarkerLine);
  } else if (/^###(?:\s|$)/.test(seg.text)) {
    // Has a ### heading — insert the marker right after the heading line
    const nl = seg.text.indexOf("\n");
    if (nl < 0) {
      newText = seg.text + "\n" + newMarkerLine;
    } else {
      newText = seg.text.slice(0, nl + 1) + newMarkerLine + "\n" + seg.text.slice(nl + 1);
    }
  } else {
    // Whole-file fallback (no ### heading) — prepend the marker
    newText = newMarkerLine + (seg.text.length > 0 ? "\n" + seg.text : "");
  }

  return emitSegments(segments.map((s, i) => (i === segIndex ? { ...s, text: newText } : s)));
}

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
  /** 1-based index across the whole inbox, ranked by recurrence DESC (matches the listing). */
  globalIndex: number;
  file: string;
  /** Position of this finding within its file's segment list (for splicing). */
  segIndex: number;
  /** Display title — the `###` heading text, or the filename for the whole-file fallback. */
  title: string;
  /** The verbatim finding block. */
  text: string;
  /** How many times this finding has been surfaced (1 for a legacy marker-less finding). */
  recurrence: number;
}

export interface InboxFile {
  file: string;
  segments: Segment[];
}

export interface LoadedInbox {
  files: InboxFile[];
  findings: InboxFinding[];
}

/**
 * Read every inbox `.md` file (sorted), parse it, and assign each finding a global 1-based index.
 * Findings are ranked by recurrence count DESC; ties keep file-sorted, in-file order (stable sort).
 * The globalIndex matches the displayed index in `sparra reflect --upstream`.
 */
export async function loadInbox(dir: string): Promise<LoadedInbox> {
  const names = readDir(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  const files: InboxFile[] = [];
  const findings: InboxFinding[] = [];
  for (const name of names) {
    const content = (await readText(path.join(dir, name))) ?? "";
    const segments = parseInbox(content);
    files.push({ file: name, segments });
    segments.forEach((seg, segIndex) => {
      if (seg.kind === "finding") {
        const recurrence = parseRecurrence(seg.text);
        findings.push({ globalIndex: 0 /* assigned below */, file: name, segIndex, title: seg.title ?? name, text: seg.text, recurrence });
      }
    });
  }
  // Rank by recurrence DESC; stable sort preserves original (file-sorted, in-file) order for ties.
  findings.sort((a, b) => b.recurrence - a.recurrence);
  findings.forEach((f, i) => { f.globalIndex = i + 1; });
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
 * A source file left with no `###` findings (including the whole-file-fallback file) is moved ENTIRELY
 * into `archive/` — re-emitted byte-faithfully in its original segment order, each triaged finding's
 * marker injected on the line just before its `###` heading — then removed from the inbox. ALL input is
 * validated BEFORE any filesystem write, so invalid input changes nothing.
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
    const sorted = [...selected].sort((a, b) => a.segIndex - b.segIndex);
    const removeSeg = new Set(sorted.map((f) => f.segIndex));
    const dispBySeg = new Map(sorted.map((f) => [f.segIndex, disposition(f.globalIndex)] as const));

    const remaining = entry.segments.filter((_, idx) => !removeSeg.has(idx));
    if (remaining.some((s) => s.kind === "finding")) {
      // Some findings remain — splice each triaged finding out, appended verbatim-with-marker to the
      // archive, and leave the rest in the inbox byte-faithfully.
      for (const f of sorted) {
        await appendText(archivePath, `\n${archiveMarker(disposition(f.globalIndex), req.reason, ts)}\n${f.text}\n`);
      }
      await writeText(path.join(req.dir, file), emitSegments(remaining));
    } else {
      // Fully consumed — archive the WHOLE file byte-faithfully (original segment order + whitespace),
      // injecting each triaged finding's disposition marker on the line immediately BEFORE its ###
      // heading; non-finding segments are left unchanged in place. Then drop the source from the inbox.
      const body = entry.segments
        .map((seg, idx) => (removeSeg.has(idx) ? `${archiveMarker(dispBySeg.get(idx)!, req.reason, ts)}\n${seg.text}` : seg.text))
        .join("\n");
      if (exists(archivePath)) await appendText(archivePath, `\n${body}\n`);
      else await writeText(archivePath, body);
      await removeFile(path.join(req.dir, file));
      result.filesMovedWhole.push(file);
    }
    for (const f of sorted) {
      result.archived.push({ globalIndex: f.globalIndex, file, title: f.title, disposition: disposition(f.globalIndex) });
    }
  }
  return result;
}
