#!/usr/bin/env bash
#
# Runnable end-to-end example: watch Sparra build the `eh` CLI from a frozen plan.
#
# This skips the interactive planning interview (which you'd normally do yourself with
# `sparra plan`) by shipping a ready-made PLAN.md, so you can watch Phase C — the
# autonomous generator/evaluator loop — from start to finish.
#
# Usage:  bash examples/cli-greenfield/run.sh [work-dir]
# Needs:  an Anthropic credential (ANTHROPIC_API_KEY or a Claude Code login).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="${1:-$HERE/.work}"
SPARRA="node $REPO/bin/sparra.mjs"

echo "▶ Setting up a fresh greenfield project in: $WORK"
rm -rf "$WORK"
mkdir -p "$WORK"
cp "$HERE/PLAN.md" "$WORK/PLAN.md"

echo "▶ sparra init (detects greenfield)"
$SPARRA init --root "$WORK"

# Drop in the tuned example config.
cp "$HERE/config.yaml" "$WORK/.sparra/config.yaml"

echo "▶ sparra freeze (lock the shipped PLAN.md as build input)"
$SPARRA freeze --root "$WORK"

echo "▶ sparra build (autonomous: contract → generate → exercise → grade)"
$SPARRA build --root "$WORK"

echo
echo "▶ Done. Exercising the built CLI:"
for args in "add 2 3" "sub 10 4" "mul 4 5" "div 20 5"; do
  printf '   node eh.js %-10s → ' "$args"
  node "$WORK/eh.js" $args || true
done
echo "   node eh.js div 10 0  → (expect error + nonzero exit)"
node "$WORK/eh.js" div 10 0 || echo "   exit code: $?"

echo
echo "▶ Artifacts to inspect:"
echo "   contract : $WORK/.sparra/contracts/"
echo "   verdict  : $WORK/.sparra/verdicts/"
echo "   traces   : $WORK/.sparra/traces/"
echo "   changelog: $WORK/CHANGELOG.md"
echo
echo "▶ Next, try the self-improvement loop:   $SPARRA reflect --root \"$WORK\""
