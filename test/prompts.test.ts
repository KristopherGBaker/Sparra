import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Paths } from "../src/paths.ts";
import {
  seedPrompts,
  promptDrift,
  syncPrompts,
  DEFAULT_PROMPTS,
  hashPrompt,
  readBaseline,
  writeBaselineEntries,
  summarizePromptDrift,
} from "../src/prompts.ts";
import { cmdPrompts } from "../src/phases/prompts.ts";
import type { Ctx } from "../src/context.ts";

/** Compare two dotted numeric versions (e.g. "2026.7.5.2"): >0 if a>b, 0 if equal, <0 if a<b.
 *  Segment-wise numeric so the plugin-version assertions tolerate forward bumps. */
function cmpDottedVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

async function tmpPaths(): Promise<{ dir: string; paths: Paths }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-prompts-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  await seedPrompts(paths);
  return { dir, paths };
}

describe("evaluator prompt — environmental blockers route to notes, not `blocking` (H3)", () => {
  const ev = DEFAULT_PROMPTS.evaluator;
  it("keeps the could-not-run → exerciseStatus='blocked' inability path", () => {
    expect(ev).toContain("exerciseStatus='blocked'");
    expect(ev).toContain("could not EXECUTE due to ENVIRONMENT");
  });
  it("routes the environmental blocker into `notes`, NOT `blocking`", () => {
    // (a) new distinction present.
    expect(ev).toContain("name the blocker in `notes`");
    // (b) the old contradictory routing is GONE — without this, a builder could append (a) while
    // leaving the self-contradictory "name the blocker in `blocking`" text and still grep green.
    expect(ev).not.toContain("name the blocker in `blocking`");
  });
  it("carries UN-RUN ids in the schema and requires stating the un-run set", () => {
    expect(ev).toContain("unrunAssertionIds");
    expect(ev).toContain("State the un-run set explicitly");
    expect(ev).toContain('"exerciseStatus": "ran" | "blocked" | "mixed"');
  });
});

describe("contract-generator prompt — teardown-crashy sentinel output guidance", () => {
  const cg = DEFAULT_PROMPTS["contract-generator"]!;
  it("prefers artifact-emitted sentinel output once, in the existing verify-command clause", () => {
    expect(cg).toContain("artifact-emitted sentinel output");
    expect(cg).toContain("printed PASS/FAIL lines or result files");
    expect(cg).toContain("exit code secondary");
    expect(cg.match(/artifact-emitted sentinel output/g)?.length).toBe(1);
  });
});

describe("capability-gap reflect clauses folded into DEFAULT_PROMPTS", () => {
  const cg = DEFAULT_PROMPTS["contract-generator"]!;
  const gen = DEFAULT_PROMPTS.generator;
  it("contract-generator requires mandated side-effect layers named up front", () => {
    expect(cg).toContain("MANDATED SIDE-EFFECTS UP FRONT");
    expect(cg).toContain("plugin-version bump");
  });
  it("contract-generator + generator require a FLOOR compare on monotonic values, never an exact pin", () => {
    expect(cg).toContain("MONOTONIC VALUES");
    expect(cg).toContain("never an exact pin");
    expect(gen).toContain("monotonic values");
    expect(gen).toContain("never exact equality");
  });
  it("reset/clear degenerate-test guard is present on both the drafting and building sides", () => {
    expect(cg).toContain("RESET/CLEAR semantics");
    expect(cg).toContain("previously-tracked key ABSENT");
    expect(gen).toContain("previously-tracked key ABSENT");
  });
});

describe("prompt-auditor / reflector — audit for readability, not just terseness", () => {
  it("prompt-auditor scores READABILITY alongside low redundancy and won't cram into a denser wall", () => {
    const pa = DEFAULT_PROMPTS["prompt-auditor"]!;
    expect(pa).toContain("READABILITY");
    expect(pa).toContain("one idea per bullet/line");
    expect(pa).toContain("EARN their tokens");
  });
  it("reflector edits stay low-redundancy AND readable", () => {
    expect(DEFAULT_PROMPTS.reflector).toContain("LOW-REDUNDANCY AND READABLE");
  });
});

