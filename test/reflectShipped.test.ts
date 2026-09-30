import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { defaultConfig, type SparraConfig } from "../src/config.ts";
import { cmdReflect, upstreamInboxDir } from "../src/phases/reflect.ts";
import {
  createShippedJudge,
  normalizeShippedConfig,
  pickShippedCommit,
  readRecentCommits,
  validateShippedFlags,
  type CommitInfo,
  type CommitSource,
  type ShippedClientFactory,
  type ShippedJevClient,
  type ShippedJudge,
  type ShippedVerdict,
} from "../src/phases/reflectShipped.ts";
import { MAX_FINDING_CHARS } from "../src/phases/reflectDedupe.ts";
import { loadInbox } from "../src/phases/upstreamTriage.ts";
import { dispatchPhase } from "../src/cli.ts";
import { parse } from "../src/util/args.ts";
import type { Ctx } from "../src/context.ts";

const FAKE_KEY = "fake-key-for-tests-0000";
const KEY_ENV = "SPARRA_TEST_SHIPPED_KEY";

const savedEnv = { home: process.env.SPARRA_HOME, key: process.env[KEY_ENV] };
afterEach(() => {
  vi.restoreAllMocks();
  if (savedEnv.home === undefined) delete process.env.SPARRA_HOME;
  else process.env.SPARRA_HOME = savedEnv.home;
  if (savedEnv.key === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = savedEnv.key;
});

function withTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-shipped-home-"));
  process.env.SPARRA_HOME = home;
  return home;
}

/** Five findings T1..T5 in ONE inbox file → globalIndex 1..5 (all recurrence 1, file order). */
function seedFive(home: string): string {
  const dir = path.join(home, "reflections");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.md"), [1, 2, 3, 4, 5].map((n) => `### T${n}\nbody of finding ${n}\n`).join("\n"));
  return dir;
}

