# Plan: TipJar — a tiny SwiftUI tip calculator

## Intent
`TipJar` is a single-screen iOS app that calculates a tip and total from a bill
amount and a tip percentage. It's the iOS "hello world" of the Sparra build loop:
small enough to build and adversarially exercise in one pass, but real enough that
the evaluator must actually **build it, run it in a simulator, drive the UI, and
look at the result** — not just read the diff.

## Constraints
- **SwiftUI**, a single iOS **app target**, no third-party dependencies.
- No networking, no persistence, no accounts — everything is local and deterministic.
- **Define the project with XcodeGen** (`project.yml` → `xcodegen generate`); do not
  hand-author the `.pbxproj`. Build/run the generated project in the iOS Simulator.
- Currency shown with two decimal places (e.g. `$120.00`).

## Approach
Generate the Xcode project with **XcodeGen**, then implement one screen:
1. Write a `project.yml` and run `xcodegen generate` to produce the `.xcodeproj`.
2. Implement the SwiftUI app:
   - a bill-amount `TextField` (decimal keypad),
   - a tip-percentage control (segmented `Picker` or `Slider`) with a few presets,
   - live-updating **Tip** and **Total** labels.
3. Keep the math in a small, **pure function** so it's trivial to reason about; the
   view just binds to it.
Build & run with `xcodebuildmcp`. High-level only — let the build loop settle details.

## Patterns to conform to
Match the XcodeGen conventions used across these projects:
- `options: { createIntermediateGroups: true, defaultConfig: Debug }`, `configs: { Debug: debug, Release: release }`.
- A single `application` target (`platform: iOS`) plus its `sources` path(s).
- `settings.base`: `SWIFT_VERSION: 6.2`, `PRODUCT_BUNDLE_IDENTIFIER: com.krisbaker.tipjar`,
  `GENERATE_INFOPLIST_FILE: YES` (keep it minimal for a demo), `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION`.
- **Don't configure code signing or a development team** — simulator builds don't need it.
  (The goal is "signing doesn't block the build", not "prove the bundle is unsigned" — the
  toolchain ad-hoc-signs simulator binaries automatically.)
- Idiomatic modern SwiftUI (value types, `@State`/bindings, no view controllers), SwiftFormat/SwiftLint clean (the harness formats on write).

## Risks & unknowns
- The **`project.yml` must be correct** so `xcodegen generate` yields a project that
  builds and launches unattended in the simulator (the genuinely hard part).
- Currency/locale formatting and rounding (round to cents; don't show `$119.99999`).
- Empty / non-numeric / zero bill must not crash and should read as `$0.00`.
- Simulator/scheme discovery (the evaluator can discover the scheme via the CLI).

## Success criteria
- A `project.yml` exists and **`xcodegen generate` produces a buildable `.xcodeproj`**.
- The app **builds and launches** in the iOS Simulator.
- Bill `100`, tip `20%` → Tip reads `$20.00` and Total reads `$120.00`.
- Bill `0` (or empty) → Tip `$0.00`, Total `$0.00`, no crash.
- Changing the tip percentage **recomputes** Tip and Total live.
- The Tip and Total are **visibly rendered and legible** on screen (the evaluator
  confirms this from a screenshot).
- Non-numeric / malformed bill input is handled gracefully (treated as 0, no crash).
