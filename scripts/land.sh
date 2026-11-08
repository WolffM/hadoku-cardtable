#!/bin/bash
# Land a wave's verified commits on main, from the wave's own worktree, without the tracker.
#
#   scripts/land.sh            # land every commit on this branch that main does not have yet
#   scripts/land.sh --dry-run  # everything but the push
#
# Lanes share the manager's worktree and leave uncommitted files in it while another lane
# lands, so this never rebases the wave branch. It builds a throwaway worktree on the latest
# origin/main, cherry-picks the commits main lacks (by patch id, so a second land skips what
# the first one already pushed), numbers any `| AF??? |` ledger rows they add (re-adding them
# on main's ledger when the ledger is a commit's only conflict), derives the art rows for any
# card they add, runs typecheck, lint and the unit suites the change reaches (by import, or by
# an `@reads` declaration), and pushes with an explicit refspec. It edits no version: a build's
# version is derived from the tree (scripts/release/build-version.ts).
#
# The check runs OUTSIDE the lock, against the main it fetched. The lock is taken only to
# re-apply the commits on the main of that moment, number their ledger rows, and push, so one
# land's 4–40 minute check no longer queues every other land behind it (w92-carry: D waited
# 77 min for the lock, then held it 40 min for a check that failed on host load). Under the
# lock: if main has not moved, the checked tree is pushed as is; if it moved, typecheck and the
# suites this change reaches run again on the new main (never the whole suite); if main's own
# move changed dependencies, or the re-apply conflicts, the lock is let go and the land starts
# over on that main, up to 3 times. Ledger numbers are taken under the lock only, so two lands
# still never number the same row.
#
# It does NOT wait for CI (memory: never wait inside a lock). CI is the combined gate: a red
# run on the pushed sha belongs to the wave that pushed it.
set -euo pipefail

DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
MAIN=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
LOCK=/tmp/claude-1000/land.lock
NODE_BIN=$HOME/.local/share/fnm/node-versions/v24.18.0/installation/bin
LEDGER=docs/planning/playtest-ledger.md
ART_IDS=apps/server/src/play/art-ids.json

SRC=$(git rev-parse --show-toplevel)
BRANCH=$(git -C "$SRC" rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = main ] && { echo "land: run this from a wave branch, not main" >&2; exit 2; }
[ "$SRC" = "$MAIN" ] && { echo "land: never from the main checkout (every worktree hangs off it)" >&2; exit 2; }

mkdir -p "$(dirname "$LOCK")"
exec 9>"$LOCK"

