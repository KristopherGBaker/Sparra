# iOS / macOS projects

Sparra builds and **exercises a real running Apple-platform app** (not just a diff): it builds, launches the app, drives the UI, screenshots it, and — because the evaluator is **multimodal** — *reads the screenshot* to judge it, plus a UI hierarchy for deterministic assertions. So it can verify UI changes, not just that the app compiles.

Two platforms, set by **`exercise.ios.platform`**:
- **`ios`** (default) — runs in the **iOS Simulator**; UI is screenshotted/driven via `xcodebuildmcp`'s simulator tooling (`simctl`, `snapshot-ui`/`describe-ui`, tap/type).
- **`macos`** — a Mac app has **no simulator**: the `.app` is built and run **on the host**. xcodebuildmcp's screenshot/ui-automation suite is simulator-only, so the UI is observed/driven through an **XCUITest** target (run via `macos test`), with `XCUIScreenshot`s extracted from the `.xcresult` and a live `screencapture`. See [macOS apps](#macos-apps-no-simulator).

## Prerequisites (macOS)
- **Xcode** + an **iOS Simulator** (the evaluator's shell runs locally; in a container/CI without Xcode the mechanism degrades to a warning).
- **`xcodebuildmcp`** CLI: `brew tap getsentry/xcodebuildmcp && brew install xcodebuildmcp` (or `npm i -g xcodebuildmcp@latest`).
- **XcodeGen**: `brew install xcodegen` (projects are defined by `project.yml`, not a hand-authored `.pbxproj`).
- *(optional)* **SwiftFormat** + **SwiftLint** for format-on-write: `brew install swiftformat swiftlint`.
- *(optional)* **xcbeautify**: `brew install xcbeautify`. When present, the guidance has the agent pipe raw `xcodebuild` through `xcbeautify -qq` (with `set -o pipefail`) for concise build logs — fewer tokens, easier to read; it re-runs verbose to diagnose a failure. Absent → plain `xcodebuild`.

## Config
```yaml
exercise:
  mechanism: ios
  ios:
    cli: xcodebuildmcp     # default; "" → raw xcrun/xcodebuild
    scheme: ""             # "" → the evaluator discovers it
    simulator: ""          # "" → auto-discover an available one (or pin e.g. "iPhone 17"); iOS only
    platform: ios          # "ios" (Simulator) or "macos" (run the .app on the host; verify via XCUITest)
  runExistingTests: true   # existing projects: new failures = hard fail

format:
  # SwiftLint is a linter, SwiftFormat a formatter — run both before the evaluator sees a file.
  command: "sh -c 'swiftformat {file}; swiftlint --fix --path {file}'"
```

## Conventions Sparra builds to
On `mechanism: ios` the generator is given the house Swift conventions automatically (greenfield) or from `CODEBASE_MAP.md` (existing). Notably:

- **XcodeGen is authoritative** — edit `project.yml`, run `xcodegen generate`; never hand-edit the `.pbxproj`. The exerciser regenerates from `project.yml` if the `.xcodeproj` is missing/stale.
- **A launch screen is mandatory** — `INFOPLIST_KEY_UILaunchScreen_Generation: "YES"` (or a `UILaunchScreen: {}` Info.plist entry). Without it the app runs **letterboxed at 320×480 with black bars**, reports wrong screen metrics, and **breaks coordinate-based UI automation** (taps land off-target). The evaluator treats a legacy/letterboxed frame as an app defect, not a tooling glitch.
- Idiomatic modern SwiftUI (`@Observable`/`@MainActor`, value types), **Swift Testing** (not XCTest), persistence behind a store/repository seam, no code signing for simulator builds.

## macOS apps (no simulator)
Set `exercise.ios.platform: macos`. A Mac app runs on the host, and xcodebuildmcp's `screenshot`/`ui-automation` tools are **simulator-only** (its `macos` workflow has build/launch/`stop`/`test` but no UI tools). So Sparra verifies a Mac UI through **XCUITest**, not simulator screenshots:

- **The generator must include an XCUITest UI-test target** (the house conventions tell it to on `platform: macos`). It launches the app via `XCUIApplication` (honoring any sample-data launch flag the plan names), drives flows including the keyboard (`.typeKey`/`.typeText`), asserts on `XCUIElement` queries, and attaches `XCUIScreenshot`s. A Mac UI with no automatable test target can't be verified.
- **The evaluator** runs that target (`<cli> macos test` / `xcodebuild test -destination 'platform=macOS'`), grades on its pass/fail, **extracts the screenshots** from the `.xcresult` (`xcrun xcresulttool export attachments …`) and *reads* them, and takes a live `screencapture` for a visual sanity check. XCUITest assertions justify pass/fail; screenshots justify taste.
- AX/`osascript` synthetic events are deliberately **not** the drive mechanism — they need interactive Accessibility (TCC) permission and are unreliable headless.
- No launch-screen/letterbox concern (that's iOS-only); the standard build-flag/sandbox conventions still apply.

## Gotchas
- **Builds are slow** — the exercise command timeout allows up to 10 minutes; building + booting a sim every round costs time/tokens.
- **Don't nest a Sparra work dir inside another Sparra project.** Run a standalone iOS project in its own directory; a parent project's stray `PLAN.md`/`.sparra/` can confuse a read-only role. (The evaluator prompts are anchored to ignore unrelated plans on disk, but a clean directory is best.)
- **`settingSources: []`** means Sparra doesn't *ambiently* inherit your global Claude Code MCP/skill config — the `xcodebuildmcp` workflow is baked into the evaluator's guidance, so nothing to wire beyond the config above. To give the evaluator your actual build/run skill on top of that, declare it explicitly: `roles.evaluator.skills: ["xcodebuildmcp-cli"]` (see [backends — skills](backends.md#skills)). Skills are declared, not inherited, so the run stays reproducible.

## Cross-backend (Codex builds, Claude judges)
Apple builds pair well with [cross-backend evaluation](backends.md#cross-backend-evaluation) — e.g. Codex writes the Swift, an independent Claude/opus evaluator grades the running app:
```yaml
roles:
  generator:  { backend: codex,  model: gpt-5-codex }
  decomposer: { backend: claude, model: opus }   # keep planning on Claude
  evaluator:  { backend: claude, model: opus, effort: high }
```

## Examples
- [`examples/ios-greenfield/`](../examples/ios-greenfield/) — **TipJar**, a SwiftUI tip calculator (pure computation + UI, screenshot-graded).
- [`examples/ios-notes/`](../examples/ios-notes/) — **Jotter**, a SwiftData notes app (CRUD + persistence + a relaunch check); ships a cross-backend config.
