#!/bin/bash
# Wait for one Actions run to finish, then print ONE compact summary of it.
#
#   scripts/lanes/watch-run.sh <run-id> [--tag <regex>]
#
# Start it once, in the background, and stop: its exit is what wakes you. A poll loop in an
# agent's own context costs a turn per wake-up (retro 2026-10-20: 52 h of lanes polling CI).
# It polls every WATCH_EVERY seconds (75; the API's 5000/h is shared by every lane), then prints
# the run's conclusion and head sha, each job's conclusion and runner, and for each red job
# only the failing specs/suites with their first Error/Expected/Received lines and the `[tag]`
# evidence lines of those specs (plus `--tag`'s), and each forge-e2e test that was flaky (failed,
# then passed its one re-run), capped at 60 lines. The full summary and
# each red job's log stay on disk (the last line says where), so a second look is a grep,
# not another download. `gh run view --log` refuses mid-run; the jobs/<id>/logs endpoint
# does not.
#
# Exit 0 when the run succeeded, 1 when it did not, 3 when it could not be watched.
set -euo pipefail

R=${CARDTABLE_REPO:-WolffM/hadoku-cardtable}
EVERY=${WATCH_EVERY:-75}
ID=${1:-}; TAG=''
[[ $ID =~ ^[0-9]+$ ]] || { echo "usage: watch-run.sh <run-id> [--tag <regex>]" >&2; exit 3; }
[ "${2:-}" = --tag ] && TAG=${3:?--tag needs a regex}
DIR=${WATCH_DIR:-/tmp/claude-1000/watch-run}/$ID
mkdir -p "$DIR"

# A blip in the API is not the run's end; only a run that stays unreadable gives up.
misses=0
while :; do
  if st=$(gh api "repos/$R/actions/runs/$ID" --jq .status 2>"$DIR/api.err"); then
    misses=0
    [ "$st" = completed ] && break
  elif [ $((misses += 1)) -ge 5 ]; then
    echo "watch-run: run $ID unreadable 5 times running: $(head -c 200 "$DIR/api.err")" >&2; exit 3
  fi
  sleep "$EVERY"
done

IFS=$'\t' read -r CONC SHA BRANCH NAME < <(gh api "repos/$R/actions/runs/$ID" \
  --jq '[.conclusion, .head_sha, .head_branch, .name] | @tsv')
gh api "repos/$R/actions/runs/$ID/jobs?per_page=100&filter=latest" \
  --jq '.jobs[] | [.id, .name, (.conclusion // "none"), (.runner_name // "-")] | @tsv' > "$DIR/jobs.tsv"

strip() { sed -E 's/\x1b\[[0-9;]*m//g; s/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z //'; }

