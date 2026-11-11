#!/usr/bin/env bash
# The daily security watch: watch.ts over the last 24 h, one report per day.
#
#   ~/.local/state/cardtable/telemetry/<YYYY-MM-DD>.txt   the report
#   ~/.local/state/cardtable/telemetry/latest.txt         -> today's
#   ~/.local/state/cardtable/telemetry/ALERTS             one line per day watch.ts exited 2
#                                                         (a gate breach, a seal-refused or a
#                                                         critical event: its `ALERT:` line),
#                                                         or failed (3 = the Discord post)
#
# Each run also posts a digest, with the report attached, to the Discord channel
# behind the vault's DISCORD_CARDTABLE_DAILY_WEBHOOK (watch.ts --post).
#
# Installed in hadoku's crontab, run from the PPE tree (it tracks main), with
# that tree as its working directory. The service key is read by watch.ts from
# KEY_FILE, never from a command line or the crontab. Its default is the repo's
# canonical caller-key file: key rotation writes every repo's key under
# ~/repos/<repo>/.devvault.local.json (hadoku_site mgmt-api lib/devvault-keys.ts)
# and the ~/srv clones only symlink to it. A build-aside deploy swaps the ~/srv
# clone whole and an untracked link does not follow, so the clone is not a
# stable place to read it from. Until 2026-11-11 this cd'd into that ~/repos
# checkout, the operator's workspace, to find the key.
# Reports older than 90 days (the logs' own retention) are deleted.
set -uo pipefail

KEY_FILE=${CARDTABLE_TELEMETRY_KEY_FILE:-/home/hadoku/repos/hadoku-cardtable/.devvault.local.json}
OUT=${CARDTABLE_TELEMETRY_OUT:-/home/hadoku/.local/state/cardtable/telemetry}
NODE=${CARDTABLE_TELEMETRY_NODE:-/home/hadoku/.local/share/fnm/node-versions/v24.18.0/installation/bin/node}
TREE="$(cd "$(dirname "$0")/../.." && pwd)"
WATCH="$TREE/scripts/telemetry/watch.ts"

mkdir -p "$OUT"
day=$(date -u +%F)
report="$OUT/$day.txt"

cd "$TREE" || exit 1
CARDTABLE_TELEMETRY_KEY_FILE="$KEY_FILE" "$NODE" "$WATCH" --hours 24 --post > "$report" 2>&1
code=$?
ln -sfn "$day.txt" "$OUT/latest.txt"

case $code in
	0) ;;
	2) echo "$day $(grep -m1 '^ALERT:' "$report" || echo 'ALERT:'); see $report" >> "$OUT/ALERTS" ;;
	*) echo "$day FAILED (exit $code): $(grep -m1 -E "^[A-Za-z]*Error:" "$report" || tail -1 "$report")" >> "$OUT/ALERTS" ;;
esac

find "$OUT" -name '20??-??-??.txt' -mtime +90 -delete
exit "$code"
