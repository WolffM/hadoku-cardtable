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
# on main's ledger when the ledger is a commit's only conflict), runs the app's hooks (cardtable:
# the art rows for any card they add), runs typecheck, lint and the unit suites the change reaches (by import, or by
# an `@reads` declaration), and pushes with an explicit refspec. It edits no version: a build's
# version is derived from the tree (packages/devkit/src/release/build-version.ts). One land at a time: the
# lock is held from fetch to push, so two waves never number the same ledger row.
#
# What is the app's comes from devkit.config.json: the lock (`land.lock`), Node (`nodeBin`), the
# ledger (`ledger`; none, and nothing is numbered), how dependencies arrive (`land.linkDeps`, else
# a frozen install), which changes run every suite (`land.tests`), the env a check must not see
# (`land.unsetEnv`), the bot commits a push may rebase over (`land.botCommits`), and the app's own
# steps before the check (`land.hooks.beforeCheck`: cardtable's art rows). Each repo path in the
# config runs as the land's own copy, on the latest main with this branch's commits.
#
# It does NOT wait for CI (memory: never wait inside a lock). CI is the combined gate: a red
# run on the pushed sha belongs to the wave that pushed it.
#
# `--dry-run` is the only argument it takes; anything else is refused with exit 2 before anything
# runs, because a misspelt or misplaced `--dry-run` would otherwise be a real land.
set -euo pipefail
DRY=0
case "$#:${1:-}" in 0:) ;; 1:--dry-run) DRY=1 ;; *) echo "usage: land.sh [--dry-run]" >&2; exit 2 ;; esac
# shellcheck source=../lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"; devkit_load

MAIN=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
LOCK=$DK_LAND_LOCK
NODE_BIN=$DK_NODE_BIN
# A config path inside the repo, as a path relative to it: run in the land's worktree, not this one.
rel() { [ -n "$1" ] && printf '%s' "${1#"$DK_ROOT"/}"; }

SRC=$(git rev-parse --show-toplevel)
BRANCH=$(git -C "$SRC" rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = main ] && { echo "land: run this from a wave branch, not main" >&2; exit 2; }
[ "$SRC" = "$MAIN" ] && { echo "land: never from the main checkout (every worktree hangs off it)" >&2; exit 2; }

mkdir -p "$(dirname "$LOCK")"
exec 9>"$LOCK"
echo "land: waiting for $LOCK"
flock -w 3600 9 || { echo "land: lock not acquired in 60 min" >&2; exit 3; }
echo "land: lock held $(date -u +%T)"

git -C "$SRC" fetch -q origin main
mapfile -t PICKS < <(git -C "$SRC" cherry origin/main HEAD | sed -n 's/^+ //p')
# Merge commits cannot be cherry-picked and carry nothing of their own here.
mapfile -t PICKS < <(for c in "${PICKS[@]}"; do [ "$(git -C "$SRC" rev-list --parents -n1 "$c" | wc -w)" = 2 ] && echo "$c"; done)
# A commit this script amended (ledger numbering, below) no longer shares its patch id with
# main's copy, but that copy's -x trailer still names it.
[ ${#PICKS[@]} = 0 ] || mapfile -t PICKS < <(printf '%s\n' "${PICKS[@]}" | grep -vxFf <(git -C "$SRC" log -1000 --format=%B origin/main \
  | sed -n 's/^(cherry picked from commit \([0-9a-f]\{40\}\))$/\1/p') || true)
