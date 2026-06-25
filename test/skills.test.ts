import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSkills, skillsForRole, inlineSkillsBlock, buildSkillPlugin } from "../src/sdk/skills.ts";
import { defaultConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";

function tmpRoot(skills: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparra-skills-test-"));
  for (const [name, body] of Object.entries(skills)) {
    const sdir = path.join(dir, "skills", name);
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, "SKILL.md"), body);
  }
  return dir;
}

function ctxWith(root: string, mut: (c: ReturnType<typeof defaultConfig>) => void): Ctx {
  const config = defaultConfig();
  mut(config);
  return { root, config } as unknown as Ctx;
}

describe("resolveSkills", () => {
  it("resolves a repo skills/ skill and reads its SKILL.md", () => {
    const root = tmpRoot({ demo: "# demo\n\nDo the demo thing." });
    const r = resolveSkills(["demo"], root);
    expect(r).toHaveLength(1);
    expect(r[0]!.name).toBe("demo");
    expect(r[0]!.skillMd).toMatch(/Do the demo thing/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("skips missing skills without throwing", () => {
    const root = tmpRoot({ demo: "# demo\n\nx" });
    const r = resolveSkills(["demo", "nope-not-real-xyz"], root);
    expect(r.map((s) => s.name)).toEqual(["demo"]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("skillsForRole", () => {
  it("builder roles inherit build.skills; grading roles do not", () => {
    const root = tmpRoot({ demo: "# demo\n\nx" });
    const ctx = ctxWith(root, (c) => (c.build.skills = ["demo"]));
    expect(skillsForRole(ctx, "generator").map((s) => s.name)).toEqual(["demo"]);
    expect(skillsForRole(ctx, "prototyper").map((s) => s.name)).toEqual(["demo"]);
    expect(skillsForRole(ctx, "evaluator")).toHaveLength(0);
    expect(skillsForRole(ctx, "reviewer")).toHaveLength(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("an explicit role.skills overrides build.skills (and enables non-builder roles)", () => {
    const root = tmpRoot({ demo: "# demo\n\nx", alt: "# alt\n\ny" });
    const ctx = ctxWith(root, (c) => {
      c.build.skills = ["demo"];
      c.roles.evaluator.skills = ["alt"]; // opt the evaluator in explicitly
      c.roles.generator.skills = ["alt"]; // override the builder's inherited set
    });
    expect(skillsForRole(ctx, "evaluator").map((s) => s.name)).toEqual(["alt"]);
    expect(skillsForRole(ctx, "generator").map((s) => s.name)).toEqual(["alt"]);
    expect(skillsForRole(ctx, "prototyper").map((s) => s.name)).toEqual(["demo"]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("inlineSkillsBlock (Codex fallback)", () => {
  it("inlines name + SKILL.md body", () => {
    const block = inlineSkillsBlock([{ name: "demo", dir: "/x", skillMd: "# demo\n\nThe body." }]);
    expect(block).toMatch(/## Available skills/);
    expect(block).toMatch(/Skill: demo/);
    expect(block).toMatch(/The body\./);
  });
  it("is empty for no skills", () => {
    expect(inlineSkillsBlock([])).toBe("");
  });
});

describe("buildSkillPlugin (Claude native)", () => {
  it("wraps skills as a local plugin and cleans up", () => {
    const root = tmpRoot({ demo: "# demo\n\nx" });
    const resolved = resolveSkills(["demo"], root);
    const plug = buildSkillPlugin(resolved);
    expect(plug.names).toEqual(["demo"]);
    expect(fs.existsSync(path.join(plug.path, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(fs.existsSync(path.join(plug.path, "skills", "demo", "SKILL.md"))).toBe(true);
    plug.cleanup();
    expect(fs.existsSync(plug.path)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