describe("docs + skill sync for UN-RUN / mixed verdict semantics", () => {
  it("documents verdict semantics and bumps the plugin version above 2026.7.3.2", () => {
    const buildLoop = fs.readFileSync(path.join(process.cwd(), "docs/build-loop.md"), "utf8");
    const skill = fs.readFileSync(path.join(process.cwd(), "skills/sparra/SKILL.md"), "utf8");
    const diagnose = fs.readFileSync(path.join(process.cwd(), "skills/sparra/subskills/diagnose.md"), "utf8");
    const marketplace = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".claude-plugin/marketplace.json"), "utf8"));

    expect(buildLoop).toContain("UN-RUN");
    expect(buildLoop).toContain("ran+blocked");
    expect(buildLoop).toContain("`mixed`");
    expect(skill).toContain("unrunAssertionIds");
    expect(skill).toContain("exerciseStatus: mixed");
    expect(diagnose).toContain("Verdict lists `unrunAssertionIds`");
    expect(diagnose).toContain("all-UN-RUN verdict is inconclusive");
    // The plugin version only moves forward — assert it is strictly ABOVE the floor this test
    // documents, not pinned to one exact string (later items legitimately bump it further).
    expect(cmpDottedVersion(marketplace.metadata.version, "2026.7.3.2")).toBeGreaterThan(0);
  });
});

describe("contract-evaluator prompt — named-plan cross-check without cross-project contamination (E1)", () => {
  const ce = DEFAULT_PROMPTS["contract-evaluator"]!;
  it("PERMITS cross-checking a plan doc the item explicitly NAMES + existing shipped behavior", () => {
    // The grant lives in ANCHOR; the check itself lives in FIDELITY — both must survive.
    expect(ce).toContain("explicitly NAMES");
    expect(ce).toContain("cross-check contract vs that doc + existing cwd behavior");
    expect(ce).toContain("contradicts/outlaws an already-shipped feature");
  });
  it("STILL FORBIDS consulting unrelated sibling/parent projects' plans", () => {
    expect(ce).toContain("Do NOT search the filesystem");
    expect(ce).toContain("belongs to another project");
    // The old blanket ban ("judge ONLY against ... THIS message") must be gone, or the
    // grant above would contradict it.
    expect(ce).not.toContain("judge the contract ONLY against");
  });
  it("does not weaken the holdout wall — no text invites reading the holdout file", () => {
    expect(ce).not.toMatch(/holdout/i);
  });
});