const inboxSnapshot = (): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix = ""): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${prefix}${e.name}/`);
      else out[`${prefix}${e.name}`] = fs.readFileSync(path.join(dir, e.name), "utf8");
    }
  };
  walk(upstreamInboxDir());
  return out;
};

function ctxFor(config: SparraConfig = defaultConfig()): Ctx {
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), "sparra-shipped-root-")), config } as unknown as Ctx;
}

function cfgWith(shipped: Record<string, unknown>, dedupe: Record<string, unknown> = { apiKeyEnv: KEY_ENV }): SparraConfig {
  const c = defaultConfig();
  Object.assign(c.reflect.shippedCheck, shipped);
  Object.assign(c.reflect.dedupe, dedupe);
  return c;
}

/** Capture stdout lines (the logger is silenced under vitest unless SPARRA_LOG_IN_TESTS is set). */
function captureLog(): { lines: () => string[]; restore: () => void } {
  const prior = process.env.SPARRA_LOG_IN_TESTS;
  process.env.SPARRA_LOG_IN_TESTS = "1";
  let buf = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
  return {
    lines: () => buf.split("\n").filter(Boolean),
    restore: () => {
      spy.mockRestore();
      if (prior === undefined) delete process.env.SPARRA_LOG_IN_TESTS;
      else process.env.SPARRA_LOG_IN_TESTS = prior;
    },
  };
}
const warnLines = (lines: string[]) => lines.filter((l) => l.startsWith("!") || l.includes("! "));

async function captured<T>(fn: () => Promise<T>): Promise<{ lines: string[]; result: T }> {
  const cap = captureLog();
  try {
    const result = await fn();
    return { lines: cap.lines(), result };
  } finally {
    cap.restore();
  }
}

/** Newest-first commits c1 (newest) .. cN, with distinct short shas. */
const commits = (n: number): CommitInfo[] =>
  Array.from({ length: n }, (_, i) => ({ sha: `c0ffee${i + 1}`, subject: `subject ${i + 1}`, body: `body ${i + 1}` }));
const source = (list: CommitInfo[]): CommitSource & { calls: { root: string; count: number }[] } => {
  const calls: { root: string; count: number }[] = [];
  const fn = ((root: string, count: number) => {
    calls.push({ root, count });
    return list;
  }) as CommitSource & { calls: typeof calls };
  fn.calls = calls;
  return fn;
};

const fixes = (p: number): ShippedVerdict => ({ fixed: p, relation: "fixes" });
const NONE: ShippedVerdict = { fixed: 0, relation: "unrelated" };

/** A fake judge keyed on `<finding title>|<commit sha>`; unlisted pairs → unrelated. Records calls. */
function fakeJudge(
  table: Record<string, ShippedVerdict | Error | "invalid">,
  opts: { delayTicks?: (findingTitle: string, sha: string) => number } = {},
): { judge: ShippedJudge; calls: { finding: string; commit: string }[]; peak: () => number } {
  const calls: { finding: string; commit: string }[] = [];
  let active = 0;
  let peak = 0;
  const judge: ShippedJudge = async (finding, commit) => {
    calls.push({ finding, commit });
    const title = /^### (\S+)/.exec(finding)?.[1] ?? "?";
    const sha = commit.split(" ")[0]!;
    active++;
    peak = Math.max(peak, active);
    for (let i = 0; i < (opts.delayTicks?.(title, sha) ?? 0); i++) await Promise.resolve();
    active--;
    const v = table[`${title}|${sha}`];
    if (v instanceof Error) throw v;
    if (v === "invalid") return { fixed: 7, relation: "nope" } as unknown as ShippedVerdict;
    return v ?? NONE;
  };
  return { judge, calls, peak: () => peak };
}

const suggestionLines = (lines: string[]) => lines.filter((l) => / — likely shipped in /.test(l));
const doneLine = (lines: string[]) => lines.find((l) => l.startsWith("sparra reflect --upstream --done "));

describe("pure helpers", () => {
  it("A4 suggestion rule: noul ≥ threshold AND choice fixes; highest noul wins, ties → newest", () => {
    expect(pickShippedCommit([fixes(0.9)], 0.8)).toBe(0);
    expect(pickShippedCommit([{ fixed: 0.95, relation: "partially_addresses" }], 0.8)).toBe(-1);
    expect(pickShippedCommit([{ fixed: 0.95, relation: "unrelated" }], 0.8)).toBe(-1);
    expect(pickShippedCommit([fixes(0.79)], 0.8)).toBe(-1);
    expect(pickShippedCommit([fixes(0.8)], 0.8)).toBe(0); // the floor is inclusive
    expect(pickShippedCommit([null, fixes(0.85), fixes(0.85), fixes(0.9), fixes(0.9)], 0.8)).toBe(3);
    expect(pickShippedCommit([fixes(0.85), fixes(0.85)], 0.8)).toBe(0);
    expect(pickShippedCommit([null, null], 0.8)).toBe(-1);
    expect(pickShippedCommit([], 0.8)).toBe(-1);
  });

  it("A7 flag validation matrix", () => {
    const base = { upstream: true, checkShipped: true };
    expect(validateShippedFlags(base)).toEqual({ check: true });
    expect(validateShippedFlags({ ...base, commits: "5" })).toEqual({ check: true, commits: 5 });
    expect(validateShippedFlags({ ...base, commits: 7 })).toEqual({ check: true, commits: 7 });
    expect(validateShippedFlags({ upstream: true })).toEqual({ check: false });
    expect(validateShippedFlags({})).toEqual({ check: false });
    expect(() => validateShippedFlags({ checkShipped: true })).toThrow(/requires --upstream/);
    expect(() => validateShippedFlags({ ...base, done: "1" })).toThrow(/--done/);
    expect(() => validateShippedFlags({ ...base, done: true })).toThrow(/--done/);
    expect(() => validateShippedFlags({ ...base, wontdo: "1" })).toThrow(/--wontdo/);
    expect(() => validateShippedFlags({ ...base, clear: true })).toThrow(/--clear/);
    expect(() => validateShippedFlags({ upstream: true, commits: "5" })).toThrow(/requires --check-shipped/);
    expect(() => validateShippedFlags({ commits: "5" })).toThrow(/requires --check-shipped/);
    for (const bad of ["0", "-1", "1.5", "abc", "", "5x", true, 0, -3, 2.5, Number.NaN, Infinity]) {
      expect(() => validateShippedFlags({ ...base, commits: bad }), String(bad)).toThrow(/positive integer/);
    }
    expect(() => validateShippedFlags({ ...base, checkShipped: "yes" })).toThrow(/takes no value/);
  });

  it("A9 config: defaults match the contract, dedupe defaults unchanged, invalid values normalize with ONE warn", async () => {
    const d = defaultConfig().reflect;
    expect(d.shippedCheck).toEqual({ commits: 30, threshold: 0.8, concurrency: 8 });
    expect(d.dedupe).toEqual({
      enabled: false,
      model: "jev-1.13.0",
      apiKeyEnv: "TYPESAFE_API_KEY",
      autoThreshold: 0.9,
      suggestThreshold: 0.5,
      maxSuggestions: 3,
      concurrency: 8,
    });

    const { lines, result } = await captured(async () => [
      normalizeShippedConfig({ commits: 12, threshold: 0.6, concurrency: 2 }),
      normalizeShippedConfig(undefined),
      normalizeShippedConfig({ commits: 0, threshold: 1.5, concurrency: 2.5 }),
      normalizeShippedConfig({ commits: "many", threshold: "high", concurrency: -1 } as never),
    ]);
    expect(result[0]).toEqual({ commits: 12, threshold: 0.6, concurrency: 2 });
    expect(result[1]).toEqual(d.shippedCheck);
    expect(result[2]).toEqual({ commits: 30, threshold: 0.8, concurrency: 8 });
    expect(result[3]).toEqual({ commits: 30, threshold: 0.8, concurrency: 8 });
    expect(warnLines(lines).filter((l) => l.includes("reflect.shippedCheck"))).toHaveLength(2); // one per bad block
  });
});

describe("createShippedJudge — request shape (fake SDK client)", () => {
  function fakeClient() {
    const requests: Parameters<ShippedJevClient["systemOne"]>[0][] = [];
    const inits: { apiKey: string; model: string }[] = [];
    const factory: ShippedClientFactory = (init) => {
      inits.push(init);
      return {
        systemOne: async (req) => {
          requests.push(req);
          return { answers: { fixed: { noul: 0.9 }, relation: { choice: "fixes" } } };
        },
      };
    };
    return { factory, requests, inits };
  }

  it("A3 F findings × C commits → exactly F×C systemOne calls, two-key clipped state, Noul + Choice, configured model", async () => {
    process.env[KEY_ENV] = FAKE_KEY;
    const home = withTempHome();
    const dir = path.join(home, "reflections");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.md"), "### Huge\n" + "x".repeat(50_000) + "\n\n### Small\nbody\n");
    const { factory, requests, inits } = fakeClient();
    const list = [...commits(3)];
    list[0] = { ...list[0]!, body: "y".repeat(50_000) };
    await captured(() =>
      cmdReflect(ctxFor(cfgWith({}, { apiKeyEnv: KEY_ENV, model: "jev-9.9.9" })), {
        upstream: true,
        checkShipped: true,
        shippedClientFactory: factory,
        commitSource: source(list),
      }),
    );
    expect(requests).toHaveLength(2 * 3);
    expect(inits).toEqual([{ apiKey: FAKE_KEY, model: "jev-9.9.9" }]);
    for (const r of requests) {
      expect(Object.keys(r.state).sort()).toEqual(["commit", "finding"]);
      expect(r.state.finding.length).toBeLessThanOrEqual(MAX_FINDING_CHARS);
      expect(r.state.commit.length).toBeLessThanOrEqual(MAX_FINDING_CHARS);
      expect(r.model).toBe("jev-9.9.9");
      const qs = Object.values(r.questions) as { type: string; criteria?: Record<string, unknown> }[];
      expect(qs.map((q) => q.type).sort()).toEqual(["choice", "noul"]);
      const choiceQ = qs.find((q) => q.type === "choice")!;
      expect(Object.keys(choiceQ.criteria!).sort()).toEqual(["fixes", "partially_addresses", "unrelated"]);
    }
    expect(requests.some((r) => r.state.finding.startsWith("### Huge") && r.state.finding.length === MAX_FINDING_CHARS)).toBe(true);
    expect(requests.some((r) => r.state.commit.startsWith("c0ffee1 subject 1\ny") && r.state.commit.length === MAX_FINDING_CHARS)).toBe(true);
  });

  it("no key → null judge, factory never called; blank key likewise", () => {
    const factory = vi.fn();
    delete process.env[KEY_ENV];
    expect(createShippedJudge({ model: "m", apiKeyEnv: KEY_ENV }, factory as never)).toBeNull();
    process.env[KEY_ENV] = "";
    expect(createShippedJudge({ model: "m", apiKeyEnv: KEY_ENV }, factory as never)).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it("A8 invalid SDK responses reject (untrusted data) and are skipped fail-open", async () => {
    process.env[KEY_ENV] = FAKE_KEY;
    const bad: unknown[] = [
      null,
      {},
      { answers: {} },
      { answers: { fixed: { noul: 1.2 }, relation: { choice: "fixes" } } },
      { answers: { fixed: { noul: Number.NaN }, relation: { choice: "fixes" } } },
      { answers: { fixed: { noul: 0.9 }, relation: { choice: "maybe" } } },
    ];
    for (const res of bad) {
      const judge = createShippedJudge({ model: "m", apiKeyEnv: KEY_ENV }, () => ({ systemOne: async () => res }))!;
      await expect(judge("### T\nb", "abc s\nb")).rejects.toThrow(/invalid Jev response/);
    }
  });
});

describe("cmdReflect --upstream --check-shipped", () => {
  it("A5/A15 prints suggestion lines + ONE deterministic --done command; shared sha appears once", async () => {
    const home = withTempHome();
    seedFive(home);
    const c = commits(3); // c0ffee1 newest
    const { judge } = fakeJudge({
      "T2|c0ffee2": fixes(0.9),
      "T5|c0ffee2": fixes(0.91),
      "T3|c0ffee1": fixes(0.876),
      "T4|c0ffee3": { fixed: 0.99, relation: "partially_addresses" },
    });
    const { lines } = await captured(() =>
      cmdReflect(ctxFor(), { upstream: true, checkShipped: true, shippedJudge: judge, commitSource: source(c) }),
    );
    expect(suggestionLines(lines)).toEqual([
      "#2 T2 — likely shipped in c0ffee2 subject 2 (p=0.90)",
      "#3 T3 — likely shipped in c0ffee1 subject 1 (p=0.88)",
      "#5 T5 — likely shipped in c0ffee2 subject 2 (p=0.91)",
    ]);
    expect(lines.filter((l) => l.startsWith("sparra reflect --upstream --done "))).toEqual([
      'sparra reflect --upstream --done 2,3,5 --reason "shipped (Jev check): c0ffee2 c0ffee1"',
    ]);
    // listing printed first with the SAME indices
    const listing = lines.filter((l) => /^\s*\[\d+\] ×\d+ T\d/.test(l));
    expect(listing.map((l) => l.trim())).toEqual([1, 2, 3, 4, 5].map((n) => `[${n}] ×1 T${n}`));
    expect(warnLines(lines)).toHaveLength(0);
  });

  it("A5 the printed --done ids, run through the existing triage, archive exactly the suggested findings", async () => {
    const home = withTempHome();
    seedFive(home);
    const { judge } = fakeJudge({ "T2|c0ffee1": fixes(0.9), "T4|c0ffee2": fixes(0.85) });
    const { lines } = await captured(() =>
      cmdReflect(ctxFor(), { upstream: true, checkShipped: true, shippedJudge: judge, commitSource: source(commits(2)) }),
    );
    const cmd = doneLine(lines)!;
    const m = /--done ([\d,]+) --reason "([^"]*)"/.exec(cmd)!;
    expect(m).toBeTruthy();
    const opts = parse(["reflect", "--upstream", "--done", m[1]!, "--reason", m[2]!]);
    await captured(() =>
      cmdReflect(ctxFor(), {
        upstream: true,
        done: opts.flags.done as string,
        reason: opts.flags.reason as string,
        now: () => new Date("2026-01-01T00:00:00Z"),
      }),
    );
    const archived = fs.readFileSync(path.join(upstreamInboxDir(), "archive", "a.md"), "utf8");
    expect(archived).toContain("### T2");
    expect(archived).toContain("### T4");
    expect(archived).not.toMatch(/### T[135]/);
    expect(archived).toContain("shipped (Jev check): c0ffee1 c0ffee2");
    const left = (await loadInbox(upstreamInboxDir())).findings.map((f) => f.title);
    expect(left).toEqual(["T1", "T3", "T5"]);
  });

  it("A4 through the command: rule applied per finding; equal-noul commits resolve to the NEWEST even when older pairs resolve first", async () => {
    const home = withTempHome();
    const dir = path.join(home, "reflections");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.md"), "### T1\nb\n\n### T2\nb\n\n### T3\nb\n\n### T4\nb\n");
    const table = {
      "T1|c0ffee1": fixes(0.9),
      "T2|c0ffee1": { fixed: 0.95, relation: "partially_addresses" } as ShippedVerdict,
      "T3|c0ffee1": fixes(0.79),
      "T4|c0ffee1": fixes(0.9),
      "T4|c0ffee2": fixes(0.9),
      "T4|c0ffee3": fixes(0.9),
    };
    for (const reverse of [false, true]) {
      // reverse: OLDER commits resolve first (more ticks for the newest)
      const { judge } = fakeJudge(table, { delayTicks: (_t, sha) => (reverse ? (sha === "c0ffee1" ? 30 : 1) : 0) });
      const { lines } = await captured(() =>
        cmdReflect(ctxFor(), { upstream: true, checkShipped: true, shippedJudge: judge, commitSource: source(commits(3)) }),
      );
      expect(suggestionLines(lines), `reverse=${reverse}`).toEqual([
        "#1 T1 — likely shipped in c0ffee1 subject 1 (p=0.90)",
        "#4 T4 — likely shipped in c0ffee1 subject 1 (p=0.90)",
      ]);
    }
  });

  it("nothing qualifies → one line saying so, no --done command", async () => {
    const home = withTempHome();
    seedFive(home);
    const { lines } = await captured(() =>
      cmdReflect(ctxFor(), { upstream: true, checkShipped: true, shippedJudge: fakeJudge({}).judge, commitSource: source(commits(2)) }),
    );
    expect(lines.filter((l) => /No inbox finding looks already shipped/.test(l))).toHaveLength(1);
    expect(suggestionLines(lines)).toHaveLength(0);
    expect(doneLine(lines)).toBeUndefined();
  });

  it("A6 never auto-triages: every inbox file byte-identical and archive/ untouched", async () => {
    const home = withTempHome();
    seedFive(home);
    const before = inboxSnapshot();
    const { judge } = fakeJudge({ "T1|c0ffee1": fixes(0.99), "T2|c0ffee2": fixes(0.99) });
    await captured(() =>
      cmdReflect(ctxFor(), { upstream: true, checkShipped: true, shippedJudge: judge, commitSource: source(commits(2)) }),
    );
    expect(inboxSnapshot()).toEqual(before);
    expect(fs.existsSync(path.join(upstreamInboxDir(), "archive"))).toBe(false);
  });

  it("--commits overrides config; config commits/threshold/concurrency apply", async () => {
    const home = withTempHome();
    seedFive(home);
    const src = source(commits(2));
    await captured(() =>
      cmdReflect(ctxFor(cfgWith({ commits: 11 })), { upstream: true, checkShipped: true, shippedJudge: fakeJudge({}).judge, commitSource: src }),
    );
    await captured(() =>
      cmdReflect(ctxFor(cfgWith({ commits: 11 })), { upstream: true, checkShipped: true, commits: "4", shippedJudge: fakeJudge({}).judge, commitSource: src }),
    );
    expect(src.calls.map((c) => c.count)).toEqual([11, 4]);

    // threshold from config
    const strict = fakeJudge({ "T1|c0ffee1": fixes(0.85) });
    const { lines } = await captured(() =>
      cmdReflect(ctxFor(cfgWith({ threshold: 0.9 })), { upstream: true, checkShipped: true, shippedJudge: strict.judge, commitSource: source(commits(1)) }),
    );
    expect(suggestionLines(lines)).toHaveLength(0);

    // concurrency bound (5 findings × 4 commits = 20 pairs, bound 3)
    const bounded = fakeJudge({}, { delayTicks: () => 3 });
    await captured(() =>
      cmdReflect(ctxFor(cfgWith({ concurrency: 3 })), { upstream: true, checkShipped: true, shippedJudge: bounded.judge, commitSource: source(commits(4)) }),
    );
    expect(bounded.calls).toHaveLength(20);
    expect(bounded.peak()).toBeLessThanOrEqual(3);
    expect(bounded.peak()).toBeGreaterThan(1);
  });

  it("A8 key unset + no injected judge: no client constructed, listing printed, exactly one warn, succeeds", async () => {
    const home = withTempHome();
    seedFive(home);
    delete process.env[KEY_ENV];
    const factory = vi.fn();
    const src = source(commits(2));
    const { lines } = await captured(() =>
      cmdReflect(ctxFor(cfgWith({})), { upstream: true, checkShipped: true, shippedClientFactory: factory as never, commitSource: src }),
    );
    expect(factory).not.toHaveBeenCalled();
    expect(src.calls).toHaveLength(0);
    expect(lines.some((l) => /\[1\] ×1 T1/.test(l))).toBe(true);
    const warns = warnLines(lines);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(KEY_ENV);
    expect(process.exitCode ?? 0).toBe(0);

    process.env[KEY_ENV] = ""; // empty counts as unset, and even with an EMPTY inbox + zero commits the same holds
    const again = await captured(() =>
      cmdReflect(ctxFor(cfgWith({})), { upstream: true, checkShipped: true, shippedClientFactory: factory as never, commitSource: source([]) }),
    );
    expect(factory).not.toHaveBeenCalled();
    expect(warnLines(again.lines)).toHaveLength(1);
  });

  it("A8 a judge that throws / returns invalid data / rejects on some pairs: valid pairs still apply, at most ONE warn, never throws", async () => {
    const home = withTempHome();
    seedFive(home);
    const { judge } = fakeJudge({
      "T1|c0ffee1": new Error("boom"),
      "T1|c0ffee2": fixes(0.9), // valid pair on the same finding still applies
      "T2|c0ffee1": "invalid",
      "T3|c0ffee2": fixes(0.9),
    });
    const { lines } = await captured(() =>
      cmdReflect(ctxFor(), { upstream: true, checkShipped: true, shippedJudge: judge, commitSource: source(commits(2)) }),
    );
    expect(warnLines(lines)).toHaveLength(1);
    expect(warnLines(lines)[0]).toContain("2 of 10");
    expect(suggestionLines(lines)).toEqual([
      "#1 T1 — likely shipped in c0ffee2 subject 2 (p=0.90)",
      "#3 T3 — likely shipped in c0ffee2 subject 2 (p=0.90)",
    ]);
    expect(doneLine(lines)).toBe('sparra reflect --upstream --done 1,3 --reason "shipped (Jev check): c0ffee2"');

    // a synchronous throw and a non-Error rejection are also just failed pairs
    const weird: ShippedJudge = (f) => {
      if (f.startsWith("### T1")) throw new Error("sync");
      return Promise.reject("string rejection");
    };
    const res = await captured(() =>
      cmdReflect(ctxFor(), { upstream: true, checkShipped: true, shippedJudge: weird, commitSource: source(commits(1)) }),
    );
    expect(warnLines(res.lines)).toHaveLength(1);
  });

  it("A8 empty inbox or zero commits → zero judge calls (and no extra warns)", async () => {
    withTempHome(); // empty inbox
    const a = fakeJudge({});
    const empty = await captured(() =>
      cmdReflect(ctxFor(), { upstream: true, checkShipped: true, shippedJudge: a.judge, commitSource: source(commits(2)) }),
    );
    expect(a.calls).toHaveLength(0);
    expect(warnLines(empty.lines)).toHaveLength(1); // the existing "(empty inbox)" warn only

    const home = withTempHome();
    seedFive(home);
    const b = fakeJudge({});
    const none = await captured(() =>
      cmdReflect(ctxFor(), { upstream: true, checkShipped: true, shippedJudge: b.judge, commitSource: source([]) }),
    );
    expect(b.calls).toHaveLength(0);
    expect(warnLines(none.lines)).toHaveLength(0);
  });

  it("A10 key hygiene: passed explicitly to the factory, never printed, process.env untouched", async () => {
    const home = withTempHome();
    seedFive(home);
    process.env[KEY_ENV] = FAKE_KEY;
    const envBefore = { ...process.env };
    const inits: { apiKey: string; model: string }[] = [];
    const factory: ShippedClientFactory = (init) => {
      inits.push(init);
      return { systemOne: async () => ({ answers: { fixed: { noul: 0.99 }, relation: { choice: "fixes" } } }) };
    };
    const { lines } = await captured(() =>
      cmdReflect(ctxFor(cfgWith({})), { upstream: true, checkShipped: true, shippedClientFactory: factory, commitSource: source(commits(1)) }),
    );
    expect(inits).toEqual([{ apiKey: FAKE_KEY, model: "jev-1.13.0" }]);
    expect(lines.join("\n")).not.toContain(FAKE_KEY);
    expect(process.env).toEqual(envBefore);
    expect(suggestionLines(lines)).toHaveLength(5);
  });

  it("A7 bad flag combos throw before any judge call or commit read", async () => {
    const home = withTempHome();
    seedFive(home);
    const j = fakeJudge({});
    const src = source(commits(2));
    const factory = vi.fn();
    const seams = { shippedJudge: j.judge, shippedClientFactory: factory as never, commitSource: src };
    const bad: Record<string, Parameters<typeof cmdReflect>[1]> = {
      "no --upstream": { checkShipped: true, ...seams },
      "--done": { upstream: true, checkShipped: true, done: "1", ...seams },
      "--wontdo": { upstream: true, checkShipped: true, wontdo: "1", ...seams },
      "--clear": { upstream: true, checkShipped: true, clear: true, ...seams },
      "--commits alone": { upstream: true, commits: "5", ...seams },
      "--commits 0": { upstream: true, checkShipped: true, commits: "0", ...seams },
      "--commits 1.5": { upstream: true, checkShipped: true, commits: "1.5", ...seams },
    };
    const before = inboxSnapshot();
    for (const [label, opts] of Object.entries(bad)) {
      await expect(cmdReflect(ctxFor(), opts), label).rejects.toThrow(/--check-shipped|--commits/);
    }
    expect(j.calls).toHaveLength(0);
    expect(src.calls).toHaveLength(0);
    expect(factory).not.toHaveBeenCalled();
    expect(inboxSnapshot()).toEqual(before);
  });

  it("A16 plain --upstream (no --check-shipped) never touches the judge or commit source", async () => {
    const home = withTempHome();
    seedFive(home);
    const j = fakeJudge({});
    const src = source(commits(2));
    const { lines } = await captured(() => cmdReflect(ctxFor(), { upstream: true, shippedJudge: j.judge, commitSource: src }));
    expect(j.calls).toHaveLength(0);
    expect(src.calls).toHaveLength(0);
    expect(suggestionLines(lines)).toHaveLength(0);
  });
});

describe("A14 through the real cli parse + dispatch", () => {
  const run = (argv: string[], seams: Parameters<typeof dispatchPhase>[4]) => {
    const { positionals, flags } = parse(argv);
    return dispatchPhase(positionals[0] ?? "help", ctxFor(), positionals, flags, seams);
  };

  it("accepts `reflect --upstream --check-shipped` and `… --commits 5`, reaching the check", async () => {
    const home = withTempHome();
    seedFive(home);
    for (const [argv, expected] of [
      [["reflect", "--upstream", "--check-shipped"], 30],
      [["reflect", "--upstream", "--check-shipped", "--commits", "5"], 5],
      [["reflect", "--check-shipped", "--commits", "9", "--upstream"], 9],
    ] as const) {
      const j = fakeJudge({ "T1|c0ffee1": fixes(0.9) });
      const src = source(commits(2));
      const { lines } = await captured(() => run([...argv], { shippedJudge: j.judge, commitSource: src }));
      expect(src.calls.map((c) => c.count), argv.join(" ")).toEqual([expected]);
      expect(j.calls).toHaveLength(10);
      expect(doneLine(lines)).toBe('sparra reflect --upstream --done 1 --reason "shipped (Jev check): c0ffee1"');
    }
  });

  it("rejects bad invocations before any client construction or judge call", async () => {
    const home = withTempHome();
    seedFive(home);
    const before = inboxSnapshot();
    const bads: string[][] = [
      ["reflect", "--check-shipped"],
      ["reflect", "--upstream", "--check-shipped", "--done", "1"],
      ["reflect", "--upstream", "--check-shipped", "--wontdo", "1"],
      ["reflect", "--upstream", "--check-shipped", "--clear"],
      ["reflect", "--upstream", "--commits", "5"],
      ["reflect", "--commits", "5"],
      ["reflect", "--upstream", "--check-shipped", "--commits", "0"],
      ["reflect", "--upstream", "--check-shipped", "--commits", "-1"],
      ["reflect", "--upstream", "--check-shipped", "--commits", "1.5"],
      ["reflect", "--upstream", "--check-shipped", "--commits"],
    ];
    process.env[KEY_ENV] = FAKE_KEY;
    for (const argv of bads) {
      const j = fakeJudge({});
      const factory = vi.fn();
      const src = source(commits(2));
      await expect(
        run(argv, { shippedJudge: j.judge, shippedClientFactory: factory as never, commitSource: src }),
        argv.join(" "),
      ).rejects.toThrow();
      expect(j.calls, argv.join(" ")).toHaveLength(0);
      expect(factory, argv.join(" ")).not.toHaveBeenCalled();
      expect(src.calls, argv.join(" ")).toHaveLength(0);
    }
    expect(inboxSnapshot()).toEqual(before);
  });
});

describe("A13 real commit source (temporary git repo)", () => {
  let repo: string;
  const git = (cwd: string, ...args: string[]): string => {
    const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (cwd: string, file: string, message: string): void => {
    fs.writeFileSync(path.join(cwd, file), message);
    git(cwd, "add", file);
    git(cwd, "commit", "-m", message);
  };

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-shipped-repo-"));
    git(repo, "init", "-q", "-b", "main");
    commit(repo, "a.txt", "first commit\n\nfirst body line\nsecond body line");
    git(repo, "checkout", "-q", "-b", "side");
    commit(repo, "b.txt", "side commit\n\nside body");
    git(repo, "checkout", "-q", "main");
    commit(repo, "c.txt", "second commit");
    git(repo, "merge", "--no-ff", "-m", "Merge branch side", "side");
    commit(repo, "d.txt", "third commit\n\nthird body");
  }, 60_000);

  it("returns the newest N non-merge commits newest-first with short sha, subject, body; merge absent", () => {
    const all = readRecentCommits(repo, 10);
    expect(all.map((c) => c.subject)).toEqual(["third commit", "second commit", "side commit", "first commit"]);
    expect(all.map((c) => c.subject)).not.toContain("Merge branch side");
    expect(all[0]!.body).toBe("third body");
    expect(all[1]!.body).toBe("");
    expect(all[3]!.body).toBe("first body line\nsecond body line");
    const headShort = git(repo, "rev-parse", "--short", "HEAD");
    expect(all[0]!.sha).toBe(headShort);
    for (const c of all) expect(c.sha).toMatch(/^[0-9a-f]{7,}$/);

    expect(readRecentCommits(repo, 2).map((c) => c.subject)).toEqual(["third commit", "second commit"]); // newest 2 non-merge
    expect(readRecentCommits(repo, 1000)).toHaveLength(4); // larger than history needs no special handling
  }, 60_000);

  it("a repo with zero commits, and a non-repo, yield [] → zero judge calls end to end", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-shipped-empty-"));
    git(empty, "init", "-q", "-b", "main");
    expect(readRecentCommits(empty, 5)).toEqual([]);
    expect(readRecentCommits(fs.mkdtempSync(path.join(os.tmpdir(), "sparra-shipped-nogit-")), 5)).toEqual([]);

    const home = withTempHome();
    seedFive(home);
    const j = fakeJudge({});
    const ctx = { root: empty, config: defaultConfig() } as unknown as Ctx;
    await captured(() => cmdReflect(ctx, { upstream: true, checkShipped: true, shippedJudge: j.judge }));
    expect(j.calls).toHaveLength(0);
  }, 60_000);

  it("production reader is the default source: judge sees the real commits of ctx.root", async () => {
    const home = withTempHome();
    seedFive(home);
    const j = fakeJudge({});
    const ctx = { root: repo, config: defaultConfig() } as unknown as Ctx;
    await captured(() => cmdReflect(ctx, { upstream: true, checkShipped: true, commits: "2", shippedJudge: j.judge }));
    expect(j.calls).toHaveLength(5 * 2);
    expect(new Set(j.calls.map((c) => c.commit.split("\n")[0]!.replace(/^\S+ /, "")))).toEqual(new Set(["third commit", "second commit"]));
    expect(j.calls.find((c) => c.commit.includes("third commit"))!.commit).toMatch(/^[0-9a-f]{7,} third commit\nthird body$/);
  }, 60_000);
});
