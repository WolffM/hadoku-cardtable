#!/bin/bash
# Land a wave's verified commits on main, from the wave's own worktree, without the tracker.
#
#   scripts/land.sh            # land every commit on this branch that main does not have yet
#   scripts/land.sh --dry-run  # everything but the push
#
# Lanes share the manager's worktree and leave uncommitted files in it while another lane
# lands, so this never rebases the wave branch. It builds a throwaway worktree on the latest
# origin/main, cherry-picks the commits main lacks (by patch id, so a second land skips what
# the first one already pushed), bumps the app versions the commits touched, runs
# `pnpm run check`, and pushes with an explicit refspec. One land at a time: the lock is
# held from fetch to push, so two waves never bump the same version.
#
# It does NOT wait for CI (memory: never wait inside a lock). CI is the combined gate: a red
# run on the pushed sha belongs to the wave that pushed it.
set -euo pipefail

DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
MAIN=/home/hadoku/repos/hadoku-cardtable
LOCK=/tmp/claude-1000/land.lock
NODE_BIN=/home/hadoku/.local/share/fnm/node-versions/v24.18.0/installation/bin

SRC=$(git rev-parse --show-toplevel)
BRANCH=$(git -C "$SRC" rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = main ] && { echo "land: run this from a wave branch, not main" >&2; exit 2; }
[ "$SRC" = "$MAIN" ] && { echo "land: never from the main checkout (it is the deploy tree)" >&2; exit 2; }

mkdir -p "$(dirname "$LOCK")"
exec 9>"$LOCK"
echo "land: waiting for $LOCK"
flock -w 3600 9 || { echo "land: lock not acquired in 60 min" >&2; exit 3; }
echo "land: lock held $(date -u +%T)"

git -C "$SRC" fetch -q origin main
mapfile -t PICKS < <(git -C "$SRC" cherry origin/main HEAD | sed -n 's/^+ //p')
# Merge commits cannot be cherry-picked and carry nothing of their own here.
mapfile -t PICKS < <(for c in "${PICKS[@]}"; do [ "$(git -C "$SRC" rev-list --parents -n1 "$c" | wc -w)" = 2 ] && echo "$c"; done)
[ ${#PICKS[@]} = 0 ] && { echo "land: nothing to land — main already has every commit on $BRANCH"; exit 0; }
echo "land: ${#PICKS[@]} commit(s) from $BRANCH:"; git -C "$SRC" log --oneline --no-walk "${PICKS[@]}"

TMP=$(mktemp -d /tmp/claude-1000/land-XXXXXX)
cleanup() { git -C "$MAIN" worktree remove --force "$TMP" 2>/dev/null || rm -rf "$TMP"; }
trap cleanup EXIT
git -C "$MAIN" worktree add -q --detach "$TMP" origin/main
cd "$TMP"
if ! git cherry-pick -x "${PICKS[@]}" >/dev/null; then
  git cherry-pick --abort || true
  echo "land: a commit does not apply on the latest main — merge origin/main into $BRANCH, resolve, and land again" >&2
  exit 4
fi

# Bump each app whose code (or a package it builds from) changed; docs-only lands bump nothing.
CHANGED=$(git diff --name-only origin/main..HEAD)
bump() {
  local f=$1/package.json v n
  v=$(jq -r .version "$f"); n=$(echo "$v" | awk -F. '{print $1"."$2"."$3+1}')
  jq --arg n "$n" '.version = $n' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  echo "${1#apps/} $n"
}
BUMPS=()
grep -qE '^(apps/ui/|packages/)' <<<"$CHANGED" && BUMPS+=("$(bump apps/ui)")
grep -qE '^(apps/server/|packages/)' <<<"$CHANGED" && BUMPS+=("$(bump apps/server)")
if [ ${#BUMPS[@]} -gt 0 ]; then
  git commit -qam "$(IFS=,; echo "${BUMPS[*]}" | sed 's/,/, /g')"
  echo "land: bumped ${BUMPS[*]}"
fi

bash "$MAIN/scripts/link-worktree-node-modules.sh" "$TMP"
echo "land: pnpm run check $(date -u +%T)"
# No jar env: with it, check runs every jvm suite (memory: check-with-jar-env-runs-all-jvm).
if ! env -u CARDTABLE_FORGE_JAR -u CARDTABLE_FORGE_RES PATH="$NODE_BIN:$PATH" pnpm run check > "$TMP.check.log" 2>&1; then
  tail -40 "$TMP.check.log"; echo "land: check FAILED — nothing pushed (log $TMP.check.log)" >&2; exit 5
fi
grep -E 'Tests +[0-9]' "$TMP.check.log" | tail -1

if [ $DRY = 1 ]; then echo "land: dry run — would push $(git rev-parse --short HEAD)"; exit 0; fi
# The lock keeps other waves out, but the auto-update bot can still move main. Its commits
# touch only @wolffm/* dependency pins, so rebase over them; anything else means start over.
for try in 1 2 3; do
  if git push -q origin HEAD:main; then
    echo "land: pushed $(git rev-parse HEAD) to main $(date -u +%T)"
    echo "land: CI — gh run list -R WolffM/hadoku-cardtable --workflow CI --commit $(git rev-parse HEAD)"
    exit 0
  fi
  git fetch -q origin main
  if git log --format=%s HEAD..origin/main | grep -qv '^chore: auto-update @wolffm/'; then
    echo "land: main moved with a non-bot commit — run land again" >&2; exit 6
  fi
  git rebase -q origin/main
done
echo "land: push rejected 3 times" >&2; exit 7
