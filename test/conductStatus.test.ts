import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadCtxForRole, type Ctx } from "../src/context.ts";
import {
  cmdConductStatus,
  cmdConductList,
  parseConductReport,
} from "../src/phases/conduct.ts";
import { projectPendingDecisions } from "../src/conduct/pending.ts";
import { parse } from "../src/util/args.ts";
// Real-bin/tsx-subprocess describe blocks + tests below SKIP visibly under `SPARRA_JUDGE_SANDBOX=1`
// (the evaluator/judge sandbox denies unix-socket listen); the injected/faked tests keep running.
import { describeRealBin, itRealBin } from "./helpers/judgeEnv.ts";

/**
 * `sparra conduct --status` / `--list` — the ZERO-SPEND, read-only reporting surfaces. Fully offline:
 * temp dirs, hand-written `run.json`/decision fixtures, NO model calls, NO fake timers. Output is
 * captured by spying on process stdout/stderr; the phase logger is un-silenced for these tests via
 * SPARRA_LOG_IN_TESTS so the human/JSON text is actually observable.
 */

const noProbe = async (): Promise<void> => {};
const CANARY = "HOLDOUT-CANARY-XYZ";
const FULL_SHA = "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const bin = path.resolve(here, "../bin/sparra.mjs");
// Un-silence the phase logger in the spawned child (so usage/status text is captured), and inject a
// bogus key: a correctly zero-spend report path never calls the model, so this only surfaces a
// regression (a live call fails fast) rather than spending.
const childEnv = { ...process.env, SPARRA_LOG_IN_TESTS: "1", ANTHROPIC_API_KEY: "invalid-no-spend" };

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sparra-conduct-status-"));
}
async function makeCtx(dir: string): Promise<Ctx> {
  return loadCtxForRole(dir, { probeAuto: noProbe });
}

/** Write the `run-a`/`run-b`/`run-c` fixture tree used across the status/list assertions. Mirrors the
 *  contract's verify block (a running run with a planted brief canary, a torn run.json, an older run). */
