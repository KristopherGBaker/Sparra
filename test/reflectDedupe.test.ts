import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig, loadConfig, type ReflectDedupeConfig } from "../src/config.ts";
import { seedPrompts } from "../src/prompts.ts";
import { cmdReflect, routeUpstreamFinding, upstreamInboxDir } from "../src/phases/reflect.ts";
import {
  createJevJudge,
  clipFinding,
  MAX_FINDING_CHARS,
  type JevClient,
  type JevClientFactory,
  type PairJudge,
  type PairVerdict,
} from "../src/phases/reflectDedupe.ts";
import { loadInbox } from "../src/phases/upstreamTriage.ts";
import type { Ctx } from "../src/context.ts";
import type { RunResult, RunSessionParams } from "../src/sdk/session.ts";

/** Fake API key used only through an injected factory; never a real credential. */
const FAKE_KEY = "fake-key-for-tests-0000";
const KEY_ENV = "SPARRA_TEST_TS_KEY";

const savedEnv = { home: process.env.SPARRA_HOME, key: process.env[KEY_ENV], ts: process.env.TYPESAFE_API_KEY };
afterEach(() => {
  for (const [k, v] of [["SPARRA_HOME", savedEnv.home], [KEY_ENV, savedEnv.key], ["TYPESAFE_API_KEY", savedEnv.ts]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function withTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-dedupe-home-"));
  process.env.SPARRA_HOME = home;
  return home;
}

/** Seed the live inbox: each entry becomes `<name>.md` (sorted, so name order = live-inbox order). */
function seedInbox(home: string, files: Record<string, string>): string {
  const dir = path.join(home, "reflections");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${name}.md`), body);
  return dir;
}

const inboxFiles = () => {
  const dir = upstreamInboxDir();
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
};
const snapshot = () => Object.fromEntries(inboxFiles().map((f) => [f, fs.readFileSync(path.join(upstreamInboxDir(), f), "utf8")]));

function dedupeCfg(over: Partial<ReflectDedupeConfig> = {}): ReflectDedupeConfig {
  return { ...defaultConfig().reflect.dedupe, enabled: true, ...over };
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

/**
 * A fake judge keyed on which LIVE finding (by its title inside finding_b) is being compared.
 * Resolves after a per-pair number of microtask ticks (no timers) so completion order is controllable.
 */
function fakeJudge(
  verdicts: Record<string, PairVerdict | Error>,
  opts: { reverse?: boolean; order?: string[] } = {},
): { judge: PairJudge; calls: { a: string; b: string }[] } {
  const calls: { a: string; b: string }[] = [];
  const judge: PairJudge = async (a, b) => {
    calls.push({ a, b });
    const title = Object.keys(verdicts).find((t) => b.includes(`### ${t}\n`) || b.startsWith(`### ${t}`));
    if (opts.reverse && opts.order) {
      const idx = opts.order.findIndex((t) => b.includes(`### ${t}`));
      for (let i = 0; i < (opts.order.length - idx) * 8; i++) await Promise.resolve();
    }
    const v = title ? verdicts[title] : undefined;
    if (v instanceof Error) throw v;
    return v ?? { same: 0, relation: "unrelated" };
  };
  return { judge, calls };
}

const same = (p: number, relation: PairVerdict["relation"] = "same_defect"): PairVerdict => ({ same: p, relation });

// ───────────────────────── A3 config ─────────────────────────

describe("reflect.dedupe config", () => {
  it("defaults match the contract block", () => {
    expect(defaultConfig().reflect.dedupe).toEqual({
      enabled: false,
      model: "jev-1.13.0",
      apiKeyEnv: "TYPESAFE_API_KEY",
      autoThreshold: 0.9,
      suggestThreshold: 0.5,
      maxSuggestions: 3,
      concurrency: 8,
    });
  });

  it("a config.yaml omitting `reflect` deep-merges to the defaults; a partial block overrides only its keys", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-dedupe-cfg-"));
    try {
      const paths = new Paths(dir);
      await paths.ensureScaffold();
      fs.writeFileSync(paths.config, YAML.stringify({ permission: { mode: "auto" } }));
      expect((await loadConfig(paths)).reflect.dedupe).toEqual(defaultConfig().reflect.dedupe);

      fs.writeFileSync(paths.config, YAML.stringify({ reflect: { dedupe: { enabled: true, concurrency: 2 } } }));
      expect((await loadConfig(paths)).reflect.dedupe).toEqual({ ...defaultConfig().reflect.dedupe, enabled: true, concurrency: 2 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────── A4 / A15 / A16 / A17 the SDK-backed judge ─────────────────────────

function goodAnswer(over: { noul?: unknown; choice?: unknown } = {}) {
  return {
    model: "jev-1.13.0",
    usage: { input_tokens: 1, output_tokens: 1 },
    answers: {
      same: { type: "noul", noul: "noul" in over ? over.noul : 0.95 },
      relation: { type: "choice", choice: "choice" in over ? over.choice : "same_defect" },
    },
  };
}

function fakeClient(respond: () => unknown | Promise<unknown>): {
  factory: JevClientFactory;
  requests: Parameters<JevClient["systemOne"]>[0][];
  inits: { apiKey: string; model: string }[];
} {
  const requests: Parameters<JevClient["systemOne"]>[0][] = [];
  const inits: { apiKey: string; model: string }[] = [];
  const factory: JevClientFactory = (init) => {
    inits.push(init);
    return { systemOne: async (req) => { requests.push(req); return respond(); } };
  };
  return { factory, requests, inits };
}

describe("createJevJudge — request shape (fake SDK client)", () => {
  it("issues exactly one systemOne per pair: state has only finding_a/finding_b, one Noul + one Choice, pinned model", async () => {
    process.env[KEY_ENV] = FAKE_KEY;
    const { factory, requests, inits } = fakeClient(() => goodAnswer());
    const judge = createJevJudge({ model: "jev-9.9.9", apiKeyEnv: KEY_ENV }, factory)!;
    expect(judge).toBeTypeOf("function");
    expect(requests).toHaveLength(0); // construction makes no request

    const v = await judge("### A\nbody a", "### B\nbody b");
    expect(v).toEqual({ same: 0.95, relation: "same_defect" });
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(Object.keys(req.state).sort()).toEqual(["finding_a", "finding_b"]);
    expect(req.model).toBe("jev-9.9.9");
    const qs = Object.values(req.questions) as { type: string; criteria?: Record<string, unknown> }[];
    expect(qs.map((q) => q.type).sort()).toEqual(["choice", "noul"]);
    const choiceQ = qs.find((q) => q.type === "choice")!;
    expect(Object.keys(choiceQ.criteria!).sort()).toEqual(["same_area_distinct_defect", "same_defect", "unrelated"]);
    expect(inits).toEqual([{ apiKey: FAKE_KEY, model: "jev-9.9.9" }]);

    await judge("### A2\nx", "### B2\ny");
    await judge("### A3\nx", "### B3\ny");
    expect(requests).toHaveLength(3); // N pairs → N requests
    for (const r of requests) expect(Object.keys(r.state).sort()).toEqual(["finding_a", "finding_b"]);
  });

  it("clips each finding to ≤1200 chars (a 50,000-char finding), state still has only the two keys", async () => {
    process.env[KEY_ENV] = FAKE_KEY;
    const { factory, requests } = fakeClient(() => goodAnswer());
    const judge = createJevJudge({ model: "m", apiKeyEnv: KEY_ENV }, factory)!;
    const huge = "### Huge\n" + "x".repeat(50_000);
    await judge(huge, huge);
    const { state } = requests[0]!;
    expect(Object.keys(state).sort()).toEqual(["finding_a", "finding_b"]);
    expect(state.finding_a.length).toBeLessThanOrEqual(MAX_FINDING_CHARS);
    expect(state.finding_b.length).toBeLessThanOrEqual(MAX_FINDING_CHARS);
    expect(state.finding_a.startsWith("### Huge")).toBe(true);
  });

  it("clipFinding never leaves a lone surrogate and drops sparra bookkeeping lines", () => {
    const emoji = "### T\n" + "😀".repeat(2000);
    const clipped = clipFinding(emoji);
    expect(clipped.length).toBeLessThanOrEqual(MAX_FINDING_CHARS);
    expect(/[\ud800-\udbff]$/.test(clipped)).toBe(false);
    const withMarkers = "### T\n<!-- sparra-recurrence n=4 -->\nPOSSIBLE-RECURRENCE-OF: X (p=0.60)\nreal body";
    expect(clipFinding(withMarkers)).toBe("### T\nreal body");
  });
});

describe("createJevJudge — response validation (untrusted data)", () => {
  const bad: [string, () => unknown][] = [
    ["missing same", () => goodAnswer({ noul: undefined })],
    ["NaN", () => goodAnswer({ noul: NaN })],
    ["1.5", () => goodAnswer({ noul: 1.5 })],
    ["-0.1", () => goodAnswer({ noul: -0.1 })],
    ["string score", () => goodAnswer({ noul: "0.95" })],
    ["unknown relation", () => goodAnswer({ choice: "duplicate" })],
    ["missing relation", () => goodAnswer({ choice: undefined })],
    ["no answers", () => ({ model: "m" })],
    ["null response", () => null],
  ];

  for (const [label, respond] of bad) {
    it(`judge rejects on ${label}`, async () => {
      process.env[KEY_ENV] = FAKE_KEY;
      const { factory } = fakeClient(respond);
      const judge = createJevJudge({ model: "m", apiKeyEnv: KEY_ENV }, factory)!;
      await expect(judge("### A\na", "### B\nb")).rejects.toThrow();
    });
  }

  it("through routing: each invalid response (and a rejected promise) fails open — finding kept, no throw, ONE warn", async () => {
    const cases: [string, () => unknown][] = [
      ...bad.slice(0, 6),
      ["rejected promise", () => Promise.reject(new Error("429 rate limited"))],
    ];
    for (const [label, respond] of cases) {
      const home = withTempHome();
      seedInbox(home, { a: "### Live A\nbody A\n", b: "### Live B\nbody B\n" });
      process.env[KEY_ENV] = FAKE_KEY;
      const { factory } = fakeClient(respond);
      const cap = captureLog();
      let dest: string | null;
      try {
        dest = await routeUpstreamFinding("proj", "s", "### New One\nfresh\n", {
          dedupe: dedupeCfg({ apiKeyEnv: KEY_ENV }),
          clientFactory: factory,
        });
      } finally {
        cap.restore();
      }
      expect(dest, label).not.toBeNull();
      expect(fs.readFileSync(dest!, "utf8"), label).toBe("### New One\nfresh\n"); // byte-identical to exact-only
      const warns = cap.lines().filter((l) => l.includes("reflect.dedupe"));
      expect(warns, label).toHaveLength(1);
      expect(cap.lines().join("\n")).not.toContain(FAKE_KEY);
    }
  });
});

describe("key path", () => {
  it("a non-default apiKeyEnv is what the factory receives; TYPESAFE_API_KEY is neither read nor mutated; key never logged", async () => {
    const home = withTempHome();
    seedInbox(home, { a: "### Live A\nbody\n" });
    process.env[KEY_ENV] = FAKE_KEY;
    delete process.env.TYPESAFE_API_KEY;
    const readKeys: string[] = [];
    const proxied = new Proxy(process.env, {
      get(t, p) {
        if (typeof p === "string") readKeys.push(p);
        return Reflect.get(t, p);
      },
    });
    const realEnv = process.env;
    const { factory, inits } = fakeClient(() => goodAnswer({ noul: 0.6, choice: "same_area_distinct_defect" }));
    const cap = captureLog();
    try {
      process.env = proxied as NodeJS.ProcessEnv;
      await routeUpstreamFinding("proj", "s", "### N\nb\n", { dedupe: dedupeCfg({ apiKeyEnv: KEY_ENV }), clientFactory: factory });
    } finally {
      process.env = realEnv;
      cap.restore();
    }
    expect(inits).toHaveLength(1);
    expect(inits[0]!.apiKey).toBe(FAKE_KEY);
    expect(readKeys).toContain(KEY_ENV);
    expect(readKeys).not.toContain("TYPESAFE_API_KEY");
    expect(process.env.TYPESAFE_API_KEY).toBeUndefined();
    expect(cap.lines().join("\n")).not.toContain(FAKE_KEY);
  });

  it("no client is constructed when disabled, when the key is absent, or when the live inbox is empty", async () => {
    const factory = vi.fn<JevClientFactory>(() => ({ systemOne: async () => goodAnswer() }));
    delete process.env[KEY_ENV];

    const home = withTempHome();
    seedInbox(home, { a: "### Live A\nbody\n" });
    await routeUpstreamFinding("p", "s1", "### N1\nb\n", { dedupe: dedupeCfg({ enabled: false, apiKeyEnv: KEY_ENV }), clientFactory: factory });
    await routeUpstreamFinding("p", "s2", "### N2\nb\n", { dedupe: dedupeCfg({ apiKeyEnv: KEY_ENV }), clientFactory: factory }); // key absent
    process.env[KEY_ENV] = "";
    await routeUpstreamFinding("p", "s3", "### N3\nb\n", { dedupe: dedupeCfg({ apiKeyEnv: KEY_ENV }), clientFactory: factory }); // key empty

    process.env[KEY_ENV] = FAKE_KEY;
    withTempHome(); // empty live inbox
    await routeUpstreamFinding("p", "s4", "### N4\nb\n", { dedupe: dedupeCfg({ apiKeyEnv: KEY_ENV }), clientFactory: factory });
    expect(factory).not.toHaveBeenCalled();
  });

  it("dedupe enabled + key missing warns once and routes exact-only", async () => {
    const home = withTempHome();
    seedInbox(home, { a: "### Live A\nbody\n" });
    delete process.env[KEY_ENV];
    const cap = captureLog();
    let dest: string | null;
    try {
      dest = await routeUpstreamFinding("p", "s", "### N\nb\n", { dedupe: dedupeCfg({ apiKeyEnv: KEY_ENV }) });
    } finally {
      cap.restore();
    }
    expect(fs.readFileSync(dest!, "utf8")).toBe("### N\nb\n");
    expect(cap.lines().filter((l) => l.includes("reflect.dedupe"))).toHaveLength(1);
    expect(cap.lines().join("\n")).toContain(KEY_ENV); // names the variable, never a value
  });
});

// ───────────────────────── routing ─────────────────────────

describe("routeUpstreamFinding — semantic dedupe", () => {
  it("A5 auto-merge: counter increments, no new file, returns null", async () => {
    const home = withTempHome();
    const dir = seedInbox(home, { live: "### Live Gap\nbody of live gap\n" });
    const { judge, calls } = fakeJudge({ "Live Gap": same(0.95) });
    const dest = await routeUpstreamFinding("proj", "s", "### Reworded Gap\nsame thing, other words\n", { dedupe: dedupeCfg(), judge });
    expect(dest).toBeNull();
    expect(inboxFiles()).toEqual(["live.md"]);
    expect(fs.readFileSync(path.join(dir, "live.md"), "utf8")).toContain("<!-- sparra-recurrence n=2 -->");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.a).toContain("Reworded Gap");
  });

  it("A6 guard: same=0.95 but same_area_distinct_defect does NOT auto-merge — written new with a POSSIBLE line", async () => {
    const home = withTempHome();
    const dir = seedInbox(home, { live: "### Live Gap\nbody\n" });
    const { judge } = fakeJudge({ "Live Gap": same(0.95, "same_area_distinct_defect") });
    const dest = await routeUpstreamFinding("proj", "s", "### Sibling\nrelated but distinct\n", { dedupe: dedupeCfg(), judge });
    expect(dest).not.toBeNull();
    expect(fs.readFileSync(dest!, "utf8")).toBe("### Sibling\nPOSSIBLE-RECURRENCE-OF: Live Gap (p=0.95)\nrelated but distinct\n");
    expect(fs.readFileSync(path.join(dir, "live.md"), "utf8")).not.toContain("sparra-recurrence");
  });

  it("A7 suggest band: top 3 of 4 in band, highest first, directly under the heading; below-threshold adds none", async () => {
    const home = withTempHome();
    seedInbox(home, {
      a: "### L1\nb\n", b: "### L2\nb\n", c: "### L3\nb\n", d: "### L4\nb\n", e: "### L5\nb\n",
    });
    const { judge } = fakeJudge({
      L1: same(0.52), L2: same(0.7), L3: same(0.55), L4: same(0.6), L5: same(0.49, "same_defect"),
    });
    const dest = await routeUpstreamFinding("proj", "s", "### New\nbody\n", { dedupe: dedupeCfg({ maxSuggestions: 3 }), judge });
    const lines = fs.readFileSync(dest!, "utf8").split("\n");
    expect(lines[0]).toBe("### New");
    expect(lines.slice(1, 4)).toEqual([
      "POSSIBLE-RECURRENCE-OF: L2 (p=0.70)",
      "POSSIBLE-RECURRENCE-OF: L4 (p=0.60)",
      "POSSIBLE-RECURRENCE-OF: L3 (p=0.55)",
    ]);
    expect(fs.readFileSync(dest!, "utf8").match(/POSSIBLE-RECURRENCE-OF:/g)).toHaveLength(3);
    expect(lines[4]).toBe("body");
  });

  it("A7 below suggestThreshold adds no line; maxSuggestions: 0 adds none", async () => {
    const home = withTempHome();
    seedInbox(home, { a: "### L1\nb\n" });
    const low = await routeUpstreamFinding("p", "s1", "### N\nb\n", { dedupe: dedupeCfg(), judge: fakeJudge({ L1: same(0.49) }).judge });
    expect(fs.readFileSync(low!, "utf8")).toBe("### N\nb\n");
    const none = await routeUpstreamFinding("p", "s2", "### N\nb\n", {
      dedupe: dedupeCfg({ maxSuggestions: 0 }),
      judge: fakeJudge({ L1: same(0.7) }).judge,
    });
    expect(fs.readFileSync(none!, "utf8")).toBe("### N\nb\n");
  });

  it("A7 a POSSIBLE-RECURRENCE-OF line in a later routing is not a RECURRENCE-OF claim", async () => {
    const home = withTempHome();
    seedInbox(home, { a: "### L1\nb\n" });
    const dest = await routeUpstreamFinding("p", "s1", "### N\nb\n", { dedupe: dedupeCfg(), judge: fakeJudge({ L1: same(0.7) }).judge });
    expect(fs.readFileSync(dest!, "utf8")).toContain("POSSIBLE-RECURRENCE-OF: L1 (p=0.70)");
    // "N" now lives in the inbox. A later finding carrying a POSSIBLE line naming the live title "N"
    // must NOT increment it (exact path ignores the line); dedupe is off here.
    const later = "### Other\nPOSSIBLE-RECURRENCE-OF: N (p=0.60)\nbody\n";
    const dest2 = await routeUpstreamFinding("p", "s2", later);
    expect(dest2).not.toBeNull();
    const { findings } = await loadInbox(upstreamInboxDir());
    for (const f of findings) expect(f.recurrence).toBe(1);
  });

  it("A8 exact RECURRENCE-OF path runs first: no judge call for that segment", async () => {
    const home = withTempHome();
    const dir = seedInbox(home, { live: "### Known Gap\nbody\n" });
    const { judge, calls } = fakeJudge({ "Known Gap": same(0.99) });
    const dest = await routeUpstreamFinding("proj", "s", "### Again\nRECURRENCE-OF: known gap\nstill\n", { dedupe: dedupeCfg(), judge });
    expect(dest).toBeNull();
    expect(calls).toHaveLength(0);
    expect(fs.readFileSync(path.join(dir, "live.md"), "utf8")).toContain("n=2");
  });

  it("A9 fail-open: output byte-identical to dedupe-disabled for disabled / empty inbox / all-throw", async () => {
    const upstream = "preamble\n### First\nbody one\n### Second\nbody two\n";
    const run = async (opts: Parameters<typeof routeUpstreamFinding>[3], seed: boolean) => {
      const home = withTempHome();
      if (seed) seedInbox(home, { a: "### Live A\nx\n", b: "### Live B\ny\n" });
      const before = seed ? snapshot() : {};
      const dest = await routeUpstreamFinding("proj", "STAMP", upstream, opts);
      const content = dest ? fs.readFileSync(dest, "utf8") : null;
      const after = snapshot();
      // drop the new random-named file from the comparison of pre-existing files
      const pre = Object.fromEntries(Object.entries(after).filter(([f]) => f in before));
      return { content, pre, returnedNull: dest === null };
    };
    const baseline = await run(undefined, true);
    expect(baseline.content).toBe(upstream);

    const throwing = fakeJudge({ "Live A": new Error("boom"), "Live B": new Error("boom") }).judge;
    const cap = captureLog();
    try {
      expect(await run({ dedupe: dedupeCfg({ enabled: false }), judge: fakeJudge({}).judge }, true)).toEqual(baseline);
      expect(await run({ dedupe: dedupeCfg(), judge: throwing }, true)).toEqual(baseline);
      expect(warnLines(cap.lines()).filter((l) => l.includes("reflect.dedupe"))).toHaveLength(1); // one per routing call
    } finally {
      cap.restore();
    }
    // empty live inbox
    const emptyBaseline = await run(undefined, false);
    const calls = fakeJudge({});
    expect(await run({ dedupe: dedupeCfg(), judge: calls.judge }, false)).toEqual(emptyBaseline);
    expect(calls.calls).toHaveLength(0);
  });

  it("A9 a judge that throws on only one pair still applies the other pairs' results", async () => {
    const home = withTempHome();
    const dir = seedInbox(home, { a: "### Live A\nx\n", b: "### Live B\ny\n" });
    const { judge } = fakeJudge({ "Live A": new Error("timeout"), "Live B": same(0.97) });
    const cap = captureLog();
    let dest: string | null;
    try {
      dest = await routeUpstreamFinding("proj", "s", "### Dup\nz\n", { dedupe: dedupeCfg(), judge });
    } finally {
      cap.restore();
    }
    expect(dest).toBeNull();
    expect(fs.readFileSync(path.join(dir, "b.md"), "utf8")).toContain("n=2");
    expect(cap.lines().filter((l) => l.includes("reflect.dedupe"))).toHaveLength(1);
  });

  it("A10 mixed batch: exact + auto-merge + genuinely new → two counters bumped, one file with ONLY the new finding", async () => {
    const home = withTempHome();
    const dir = seedInbox(home, { a: "### Alpha\nalpha body\n", b: "### Beta\nbeta body\n" });
    const { judge, calls } = fakeJudge({ Alpha: same(0.1, "unrelated"), Beta: same(0.96) });
    const upstream = [
      "preamble text",
      "### Exact Recurrence",
      "RECURRENCE-OF: Alpha",
      "seen again",
      "### Semantic Recurrence",
      "worded differently",
      "### Truly New",
      "nothing like the others",
      "",
    ].join("\n");
    // Beta matches Semantic Recurrence; make the judge distinguish by the NEW text so Truly New isn't merged.
    const discerning: PairJudge = async (a, b) => (a.includes("Truly New") ? same(0.05, "unrelated") : judge(a, b));
    const dest = await routeUpstreamFinding("proj", "s", upstream, { dedupe: dedupeCfg(), judge: discerning });
    expect(dest).not.toBeNull();
    const written = fs.readFileSync(dest!, "utf8");
    expect(written).toContain("preamble text");
    expect(written).toContain("### Truly New");
    expect(written).not.toContain("Exact Recurrence");
    expect(written).not.toContain("Semantic Recurrence");
    expect(fs.readFileSync(path.join(dir, "a.md"), "utf8")).toContain("n=2");
    expect(fs.readFileSync(path.join(dir, "b.md"), "utf8")).toContain("n=2");
    expect(calls.every((c) => !c.a.includes("Exact Recurrence"))).toBe(true); // exact segment never judged
    expect(inboxFiles()).toHaveLength(3);
  });

  it("A18 ties resolve by live-inbox order for auto-merge AND suggestion order, even when pairs resolve in reverse", async () => {
    const home = withTempHome();
    const dir = seedInbox(home, { a: "### T1\nb\n", b: "### T2\nb\n", c: "### T3\nb\n" });
    const order = ["T1", "T2", "T3"];

    const auto = fakeJudge({ T1: same(0.95), T2: same(0.95), T3: same(0.95) }, { reverse: true, order });
    expect(await routeUpstreamFinding("p", "s", "### N\nb\n", { dedupe: dedupeCfg(), judge: auto.judge })).toBeNull();
    expect(fs.readFileSync(path.join(dir, "a.md"), "utf8")).toContain("n=2");
    expect(fs.readFileSync(path.join(dir, "b.md"), "utf8")).not.toContain("sparra-recurrence");
    expect(fs.readFileSync(path.join(dir, "c.md"), "utf8")).not.toContain("sparra-recurrence");

    // fresh inbox for the suggestion-order check (T1 is now recurrence 2 and would sort first anyway)
    const home2 = withTempHome();
    seedInbox(home2, { a: "### T1\nb\n", b: "### T2\nb\n", c: "### T3\nb\n" });
    const sug = fakeJudge({ T1: same(0.6), T2: same(0.6), T3: same(0.6) }, { reverse: true, order });
    const dest = await routeUpstreamFinding("p", "s", "### N\nb\n", { dedupe: dedupeCfg(), judge: sug.judge });
    expect(fs.readFileSync(dest!, "utf8").split("\n").slice(1, 4)).toEqual([
      "POSSIBLE-RECURRENCE-OF: T1 (p=0.60)",
      "POSSIBLE-RECURRENCE-OF: T2 (p=0.60)",
      "POSSIBLE-RECURRENCE-OF: T3 (p=0.60)",
    ]);
  });

  it("A18 highest score beats live order for the auto-merge target", async () => {
    const home = withTempHome();
    const dir = seedInbox(home, { a: "### T1\nb\n", b: "### T2\nb\n" });
    const { judge } = fakeJudge({ T1: same(0.92), T2: same(0.99) });
    await routeUpstreamFinding("p", "s", "### N\nb\n", { dedupe: dedupeCfg(), judge });
    expect(fs.readFileSync(path.join(dir, "b.md"), "utf8")).toContain("n=2");
    expect(fs.readFileSync(path.join(dir, "a.md"), "utf8")).not.toContain("sparra-recurrence");
  });

  it("concurrency bound is respected (peak in-flight ≤ concurrency)", async () => {
    const home = withTempHome();
    seedInbox(home, Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}`, `### L${i}\nb\n`])));
    let active = 0;
    let peak = 0;
    const judge: PairJudge = async () => {
      active++;
      peak = Math.max(peak, active);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      active--;
      return same(0.1, "unrelated");
    };
    await routeUpstreamFinding("p", "s", "### N\nb\n", { dedupe: dedupeCfg({ concurrency: 2 }), judge });
    expect(peak).toBe(2);
  });

  it("A18 invalid config values normalize to defaults with ONE warn and still route", async () => {
    const bads: Partial<Record<keyof ReflectDedupeConfig, unknown>>[] = [
      { autoThreshold: NaN },
      { autoThreshold: 1.5 },
      { suggestThreshold: -0.2 },
      { suggestThreshold: 0.95 }, // > autoThreshold default
      { concurrency: 0 },
      { concurrency: 2.5 },
      { maxSuggestions: -1 },
      { maxSuggestions: 1.5 },
      { autoThreshold: "high", concurrency: 0 }, // several bad values → still one warn
    ];
    for (const bad of bads) {
      const home = withTempHome();
      seedInbox(home, { a: "### L1\nb\n" });
      const { judge, calls } = fakeJudge({ L1: same(0.95) });
      const cap = captureLog();
      let dest: string | null;
      try {
        dest = await routeUpstreamFinding("p", "s", "### N\nb\n", { dedupe: dedupeCfg(bad as Partial<ReflectDedupeConfig>), judge });
      } finally {
        cap.restore();
      }
      // defaults applied → 0.95 same_defect auto-merges (default autoThreshold 0.9)
      expect(dest, JSON.stringify(bad)).toBeNull();
      expect(calls).toHaveLength(1);
      expect(cap.lines().filter((l) => l.includes("reflect.dedupe")), JSON.stringify(bad)).toHaveLength(1);
    }
  });

  it("valid config is not warned about", async () => {
    const home = withTempHome();
    seedInbox(home, { a: "### L1\nb\n" });
    const cap = captureLog();
    try {
      await routeUpstreamFinding("p", "s", "### N\nb\n", {
        dedupe: dedupeCfg({ autoThreshold: 0.8, suggestThreshold: 0.8 }),
        judge: fakeJudge({}).judge,
      });
    } finally {
      cap.restore();
    }
    expect(cap.lines().filter((l) => l.includes("reflect.dedupe"))).toHaveLength(0);
  });

  it("holdout/privacy: the judge sees only the routed finding text and live inbox text", async () => {
    const home = withTempHome();
    seedInbox(home, { a: "### Live A\nlive body\n" });
    const { judge, calls } = fakeJudge({});
    await routeUpstreamFinding("secret-project-name", "stamp-xyz", "### N\nredacted body\n", { dedupe: dedupeCfg(), judge });
    for (const c of calls) {
      expect(c.a + c.b).not.toContain("secret-project-name");
      expect(c.a + c.b).not.toContain("stamp-xyz");
    }
  });
});

// ───────────────────────── A11 cmdReflect wiring ─────────────────────────

describe("cmdReflect — threads reflect.dedupe config + judge into routing", () => {
  async function ctxFor(): Promise<{ ctx: Ctx; dir: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-dedupe-reflect-"));
    const paths = new Paths(dir);
    await paths.ensureScaffold();
    await seedPrompts(paths);
    const store = StateStore.create(paths, "existing");
    store.data.autoSupported = false;
    return { ctx: { root: dir, paths, config: defaultConfig(), store }, dir };
  }
  const okResult = (): RunResult => ({
    ok: true, subtype: "success", resultText: "done", sessionId: "s", costUsd: 0, tokens: 0,
    numTurns: 1, hitMaxTurns: false, hitBudget: false, errors: [], tracePath: "",
  });

  function reflectWith(ctx: Ctx, finding: string) {
    const td = ctx.paths.traceDir("build-1");
    fs.mkdirSync(td, { recursive: true });
    fs.writeFileSync(path.join(td, "1.json"), "{}");
    return async (p: RunSessionParams): Promise<RunResult> => {
      fs.writeFileSync(path.join(path.dirname(p.traceDir!), "upstream.md"), finding);
      return okResult();
    };
  }

  it("enabled + injected judge → a routed finding matching a live one auto-merges", async () => {
    const home = withTempHome();
    const inbox = seedInbox(home, { live: "### Live Gap\nbody\n" });
    const { ctx, dir } = await ctxFor();
    try {
      ctx.config.reflect.dedupe.enabled = true;
      const { judge, calls } = fakeJudge({ "Live Gap": same(0.96) });
      await cmdReflect(ctx, { run: "build-1", runSessionFn: reflectWith(ctx, "### Same Gap, Reworded\nbody\n"), dedupeJudge: judge });
      expect(calls).toHaveLength(1);
      expect(fs.readdirSync(inbox).filter((f) => f.endsWith(".md"))).toEqual(["live.md"]);
      expect(fs.readFileSync(path.join(inbox, "live.md"), "utf8")).toContain("n=2");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disabled (default config) → the injected judge is never consulted", async () => {
    const home = withTempHome();
    seedInbox(home, { live: "### Live Gap\nbody\n" });
    const { ctx, dir } = await ctxFor();
    try {
      const { judge, calls } = fakeJudge({ "Live Gap": same(0.96) });
      await cmdReflect(ctx, { run: "build-1", runSessionFn: reflectWith(ctx, "### Reworded\nbody\n"), dedupeJudge: judge });
      expect(calls).toHaveLength(0);
      expect(inboxFiles()).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enabled with no injected judge builds the real judge from config (client factory receives the env key)", async () => {
    const home = withTempHome();
    seedInbox(home, { live: "### Live Gap\nbody\n" });
    process.env[KEY_ENV] = FAKE_KEY;
    const { ctx, dir } = await ctxFor();
    try {
      ctx.config.reflect.dedupe = { ...ctx.config.reflect.dedupe, enabled: true, apiKeyEnv: KEY_ENV };
      const { factory, requests, inits } = fakeClient(() => goodAnswer());
      await cmdReflect(ctx, { run: "build-1", runSessionFn: reflectWith(ctx, "### Reworded\nbody\n"), dedupeClientFactory: factory });
      expect(inits[0]!.apiKey).toBe(FAKE_KEY);
      expect(requests).toHaveLength(1);
      expect(inboxFiles()).toEqual(["live.md"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────── A12 key hygiene ─────────────────────────

describe("key hygiene", () => {
  it("no source file assigns a literal string to an apiKey field", () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, "../src/phases/reflectDedupe.ts"), "utf8");
    expect(src).not.toMatch(/apiKey\s*:\s*["'`]/);
    expect(src).toContain("process.env[cfg.apiKeyEnv]");
  });
});
