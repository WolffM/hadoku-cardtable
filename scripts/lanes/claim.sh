#!/bin/bash
# Who is working on what, across every session and lane on this host.
#
#   scripts/lanes/claim.sh claim <area> <owner> [note]   # exit 1 (and the holder) if someone else holds it
#   scripts/lanes/claim.sh release <area|--all> <owner>
#   scripts/lanes/claim.sh list
#
# An area is a repo path or glob (`apps/ui/src/play/`, `e2e/*.spec.ts`) or a topic
# (`cost-payment`). Two areas overlap when they are equal, when one is a path under the other
# (`apps/ui/` holds `apps/ui/src/x.ts`), or when one is a glob the other matches. Owners are
# whatever names a lane or session by (`lane-tl`, `manager-3fcb`). Claiming again as the same
# owner refreshes the timestamp and note.
#
# The file lives outside the repo, so every worktree and session reads the same one, and every
# read-modify-write holds its flock. A claim older than 24 h is listed as stale and no longer
# blocks: a new claim over it replaces it and says whose it was.
set -euo pipefail

FILE=${CARDTABLE_CLAIMS:-$HOME/.local/state/cardtable/claims.tsv}
STALE=$((24 * 3600))
mkdir -p "$(dirname "$FILE")"; touch "$FILE"
usage() { sed -n '4,6p' "$0" | sed 's/^# *//' >&2; exit 2; }

# Area a and b overlap? Paths compare without a trailing slash.
overlaps() {
  local a=${1%/} b=${2%/}
  [ "$a" = "$b" ] && return 0
  [[ $a == "$b"/* || $b == "$a"/* ]] && return 0
  # shellcheck disable=SC2053 # either side may be a glob on purpose
  [[ $a == $b || $b == $a ]]
}

age() {
  local s=$(($(date +%s) - $1))
  if [ $s -ge 86400 ]; then echo "$((s / 86400))d$((s % 86400 / 3600))h"
  elif [ $s -ge 3600 ]; then echo "$((s / 3600))h$((s % 3600 / 60))m"
  else echo "$((s / 60))m"; fi
}

clean() { tr '\t\n' '  ' <<<"$1" | sed 's/ *$//'; }

exec 9>"$FILE.lock"
flock -w 30 9 || { echo "claim: $FILE.lock not acquired in 30 s" >&2; exit 3; }

cmd=${1:-}; now=$(date +%s)
case $cmd in
  claim)
    [ $# -ge 3 ] || usage
    area=$(clean "$2"); owner=$(clean "$3"); note=$(clean "${4:-}")
    { [ -n "$area" ] && [ -n "$owner" ]; } || usage
    keep=(); took=(); held=0
    while IFS=$'\t' read -r a o t n; do
      [ -n "$a" ] || continue
      if [ "$o" != "$owner" ] && overlaps "$a" "$area"; then
        if [ $((now - t)) -lt $STALE ]; then
          echo "claim: $area overlaps $a, held by $o for $(age "$t")${n:+ — $n}" >&2; held=1
        else
          took+=("claim: replaced $o's stale claim on $a ($(age "$t") old)"); continue
        fi
      fi
      [ "$o" = "$owner" ] && [ "$a" = "$area" ] && continue
      keep+=("$a"$'\t'"$o"$'\t'"$t"$'\t'"$n")
    done < "$FILE"
    [ $held = 0 ] || exit 1
    { [ ${#keep[@]} = 0 ] || printf '%s\n' "${keep[@]}"; printf '%s\t%s\t%s\t%s\n' "$area" "$owner" "$now" "$note"; } > "$FILE.new"
    mv "$FILE.new" "$FILE"
    [ ${#took[@]} = 0 ] || printf '%s\n' "${took[@]}"
    echo "claim: $owner holds $area"
    ;;
  release)
    [ $# = 3 ] || usage
    area=$(clean "$2"); owner=$(clean "$3"); gone=()
    while IFS=$'\t' read -r a o t n; do
      [ -n "$a" ] || continue
      if [ "$o" = "$owner" ] && { [ "$area" = --all ] || [ "$a" = "$area" ]; }; then gone+=("$a")
      else printf '%s\t%s\t%s\t%s\n' "$a" "$o" "$t" "$n"; fi
    done < "$FILE" > "$FILE.new"
    mv "$FILE.new" "$FILE"
    [ ${#gone[@]} -gt 0 ] || { echo "claim: $owner holds no claim on $area" >&2; exit 1; }
    printf 'claim: released %s\n' "${gone[@]}"
    ;;
  list)
    [ -s "$FILE" ] || { echo "claim: no claims"; exit 0; }
    while IFS=$'\t' read -r a o t n; do
      [ -n "$a" ] || continue
      s=''; [ $((now - t)) -ge $STALE ] && s=' STALE'
      printf '%-32s %-16s %7s%s%s\n' "$a" "$o" "$(age "$t")" "$s" "${n:+  $n}"
    done < "$FILE"
    ;;
  *) usage ;;
esac
