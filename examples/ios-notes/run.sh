#!/usr/bin/env bash
#
# Runnable end-to-end example: watch Sparra build `Jotter`, a SwiftData notes app,
# from a frozen plan, then build/run/exercise it in the iOS Simulator.
#
# A step up from the TipJar example: this exercises CRUD, persistence, and a
# relaunch check (does the note survive?), not just pure computation.
#
# Usage:  bash examples/ios-notes/run.sh [work-dir]
# Needs:  macOS + Xcode + an iOS Simulator, the `xcodebuildmcp` and `xcodegen` CLIs,
#         and an Anthropic credential (ANTHROPIC_API_KEY or a Claude Code login).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="${1:-$HERE/.work}"
SPARRA="node $REPO/bin/sparra.mjs"

echo "▶ Preflight"
[ "$(uname)" = "Darwin" ] || { echo "  ✗ iOS builds need macOS."; exit 1; }
command -v xcodebuild >/dev/null 2>&1 || { echo "  ✗ Xcode (xcodebuild) not found."; exit 1; }
command -v xcodebuildmcp >/dev/null 2>&1 && echo "  ✓ xcodebuildmcp present" || echo "  ! xcodebuildmcp not found — install: brew tap getsentry/xcodebuildmcp && brew install xcodebuildmcp"
command -v xcodegen >/dev/null 2>&1 && echo "  ✓ xcodegen present" || echo "  ! xcodegen not found — install: brew install xcodegen"

echo "▶ Setting up a fresh greenfield project in: $WORK"
rm -rf "$WORK"
mkdir -p "$WORK"
cp "$HERE/PLAN.md" "$WORK/PLAN.md"

echo "▶ sparra init (detects greenfield)"
$SPARRA init --root "$WORK"
cp "$HERE/config.yaml" "$WORK/.sparra/config.yaml"

echo "▶ sparra freeze (lock the shipped PLAN.md as build input)"
$SPARRA freeze --root "$WORK"

echo "▶ sparra build (autonomous: contract → generate SwiftData app → build+run → drive+grade)"
$SPARRA build --root "$WORK"

echo
echo "▶ Done. The evaluator built, launched, and exercised Jotter in the simulator"
echo "  (incl. a relaunch check that notes persist) during the build loop."
echo
echo "▶ Artifacts to inspect:"
echo "   contract : $WORK/.sparra/contracts/"
echo "   verdict  : $WORK/.sparra/verdicts/   (screenshots + UI-hierarchy evidence)"
echo "   traces   : $WORK/.sparra/traces/"
echo "   memory   : $WORK/.sparra/memory.md"
echo
echo "▶ Next, try the self-improvement loop:   $SPARRA reflect --root \"$WORK\""
