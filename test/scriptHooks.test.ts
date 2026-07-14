import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { spawn as SpawnFn } from "node:child_process";
import { runScriptHooks, isBeforeEvent, OutputCapture, type ScriptHookContext } from "../src/scriptHooks.ts";
import { defaultConfig, loadConfig, type ScriptHookEvent } from "../src/config.ts";
import { Paths } from "../src/paths.ts";
import { EXEC_TIMEOUT_MS, EXEC_OUTPUT_CAP } from "../src/build/exec.ts";

/**
 * U1: the script-hooks RUNNER (no fire points wired here — see U2). Every test injects a fake
 * `spawnFn` (an EventEmitter-based fake child, mirroring the `fakeSpawn` pattern in
 * test/buildEnv.test.ts) — NO real process spawning, no disk, no sleeps. `kill()` on the fake
 * simulates a real SIGKILL: it schedules a `close` event, so the runner's timeout path resolves
 * instead of hanging.
 */

interface FakeCall {
  argv0: string;
  args: string[];
  options: { cwd?: string; env?: Record<string, string> };
  kill: ReturnType<typeof vi.fn>;
  stdin(): string;
}

interface FakeBehavior {
  exitCode?: number | null;
  signal?: string | null;
  /** Never emits `close` on its own — only `kill()` (the runner's timeout path) resolves it. */
  neverExit?: boolean;
  /** Emitted as one `data` chunk on stdout before close (for output-cap tests). */
  stdout?: string;
  /** Emitted as one `data` chunk on stderr before close (for combined-cap tests). */
  stderr?: string;
  /** Raw-bytes variant of `stdout` for multibyte-boundary tests (bypasses `Buffer.from(string)`
   *  re-encoding so the exact byte sequence under test is unambiguous). */
  stdoutBuffer?: Buffer;
}

/** Keyed by the full `argv0 arg1 arg2…` command string — one behavior per distinct command used
 *  in a test, since real tests use distinct hook commands per spec. */
function fakeSpawnFactory(script: Record<string, FakeBehavior>, calls: FakeCall[]): typeof SpawnFn {
  return ((argv0: string, args: string[] = [], options: any = {}) => {
    const command = [argv0, ...args].join(" ");
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let stdinBuf = "";
    child.stdin = {
      write: (d: string) => {
        stdinBuf += d;
      },
      end: () => {},
    };
    const kill = vi.fn(() => {
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    });
    child.kill = kill;
    calls.push({ argv0, args, options, kill, stdin: () => stdinBuf });
    const behavior = script[command] ?? { exitCode: 0 };
    if (!behavior.neverExit) {
      queueMicrotask(() => {
        if (behavior.stdoutBuffer) child.stdout.emit("data", behavior.stdoutBuffer);
        else if (behavior.stdout) child.stdout.emit("data", Buffer.from(behavior.stdout));
        if (behavior.stderr) child.stderr.emit("data", Buffer.from(behavior.stderr));
        child.emit("close", behavior.exitCode ?? 0, behavior.signal ?? null);
      });
    }
    return child;
  }) as unknown as typeof SpawnFn;
}

describe("isBeforeEvent — closed policy check over all 7 events", () => {
  it("is true for exactly onRunStart/onPhaseStart/onUnitStart, false for the other four", () => {
    const all: ScriptHookEvent[] = [
      "onRunStart",
      "onRunComplete",
      "onPhaseStart",
      "onPhaseEnd",
      "onUnitStart",
      "onUnitComplete",
      "onDecisionParked",
    ];
    const before = all.filter(isBeforeEvent);
    expect(before.sort()).toEqual(["onPhaseStart", "onRunStart", "onUnitStart"].sort());
    for (const e of all) {
      if (!before.includes(e)) expect(isBeforeEvent(e)).toBe(false);
    }
  });
});

