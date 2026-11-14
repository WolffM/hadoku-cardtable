#!/usr/bin/env bash
# The daily security watch: watch.ts over the last 24 h, one report per day.
#
#   scripts/telemetry/daily.sh          # the app's entry point; the crontab runs it
#   scripts/telemetry/daily.sh --help   # this text, and the paths it would use; runs nothing
#
#   <outDir>/<YYYY-MM-DD>.txt   the report
#   <outDir>/latest.txt         -> today's
#   <outDir>/ALERTS             one line per day watch.ts exited 2 (a gate breach, a
#                               seal-refused or a critical event: its `ALERT:` line), or
#                               failed (3 = the Discord post)
#
# outDir is the config's `telemetry.outDir` (default <stateDir>/telemetry). Each run also posts
# a digest, with the report attached, to the Discord channel behind the vault secret the
# config's `telemetry.discordWebhookSecret` names (watch.ts --post).
#
# Installed in hadoku's crontab for cardtable, run from the PPE tree (it tracks main), with that
# tree as its working directory. The service key is read by watch.ts from KEY_FILE
# (`telemetry.keyFile`), never from a command line or the crontab. Cardtable's is the repo's
# canonical caller-key file: key rotation writes every repo's key under
# ~/repos/<repo>/.devvault.local.json (hadoku_site mgmt-api lib/devvault-keys.ts) and the ~/srv
# clones only symlink to it. A build-aside deploy swaps the ~/srv clone whole and an untracked
# link does not follow, so the clone is not a stable place to read it from.
# <envPrefix>_TELEMETRY_KEY_FILE, _OUT and _NODE override the key file, outDir and Node.
# Reports older than 90 days (the logs' own retention) are deleted.
set -uo pipefail
# shellcheck source=../lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"; devkit_load

[ -n "$DK_TELEMETRY_OUT" ] || { echo "daily: devkit.config.json has no telemetry block" >&2; exit 2; }
KEY_FILE=$(dk_env TELEMETRY_KEY_FILE); KEY_FILE=${KEY_FILE:-$DK_TELEMETRY_KEY_FILE}
OUT=$(dk_env TELEMETRY_OUT); OUT=${OUT:-$DK_TELEMETRY_OUT}
NODE=$(dk_env TELEMETRY_NODE); [ -n "$NODE" ] || { NODE=$DK_NODE_BIN/node; [ -x "$NODE" ] || NODE=$DK_NODE; }
WATCH="$DK_SRC/telemetry/watch.ts"

if [ "${1:-}" = --help ]; then
  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
  echo; printf '%s: %s\n' app "$DK_APP_ID" tree "$DK_ROOT" out "$OUT" "key file" "$KEY_FILE" node "$NODE" watch "$WATCH"
  exit 0
fi

mkdir -p "$OUT"
day=$(date -u +%F)
report="$OUT/$day.txt"

cd "$DK_ROOT" || exit 1
env "${DK_ENV_PREFIX}_TELEMETRY_KEY_FILE=$KEY_FILE" "$NODE" "$WATCH" --hours 24 --post > "$report" 2>&1
code=$?
ln -sfn "$day.txt" "$OUT/latest.txt"

case $code in
	0) ;;
	2) echo "$day $(grep -m1 '^ALERT:' "$report" || echo 'ALERT:'); see $report" >> "$OUT/ALERTS" ;;
	*) echo "$day FAILED (exit $code): $(grep -m1 -E "^[A-Za-z]*Error:" "$report" || tail -1 "$report")" >> "$OUT/ALERTS" ;;
esac

find "$OUT" -name '20??-??-??.txt' -mtime +90 -delete
exit "$code"
