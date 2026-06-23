#!/usr/bin/env bash
#
# Set up Sparra to run on ITSELF (self-improvement).
#
# Initializes Sparra in this repo (detected as an existing project), drops in the
# self-host config + a scoped PLAN.md, and stops before the build so you can review
# and decide. The build runs in an isolated git worktree and never commits to your
# branch. The runtime artifacts (.sparra/, PLAN.md, CODEBASE_MAP.md, CHANGELOG.md)
# are gitignored in this repo.
#
# Usage:  bash selfhost/setup.sh

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
SPARRA="node $REPO/bin/sparra.mjs"

cd "$REPO"

echo "▶ sparra init (should detect this repo as 'existing')"
$SPARRA init

echo "▶ installing self-host config + scoped PLAN.md"
cp "$HERE/config.yaml" "$REPO/.sparra/config.yaml"
cp "$HERE/PLAN.md" "$REPO/PLAN.md"

cat <<'NEXT'

▶ Set up. Recommended next steps (you stay in control):

   sparra orient     # map the codebase → CODEBASE_MAP.md (helps the build conform)
   sparra plan       # OPTIONAL: refine PLAN.md with the interview, or edit it directly
   sparra freeze     # lock the plan as build input (your call)
   sparra build      # autonomous: builds in a sibling git worktree (../Sparra-build-*)

After the build, review the worktree/branch and merge what you want yourself.
Clean up a worktree with:  git worktree remove ../Sparra-build-<id>
Improve the agents' own prompts from the run:  sparra reflect

NEXT
