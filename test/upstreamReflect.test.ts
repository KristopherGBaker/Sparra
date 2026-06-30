import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import { seedPrompts, DEFAULT_PROMPTS } from "../src/prompts.ts";
import {
  cmdReflect,
  sparraHome,
  upstreamInboxDir,
  routeUpstreamFinding,
} from "../src/phases/reflect.ts";
import type { Ctx } from "../src/context.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

/** Point SPARRA_HOME at a fresh temp dir so nothing touches the real ~/.sparra. Returns the dir. */
function withTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-home-"));
  process.env.SPARRA_HOME = home;
  return home;
}

const savedHome = process.env.SPARRA_HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.SPARRA_HOME;
  else process.env.SPARRA_HOME = savedHome;
});

async function ctxFor(): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-upreflect-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  await seedPrompts(paths);
  const store = StateStore.create(paths, "existing");
  store.data.autoSupported = false; // offline: no live SDK probe
  return { ctx: { root: dir, paths, config: defaultConfig(), store }, dir };
}

function okResult(): RunResult {
  return {
    ok: true, subtype: "success", resultText: "done", sessionId: "s",
    costUsd: 0, tokens: 0, numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
  };
}

function recorder(sideEffect?: (p: RunSessionParams) => void) {
  const calls: RunSessionParams[] = [];
  const fn = async (p: RunSessionParams): Promise<RunResult> => {
    calls.push(p);
    sideEffect?.(p);
    return okResult();
  };
  return { calls, fn };
}

function seedTrace(ctx: Ctx, runId: string): void {
  const td = ctx.paths.traceDir(runId);
  fs.mkdirSync(td, { recursive: true });
  fs.writeFileSync(path.join(td, "1.json"), "{}");
}

/** Capture process.stdout for assertions on printed output. */
function captureStdout(): { buf: () => string; restore: () => void } {
  let buf = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
  return { buf: () => buf, restore: () => spy.mockRestore() };
}

const inboxFiles = () => {
  const dir = upstreamInboxDir();
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
};

// ───────────────────────── routeUpstreamFinding + SPARRA_HOME ─────────────────────────

describe("sparraHome / upstreamInboxDir — SPARRA_HOME override", () => {
  it("honors SPARRA_HOME when set; falls back to ~/.sparra otherwise", () => {
    const home = withTempHome();
    expect(sparraHome()).toBe(home);
    expect(upstreamInboxDir()).toBe(path.join(home, "reflections"));
    delete process.env.SPARRA_HOME;
    expect(sparraHome()).toBe(path.join(os.homedir(), ".sparra"));
  });
});

describe("routeUpstreamFinding — concurrency-safe unique file", () => {
  it("CLOCK-FIXED: two routings with an IDENTICAL stamp still produce two distinct files (uuid token)", async () => {
    const home = withTempHome();
    const a = await routeUpstreamFinding("proj", "reflect-FIXED", "HARNESS FINDING");
    const b = await routeUpstreamFinding("proj", "reflect-FIXED", "HARNESS FINDING");
    expect(a).not.toBe(b); // distinct paths despite identical project+stamp
    const files = inboxFiles();
    expect(files).toHaveLength(2);
    // both carry the same project+stamp prefix but differ by a non-time random (uuid) token
    for (const f of files) expect(f).toMatch(/^proj-reflect-FIXED-[0-9a-f]+\.md$/);
    expect(new Set(files).size).toBe(2);
    // content preserved
    for (const f of files) expect(fs.readFileSync(path.join(home, "reflections", f), "utf8")).toBe("HARNESS FINDING");
  });
});

// ───────────────────────── cmdReflect — routing harness findings ─────────────────────────

