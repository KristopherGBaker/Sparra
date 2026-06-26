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
