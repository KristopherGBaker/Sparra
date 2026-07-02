import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import { contractModeClauses, rubricText, selfVerifyGuidance } from "../src/build/modeText.ts";
import type { Ctx } from "../src/context.ts";

async function makeCtx(mode: "existing" | "greenfield"): Promise<{ ctx: Ctx; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-modetext-"));
  const paths = new Paths(dir);
  await paths.ensureScaffold();
  const store = StateStore.create(paths, mode);
  const ctx: Ctx = { root: dir, paths, config: defaultConfig(), store };
  return { ctx, dir };
}

describe("contractModeClauses — CODEBASE_MAP.md clause degrades when no map exists (H6)", () => {
  it("existing + a CODEBASE_MAP.md on disk → mandates conformance to that file", async () => {
    const { ctx, dir } = await makeCtx("existing");
    fs.writeFileSync(ctx.paths.codebaseMap, "# Codebase map\n");
    const out = contractModeClauses(ctx);
    expect(out).toContain("Conforms to the conventions in CODEBASE_MAP.md");
    expect(out).toContain("Does not regress existing behavior");
    expect(out).toContain("existing test suite");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("existing + NO map on disk → drops the CODEBASE_MAP.md demand, keeps no-regression + suite", async () => {
    const { ctx, dir } = await makeCtx("existing");
    // Precondition: the scaffold did NOT create a map (orient was never run).
    expect(fs.existsSync(ctx.paths.codebaseMap)).toBe(false);
    expect(fs.existsSync(ctx.paths.frozenMap)).toBe(false);
    const out = contractModeClauses(ctx);
    expect(out).not.toContain("Conforms to the conventions in CODEBASE_MAP.md");
    expect(out).toContain("Does not regress existing behavior");
    expect(out).toContain("existing test suite");
    // Still emits a (satisfiable) conventions clause.
    expect(out).toContain("Conforms to the repo's existing conventions");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the map-present and map-absent branches produce DIFFERENT text (not a no-op)", async () => {
    const a = await makeCtx("existing");
    fs.writeFileSync(a.ctx.paths.codebaseMap, "# Codebase map\n");
    const withMap = contractModeClauses(a.ctx);

    const b = await makeCtx("existing"); // no map written
    const withoutMap = contractModeClauses(b.ctx);

    expect(withMap).not.toBe(withoutMap);
    expect(withMap).toContain("CODEBASE_MAP.md");
    expect(withoutMap).not.toContain("Conforms to the conventions in CODEBASE_MAP.md");

    fs.rmSync(a.dir, { recursive: true, force: true });
    fs.rmSync(b.dir, { recursive: true, force: true });
  });

  it("a frozen map alone (no live map) also satisfies the map-present branch", async () => {
    const { ctx, dir } = await makeCtx("existing");
    fs.mkdirSync(path.dirname(ctx.paths.frozenMap), { recursive: true });
    fs.writeFileSync(ctx.paths.frozenMap, "# Frozen map\n");
    const out = contractModeClauses(ctx);
    expect(out).toContain("Conforms to the conventions in CODEBASE_MAP.md");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("greenfield is unchanged (no mandatory clauses)", async () => {
    const { ctx, dir } = await makeCtx("greenfield");
    const out = contractModeClauses(ctx);
    expect(out).toContain("greenfield");
    expect(out).not.toContain("MANDATORY CLAUSES");
    expect(out).not.toContain("CODEBASE_MAP.md");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("selfVerifyGuidance — in-place opt-in ungating (H7 assertion 7e)", () => {
  it("in-place (no build.branch): emits the SELF-VERIFY block ONLY when allowVerify=true", async () => {
    const { ctx, dir } = await makeCtx("existing");
    expect(ctx.store.data.build.branch).toBeFalsy(); // in-place — no branch
    expect(ctx.config.build.verifyCommands.length).toBeGreaterThan(0); // precondition

    // Without the opt-in the generator is NOT told which commands it may run (today's behavior).
    expect(selfVerifyGuidance(ctx)).toBe("");
    expect(selfVerifyGuidance(ctx, false)).toBe("");

    // With the opt-in the block appears, naming the verify commands.
    const out = selfVerifyGuidance(ctx, true);
    expect(out).toContain("SELF-VERIFY");
    expect(out).toContain(ctx.config.build.verifyCommands[0]!);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("on a branch: the block is emitted regardless of the opt-in (unchanged)", async () => {
    const { ctx, dir } = await makeCtx("existing");
    ctx.store.data.build.branch = "sparra/x"; // worktree/branch boundary
    expect(selfVerifyGuidance(ctx)).toContain("SELF-VERIFY");
    expect(selfVerifyGuidance(ctx, true)).toContain("SELF-VERIFY");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("no verifyCommands → empty even with the opt-in (nothing to run)", async () => {
    const { ctx, dir } = await makeCtx("existing");
    ctx.config.build.verifyCommands = [];
    expect(selfVerifyGuidance(ctx, true)).toBe("");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("rubricText — anchored criterion definitions + band scale (Q4)", () => {
  it("names each criterion WITH its definition phrase (not bare weight lines)", async () => {
    const { ctx, dir } = await makeCtx("greenfield");
    const out = rubricText(ctx);
    expect(out).toContain("design (weight 0.25): architecture/API/UX fit the problem");
    expect(out).toContain("originality (weight 0.15): real judgment, not boilerplate/AI-slop");
    expect(out).toContain("craft (weight 0.3): code quality — naming, structure, error handling");
    expect(out).toContain("functionality (weight 0.3): works when exercised — contract assertions hold with evidence");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("carries the generic band scale with all four boundaries + the pass threshold", async () => {
    const { ctx, dir } = await makeCtx("greenfield");
    const out = rubricText(ctx);
    expect(out).toContain("Bands (each criterion):");
    expect(out).toContain("90+ exemplary");
    expect(out).toContain("70-89 solid");
    expect(out).toContain("50-69 notable gaps");
    expect(out).toContain("<50 broken/deficient");
    expect(out).toContain(`Pass threshold: weighted total ≥ ${ctx.config.rubric.passThreshold}.`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reflects configured weights/threshold (rendered, not hardcoded)", async () => {
    const { ctx, dir } = await makeCtx("greenfield");
    ctx.config.rubric.weights = { design: 0.4, originality: 0.1, craft: 0.2, functionality: 0.3 };
    ctx.config.rubric.passThreshold = 80;
    const out = rubricText(ctx);
    expect(out).toContain("design (weight 0.4)");
    expect(out).toContain("≥ 80");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
