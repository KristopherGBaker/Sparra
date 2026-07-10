import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

describe("sparra-loop skill and dual-manifest integrity", () => {
  const root = process.cwd();
  const skillDir = path.join(root, "skills", "sparra-loop");

  it("validates frontmatter, linked references, cross-host evals, manifests, and host isolation", () => {
    const skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
    expect(frontmatter).not.toBeNull();
    const metadata = parseYaml(frontmatter![1]!) as { name?: unknown; description?: unknown };
    expect(metadata.name).toBe("sparra-loop");
    expect(metadata.description).toEqual(expect.any(String));
    expect((metadata.description as string).trim().length).toBeGreaterThan(0);

    const linkedReferences = [...skill.matchAll(/\]\(references\/(.+?\.md)\)/g)].map((m) => m[1]!);
    const phaseOneReferences = [
      "interactive-build.md", "loop-core.md", "role-result.md", "recovery.md", "scheduling.md", "claude-code.md",
    ];
    for (const file of [...new Set([...linkedReferences, ...phaseOneReferences, "codex.md"])]) {
      expect(fs.existsSync(path.join(skillDir, "references", file)), file).toBe(true);
    }

    const crossHostEvals = [
      "zero-setup-codex-eval.md", "cross-model-and-reverse.md", "collapsed-independence.md",
      "recovery-envelope.md", "parallel-queue-refill.md", "holdout-wall.md",
      "full-engine-step-handoff.md", "claude-regression.md",
    ];
    for (const file of crossHostEvals) expect(fs.existsSync(path.join(skillDir, "evals", file)), file).toBe(true);

    const claude = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8")) as {
      plugins: Array<{ source: string; skills: string[]; agents?: string[] }>;
    };
    for (const plugin of claude.plugins) {
      expect(fs.existsSync(path.resolve(root, plugin.source))).toBe(true);
      for (const target of [...plugin.skills, ...(plugin.agents ?? [])]) expect(fs.existsSync(path.resolve(root, target))).toBe(true);
    }
    const codex = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin", "plugin.json"), "utf8")) as {
      skills: string; mcpServers: string; interface: { logo: string };
    };
    for (const target of [codex.skills, codex.mcpServers, codex.interface.logo]) {
      expect(fs.existsSync(path.resolve(root, target)), target).toBe(true);
    }

    const referencesDir = path.join(skillDir, "references");
    const references = fs.readdirSync(referencesDir).filter((file) => file.endsWith(".md"));
    for (const file of references.filter((file) => file !== "claude-code.md")) {
      expect(fs.readFileSync(path.join(referencesDir, file), "utf8"), file).not.toMatch(/run_in_background|\bTask\b/);
    }
    expect(fs.readFileSync(path.join(referencesDir, "codex.md"), "utf8")).not.toMatch(/run_in_background|\bTask\b/);
  });
});
