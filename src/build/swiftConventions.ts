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
export function appleConventions(): string {
  return `APPLE/SWIFT HOUSE CONVENTIONS — this is an Apple-platform project; build it the way the surrounding apps are built:
- Project: XcodeGen is authoritative — edit project.yml and run \`xcodegen generate\`; never hand-edit the .pbxproj. An iOS app target MUST configure a launch screen (\`INFOPLIST_KEY_UILaunchScreen_Generation: "YES"\` or a \`UILaunchScreen: {}\` Info.plist entry) or the app letterboxes. Swift 6.2.
- Concurrency: keep strict-concurrency CLEAN (zero warnings). Use \`@Observable\` + \`@MainActor\` for view/coordinator state — typically a single \`AppModel\` injected via \`@Environment\`; use \`actor\`s for long-lived services; never pass \`inout\` across an actor boundary (return new values).
- Structure: organize app code BY FEATURE (e.g. \`Notes/\`, \`Editor/\`, \`Settings/\`), not by layer. Put pure, UI-free logic in a Swift package (\`Sources/<Kit>/\`, \`Tests/<Kit>Tests/\`); dependency direction is app → packages, never the reverse. As a type approaches ~250 lines, split it into \`Type+Area.swift\` extension files.
- Tests: use Swift Testing (\`import Testing\`, \`@Test\`, \`#expect\`) — NOT XCTest. Cover real edge cases and failure paths, not vanity coverage; keep pure logic testable without mocks.
- Quality: idiomatic modern SwiftUI (value types, bindings, no view controllers), SwiftLint-clean. The harness formats on write.
- Persistence (if any): behind a store/repository seam (GRDB or SwiftData \`@Model\`), never touched directly from views. Shared visual style lives in a design-system package (tokens + components), not duplicated per view.

When the feature calls an LLM / model:
- Put model access behind a PROVIDER SEAM protocol — on Apple, prefer the Shikisha package's \`ChatModel\` (the user's Swift LLM abstraction) rather than hardcoding a vendor. Make on-device the default; cloud is an explicit, Keychain-backed opt-in.
- Centralize prompts (enums or YAML), never scatter string literals; pin the exact JSON shape in the system prompt for structured output.
- Stream via \`AsyncThrowingStream\` accumulating cumulative snapshots; support cancellation (\`.onTermination\` / \`Task.checkCancellation()\`).
- Parse structured output defensively: strip code fences, isolate balanced JSON, decode per-kind DTOs, drop invalid entries rather than failing the whole batch. Layer error types so one item's failure does not abort a fan-out.
- Test with fakes/fixtures — NO live API calls in the test suite.`;
}
