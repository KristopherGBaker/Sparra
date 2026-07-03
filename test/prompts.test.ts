import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Paths } from "../src/paths.ts";
import { seedPrompts, promptDrift, syncPrompts, DEFAULT_PROMPTS } from "../src/prompts.ts";

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
    expect(marketplace.metadata.version).toBe("2026.7.3.8");
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
    // Drift machinery sees an edit like any other role.
    fs.writeFileSync(paths.promptFile("decomposer"), "edited\n");
    const after = Object.fromEntries((await promptDrift(paths)).map((d) => [d.role, d.state]));
    expect(after["decomposer"]).toBe("drifted");
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

  it("detects drifted and missing prompts", async () => {
    const { dir, paths } = await tmpPaths();
    fs.writeFileSync(paths.promptFile("evaluator"), "totally different\n");
    fs.rmSync(paths.promptFile("generator"));
    const byRole = Object.fromEntries((await promptDrift(paths)).map((d) => [d.role, d.state]));
    expect(byRole["evaluator"]).toBe("drifted");
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
    expect(byRole["generator"]).toBe("drifted"); // untouched
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
