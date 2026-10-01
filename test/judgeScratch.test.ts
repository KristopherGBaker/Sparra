import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config.ts";
import {
  detectJudgeStack,
  hasAppleMarker,
  UNKNOWN_JUDGE_STACK,
  JUDGE_SCRATCH_ENV_KEYS,
  judgeScratchEnvLayer,
  judgeSandboxEnv,
  createJudgeScratch,
  sandboxCapabilityNotes,
  sandboxCapabilityNotesText,
  judgeCapabilityNotesText,
  judgeWriteScratchText,
  runnerLimitations,
  runnerLimitationsText,
  type JudgeSandboxMode,
} from "../src/build/judgeScratch.ts";

/**
 * The existing matrix assertions describe a Node/vitest project's judge — that is what the notes are
 * ABOUT. Stack detection now decides which of them are emitted, so the fixture has to say so; a
 * Swift/iOS project gets none of it (see the stack-conditioning describe at the end of this file).
 */
const VITEST_STACK = { node: true, vitest: true, judgeSandboxSeam: true, apple: false } as const;

/** An on-disk Node/vitest workspace, so `judgeCapabilityNotesText` DETECTS the stack rather than
 *  being told — the detection is the thing under test for the stack-conditioning cases below. */
const NODE_WS = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-judgestack-node-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ devDependencies: { vitest: "^3" } }));
  fs.mkdirSync(path.join(dir, "test/helpers"), { recursive: true });
  fs.writeFileSync(path.join(dir, "test/helpers/judgeEnv.ts"), "process.env.SPARRA_JUDGE_SANDBOX;\n");
  return dir;
})();

