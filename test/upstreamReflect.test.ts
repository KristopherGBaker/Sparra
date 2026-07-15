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
import { loadInbox } from "../src/phases/upstreamTriage.ts";
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
  // The logger is silenced under vitest; lift the gate via the documented escape hatch while capturing.
  const priorLogInTests = process.env.SPARRA_LOG_IN_TESTS;
  process.env.SPARRA_LOG_IN_TESTS = "1";
  let buf = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
  return {
    buf: () => buf,
    restore: () => {
      spy.mockRestore();
      if (priorLogInTests === undefined) delete process.env.SPARRA_LOG_IN_TESTS;
      else process.env.SPARRA_LOG_IN_TESTS = priorLogInTests;
    },
  };
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
    // it must still preserve the prior reflector discipline (the low-redundancy/readability rule)
    expect(t).toMatch(/LOW-REDUNDANCY AND READABLE/);
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
    expect(roles).toHaveLength(14);
    // Regenerated 2026-07-06 (capability-gap cycle): prompt-auditor now audits for READABILITY
    // (not just terseness); contract-generator gained the mandated-side-effects, monotonic-floor,
    // and reset/clear degenerate-test clauses; the generator gained the monotonic-floor + reset/clear
    // probe clauses (folded reflect lessons from the capability-gap cycle).
    // Regenerated 2026-07-06 (U1 backend-aware exercise wiring): the evaluator PROCESS-step run-
    // instruction is now a {{EXERCISE_RUN_INSTRUCTION}} placeholder (backend-aware), replacing the
    // hard-coded `mcp__exercise__run_command` sentence — so a no-inProcessMcp evaluator carries no
    // phantom mandate in its STATIC template.
    // Regenerated 2026-07-06 (prompt-fold cycle): folded 6 reflect-earned lessons into DEFAULT_PROMPTS —
    // contract-evaluator (guard-evasion enumeration = every grammar element the carve-out touches;
    // batch every mandatory clause in round 1), evaluator (GUARD/ALLOW-DENY SURFACES probe-in-round-1;
    // env-blocked gate never alone a FAIL), generator (guard-arg/left-prefix adversaries; fix-brief vs
    // agreed-contract precedence; emit report JSON as gates verify).
    // Regenerated 2026-07-06 (0706b/0706c prompt-fold): folded the 8 locally-applied reflect lessons
    // from .sparra/prompts back into DEFAULT_PROMPTS — contract-generator + contract-evaluator
    // (stale-claim sweep for widened shipped behavior; retry/recover output gated by the SAME
    // validation + garbage-retry negative; judge-sandbox-denied gates unsatisfiable), generator
    // (load-reliable gating suites; stub side-effectful calls in pre-existing test paths; don't
    // end-load doc/version sweeps), evaluator (exerciseStatus reflects contract gates, not own probes).
    // Regenerated 2026-07-06 (U-L load-determinism): the EVALUATOR prompt gained the concurrent-load
    // determinism clause — folded into the FLAKY rule (rule 1) and PROCESS step 1 (a full-suite gate
    // is run once quietly AND once under a concurrently-running suite instance; a load-only timeout is
    // an ARTIFACT defect, not environmental), mirroring the generator's existing clause. To regenerate
    // this literal after the edit: run the suite (or `npx tsx -e`) to print the SHA-256 over every
    // sorted non-reflector role's `role + " " + prompt + " "` and paste it below.
    // Regenerated 2026-07-06 (loop-0706e prompt-fold): folded 5 reflect-earned lessons into
    // DEFAULT_PROMPTS — generator (grep EVERY call site when threading a shared signal; re-ask
    // report is tool-free plain text), evaluator (verify pre-existing-failure carveouts against the
    // baseline; exactly one assertions entry per contract id), contract-evaluator (a shared-signal
    // fix must enumerate ALL call sites + require an observable per consumer).
    // Regenerated 2026-07-07 (U-REC recurrence-weighted inbox): only the reflector prompt changed
    // (materiality bar + RECURRENCE-OF clause added). The hash over non-reflector prompts changed
    // from the previous sentinel because earlier 0707a/0707b cycles folded additional lessons into
    // non-reflector prompts (e.g. generator allowVerifyBash) without bumping this sentinel — those
    // cycles had a stale sentinel. This update regenerates it from the current worktree state.
    // To regenerate: run the suite; the received hash in the failure IS the correct new value.
    // Regenerated 2026-07-09 (loop-0709 prompt-fold): folded 5 reflect-earned lessons into
    // DEFAULT_PROMPTS — evaluator (a violated UNNUMBERED contract clause / missed mandated sweep goes
    // in `blocking`, not notes, even on a pass), contract-evaluator (stale-claim sweep must land as a
    // NUMBERED zero-stale-hits assertion; explore from cwd via relative paths — root-anchored search is
    // blocked, an abs path from the repo name is permission-denied), generator (RUN the sweep grep — the
    // "known surfaces" list is a floor; a diff in a file Scope does NOT name needs a `deviations` entry).
    // Regenerated 2026-07-10 (codex-loop reflect prompt-fold): folded 3 reflect-earned lessons into
    // DEFAULT_PROMPTS — contract-evaluator (a "cd <elsewhere> && …" prefix is denied as a multi-op
    // escape so run bare relative commands; ".sparra/" is outside this role's read scope, so a
    // plan-cited artifact there is unavailable — judge without it; an inline "node -e"/"python -c"
    // snippet is a command too, EXECUTE it verbatim; numeric test-count baselines are MEASURED, use a
    // "count ≥ N" floor and never report an unexecuted command as confirmed runnable) and evaluator
    // (a broken CONTRACT transcription of a check, while the shipped command runs clean and nothing
    // broken is committed, is contract trivia — run the working form, don't fail the artifact).
    // Regenerated 2026-07-10 (holdout-safe root search): contract-evaluator guidance now permits
    // selective filename Globs while retaining the protected-target and unfiltered-root denials.
    // Regenerated 2026-07-13 (U2 conduct-brain): a NEW non-reflector prompt — `conductor` — was added
    // to DEFAULT_PROMPTS (the `sparra conduct` hybrid/llm brain), so the sorted non-reflector set grew
    // from 13 to 14 and this digest changed. No existing prompt was edited.
    // Regenerated 2026-07-13 (U2 argv-acceptance fold): the CONTRACT-GENERATOR prompt's DEFEAT
    // DEGENERATE/NO-OP bullet gained the argv-acceptance-test requirement (produced argv must be
    // ACCEPTED by the real parser/validation layer, not merely flag-content-asserted), so the hash
    // over non-reflector prompts changed. Only that one existing prompt was edited (no new prompt).
    // Regenerated 2026-07-13 (four-finding reflect fold): folded four 2026-07-13 reflect findings into
    // DEFAULT_PROMPTS — contract-generator (JUDGE-RUNNABLE FORM bullet; closed-rule for flag-compat;
    // shell-portable/worktree-relative verify snippets), contract-evaluator (closed-rule standard;
    // UN-RUN blast-radius cap; check shell snippets under real shell semantics — zsh-reserved `status`,
    // fail-fast, no MAIN-checkout `cd`/abs path), evaluator (FLAKY documented-env-denial EXCEPTION +
    // PROCESS step-1 "unless rule 1's documented-env-denial exception applies" rewording). Three
    // existing prompts edited; no new prompt.
    // Regenerated 2026-07-15 (worker-RPC-timeout carve-out): the EVALUATOR FLAKY rule now distinguishes
    // a genuine load-only artifact defect from the test RUNNER's OWN worker/reporter-RPC timeout (vitest
    // `Timeout calling "onTaskUpdate"`/`onCollected`, zero failing assertions) — the latter is runner CPU
    // saturation (a concurrent probe OR a constrained/few-core eval worktree), NOT an artifact defect, and
    // is confirmed by re-running the aborted file(s) in isolation rather than failing the artifact. One
    // existing prompt edited; no new prompt.
    // Regenerated 2026-07-15 (harness-owned git-lifecycle satisfiability): folded a commit/branch-
    // history/clean-tree/landing-state clause into the existing SATISFIABILITY guidance for BOTH
    // contract-generator (extends the "NEVER assert ABSENCE" bullet) and contract-evaluator (extends
    // the "SATISFIABILITY:" bullet to REJECT such assertions during negotiation) — the committer +
    // merge run AFTER acceptance, so contracts must gate on worktree CONTENT only. Two existing
    // prompts edited; no new prompt.
    expect(h.digest("hex")).toBe("2848dcc9071d2187a3f66ef02ed7b3193abc3c98b4d78ca9bf3f3d0e43256a97");
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

  it("listing shows ×N recurrence marker in the [index] title line (degenerate-proof ordering)", async () => {
    const home = withTempHome();
    const inboxDir = path.join(home, "reflections");
    fs.mkdirSync(inboxDir, { recursive: true });
    // Three findings with distinct recurrence counts: 3, 1, 2 (file order is 3→1→2)
    fs.writeFileSync(path.join(inboxDir, "a.md"), "### Finding A\n<!-- sparra-recurrence n=3 -->\nbody a\n");
    fs.writeFileSync(path.join(inboxDir, "b.md"), "### Finding B\nbody b\n"); // recurrence 1
    fs.writeFileSync(path.join(inboxDir, "c.md"), "### Finding C\n<!-- sparra-recurrence n=2 -->\nbody c\n");

    const { ctx, dir } = await ctxFor();
    const cap = captureStdout();
    try {
      await cmdReflect(ctx, { upstream: true });
      const out = cap.buf();
      // All three ×N markers present
      expect(out).toContain("×3");
      expect(out).toContain("×2");
      expect(out).toContain("×1");
      // Order: ×3 before ×2 before ×1 (NOT file order)
      expect(out.indexOf("×3")).toBeLessThan(out.indexOf("×2"));
      expect(out.indexOf("×2")).toBeLessThan(out.indexOf("×1"));
      // Global indices [1] [2] [3] appear in the output
      expect(out).toContain("[1]");
      expect(out).toContain("[2]");
      expect(out).toContain("[3]");
      // [1] appears before [2] before [3] in the output
      expect(out.indexOf("[1]")).toBeLessThan(out.indexOf("[2]"));
      expect(out.indexOf("[2]")).toBeLessThan(out.indexOf("[3]"));
    } finally {
      cap.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────── recurrence-aware routing ─────────────────────────

describe("routeUpstreamFinding — recurrence-aware routing", () => {
  it("routing recurrence: RECURRENCE-OF: <live title> → that finding's count bumps, NO duplicate/new file added", async () => {
    const home = withTempHome();
    const inboxDir = path.join(home, "reflections");
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, "first.md"), "### Existing Issue\nbody of existing issue\n");

    // upstream.md with RECURRENCE-OF tag matching the live finding
    const upstreamContent = "### Existing Issue Again\nRECURRENCE-OF: Existing Issue\nSame problem observed again\n";
    const result = await routeUpstreamFinding("proj", "stamp1", upstreamContent);

    // No new file — all were recurrences
    expect(result).toBeNull();
    expect(inboxFiles()).toHaveLength(1); // only "first.md"

    // The existing finding's counter bumped to 2
    const { findings } = await loadInbox(inboxDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.recurrence).toBe(2);
    expect(fs.readFileSync(path.join(inboxDir, "first.md"), "utf8")).toContain("<!-- sparra-recurrence n=2 -->");
  });

  it("routing new: unmatched/typo RECURRENCE-OF AND a genuinely-new finding → both written as new (count 1)", async () => {
    withTempHome();
    // No live findings at all — both sections are new
    const upstreamContent = "### Typo Recurrence\nRECURRENCE-OF: Nonexistent Title XYZ\nbody typo\n### Brand New\nbrand new body\n";
    const result = await routeUpstreamFinding("proj", "stamp2", upstreamContent);

    expect(result).not.toBeNull();
    const written = fs.readFileSync(result!, "utf8");
    expect(written).toContain("### Typo Recurrence");
    expect(written).toContain("### Brand New");
    expect(inboxFiles()).toHaveLength(1);
    // Neither bumped an existing finding (there was none)
  });

  it("archived-negative: RECURRENCE-OF a title present ONLY in archive/ → treated as NEW, no counter touched", async () => {
    const home = withTempHome();
    const inboxDir = path.join(home, "reflections");
    const archiveDir = path.join(inboxDir, "archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    // Write an archived finding (NOT in the live inbox)
    fs.writeFileSync(path.join(archiveDir, "old.md"), "### Archived Issue\nbody\n");
    const originalArchive = fs.readFileSync(path.join(archiveDir, "old.md"), "utf8");

    // Try to recur against the archived finding
    const upstreamContent = "### Archived Issue\nRECURRENCE-OF: Archived Issue\nSaw this again\n";
    const result = await routeUpstreamFinding("proj", "stamp3", upstreamContent);

    // Should be treated as NEW (live inbox was empty → no match)
    expect(result).not.toBeNull();
    expect(inboxFiles()).toHaveLength(1); // new finding written
    // Archive untouched
    expect(fs.readFileSync(path.join(archiveDir, "old.md"), "utf8")).toBe(originalArchive);
  });

  it("mixed: one recurrence + one new finding → only new finding written, existing counter bumped", async () => {
    const home = withTempHome();
    const inboxDir = path.join(home, "reflections");
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, "live.md"), "### Known Gap\nbody known\n");

    const upstreamContent = "### Known Gap Recurrence\nRECURRENCE-OF: Known Gap\nstill happening\n### Truly New\nnew finding body\n";
    const result = await routeUpstreamFinding("proj", "stamp4", upstreamContent);

    // One new file written (the new finding)
    expect(result).not.toBeNull();
    const written = fs.readFileSync(result!, "utf8");
    expect(written).toContain("### Truly New");
    expect(written).not.toContain("Known Gap Recurrence"); // recurrence not duplicated

    // Known Gap counter bumped
    const { findings } = await loadInbox(inboxDir);
    const known = findings.find((f) => f.title === "Known Gap");
    expect(known!.recurrence).toBe(2);
  });
});

