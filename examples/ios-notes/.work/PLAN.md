# Plan: Jotter — a simplified Apple Notes-style app

## Intent
`Jotter` is a small SwiftUI note-taking app: a list of notes you can create, edit,
and delete, persisted across launches with SwiftData. It's a step up from the TipJar
example — it exercises **CRUD, persistence, and stateful navigation**, so the build
loop must build it, drive real flows (add → type → back → delete), and confirm data
survives a relaunch.

## Constraints
- **SwiftUI**, a single iOS **app target**, no third-party dependencies.
- **Persistence with SwiftData** (`@Model`, `ModelContainer`, `@Query`) — no networking,
  no accounts. Everything local and deterministic.
- Project defined with **XcodeGen** (`project.yml` → `xcodegen generate`); runs in the
  iOS Simulator and renders **fullscreen** (a launch screen is configured).

## Approach
One model and two screens:
- `@Model final class Note` with `title`, `body`, `createdAt`, `updatedAt`.
- A **list screen** (`@Query` sorted by `updatedAt` descending) with an add (`+`) button
  and swipe-to-delete; tapping a row opens the editor.
- An **editor screen**: a title field and a multi-line body editor bound to the note;
  edits autosave to the SwiftData context.
- `ModelContainer` installed at the app entry point. Keep it idiomatic and minimal —
  let the build loop settle details. (House Swift/SwiftUI conventions are provided to
  the builder automatically.)

## Patterns to conform to
- SwiftData `@Model` + `@Query` + `@Environment(\.modelContext)`, container at `@main`
  (the JPAssist Notes pattern).
- Expose **accessibility identifiers** on the add button, each list row, the title field,
  and the body editor so the running UI can be driven and asserted (like TipJar's labels).
- Swift Testing for any pure logic (e.g. list-title fallback / sort helpers).

## Risks & unknowns
- Greenfield SwiftData wiring (`ModelContainer` at `@main`) must be correct or the app
  won't launch.
- Autosave timing — edits should reach the store before navigating back.
- Empty-title notes need a sensible display fallback, not a blank row.
- Relaunch persistence must be verified by actually relaunching the app, not just re-reading in-process.

## Success criteria
- `project.yml` exists and **`xcodegen generate` produces a buildable `.xcodeproj`**.
- The app **builds, launches, and renders fullscreen** (no letterbox) in the iOS Simulator.
- **Empty state**: first launch with no data shows a placeholder (e.g. "No Notes").
- **Create**: tapping the add (`+`) control creates a note and opens it in the editor.
- **Edit persists in-session**: entering a title + body and returning to the list shows
  that note (title, and a body snippet) in the list.
- **Edit updates in place**: re-opening and changing a note updates it — no duplicate row.
- **Ordering**: the list is sorted most-recently-edited first.
- **Empty-title fallback**: a note with no title shows "New Note"/"Untitled", not a blank row.
- **Delete**: swipe-to-delete removes the note from the list.
- **Persistence across relaunch**: after creating a note and **relaunching** the app, the
  note is still present (SwiftData persisted it).
