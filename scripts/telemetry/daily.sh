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
# Installed in hadoku's crontab, run from the PPE tree (it tracks main). The
# service key is the main checkout's .devvault.local.json, read by watch.ts
# from its working directory — never on a command line or in the crontab.
# Reports older than 90 days (the logs' own retention) are deleted.
set -uo pipefail

KEY_DIR=${CARDTABLE_TELEMETRY_KEY_DIR:-/home/hadoku/repos/hadoku-cardtable}
OUT=${CARDTABLE_TELEMETRY_OUT:-/home/hadoku/.local/state/cardtable/telemetry}
NODE=${CARDTABLE_TELEMETRY_NODE:-/home/hadoku/.local/share/fnm/node-versions/v24.18.0/installation/bin/node}
WATCH="$(cd "$(dirname "$0")" && pwd)/watch.ts"

mkdir -p "$OUT"
day=$(date -u +%F)
report="$OUT/$day.txt"

cd "$KEY_DIR" || exit 1
"$NODE" "$WATCH" --hours 24 --post > "$report" 2>&1
code=$?
ln -sfn "$day.txt" "$OUT/latest.txt"

case $code in
	0) ;;
	2) echo "$day $(grep -m1 '^ALERT:' "$report" || echo 'ALERT:'); see $report" >> "$OUT/ALERTS" ;;
	*) echo "$day FAILED (exit $code): $(grep -m1 -E "^[A-Za-z]*Error:" "$report" || tail -1 "$report")" >> "$OUT/ALERTS" ;;
esac

find "$OUT" -name '20??-??-??.txt' -mtime +90 -delete
exit "$code"