describe("cmdReflect — routes harness findings to the inbox (content equality)", () => {
  it("copies a non-empty <outDir>/upstream.md into the inbox VERBATIM", async () => {
    withTempHome();
    const { ctx, dir } = await ctxFor();
    try {
      const runId = "build-xyz";
      seedTrace(ctx, runId);
      const FINDING = "## Harness\n- config knob X is missing\n  - _why:_ blocked the run\n";
      const rec = recorder((p) => {
        const outDir = path.dirname(p.traceDir!);
        fs.writeFileSync(path.join(outDir, "upstream.md"), FINDING);
      });
      await cmdReflect(ctx, { run: runId, runSessionFn: rec.fn });
      const files = inboxFiles();
      expect(files).toHaveLength(1);
      // bytes EQUAL the source upstream.md (not mere presence / a placeholder)
      expect(fs.readFileSync(path.join(upstreamInboxDir(), files[0]!), "utf8")).toBe(FINDING);
      // filename is project-tagged (project = basename of ctx.root)
      expect(files[0]!.startsWith(path.basename(ctx.root))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes upstream EVEN WHEN the reflector proposed no prompt candidates (harness-only run)", async () => {
    withTempHome();
    const { ctx, dir } = await ctxFor();
    try {
      const runId = "build-harness-only";
      seedTrace(ctx, runId);
      const rec = recorder((p) => {
        // writes ONLY upstream.md — no candidates/<role>.md
        fs.writeFileSync(path.join(path.dirname(p.traceDir!), "upstream.md"), "harness finding");
      });
      await cmdReflect(ctx, { run: runId, runSessionFn: rec.fn });
      expect(inboxFiles()).toHaveLength(1); // routed despite zero prompt candidates
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("NEGATIVE: no upstream.md ⇒ nothing routed", async () => {
    withTempHome();
    const { ctx, dir } = await ctxFor();
    try {
      const runId = "build-none";
      seedTrace(ctx, runId);
      const rec = recorder(); // writes nothing
      await cmdReflect(ctx, { run: runId, runSessionFn: rec.fn });
      expect(inboxFiles()).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("NEGATIVE: an EMPTY/whitespace upstream.md ⇒ nothing routed", async () => {
    withTempHome();
    const { ctx, dir } = await ctxFor();
    try {
      const runId = "build-empty";
      seedTrace(ctx, runId);
      const rec = recorder((p) => {
        fs.writeFileSync(path.join(path.dirname(p.traceDir!), "upstream.md"), "   \n  \n");
      });
      await cmdReflect(ctx, { run: runId, runSessionFn: rec.fn });
      expect(inboxFiles()).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PRODUCTION SINK: the real cmdReflect task string instructs writing harness findings to <outDir>/upstream.md", async () => {
    withTempHome();
    const { ctx, dir } = await ctxFor();
    try {
      const runId = "build-task";
      seedTrace(ctx, runId);
      const rec = recorder();
      await cmdReflect(ctx, { run: runId, runSessionFn: rec.fn });
      // The prompt the session receives is the REAL task string cmdReflect built — so the feature is
      // not inert in production even though the routing tests inject upstream.md themselves.
      const prompt = rec.calls[0]!.prompt;
      const reflectStamp = fs.readdirSync(ctx.paths.reflect).find((d) => d.startsWith("reflect-"))!;
      expect(prompt).toContain(path.join("reflect", reflectStamp, "upstream.md")); // names the real sink path
      expect(prompt.toLowerCase()).toContain("harness"); // tells the reflector WHAT goes there
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────── prompt: the one additive reflector clause ─────────────────────────

describe("reflector DEFAULT_PROMPTS — the additive harness-tagging clause", () => {
  it("the reflector prompt now instructs harness-level findings → upstream.md (content, not just length)", () => {
    const t = DEFAULT_PROMPTS["reflector"]!;
    expect(t.toLowerCase()).toContain("harness");
    expect(t).toContain("upstream.md");
    // it must still preserve the prior reflector discipline (placeholders + conciseness rule)
    expect(t).toMatch(/CONCISE/);
  });

  it("isolated + drift sentinel: every NON-reflector prompt is byte-identical to the committed baseline", () => {
    // A real byte-comparison (not just 'doesn't contain upstream.md'): hash every non-reflector role's
    // prompt and compare to the frozen digest. ANY change to a non-reflector prompt — the upstream-reflect
    // clause leaking elsewhere, or unrelated drift slipping into this change — flips the digest and fails.
    // If you INTENTIONALLY edit a non-reflector prompt later, regenerate this digest the same way and
    // update the literal below (the failure makes the change explicit rather than silent).
    const roles = Object.keys(DEFAULT_PROMPTS).filter((r) => r !== "reflector").sort();
    const h = createHash("sha256");
    for (const r of roles) h.update(r + " " + DEFAULT_PROMPTS[r]! + " ");
    expect(roles).toHaveLength(11);
    expect(h.digest("hex")).toBe("2af57e8b1ec0ca0ae290bf081eece74bb2ea44df062778c78854173ea5eb8bc9");
    // and the new sink token lives in the reflector ONLY
    for (const [role, text] of Object.entries(DEFAULT_PROMPTS)) {
      if (role !== "reflector") expect(text).not.toContain("upstream.md");
    }
  });
});

// ───────────────────────── cmdReflect --upstream (read/triage, NO model) ─────────────────────────

describe("cmdReflect --upstream — read & archive (runs no model session)", () => {
  // The call-count==0 assertions below are only meaningful if a FALLTHROUGH into the normal reflect
  // path WOULD invoke the session. So seed a valid run + trace: the read mode must early-return BEFORE
  // that — if it fell through, the seeded run would reach runSession and the call count would be 1.
  function seedRunnableReflect(ctx: Ctx): void {
    const runId = "build-seeded";
    ctx.store.data.build.runId = runId;
    seedTrace(ctx, runId);
  }

  it("prints the accumulated inbox files and runs NO session", async () => {
    withTempHome();
    await routeUpstreamFinding("projA", "reflect-1", "finding A");
    await routeUpstreamFinding("projB", "reflect-2", "finding B");
    const { ctx, dir } = await ctxFor();
    seedRunnableReflect(ctx);
    const cap = captureStdout();
    try {
      const rec = recorder();
      await cmdReflect(ctx, { upstream: true, runSessionFn: rec.fn });
      expect(rec.calls).toHaveLength(0); // HARD: read path early-returns; no fallthrough into the session
      expect(cap.buf()).toContain("finding A");
      expect(cap.buf()).toContain("finding B");
      expect(inboxFiles()).toHaveLength(2); // not cleared
    } finally {
      cap.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--clear archives the files after printing (inbox emptied, archive populated), NO session", async () => {
    const home = withTempHome();
    await routeUpstreamFinding("projA", "reflect-1", "finding A");
    await routeUpstreamFinding("projB", "reflect-2", "finding B");
    const { ctx, dir } = await ctxFor();
    seedRunnableReflect(ctx);
    const cap = captureStdout();
    try {
      const rec = recorder();
      await cmdReflect(ctx, { upstream: true, clear: true, runSessionFn: rec.fn });
      expect(rec.calls).toHaveLength(0);
      expect(cap.buf()).toContain("finding A");
      expect(inboxFiles()).toHaveLength(0); // inbox emptied
      const archive = path.join(home, "reflections", "archive");
      expect(fs.readdirSync(archive).filter((f) => f.endsWith(".md"))).toHaveLength(2); // archive populated
    } finally {
      cap.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an EMPTY inbox warns and is a no-op (no session, no throw)", async () => {
    withTempHome();
    const { ctx, dir } = await ctxFor();
    seedRunnableReflect(ctx);
    const cap = captureStdout();
    try {
      const rec = recorder();
      await cmdReflect(ctx, { upstream: true, runSessionFn: rec.fn });
      expect(rec.calls).toHaveLength(0); // even on an empty inbox, the read path must not fall through
      expect(cap.buf()).toMatch(/empty inbox/i);
    } finally {
      cap.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the archive/ subdir is NOT itself listed as a reflection (only *.md files)", async () => {
    const home = withTempHome();
    await routeUpstreamFinding("projA", "reflect-1", "finding A");
    fs.mkdirSync(path.join(home, "reflections", "archive"), { recursive: true });
    expect(inboxFiles()).toEqual(expect.arrayContaining([])); // sanity
    expect(inboxFiles().every((f) => f.endsWith(".md"))).toBe(true);
    expect(inboxFiles()).toHaveLength(1); // the dir is excluded
  });
});
