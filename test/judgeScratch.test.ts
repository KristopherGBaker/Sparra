import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config.ts";
import {
  JUDGE_SCRATCH_ENV_KEYS,
  judgeScratchEnvLayer,
  judgeSandboxEnv,
  createJudgeScratch,
  sandboxCapabilityNotes,
  sandboxCapabilityNotesText,
  judgeCapabilityNotesText,
  type JudgeSandboxMode,
} from "../src/build/judgeScratch.ts";

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
    sandboxCapabilityNotes({ backendId: "codex", hasOsSandbox: true, sandboxMode: mode, scratchEnabled });

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
        sandboxCapabilityNotes({ backendId: "claude", hasOsSandbox: false, sandboxMode: mode, scratchEnabled: false })
      ).toEqual([]);
    }
  });

  it("a fully-lifted sandbox (danger-full-access) restores socket listen → NO notes", () => {
    expect(codex("danger-full-access", true)).toEqual([]);
  });

  it("renders CLASSIFY-don't-reprove text with UN-RUN / one-probe / no-multi-round instruction", () => {
    const text = sandboxCapabilityNotesText(codex("read-only"));
    expect(text).toMatch(/unix-domain-socket-listen/);
    expect(text).toMatch(/environment-blocked \/ UN-RUN/);
    expect(text.toLowerCase()).toMatch(/not an? artifact fail|it is not an artifact fail/i);
    expect(text.toUpperCase()).toMatch(/AT MOST ONE/);
    expect(text.toLowerCase()).toMatch(/do not re-prove/);
    // Cite: a live harness-side probe is impossible.
    expect(text.toLowerCase()).toMatch(/harness runs outside your sandbox|live harness-side probe is impossible/);
  });

  it("renders EMPTY text when nothing is denied (Claude judge)", () => {
    expect(sandboxCapabilityNotesText([])).toBe("");
    expect(
      judgeCapabilityNotesText({ backendId: "claude", hasOsSandbox: false, sandboxMode: "read-only", scratchEnabled: false })
    ).toBe("");
  });

  it("judgeCapabilityNotesText composes matrix + render for a sandboxed judge", () => {
    const text = judgeCapabilityNotesText({
      backendId: "codex",
      hasOsSandbox: true,
      sandboxMode: "workspace-write",
      scratchEnabled: true,
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
    });
    expect(text).toContain("SPARRA_JUDGE_SANDBOX=1");
    expect(text.toUpperCase()).toMatch(/EXPECTED green/i);
    expect(text.toUpperCase()).toMatch(/REAL (ARTIFACT )?SIGNAL/);
    // The same forward-looking note reaches a read-only judge too (the flag applies to the full suite).
    expect(sandboxCapabilityNotesText(codex("read-only"))).toContain("SPARRA_JUDGE_SANDBOX=1");
  });

  describe("vitest-vite-temp-write entry", () => {
    it("is PRESENT for read-only + hasOsSandbox=true, regardless of scratchEnabled", () => {
      for (const scratchEnabled of [true, false]) {
        const caps = sandboxCapabilityNotes({ backendId: "codex", hasOsSandbox: true, sandboxMode: "read-only", scratchEnabled });
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
      const caps = sandboxCapabilityNotes({ backendId: "codex", hasOsSandbox: true, sandboxMode: "workspace-write", scratchEnabled: true });
      expect(caps.map((c) => c.capability)).not.toContain("vitest-vite-temp-write");
    });

    it("is ABSENT with no OS sandbox (Claude judge)", () => {
      const caps = sandboxCapabilityNotes({ backendId: "claude", hasOsSandbox: false, sandboxMode: "read-only", scratchEnabled: false });
      expect(caps.map((c) => c.capability)).not.toContain("vitest-vite-temp-write");
    });

    it("is ABSENT for danger-full-access", () => {
      const caps = sandboxCapabilityNotes({ backendId: "codex", hasOsSandbox: true, sandboxMode: "danger-full-access", scratchEnabled: true });
      expect(caps.map((c) => c.capability)).not.toContain("vitest-vite-temp-write");
    });

    it("appears in rendered text for read-only judge under the same header", () => {
      const text = judgeCapabilityNotesText({ backendId: "codex", hasOsSandbox: true, sandboxMode: "read-only", scratchEnabled: false });
      expect(text).toMatch(/vitest-vite-temp-write/);
      expect(text).toMatch(/node_modules\/.vite-temp/);
      // Rendered under the same KNOWN SANDBOX CAPABILITY LIMITS header.
      expect(text).toMatch(/KNOWN SANDBOX CAPABILITY LIMITS/);
    });

    it("does NOT appear in rendered text for workspace-write judge", () => {
      const text = judgeCapabilityNotesText({ backendId: "codex", hasOsSandbox: true, sandboxMode: "workspace-write", scratchEnabled: true });
      expect(text).not.toMatch(/vitest-vite-temp-write/);
      // UDS entry is still present for workspace-write.
      expect(text).toMatch(/unix-domain-socket-listen/);
    });
  });
});