function seedFixture(dir: string): void {
  const conduct = path.join(dir, ".sparra", "conduct");
  fs.mkdirSync(path.join(conduct, "run-a", "decisions"), { recursive: true });
  fs.mkdirSync(path.join(conduct, "run-a", "unit-001"), { recursive: true });
  fs.mkdirSync(path.join(conduct, "run-b"), { recursive: true });
  fs.mkdirSync(path.join(conduct, "run-c"), { recursive: true });
  // A planted brief whose CONTENTS must never appear in any report output (holdout wall).
  fs.writeFileSync(path.join(conduct, "run-a", "unit-001", "brief.md"), `${CANARY}\n`);
  fs.writeFileSync(
    path.join(conduct, "run-a", "run.json"),
    JSON.stringify({
      runId: "run-a",
      prompt: "line one\nline two",
      status: "running",
      createdAt: "2026-07-13T01:00:00.000Z",
      updatedAt: "2026-07-13T03:00:00.000Z",
      maxUnits: 4,
      concurrency: 2,
      dryRun: false,
      brain: "hybrid",
      decisionSurface: "park",
      units: [
        {
          id: "unit-001",
          title: "First",
          outcome: "accepted",
          briefPath: ".sparra/conduct/run-a/unit-001/brief.md",
          score: 91.2,
          cost: 0.5,
          branch: "sparra/first",
          committedSha: FULL_SHA,
          mergedInto: "sparra/run-a",
        },
        {
          id: "unit-002",
          title: "Second",
          outcome: "running",
          briefPath: ".sparra/conduct/run-a/unit-002/brief.md",
          cost: 0.25,
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(conduct, "run-a", "decisions", "3.request.json"),
    JSON.stringify({
      id: "unit-002-3",
      seq: 3,
      unit: "unit-002",
      kind: "borderline-accept",
      question: "Unit unit-002: the verdict is a borderline pass — accept, revise once more, or abandon?",
      options: ["accept", "revise", "abandon"],
      default: "accept",
      expiresAt: "2026-07-14T00:00:00.000Z",
    }),
  );
  fs.writeFileSync(path.join(conduct, "run-b", "run.json"), "{broken");
  fs.writeFileSync(
    path.join(conduct, "run-c", "run.json"),
    JSON.stringify({
      runId: "run-c",
      prompt: "older",
      status: "completed",
      createdAt: "2026-07-12T01:00:00.000Z",
      updatedAt: "2026-07-12T02:00:00.000Z",
      maxUnits: 4,
      concurrency: 2,
      dryRun: false,
      units: [
        { id: "unit-001", title: "Only", outcome: "accepted", briefPath: ".sparra/conduct/run-c/unit-001/brief.md", score: 90.0, cost: 0.1 },
      ],
    }),
  );
}

/** Run a reporting command with stdout+stderr captured and the resulting `process.exitCode`. */
async function capture(fn: () => Promise<void>): Promise<{ out: string; exit: number }> {
  process.exitCode = 0;
  const chunks: string[] = [];
  const sink = ((s: unknown) => {
    chunks.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  const o = vi.spyOn(process.stdout, "write").mockImplementation(sink);
  const e = vi.spyOn(process.stderr, "write").mockImplementation(sink);
  try {
    await fn();
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
  const exit = typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = 0;
  return { out: chunks.join(""), exit };
}

/** A CONTENT-AWARE snapshot of the `.sparra` tree: for every file, `relpath\0<sha256-of-contents>`
 *  (mirrors the contract's `shasum -a 256` verify block). A pure read must leave this byte-identical —
 *  this catches not just added/removed files but any in-place CONTENT mutation a size-only snapshot
 *  would miss (e.g. a same-length rewrite). */
function snapshot(dir: string): string {
  const root = path.join(dir, ".sparra");
  const rows: string[] = [];
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p); // lstat: never follow a (possibly hostile) symlink while snapshotting
      if (st.isDirectory()) walk(p);
      else if (st.isSymbolicLink()) rows.push(`${path.relative(root, p)}\0symlink:${fs.readlinkSync(p)}`);
      else rows.push(`${path.relative(root, p)}\0${createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`);
    }
  };
  walk(root);
  return rows.sort().join("\n");
}

let prevLog: string | undefined;
beforeEach(() => {
  prevLog = process.env.SPARRA_LOG_IN_TESTS;
  process.env.SPARRA_LOG_IN_TESTS = "1";
});
afterEach(() => {
  if (prevLog === undefined) delete process.env.SPARRA_LOG_IN_TESTS;
  else process.env.SPARRA_LOG_IN_TESTS = prevLog;
  process.exitCode = 0;
});

describe("conduct --status (assertions 1-5, 9)", () => {
  it("A1: full human render — header + every unit field, prompt on ONE line, unit-002 no crash", async () => {
    const dir = tmpdir();
    try {
      seedFixture(dir);
      const ctx = await makeCtx(dir);
      const { out, exit } = await capture(() => cmdConductStatus(ctx, "run-a", {}));
      expect(exit).toBe(0);
      // header
      expect(out).toContain("run-a");
      expect(out).toContain("running");
      expect(out).toContain("hybrid");
      expect(out).toContain("park");
      expect(out).toContain("2026-07-13T01:00:00.000Z"); // createdAt
      expect(out).toContain("2026-07-13T03:00:00.000Z"); // updatedAt
      // prompt truncated to ONE line: first line present, second absent, no raw newline break within it
      expect(out).toContain("line one");
      expect(out).not.toContain("line two");
      // unit-001 fields
      expect(out).toContain("unit-001");
      expect(out).toContain("First");
      expect(out).toContain("accepted");
      expect(out).toContain("91.2");
      expect(out).toContain("sparra/first");
      expect(out).toContain("sparra/run-a"); // mergedInto
      // SHORT sha: a prefix of the full sha, and NOT the full 40-char sha
      expect(out).toContain(FULL_SHA.slice(0, 12));
      expect(out).not.toContain(FULL_SHA);
      // unit-002 (missing score/branch/sha/mergedInto) renders without crashing
      expect(out).toContain("unit-002");
      expect(out).toContain("Second");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A2: pending decision seq 3 + question + hint; --json carries the allowlist projection", async () => {
    const dir = tmpdir();
    try {
      seedFixture(dir);
      const ctx = await makeCtx(dir);
      const human = await capture(() => cmdConductStatus(ctx, "run-a", {}));
      expect(human.exit).toBe(0);
      expect(human.out).toContain("borderline pass"); // the question text
      expect(human.out).toContain("--decide run-a 3"); // the answer hint

      const json = await capture(() => cmdConductStatus(ctx, "run-a", { json: true }));
      expect(json.exit).toBe(0);
      const doc = JSON.parse(json.out);
      expect(doc.runId).toBe("run-a"); // run.json fields present
      expect(doc.status).toBe("running");
      expect(Array.isArray(doc.pendingDecisions)).toBe(true);
      const p = doc.pendingDecisions.find((x: { seq: number }) => x.seq === 3);
      expect(p).toBeDefined();
      // allowlist fields exactly
      expect(p).toMatchObject({
        seq: 3,
        unit: "unit-002",
        kind: "borderline-accept",
        options: ["accept", "revise", "abandon"],
        default: "accept",
        expiresAt: "2026-07-14T00:00:00.000Z",
      });
      expect(typeof p.question).toBe("string");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A3: unknown runId → exit 1 naming it, .sparra tree byte-identical (no side effects)", async () => {
    const dir = tmpdir();
    try {
      seedFixture(dir);
      const ctx = await makeCtx(dir);
      const before = snapshot(dir);
      const { out, exit } = await capture(() => cmdConductStatus(ctx, "nope", {}));
      expect(exit).toBe(1);
      expect(out).toContain("nope");
      expect(snapshot(dir)).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A4: unsafe runId (../run-a) → exit 1 naming it, nothing read/written outside conduct/", async () => {
    const dir = tmpdir();
    try {
      seedFixture(dir);
      const ctx = await makeCtx(dir);
      const before = snapshot(dir);
      const { out, exit } = await capture(() => cmdConductStatus(ctx, "../run-a", {}));
      expect(exit).toBe(1);
      expect(out).toContain("../run-a");
      expect(snapshot(dir)).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A5: once 3.decision.json exists, seq 3 is ABSENT from human output and --json pendingDecisions is []", async () => {
    const dir = tmpdir();
    try {
      seedFixture(dir);
      fs.writeFileSync(
        path.join(dir, ".sparra", "conduct", "run-a", "decisions", "3.decision.json"),
        JSON.stringify({ answer: "accept" }),
      );
      const ctx = await makeCtx(dir);
      const human = await capture(() => cmdConductStatus(ctx, "run-a", {}));
      expect(human.exit).toBe(0);
      expect(human.out).not.toContain("--decide run-a 3");
      expect(human.out).not.toContain("borderline pass");

      const json = await capture(() => cmdConductStatus(ctx, "run-a", { json: true }));
      const doc = JSON.parse(json.out);
      expect(doc.pendingDecisions).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A9: the planted brief canary appears in NO status output (human or --json)", async () => {
    const dir = tmpdir();
    try {
      seedFixture(dir);
      const ctx = await makeCtx(dir);
      const human = await capture(() => cmdConductStatus(ctx, "run-a", {}));
      const json = await capture(() => cmdConductStatus(ctx, "run-a", { json: true }));
      expect(human.out).not.toContain(CANARY);
      expect(json.out).not.toContain(CANARY);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct --list (assertions 6, 7, 9)", () => {
  it("A6: newest-first ordering, accepted/total + total cost, corrupt run.json → 'unreadable', --json parses", async () => {
    const dir = tmpdir();
    try {
      seedFixture(dir);
      const ctx = await makeCtx(dir);
      const { out, exit } = await capture(() => cmdConductList(ctx, {}));
      expect(exit).toBe(0);
      // ordering: run-a (updated 03:00) BEFORE run-c (updated 02:00 the prior day)
      const iA = out.indexOf("run-a");
      const iC = out.indexOf("run-c");
      expect(iA).toBeGreaterThanOrEqual(0);
      expect(iC).toBeGreaterThan(iA);
      // run-a headline: 1/2 accepted, total cost 0.75 (0.5 + 0.25)
      expect(out).toContain("1/2");
      expect(out).toContain("0.75");
      // run-b corrupt → unreadable, never a crash
      expect(out).toContain("run-b");
      expect(out).toContain("unreadable");

      const json = await capture(() => cmdConductList(ctx, { json: true }));
      const rows = JSON.parse(json.out) as Array<{ runId: string; status: string; accepted: number; total: number; cost: number }>;
      const a = rows.find((r) => r.runId === "run-a")!;
      expect(a).toMatchObject({ accepted: 1, total: 2 });
      expect(a.cost).toBeCloseTo(0.75, 6);
      expect(rows.find((r) => r.runId === "run-b")!.status).toBe("unreadable");
      // newest-first: run-a index before run-c index in the array too
      expect(rows.findIndex((r) => r.runId === "run-a")).toBeLessThan(rows.findIndex((r) => r.runId === "run-c"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A7: no conduct dir → 'no conduct runs', exit 0; empty conduct dir → same", async () => {
    const empty = tmpdir();
    const emptyConduct = tmpdir();
    try {
      const ctx1 = await makeCtx(empty); // no .sparra/conduct at all
      const r1 = await capture(() => cmdConductList(ctx1, {}));
      expect(r1.exit).toBe(0);
      expect(r1.out).toContain("no conduct runs");

      fs.mkdirSync(path.join(emptyConduct, ".sparra", "conduct"), { recursive: true });
      const ctx2 = await makeCtx(emptyConduct);
      const r2 = await capture(() => cmdConductList(ctx2, {}));
      expect(r2.exit).toBe(0);
      expect(r2.out).toContain("no conduct runs");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
      fs.rmSync(emptyConduct, { recursive: true, force: true });
    }
  });

  it("A9: the planted brief canary appears in NO list output (human or --json)", async () => {
    const dir = tmpdir();
    try {
      seedFixture(dir);
      const ctx = await makeCtx(dir);
      const human = await capture(() => cmdConductList(ctx, {}));
      const json = await capture(() => cmdConductList(ctx, { json: true }));
      expect(human.out).not.toContain(CANARY);
      expect(json.out).not.toContain(CANARY);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct report — usage matrix (assertion 8, pure classifier, no I/O)", () => {
  const usage = (argv: string[]): ReturnType<typeof parseConductReport> => {
    const { positionals, flags } = parse(argv);
    return parseConductReport(positionals, flags);
  };

  it("valid promptless forms classify to status/list", () => {
    expect(usage(["conduct", "--status", "run-a"])).toEqual({ kind: "status", runId: "run-a", json: false });
    expect(usage(["conduct", "--status", "run-a", "--json"])).toEqual({ kind: "status", runId: "run-a", json: true });
    expect(usage(["conduct", "--list"])).toEqual({ kind: "list", json: false });
    expect(usage(["conduct", "--list", "--json"])).toEqual({ kind: "list", json: true });
  });

  it("no reporting flag → 'none' (falls through to run/decide/resume)", () => {
    expect(usage(["conduct", "build a thing"])).toEqual({ kind: "none" });
    expect(usage(["conduct", "--resume", "run-a"])).toEqual({ kind: "none" });
  });

  // Each of the five contract combos → usage-error (exit-1 path in the CLI, no side effects/spend).
  const bad: Array<[string, string[]]> = [
    ["prompt + --status", ["conduct", "hi", "--status", "run-a"]],
    ["prompt + --list", ["conduct", "hi", "--list"]],
    ["--status + --list", ["conduct", "--status", "run-a", "--list"]],
    ["--status + --resume", ["conduct", "--status", "run-a", "--resume", "run-a"]],
    ["--status + --decide", ["conduct", "--status", "run-a", "--decide", "run-a", "3", "accept"]],
  ];
  for (const [label, argv] of bad) {
    it(`${label} → usage-error`, () => {
      const r = usage(argv);
      expect(r.kind).toBe("usage-error");
    });
  }

  it("value-less --status → usage-error naming the required runId", () => {
    // `--status` at end of argv → boolean true (no runId captured).
    const r = usage(["conduct", "--status"]);
    expect(r.kind).toBe("usage-error");
    if (r.kind === "usage-error") expect(r.error).toMatch(/runId/i);
  });
});

describe("projectPendingDecisions — NON-degenerate resolved-seq filter (assertion 11)", () => {
  it("keeps an unresolved seq and DROPS a same-dir seq that has a matching decision file", () => {
    const dir = tmpdir();
    try {
      const runDir = path.join(dir, ".sparra", "conduct", "run-x");
      const dd = path.join(runDir, "decisions");
      fs.mkdirSync(dd, { recursive: true });
      // seq 3: an UNRESOLVED request (no decision file) → must appear.
      fs.writeFileSync(
        path.join(dd, "3.request.json"),
        JSON.stringify({ seq: 3, unit: "u3", kind: "borderline-accept", question: "q3", options: ["accept"], default: "accept", expiresAt: "z" }),
      );
      // seq 5: a RESOLVED pair — request AND matching decision in the SAME dir → must be filtered out.
      fs.writeFileSync(
        path.join(dd, "5.request.json"),
        JSON.stringify({ seq: 5, unit: "u5", kind: "unit-exhausted", question: "q5", options: ["pivot"], default: "pivot", expiresAt: "z" }),
      );
      fs.writeFileSync(path.join(dd, "5.decision.json"), JSON.stringify({ answer: "pivot" }));

      const pending = projectPendingDecisions(runDir);
      // TIGHT assertion: EXACTLY [seq 3]. This is what makes the test a real filter guard — a resolved
      // request (seq 5) IS present in the dir, so if the resolved-seq filter is flipped/removed
      // (`if (answered.has(seq)) continue;` deleted), seq 5 rides along and this deepEqual FAILS.
      expect(pending.map((p) => p.seq)).toEqual([3]);
      expect(pending.find((p) => p.seq === 5)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────── round-2 blocking-gap adversaries (beyond the contract fixtures) ─────────────────

describe("realpath containment — a symlinked run dir that escapes conduct/ is refused", () => {
  it("--status <symlink-out> → exit 1, reads NOTHING outside conduct/, tree byte-identical", async () => {
    const dir = tmpdir();
    const outside = tmpdir(); // a sibling tree the symlink will try to reach
    try {
      seedFixture(dir);
      // Plant a run.json with a canary OUTSIDE the conduct tree, then symlink it in as a "run".
      fs.mkdirSync(path.join(outside, "secret"), { recursive: true });
      fs.writeFileSync(
        path.join(outside, "secret", "run.json"),
        JSON.stringify({ runId: "escaped", prompt: CANARY, status: "running", updatedAt: "z", units: [] }),
      );
      const conduct = path.join(dir, ".sparra", "conduct");
      try {
        fs.symlinkSync(path.join(outside, "secret"), path.join(conduct, "escaped"), "dir");
      } catch {
        return; // platform without symlink support — skip (the guard is still exercised on Unix CI)
      }
      const ctx = await makeCtx(dir);
      const before = snapshot(dir);
      const { out, exit } = await capture(() => cmdConductStatus(ctx, "escaped", {}));
      expect(exit).toBe(1); // escapes conduct/ → treated as "no such run"
      expect(out).toContain("escaped");
      expect(out).not.toContain(CANARY); // the out-of-root run.json was NOT read
      expect(snapshot(dir)).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("--list SKIPS a symlinked-out run dir (its canary never surfaces)", async () => {
    const dir = tmpdir();
    const outside = tmpdir();
    try {
      seedFixture(dir);
      fs.mkdirSync(path.join(outside, "secret"), { recursive: true });
      fs.writeFileSync(
        path.join(outside, "secret", "run.json"),
        JSON.stringify({ runId: "escaped", prompt: CANARY, status: "running", updatedAt: "9999-01-01T00:00:00.000Z", units: [] }),
      );
      const conduct = path.join(dir, ".sparra", "conduct");
      try {
        fs.symlinkSync(path.join(outside, "secret"), path.join(conduct, "escaped"), "dir");
      } catch {
        return;
      }
      const ctx = await makeCtx(dir);
      const { out, exit } = await capture(() => cmdConductList(ctx, {}));
      expect(exit).toBe(0);
      expect(out).not.toContain("escaped"); // the escaping symlink is not a listable run
      expect(out).not.toContain(CANARY);
      // real runs still listed
      expect(out).toContain("run-a");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("symlink-redirect guard on FILES (round-3 blocking gap)", () => {
  // A run dir can be realpath-CONTAINED yet hold a symlink FILE. The escaping-DIR guard (above) does
  // not catch these: a `run.json` / `<seq>.request.json` planted as a link to a holdout artifact that
  // lives INSIDE the conduct tree passes dir-containment, so a file-level guard is required.

  // Plant a VALID-JSON holdout artifact (not the non-JSON brief.md) inside the conduct tree, then
  // symlink a run's run.json at it. This is the genuine leak vector: without the file-level guard,
  // JSON.parse SUCCEEDS and `--status --json` would emit the holdout document (canary) verbatim —
  // pointing at a non-JSON file would read "unreadable" even WITHOUT the guard (a degenerate test).
  function seedHoldoutJson(conduct: string): string {
    const holdout = path.join(conduct, "run-a", "unit-001", "verdict.json");
    fs.writeFileSync(holdout, JSON.stringify({ runId: "leaked", secret: CANARY, prompt: CANARY, units: [] }));
    return holdout;
  }

  it("--status: a run.json that is a SYMLINK to a valid-JSON holdout is 'unreadable', canary never leaks", async () => {
    const dir = tmpdir();
    try {
      seedFixture(dir);
      const conduct = path.join(dir, ".sparra", "conduct");
      const holdout = seedHoldoutJson(conduct);
      fs.mkdirSync(path.join(conduct, "run-link"), { recursive: true });
      // run.json is a SYMLINK pointing at a holdout JSON doc INSIDE the conduct tree (so a
      // dir-containment-only guard would follow it and leak the document into --status --json).
      try {
        fs.symlinkSync(holdout, path.join(conduct, "run-link", "run.json"), "file");
      } catch {
        return; // no symlink support → skip (exercised on Unix CI)
      }
      const ctx = await makeCtx(dir);
      const human = await capture(() => cmdConductStatus(ctx, "run-link", {}));
      expect(human.exit).toBe(1); // symlinked run.json → refused as unreadable
      expect(human.out).not.toContain(CANARY);
      const json = await capture(() => cmdConductStatus(ctx, "run-link", { json: true }));
      expect(json.exit).toBe(1);
      expect(json.out).not.toContain(CANARY); // WITHOUT the guard this parses+emits the holdout → leak
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--list: a run whose run.json is a symlink-to-holdout is listed 'unreadable', canary never leaks", async () => {
    const dir = tmpdir();
    try {
      seedFixture(dir);
      const conduct = path.join(dir, ".sparra", "conduct");
      const holdout = seedHoldoutJson(conduct);
      fs.mkdirSync(path.join(conduct, "run-link"), { recursive: true });
      try {
        fs.symlinkSync(holdout, path.join(conduct, "run-link", "run.json"), "file");
      } catch {
        return;
      }
      const ctx = await makeCtx(dir);
      const { out, exit } = await capture(() => cmdConductList(ctx, {}));
      expect(exit).toBe(0);
      expect(out).toContain("run-link");
      expect(out).toContain("unreadable"); // both run-b (torn) and run-link (symlink) surface as unreadable
      expect(out).not.toContain(CANARY);
      expect(out).not.toContain("leaked"); // the holdout's runId field never surfaces either
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("projectPendingDecisions: a <seq>.request.json SYMLINK to a holdout brief is NOT followed/surfaced", () => {
    const dir = tmpdir();
    try {
      const conduct = path.join(dir, ".sparra", "conduct");
      const runDir = path.join(conduct, "run-p");
      const dd = path.join(runDir, "decisions");
      fs.mkdirSync(dd, { recursive: true });
      // A holdout artifact inside the conduct tree.
      fs.mkdirSync(path.join(runDir, "unit-001"), { recursive: true });
      const secret = path.join(runDir, "unit-001", "verdict.json");
      fs.writeFileSync(secret, JSON.stringify({ seq: 7, unit: "leak", kind: CANARY, question: CANARY, options: [CANARY], default: CANARY, expiresAt: CANARY }));
      // seq 7: request.json is a SYMLINK to that holdout verdict — a dir-contained redirect.
      let symlinked = true;
      try {
        fs.symlinkSync(secret, path.join(dd, "7.request.json"), "file");
      } catch {
        symlinked = false;
      }
      // seq 8: a genuine pending request survives alongside the hostile symlink.
      fs.writeFileSync(
        path.join(dd, "8.request.json"),
        JSON.stringify({ seq: 8, unit: "u8", kind: "k", question: "q8", options: ["a"], default: "a", expiresAt: "z" }),
      );
      const pending = projectPendingDecisions(runDir);
      const seqs = pending.map((p) => p.seq);
      expect(seqs).toContain(8);
      if (symlinked) {
        expect(seqs).not.toContain(7); // the symlinked request was refused, not projected
        expect(JSON.stringify(pending)).not.toContain(CANARY);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("projectPendingDecisions — hostile/torn request files never crash", () => {
  const write = (dd: string, name: string, body: string): void => {
    fs.mkdirSync(dd, { recursive: true });
    fs.writeFileSync(path.join(dd, name), body);
  };

  it("a request file whose JSON is `null` / an array / a bare number is SKIPPED (not a throw, not raw)", () => {
    const dir = tmpdir();
    try {
      const runDir = path.join(dir, ".sparra", "conduct", "run-y");
      const dd = path.join(runDir, "decisions");
      write(dd, "1.request.json", "null"); // valid JSON, but not an object → must not `null.unit` crash
      write(dd, "2.request.json", "[1,2,3]"); // an array
      write(dd, "3.request.json", "42"); // a bare number
      write(dd, "4.request.json", "{not json"); // torn
      // a genuinely valid pending request survives alongside the hostile ones
      write(
        dd,
        "5.request.json",
        JSON.stringify({ seq: 5, unit: "u5", kind: "k", question: "q5", options: ["a"], default: "a", expiresAt: "z" }),
      );
      let pending: ReturnType<typeof projectPendingDecisions>;
      expect(() => {
        pending = projectPendingDecisions(runDir);
      }).not.toThrow();
      expect(pending!.map((p) => p.seq)).toEqual([5]); // only the well-formed request survives
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conduct report — fail-closed on incompatible/unknown flags (assertion 8, extended)", () => {
  const usage = (argv: string[]): ReturnType<typeof parseConductReport> => {
    const { positionals, flags } = parse(argv);
    return parseConductReport(positionals, flags);
  };
  // Every action / run-shaping / unknown flag alongside a reporting flag must fail-closed.
  const combos: string[][] = [
    ["conduct", "--status", "run-a", "--commit"],
    ["conduct", "--status", "run-a", "--merge"],
    ["conduct", "--status", "run-a", "--auto"],
    ["conduct", "--status", "run-a", "--dry-run"],
    ["conduct", "--status", "run-a", "--brain", "llm"],
    ["conduct", "--status", "run-a", "--max-units", "2"],
    ["conduct", "--status", "run-a", "--budget", "5"],
    ["conduct", "--status", "run-a", "--totally-unknown"],
    ["conduct", "--list", "--commit"],
    ["conduct", "--list", "--auto"],
    ["conduct", "--list", "--typo"],
  ];
  for (const argv of combos) {
    it(`${argv.slice(1).join(" ")} → usage-error`, () => {
      expect(usage(argv).kind).toBe("usage-error");
    });
  }

  it("the ALLOWED companion flags (--json, --root) do NOT trip the fail-closed sweep", () => {
    expect(usage(["conduct", "--status", "run-a", "--json"]).kind).toBe("status");
    expect(usage(["conduct", "--status", "run-a", "--root", "/tmp/x"]).kind).toBe("status");
    expect(usage(["conduct", "--list", "--json", "--root", "/tmp/x"]).kind).toBe("list");
  });
});

describe("conduct report — fail-closed VALUED-boolean flag parsing (round-3 blocking gap)", () => {
  const usage = (argv: string[]): ReturnType<typeof parseConductReport> => {
    const { positionals, flags } = parse(argv);
    return parseConductReport(positionals, flags);
  };

  // The generic arg parser greedily binds a trailing positional as a flag's VALUE. `--list` and
  // `--json` are pure booleans, so a bound value is a misuse that must FAIL CLOSED (exit 1) rather
  // than: (a) silently swallow the token, or (b) for --json, fail OPEN by downgrading to human output.
  it("`--list <token>` (list swallows a positional) → usage-error, not a silently-ignored token", () => {
    // Guard against the naive `flags.list !== undefined` detection accepting a stringy --list.
    const { positionals, flags } = parse(["conduct", "--list", "run-a"]);
    expect(flags["list"]).toBe("run-a"); // parser bound the positional as the value…
    expect(positionals).toEqual(["conduct"]); // …so it is NOT a stray positional the prompt-check sees
    const r = parseConductReport(positionals, flags);
    expect(r.kind).toBe("usage-error"); // …and MUST be rejected, not treated as a bare `--list`
    if (r.kind === "usage-error") expect(r.error).toMatch(/--list/);
  });

  it("`--status run-a --json <token>` (json swallows a positional) → usage-error, NOT a silent human downgrade", () => {
    const { positionals, flags } = parse(["conduct", "--status", "run-a", "--json", "extra"]);
    expect(flags["json"]).toBe("extra"); // json is a STRING here, so `=== true` would be false…
    const r = parseConductReport(positionals, flags);
    expect(r.kind).toBe("usage-error"); // …fail closed rather than silently emitting human output
    if (r.kind === "usage-error") expect(r.error).toMatch(/--json/);
  });

  itRealBin("`--list <token>` via the REAL bin exits 1 (no silent success)", () => {
    const dir = tmpdir();
    try {
      seedFixture(dir);
      const res = spawnSync(process.execPath, [bin, "conduct", "--list", "run-a"], {
        cwd: dir,
        encoding: "utf8",
        env: childEnv,
        timeout: 60_000,
      });
      expect(res.status).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("the valid bare forms still classify (the guard doesn't over-reject)", () => {
    expect(usage(["conduct", "--list"]).kind).toBe("list");
    expect(usage(["conduct", "--list", "--json"]).kind).toBe("list");
    expect(usage(["conduct", "--status", "run-a", "--json"]).kind).toBe("status");
  });
});

describe("marketplace plugin version (assertion 14, FLOOR compare)", () => {
  it("metadata.version parses to strictly greater than the pre-change 2026.7.13.9", () => {
    const raw = fs.readFileSync(path.resolve(repoRoot, ".claude-plugin", "marketplace.json"), "utf8");
    const version = String((JSON.parse(raw) as { metadata: { version: string } }).metadata.version);
    const parse4 = (v: string): number[] => v.split(".").map((n) => Number(n));
    const cur = parse4(version);
    const floor = parse4("2026.7.13.9");
    // Component-wise lexical compare: cur must be strictly greater than the floor (never an exact pin).
    let cmp = 0;
    for (let i = 0; i < Math.max(cur.length, floor.length) && cmp === 0; i++) {
      cmp = (cur[i] ?? 0) - (floor[i] ?? 0);
    }
    expect(cmp).toBeGreaterThan(0);
  });
});

// REAL-PATH coverage: drive the ACTUAL `bin/sparra.mjs` argv → cli.ts routing → cmd, so the reporting
// surfaces are proven through the same entry point the evaluator runs (not just the exported cmds).
// Zero spend by construction (report paths never call the model; a bogus key belts any regression).
describeRealBin("conduct --status/--list via the REAL bin (cli.ts routing)", () => {
  function bin_(argv: string[], cwd: string) {
    const res = spawnSync(process.execPath, [bin, "conduct", ...argv], { cwd, encoding: "utf8", env: childEnv, timeout: 60_000 });
    return { out: `${res.stdout ?? ""}${res.stderr ?? ""}`, status: res.status };
  }

  it("A1/A6/A8/A7 through the real CLI", () => {
    const dir = tmpdir();
    const empty = tmpdir();
    try {
      seedFixture(dir);

      // A1: status render, exit 0, no canary, short sha only.
      const s = bin_(["--status", "run-a"], dir);
      expect(s.status).toBe(0);
      expect(s.out).toContain("run-a");
      expect(s.out).toContain("91.2");
      expect(s.out).toContain(FULL_SHA.slice(0, 12));
      expect(s.out).not.toContain(FULL_SHA);
      expect(s.out).not.toContain(CANARY);
      expect(s.out).toContain("--decide run-a 3");

      // A2: --json parses on the wire (no banner/log leakage corrupting stdout).
      const sj = bin_(["--status", "run-a", "--json"], dir);
      expect(sj.status).toBe(0);
      const doc = JSON.parse(sj.out);
      expect(doc.pendingDecisions.some((p: { seq: number }) => p.seq === 3)).toBe(true);
      expect(JSON.stringify(doc)).not.toContain(CANARY);

      // A6: list ordering + unreadable + --json.
      const l = bin_(["--list"], dir);
      expect(l.status).toBe(0);
      expect(l.out.indexOf("run-a")).toBeLessThan(l.out.indexOf("run-c"));
      expect(l.out).toContain("unreadable");
      expect(l.out).toContain("0.75");
      const lj = bin_(["--list", "--json"], dir);
      JSON.parse(lj.out);

      // A3/A4: unknown + unsafe exit 1.
      expect(bin_(["--status", "nope"], dir).status).toBe(1);
      expect(bin_(["--status", "../run-a"], dir).status).toBe(1);

      // A8: each usage combo exits 1.
      expect(bin_(["hi", "--status", "run-a"], dir).status).toBe(1);
      expect(bin_(["hi", "--list"], dir).status).toBe(1);
      expect(bin_(["--status", "run-a", "--list"], dir).status).toBe(1);
      expect(bin_(["--status", "run-a", "--resume", "run-a"], dir).status).toBe(1);
      expect(bin_(["--status", "run-a", "--decide", "run-a", "3", "accept"], dir).status).toBe(1);

      // A7: empty dir → friendly message, exit 0.
      const e = bin_(["--list"], empty);
      expect(e.status).toBe(0);
      expect(e.out).toContain("no conduct runs");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(empty, { recursive: true, force: true });
    }
  }, 120_000);
});
