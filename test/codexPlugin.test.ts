import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Codex plugin packaging", () => {
  const pluginRoot = process.cwd();
  const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;

  it("parses the manifest and resolves its declared skill path", () => {
    expect(manifest).not.toHaveProperty("agents");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+-[0-9A-Za-z-]+$/);
    expect(manifest.skills).toBe("./skills/");

    const skillsPath = path.resolve(pluginRoot, manifest.skills as string);
    expect(fs.statSync(skillsPath).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(skillsPath, "sparra-loop", "SKILL.md"))).toBe(true);
  });

  it("resolves and validates the long-running Sparra MCP declaration", () => {
    expect(manifest.mcpServers).toBe("./.codex-plugin/mcp.json");
    const mcpPath = path.resolve(pluginRoot, manifest.mcpServers as string);
    expect(fs.existsSync(mcpPath)).toBe(true);

    const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8")) as {
      mcpServers: Record<string, { command: string; tool_timeout_sec: number }>;
    };
    expect(mcp.mcpServers["sparra-run"]).toMatchObject({ command: "sparra-run-mcp" });
    expect(mcp.mcpServers["sparra-run"]!.tool_timeout_sec).toBeGreaterThanOrEqual(1800);
  });

  it("resolves the interface logo and exposes the three starter scenarios", () => {
    const ui = manifest.interface as { defaultPrompt: string[]; logo: string };
    expect(fs.existsSync(path.resolve(pluginRoot, ui.logo))).toBe(true);
    expect(ui.defaultPrompt).toHaveLength(3);
    expect(ui.defaultPrompt.join("\n")).toMatch(/Evaluate my current work once/i);
    expect(ui.defaultPrompt.join("\n")).toMatch(/interactive cross-model/i);
    expect(ui.defaultPrompt.join("\n")).toMatch(/build --step=contract,round,commit,item/i);
  });

  it("bumps the Claude marketplace version monotonically with the shared router", () => {
    const marketplace = JSON.parse(
      fs.readFileSync(path.join(pluginRoot, ".claude-plugin", "marketplace.json"), "utf8"),
    ) as { metadata: { version: string } };
    const parts = marketplace.metadata.version.split(".").map(Number);
    const floor = [2026, 7, 10, 1];
    const isAboveFloor = parts.some((part, index) => {
      const priorEqual = parts.slice(0, index).every((value, prior) => value === floor[prior]);
      return priorEqual && part > floor[index]!;
    });
    expect(isAboveFloor).toBe(true);
  });
});
