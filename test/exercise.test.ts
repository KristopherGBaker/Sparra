import { describe, it, expect } from "vitest";
import { buildExerciser, iosGuidance, nativeRunnerGuidance } from "../src/sdk/exercise.ts";
import { defaultConfig } from "../src/config.ts";

describe("buildExerciser — backend-aware exercise guidance (inProcessMcp)", () => {
  it("inProcessMcp:true (default) keeps the mcp__exercise__run_command mandate (byte-for-byte)", () => {
    const cfg = defaultConfig();
    cfg.exercise.mechanism = "cli";
    const observed = buildExerciser(cfg, "/tmp/work"); // default
    const explicit = buildExerciser(cfg, "/tmp/work", { inProcessMcp: true });
    expect(observed.guidance).toContain("mcp__exercise__run_command");
    expect(explicit.guidance).toBe(observed.guidance); // explicit true === default
  });

  it("inProcessMcp:false drops EVERY mcp__exercise__ token and directs the native runner + honest self-report", () => {
    const cfg = defaultConfig();
    cfg.exercise.mechanism = "cli";
    const native = buildExerciser(cfg, "/tmp/work", { inProcessMcp: false });
    expect(native.guidance).not.toContain("mcp__exercise__"); // NO phantom tool mandate
    expect(native.guidance).toMatch(/native command runner|shell\/Bash/i);
    expect(native.guidance).toMatch(/cannot observe or classify exit codes/i);
    expect(native.guidance).toMatch(/exerciseStatus.*HONESTLY|HONESTLY.*exerciseStatus/is);
    // Substance preserved: it still tells the evaluator to exercise real behavior (swift build hint survives).
    expect(native.guidance).toMatch(/swift build|swift test|exit code/i);
  });

  it("web: the native path strips mcp__exercise__http_request too (no exercise-MCP token survives)", () => {
    const cfg = defaultConfig();
    cfg.exercise.mechanism = "web";
    const observed = buildExerciser(cfg, "/tmp/work", { inProcessMcp: true });
    expect(observed.guidance).toContain("mcp__exercise__http_request");
    const native = buildExerciser(cfg, "/tmp/work", { inProcessMcp: false });
    expect(native.guidance).not.toContain("mcp__exercise__");
  });

  it("nativeRunnerGuidance is a pure transform: prepends the honest preamble and rewrites tool refs", () => {
    const out = nativeRunnerGuidance("Exercise it with mcp__exercise__run_command and probe via mcp__exercise__http_request.");
    expect(out).not.toContain("mcp__exercise__");
    expect(out).toMatch(/cannot observe or classify exit codes/i);
    expect(out).toMatch(/shell\/Bash/);
  });
});

describe("iosGuidance", () => {
  it("drives the configured CLI help-first and uses screenshots + the UI hierarchy", () => {
    const cfg = defaultConfig();
    cfg.exercise.mechanism = "ios";
    cfg.exercise.ios = { cli: "xcodebuildmcp", scheme: "MyApp", simulator: "iPhone 16", platform: "ios", visual: true };
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
    cfg.exercise.ios = { cli: "xcodebuildmcp", scheme: "", simulator: "", platform: "ios", visual: true };
    const g = iosGuidance(cfg);
    expect(g).toMatch(/simctl list devices available/);
    expect(g).toMatch(/pick an available/i);
  });

  it("falls back to raw Apple tooling when no CLI is configured", () => {
    const cfg = defaultConfig();
    cfg.exercise.ios = { cli: "", scheme: "", simulator: "iPhone 16", platform: "ios", visual: true };
    const g = iosGuidance(cfg);
    expect(g).toMatch(/xcrun simctl/);
    expect(g).toMatch(/Read tool/);
  });

  it("for a macOS app, drives XCUITest + xcresult/screencapture and AVOIDS the simulator path", () => {
    const cfg = defaultConfig();
    cfg.exercise.mechanism = "ios";
    cfg.exercise.ios = { cli: "xcodebuildmcp", scheme: "DemoApp", simulator: "", platform: "macos", visual: true };
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
    cfg.exercise.ios = { cli: "xcodebuildmcp", scheme: "App", simulator: "iPhone 16", platform: "ios", visual: true };
    const ex = buildExerciser(cfg, "/tmp/work");
    expect(ex.guidance).toContain("xcodebuildmcp");
    expect(ex.allowedTools).toContain("mcp__exercise__run_command");
  });
});

/** iOS config with the visual knob on (the default) — used across the visual-recipe assertions. */
function iosVisualOn(): ReturnType<typeof defaultConfig> {
  const cfg = defaultConfig();
  cfg.exercise.mechanism = "ios";
  cfg.exercise.ios = { cli: "xcodebuildmcp", scheme: "MyApp", simulator: "iPhone 16", platform: "ios", visual: true };
  return cfg;
}

