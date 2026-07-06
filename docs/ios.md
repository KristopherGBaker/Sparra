# iOS / macOS projects

> This is **one worked example** of adapting Sparra to a stack — a `custom`-style exerciser (`xcodebuildmcp`) plus injected house conventions and a `format.command`. The specific tooling and Swift conventions below reflect how the author builds Apple apps; treat them as a template. The same hooks — a custom exercise recipe, `build.verifyCommands`, per-role `skills`, and editable role prompts — let you fit Sparra to *your* toolchain in any language. See [Adapt it to your stack](../README.md#adapt-it-to-your-stack).

Sparra builds and **exercises a real running Apple-platform app** (not just a diff): it builds, launches the app, drives the UI, screenshots it, and — because the evaluator is **multimodal** — *reads the screenshot* to judge it, plus a UI hierarchy for deterministic assertions. So it can verify UI changes, not just that the app compiles.

Two platforms, set by **`exercise.ios.platform`**:
- **`ios`** (default) — runs in the **iOS Simulator**; UI is screenshotted/driven via `xcodebuildmcp`'s simulator tooling (`simctl`, `snapshot-ui`/`describe-ui`, tap/type).
- **`macos`** — a Mac app has **no simulator**: the `.app` is built and run **on the host**. xcodebuildmcp's screenshot/ui-automation suite is simulator-only, so the UI is observed/driven through an **XCUITest** target (run via `macos test`), with `XCUIScreenshot`s extracted from the `.xcresult` and a live `screencapture`. See [macOS apps](#macos-apps-no-simulator).

## Prerequisites (macOS)
- **Xcode** + an **iOS Simulator** (the evaluator's shell runs locally; in a container/CI without Xcode the mechanism degrades to a warning).
- **`xcodebuildmcp`** CLI: `brew tap getsentry/xcodebuildmcp && brew install xcodebuildmcp` (or `npm i -g xcodebuildmcp@latest`).
- **XcodeGen**: `brew install xcodegen` (projects are defined by `project.yml`, not a hand-authored `.pbxproj`).
- *(optional)* **SwiftFormat** + **SwiftLint** for format-on-write: `brew install swiftformat swiftlint`.
- *(optional)* **ffmpeg**: `brew install ffmpeg`. Needed only for **animation** verification (`exercise.ios.visual: true`, the default) — the evaluator tiles a Simulator screen recording into one contact sheet with `ffmpeg`. Absent → the animation gate is **UN-RUN** (environment-blocked), never failed; static screenshots don't need it.
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
    visual: true           # iOS only: inject the screenshot + animation contact-sheet recipe (needs ffmpeg for animation); false → pre-recipe guidance
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
- **Deterministic-reach hooks** — the generator exposes `#if DEBUG` **launch-arg hooks** (reading `ProcessInfo.processInfo.arguments`) so the evaluator can jump straight to a UI state via `simctl launch … <args>` (a feature flag, skip-onboarding, seed a fixture, optionally auto-trigger the interaction). This is what makes the screenshots/animation captures below *reliable* — the evaluator reaches the exact state under test instead of hand-navigating.

## Visual verification (screenshots + animation contact sheets)
With **`exercise.ios.visual: true`** (the default), the iOS exerciser guidance carries a **visual-verification recipe** so the multimodal evaluator can put *eyes* on Simulator-runnable UI **and animation** — the dimension code review is blind to. The evaluator runs these commands itself (Sparra encodes the recipe, it doesn't run a capture pipeline).

**Static UI → screenshot.** Boot a simulator (`xcrun simctl boot <udid>`), build into a **repo-local `-derivedDataPath`** — passing **`CODE_SIGNING_ALLOWED=NO`** when driving raw `xcodebuild` for an unsigned Simulator build (unsigned Sim + SPM resource bundles) — then `xcrun simctl install <udid> <app>`, `xcrun simctl launch <udid> <bundle> <launch-args>`, and `xcrun simctl io <udid> screenshot <file>.png`. The evaluator **Reads the PNG** and judges it, complemented by an **accessibility-hierarchy dump** for deterministic assertions.

**Animation / transition → contact sheet.** Record around a scripted trigger:
```bash
xcrun simctl io <udid> recordVideo --codec=h264 clip.mov      # h264, NOT hevc (ffmpeg decode compatibility)
ffmpeg -i clip.mov -vf "fps=N,scale=W:-2,tile=CxR" sheet.png   # ONE image; -2 auto-picks an EVEN height (odd/-1 fails)
```
The evaluator **Reads the single contact sheet** and judges the **start→mid→end** geometry. Use **two passes**: a **coarse** sheet over the full clip to *locate* the motion, then a **dense** sheet over a *narrow window* around the transition to *judge* it.

**Timing caveats.** `window.layer.speed` does **not** slow **system-driven** transitions (e.g. a `UINavigation preferredTransition = .zoom`) — only a **custom** `UIViewControllerAnimatedTransitioning` animator with an **explicit duration** is slow-mo-able; the Simulator's **⌘T Slow-Animations** toggle is **GUI-only** (not CLI-scriptable). A system transition can be **~0.15s**, so capture at **high fps** and sample **densely** around the window (expect a sparse peak).

**Honest boundary (the evidence must state it).** These captures **prove** geometry / layout / nav structure / transition *shape*. They do **not** prove motion feel, jank, frame pacing (120 Hz), gesture interruptibility, or Simulator-gated **GPU/ML** (Metal / Neural Engine) paths — the evaluator must **not** claim those from a screenshot or contact sheet.

**UN-RUN semantics.** If the Simulator is unavailable (or `recordVideo`/`ffmpeg` for an animation gate), the affected visual gates — **static screenshot gates included** — are **UN-RUN** (environment-blocked), **never failed** and **never passed via a weaker fallback**. A screenshot only *supplements* a static-UI check; it **never** substitutes for an animation gate. Set `exercise.ios.visual: false` for the pre-recipe guidance (byte-identical to before the knob existed).

## macOS apps (no simulator)
Set `exercise.ios.platform: macos`. A Mac app runs on the host, and xcodebuildmcp's `screenshot`/`ui-automation` tools are **simulator-only** (its `macos` workflow has build/launch/`stop`/`test` but no UI tools). So Sparra verifies a Mac UI through **XCUITest**, not simulator screenshots:

- **The generator must include an XCUITest UI-test target** (the house conventions tell it to on `platform: macos`). It launches the app via `XCUIApplication` (honoring any sample-data launch flag the plan names), drives flows including the keyboard (`.typeKey`/`.typeText`), asserts on `XCUIElement` queries, and attaches `XCUIScreenshot`s. A Mac UI with no automatable test target can't be verified.
- **The evaluator** runs that target (`<cli> macos test` / `xcodebuild test -destination 'platform=macOS'`), grades on its pass/fail, **extracts the screenshots** from the `.xcresult` (`xcrun xcresulttool export attachments …`) and *reads* them, and takes a live `screencapture` for a visual sanity check. XCUITest assertions justify pass/fail; screenshots justify taste.
- AX/`osascript` synthetic events are deliberately **not** the drive mechanism — they need interactive Accessibility (TCC) permission and are unreliable headless.
- No launch-screen/letterbox concern (that's iOS-only); the standard build-flag/sandbox conventions still apply.

## SwiftPM dependency prewarm
Two things break a Swift `swift build`/`swift test`/`make test` gate under a sandboxed run: a
read-only `$HOME` (clang can't write `~/.cache/clang/ModuleCache`), and **network off** in a
throwaway worktree (the first `swift build` can't resolve packages like GRDB). Sparra fixes both so
the gate runs **as shipped** — no `--disable-sandbox` workaround baked into `project.yml`:

- **Cache redirect (all sandboxed build sessions).** The generator, the two judge roles
  (evaluator + contract-evaluator), and the contract-negotiation sessions get a writable-scratch env
  layer (`src/build/judgeScratch.ts`, `createSandboxSessionEnv`) that points `CLANG_MODULE_CACHE_PATH`
  and `TMPDIR` at a fresh per-run scratch dir, and **`SWIFTPM_CACHE_DIR`** at a **durable,
  worktree-local** cache. Your `build.env` still overrides. See
  [backends → writable-scratch env layer](backends.md#default-writable-scratch-env-layer-all-sandboxed-build-sessions).
- **Dependency prewarm (`git.provisionDeps.swiftPackages`, default on).** When the worktree is
  provisioned — while the network is still available — Sparra runs a `swift package resolve` into that
  **same durable `SWIFTPM_CACHE_DIR`** if the tree is a SwiftPM package (`Package.swift` present). A
  later **offline** `swift build` in the worktree reuses the resolved state instead of failing to
  fetch. It's a **non-fatal no-op** off-knob, on a non-Swift project, or in-place; a prewarm failure
  is warned, never aborting the build. Set `git.provisionDeps.swiftPackages: false` to skip it.

## Gotchas
- **Builds are slow** — the exercise command timeout allows up to 10 minutes; building + booting a sim every round costs time/tokens.
- **Local SwiftPM package in the project's own dir → use `path: .`, never `path: ./`.** When `project.yml` references a local package that lives in the same directory as the `.xcodeproj` (e.g. an engine package at the repo root), a trailing slash (`path: ./`) makes XcodeGen resolve it to the filesystem root `/`, emitting a folder reference. `xcodebuild` then recursively scans the whole disk on project load (stuck in `IDEContainer _locateFileReferencesRecursively`) — it pins a CPU, spawns **no** compiler workers, produces **zero** `.o` files, and "hangs" for many minutes. `path: .` (no slash) resolves correctly and builds in seconds. The generator is told this; see [diagnose](../skills/sparra/subskills/diagnose.md).
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
