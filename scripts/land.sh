#!/bin/bash
# Land a wave's verified commits on main, from the wave's own worktree, without the tracker.
#
#   scripts/land.sh            # land every commit on this branch that main does not have yet
#   scripts/land.sh --dry-run  # everything but the push
#
# Lanes share the manager's worktree and leave uncommitted files in it while another lane
# lands, so this never rebases the wave branch. It builds a throwaway worktree on the latest
# origin/main, cherry-picks the commits main lacks (by patch id, so a second land skips what
# the first one already pushed), derives the art rows for any card they add, bumps the app
# versions the commits touched, runs typecheck, lint and the unit suites the change reaches
# (by import, or by an `@reads` declaration), and pushes with an explicit refspec. One land
# at a time: the lock is held from fetch to push, so two waves never bump the same version.
#
# It does NOT wait for CI (memory: never wait inside a lock). CI is the combined gate: a red
# run on the pushed sha belongs to the wave that pushed it.
set -euo pipefail

DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
MAIN=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
LOCK=/tmp/claude-1000/land.lock
NODE_BIN=$HOME/.local/share/fnm/node-versions/v24.18.0/installation/bin

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

# Dependencies first: the art step below runs code that imports them. Linking borrows the
# deploy tree's node_modules, which match the deploy tree's lockfile, not this one. When the
# two lockfiles differ (an auto-update landed since the last deploy, or the
# land itself changes dependencies), a linked check typechecks against the wrong versions, so
# install for real instead. The temp worktree has no node_modules of its own, so nothing here
# writes through a symlink into the deploy tree.
if cmp -s "$MAIN/pnpm-lock.yaml" pnpm-lock.yaml; then
  bash "$MAIN/scripts/link-worktree-node-modules.sh" "$TMP"
else
  echo "land: lockfile differs from the deploy tree's — pnpm install --frozen-lockfile"
  PATH="$NODE_BIN:$PATH" pnpm install --frozen-lockfile --prefer-offline > "$TMP.install.log" 2>&1 \
    || { tail -20 "$TMP.install.log"
         grep -q 'ERR_PNPM_FETCH_401' "$TMP.install.log" \
           && echo "land: GitHub Packages refused ~/.npmrc's token (401) — it needs the current HADOKU_NPM_READ_TOKEN" >&2
         echo "land: install FAILED — nothing pushed" >&2; exit 5; }
fi

# The art table's rows are derived data: every card a scenario places or a deck lists gets one.
# Derive them here, from the deploy tree's Scryfall cache, so a new scenario's cards land with
# their rows instead of reddening the coverage suite on main. `--no-tokens`: only the rows this
# land's cards need, never the token rows a whole rebuild would bring. A no-op (3 s) otherwise.
ART_CACHE="$MAIN/packages/carddata/data"
if [ -f "$ART_CACHE/cards.jsonl" ]; then
  PATH="$NODE_BIN:$PATH" node --max-old-space-size=6144 scripts/art/build-art-ids.ts --no-tokens --cache="$ART_CACHE" > "$TMP.art.log" 2>&1 \
    || { tail -20 "$TMP.art.log"; echo "land: art rows FAILED — nothing pushed (log $TMP.art.log)" >&2; exit 5; }
  if ! git diff --quiet -- apps/ui/src/draft/art-ids.json; then
    git commit -qm "art: rows for the cards this land's scenarios and decks place" -- apps/ui/src/draft/art-ids.json
    echo "land: art rows — $(grep -oE 'added [0-9]+ new' "$TMP.art.log")"
  fi
else
  echo "land: no Scryfall cache at $ART_CACHE — art rows not derived; the coverage suite still runs"
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

# Typecheck and lint run whole. The unit suites run only where the change reaches
# (`vitest related`: the test files whose import graph holds a changed file) — CI's `check` on
# the pushed commit runs every suite anyway. Whole when the change is to what every suite
# runs on: a package, the vitest/TS config, the dependencies, the test setup — or a deleted
# module, which `related` cannot follow to the suites that still import it.
TESTS="pnpm run test"
GONE=$({ grep -E '\.tsx?$' <<<"$CHANGED" || true; } | while read -r f; do [ -f "$f" ] || echo "$f"; done)
if [ -z "$GONE" ] && ! grep -qE '^(packages/|vitest\.config\.ts$|tsconfig[^/]*\.json$|(apps/[^/]+/)?package\.json$|pnpm-(lock|workspace)\.yaml$|apps/[^/]+/tsconfig[^/]*\.json$|apps/ui/src/test-setup\.ts$)' <<<"$CHANGED"; then
  mapfile -t RELATED < <(grep -E '\.(tsx?|css|json)$' <<<"$CHANGED" | while read -r f; do [ -f "$f" ] && echo "$f"; done)
  # Suites that read the tree from disk, not through an import, are out of `related`'s reach, so
  # they say what they read: a `// @reads <path>…` line (repo paths; `*` spans directories, a
  # trailing `/` is everything under it). A changed path matching one runs the suite.
  while IFS= read -r hit; do
    read -ra pats <<<"${hit#*@reads}"
    for pat in "${pats[@]}"; do
      [[ $pat == */ ]] && pat+='*'
      while IFS= read -r f; do
        # shellcheck disable=SC2053 # the declared path is a pattern on purpose
        [[ $f == $pat ]] && { RELATED+=("${hit%%:*}"); continue 3; }
      done <<<"$CHANGED"
    done
  done < <(git grep -E '^\s*(//|\*)\s*@reads\s' -- '*.test.ts' '*.test.tsx' || true)
  if [ ${#RELATED[@]} = 0 ]; then
    TESTS="echo 'land: no source file changed — no unit suite to run'"
  else
    TESTS="pnpm exec vitest related --run --passWithNoTests ${RELATED[*]}"
  fi
fi
echo "land: typecheck, lint, $TESTS $(date -u +%T)"
# No jar env: with it, check runs every jvm suite (memory: check-with-jar-env-runs-all-jvm).
# CI=1: the same check CI gates a deploy on — its timeouts and its 4-worker cap. This host
# runs production and every lane at once; the local 5 s/1 s budgets measured its load instead.
# NO_COLOR: CI=1 turns vitest's colour on, and the Tests-line grep below must read plain text.
if ! env -u CARDTABLE_FORGE_JAR -u CARDTABLE_FORGE_RES CI=1 NO_COLOR=1 PATH="$NODE_BIN:$PATH" \
  bash -c "pnpm run typecheck && pnpm run lint && $TESTS" > "$TMP.check.log" 2>&1; then
  tail -40 "$TMP.check.log"; echo "land: check FAILED — nothing pushed (log $TMP.check.log)" >&2; exit 5
fi
{ grep -E 'Tests +[0-9]' "$TMP.check.log" || true; } | tail -1

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