describe("no-op / contrast", () => {
  it("no specs for the event → true no-op: nothing spawned, ok:true, ran:0", async () => {
    const calls: FakeCall[] = [];
    const cfg = defaultConfig();
    const outcome = await runScriptHooks("onRunStart", {}, cfg, { spawnFn: fakeSpawnFactory({}, calls) });
    expect(outcome).toEqual({ ok: true, ran: 0 });
    expect(calls.length).toBe(0);
  });

  it("contrast: a configured event DOES spawn", async () => {
    const calls: FakeCall[] = [];
    const cfg = defaultConfig();
    cfg.scriptHooks = { onRunStart: ["echo hi"] };
    const outcome = await runScriptHooks("onRunStart", {}, cfg, {
      spawnFn: fakeSpawnFactory({ "echo hi": { exitCode: 0 } }, calls),
    });
    expect(outcome.ran).toBe(1);
    expect(calls.length).toBe(1);
  });
});

describe("order, count, tokenization", () => {
  it("runs specs sequentially in listed order; ran counts them; string spec tokenizes on whitespace, argv[0] is the command, no shell", async () => {
    const calls: FakeCall[] = [];
    const cfg = defaultConfig();
    cfg.scriptHooks = { onUnitComplete: ["cmd a b", { run: "second one" }] };
    const script = { "cmd a b": { exitCode: 0 }, "second one": { exitCode: 0 } };
    const outcome = await runScriptHooks("onUnitComplete", {}, cfg, { spawnFn: fakeSpawnFactory(script, calls) });
    expect(outcome.ok).toBe(true);
    expect(outcome.ran).toBe(2);
    expect(calls[0]!.argv0).toBe("cmd");
    expect(calls[0]!.args).toEqual(["a", "b"]);
    expect(calls[1]!.argv0).toBe("second");
    expect(calls[1]!.args).toEqual(["one"]);
  });
});

