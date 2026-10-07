#!/bin/bash
# Link the main checkout's node_modules into a worktree, @hadoku/* pointing at the worktree's own packages.
set -euo pipefail
MAIN=/home/hadoku/repos/hadoku-cardtable; WT=$(realpath "$1")   # absolute: the @hadoku links are built from it, and a relative one dangles
for nm in $(cd $MAIN && find . -maxdepth 3 -name node_modules -not -path './node_modules/*' -not -path './forge/*' -not -path './.claude/*'); do
  mkdir -p "$WT/$nm"
  for e in $(ls -A "$MAIN/$nm"); do
    [ -e "$WT/$nm/$e" ] || [ -L "$WT/$nm/$e" ] && continue
    if [ "$e" = "@hadoku" ]; then
      mkdir -p "$WT/$nm/@hadoku"
      for p in $(ls -A "$MAIN/$nm/@hadoku"); do
        tgt=$(readlink -f "$MAIN/$nm/@hadoku/$p"); rel=${tgt#$MAIN/}
        ln -s "$WT/$rel" "$WT/$nm/@hadoku/$p"
      done
    else ln -s "$MAIN/$nm/$e" "$WT/$nm/$e"; fi
  done
done
