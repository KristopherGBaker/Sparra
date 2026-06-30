import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import { seedPrompts } from "../src/prompts.ts";
import { cmdReflect, upstreamInboxDir } from "../src/phases/reflect.ts";
import { parseInbox, emitSegments, loadInbox, type Segment } from "../src/phases/upstreamTriage.ts";
import type { Ctx } from "../src/context.ts";
import type { RunResult } from "../src/sdk/session.ts";

/** Point SPARRA_HOME at a fresh temp dir so nothing touches the real ~/.sparra. Returns the inbox dir. */
function withTempInbox(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-triage-"));
  process.env.SPARRA_HOME = home;
  const dir = upstreamInboxDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const savedHome = process.env.SPARRA_HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.SPARRA_HOME;
  else process.env.SPARRA_HOME = savedHome;
});

/** showUpstream ignores ctx entirely (no model session) — a dummy is sufficient to drive the CLI path. */
const DUMMY_CTX = {} as unknown as Ctx;

/** A fixed clock so the archive timestamp is deterministic (assertion 12). */
const FIXED = "2026-06-30T12:00:00.000Z";
const now = (): Date => new Date(FIXED);

const isFinding = (s: Segment): s is Extract<Segment, { kind: "finding" }> => s.kind === "finding";

function write(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

function read(p: string): string {
  return fs.readFileSync(p, "utf8");
}

function suppressStdout(): { restore: () => void } {
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return { restore: () => spy.mockRestore() };
}

// ───────────────────────── PURE parser ─────────────────────────

describe("parseInbox — pure markdown finding splitter", () => {
  it("(a) splits a multi-### file into N findings with correct titles and bodies", () => {
    const content = "preamble line\n### Alpha gap\nalpha body\nmore alpha\n### Beta bug\nbeta body\n";
    const segs = parseInbox(content);
    const findings = segs.filter(isFinding);
    expect(findings).toHaveLength(2);
    expect(findings[0]!.title).toBe("Alpha gap");
    expect(findings[0]!.text).toBe("### Alpha gap\nalpha body\nmore alpha");
    expect(findings[1]!.title).toBe("Beta bug");
    expect(findings[1]!.text).toBe("### Beta bug\nbeta body\n");
    // the preamble before the first ### is non-finding text, not a finding
    expect(segs[0]).toEqual({ kind: "text", text: "preamble line" });
  });

  it("treats #/## sections (and #### inside a finding) as non-finding / in-body, not boundaries", () => {
    const content = "## Title\nintro\n### Finding one\nbody\n#### sub note still in finding\ntail\n";
    const findings = parseInbox(content).filter(isFinding);
    expect(findings).toHaveLength(1);
    // the level-4 #### does NOT end the finding (only level ≤ 3 does)
    expect(findings[0]!.text).toContain("#### sub note still in finding");
    expect(findings[0]!.text).toContain("tail");
  });

  it("(no-###) parses the WHOLE file as exactly one finding (title=null fallback)", () => {
    const content = "## only h2 here\nplain note\nmore\n";
    const segs = parseInbox(content);
    expect(segs).toEqual([{ kind: "finding", title: null, text: content }]);
  });

  it("(4) round-trips byte-faithfully: re-emitting all segments equals the original", () => {
    const samples = [
      "preamble\n### A\nbody a\n### B\nbody b\n",
      "no headings at all\njust text\n",
      "### only one\nbody\n",
      "lead\n## section\nx\n### find\ny\n",
    ];
    for (const s of samples) expect(emitSegments(parseInbox(s))).toBe(s);
  });
});

// ───────────────────────── listing ─────────────────────────

describe("loadInbox — global 1-based indexing across files", () => {
  it("assigns indices in file-sorted, in-file order; fallback title = filename", async () => {
    const dir = withTempInbox();
    write(dir, "a.md", "### One\nb1\n### Two\nb2\n");
    write(dir, "b.md", "plain whole-file finding\n");
    const { findings } = await loadInbox(dir);
    expect(findings.map((f) => [f.globalIndex, f.file, f.title])).toEqual([
      [1, "a.md", "One"],
      [2, "a.md", "Two"],
      [3, "b.md", "b.md"], // whole-file fallback titled by filename
    ]);
  });
});

// ───────────────────────── triage: --done ─────────────────────────

describe("cmdReflect --upstream --done — splice one finding out", () => {
  it("(b) removes exactly the marked finding from source AND appends it verbatim to archive with a done-marker", async () => {
    const dir = withTempInbox();
    const src = write(dir, "a.md", "preamble\n### First gap\nfirst body\n### Second gap\nsecond body\n");
    const cap = suppressStdout();
    try {
      await cmdReflect(DUMMY_CTX, { upstream: true, done: "1", now });
    } finally {
      cap.restore();
    }
    // source: First spliced OUT, preamble + Second kept (byte-faithful)
    const after = read(src);
    expect(after).toContain("### Second gap");
    expect(after).toContain("second body");
    expect(after).toContain("preamble");
    expect(after).not.toContain("First gap");
    // archive: First present VERBATIM under a done marker with the deterministic timestamp
    const arc = read(path.join(dir, "archive", "a.md"));
    expect(arc).toContain("### First gap\nfirst body");
    expect(arc).toMatch(/<!-- sparra-triage disposition=done at=2026-06-30T12:00:00\.000Z -->/);
    expect(arc).not.toContain("Second gap");
  });
});

// ───────────────────────── triage: --wontdo + reason ─────────────────────────

describe("cmdReflect --upstream --wontdo --reason", () => {
  it("(c) splices the finding, appends it with a wontdo-marker carrying the reason", async () => {
    const dir = withTempInbox();
    const src = write(dir, "a.md", "### Keep me\nkeep body\n### Drop me\ndrop body\n");
    const cap = suppressStdout();
    try {
      await cmdReflect(DUMMY_CTX, { upstream: true, wontdo: "2", reason: "out of scope", now });
    } finally {
      cap.restore();
    }
    const after = read(src);
    expect(after).toContain("### Keep me");
    expect(after).not.toContain("Drop me");
    const arc = read(path.join(dir, "archive", "a.md"));
    expect(arc).toContain("### Drop me\ndrop body");
    expect(arc).toMatch(/disposition=wontdo at=2026-06-30T12:00:00\.000Z reason="out of scope"/);
  });
});

// ───────────────────────── triage: no-### fallback ─────────────────────────

describe("cmdReflect --upstream — no-### whole-file fallback", () => {
  it("(d) yields 1 finding; triaging it moves the whole file to archive (inbox clean)", async () => {
    const dir = withTempInbox();
    const body = "a single plain finding\nspanning the whole file\n";
    write(dir, "solo.md", body);
    const cap = suppressStdout();
    try {
      await cmdReflect(DUMMY_CTX, { upstream: true, done: "1", now });
    } finally {
      cap.restore();
    }
    // source removed entirely — no stub left in the inbox
    expect(fs.existsSync(path.join(dir, "solo.md"))).toBe(false);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".md"))).toHaveLength(0);
    // whole body archived verbatim under a done marker
    const arc = read(path.join(dir, "archive", "solo.md"));
    expect(arc).toContain(body.trimEnd());
    expect(arc).toContain("disposition=done");
  });
});