# One red job: vitest's ` FAIL  file > test` and Playwright's `  1) [project] › file:line › test` open a
# failure block; its first three Error/Expected/Received lines are what tells the cause. A job cut
# off by its timeout (`cancelled`) never reaches Playwright's closing list, so its live
# `  ✘   72 [project] › file:line` lines name what failed before the cut — run 42204349837's
# fourth shard hid a real red (w89h) that way, under a job only reported as cancelled.
red_job() {
  local jid=$1 log="$DIR/job-$1.log" counts tags
  # gh >= 2.100 refuses a body with escape sequences unless told, and every job log has them.
  gh api --allow-escape-sequences "repos/$R/actions/jobs/$jid/logs" 2>"$log.err" | strip > "$log" \
    || echo "    no log for job $jid: $(head -c 200 "$log.err")"
  # A shard that re-ran its failed tests names its own reds; its first run's list also holds the flaky ones.
  if grep -q '^e2e re-run verdict:' "$log"; then
    grep -E '^red: ' "$log" | cut -c1-200 | sed 's/^red: /    ✘ /'
  else
  awk '
    /^ FAIL  / || /^ +[0-9]+\) (\[[a-z]+\] › )?[^ ]+\.(spec|test)\.tsx?/ { sub(/^ +(FAIL +)?/, ""); print "    ✘ " substr($0, 1, 200); inb = 1; n = 0; found = 1; next }
    inb && (/^⎯/ || /^ +[0-9]+ (failed|passed|flaky)/) { inb = 0 }
    inb && n < 3 && /(Error|Expected|Received|Timeout [0-9]+ms)/ && !/^ +at / && !/^ *>? *[0-9]+ ?\|/ { sub(/^ +/, ""); print "        " substr($0, 1, 200); n++ }
    /^ +✘ +[0-9]+ \[[a-z-]+\] › / { sub(/^ +✘ +/, ""); live[++nl] = $0 }
    END {
      if (!found) for (i = 1; i <= nl; i++) { print "    ✘ " substr(live[i], 1, 200); found = 1 }
      exit !found
    }
  ' "$log" || grep -E '(Error|##\[error\])' "$log" | grep -v 'Process completed with exit code' \
    | head -3 | cut -c1-200 | sed 's/^/    /' || true
  fi
  counts=$(grep -E '^ +[0-9]+ (failed|passed|flaky|skipped|did not run)|^ +(Test Files|Tests) ' "$log" \
    | sed -E 's/^ +//; s/ +/ /g' | paste -sd';' | sed 's/;/; /g' || true)
  [ -z "$counts" ] || echo "    counts: $counts"
  # Evidence: the `[tag]` lines of the specs that failed (a tag starts with the spec's file
  # stem: `[stacking]`, `[prompts.jvm]`), and any the caller named.
  tags=$(grep -oE '^( FAIL  | +[0-9]+\) )[^ ]*' "$log" | grep -oE '[A-Za-z0-9_.-]+\.(spec|test)\.tsx?' \
    | sed -E 's/\.(spec|test)\.tsx?$//' | sort -u | paste -sd'|' || true)
  tags=$(printf '%s' "${tags}${TAG:+${tags:+|}$TAG}" | sed 's/\./\\./g')
  if [ -n "$tags" ]; then
    grep -E "^\[($tags)[^] ]*\] " "$log" | tail -8 | cut -c1-200 | sed "s/^/    /" || true
  fi
}

# A forge-e2e test that failed and then passed its one re-run (`scripts/ci/e2e-rerun.ts`) leaves
# the job green and a "Flaky e2e test" annotation: listed apart from the reds, never counted as one.
# A cancelled or timed-out shard is never read here — it never got to a re-run, and it is red.
flaky_job() {
  gh api "repos/$R/check-runs/$1/annotations?per_page=100" \
    --jq '.[] | select(.title == "Flaky e2e test") | .message' 2>/dev/null \
    | cut -c1-200 | sed 's/^/    ⚠ flaky: /' || true
}

OUT="$DIR/summary.txt"
{
  echo "run $ID $NAME: ${CONC:-none} on $BRANCH@${SHA:0:12} https://github.com/$R/actions/runs/$ID"
  ran=0
  while IFS=$'\t' read -r jid jname jconc runner; do
    echo "  $jname: $jconc (${runner%%-hadoku-cardtabl*})"
    case $jconc in failure|timed_out|cancelled) red_job "$jid" ;; esac
    case $jname:$jconc in forge-e2e*:success|forge-e2e*:failure) flaky_job "$jid" ;; esac
    case $jname in changes|judge*) ;; *) [ "$jconc" = skipped ] || ran=1 ;; esac
  done < "$DIR/jobs.tsv"
  if [ $ran = 0 ]; then
    # The `changes` job says why it picked nothing: main unmoved, or the same proof already green.
    cid=$(awk -F'\t' '$2 == "changes" { print $1 }' "$DIR/jobs.tsv")
    why=$([ -n "$cid" ] && gh api --allow-escape-sequences "repos/$R/actions/jobs/$cid/logs" 2>/dev/null | grep -aoE 'running nothing: .*' | tail -1)
    echo "  note: every test job skipped — ${why:-nothing ran (a bare dispatch on main needs -f full=true)}"
  fi
} > "$OUT"
head -60 "$OUT"
L=$(wc -l < "$OUT"); [ "$L" -gt 60 ] && echo "  … $((L - 60)) more lines in $OUT"
echo "watch-run: logs in $DIR"
[ "$CONC" = success ]
