import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadCtxForRole, type Ctx } from "../src/context.ts";
import { cmdConduct, parseConductFlags } from "../src/phases/conduct.ts";
import { parse } from "../src/util/args.ts";
import type { ConductOptions, ConductResult } from "../src/conduct/run.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.resolve(here, "../bin/sparra.mjs");
const repoRoot = path.resolve(here, "..");

// The CLI phase logger is SILENCED when VITEST is set (log.ts `silenced()`), and a spawned child
// inherits this process's env — so an `err()`/usage message would be swallowed in the subprocess.
// Re-enable it via SPARRA_LOG_IN_TESTS so the child's usage/error text is actually captured.
// ANTHROPIC_API_KEY is deliberately bogus: a correctly-validated malformed invocation must reject
// BEFORE any model/auth call, so this never matters — but if validation ever detaches from the real
// argv path (the round-3 regression), the child would proceed and any live call fails FAST here
// rather than spending, while the assertions (exit≠0, flag named, no run dir) still catch the bug.
const childEnv = { ...process.env, SPARRA_LOG_IN_TESTS: "1", ANTHROPIC_API_KEY: "invalid-no-spend" };

const noProbe = async (): Promise<void> => {};

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sparra-conduct-cli-"));
}
async function makeCtx(dir: string): Promise<Ctx> {
  return loadCtxForRole(dir, { probeAuto: noProbe });
}

afterEach(() => {
  process.exitCode = 0;
});

