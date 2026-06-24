import { describe, it, expect } from "vitest";
import { buildExerciser, iosGuidance } from "../src/sdk/exercise.ts";
import { defaultConfig } from "../src/config.ts";

describe("iosGuidance", () => {
  it("drives the configured CLI help-first and uses screenshots + the UI hierarchy", () => {
    const cfg = defaultConfig();
    cfg.exercise.mechanism = "ios";
    cfg.exercise.ios = { cli: "xcodebuildmcp", scheme: "MyApp", simulator: "iPhone 16" };
    const g = iosGuidance(cfg);
    expect(g).toContain("xcodebuildmcp --help"); // help-first discovery
    expect(g).toContain("MyApp");
    expect(g).toContain("iPhone 16");
    expect(g).toMatch(/Read tool/); // screenshot → multimodal read
    expect(g).toMatch(/hierarchy/i); // deterministic assertions
    expect(g).toMatch(/build-and-run/);
    expect(g).toMatch(/xcodegen generate/); // regenerate XcodeGen projects before building
  });

  it("falls back to raw Apple tooling when no CLI is configured", () => {
    const cfg = defaultConfig();
    cfg.exercise.ios = { cli: "", scheme: "", simulator: "iPhone 16" };
    const g = iosGuidance(cfg);
    expect(g).toMatch(/xcrun simctl/);
    expect(g).toMatch(/Read tool/);
  });

  it("wires the ios guidance into the exerciser for the ios mechanism", () => {
    const cfg = defaultConfig();
    cfg.exercise.mechanism = "ios";
    cfg.exercise.ios = { cli: "xcodebuildmcp", scheme: "App", simulator: "iPhone 16" };
    const ex = buildExerciser(cfg, "/tmp/work");
    expect(ex.guidance).toContain("xcodebuildmcp");
    expect(ex.allowedTools).toContain("mcp__exercise__run_command");
  });
});
