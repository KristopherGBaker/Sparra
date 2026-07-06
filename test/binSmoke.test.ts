import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJudgeScratch, judgeScratchEnvLayer } from "../src/build/judgeScratch.ts";

// U-A #7: the packaged CLI shells out to tsx, whose IPC pipe is derived from `os.tmpdir()`
// (installed tsx 4.x: `dist/temporary-directory-*.cjs` → `join(os.tmpdir(), 'tsx-<uid>')`, then
// `dist/get-pipe-path-*.cjs` → `join(tmpdir, '<pid>.pipe')`). Under a read-only sandbox that socket
// EPERMs before any Sparra code runs. Pointing TMPDIR at a per-run WRITABLE scratch dir (the default
// judge env layer) makes the socket creatable, so `node bin/sparra.mjs --help` runs. No model calls.

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.resolve(here, "../bin/sparra.mjs");

describe("packaged CLI smoke — tsx IPC socket lands in scratch TMPDIR (U-A #7)", () => {
  it(
    "node bin/sparra.mjs --help exits 0 with TMPDIR pointed at a per-run scratch dir",
    () => {
      const scratch = createJudgeScratch();
      try {
        // Only TMPDIR is redirected here (the tsx-socket root) — the rest of the env is inherited.
        const env = { ...process.env, ...judgeScratchEnvLayer(scratch) };
        const res = spawnSync(process.execPath, [bin, "--help"], { env, encoding: "utf8" });
        const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
        expect(res.status).toBe(0);
        expect(out).not.toMatch(/EPERM/i);
        expect(out).toMatch(/sparra/i); // the help text actually printed
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    },
    60_000
  );
});