describe("parseConductFlags — validation (no side effects)", () => {
  it("accepts a bare prompt with defaults", () => {
    const r = parseConductFlags("build a thing", {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.opts.maxUnits).toBe(4);
      expect(r.opts.concurrency).toBe(2);
      expect(r.opts.dryRun).toBe(false);
      expect(r.opts.budget).toBeUndefined();
    }
  });

  it("rejects an empty prompt", () => {
    const r = parseConductFlags("   ", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/prompt/i);
  });

  // Each malformed flag: rejected, error names the offending flag.
  const badInt: Array<[string, Record<string, string | boolean>]> = [
    ["max-units 0", { "max-units": "0" }],
    ["max-units abc", { "max-units": "abc" }],
    ["max-units missing", { "max-units": true }],
    ["concurrency 0", { concurrency: "0" }],
    ["concurrency abc", { concurrency: "abc" }],
    ["concurrency missing", { concurrency: true }],
    ["max-turns 0", { "max-turns": "0" }],
    ["max-turns abc", { "max-turns": "abc" }],
    ["max-turns missing", { "max-turns": true }],
  ];
  for (const [label, flags] of badInt) {
    it(`rejects --${label}`, () => {
      const r = parseConductFlags("x", flags);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(label.split(" ")[0]!);
    });
  }

  const badBudget: Array<[string, Record<string, string | boolean>]> = [
    ["budget -5", { budget: "-5" }],
    ["budget abc", { budget: "abc" }],
    ["budget missing", { budget: true }],
  ];
  for (const [label, flags] of badBudget) {
    it(`rejects --${label}`, () => {
      const r = parseConductFlags("x", flags);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("budget");
    });
  }

  it("budget: --budget 0 is ACCEPTED as unlimited (parses, not rejected)", () => {
    const r = parseConductFlags("x", { budget: "0" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.opts.budget).toBe(0);
  });

  it("negative --max-units / --concurrency are rejected (parser drops the value → flag named)", () => {
    // The CLI parser treats `--max-units -3` as a value-less flag; either way it must be rejected.
    expect(parseConductFlags("x", { "max-units": true }).ok).toBe(false);
    expect(parseConductFlags("x", { concurrency: true }).ok).toBe(false);
  });
});

describe("cmdConduct — validation aborts with zero side effects", () => {
  it("bare prompt: exits non-zero, never calls the runner, creates no run dir", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      let called = 0;
      const res = await cmdConduct(ctx, "", {}, {
        autoProbe: noProbe as unknown as never,
        runConductFn: async () => {
          called++;
          return {} as ConductResult;
        },
      });
      expect(res).toBeUndefined();
      expect(called).toBe(0);
      expect(process.exitCode).toBe(1);
      expect(fs.existsSync(path.join(dir, ".sparra", "conduct"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("malformed flag: rejected before the auto-probe and the runner (zero spend)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      let probed = 0;
      let ran = 0;
      await cmdConduct(ctx, "x", { "max-units": "0" }, {
        autoProbe: (async () => {
          probed++;
        }) as unknown as never,
        runConductFn: async () => {
          ran++;
          return {} as ConductResult;
        },
      });
      expect(probed).toBe(0);
      expect(ran).toBe(0);
      expect(process.exitCode).toBe(1);
      expect(fs.existsSync(path.join(dir, ".sparra", "conduct"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("budget: --budget 0 reaches the runner as unlimited (opts.budget === 0)", async () => {
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      let seen: ConductOptions | undefined;
      await cmdConduct(ctx, "x", { budget: "0" }, {
        autoProbe: noProbe as unknown as never,
        runConductFn: async (_c, opts) => {
          seen = opts;
          return { runId: "r", runDir: "d", state: { units: [] } } as unknown as ConductResult;
        },
      });
      expect(seen?.budget).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct — REAL argv dispatch (general parse → cmdConduct, no detached validation)", () => {
  // Mirror cli.ts's EXACT conduct wiring: the general `parse()` feeds prompt + flags into cmdConduct.
  // This catches a detachment where the helper parser rejects but the real entry point does not
  // (round-3 regression class), without spawning a subprocess. A fake runConductFn keeps a VALID
  // invocation spend-free; malformed invocations must never reach it.
  async function driveArgv(argv: string[], deps: { runConductFn: NonNullable<import("../src/phases/conduct.ts").CmdConductDeps["runConductFn"]> }) {
    const { positionals, flags } = parse(argv);
    const prompt = positionals.slice(1).join(" ");
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      await cmdConduct(ctx, prompt, flags, {
        autoProbe: noProbe as unknown as never,
        runConductFn: deps.runConductFn,
      });
      return { dir };
    } finally {
      // caller inspects dir before this cleanup via the returned value in the same tick
    }
  }

  it("VALID argv reaches the runner with correctly parsed opts (no spend via fake)", async () => {
    let seen: ConductOptions | undefined;
    const dir = tmpdir();
    try {
      const ctx = await makeCtx(dir);
      const { positionals, flags } = parse(["conduct", "build a thing", "--max-units", "3", "--concurrency", "1", "--budget", "0"]);
      await cmdConduct(ctx, positionals.slice(1).join(" "), flags, {
        autoProbe: noProbe as unknown as never,
        runConductFn: async (_c, opts) => {
          seen = opts;
          return { runId: "r", runDir: "d", state: { units: [] } } as unknown as ConductResult;
        },
      });
      expect(seen).toBeDefined();
      expect(seen!.maxUnits).toBe(3);
      expect(seen!.concurrency).toBe(1);
      expect(seen!.budget).toBe(0); // unlimited, accepted
      expect(seen!.prompt).toBe("build a thing");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const argv of [
    ["conduct", "x", "--max-units", "0"],
    ["conduct", "x", "--max-units", "-3"],
    ["conduct", "x", "--concurrency", "0"],
    ["conduct", "x", "--max-turns", "abc"],
    ["conduct", "x", "--budget", "-5"],
  ]) {
    it(`MALFORMED argv ${argv.slice(2).join(" ")} is rejected on the real dispatch (runner never reached)`, async () => {
      let reached = 0;
      process.exitCode = 0;
      const { dir } = await driveArgv(argv, {
        runConductFn: async () => {
          reached++;
          return { runId: "r", runDir: "d", state: { units: [] } } as unknown as ConductResult;
        },
      });
      try {
        expect(reached).toBe(0);
        expect(process.exitCode).toBe(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("conduct — CLI subprocess surface (verify steps 4-6)", () => {
  it("help lists conduct with all five flags", () => {
    const res = spawnSync(process.execPath, [bin, "help"], { encoding: "utf8", env: childEnv });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    expect(res.status).toBe(0);
    expect(out).toContain("conduct");
    for (const flag of ["--max-units", "--concurrency", "--budget", "--max-turns", "--dry-run"]) {
      expect(out).toContain(flag);
    }
  }, 60_000);

  it("bare `conduct` (no prompt): non-zero exit, usage names conduct, no run dir created", () => {
    const dir = tmpdir();
    try {
      const res = spawnSync(process.execPath, [bin, "conduct", "--root", dir], { encoding: "utf8", env: childEnv });
      const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
      expect(res.status).not.toBe(0);
      expect(out.toLowerCase()).toContain("conduct");
      expect(fs.existsSync(path.join(dir, ".sparra", "conduct"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // REAL-PATH regression guard (round-3): drive the ACTUAL `bin/sparra.mjs` argv path for the FULL
  // verify-step-6 malformed matrix. Each case must exit non-zero, name the offending flag on stderr,
  // and create NO run dir — spawning no role. If validation is ever detached from the real entry
  // point again (helpers pass but the CLI accepts), these FAIL (exit 0 / run dir appears / no flag
  // name). Spend-free by construction: validation rejects before any model call (+ bogus key belt).
  const MALFORMED: Array<{ label: string; args: string[]; flag: string }> = [
    { label: "--max-units 0", args: ["--max-units", "0"], flag: "max-units" },
    { label: "--max-units -3", args: ["--max-units", "-3"], flag: "max-units" },
    { label: "--max-units abc", args: ["--max-units", "abc"], flag: "max-units" },
    { label: "--max-units (missing)", args: ["--max-units"], flag: "max-units" },
    { label: "--concurrency 0", args: ["--concurrency", "0"], flag: "concurrency" },
    { label: "--concurrency -1", args: ["--concurrency", "-1"], flag: "concurrency" },
    { label: "--concurrency abc", args: ["--concurrency", "abc"], flag: "concurrency" },
    { label: "--concurrency (missing)", args: ["--concurrency"], flag: "concurrency" },
    { label: "--max-turns 0", args: ["--max-turns", "0"], flag: "max-turns" },
    { label: "--max-turns -1", args: ["--max-turns", "-1"], flag: "max-turns" },
    { label: "--max-turns abc", args: ["--max-turns", "abc"], flag: "max-turns" },
    { label: "--max-turns (missing)", args: ["--max-turns"], flag: "max-turns" },
    { label: "--budget -5", args: ["--budget", "-5"], flag: "budget" },
    { label: "--budget abc", args: ["--budget", "abc"], flag: "budget" },
    { label: "--budget (missing)", args: ["--budget"], flag: "budget" },
  ];
  for (const c of MALFORMED) {
    it(`malformed \`${c.label}\` via REAL bin: exit≠0, names flag, no run dir, no spend`, () => {
      const dir = tmpdir();
      try {
        // `--root dir` LAST: a missing-value flag (e.g. `--max-units`) correctly stays value-less
        // because the next token `--root` starts with `-` — exercising the real missing-value path.
        const res = spawnSync(
          process.execPath,
          [bin, "conduct", "x", ...c.args, "--root", dir],
          { encoding: "utf8", env: childEnv, timeout: 45_000 },
        );
        const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
        expect(res.status, `expected non-zero exit for ${c.label}; output: ${out}`).not.toBe(0);
        expect(out, `error should name --${c.flag}`).toContain(c.flag);
        // No run dir ⇒ no decomposer/role spawned before the rejection.
        expect(fs.existsSync(path.join(dir, ".sparra", "conduct")), `${c.label} created a run dir`).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);
  }
});

describe("conduct — docs/flag parity (verify step 7)", () => {
  const FLAGS = ["--max-units", "--concurrency", "--budget", "--max-turns", "--dry-run"];
  it("every documented flag is parsed in the cli conduct handling and vice versa", () => {
    const cli = fs.readFileSync(path.join(repoRoot, "src", "cli.ts"), "utf8");
    const docs = fs.readFileSync(path.join(repoRoot, "docs", "conduct.md"), "utf8");
    // The conduct HELP line + docs both mention every flag.
    const conductHelpLine = cli.split("\n").find((l) => l.includes('conduct "<prompt>"')) ?? "";
    for (const f of FLAGS) {
      expect(conductHelpLine).toContain(f);
      expect(docs).toContain(f);
    }
    // No stray flag documented that the parser doesn't accept: the docs' flag set ⊆ known FLAGS.
    const docFlags = new Set((docs.match(/--[a-z-]+/g) ?? []).filter((f) => /^--(max-units|concurrency|budget|max-turns|dry-run|root)$/.test(f)));
    for (const f of docFlags) {
      if (f === "--root") continue;
      expect(FLAGS).toContain(f);
    }
  });
});
