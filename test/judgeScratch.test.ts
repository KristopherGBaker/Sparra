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
