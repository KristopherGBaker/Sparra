# Example: greenfield iOS build (`TipJar`)

A runnable, watchable end-to-end demo of Sparra's autonomous build loop on a **native
iOS app**. It builds **`TipJar`**, a one-screen SwiftUI tip calculator, from a frozen
plan — so you can watch **Phase C** drive a real UI: contract negotiation → Swift
generation → **build & run in the iOS Simulator** → **screenshot + UI-hierarchy
grading** → accept on pass.

This is the iOS analog of [`cli-greenfield`](../cli-greenfield/). Use it to exercise the
Apple-platform exerciser, the SwiftFormat/SwiftLint format-on-write hook, and the
multimodal evaluator that *looks at the running UI*.

## Prerequisites (macOS only)

- **Xcode** + at least one **iOS Simulator** (this runs locally on your Mac).
- The **`xcodebuildmcp`** CLI on your `PATH`:
  ```bash
  brew tap getsentry/xcodebuildmcp && brew install xcodebuildmcp
  # or: npm install -g xcodebuildmcp@latest
  ```
- (Optional) **SwiftFormat** + **SwiftLint** for the format-on-write hook
  (`brew install swiftformat swiftlint`). Missing → the hook no-ops with a warning.
- An Anthropic credential (`ANTHROPIC_API_KEY` or a Claude Code login).

## Run it

```bash
# from the repo root
npm install
bash examples/ios-greenfield/run.sh
```

That will, in a throwaway `examples/ios-greenfield/.work/` directory:

1. `sparra init` — detect greenfield, scaffold `.sparra/`.
2. Drop in [`config.yaml`](config.yaml) — deliberately minimal: it inherits Sparra's
   built-in defaults (opus-heavy roles, `$5`/item budget) and only sets the iOS bits
   (`mechanism: ios` + the `swiftformat`+`swiftlint` format command). If a greenfield
   Xcode scaffold runs long, bump `build.maxTurnsPerSession` / `build.maxBudgetUsdPerItem`.
3. `sparra freeze` — lock the shipped [`PLAN.md`](PLAN.md) as build input.
4. `sparra build` — the autonomous loop:
   - decompose the plan,
   - **negotiate a "done" contract** (generator proposes assertions; adversarial evaluator hardens them),
   - **generate** the Swift app (scaffolding the Xcode project via `xcodebuildmcp`),
   - **exercise it for real**: build & launch in the simulator, drive the UI, and
     **screenshot the result** — the evaluator *reads the image* and the `describe-ui`
     hierarchy to check assertions like "bill 100 @ 20% → Total `$120.00`",
   - **grade** against the contract + rubric, pivot/patch if needed, accept on pass.

> Heads-up: greenfield Xcode-project scaffolding is the genuinely hard part, and native
> builds are slow — expect this to take longer (and cost more) than the CLI example.

## What to look at afterward

Everything is on disk in `.work/.sparra/`:

- `contracts/` — the generator↔evaluator negotiation and the AGREED contract.
- `verdicts/` — per-round scores and assertion pass/fail, with the **screenshot /
  UI-hierarchy evidence** the evaluator cited.
- `traces/<run>/` — every agent's full transcript as readable markdown.
- `memory.md` — durable cross-run learnings the build accumulated.
- `CHANGELOG.md` — any deviations the generator recorded.

Then try the outer loop:

```bash
node ../../bin/sparra.mjs reflect --root .work     # propose prompt improvements from the traces
```

## Want to drive it yourself?

Skip `run.sh` and do the real flow in a fresh directory:

```bash
mkdir tipjar && cd tipjar
sparra init
sparra plan          # the collaborative interview builds PLAN.md with you
sparra freeze
sparra build
```
