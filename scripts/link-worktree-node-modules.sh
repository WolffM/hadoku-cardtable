#!/bin/bash
# Link the deploy tree's node_modules into a worktree, @hadoku/* pointing at the worktree's own packages.
#
#   scripts/link-worktree-node-modules.sh <absolute worktree path>
#   scripts/link-worktree-node-modules.sh --source   # print the tree it links from
#
# The source is the deploy tree ($CARDTABLE_DEPLOY_TREE, default ~/srv/hadoku-cardtable), whose
# node_modules match main's lockfile as of the last deploy. The git common dir's checkout
# (~/repos/hadoku-cardtable) stopped being pulled on 2026-10-22 and its dependencies lag, so it
# is only the fallback on a host with no deploy tree. Re-running repoints every link, so a
# worktree linked from the old source catches up. Vite's caches stay per-worktree directories:
# linked, a worktree's dev server would write into production's.
set -euo pipefail
DEPLOY=${CARDTABLE_DEPLOY_TREE:-$HOME/srv/hadoku-cardtable}
if [ -d "$DEPLOY/node_modules" ]; then MAIN=$(realpath "$DEPLOY")
else MAIN=$(dirname "$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)"); fi
[ "${1:-}" = --source ] && { echo "$MAIN"; exit 0; }
WT=$(realpath "$1")   # absolute: the @hadoku links are built from it, and a relative one dangles
# A real install's own links live under the same names; repointing them would break it quietly.
[ -d "$WT/node_modules/.pnpm" ] && [ ! -L "$WT/node_modules/.pnpm" ] && { echo "link: $WT has its own pnpm install — not linking" >&2; exit 2; }
for nm in $(cd $MAIN && find . -maxdepth 3 -name node_modules -not -path './node_modules/*' -not -path './forge/*' -not -path './.claude/*'); do
  [ -d "$WT/$nm" ] && find "$WT/$nm" -maxdepth 2 -type l -delete
  mkdir -p "$WT/$nm"
  for e in $(ls -A "$MAIN/$nm"); do
    case "$e" in .vite|.vite-temp) mkdir -p "$WT/$nm/$e"; continue;; esac
    if [ "$e" = "@hadoku" ]; then
      mkdir -p "$WT/$nm/@hadoku"
      for p in $(ls -A "$MAIN/$nm/@hadoku"); do
        tgt=$(readlink -f "$MAIN/$nm/@hadoku/$p"); rel=${tgt#$MAIN/}
        [ -e "$WT/$nm/@hadoku/$p" ] || ln -s "$WT/$rel" "$WT/$nm/@hadoku/$p"
      done
    elif [ ! -e "$WT/$nm/$e" ]; then ln -s "$MAIN/$nm/$e" "$WT/$nm/$e"; fi
  done
done