describe("iosGuidance — visual verification recipe (exercise.ios.visual)", () => {
  it("defaults the visual knob ON so the real iosGuidance carries the recipe", () => {
    expect(defaultConfig().exercise.ios.visual).toBe(true);
    const g = iosGuidance(iosVisualOn());
    expect(g).toMatch(/VISUAL VERIFICATION/);
  });

  // Assertion 2: the ANIMATION recipe verbatim elements.
  it("contains the ANIMATION recipe: recordVideo/h264 → ffmpeg fps+scale=…:-2+tile contact sheet, one-sheet start→mid→end, coarse-then-dense", () => {
    const g = iosGuidance(iosVisualOn());
    expect(g).toContain("recordVideo");
    expect(g).toContain("--codec=h264");
    expect(g).toMatch(/fps=/);
    expect(g).toMatch(/scale=W:-2/); // even-height form
    expect(g).not.toMatch(/scale=\S*:-1/); // the odd-height form must NOT appear anywhere
    expect(g).toMatch(/tile=/);
    expect(g).toMatch(/ONE image|single contact sheet|start→mid→end/);
    expect(g).toMatch(/start→mid→end/);
    expect(g).toMatch(/COARSE[\s\S]*DENSE/); // two-pass: coarse to locate, dense to judge
  });

  // Assertion 3: the STATIC recipe chain.
  it("contains the STATIC recipe chain: boot → build/install → simctl launch <args> → screenshot → Read PNG → hierarchy, with CODE_SIGNING_ALLOWED=NO", () => {
    const g = iosGuidance(iosVisualOn());
    expect(g).toMatch(/simctl boot/);
    expect(g).toContain("CODE_SIGNING_ALLOWED=NO");
    expect(g).toMatch(/simctl install/);
    expect(g).toMatch(/simctl launch <udid> <bundle> <launch-args>/);
    expect(g).toMatch(/simctl io <udid> screenshot/);
    expect(g).toMatch(/READ the PNG/);
    expect(g).toMatch(/accessibility-hierarchy/);
  });

  // Assertion 4: the timing caveats.
  it("contains the timing caveats: window.layer.speed useless for system transitions, ⌘T GUI-only, custom animator explicit duration, ~0.15s high-fps dense", () => {
    const g = iosGuidance(iosVisualOn());
    expect(g).toContain("window.layer.speed");
    expect(g).toMatch(/does NOT slow SYSTEM-driven transitions/);
    expect(g).toContain("UIViewControllerAnimatedTransitioning");
    expect(g).toMatch(/EXPLICIT duration/);
    expect(g).toMatch(/⌘T[\s\S]*GUI-only/);
    expect(g).toMatch(/~0\.15s/);
    expect(g).toMatch(/HIGH fps/);
  });

  // Assertion 5: honest boundary as REQUIRED evidence content.
  it("states the honest Simulator boundary as REQUIRED evidence (geometry proven; feel/jank/120Hz/gesture/GPU-ML not)", () => {
    const g = iosGuidance(iosVisualOn());
    expect(g).toMatch(/evidence MUST state this/);
    expect(g).toMatch(/geometry \/ layout \/ nav structure \/ transition shape/i);
    expect(g).toMatch(/motion feel/i);
    expect(g).toMatch(/jank/i);
    expect(g).toMatch(/120 Hz/);
    expect(g).toMatch(/gesture interruptibility/i);
    expect(g).toMatch(/GPU\/ML|Metal|Neural Engine/);
  });

  // Assertion 6: UN-RUN semantics for ALL visual gates + screenshots-supplement-only.
  it("states UN-RUN semantics for ALL visual gates (static + animation) and screenshots-supplement-static-only", () => {
    const g = iosGuidance(iosVisualOn());
    expect(g).toMatch(/UN-RUN semantics \(ALL visual gates\)/);
    expect(g).toMatch(/static screenshot gates INCLUDED/);
    expect(g).toMatch(/environment-blocked/);
    expect(g).toMatch(/never FAILED and never passed via a weaker fallback/);
    expect(g).toMatch(/SUPPLEMENTS a static-UI check; it NEVER substitutes for an animation gate/);
  });

  // Assertion 5 (launch-arg convention appears on the evaluator side too).
  it("carries the #if DEBUG launch-arg deterministic-reach convention", () => {
    const g = iosGuidance(iosVisualOn());
    expect(g).toContain("#if DEBUG");
    expect(g).toMatch(/launch-arg hooks/);
  });

  // Assertion 9: byte-identical off-paths — the recipe is a pure appended suffix, nothing else changes.
  it("knob-OFF iOS guidance is byte-identical to the pre-recipe output (visual section is a pure suffix)", () => {
    const on = iosVisualOn();
    const off = iosVisualOn();
    off.exercise.ios.visual = false;
    const gOn = iosGuidance(on);
    const gOff = iosGuidance(off);
    expect(gOn).not.toBe(gOff); // the knob actually flips the section on
    expect(gOn.startsWith(gOff)).toBe(true); // and does so purely by appending — the prefix is untouched
    expect(gOff).not.toMatch(/VISUAL VERIFICATION|recordVideo|ffmpeg/); // no recipe leaks into the off-path
  });

  it("knob-OFF also holds for the raw-tooling (no-CLI) iOS path", () => {
    const on = iosVisualOn();
    on.exercise.ios = { cli: "", scheme: "", simulator: "iPhone 16", platform: "ios", visual: true };
    const off = iosVisualOn();
    off.exercise.ios = { cli: "", scheme: "", simulator: "iPhone 16", platform: "ios", visual: false };
    const gOn = iosGuidance(on);
    const gOff = iosGuidance(off);
    expect(gOn.startsWith(gOff)).toBe(true);
    expect(gOff).not.toMatch(/VISUAL VERIFICATION|recordVideo/);
    expect(gOn).toContain("recordVideo");
  });

  it("macOS guidance is unaffected by the visual knob (byte-identical) and never carries the simulator recipe", () => {
    const on = iosVisualOn();
    on.exercise.ios = { cli: "xcodebuildmcp", scheme: "DemoApp", simulator: "", platform: "macos", visual: true };
    const off = iosVisualOn();
    off.exercise.ios = { cli: "xcodebuildmcp", scheme: "DemoApp", simulator: "", platform: "macos", visual: false };
    const gOn = iosGuidance(on);
    const gOff = iosGuidance(off);
    expect(gOn).toBe(gOff); // visual knob is a no-op on macOS
    expect(gOn).not.toMatch(/recordVideo|VISUAL VERIFICATION/);
  });
});