# The commits main lacks, against whatever origin/main is now.
find_picks() {
  mapfile -t PICKS < <(git -C "$SRC" cherry origin/main HEAD | sed -n 's/^+ //p')
  # Merge commits cannot be cherry-picked and carry nothing of their own here.
  mapfile -t PICKS < <(for c in "${PICKS[@]}"; do [ "$(git -C "$SRC" rev-list --parents -n1 "$c" | wc -w)" = 2 ] && echo "$c"; done)
  # A commit this script amended (ledger numbering, below) no longer shares its patch id with
  # main's copy, but that copy's -x trailer still names it.
  [ ${#PICKS[@]} = 0 ] || mapfile -t PICKS < <(printf '%s\n' "${PICKS[@]}" | grep -vxFf <(git -C "$SRC" log -1000 --format=%B origin/main \
    | sed -n 's/^(cherry picked from commit \([0-9a-f]\{40\}\))$/\1/p') || true)
  [ ${#PICKS[@]} = 0 ] && { echo "land: nothing to land — main already has every commit on $BRANCH"; exit 0; }
  echo "land: ${#PICKS[@]} commit(s) from $BRANCH:"; git -C "$SRC" log --oneline --no-walk "${PICKS[@]}"
}
# Ledger rows are numbered here, not in the lane: two lanes that each took "the next AF" on
# their own base collided eight times in a week. A commit may add rows as `| AF??? |`; once it
# is on the latest main, each placeholder becomes the next free number (max + 1, in file
# order), in the file and the commit's message, and the commit is amended. The lock makes the
# numbers final (the picks before the check number too, but those numbers are thrown away and
# taken again under the lock). Explicit ids are left as they are.
#
# Every lane appends its rows at the table's end, so two lanes' ledger edits conflict. When the
# ledger is a pick's only conflict, main's ledger wins and the rows the commit adds go back in
# after main's last AF row as `| AF??? |`, to be numbered like any other; the commit's other
# ledger edits are dropped (only the operator writes ✅). Any other conflict refuses.
# Sets CONFLICT=1 (and stops) when a pick does not apply, rather than returning non-zero:
# a function called as `f || …` runs with `set -e` off, and every other step in it must still stop.
pick_onto() {
  git checkout -q --detach --force "$1"
  CONFLICT=0
  local c max ids
  for c in "${PICKS[@]}"; do
    if ! git cherry-pick -x "$c" >/dev/null 2>"$TMP.pick.log"; then
      if [ "$(git diff --name-only --diff-filter=U)" != "$LEDGER" ]; then
        cat "$TMP.pick.log" >&2; git cherry-pick --abort || true
        CONFLICT=1; return 0
      fi
      git checkout -q HEAD -- "$LEDGER"
      # A `-` row paired with a `+` row is the commit editing a row its branch added earlier, which
      # an earlier pick has already numbered: rewrite that row in place, keeping its number.
      git diff "$c~1" "$c" -- "$LEDGER" > "$TMP.diff"
      perl -e '
        my ($diff, $f, $rows) = @ARGV; open my $d, "<", $diff or die; my (@gone, @new);
        while (<$d>) { push @gone, $1 if /^-\| AF[0-9?]+ \|(.*)$/; push @new, $1 if /^\+\| AF[0-9?]+ \|(.*)$/ }
        open my $in, "<", $f or die; my @l = <$in>; close $in; my @add;
        for my $text (@new) {
          my $old = shift @gone; my $hit;
          if (defined $old) { for (@l) { if (/^(\| AF\d+ \|)\Q$old\E$/) { $_ = "$1$text\n"; $hit = 1; last } } }
          push @add, "| AF??? |$text\n" unless $hit;
        }
        my $last; for my $i (0 .. $#l) { $last = $i if $l[$i] =~ /^\| AF\d+ \|/ }
        defined $last or die "land: no AF row in the ledger\n";
        splice @l, $last + 1, 0, @add; open my $out, ">", $f or die; print $out @l; close $out or die;
        open my $r, ">", $rows or die; print $r @add; close $r or die' "$TMP.diff" "$LEDGER" "$TMP.rows"
      git add "$LEDGER"
      if git diff --cached --quiet; then
        git cherry-pick --skip; echo "land: $(git rev-parse --short "$c") only edited ledger rows main has since changed — skipped"; continue
      fi
      GIT_EDITOR=true git cherry-pick --continue >/dev/null
      echo "land: ledger conflict in $(git rev-parse --short "$c") — took main's ledger, re-added $(grep -c . "$TMP.rows") row(s)"
    fi
    grep -q '^| AF??? |' "$LEDGER" 2>/dev/null || continue
    max=$(grep -oE '^\| AF[0-9]+ ' "$LEDGER" | grep -oE '[0-9]+' | sort -n | tail -1)
    ids=$(perl -ne 'BEGIN { $n = shift } print "AF", ++$n, " " if /^\| AF\?\?\? \|/' "${max:-0}" "$LEDGER")
    perl -i -pe 'BEGIN { $n = shift } s/^\| AF\?\?\? \|/sprintf("| AF%d |", ++$n)/e' "${max:-0}" "$LEDGER"
    git log -1 --format=%B | perl -pe 'BEGIN { @ids = split " ", shift } s{AF\?\?\?}{shift(@ids) // $&}ge' "$ids" > "$TMP.msg"
    git commit -q --amend -F "$TMP.msg" -- "$LEDGER"
    echo "land: ledger ${ids% }"
  done
}

# Run in $TMP after the picks: dependencies, then art rows (committed on top when they change).
prepare() {

  # The lockfile must agree with every package.json before anything else runs. The link below
  # borrows a deploy tree's node_modules whenever the two lockfiles match, so a land that edits a
  # package.json and not the lockfile passed every local step and failed CI's frozen install
  # (ERR_PNPM_OUTDATED_LOCKFILE). `--lockfile-only` reads the manifests and the lockfile and
  # needs no node_modules, so it runs here, before the link.
  PATH="$NODE_BIN:$PATH" pnpm install --frozen-lockfile --lockfile-only > "$TMP.lockfile.log" 2>&1 \
    || { tail -20 "$TMP.lockfile.log"
         echo "land: pnpm-lock.yaml is out of date with a package.json — nothing pushed (log $TMP.lockfile.log)" >&2; exit 5; }

  # Dependencies first: the art step below runs code that imports them. Linking borrows a
  # deploy tree's node_modules, which match that tree's lockfile, not this one. When the
  # two lockfiles differ (an auto-update landed since the last deploy, or the
  # land itself changes dependencies), a linked check typechecks against the wrong versions, so
  # install for real instead. The temp worktree has no node_modules of its own, so nothing here
  # writes through a symlink into the deploy tree. The link script names that tree: $MAIN is the
  # git common dir's checkout, which nothing has pulled since 2026-10-22.
  DEPS=$(bash scripts/link-worktree-node-modules.sh --source)
  if cmp -s "$DEPS/pnpm-lock.yaml" pnpm-lock.yaml; then
    bash scripts/link-worktree-node-modules.sh "$TMP"
  else
    echo "land: lockfile differs from $DEPS's — pnpm install --frozen-lockfile"
    PATH="$NODE_BIN:$PATH" pnpm install --frozen-lockfile --prefer-offline > "$TMP.install.log" 2>&1 \
      || { tail -20 "$TMP.install.log"
           echo "land: install FAILED — nothing pushed" >&2; exit 5; }
  fi

  # The art table's rows are derived data: every card a scenario places or a deck lists gets one.
  # Derive them here, from the shared Scryfall cache (docs/WAVE_WORKTREE.md; it lived in the main checkout
  # until production moved to /home/hadoku/srv on 2026-10-22), so a new scenario's cards land with
  # their rows instead of reddening the coverage suite on main. `--no-tokens`: only the rows this
  # land's cards need, never the token rows a whole rebuild would bring. A no-op (3 s) otherwise.
  ART_CACHE="${CARDTABLE_SCRYFALL_DIR:-$HOME/.local/share/cardtable/scryfall}"
  if [ -f "$ART_CACHE/cards.jsonl" ]; then
    PATH="$NODE_BIN:$PATH" node --max-old-space-size=6144 scripts/art/build-art-ids.ts --no-tokens --cache="$ART_CACHE" > "$TMP.art.log" 2>&1 \
      || { tail -20 "$TMP.art.log"; echo "land: art rows FAILED — nothing pushed (log $TMP.art.log)" >&2; exit 5; }
    if ! git diff --quiet -- "$ART_IDS"; then
      git commit -qm "art: rows for the cards this land's scenarios and decks place" -- "$ART_IDS"
      echo "land: art rows — $(grep -oE 'added [0-9]+ new' "$TMP.art.log")"
    fi
  else
    echo "land: no Scryfall cache at $ART_CACHE — art rows not derived; the coverage suite still runs"
  fi
}

# Which unit suites the change reaches. Typecheck and lint run whole; the unit suites run only
# where the change reaches (`vitest related`: the test files whose import graph holds a changed
# file) — CI's `check` on the pushed commit runs every suite anyway. Whole when the change is to
# what every suite runs on: `scripts/ci/run-all.txt`'s config and dependencies, a package, the
# test setup.
#
# A deleted module no longer forces the whole suite. `related` cannot follow a file that is
# gone, but typecheck fails every importer still naming it (TS2307), and what typecheck cannot
# see — a suite that names the path in a string (`vi.mock('../sound/mixer.ts')`, a fixture
# path) — is found by name below and runs. A refactor that deletes a stub used to hold the
# lock for the whole 13k-test suite (w92-carry D and Z).
select_tests() {
  TESTS="pnpm run test"
  grep -qE -e '^(packages/|apps/ui/src/test-setup\.ts$)' -f <(grep -v '^#' scripts/ci/run-all.txt) <<<"$CHANGED" && return 0
  local hit pat pats f name stem
  mapfile -t RELATED < <(grep -E '\.(tsx?|css|json)$' <<<"$CHANGED" | while read -r f; do [ -f "$f" ] && echo "$f"; done)
  # Suites that name a deleted module by path: its stem as a whole last path segment, with or
  # without an extension (`'./mixer'`, `"../sound/mixer.ts"`).
  while IFS= read -r f; do
    [ -f "$f" ] && continue
    stem=$(basename "$f" | sed -E 's/\.tsx?$//; s/[.[\*^$]/\\&/g')
    mapfile -t -O "${#RELATED[@]}" RELATED < <(git grep -lE "[\"'\`/]${stem}(\.tsx?)?[\"'\`]" -- '*.test.ts' '*.test.tsx' || true)
  done < <(grep -E '\.tsx?$' <<<"$CHANGED" || true)
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
  # A suite that reads a file by name (`readFileSync(resolve(dir, 'board.css'))`) runs when that
  # file changes, with or without an `@reads` line: a1b97799 changed board.css and reddened
  # zone-box.test.ts, which names it and never imports it. Only non-code files, whose readers
  # `related` cannot see; the name must stand as a whole string or its last path segment. Not
  # markdown: a `README.md` is named by fixtures all over, and no suite reads prose by name.
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    name=$(basename "$f" | sed 's/[.[\*^$]/\\&/g')
    mapfile -t -O "${#RELATED[@]}" RELATED < <(git grep -lE "[\"'\`/]${name}[\"'\`]" -- '*.test.ts' '*.test.tsx' || true)
  done < <(grep -vE '\.(tsx?|md)$' <<<"$CHANGED" || true)
  if [ ${#RELATED[@]} = 0 ]; then
    TESTS="echo 'land: no source file changed — no unit suite to run'"
  else
    TESTS="pnpm exec vitest related --run --passWithNoTests ${RELATED[*]}"
  fi
}

# $1: what to run after typecheck. No jar env: with it, check runs every jvm suite (memory:
# check-with-jar-env-runs-all-jvm). CI=1: the same check CI gates a deploy on — its timeouts and
# its 4-worker cap. This host runs production and every lane at once; the local 5 s/1 s budgets
# measured its load instead. NO_COLOR: CI=1 turns vitest's colour on, and the Tests-line grep
# below must read plain text.
run_check() {
  echo "land: typecheck, $1 $(date -u +%T)"
  if ! env -u CARDTABLE_FORGE_JAR -u CARDTABLE_FORGE_RES CI=1 NO_COLOR=1 PATH="$NODE_BIN:$PATH" \
    bash -c "pnpm run typecheck && $1" > "$TMP.check.log" 2>&1; then
    tail -40 "$TMP.check.log"; echo "land: check FAILED — nothing pushed (log $TMP.check.log)" >&2; exit 5
  fi
  { grep -E 'Tests +[0-9]' "$TMP.check.log" || true; } | tail -1
}

TMP=$(mktemp -d /tmp/claude-1000/land-XXXXXX)
# shellcheck disable=SC2317 # run by the EXIT trap
cleanup() { git -C "$MAIN" worktree remove --force "$TMP" 2>/dev/null || rm -rf "$TMP"; }
trap cleanup EXIT
git -C "$SRC" fetch -q origin main
git -C "$MAIN" worktree add -q --detach "$TMP" origin/main
cd "$TMP"

for attempt in 1 2 3; do
  # ── Before the lock: apply, prepare and check on the main fetched now. ──
  git fetch -q origin main
  BASE=$(git rev-parse origin/main)
  find_picks
  pick_onto "$BASE"
  if [ $CONFLICT = 1 ]; then
    echo "land: a commit does not apply on the latest main — merge origin/main into $BRANCH, resolve, and land again" >&2
    exit 4
  fi
  # prepare commits the art rows on top only when they change; that commit is replayed under the lock.
  PRE=$(git rev-parse HEAD); ART=
  prepare
  [ "$(git rev-parse HEAD)" = "$PRE" ] || ART=$(git rev-parse HEAD)
  CHANGED=$(git diff --name-only "$BASE"..HEAD)
  select_tests
  run_check "pnpm run lint && $TESTS"

  # ── Under the lock: re-apply on main as it is now, number the ledger, push. ──
  echo "land: waiting for $LOCK"
  flock -w 3600 9 || { echo "land: lock not acquired in 60 min" >&2; exit 3; }
  HELD=$(date +%s); echo "land: lock held $(date -u +%T)"
  git fetch -q origin main
  NOW=$(git rev-parse origin/main)
  if [ "$NOW" != "$BASE" ] && git diff --name-only "$BASE" "$NOW" | grep -qE '(^|/)(package\.json|pnpm-lock\.yaml)$'; then
    echo "land: main changed dependencies since the check — checking again on $(git rev-parse --short "$NOW")"
    flock -u 9; continue
  fi
  pick_onto "$NOW"
  [ -z "$ART" ] || git cherry-pick -q "$ART" >/dev/null 2>&1 || { git cherry-pick --abort || true; CONFLICT=1; }
  if [ $CONFLICT = 1 ]; then
    echo "land: main moved under the check and a commit no longer applies — checking again"
    flock -u 9; continue
  fi
  if [ "$NOW" != "$BASE" ]; then
    # Main moved: what it added meets this change through types and through the suites that
    # import this change, so those run again — on the new tree, inside the lock, never whole.
    echo "land: main moved $(git rev-list --count "$BASE".."$NOW") commit(s) since the check"
    mapfile -t MINE < <(git diff --name-only "$NOW"..HEAD | grep -E '\.(tsx?|css|json)$' | while read -r f; do [ -f "$f" ] && echo "$f"; done || true)
    if [ ${#MINE[@]} = 0 ]; then run_check "true"
    else run_check "pnpm exec vitest related --run --passWithNoTests ${MINE[*]}"; fi
  fi

  if [ $DRY = 1 ]; then echo "land: dry run — would push $(git rev-parse --short HEAD)"; exit 0; fi
  # The auto-update bot can still move main without the lock. Its commits touch only
  # @wolffm/* dependency pins, so rebase over them; anything else means start over.
  for _ in 1 2 3; do
    if git push -q origin HEAD:main; then
      echo "land: pushed $(git rev-parse HEAD) to main $(date -u +%T) (lock held $(( $(date +%s) - HELD )) s)"
      echo "land: CI — gh run list -R WolffM/hadoku-cardtable --workflow CI --commit $(git rev-parse HEAD)"
      exit 0
    fi
    git fetch -q origin main
    if git log --format=%s HEAD..origin/main | grep -v '^chore: auto-update @wolffm/' >/dev/null; then
      echo "land: main moved with a non-bot commit — checking again"
      flock -u 9; continue 2
    fi
    git rebase -q origin/main
  done
  echo "land: push rejected 3 times" >&2; exit 7
done
echo "land: main moved under 3 checks in a row — nothing pushed; run land again" >&2; exit 6