describe("env contract", () => {
  it("present ctx fields set their SPARRA_HOOK_* var + SPARRA_HOOK_EVENT always; absent fields (unit/status) leave their var unset; question is NOT in env but IS on stdin", async () => {
    const calls: FakeCall[] = [];
    const cfg = defaultConfig();
    cfg.scriptHooks = { onRunStart: ["envcheck"] };
    const ctx: ScriptHookContext = { root: "/r", phase: "build", runId: "run1", runDir: "/r/dir", question: "proceed?" };
    await runScriptHooks("onRunStart", ctx, cfg, { spawnFn: fakeSpawnFactory({ envcheck: { exitCode: 0 } }, calls) });
    const env = calls[0]!.options.env!;
    expect(env.SPARRA_HOOK_EVENT).toBe("onRunStart");
    expect(env.SPARRA_HOOK_ROOT).toBe("/r");
    expect(env.SPARRA_HOOK_PHASE).toBe("build");
    expect(env.SPARRA_HOOK_RUN_ID).toBe("run1");
    expect(env.SPARRA_HOOK_RUN_DIR).toBe("/r/dir");
    // Contrast: fields absent from THIS ctx → their env vars are absent (not empty-string).
    expect("SPARRA_HOOK_UNIT" in env).toBe(false);
    expect("SPARRA_HOOK_STATUS" in env).toBe(false);
    expect("SPARRA_HOOK_DECISION_SEQ" in env).toBe(false);
    expect("SPARRA_HOOK_DECISION_KIND" in env).toBe(false);
    // question never in env, under any key/value.
    expect(Object.keys(env).some((k) => k.toLowerCase().includes("question"))).toBe(false);
    expect(Object.values(env)).not.toContain("proceed?");
    // …but IS in the stdin JSON, parsed back.
    const stdin = JSON.parse(calls[0]!.stdin().trim());
    expect(stdin.question).toBe("proceed?");
    expect(stdin.root).toBe("/r");
  });

  it("unit/status/decision fields set their vars when present (stringified where numeric)", async () => {
    const calls: FakeCall[] = [];
    const cfg = defaultConfig();
    cfg.scriptHooks = { onDecisionParked: ["dcheck"] };
    const ctx: ScriptHookContext = { decisionSeq: 3, decisionKind: "budget", unit: "item-001", status: "passed" };
    await runScriptHooks("onDecisionParked", ctx, cfg, { spawnFn: fakeSpawnFactory({ dcheck: { exitCode: 0 } }, calls) });
    const env = calls[0]!.options.env!;
    expect(env.SPARRA_HOOK_DECISION_SEQ).toBe("3");
    expect(env.SPARRA_HOOK_DECISION_KIND).toBe("budget");
    expect(env.SPARRA_HOOK_UNIT).toBe("item-001");
    expect(env.SPARRA_HOOK_STATUS).toBe("passed");
    // Fields absent from this ctx (root/phase/runId/runDir) are absent too.
    expect("SPARRA_HOOK_ROOT" in env).toBe(false);
  });

  it("fix #6 — a STALE SPARRA_HOOK_* value already sitting in the parent env does NOT leak into the child when ctx omits that field (env-isolation security fix)", async () => {
    const staleUnit = process.env.SPARRA_HOOK_UNIT;
    const staleQuestion = process.env.SPARRA_HOOK_QUESTION;
    process.env.SPARRA_HOOK_UNIT = "stale";
    process.env.SPARRA_HOOK_QUESTION = "leak";
    try {
      const calls: FakeCall[] = [];
      const cfg = defaultConfig();
      cfg.scriptHooks = { onRunStart: ["leakcheck"] };
      // ctx is EMPTY — neither `unit` nor `question` is present, so neither reserved var should
      // reach the child, regardless of what the parent process happens to be holding.
      await runScriptHooks("onRunStart", {}, cfg, { spawnFn: fakeSpawnFactory({ leakcheck: { exitCode: 0 } }, calls) });
      const env = calls[0]!.options.env!;
      expect("SPARRA_HOOK_UNIT" in env).toBe(false);
      expect("SPARRA_HOOK_QUESTION" in env).toBe(false);
      expect(Object.values(env)).not.toContain("stale");
      expect(Object.values(env)).not.toContain("leak");
    } finally {
      if (staleUnit === undefined) delete process.env.SPARRA_HOOK_UNIT;
      else process.env.SPARRA_HOOK_UNIT = staleUnit;
      if (staleQuestion === undefined) delete process.env.SPARRA_HOOK_QUESTION;
      else process.env.SPARRA_HOOK_QUESTION = staleQuestion;
    }
  });

  it("fix #6 contrast — when ctx DOES supply a field, its var is set to the CURRENT ctx value, not any stale parent value for that same key", async () => {
    const staleUnit = process.env.SPARRA_HOOK_UNIT;
    process.env.SPARRA_HOOK_UNIT = "stale-parent-value";
    try {
      const calls: FakeCall[] = [];
      const cfg = defaultConfig();
      cfg.scriptHooks = { onUnitStart: ["freshcheck"] };
      await runScriptHooks("onUnitStart", { unit: "item-009" }, cfg, {
        spawnFn: fakeSpawnFactory({ freshcheck: { exitCode: 0 } }, calls),
      });
      expect(calls[0]!.options.env!.SPARRA_HOOK_UNIT).toBe("item-009");
    } finally {
      if (staleUnit === undefined) delete process.env.SPARRA_HOOK_UNIT;
      else process.env.SPARRA_HOOK_UNIT = staleUnit;
    }
  });
});

