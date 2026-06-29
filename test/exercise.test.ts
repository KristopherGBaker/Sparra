import { describe, it, expect } from "vitest";
import { buildExerciser, iosGuidance } from "../src/sdk/exercise.ts";
import { defaultConfig } from "../src/config.ts";

describe("iosGuidance", () => {
  it("drives the configured CLI help-first and uses screenshots + the UI hierarchy", () => {
    const cfg = defaultConfig();
    cfg.exercise.mechanism = "ios";
    cfg.exercise.ios = { cli: "xcodebuildmcp", scheme: "MyApp", simulator: "iPhone 16", platform: "ios" };
    const g = iosGuidance(cfg);
    expect(g).toContain("xcodebuildmcp --help"); // help-first discovery
    expect(g).toContain("MyApp");
    expect(g).toContain("iPhone 16");
    expect(g).toMatch(/Read tool/); // screenshot → multimodal read
    expect(g).toMatch(/hierarchy/i); // deterministic assertions
    expect(g).toMatch(/build-and-run/);
    expect(g).toMatch(/xcodegen generate/); // regenerate XcodeGen projects before building
    expect(g).toMatch(/letterbox/i); // catch missing-launch-screen as an app defect, not tooling
  });

  it("tells the evaluator to discover an available simulator when none is pinned", () => {
    const cfg = defaultConfig();
    cfg.exercise.ios = { cli: "xcodebuildmcp", scheme: "", simulator: "", platform: "ios" };
    const g = iosGuidance(cfg);
    expect(g).toMatch(/simctl list devices available/);
    expect(g).toMatch(/pick an available/i);
  });

  it("falls back to raw Apple tooling when no CLI is configured", () => {
    const cfg = defaultConfig();
    cfg.exercise.ios = { cli: "", scheme: "", simulator: "iPhone 16", platform: "ios" };
    const g = iosGuidance(cfg);
    expect(g).toMatch(/xcrun simctl/);
    expect(g).toMatch(/Read tool/);
  });

  it("for a macOS app, drives XCUITest + xcresult/screencapture and AVOIDS the simulator path", () => {
    const cfg = defaultConfig();
    cfg.exercise.mechanism = "ios";
    cfg.exercise.ios = { cli: "xcodebuildmcp", scheme: "DemoApp", simulator: "", platform: "macos" };
    const g = iosGuidance(cfg);
    expect(g).toMatch(/macOS app/);
    expect(g).toMatch(/XCUITest/); // the deterministic UI spine
    expect(g).toMatch(/macos test/); // run the UI-test target
    expect(g).toMatch(/xcresulttool/); // extract screenshots from the .xcresult
    expect(g).toMatch(/screencapture/); // live visual sanity
    expect(g).toMatch(/DemoApp/);
    expect(g).not.toMatch(/simctl/); // simulator tooling does NOT apply to macOS
    expect(g).not.toMatch(/letterbox/i); // simulator-only concern
  });

  it("wires the ios guidance into the exerciser for the ios mechanism", () => {
    const cfg = defaultConfig();
    cfg.exercise.mechanism = "ios";
    cfg.exercise.ios = { cli: "xcodebuildmcp", scheme: "App", simulator: "iPhone 16", platform: "ios" };
    const ex = buildExerciser(cfg, "/tmp/work");
    expect(ex.guidance).toContain("xcodebuildmcp");
    expect(ex.allowedTools).toContain("mcp__exercise__run_command");
  });
});