describe("decomposer + reconciler prompts (Q7 a/b)", () => {
  it("DEFAULT_PROMPTS carries the decomposer prompt (moved out of decompose.ts)", () => {
    const d = DEFAULT_PROMPTS.decomposer;
    expect(d).toContain("decompose a frozen build plan");
    expect(d).toContain("SCALE THE COUNT TO THE PLAN'S SIZE");
    expect(d).toContain("Order items so dependencies come first");
  });

  it("DEFAULT_PROMPTS carries a short HEADLESS reconciler prompt — no interview/question language", () => {
    const r = DEFAULT_PROMPTS.reconciler!;
    expect(r).toBeTruthy();
    expect(r).toContain("PLAN.md");
    expect(r).toContain("NEVER ask questions");
    // The planner's interactive directives must be absent (grep-checkable headlessness).
    expect(r).not.toContain("Ask ONE question at a time");
    expect(r).not.toMatch(/interview/i);
    expect(r.length).toBeLessThan(DEFAULT_PROMPTS.planner!.length); // stays small
  });

  it("seedPrompts seeds both to disk matching the defaults, and promptDrift tracks them", async () => {
    const { dir, paths } = await tmpPaths();
    for (const role of ["decomposer", "reconciler"]) {
      expect(fs.readFileSync(paths.promptFile(role), "utf8").trim()).toBe(DEFAULT_PROMPTS[role]!.trim());
    }
    const byRole = Object.fromEntries((await promptDrift(paths)).map((d) => [d.role, d.state]));
    expect(byRole["decomposer"]).toBe("same");
    expect(byRole["reconciler"]).toBe("same");
    // Drift machinery sees an edit like any other role. seedPrompts recorded a baseline (==
    // the current default), so an edit AFTER seeding classifies as `local`, not the coarse `drifted`.
    fs.writeFileSync(paths.promptFile("decomposer"), "edited\n");
    const after = Object.fromEntries((await promptDrift(paths)).map((d) => [d.role, d.state]));
    expect(after["decomposer"]).toBe("local");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("prompt drift + sync", () => {
  it("reports every role in-sync right after seeding", async () => {
    const { dir, paths } = await tmpPaths();
    const drift = await promptDrift(paths);
    expect(drift.length).toBe(Object.keys(DEFAULT_PROMPTS).length);
    expect(drift.every((d) => d.state === "same")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("detects local edits and missing prompts (edit after seed is `local`, not coarse `drifted`)", async () => {
    const { dir, paths } = await tmpPaths();
    fs.writeFileSync(paths.promptFile("evaluator"), "totally different\n");
    fs.rmSync(paths.promptFile("generator"));
    const byRole = Object.fromEntries((await promptDrift(paths)).map((d) => [d.role, d.state]));
    expect(byRole["evaluator"]).toBe("local"); // baseline == default, disk moved → your edit
    expect(byRole["generator"]).toBe("missing");
    expect(byRole["planner"]).toBe("same");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("syncs a single role and leaves others untouched", async () => {
    const { dir, paths } = await tmpPaths();
    fs.writeFileSync(paths.promptFile("evaluator"), "drifted\n");
    fs.writeFileSync(paths.promptFile("generator"), "also drifted\n");
    const written = await syncPrompts(paths, { roles: ["evaluator"] });
    expect(written).toEqual(["evaluator"]);
    const byRole = Object.fromEntries((await promptDrift(paths)).map((d) => [d.role, d.state]));
    expect(byRole["evaluator"]).toBe("same"); // synced
    expect(byRole["generator"]).toBe("local"); // untouched (edited after seed → local)
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("syncs all drifted/missing roles when none specified", async () => {
    const { dir, paths } = await tmpPaths();
    fs.writeFileSync(paths.promptFile("evaluator"), "drifted\n");
    fs.rmSync(paths.promptFile("generator"));
    const written = await syncPrompts(paths);
    expect(written).toContain("evaluator");
    expect(written).toContain("generator");
    expect((await promptDrift(paths)).every((d) => d.state === "same")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("prompt-drift baseline (three-way classification)", () => {
  it("hashPrompt is a stable, whitespace-insensitive hex sha256", () => {
    expect(hashPrompt("x")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPrompt("x")).toBe(hashPrompt("  x\n")); // ends trimmed
    expect(hashPrompt("a")).not.toBe(hashPrompt("b"));
  });

  it("readBaseline defaults to {} when absent; writeBaselineEntries MERGES (never clobbers)", async () => {
    const { dir, paths } = await tmpPaths();
    fs.rmSync(paths.promptBaseline, { force: true }); // start clean
    expect(await readBaseline(paths)).toEqual({});
    await writeBaselineEntries(paths, { roleA: "aaa" });
    await writeBaselineEntries(paths, { roleB: "bbb" });
    expect(await readBaseline(paths)).toEqual({ roleA: "aaa", roleB: "bbb" }); // roleA survived
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("seedPrompts records .baseline.json = hashPrompt(default) for every seeded role", async () => {
    const { dir, paths } = await tmpPaths();
    expect(fs.existsSync(paths.promptBaseline)).toBe(true);
    const base = await readBaseline(paths);
    for (const [role, body] of Object.entries(DEFAULT_PROMPTS)) {
      expect(base[role]).toBe(hashPrompt(body));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it(".baseline.json is never treated as a role — promptDrift returns exactly DEFAULT_PROMPTS roles", async () => {
    const { dir, paths } = await tmpPaths();
    const roles = (await promptDrift(paths)).map((d) => d.role).sort();
    expect(roles).toEqual(Object.keys(DEFAULT_PROMPTS).sort());
    expect(roles).not.toContain(".baseline");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("promptDrift is a PURE read — it neither creates nor modifies .baseline.json", async () => {
    const { dir, paths } = await tmpPaths();
    fs.rmSync(paths.promptBaseline, { force: true });
    await promptDrift(paths);
    expect(fs.existsSync(paths.promptBaseline)).toBe(false); // no write on read
    // And with a baseline present, a read leaves it byte-identical.
    await writeBaselineEntries(paths, { generator: "zzz" });
    const before = fs.readFileSync(paths.promptBaseline, "utf8");
    await promptDrift(paths);
    expect(fs.readFileSync(paths.promptBaseline, "utf8")).toBe(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("classifies `stale` — disk matches baseline but the default moved past it (safe to adopt)", async () => {
    const { dir, paths } = await tmpPaths();
    const diskText = "an older default the project has never touched\n";
    fs.writeFileSync(paths.promptFile("reviewer"), diskText);
    // Baseline records THAT older default's hash — so disk == baseline, but baseline != current default.
    await writeBaselineEntries(paths, { reviewer: hashPrompt(diskText) });
    const byRole = Object.fromEntries((await promptDrift(paths)).map((d) => [d.role, d.state]));
    expect(byRole["reviewer"]).toBe("stale");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("classifies `local` — you edited it, the default is unchanged", async () => {
    const { dir, paths } = await tmpPaths();
    fs.writeFileSync(paths.promptFile("reviewer"), "my local tweak\n"); // baseline still == default
    const byRole = Object.fromEntries((await promptDrift(paths)).map((d) => [d.role, d.state]));
    expect(byRole["reviewer"]).toBe("local");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("classifies `conflict` — disk, baseline, and current default all differ (both moved)", async () => {
    const { dir, paths } = await tmpPaths();
    fs.writeFileSync(paths.promptFile("reviewer"), "my local edit\n"); // disk != default
    await writeBaselineEntries(paths, { reviewer: hashPrompt("some third older default\n") }); // baseline != default, != disk
    const byRole = Object.fromEntries((await promptDrift(paths)).map((d) => [d.role, d.state]));
    expect(byRole["reviewer"]).toBe("conflict");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("legacy fallback — no baseline entry ⇒ an edited role is `drifted`, never a wrong classification", async () => {
    const { dir, paths } = await tmpPaths();
    fs.rmSync(paths.promptBaseline, { force: true }); // legacy project: no baseline at all
    fs.writeFileSync(paths.promptFile("reviewer"), "edited with no baseline\n");
    const byRole = Object.fromEntries((await promptDrift(paths)).map((d) => [d.role, d.state]));
    expect(byRole["reviewer"]).toBe("drifted");
    // Never stale/local/conflict when unclassifiable.
    expect(["stale", "local", "conflict"]).not.toContain(byRole["reviewer"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("`same` wins even when the baseline is stale/absent (disk == current default)", async () => {
    const { dir, paths } = await tmpPaths();
    await writeBaselineEntries(paths, { reviewer: hashPrompt("a stale baseline\n") });
    // disk is untouched (== current default), so it must read `same` regardless of the baseline.
    const byRole = Object.fromEntries((await promptDrift(paths)).map((d) => [d.role, d.state]));
    expect(byRole["reviewer"]).toBe("same");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sync adopts ONLY stale roles by default and refreshes the baseline → a re-check reads `same`", async () => {
    const { dir, paths } = await tmpPaths();
    // reviewer = stale (adoptable), planner = local (your edit, must be left alone by a bare sync).
    const staleText = "older reviewer default\n";
    fs.writeFileSync(paths.promptFile("reviewer"), staleText);
    await writeBaselineEntries(paths, { reviewer: hashPrompt(staleText) });
    fs.writeFileSync(paths.promptFile("planner"), "my planner edit\n");

    const drift = await promptDrift(paths);
    const summary = summarizePromptDrift(drift);
    expect(summary.stale).toContain("reviewer");
    expect(summary.local).toContain("planner");

    // Phase-level policy: a bare sync adopts stale only → pass exactly the stale roles.
    const written = await syncPrompts(paths, { roles: summary.stale });
    expect(written).toEqual(["reviewer"]);

    const after = Object.fromEntries((await promptDrift(paths)).map((d) => [d.role, d.state]));
    expect(after["reviewer"]).toBe("same"); // baseline refreshed on write
    expect(after["planner"]).toBe("local"); // your edit untouched
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cmdPrompts sync policy — stale-only vs --role vs --all (real phase, on-disk effect)", () => {
  const fakeCtx = (paths: Paths): Ctx => ({ root: paths.root, paths }) as unknown as Ctx;

  // Build a fixture with one role in each interesting state. Returns the on-disk texts so a test
  // can assert which files actually changed.
  async function scenario(): Promise<{ dir: string; paths: Paths; before: Record<string, string | null> }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-cmdprompts-"));
    const paths = new Paths(dir);
    await paths.ensureScaffold();
    await seedPrompts(paths); // all `same`, baseline == default

    // stale: reviewer disk == baseline, baseline != current default.
    const staleText = "older reviewer default\n";
    fs.writeFileSync(paths.promptFile("reviewer"), staleText);
    // local: planner edited after seed (baseline stays == default).
    fs.writeFileSync(paths.promptFile("planner"), "my planner edit\n");
    // conflict: generator disk != baseline != default.
    fs.writeFileSync(paths.promptFile("generator"), "my generator edit\n");
    // drifted: evaluator edited AND its baseline entry removed (legacy).
    fs.writeFileSync(paths.promptFile("evaluator"), "evaluator edit no baseline\n");
    // missing: decomposer file absent.
    fs.rmSync(paths.promptFile("decomposer"));

    // Rewrite the baseline: reviewer→older hash, generator→a third hash, evaluator→removed.
    const base = await readBaseline(paths);
    base["reviewer"] = hashPrompt(staleText);
    base["generator"] = hashPrompt("some third older generator default\n");
    delete base["evaluator"];
    fs.writeFileSync(paths.promptBaseline, JSON.stringify(base, null, 2) + "\n");

    // Sanity: the states are what we intend.
    const st = Object.fromEntries((await promptDrift(paths)).map((d) => [d.role, d.state]));
    expect(st["reviewer"]).toBe("stale");
    expect(st["planner"]).toBe("local");
    expect(st["generator"]).toBe("conflict");
    expect(st["evaluator"]).toBe("drifted");
    expect(st["decomposer"]).toBe("missing");

    const before: Record<string, string | null> = {};
    for (const role of ["reviewer", "planner", "generator", "evaluator", "decomposer"])
      before[role] = fs.existsSync(paths.promptFile(role)) ? fs.readFileSync(paths.promptFile(role), "utf8") : null;
    return { dir, paths, before };
  }

  const read = (paths: Paths, role: string): string | null =>
    fs.existsSync(paths.promptFile(role)) ? fs.readFileSync(paths.promptFile(role), "utf8") : null;

  it("bare sync adopts ONLY `stale`; local/conflict/drifted/missing are left byte-identical", async () => {
    const { dir, paths, before } = await scenario();
    await cmdPrompts(fakeCtx(paths), ["sync"], {});
    // reviewer (stale) adopted → now the current default.
    expect(read(paths, "reviewer")).toBe(DEFAULT_PROMPTS.reviewer + "\n");
    // everything else untouched.
    expect(read(paths, "planner")).toBe(before["planner"]);
    expect(read(paths, "generator")).toBe(before["generator"]);
    expect(read(paths, "evaluator")).toBe(before["evaluator"]);
    expect(read(paths, "decomposer")).toBeNull(); // missing stays absent
    const st = Object.fromEntries((await promptDrift(paths)).map((d) => [d.role, d.state]));
    expect(st["reviewer"]).toBe("same"); // baseline refreshed
    expect(st["planner"]).toBe("local");
    expect(st["generator"]).toBe("conflict");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("--role X force-overwrites that one role regardless of state (a `conflict`), touching no other", async () => {
    const { dir, paths, before } = await scenario();
    await cmdPrompts(fakeCtx(paths), ["sync"], { role: "generator" });
    expect(read(paths, "generator")).toBe(DEFAULT_PROMPTS.generator + "\n"); // forced despite conflict
    expect(read(paths, "reviewer")).toBe(before["reviewer"]); // stale left (not this role)
    expect(read(paths, "planner")).toBe(before["planner"]);
    const st = Object.fromEntries((await promptDrift(paths)).map((d) => [d.role, d.state]));
    expect(st["generator"]).toBe("same");
    expect(st["reviewer"]).toBe("stale");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("--all overwrites EVERY non-`same` role (stale+local+conflict+drifted+missing)", async () => {
    const { dir, paths } = await scenario();
    await cmdPrompts(fakeCtx(paths), ["sync"], { all: true });
    for (const role of ["reviewer", "planner", "generator", "evaluator", "decomposer"])
      expect(read(paths, role)).toBe(DEFAULT_PROMPTS[role] + "\n");
    expect((await promptDrift(paths)).every((d) => d.state === "same")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("zero-byte edge: a role truncated to '' is `local`, left by bare sync, adopted by --role", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-cmdprompts-empty-"));
    const paths = new Paths(dir);
    await paths.ensureScaffold();
    await seedPrompts(paths);
    fs.writeFileSync(paths.promptFile("reviewer"), ""); // zero-byte, baseline == default
    const st0 = Object.fromEntries((await promptDrift(paths)).map((d) => [d.role, d.state]));
    expect(st0["reviewer"]).toBe("local"); // NOT missing (file exists, just empty)

    await cmdPrompts(fakeCtx(paths), ["sync"], {}); // bare
    expect(fs.readFileSync(paths.promptFile("reviewer"), "utf8")).toBe(""); // untouched

    await cmdPrompts(fakeCtx(paths), ["sync"], { role: "reviewer" }); // force
    expect(fs.readFileSync(paths.promptFile("reviewer"), "utf8")).toBe(DEFAULT_PROMPTS.reviewer + "\n");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("summarizePromptDrift — buckets / actionable / line", () => {
  const drift = [
    { role: "reviewer", state: "stale" as const },
    { role: "planner", state: "local" as const },
    { role: "generator", state: "conflict" as const },
    { role: "evaluator", state: "drifted" as const },
    { role: "decomposer", state: "missing" as const },
    { role: "reconciler", state: "same" as const },
  ];

  it("buckets each state and is actionable when there are stale OR conflict roles", () => {
    const s = summarizePromptDrift(drift);
    expect(s.stale).toEqual(["reviewer"]);
    expect(s.local).toEqual(["planner"]);
    expect(s.conflict).toEqual(["generator"]);
    expect(s.drifted).toEqual(["evaluator"]);
    expect(s.missing).toEqual(["decomposer"]);
    expect(s.actionable).toBe(true);
  });

  it("the line NAMES stale roles (adoptable via sync) and mentions conflicts separately", () => {
    const { line } = summarizePromptDrift(drift);
    expect(line).toContain("reviewer"); // named as adoptable
    expect(line).toContain("sparra prompts sync");
    expect(line).toContain("generator"); // conflict mentioned separately
    expect(line).toMatch(/conflict/i);
  });

  it("is non-actionable with a null line when every role is `same`", () => {
    const s = summarizePromptDrift([{ role: "x", state: "same" as const }]);
    expect(s.actionable).toBe(false);
    expect(s.line).toBeNull();
  });

  it("is non-actionable when only local/drifted/missing (no adoptable update, no conflict)", () => {
    const s = summarizePromptDrift([
      { role: "a", state: "local" as const },
      { role: "b", state: "drifted" as const },
      { role: "c", state: "missing" as const },
    ]);
    expect(s.actionable).toBe(false);
    expect(s.line).toBeNull();
  });
});
