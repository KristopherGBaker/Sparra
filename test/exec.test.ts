import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { runVerifyCommand, extractVerifyCommands, classifyExec, rerunVerifyCommands, type ExecOutcome } from "../src/build/exec.ts";

/**
 * Q3: the harness-side no-model executor. Real-command tests use ONLY local built-ins
 * (`true`/`false`/`echo`/`ls`) — no network, no model calls. `spawnFn` is dependency-injected
 * (a spy wrapping the real spawn) so the safety tests PROVE an unsafe command never spawns.
 */

describe("runVerifyCommand — safety rules (shared with the self-verify allow-path)", () => {
  /** Spy that passes through to the real spawn — counts every actual process launch. */
  const spySpawn = () =>
    vi.fn((...args: Parameters<typeof spawn>) => spawn(...args)) as unknown as typeof spawn & { mock: { calls: unknown[] } };
  const unsafe = [
    "echo a && echo b",
    "echo a; echo b",
    "cat x | grep y",
    "echo hi > out.txt",
    "curl https://example.com",
    "npm install left-pad",
    "git commit -m x",
    "rm -rf scratch",
  ];

  it("rejects chaining/redirect/network/mutation/commit commands WITHOUT spawning", async () => {
    const spawnFn = spySpawn();
    for (const cmd of unsafe) {
      const o = await runVerifyCommand(os.tmpdir(), cmd, { spawnFn });
      expect(o.ran).toBe(false);
      if (!o.ran) expect(o.unsafeReason).toBeTruthy();
    }
    expect(spawnFn).not.toHaveBeenCalled(); // the spy proves NO execution happened
  });

  it("executes a plain allowed command and returns exit 0 + stdout", async () => {
    const spawnFn = spySpawn();
    const o = await runVerifyCommand(os.tmpdir(), "echo ok", { spawnFn });
    expect(o.ran).toBe(true);
    if (o.ran) {
      expect(o.exitCode).toBe(0);
      expect(o.stdout).toContain("ok");
      expect(o.timedOut).toBe(false);
    }
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("captures a nonzero exit (`false`) without throwing", async () => {
    const o = await runVerifyCommand(os.tmpdir(), "false");
    expect(o.ran).toBe(true);
    if (o.ran) expect(o.exitCode).not.toBe(0);
  });

  it("runs with cwd=workspace: a relative path resolves against the workspace (7b)", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-exec-ws-"));
    fs.writeFileSync(path.join(ws, "only-here.txt"), "x");
    const inWs = await runVerifyCommand(ws, "ls only-here.txt");
    expect(inWs.ran && inWs.exitCode === 0).toBe(true);
    const elsewhere = await runVerifyCommand(os.tmpdir(), "ls only-here.txt");
    expect(elsewhere.ran && elsewhere.exitCode !== 0).toBe(true);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("bounds captured output to the cap", async () => {
    const o = await runVerifyCommand(os.tmpdir(), "echo aaaaaaaaaaaaaaaaaaaa", { outputCap: 5 });
    expect(o.ran).toBe(true);
    if (o.ran) expect(o.stdout.length).toBeLessThanOrEqual(5);
  });
});

describe("classifyExec — usage vs behavioral vs ok", () => {
  const c = (exitCode: number | null, stderr = "", stdout = "") => classifyExec({ exitCode, stdout, stderr });

  it("discriminates every contract case", () => {
    expect(c(127, "zsh: command not found: mytool")).toBe("usage"); // exit 127 → usage
    expect(c(2, "usage: mytool [--profile <p>]")).toBe("usage"); // exit 2 + usage text → usage
    expect(c(1, "error: unknown option --bogus")).toBe("usage"); // unknown-flag stderr → usage
    expect(c(2, "assertion failed: expected 5 got 3")).toBe("behavioral"); // exit 2, NON-usage → behavioral
    expect(c(1, "test suite failed: 3 failing")).toBe("behavioral"); // plain exit 1 → behavioral
    expect(c(0)).toBe("ok"); // exit 0 → ok
  });
});

describe("extractVerifyCommands — bounded to the 'I will verify by' section", () => {
  it("extracts backticked-in-prose AND plain list-item commands (exactly those 3)", () => {
    const md = [
      "# Contract — x",
      "## I will build",
      "- stuff with `not-a-verify-command`",
      "## I will verify by",
      "Run `npm run typecheck` first (exit 0).",
      "- npm test → exit 0",
      "- `mytool add 2 3` prints `5`, exits 0",
      "## Assertions",
      "1. `some-other-command --flag` exits 0.",
      "- assertion list item command",
    ].join("\n");
    expect(extractVerifyCommands(md)).toEqual(["npm run typecheck", "npm test", "mytool add 2 3"]);
  });

  it("yields [] when the section is absent (no probe)", () => {
    expect(extractVerifyCommands("# Contract\n## Assertions\n- `npm test` exits 0\n")).toEqual([]);
  });

  it("yields [] for an empty section (stops at the immediately-following heading)", () => {
    expect(extractVerifyCommands("## I will verify by\n## Assertions\n- `npm test`\n")).toEqual([]);
  });
});

describe("rerunVerifyCommands — the rerun-gate core over an injected executor", () => {
  const ran = (exitCode: number, command = "npm test"): ExecOutcome => ({ ran: true, command, exitCode, stdout: "", stderr: exitCode ? "boom" : "", timedOut: false });

  it("mixed exits → flaky; all nonzero → failing; all zero → ok; unsafe → unsafe (not retried, demotes like failing)", async () => {
    const seq = [0, 1]; // flaky
    let i = 0;
    const flaky = await rerunVerifyCommands("/ws", ["npm test"], 2, async () => ran(seq[i++]!));
    expect(flaky[0]!.status).toBe("flaky");

    const failing = await rerunVerifyCommands("/ws", ["npm test"], 2, async () => ran(1));
    expect(failing[0]!.status).toBe("failing");

    const okRes = await rerunVerifyCommands("/ws", ["npm test"], 2, async () => ran(0));
    expect(okRes[0]!.status).toBe("ok");

    const spy = vi.fn(async (): Promise<ExecOutcome> => ({ ran: false, command: "a && b", unsafeReason: "chain" }));
    const unsafe = await rerunVerifyCommands("/ws", ["a && b"], 3, spy);
    expect(unsafe[0]!.status).toBe("unsafe"); // its own non-ok class — the gate demotes it like failing
    expect(unsafe[0]!.detail).toContain("a && b"); // detail names the command for the blocking feedback
    expect(spy).toHaveBeenCalledTimes(1); // unsafe is deterministic — no retry
  });
});