describe("judgeScratch — default writable-scratch env layer", () => {
  it("redirects TMPDIR, clang, and SwiftPM caches all UNDER the scratch root", () => {
    const scratch = "/tmp/sprj-abc";
    const layer = judgeScratchEnvLayer(scratch);
    // The three EPERM-prone roots the reflect findings name.
    expect(Object.keys(layer).sort()).toEqual([...JUDGE_SCRATCH_ENV_KEYS].sort());
    expect(layer.TMPDIR).toBeDefined();
    expect(layer.CLANG_MODULE_CACHE_PATH).toBeDefined();
    expect(layer.SWIFTPM_CACHE_DIR).toBeDefined();
    for (const key of JUDGE_SCRATCH_ENV_KEYS) {
      const rel = path.relative(scratch, layer[key]!);
      expect(rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))).toBe(true); // strictly under scratch
    }
  });

  it("(1a) empty build.env ⇒ default scratch keys are still present, process.env preserved", () => {
    const cfg = defaultConfig();
    cfg.build.env = {};
    const scratch = createJudgeScratch();
    try {
      const env = judgeSandboxEnv(cfg, scratch, { PATH: "/usr/bin", HOME: "/home/me" } as NodeJS.ProcessEnv);
      for (const key of JUDGE_SCRATCH_ENV_KEYS) {
        expect(env[key]?.startsWith(scratch)).toBe(true);
      }
      // (1c) unrelated process.env survives.
      expect(env.PATH).toBe("/usr/bin");
      expect(env.HOME).toBe("/home/me");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("(1b) a colliding user build.env key WINS over the default scratch value", () => {
    const cfg = defaultConfig();
    cfg.build.env = { TMPDIR: "/my/own/tmp", EXTRA: "1" };
    const scratch = "/tmp/sprj-xyz";
    const env = judgeSandboxEnv(cfg, scratch, {} as NodeJS.ProcessEnv);
    expect(env.TMPDIR).toBe("/my/own/tmp"); // user override beats default
    expect(env.EXTRA).toBe("1");
    // The non-colliding defaults still land under scratch.
    expect(env.CLANG_MODULE_CACHE_PATH?.startsWith(scratch)).toBe(true);
    expect(env.SWIFTPM_CACHE_DIR?.startsWith(scratch)).toBe(true);
  });

  it("(2) createJudgeScratch makes a real, writable dir with every env value pointing inside it", () => {
    const scratch = createJudgeScratch();
    try {
      expect(fs.existsSync(scratch)).toBe(true);
      const layer = judgeScratchEnvLayer(scratch);
      for (const key of JUDGE_SCRATCH_ENV_KEYS) {
        const target = layer[key]!;
        expect(target.startsWith(scratch)).toBe(true);
        expect(fs.existsSync(target)).toBe(true); // sub-dir created up front
        // actually writable
        const probe = path.join(target, "probe.txt");
        fs.writeFileSync(probe, "ok");
        expect(fs.readFileSync(probe, "utf8")).toBe("ok");
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("keeps the added scratch prefix short (tsx builds a Unix-domain socket UNDER TMPDIR)", () => {
    // tsx's IPC socket is join(tmpdir, `tsx-<uid>`, `<pid>.pipe`); OUR added prefix on top of
    // os.tmpdir() must stay small so it doesn't blow the ~104-char sun_path limit. We can't control
    // os.tmpdir()'s length, so we bound only what we add: `sprj-<8hex>/tmp`.
    const scratch = createJudgeScratch();
    try {
      const added = path.relative(os.tmpdir(), judgeScratchEnvLayer(scratch).TMPDIR!);
      expect(added.length).toBeLessThanOrEqual(20); // sprj-<8hex>/tmp
      expect(path.basename(scratch)).toMatch(/^sprj-[0-9a-f]{8}$/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("sandboxCapabilityNotes — KNOWN sandbox-capability matrix (pure)", () => {
  const codex = (mode: JudgeSandboxMode, scratchEnabled = mode === "workspace-write") =>
    sandboxCapabilityNotes({ backendId: "codex", hasOsSandbox: true, sandboxMode: mode, scratchEnabled , stack: VITEST_STACK });

  it("Codex read-only AND workspace-write both deny unix-domain-socket LISTEN", () => {
    for (const mode of ["read-only", "workspace-write"] as const) {
      const caps = codex(mode);
      expect(caps.map((c) => c.capability)).toContain("unix-domain-socket-listen");
      const uds = caps.find((c) => c.capability === "unix-domain-socket-listen")!;
      // Evidence must cite the policy-deny nature (not path writability) and the socket path.
      expect(uds.detail.toLowerCase()).toMatch(/policy/);
      expect(uds.detail.toLowerCase()).toMatch(/writable scratch tmpdir/);
    }
  });

  it("the UDS-listen deny is INDEPENDENT of scratchEnabled (path writability never lifts it)", () => {
    // Same verdict whether or not the writable-scratch layer is active — the deny is policy, not path.
    const withScratch = codex("read-only", true);
    const withoutScratch = codex("read-only", false);
    expect(withScratch.map((c) => c.capability)).toEqual(withoutScratch.map((c) => c.capability));
    expect(withoutScratch.map((c) => c.capability)).toContain("unix-domain-socket-listen");
  });

  it("a no-OS-sandbox backend (Claude judge) gets NO notes", () => {
    for (const mode of ["read-only", "workspace-write", "danger-full-access"] as const) {
      expect(
        sandboxCapabilityNotes({ backendId: "claude", hasOsSandbox: false, sandboxMode: mode, scratchEnabled: false , stack: VITEST_STACK })
      ).toEqual([]);
    }
  });

  it("a fully-lifted sandbox (danger-full-access) restores socket listen → NO notes", () => {
    expect(codex("danger-full-access", true)).toEqual([]);
  });

  it("renders CLASSIFY-don't-reprove text with UN-RUN / one-probe / no-multi-round instruction", () => {
    const text = sandboxCapabilityNotesText(codex("read-only"), VITEST_STACK);
    expect(text).toMatch(/unix-domain-socket-listen/);
    expect(text).toMatch(/environment-blocked \/ UN-RUN/);
    expect(text.toLowerCase()).toMatch(/not an? artifact fail|it is not an artifact fail/i);
    expect(text.toUpperCase()).toMatch(/AT MOST ONE/);
    expect(text.toLowerCase()).toMatch(/do not re-prove/);
    // Cite: a live harness-side probe is impossible.
    expect(text.toLowerCase()).toMatch(/harness runs outside your sandbox|live harness-side probe is impossible/);
  });

  it("renders NO sandbox-policy section when nothing is policy-denied, but still the runner-limits block (Claude judge)", () => {
    // The runner CPU-saturation flake is LOAD, not a sandbox-policy deny, so it renders even with []
    // caps — a no-OS-sandbox Claude judge is NOT left with an empty injected block.
    const emptyCaps = sandboxCapabilityNotesText([], VITEST_STACK);
    expect(emptyCaps).not.toBe("");
    expect(emptyCaps).not.toMatch(/KNOWN SANDBOX CAPABILITY LIMITS/); // no policy section
    expect(emptyCaps).toMatch(/KNOWN RUNNER LIMITS/); // runner-limits section present
    const claude = judgeCapabilityNotesText({
      backendId: "claude",
      hasOsSandbox: false,
      sandboxMode: "read-only",
      scratchEnabled: false,
      workspaceDir: NODE_WS,
    });
    expect(claude).toBe(emptyCaps); // Claude judge == the []-caps render
  });

  it("judgeCapabilityNotesText composes matrix + render for a sandboxed judge", () => {
    const text = judgeCapabilityNotesText({
      backendId: "codex",
      hasOsSandbox: true,
      sandboxMode: "workspace-write",
      scratchEnabled: true,
      workspaceDir: NODE_WS,
    });
    expect(text).toMatch(/unix-domain-socket-listen/);
    expect(text).toMatch(/UN-RUN/);
  });

  it("names SPARRA_JUDGE_SANDBOX and states the full suite is expected green / nonzero exit = real signal", () => {
    // Assertion 12: under the flag, socket suites SKIP, so a nonzero full-suite exit is a REAL signal.
    const text = judgeCapabilityNotesText({
      backendId: "codex",
      hasOsSandbox: true,
      sandboxMode: "workspace-write",
      scratchEnabled: true,
      workspaceDir: NODE_WS,
    });
    expect(text).toContain("SPARRA_JUDGE_SANDBOX=1");
    expect(text.toUpperCase()).toMatch(/EXPECTED green/i);
    expect(text.toUpperCase()).toMatch(/REAL (ARTIFACT )?SIGNAL/);
    // The same forward-looking note reaches a read-only judge too (the flag applies to the full suite).
    expect(sandboxCapabilityNotesText(codex("read-only"), VITEST_STACK)).toContain("SPARRA_JUDGE_SANDBOX=1");
  });

  describe("vitest-vite-temp-write entry", () => {
    it("is PRESENT for read-only + hasOsSandbox=true, regardless of scratchEnabled", () => {
      for (const scratchEnabled of [true, false]) {
        const caps = sandboxCapabilityNotes({ backendId: "codex", hasOsSandbox: true, sandboxMode: "read-only", scratchEnabled , stack: VITEST_STACK });
        expect(caps.map((c) => c.capability)).toContain("vitest-vite-temp-write");
        const entry = caps.find((c) => c.capability === "vitest-vite-temp-write")!;
        // Detail must cite the concrete path so a presence-only stub cannot pass.
        expect(entry.detail).toMatch(/node_modules\/.vite-temp/);
        // Must instruct judge to classify as sandbox limit, not code FAIL.
        expect(entry.detail.toLowerCase()).toMatch(/un-run|environment-blocked/);
        expect(entry.detail.toLowerCase()).toMatch(/not a code fail/);
      }
    });

    it("is ABSENT for workspace-write (writes to checkout are allowed)", () => {
      const caps = sandboxCapabilityNotes({ backendId: "codex", hasOsSandbox: true, sandboxMode: "workspace-write", scratchEnabled: true , stack: VITEST_STACK });
      expect(caps.map((c) => c.capability)).not.toContain("vitest-vite-temp-write");
    });

    it("is ABSENT with no OS sandbox (Claude judge)", () => {
      const caps = sandboxCapabilityNotes({ backendId: "claude", hasOsSandbox: false, sandboxMode: "read-only", scratchEnabled: false , stack: VITEST_STACK });
      expect(caps.map((c) => c.capability)).not.toContain("vitest-vite-temp-write");
    });

    it("is ABSENT for danger-full-access", () => {
      const caps = sandboxCapabilityNotes({ backendId: "codex", hasOsSandbox: true, sandboxMode: "danger-full-access", scratchEnabled: true , stack: VITEST_STACK });
      expect(caps.map((c) => c.capability)).not.toContain("vitest-vite-temp-write");
    });

    it("appears in rendered text for read-only judge under the same header", () => {
      const text = judgeCapabilityNotesText({ backendId: "codex", hasOsSandbox: true, sandboxMode: "read-only", scratchEnabled: false , workspaceDir: NODE_WS });
      expect(text).toMatch(/vitest-vite-temp-write/);
      expect(text).toMatch(/node_modules\/.vite-temp/);
      // Rendered under the same KNOWN SANDBOX CAPABILITY LIMITS header.
      expect(text).toMatch(/KNOWN SANDBOX CAPABILITY LIMITS/);
    });

    it("does NOT appear in rendered text for workspace-write judge", () => {
      const text = judgeCapabilityNotesText({ backendId: "codex", hasOsSandbox: true, sandboxMode: "workspace-write", scratchEnabled: true , workspaceDir: NODE_WS });
      expect(text).not.toMatch(/vitest-vite-temp-write/);
      // UDS entry is still present for workspace-write.
      expect(text).toMatch(/unix-domain-socket-listen/);
    });
  });
});

describe("runnerLimitations — vitest worker/reporter-RPC CPU-saturation flake (pure)", () => {
  const render = (args: { hasOsSandbox: boolean; sandboxMode: JudgeSandboxMode; backendId?: string }) =>
    judgeCapabilityNotesText({
      backendId: args.backendId ?? (args.hasOsSandbox ? "codex" : "claude"),
      hasOsSandbox: args.hasOsSandbox,
      sandboxMode: args.sandboxMode,
      scratchEnabled: args.sandboxMode === "workspace-write",
      workspaceDir: NODE_WS,
    });

  it("(matrix) exposes the vitest-worker-rpc-timeout entry, backend/sandbox-independent", () => {
    const ids = runnerLimitations(VITEST_STACK).map((l) => l.id);
    expect(ids).toContain("vitest-worker-rpc-timeout");
    // Pure + deterministic: same call → same strings (assertion 8), no env/fs setup.
    expect(runnerLimitations(VITEST_STACK)).toEqual(runnerLimitations(VITEST_STACK));
    expect(runnerLimitationsText(VITEST_STACK)).toBe(runnerLimitationsText(VITEST_STACK));
  });

  // Assertion 1: the Claude (no-OS-sandbox) rendered block is NON-empty and carries the full note.
  it("(assertion 1) Claude judge block is non-empty and carries the complete flake note", () => {
    const text = render({ hasOsSandbox: false, sandboxMode: "read-only" });
    expect(text).not.toBe("");
    expect(text).toContain('Timeout calling "onTaskUpdate"');
    expect(text).toContain("onCollected");
    // zero-failing-assertions signature clause
    expect(text).toMatch(/ZERO (individual failing assertions|failing test ASSERTIONS)/);
    // CPU-saturation attribution
    expect(text).toMatch(/CPU saturation/);
    // environment / UN-RUN classification, conditioned on the COMPLETE signature + passing isolation rerun
    expect(text).toMatch(/environment \/ UN-RUN/);
    expect(text).toMatch(/COMPLETE signature[\s\S]*PASSING isolation rerun/);
    // never/not an artifact FAIL
    expect(text).toMatch(/NEVER an artifact FAIL|not an artifact FAIL/i);
    // re-run-in-isolation confirmation step
    expect(text).toMatch(/RE-RUNNING the aborted file\(s\) IN ISOLATION/);
  });

  // Assertion 15: negative clause — a failing isolation rerun does NOT satisfy the carve-out.
  it("(assertion 15) states the negative: a failing isolation rerun remains an artifact signal", () => {
    const text = render({ hasOsSandbox: false, sandboxMode: "read-only" });
    expect(text).toMatch(
      /isolation rerun that produces a REAL assertion failure \/ nonzero result does NOT satisfy the carve-out and REMAINS an artifact signal/
    );
  });

  // Assertion 6: concurrent-probe alignment.
  it("(assertion 6) aligns the concurrent-load probe onto focused/diff-touched suites", () => {
    const text = render({ hasOsSandbox: false, sandboxMode: "read-only" });
    expect(text).toMatch(/FOCUSED \/ diff-touched suites/);
    expect(text).toMatch(/NOT a second simultaneous FULL suite/i);
  });

  // Assertion 2: contrast — the Claude block has NO sandbox-policy rows.
  it("(assertion 2) Claude judge block has neither sandbox-policy row", () => {
    const text = render({ hasOsSandbox: false, sandboxMode: "read-only" });
    expect(text).not.toContain("unix-domain-socket-listen");
    expect(text).not.toContain("vitest-vite-temp-write");
  });

  // Assertion 3: the flake entry reaches every OS-sandboxed shape alongside the UDS row.
  it("(assertion 3) codex read-only + workspace-write carry BOTH the flake and the UDS row; danger-full-access carries the flake", () => {
    for (const mode of ["read-only", "workspace-write"] as const) {
      const text = render({ hasOsSandbox: true, sandboxMode: mode });
      expect(text).toContain("vitest-worker-rpc-timeout");
      expect(text).toContain("unix-domain-socket-listen");
    }
    const danger = render({ hasOsSandbox: true, sandboxMode: "danger-full-access" });
    expect(danger).toContain("vitest-worker-rpc-timeout");
    expect(danger).not.toContain("unix-domain-socket-listen"); // fully-lifted → no policy rows
  });

  // Assertion 5: the block-level "REAL artifact signal" sentence is explicitly scoped, and the
  // exception clause co-renders in the SAME block as the byte-frozen UDS row for an OS-sandboxed judge.
  it("(assertion 5) scopes the REAL-artifact-signal sentence with an RPC-timeout EXCEPTION in the same block as the UDS row", () => {
    const text = render({ hasOsSandbox: true, sandboxMode: "read-only" });
    // The UDS row (byte-frozen real-signal sentence) co-renders with the exception clause.
    expect(text).toContain("unix-domain-socket-listen");
    // regex spanning "REAL artifact signal" → EXCEPTION → the signature.
    expect(text).toMatch(/REAL artifact signal[\s\S]*EXCEPTION[\s\S]*Timeout calling "onTaskUpdate"/);
  });
});

// ── Field report 2026-09-14 (Sarukani, Swift/iOS): the contract-evaluator prompt carried a block
// about `net.createServer().listen()`, "a tsx-launched CLI smoke that IPCs over a .pipe", vitest's
// `Timeout calling "onTaskUpdate"`, and what SPARRA_JUDGE_SANDBOX=1 makes vitest do. That project has
// no Node, no vitest and no tsx; its gates are `make verify`, `xcodebuild` and `swift test`. ────────
describe("judge capability notes — conditional on the graded project's stack", () => {
  function project(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-stack-"));
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    return dir;
  }
  const NODE_TERMS = ["vitest", "tsx", "onTaskUpdate", "SPARRA_JUDGE_SANDBOX", ".pipe", "node_modules"];
  const notes = (workspaceDir: string, backendId = "codex") =>
    judgeCapabilityNotesText({
      backendId,
      hasOsSandbox: backendId === "codex",
      sandboxMode: "workspace-write",
      scratchEnabled: true,
      workspaceDir,
    });

  it("emits NO Node-ecosystem instructions for a Swift project", () => {
    const swift = project({
      "Package.swift": "// swift-tools-version:6.0\n",
      "Makefile": "verify:\n\tswift test\n",
    });
    const text = notes(swift);
    for (const term of NODE_TERMS) expect(text).not.toContain(term);
    // The socket-policy deny is a SANDBOX fact, not a Node one, so a sandboxed judge still gets it —
    // phrased for any stack, and without the "full suite is EXPECTED green" promise, which would be
    // a false statement about a suite that never reads the flag.
    expect(text).toContain("unix-domain-socket-listen");
    expect(text).toContain("UN-RUN");
    expect(text).not.toMatch(/KNOWN RUNNER LIMITS/);
    fs.rmSync(swift, { recursive: true, force: true });
  });

  it("emits no stack-specific note AT ALL for a Swift project on a no-OS-sandbox backend", () => {
    const swift = project({ "Package.swift": "// swift-tools-version:6.0\n" });
    const text = notes(swift, "claude");
    // No sandbox-policy rows (no OS sandbox) and no runner limits (not vitest) — nothing is CLAIMED
    // about this stack. The write-scratch note is stack-INDEPENDENT (it is about the integrity guard,
    // which is armed on exactly this writable-judge path) and is the one block that remains.
    expect(text.replace(judgeWriteScratchText(), "")).toBe("");
    expect(text).toContain("WRITABLE SCRATCH");
    fs.rmSync(swift, { recursive: true, force: true });
  });

  it("keeps the full block for a vitest project that actually wires the flag", () => {
    const node = project({
      "package.json": JSON.stringify({ devDependencies: { vitest: "^3" } }),
      "test/helpers/judgeEnv.ts": "process.env.SPARRA_JUDGE_SANDBOX;\n",
    });
    const text = notes(node);
    expect(text).toContain('Timeout calling "onTaskUpdate"');
    expect(text).toContain("SPARRA_JUDGE_SANDBOX=1");
    expect(text).toContain("EXPECTED green");
    fs.rmSync(node, { recursive: true, force: true });
  });

  it("withholds the expected-green PROMISE from a vitest project that does NOT wire the flag", () => {
    // The flag is set on every judge session; the SKIP only happens if the suite implements it.
    const node = project({ "package.json": JSON.stringify({ devDependencies: { vitest: "^3" } }) });
    const text = notes(node);
    expect(text).toContain('Timeout calling "onTaskUpdate"'); // the runner flake is still real here
    expect(text).not.toContain("EXPECTED green");
    expect(text).not.toContain("SPARRA_JUDGE_SANDBOX=1");
    fs.rmSync(node, { recursive: true, force: true });
  });

  it("detects the stack from evidence, not from configuration", () => {
    const bare = project({ "README.md": "# thing\n" });
    expect(detectJudgeStack(bare)).toEqual({ node: false, vitest: false, judgeSandboxSeam: false, apple: false });
    const viaConfig = project({ "package.json": "{}", "vitest.config.ts": "export default {};\n" });
    expect(detectJudgeStack(viaConfig)).toMatchObject({ node: true, vitest: true });
    expect(detectJudgeStack("/nonexistent/path")).toEqual(UNKNOWN_JUDGE_STACK);
    fs.rmSync(bare, { recursive: true, force: true });
    fs.rmSync(viaConfig, { recursive: true, force: true });
  });

  it("detects a Swift/Xcode project from a marker at the root or up to two levels below", () => {
    const cases: Array<[Record<string, string>, boolean]> = [
      [{ "Package.swift": "// swift-tools-version:6.0\n" }, true],
      [{ "project.yml": "name: App\n" }, true],
      [{ "App.xcodeproj/project.pbxproj": "" }, true],
      [{ "App.xcworkspace/contents.xcworkspacedata": "" }, true],
      [{ "Apps/Reader/project.yml": "name: Reader\n" }, true], // two levels down (Sumi's layout)
      [{ "a/b/c/Package.swift": "" }, false], // three levels down: out of range
      [{ "node_modules/pkg/Package.swift": "" }, false], // dependency dirs are not the project
      [{ ".build/checkouts/Package.swift": "" }, false], // hidden dirs are skipped
      [{ "README.md": "# thing\n" }, false],
    ];
    for (const [files, expected] of cases) {
      const dir = project(files);
      expect(hasAppleMarker(dir), JSON.stringify(files)).toBe(expected);
      expect(detectJudgeStack(dir).apple, JSON.stringify(files)).toBe(expected);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(hasAppleMarker("/nonexistent/path")).toBe(false);
  });
});


// ── Field report 2026-09-15 (Sarukani): an evaluator wrote `EvaluatorAdversarialTests.swift` into
// the artifact tree during grading. The guard caught it, reverted it, and marked its own verdict
// untrustworthy — exactly as designed. The gap is upstream: writing an adversarial probe is a
// valuable thing for a judge to do (a later evaluator on that project found a real data-loss defect
// with a round-trip test), and nothing ever told it where its writable scratch was. ────────────────
describe("judge write-scratch note — the artifact is off limits AND there is somewhere else", () => {
  it("names the scratch, the consequence of ignoring it, and the copy-the-tree route for a probe", () => {
    const t = judgeWriteScratchText();
    expect(t).toContain("$TMPDIR"); // where
    expect(t).toContain("mktemp -d"); // how
    expect(t).toContain("INTEGRITY-GUARDED"); // why it matters
    expect(t).toContain("COPY the tree"); // the route for a probe that must compile in-package
  });

  it("reaches a judge that can actually write, on either writable mode and either backend", () => {
    for (const sandboxMode of ["workspace-write", "danger-full-access"] as JudgeSandboxMode[]) {
      for (const [backendId, hasOsSandbox] of [["codex", true], ["claude", false]] as const) {
        expect(
          judgeCapabilityNotesText({ backendId, hasOsSandbox, sandboxMode, scratchEnabled: true })
        ).toContain("WRITABLE SCRATCH");
      }
    }
  });

  it("is omitted for a read-only judge — its writes are blocked anyway, so the paragraph is noise", () => {
    expect(
      judgeCapabilityNotesText({ backendId: "codex", hasOsSandbox: true, sandboxMode: "read-only", scratchEnabled: false })
    ).not.toContain("WRITABLE SCRATCH");
  });
});
