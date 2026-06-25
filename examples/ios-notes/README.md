# Example: greenfield iOS build (`Jotter`, a SwiftData notes app)

A runnable end-to-end demo of Sparra building a **simplified Apple Notes-style app** —
a list of notes you create, edit, delete, and that **persist across launches** with
SwiftData. It's a step up from [`ios-greenfield`](../ios-greenfield/) (TipJar): instead
of pure computation it exercises **CRUD, persistence, and a relaunch check**, so the
evaluator has to drive real flows and confirm data survives.

It also showcases the Apple/Swift **house conventions** Sparra injects for `mechanism: ios`
builds (SwiftData `@Model`/`@Query`, `@Observable`/`@MainActor`, Swift Testing, XcodeGen,
launch screen) — see the repo README's iOS section.

## Prerequisites (macOS only)
- **Xcode** + an **iOS Simulator**.
- **`xcodebuildmcp`**: `brew tap getsentry/xcodebuildmcp && brew install xcodebuildmcp`
- **`xcodegen`**: `brew install xcodegen`
- (Optional) **SwiftFormat** + **SwiftLint** for format-on-write: `brew install swiftformat swiftlint`
- An Anthropic credential (`ANTHROPIC_API_KEY` or a Claude Code login).

## Run it
```bash
# from the repo root
npm install
bash examples/ios-notes/run.sh
```

In a throwaway `examples/ios-notes/.work/`, it runs `sparra init → freeze → build`. The
build loop negotiates a contract, generates the SwiftData app (XcodeGen → `xcodegen
generate` → SwiftUI), then **exercises it for real**: builds & launches in the simulator,
adds a note, edits it, deletes one, and **relaunches to confirm persistence** — citing
screenshots and the `describe-ui` hierarchy as evidence.

## What it exercises that TipJar didn't
- **Persistence**: SwiftData store wired at `@main`; the evaluator relaunches the app and
  checks the note is still there.
- **Stateful navigation + CRUD**: add → type → back → re-open → edit → delete.
- **Empty/edge states**: empty list placeholder, empty-title fallback.

## What to look at afterward
Everything's in `.work/.sparra/`: `contracts/`, `verdicts/` (with screenshot + hierarchy
evidence), `traces/<run>/`, `memory.md`. Then try `node ../../bin/sparra.mjs reflect --root .work`.