// ───────────────────────── triage: fully-triaged file ─────────────────────────

describe("cmdReflect --upstream — fully-triaged file", () => {
  it("(e) triaging ALL findings moves the residual to archive and leaves the inbox clean", async () => {
    const dir = withTempInbox();
    write(dir, "a.md", "leading note\n### One\nb1\n### Two\nb2\n");
    const cap = suppressStdout();
    try {
      await cmdReflect(DUMMY_CTX, { upstream: true, done: "1", wontdo: "2", reason: "both handled", now });
    } finally {
      cap.restore();
    }
    expect(fs.existsSync(path.join(dir, "a.md"))).toBe(false);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".md"))).toHaveLength(0);
    const arc = read(path.join(dir, "archive", "a.md"));
    expect(arc).toContain("### One\nb1");
    expect(arc).toContain("### Two\nb2");
    expect(arc).toContain("leading note"); // the non-finding residual is preserved in archive
    expect(arc).toContain("disposition=done");
    expect(arc).toContain('disposition=wontdo at=2026-06-30T12:00:00.000Z reason="both handled"');
  });
});

// ───────────────────────── atomic error: no fs change ─────────────────────────

describe("cmdReflect --upstream — invalid input is atomic (no fs change)", () => {
  it("(f) an out-of-range index throws and changes NOTHING on disk", async () => {
    const dir = withTempInbox();
    const original = "### Only\nbody\n";
    const src = write(dir, "a.md", original);
    const cap = suppressStdout();
    try {
      await expect(cmdReflect(DUMMY_CTX, { upstream: true, done: "5", now })).rejects.toThrow(/out of range/i);
    } finally {
      cap.restore();
    }
    expect(read(src)).toBe(original); // source untouched
    expect(fs.existsSync(path.join(dir, "archive"))).toBe(false); // nothing archived
  });

  it("a non-numeric index throws and changes nothing", async () => {
    const dir = withTempInbox();
    const src = write(dir, "a.md", "### Only\nbody\n");
    const cap = suppressStdout();
    try {
      await expect(cmdReflect(DUMMY_CTX, { upstream: true, done: "abc", now })).rejects.toThrow(/invalid index/i);
    } finally {
      cap.restore();
    }
    expect(read(src)).toBe("### Only\nbody\n");
  });

  it("the SAME index in both --done and --wontdo throws and changes nothing", async () => {
    const dir = withTempInbox();
    const src = write(dir, "a.md", "### One\nb1\n### Two\nb2\n");
    const cap = suppressStdout();
    try {
      await expect(cmdReflect(DUMMY_CTX, { upstream: true, done: "1", wontdo: "1", now })).rejects.toThrow(/BOTH/i);
    } finally {
      cap.restore();
    }
    expect(read(src)).toBe("### One\nb1\n### Two\nb2\n");
    expect(fs.existsSync(path.join(dir, "archive"))).toBe(false);
  });

  it("a triage flag on an EMPTY inbox throws (no session, no fs change)", async () => {
    const dir = withTempInbox();
    const cap = suppressStdout();
    try {
      await expect(cmdReflect(DUMMY_CTX, { upstream: true, done: "1", now })).rejects.toThrow(/empty/i);
    } finally {
      cap.restore();
    }
    expect(fs.existsSync(path.join(dir, "archive"))).toBe(false);
  });
});

