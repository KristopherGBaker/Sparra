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
- Must produce a **buildable Xcode project that launches in the iOS Simulator**.
- Currency shown with two decimal places (e.g. `$120.00`).

## Approach
Scaffold a runnable SwiftUI app project with the `xcodebuildmcp` CLI (the same tool
the evaluator uses), then implement one screen:
- a bill-amount `TextField` (decimal keypad),
- a tip-percentage control (segmented `Picker` or `Slider`) with a few presets,
- live-updating **Tip** and **Total** labels.
Keep the math in a small, pure function so it's trivial to reason about; the view just
binds to it. High-level only — let the build loop settle the details.

## Patterns to conform to
Greenfield, so no existing code to match — but write idiomatic modern SwiftUI
(value types, `@State`/bindings, no view controllers) and keep it SwiftFormat/SwiftLint
clean (the harness formats on write).

## Risks & unknowns
- Greenfield **Xcode project scaffolding** is the genuinely hard part — the project
  must build and run unattended in the simulator.
- Currency/locale formatting and rounding (round to cents; don't show `$119.99999`).
- Empty / non-numeric / zero bill must not crash and should read as `$0.00`.
- Simulator/scheme discovery (the evaluator can discover the scheme via the CLI).

## Success criteria
- The app **builds and launches** in the iOS Simulator.
- Bill `100`, tip `20%` → Tip reads `$20.00` and Total reads `$120.00`.
- Bill `0` (or empty) → Tip `$0.00`, Total `$0.00`, no crash.
- Changing the tip percentage **recomputes** Tip and Total live.
- The Tip and Total are **visibly rendered and legible** on screen (the evaluator
  confirms this from a screenshot).
- Non-numeric / malformed bill input is handled gracefully (treated as 0, no crash).
