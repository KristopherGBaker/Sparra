import type { Ctx } from "../context.ts";

/** True when the build targets an Apple platform (mechanism: ios covers iOS/macOS/etc.). */
export function isApplePlatform(ctx: Ctx): boolean {
  return ctx.config.exercise.mechanism === "ios";
}

/**
 * House conventions for Apple/Swift work, injected into the GENERATOR (not the
 * contract/evaluator). This is guidance on HOW to build — architecture and idioms —
 * so generated code matches the user's existing apps. It is deliberately NOT turned
 * into contract assertions: "done" is still graded on observable behavior + the
 * build/lint/test gates, never on internal style (that's the over-spec trap).
 */
export function appleConventions(platform: "ios" | "macos" = "ios"): string {
  const macVerify =
    platform === "macos"
      ? `\n- macOS verification: a Mac app has NO simulator, so Sparra observes/drives its UI through an XCUITest UI-test target — INCLUDE ONE. It must launch the app via \`XCUIApplication\` (honoring any sample-data launch flag the plan names), drive the key flows (including keyboard: \`.typeKey\`/\`.typeText\` for Space/Delete/arrows), assert on \`XCUIElement\` queries, and attach \`XCUIScreenshot\`s. A UI with no automatable test target cannot be verified — treat the UI-test target as part of "done", run via \`xcodebuild test\`/\`<cli> macos test\`.`
      : "";
  return `APPLE/SWIFT HOUSE CONVENTIONS — this is an Apple-platform project; build it the way the surrounding apps are built:
- Project: XcodeGen is authoritative — edit project.yml and run \`xcodegen generate\`; never hand-edit the .pbxproj. Reference a LOCAL SwiftPM package that sits in the project's own directory (e.g. an engine package at the repo root) with \`path: .\` — NEVER \`path: ./\`: a trailing slash makes XcodeGen resolve it to the filesystem root \`/\`, emitting a folder reference that makes \`xcodebuild\` recursively scan the entire disk and hang (no compiler ever starts) on project load. An iOS app target MUST configure a launch screen (\`INFOPLIST_KEY_UILaunchScreen_Generation: "YES"\` or a \`UILaunchScreen: {}\` Info.plist entry) or the app letterboxes. Swift 6.2.${macVerify}
- Concurrency: keep strict-concurrency CLEAN (zero warnings). Use \`@Observable\` + \`@MainActor\` for view/coordinator state — typically a single \`AppModel\` injected via \`@Environment\`; use \`actor\`s for long-lived services; never pass \`inout\` across an actor boundary (return new values).
- Structure: organize app code BY FEATURE (e.g. \`Notes/\`, \`Editor/\`, \`Settings/\`), not by layer. Put pure, UI-free logic in a Swift package (\`Sources/<Kit>/\`, \`Tests/<Kit>Tests/\`); dependency direction is app → packages, never the reverse. As a type approaches ~250 lines, split it into \`Type+Area.swift\` extension files.
- Tests: use Swift Testing (\`import Testing\`, \`@Test\`, \`#expect\`) — NOT XCTest. Cover real edge cases and failure paths, not vanity coverage; keep pure logic testable without mocks.
- Quality: idiomatic modern SwiftUI (value types, bindings, no view controllers), SwiftLint-clean. The harness formats on write.
- Build logs: when you run \`xcodebuild\` directly, pipe it through \`xcbeautify -qq\` for concise output — \`set -o pipefail; xcodebuild … | xcbeautify -qq\` (pipefail so a build failure still fails the command). Re-run without \`-qq\`/xcbeautify for full logs when you need to diagnose an error; if xcbeautify isn't installed, plain xcodebuild is fine. (Also tidies \`swift build\`/\`swift test\`.)
- Do NOT bake build-environment workarounds into \`project.yml\` that you wouldn't ship — especially settings that weaken security/sandboxing (\`-disable-sandbox\`, \`ENABLE_USER_SCRIPT_SANDBOXING: NO\`, relaxed ATS). If YOUR build environment needs such a flag to compile, pass it transiently on the \`xcodebuild\` command line for your own verification — never persist it in the committed project.
- Don't keep view state on a vestigial \`AppModel\` you never read; only add an \`@Observable\` \`AppModel\` when there's real cross-view state for it to own.
- Stable, deterministic UI: avoid per-keystroke churn that re-creates the view (e.g. bumping a \`@Query\` sort key on every character); debounce or commit on done. Flaky input handling fails the evaluator.
- Persistence (if any): behind a store/repository seam (GRDB or SwiftData \`@Model\`), never touched directly from views. Shared visual style lives in a design-system package (tokens + components), not duplicated per view.

When the feature calls an LLM / model:
- Put model access behind a PROVIDER SEAM protocol — on Apple, prefer the Shikisha package's \`ChatModel\` (the user's Swift LLM abstraction) rather than hardcoding a vendor. Make on-device the default; cloud is an explicit, Keychain-backed opt-in.
- Centralize prompts (enums or YAML), never scatter string literals; pin the exact JSON shape in the system prompt for structured output.
- Stream via \`AsyncThrowingStream\` accumulating cumulative snapshots; support cancellation (\`.onTermination\` / \`Task.checkCancellation()\`).
- Parse structured output defensively: strip code fences, isolate balanced JSON, decode per-kind DTOs, drop invalid entries rather than failing the whole batch. Layer error types so one item's failure does not abort a fan-out.
- Test with fakes/fixtures — NO live API calls in the test suite.`;
}
