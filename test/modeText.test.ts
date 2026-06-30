import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Paths } from "../src/paths.ts";
import { StateStore } from "../src/state.ts";
import { defaultConfig } from "../src/config.ts";
import { contractModeClauses } from "../src/build/modeText.ts";
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