describe("stdin JSON", () => {
  it("receives the full context as one JSON line, including question, parsed back field-equal", async () => {
    const calls: FakeCall[] = [];
    const cfg = defaultConfig();
    cfg.scriptHooks = { onUnitStart: ["stdincheck"] };
    const ctx: ScriptHookContext = {
      root: "/root",
      phase: "build",
      runId: "r1",
      runDir: "/root/.sparra/runs/r1",
      unit: "item-001",
      status: "in_progress",
      decisionSeq: 2,
      decisionKind: "pivot",
      question: "continue past budget?",
    };
    await runScriptHooks("onUnitStart", ctx, cfg, { spawnFn: fakeSpawnFactory({ stdincheck: { exitCode: 0 } }, calls) });
    const raw = calls[0]!.stdin();
    expect(raw.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(raw.trim());
    expect(parsed).toEqual(ctx);
  });
});

describe("cwd precedence", () => {
  it("spec.cwd wins over ctx.root", async () => {
    const calls: FakeCall[] = [];
    const cfg = defaultConfig();
    cfg.scriptHooks = { onRunStart: [{ run: "cwdcheck", cwd: "/spec-cwd" }] };
    await runScriptHooks("onRunStart", { root: "/ctx-root" }, cfg, {
      spawnFn: fakeSpawnFactory({ cwdcheck: { exitCode: 0 } }, calls),
    });
    expect(calls[0]!.options.cwd).toBe("/spec-cwd");
  });

  it("ctx.root wins when spec.cwd is absent", async () => {
    const calls: FakeCall[] = [];
    const cfg = defaultConfig();
    cfg.scriptHooks = { onRunStart: ["cwdcheck"] };
    await runScriptHooks("onRunStart", { root: "/ctx-root" }, cfg, {
      spawnFn: fakeSpawnFactory({ cwdcheck: { exitCode: 0 } }, calls),
    });
    expect(calls[0]!.options.cwd).toBe("/ctx-root");
  });

  it("falls back to process.cwd() when both spec.cwd and ctx.root are absent", async () => {
    const calls: FakeCall[] = [];
    const cfg = defaultConfig();
    cfg.scriptHooks = { onRunStart: ["cwdcheck"] };
    await runScriptHooks("onRunStart", {}, cfg, { spawnFn: fakeSpawnFactory({ cwdcheck: { exitCode: 0 } }, calls) });
    expect(calls[0]!.options.cwd).toBe(process.cwd());
  });
});

describe("before-event gate (onRunStart/onPhaseStart/onUnitStart)", () => {
  it("a required spec that exits non-zero STOPS the list: ok:false, gateFailure names event/command/exitCode, later spec NOT spawned", async () => {
    const calls: FakeCall[] = [];
    const cfg = defaultConfig();
    cfg.scriptHooks = { onRunStart: [{ run: "failer", required: true }, { run: "later" }] };
    const script = { failer: { exitCode: 1 }, later: { exitCode: 0 } };
    const outcome = await runScriptHooks("onRunStart", {}, cfg, { spawnFn: fakeSpawnFactory(script, calls) });
    expect(outcome.ok).toBe(false);
    expect(outcome.ran).toBe(1);
    expect(outcome.gateFailure).toEqual({
      event: "onRunStart",
      command: "failer",
      exitCode: 1,
      signal: null,
      timedOut: false,
    });
    expect(calls.length).toBe(1); // "later" was never spawned
  });

  it("contrast: required:false on the same failing spec → ok:true, BOTH specs spawned, warn called", async () => {
    const calls: FakeCall[] = [];
    const cfg = defaultConfig();
    cfg.scriptHooks = { onRunStart: [{ run: "failer", required: false }, { run: "later" }] };
    const script = { failer: { exitCode: 1 }, later: { exitCode: 0 } };
    const warn = vi.fn();
    const outcome = await runScriptHooks("onRunStart", {}, cfg, { spawnFn: fakeSpawnFactory(script, calls), warn });
    expect(outcome.ok).toBe(true);
    expect(outcome.ran).toBe(2);
    expect(calls.length).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("failer");
  });

  it("onPhaseStart / onUnitStart behave the same as onRunStart for the gate", async () => {
    for (const event of ["onPhaseStart", "onUnitStart"] as const) {
      const calls: FakeCall[] = [];
      const cfg = defaultConfig();
      cfg.scriptHooks = { [event]: [{ run: "failer", required: true }, { run: "later" }] };
      const script = { failer: { exitCode: 1 }, later: { exitCode: 0 } };
      const outcome = await runScriptHooks(event, {}, cfg, { spawnFn: fakeSpawnFactory(script, calls) });
      expect(outcome.ok, event).toBe(false);
      expect(outcome.gateFailure?.event, event).toBe(event);
      expect(calls.length, event).toBe(1);
    }
  });
});

describe("after-event best-effort (onRunComplete/onPhaseEnd/onUnitComplete/onDecisionParked)", () => {
  it.each(["onRunComplete", "onPhaseEnd", "onUnitComplete", "onDecisionParked"] as const)(
    "%s: a FAILING required:true spec does NOT gate — ok:true, remaining specs still run, warn called",
    async (event) => {
      const calls: FakeCall[] = [];
      const cfg = defaultConfig();
      cfg.scriptHooks = { [event]: [{ run: "failer", required: true }, { run: "later" }] };
      const script = { failer: { exitCode: 1 }, later: { exitCode: 0 } };
      const warn = vi.fn();
      const outcome = await runScriptHooks(event, {}, cfg, { spawnFn: fakeSpawnFactory(script, calls), warn });
      expect(outcome.ok).toBe(true);
      expect(outcome.ran).toBe(2);
      expect(outcome.gateFailure).toBeUndefined();
      expect(calls.length).toBe(2);
      expect(warn).toHaveBeenCalledOnce();
    }
  );
});

describe("timeout", () => {
  it("kills a never-exiting hook at the deadline and gates a required before-event spec", async () => {
    const calls: FakeCall[] = [];
    const cfg = defaultConfig();
    cfg.scriptHooks = { onUnitStart: [{ run: "hang", required: true }] };
    const script = { hang: { neverExit: true } };
    const outcome = await runScriptHooks("onUnitStart", {}, cfg, {
      spawnFn: fakeSpawnFactory(script, calls),
      timeoutMs: 15,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.gateFailure?.timedOut).toBe(true);
    expect(calls[0]!.kill).toHaveBeenCalled();
  });

  it("kills a never-exiting hook at the deadline and warns (does not gate) on an after-event", async () => {
    const calls: FakeCall[] = [];
    const cfg = defaultConfig();
    cfg.scriptHooks = { onPhaseEnd: [{ run: "hang" }] };
    const script = { hang: { neverExit: true } };
    const warn = vi.fn();
    const outcome = await runScriptHooks("onPhaseEnd", {}, cfg, {
      spawnFn: fakeSpawnFactory(script, calls),
      timeoutMs: 15,
      warn,
    });
    expect(outcome.ok).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/timed out/);
  });

  it("the default timeout (no deps.timeoutMs, no spec.timeoutSec) reuses the EXEC_TIMEOUT_MS magnitude", async () => {
    const calls: FakeCall[] = [];
    const cfg = defaultConfig();
    cfg.scriptHooks = { onRunStart: ["quick"] };
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      await runScriptHooks("onRunStart", {}, cfg, { spawnFn: fakeSpawnFactory({ quick: { exitCode: 0 } }, calls) });
      const usedDefault = setTimeoutSpy.mock.calls.some((c) => c[1] === EXEC_TIMEOUT_MS);
      expect(usedDefault).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});

describe("output cap", () => {
  it("retains at most the EXEC_OUTPUT_CAP magnitude (default) — no unbounded buffer for a chatty hook", async () => {
    const calls: FakeCall[] = [];
    const cfg = defaultConfig();
    cfg.scriptHooks = { onPhaseEnd: [{ run: "chatty" }] };
    const bigOutput = "x".repeat(EXEC_OUTPUT_CAP * 3); // deliberately far over the cap
    const script = { chatty: { exitCode: 1, stdout: bigOutput } };
    const warn = vi.fn();
    await runScriptHooks("onPhaseEnd", {}, cfg, { spawnFn: fakeSpawnFactory(script, calls), warn });
    expect(warn).toHaveBeenCalledOnce();
    // The warn message embeds a small diagnostic slice of the (already-capped) captured output —
    // it must never approach the uncapped 3x-EXEC_OUTPUT_CAP size.
    expect(warn.mock.calls[0]![0]!.length).toBeLessThan(EXEC_OUTPUT_CAP);
  });

  it("a smaller injected outputCap bounds the diagnostic to that magnitude, not the larger default", async () => {
    const calls: FakeCall[] = [];
    const cfg = defaultConfig();
    cfg.scriptHooks = { onPhaseEnd: [{ run: "chatty" }] };
    const bigOutput = "y".repeat(5_000);
    const script = { chatty: { exitCode: 1, stdout: bigOutput } };
    const warn = vi.fn();
    await runScriptHooks("onPhaseEnd", {}, cfg, {
      spawnFn: fakeSpawnFactory(script, calls),
      warn,
      outputCap: 10,
    });
    expect(warn).toHaveBeenCalledOnce();
    // At most 10 chars of "y" survive the cap, embedded in a short diagnostic message.
    expect(warn.mock.calls[0]![0]).not.toContain("y".repeat(11));
  });

  it("fix #11 integration — stdout+stderr TOGETHER respect a single combined byte cap, not one cap each", async () => {
    const calls: FakeCall[] = [];
    const cfg = defaultConfig();
    cfg.scriptHooks = { onPhaseEnd: [{ run: "both" }] };
    // 20 "Z" bytes on stdout + 20 "Q" bytes on stderr — distinctive marker chars that can't
    // collide with any prose word in the warn message. If capped PER STREAM, up to 20 of each
    // (40 total) could reach the diagnostic. With a shared budget of 10, at most 10 combined.
    const script = { both: { exitCode: 1, stdout: "Z".repeat(20), stderr: "Q".repeat(20) } };
    const warn = vi.fn();
    await runScriptHooks("onPhaseEnd", {}, cfg, {
      spawnFn: fakeSpawnFactory(script, calls),
      warn,
      outputCap: 10,
    });
    expect(warn).toHaveBeenCalledOnce();
    const msg = warn.mock.calls[0]![0] as string;
    const retainedMarkerChars = (msg.match(/[ZQ]/g) ?? []).length;
    expect(retainedMarkerChars).toBeLessThanOrEqual(10); // combined, never 10 "Z" PLUS 10 "Q"
  });
});

describe("OutputCapture — combined byte-accurate cap (fix #11, direct/pure unit tests)", () => {
  it("a 4-byte emoji does not slip past a tiny byte cap — retained bytes never exceed the cap, even mid-character", () => {
    const emoji = Buffer.from("\u{1F600}", "utf8"); // 😀 — exactly 4 UTF-8 bytes
    expect(emoji.length).toBe(4);
    const capture = new OutputCapture(2);
    capture.push("stdout", emoji);
    const { stdout, stderr } = capture.result();
    expect(stdout.length).toBe(2); // raw retained BYTES — not "1 char let through"
    expect(stderr.length).toBe(0);
  });

  it("measures BYTES, not JS string .length — a chunk under the cap in bytes is retained whole even if it decodes to fewer/more chars", () => {
    // 3 two-byte characters ("é" × 3) = 6 bytes total, 3 JS chars.
    const twoByteChars = Buffer.from("ééé", "utf8");
    expect(twoByteChars.length).toBe(6);
    const capture = new OutputCapture(5); // cap lands mid-character (byte 5 of 6)
    capture.push("stdout", twoByteChars);
    const { stdout } = capture.result();
    expect(stdout.length).toBe(5); // exactly 5 bytes retained, not "cap counted as chars"
  });

  it("shares ONE combined budget across stdout+stderr — a full stdout chunk leaves only the REMAINING budget for stderr", () => {
    const capture = new OutputCapture(10);
    capture.push("stdout", Buffer.from("12345678")); // 8 bytes — 2 remain in the shared budget
    capture.push("stderr", Buffer.from("12345678")); // would be 8 more, but only 2 fit
    const { stdout, stderr } = capture.result();
    expect(stdout.length).toBe(8);
    expect(stderr.length).toBe(2); // truncated to the remaining shared budget, NOT a fresh 8/10
    expect(stdout.length + stderr.length).toBe(10); // combined total respects the ONE cap
  });

  it("once the combined cap is exhausted, further pushes on EITHER stream are dropped entirely (no partial-then-empty growth)", () => {
    const capture = new OutputCapture(4);
    capture.push("stdout", Buffer.from("abcd")); // fills the budget exactly
    capture.push("stderr", Buffer.from("more data"));
    capture.push("stdout", Buffer.from("even more"));
    const { stdout, stderr } = capture.result();
    expect(stdout.toString()).toBe("abcd");
    expect(stderr.length).toBe(0);
  });
});

describe("validateScriptHooks (via loadConfig)", () => {
  async function withConfigFile(yaml: string): Promise<{ paths: Paths; dir: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-scripthooks-config-"));
    const paths = new Paths(dir);
    await paths.ensureScaffold();
    fs.writeFileSync(paths.config, yaml);
    return { paths, dir };
  }

  it("a config with NO scriptHooks key passes and yields {}", async () => {
    const { paths, dir } = await withConfigFile("build:\n  maxRoundsPerItem: 4\n");
    const cfg = await loadConfig(paths);
    expect(cfg.scriptHooks).toEqual({});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("REGRESSION (assertion 3b, null-vs-absent): key-absent is accepted (yields {}) but an EXPLICITLY PRESENT scriptHooks: null is REJECTED, not silently treated as absent", async () => {
    // Absent key — same case as above, restated here for a direct side-by-side contrast.
    const absent = await withConfigFile("build:\n  maxRoundsPerItem: 4\n");
    const cfg = await loadConfig(absent.paths);
    expect(cfg.scriptHooks).toEqual({});
    fs.rmSync(absent.dir, { recursive: true, force: true });

    // Explicitly present `scriptHooks: null` — must THROW, never fall through to `{}`. A guard
    // written as `if (scriptHooks == null) return` would wrongly accept this (typeof null ===
    // "object"), conflating "key not there" with "key there, value null".
    const explicitNull = await withConfigFile("scriptHooks: null\n");
    await expect(loadConfig(explicitNull.paths)).rejects.toThrow(/Invalid .*scriptHooks must be a map/);
    fs.rmSync(explicitNull.dir, { recursive: true, force: true });
  });

  it("a valid config (string spec + full object spec) passes", async () => {
    const { paths, dir } = await withConfigFile(
      "scriptHooks:\n  onRunStart:\n    - \"echo start\"\n    - run: notify\n      required: true\n      timeoutSec: 30\n      cwd: /tmp\n"
    );
    const cfg = await loadConfig(paths);
    expect(cfg.scriptHooks.onRunStart).toEqual(["echo start", { run: "notify", required: true, timeoutSec: 30, cwd: "/tmp" }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a non-object scriptHooks value", async () => {
    const { paths, dir } = await withConfigFile("scriptHooks: not-an-object\n");
    await expect(loadConfig(paths)).rejects.toThrow(/Invalid .*scriptHooks must be a map/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an array scriptHooks value", async () => {
    const { paths, dir } = await withConfigFile("scriptHooks:\n  - a\n  - b\n");
    await expect(loadConfig(paths)).rejects.toThrow(/Invalid .*scriptHooks must be a map/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an unknown event name", async () => {
    const { paths, dir } = await withConfigFile("scriptHooks:\n  onBogusEvent:\n    - echo hi\n");
    await expect(loadConfig(paths)).rejects.toThrow(/Invalid .*scriptHooks\.onBogusEvent is not a known event/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a non-array event value", async () => {
    const { paths, dir } = await withConfigFile("scriptHooks:\n  onRunStart: echo hi\n");
    await expect(loadConfig(paths)).rejects.toThrow(/Invalid .*scriptHooks\.onRunStart must be an array/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a spec that is neither a string nor an object with a run field", async () => {
    const { paths, dir } = await withConfigFile("scriptHooks:\n  onRunStart:\n    - 5\n");
    await expect(loadConfig(paths)).rejects.toThrow(/Invalid .*scriptHooks\.onRunStart\[0\]/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an object spec with an empty-string run", async () => {
    const { paths, dir } = await withConfigFile('scriptHooks:\n  onRunStart:\n    - run: ""\n');
    await expect(loadConfig(paths)).rejects.toThrow(/Invalid .*\.run must be a non-empty string/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an object spec with no run field at all", async () => {
    const { paths, dir } = await withConfigFile("scriptHooks:\n  onRunStart:\n    - required: true\n");
    await expect(loadConfig(paths)).rejects.toThrow(/Invalid .*\.run must be a non-empty string/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a non-boolean required", async () => {
    const { paths, dir } = await withConfigFile('scriptHooks:\n  onRunStart:\n    - run: x\n      required: "yes"\n');
    await expect(loadConfig(paths)).rejects.toThrow(/Invalid .*\.required must be a boolean/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(["0", "-5", '"abc"', "null", ".nan"])("rejects a non-positive/non-finite/non-number timeoutSec (%s)", async (value) => {
    const { paths, dir } = await withConfigFile(`scriptHooks:\n  onRunStart:\n    - run: x\n      timeoutSec: ${value}\n`);
    await expect(loadConfig(paths)).rejects.toThrow(/Invalid .*\.timeoutSec must be a positive finite number/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a non-string cwd", async () => {
    const { paths, dir } = await withConfigFile("scriptHooks:\n  onRunStart:\n    - run: x\n      cwd: 5\n");
    await expect(loadConfig(paths)).rejects.toThrow(/Invalid .*\.cwd must be a string/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("defaultConfig opt-in default", () => {
  it("defaultConfig().scriptHooks deep-equals {}", () => {
    expect(defaultConfig().scriptHooks).toEqual({});
  });
});