// ───────────────────────── prompt injection: inbox titles ─────────────────────────

describe("cmdReflect task — inbox injection", () => {
  it("prompt injection: a non-empty inbox injects each live finding's title into the reflect prompt", async () => {
    const home = withTempHome();
    const inboxDir = path.join(home, "reflections");
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, "find.md"), "### My Harness Gap\ndetails about the gap\n");

    const { ctx, dir } = await ctxFor();
    try {
      const runId = "build-inject";
      seedTrace(ctx, runId);
      const rec = recorder();
      await cmdReflect(ctx, { run: runId, runSessionFn: rec.fn });
      const prompt = rec.calls[0]!.prompt;
      expect(prompt).toContain("My Harness Gap"); // title injected
      expect(prompt).toContain("RECURRENCE-OF"); // instruction injected
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prompt injection: an empty inbox injects nothing (behavior unchanged)", async () => {
    withTempHome(); // fresh empty home — no inbox findings

    const { ctx, dir } = await ctxFor();
    try {
      const runId = "build-empty-inject";
      seedTrace(ctx, runId);
      const rec = recorder();
      await cmdReflect(ctx, { run: runId, runSessionFn: rec.fn });
      const prompt = rec.calls[0]!.prompt;
      // No inbox list injected
      expect(prompt).not.toContain("CURRENT HARNESS INBOX");
      // Core upstream.md instruction still present (not removed)
      expect(prompt).toContain("upstream.md");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