// ───────────────────────── untriaged findings survive ─────────────────────────

describe("cmdReflect --upstream — untriaged findings resurface", () => {
  it("(8) findings not named stay in the inbox and re-list on the next load", async () => {
    const dir = withTempInbox();
    write(dir, "a.md", "### One\nb1\n### Two\nb2\n### Three\nb3\n");
    const cap = suppressStdout();
    try {
      await cmdReflect(DUMMY_CTX, { upstream: true, done: "2", now });
    } finally {
      cap.restore();
    }
    const { findings } = await loadInbox(dir);
    expect(findings.map((f) => f.title)).toEqual(["One", "Three"]); // Two gone, others re-indexed 1..2
    expect(findings.map((f) => f.globalIndex)).toEqual([1, 2]);
  });
});

// ───────────────────────── Part A: operative prompt instruction ─────────────────────────

describe("Part A — the reflector task prompt fixes the ### finding format", () => {
  it("the production cmdReflect task string requires per-finding ### sections in upstream.md", async () => {
    withTempInbox();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-promptcap-"));
    const paths = new Paths(root);
    await paths.ensureScaffold();
    await seedPrompts(paths);
    const store = StateStore.create(paths, "existing");
    store.data.autoSupported = false; // offline: no live SDK probe
    const ctx = { root, paths, config: defaultConfig(), store } as unknown as Ctx;

    const runId = "build-cap";
    const td = paths.traceDir(runId);
    fs.mkdirSync(td, { recursive: true });
    fs.writeFileSync(path.join(td, "1.json"), "{}");

    let captured = "";
    const okResult: RunResult = {
      ok: true, subtype: "success", resultText: "", sessionId: "s",
      costUsd: 0, tokens: 0, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
    };
    const cap = suppressStdout();
    try {
      await cmdReflect(ctx, {
        run: runId,
        runSessionFn: async (p) => {
          captured = p.prompt;
          return okResult;
        },
      });
    } finally {
      cap.restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(captured).toContain("upstream.md");
    expect(captured).toContain("### <short title>"); // each harness finding as its own ### section
  });
});