[ ${#PICKS[@]} = 0 ] && { echo "land: nothing to land — main already has every commit on $BRANCH"; exit 0; }
echo "land: ${#PICKS[@]} commit(s) from $BRANCH:"; git -C "$SRC" log --oneline --no-walk "${PICKS[@]}"

mkdir -p "$DK_SCRATCH_DIR"
TMP=$(mktemp -d "$DK_SCRATCH_DIR/land-XXXXXX")
# shellcheck disable=SC2317 # run by the EXIT trap
cleanup() { git -C "$MAIN" worktree remove --force "$TMP" 2>/dev/null || rm -rf "$TMP"; }
trap cleanup EXIT
git -C "$MAIN" worktree add -q --detach "$TMP" origin/main
cd "$TMP"
# Ledger rows are numbered here, not in the lane: two lanes that each took "the next AF" on
# their own base collided eight times in a week. A commit may add rows as `| AF??? |`; once it
# is on the latest main, each placeholder becomes the next free number (max + 1, in file
# order), in the file and the commit's message, and the commit is amended. The lock makes the
# numbers final. Explicit ids are left as they are.
#
# Every lane appends its rows at the table's end, so two lanes' ledger edits conflict. When the
# ledger is a pick's only conflict, main's ledger wins and the rows the commit adds go back in
# after main's last AF row as `| AF??? |`, to be numbered like any other; the commit's other
# ledger edits are dropped (only the operator writes ✅). Any other conflict refuses.
LEDGER=$(rel "$DK_LEDGER" || true)
for c in "${PICKS[@]}"; do
  if ! git cherry-pick -x "$c" >/dev/null 2>"$TMP.pick.log"; then
    if [ -z "$LEDGER" ] || [ "$(git diff --name-only --diff-filter=U)" != "$LEDGER" ]; then
      cat "$TMP.pick.log" >&2; git cherry-pick --abort || true
      echo "land: a commit does not apply on the latest main — merge origin/main into $BRANCH, resolve, and land again" >&2
      exit 4
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
  [ -n "$LEDGER" ] && grep -q '^| AF??? |' "$LEDGER" 2>/dev/null || continue
  max=$(grep -oE '^\| AF[0-9]+ ' "$LEDGER" | grep -oE '[0-9]+' | sort -n | tail -1)
  ids=$(perl -ne 'BEGIN { $n = shift } print "AF", ++$n, " " if /^\| AF\?\?\? \|/' "${max:-0}" "$LEDGER")
  perl -i -pe 'BEGIN { $n = shift } s/^\| AF\?\?\? \|/sprintf("| AF%d |", ++$n)/e' "${max:-0}" "$LEDGER"
  git log -1 --format=%B | perl -pe 'BEGIN { @ids = split " ", shift } s{AF\?\?\?}{shift(@ids) // $&}ge' "$ids" > "$TMP.msg"
  git commit -q --amend -F "$TMP.msg" -- "$LEDGER"
  echo "land: ledger ${ids% }"
done

# The lockfile must agree with every package.json before anything else runs. The link below
# borrows a deploy tree's node_modules whenever the two lockfiles match, so a land that edits a
# package.json and not the lockfile passed every local step and failed CI's frozen install
# (ERR_PNPM_OUTDATED_LOCKFILE). `--lockfile-only` reads the manifests and the lockfile and
# needs no node_modules, so it runs here, before the link.
PATH="$NODE_BIN:$PATH" pnpm install --frozen-lockfile --lockfile-only > "$TMP.lockfile.log" 2>&1 \
  || { tail -20 "$TMP.lockfile.log"
       echo "land: pnpm-lock.yaml is out of date with a package.json — nothing pushed (log $TMP.lockfile.log)" >&2; exit 5; }

# Dependencies first: the hooks below run code that imports them. With a `land.linkDeps` script,
# linking borrows a deploy tree's node_modules, which match that tree's lockfile, not this one.
# When the two lockfiles differ (an auto-update landed since the last deploy, or the
# land itself changes dependencies), a linked check typechecks against the wrong versions, so
# install for real instead. The temp worktree has no node_modules of its own, so nothing here
# writes through a symlink into the deploy tree. The link script names that tree (`--source`):
# $MAIN is the git common dir's checkout, which may lag. With no link script, always install.
LINK=$(rel "$DK_LINK_DEPS" || true)
DEPS=''; [ -z "$LINK" ] || DEPS=$(bash "$LINK" --source)
if [ -n "$DEPS" ] && cmp -s "$DEPS/pnpm-lock.yaml" pnpm-lock.yaml; then
  bash "$LINK" "$TMP"
else
  if [ -n "$DEPS" ]; then echo "land: lockfile differs from $DEPS's — pnpm install --frozen-lockfile"
  else echo "land: no land.linkDeps — pnpm install --frozen-lockfile"; fi
  PATH="$NODE_BIN:$PATH" pnpm install --frozen-lockfile --prefer-offline > "$TMP.install.log" 2>&1 \
    || { tail -20 "$TMP.install.log"
         echo "land: install FAILED — nothing pushed" >&2; exit 5; }
fi

# The app's own steps (`land.hooks.beforeCheck`), in order, in the land's worktree, before the
# check: each may commit derived data for what this land adds (cardtable: the art rows for a new
# scenario's cards). A hook sees NODE_BIN and LAND_LOG (a log path prefix of its own); a non-zero
# exit refuses the land, and the hook says why.
while IFS= read -r hook; do
  [ -n "$hook" ] || continue
  NODE_BIN=$NODE_BIN LAND_LOG="$TMP.$(basename "$hook" .sh)" bash "$(rel "$hook")" \
    || { echo "land: hook $(rel "$hook") FAILED — nothing pushed" >&2; exit 5; }
done <<<"$DK_HOOKS_BEFORE_CHECK"

CHANGED=$(git diff --name-only origin/main..HEAD)

# Typecheck and lint run whole. The unit suites run only where the change reaches
# (`vitest related`: the test files whose import graph holds a changed file) — CI's `check` on
# the pushed commit runs every suite anyway. Whole when the change is to what every suite
# runs on — `land.tests.whole` (cardtable: a package, the test setup) or a line of the
# `land.tests.runAllList` file (cardtable: `scripts/ci/run-all.txt`'s config and dependencies) —
# or a deleted module, which `related` cannot follow to the suites that still import it. Paths
# matching `land.tests.relatedOnly` are the exception (cardtable: the platform's server and UI
# packages' source, which `related` follows through its `@hadoku/game-server/*` and
# `@hadoku/game-ui/*` imports as it did when it lived in apps/server and apps/ui).
TESTS="pnpm run test"
GONE=$({ grep -E '\.tsx?$' <<<"$CHANGED" || true; } | while read -r f; do [ -f "$f" ] || echo "$f"; done)
RUN_ALL=$(rel "$DK_TESTS_RUN_ALL" || true)
whole() {   # reads paths on stdin: true when one runs every suite
  local paths; paths=$(cat)
  { [ -n "$DK_TESTS_WHOLE" ] && grep -qE -e "$DK_TESTS_WHOLE" <<<"$paths"; } && return 0
  [ -n "$RUN_ALL" ] && grep -qE -f <(grep -v '^#' "$RUN_ALL") <<<"$paths"
}
relatedOnly() { if [ -n "$DK_TESTS_RELATED_ONLY" ]; then grep -vE "$DK_TESTS_RELATED_ONLY" || true; else cat; fi; }
if [ -z "$GONE" ] && ! relatedOnly <<<"$CHANGED" | whole; then
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
fi
echo "land: typecheck, lint, $TESTS $(date -u +%T)"
# Without `land.unsetEnv` (cardtable: the jar env, with which check runs every jvm suite —
# memory: check-with-jar-env-runs-all-jvm).
# CI=1: the same check CI gates a deploy on — its timeouts and its 4-worker cap. This host
# runs production and every lane at once; the local 5 s/1 s budgets measured its load instead.
# NO_COLOR: CI=1 turns vitest's colour on, and the Tests-line grep below must read plain text.
UNSET=(); for v in $DK_UNSET_ENV; do UNSET+=(-u "$v"); done
if ! env "${UNSET[@]}" CI=1 NO_COLOR=1 PATH="$NODE_BIN:$PATH" \
  bash -c "pnpm run typecheck && pnpm run lint && $TESTS" > "$TMP.check.log" 2>&1; then
  tail -40 "$TMP.check.log"; echo "land: check FAILED — nothing pushed (log $TMP.check.log)" >&2; exit 5
fi
{ grep -E 'Tests +[0-9]' "$TMP.check.log" || true; } | tail -1

if [ $DRY = 1 ]; then echo "land: dry run — would push $(git rev-parse --short HEAD)"; exit 0; fi
# The lock keeps other waves out, but the auto-update bot can still move main. Its commits
# (`land.botCommits`) touch only dependency pins, so rebase over them; anything else means start over.
for _ in 1 2 3; do
  if git push -q origin HEAD:main; then
    echo "land: pushed $(git rev-parse HEAD) to main $(date -u +%T)"
    echo "land: CI — gh run list -R $DK_REPO --workflow $DK_CI_WORKFLOW --commit $(git rev-parse HEAD) (job $DK_CI_CHECK_JOB gates the deploy)"
    exit 0
  fi
  git fetch -q origin main
  if git log --format=%s HEAD..origin/main | grep -vE "$DK_BOT_COMMITS" >/dev/null; then
    echo "land: main moved with a non-bot commit — run land again" >&2; exit 6
  fi
  git rebase -q origin/main
done
echo "land: push rejected 3 times" >&2; exit 7
