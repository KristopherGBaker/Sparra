import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJudgeScratch, judgeScratchEnvLayer } from "../src/build/judgeScratch.ts";

// U-A #7: the packaged CLI shells out to tsx, whose IPC pipe is derived from `os.tmpdir()`
// (installed tsx 4.x: `dist/temporary-directory-*.cjs` → `join(os.tmpdir(), 'tsx-<uid>')`, then
// `dist/get-pipe-path-*.cjs` → `join(tmpdir, '<pid>.pipe')`). Under a read-only sandbox that socket
// EPERMs before any Sparra code runs. Pointing TMPDIR at a per-run WRITABLE scratch dir (the default
// judge env layer) fixes the socket PATH's writability — but NOT a sandbox that denies unix-socket
// `listen()` as POLICY (independent of path writability); there the tsx socket still EPERMs no matter
// where TMPDIR points, so this smoke SKIPS on an observed listen-deny (see `canListenUnixSocket`
// below) and asserts the redirect only where listen is actually permitted. No model calls.

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.resolve(here, "../bin/sparra.mjs");

/**
 * Probe whether THIS environment permits binding a unix-domain socket at all. Some sandboxes
 * (e.g. the read-only adversarial evaluator) deny `listen()` on a unix socket as a POLICY matter,
 * independent of path writability — `net.createServer().listen()` fails with `EPERM`. tsx's IPC
 * loader binds exactly such a socket, so under that policy the smoke below would EPERM no matter
 * where TMPDIR points. That's a FALSE environment failure (the very thing this unit exists to kill),
 * so the smoke SKIPS on an observed deny and runs fully everywhere else. The probe uses a throwaway
 * socket in a fresh temp dir and never leaks a listener/dir.
 */
function canListenUnixSocket(): Promise<boolean> {
  return new Promise((resolve) => {
    let dir: string;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-listen-probe-"));
    } catch {
      resolve(false);
      return;
    }
    const sockPath = path.join(dir, "p.sock");
    const srv = net.createServer();
    const done = (ok: boolean) => {
      try {
        srv.close();
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    srv.once("error", () => done(false)); // EPERM / EACCES / anything ⇒ deny
    try {
      srv.listen(sockPath, () => done(true));
    } catch {
      done(false);
    }
  });
}

describe("packaged CLI smoke — tsx IPC socket lands in scratch TMPDIR (U-A #7)", () => {
  it(
    "node bin/sparra.mjs --help exits 0 with TMPDIR pointed at a per-run scratch dir",
    async (ctx) => {
      // Guard against a sandbox that forbids unix-socket listen outright: skip (never fail) — a
      // false environment failure here is exactly the failure mode this unit exists to kill.
      if (!(await canListenUnixSocket())) {
        ctx.skip();
        return;
      }
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
