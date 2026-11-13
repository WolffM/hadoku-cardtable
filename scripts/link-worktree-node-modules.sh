#!/bin/bash
# Link a deploy tree's node_modules into a worktree, @hadoku/* pointing at the worktree's own packages.
#
#   scripts/link-worktree-node-modules.sh <absolute worktree path>
#   scripts/link-worktree-node-modules.sh --source   # print the tree it links from
#
# The source is the first of $CARDTABLE_DEPLOY_TREE, the PPE tree and the prod tree that has
# node_modules. PPE deploys every green main, so its dependencies match main's lockfile; prod
# follows releases and lags main's auto-updates. The git common dir's checkout
# (~/repos/hadoku-cardtable) stopped being pulled on 2026-10-22 and its dependencies lag, so it
# is only the fallback on a host with neither. Re-running repoints every link, so a worktree
# linked from an older source catches up. Vite's caches stay per-worktree directories:
# linked, a worktree's dev server would write into a live server's tree.
set -euo pipefail
MAIN=$(dirname "$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)")
for t in ${CARDTABLE_DEPLOY_TREE:-} $HOME/srv/hadoku-cardtable-ppe $HOME/srv/hadoku-cardtable; do
  [ -d "$t/node_modules" ] && { MAIN=$(realpath "$t"); break; }
done
[ "${1:-}" = --source ] && { echo "$MAIN"; exit 0; }
WT=$(realpath "$1")   # absolute: the @hadoku links are built from it, and a relative one dangles
# A real install's own links live under the same names; repointing them would break it quietly.
[ -d "$WT/node_modules/.pnpm" ] && [ ! -L "$WT/node_modules/.pnpm" ] && { echo "link: $WT has its own pnpm install — not linking" >&2; exit 2; }
# Where each workspace package lives, by name: `apps/*`, `packages/*`, `games/*/packages/*` or a game's `games/*/server`. The source and the
# worktree may differ in layout (a package moved since the source last deployed), so every link is placed
# by the package's name, never by the source's path.
declare -A SRC_DIR WT_DIR
index() {   # index <root> <assoc name>
  local -n into=$2; local m d
  for m in "$1"/package.json "$1"/{apps,packages,games/*/packages}/*/package.json "$1"/games/*/server/package.json "$1"/e2e/package.json; do
    [ -f "$m" ] || continue; d=$(dirname "$m"); d=${d#"$1"}; d=${d#/}
    into[$(node -p "require(process.argv[1]).name" "$m")]=${d:-.}
  done
}
index "$MAIN" SRC_DIR; index "$WT" WT_DIR
for name in "${!SRC_DIR[@]}"; do
  src="$MAIN/${SRC_DIR[$name]}/node_modules"; [ -d "$src" ] || continue
  [ -n "${WT_DIR[$name]:-}" ] || continue
  dst="$WT/${WT_DIR[$name]}/node_modules"
  [ -d "$dst" ] && find "$dst" -maxdepth 2 -type l -delete
  mkdir -p "$dst"
  for e in $(ls -A "$src"); do
    case "$e" in .vite|.vite-temp) mkdir -p "$dst/$e"; continue;; esac
    if [ "$e" = "@hadoku" ]; then
      mkdir -p "$dst/@hadoku"
      for p in $(ls -A "$src/@hadoku"); do
        own=${WT_DIR[@hadoku/$p]:-}
        [ -n "$own" ] && tgt="$WT/$own" || tgt=$(readlink -f "$src/@hadoku/$p")
        [ -e "$dst/@hadoku/$p" ] || ln -s "$tgt" "$dst/@hadoku/$p"
      done
    elif [ ! -e "$dst/$e" ]; then ln -s "$src/$e" "$dst/$e"; fi
  done
done
# What the source has not deployed yet: a package new in this worktree, or a dependency a package
# gained here. Each missing dependency is linked by name: a workspace package at the worktree's own,
# anything else wherever one of the source's packages has it.
for name in "${!WT_DIR[@]}"; do
  dst="$WT/${WT_DIR[$name]}/node_modules"
  for dep in $(node -p "const j=require(process.argv[1]); Object.keys({...j.dependencies, ...j.devDependencies}).join(' ')" "$WT/${WT_DIR[$name]}/package.json"); do
    [ -e "$dst/$dep" ] && continue
    tgt=""
    if [ -n "${WT_DIR[$dep]:-}" ]; then tgt="$WT/${WT_DIR[$dep]}"
    else for d in "${SRC_DIR[@]}"; do [ -e "$MAIN/$d/node_modules/$dep" ] && { tgt=$(readlink -f "$MAIN/$d/node_modules/$dep"); break; }; done
    fi
    [ -n "$tgt" ] || { echo "link: no source for $dep (${WT_DIR[$name]})" >&2; continue; }
    mkdir -p "$(dirname "$dst/$dep")"; ln -s "$tgt" "$dst/$dep"
  done
done
