#!/usr/bin/env bash
#
# Runnable end-to-end example: watch Sparra build the `TipJar` SwiftUI app from a
# frozen plan, then build/run/exercise it in the iOS Simulator.
#
# This skips the interactive planning interview (which you'd normally do yourself with
# `sparra plan`) by shipping a ready-made PLAN.md, so you can watch Phase C — the
# autonomous generator/evaluator loop — drive a real native UI from start to finish.
#
# Usage:  bash examples/ios-greenfield/run.sh [work-dir]
# Needs:  macOS with Xcode + an iOS Simulator, the `xcodebuildmcp` CLI on PATH, and
#         an Anthropic credential (ANTHROPIC_API_KEY or a Claude Code login).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="${1:-$HERE/.work}"
SPARRA="node $REPO/bin/sparra.mjs"

echo "▶ Preflight"
[ "$(uname)" = "Darwin" ] || { echo "  ✗ iOS builds need macOS."; exit 1; }
command -v xcodebuild >/dev/null 2>&1 || { echo "  ✗ Xcode (xcodebuild) not found."; exit 1; }
if command -v xcodebuildmcp >/dev/null 2>&1; then
  echo "  ✓ xcodebuildmcp present"
else
  echo "  ! xcodebuildmcp not found — install it for the best path:"
  echo "      brew tap getsentry/xcodebuildmcp && brew install xcodebuildmcp"
  echo "    (the evaluator will fall back to raw xcrun/xcodebuild, which is rougher.)"
fi
command -v xcodegen >/dev/null 2>&1 && echo "  ✓ xcodegen present" || echo "  ! xcodegen not found — install with: brew install xcodegen (the plan generates the project with it)"

echo "▶ Setting up a fresh greenfield project in: $WORK"
rm -rf "$WORK"
mkdir -p "$WORK"
cp "$HERE/PLAN.md" "$WORK/PLAN.md"

echo "▶ sparra init (detects greenfield)"
$SPARRA init --root "$WORK"

# Drop in the tuned iOS example config.
cp "$HERE/config.yaml" "$WORK/.sparra/config.yaml"

echo "▶ sparra freeze (lock the shipped PLAN.md as build input)"
$SPARRA freeze --root "$WORK"

echo "▶ sparra build (autonomous: contract → generate Swift → build+run in sim → screenshot+grade)"
$SPARRA build --root "$WORK"

echo
echo "▶ Done. The evaluator already built, launched, and exercised TipJar in the simulator"
echo "  during the build loop. To open it yourself:"
echo "     open -a Simulator"
echo "     (find the .xcodeproj/.xcworkspace under $WORK and build-and-run it)"
echo
echo "▶ Artifacts to inspect:"
echo "   contract : $WORK/.sparra/contracts/"
echo "   verdict  : $WORK/.sparra/verdicts/   (screenshots + UI-hierarchy evidence)"
echo "   traces   : $WORK/.sparra/traces/"
echo "   memory   : $WORK/.sparra/memory.md"
echo "   changelog: $WORK/CHANGELOG.md"
echo
echo "▶ Next, try the self-improvement loop:   $SPARRA reflect --root \"$WORK\""
