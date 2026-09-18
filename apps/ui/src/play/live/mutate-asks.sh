#!/usr/bin/env bash
# Mutation test for the live prompt seam (Wave 10, lane A): `match.ts`'s open
# asks and `LiveBoard.tsx`'s prompt.
#
# Same discipline as `./mutate-seq.sh`: break each guard in turn, run the live
# tests against the REPLAY server (never a live Forge — the JVM suite is
# forced to skip here), and require them to FAIL; then restore and require
# them to PASS. Each mutation's diff is asserted non-empty first.
#
#   M1  open asks as ONE slot again: a second ask replaces the first (Wave 9's
#       behaviour), so the first is never answered and Forge waits on it.
#   M2  the prompt keyed by revision, not callId: every board redraw under an
#       open prompt remounts it and throws away a half-made choice.
#   M3  a prompt that throws is not aborted: Forge is left parked on it.
#   M4  answerAsk ignores the method: a reply for the wrong method is sent.
#   M5  state is dropped while a prompt is open — "don't move the board under
#       the player" — which is exactly the desync this lane must not have.
#
# Run from the repo root (wrap it in the build lock when agents share a tree):
#   bash apps/ui/src/play/live/mutate-asks.sh
# Exit 0 only if every mutation was caught and the restored files pass.

set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
MATCH=apps/ui/src/play/live/match.ts
BOARD=apps/ui/src/play/live/LiveBoard.tsx
MATCH_BACKUP=$(mktemp)
BOARD_BACKUP=$(mktemp)
cp "$MATCH" "$MATCH_BACKUP"
cp "$BOARD" "$BOARD_BACKUP"
restore() { cp "$MATCH_BACKUP" "$MATCH"; cp "$BOARD_BACKUP" "$BOARD"; rm -f "$MATCH_BACKUP" "$BOARD_BACKUP"; }
trap restore EXIT

mutate() { # $1 = file, $2 = JSON replacement pairs
  python3 - "$1" "$2" <<'EOF'
import json, sys
path, pairs = sys.argv[1], json.loads(sys.argv[2])
src = open(path).read()
for old, new in pairs:
    if src.count(old) != 1:
        sys.exit(f"mutation anchor not found exactly once: {old!r}")
    src = src.replace(old, new)
open(path, 'w').write(src)
EOF
}

run_tests() { # prints "<failed> failed / <passed> passed", returns vitest's exit code
  local log
  log=$(mktemp)
  env -u CARDTABLE_FORGE_JAR -u CARDTABLE_FORGE_RES pnpm exec vitest run apps/ui/src/play/live >"$log" 2>&1
  local code=$?
  local failed passed
  failed=$(grep -oE '[0-9]+ failed' "$log" | tail -1 | grep -oE '[0-9]+' || true)
  passed=$(grep -oE '[0-9]+ passed' "$log" | tail -1 | grep -oE '[0-9]+' || true)
  echo "    tests: ${failed:-0} failed / ${passed:-0} passed (vitest exit $code)"
  grep -E '^ +×' "$log" | sed 's/^/    /'
  rm -f "$log"
  return $code
}

status=0
try_mutation() { # $1 = name, $2 = file, $3 = replacement pairs
  echo "== $1"
  cp "$MATCH_BACKUP" "$MATCH"
  cp "$BOARD_BACKUP" "$BOARD"
  mutate "$2" "$3" || { echo "    could not apply"; status=1; return; }
  if diff -q "$MATCH_BACKUP" "$MATCH" >/dev/null && diff -q "$BOARD_BACKUP" "$BOARD" >/dev/null; then
    echo "    EMPTY DIFF — mutation did nothing"; status=1; return
  fi
  if run_tests; then echo "    NOT CAUGHT"; status=1; else echo "    caught"; fi
}

try_mutation "M1 open asks as one slot: a new ask replaces the old" "$MATCH" '[
  ["    if (i < 0) match.asks.push(frame);\n    else match.asks[i] = frame;", "    void i;\n    match.asks = [frame];"]
]'
try_mutation "M2 prompt keyed by revision: remounts under every redraw" "$BOARD" '[
  ["            key={ask.callId}", "            key={match.revision}"]
]'
try_mutation "M3 a prompt that throws is not aborted" "$BOARD" '[
  ["              abortAsk(match, ask.callId, '"'"'unsupported'"'"', `the ${ask.method} prompt failed to draw: ${why}`);\n", ""]
]'
try_mutation "M4 answerAsk ignores the method" "$MATCH" '[
  ["if (ask === undefined || ask.method !== method) return false;", "if (ask === undefined) return false;"]
]'
try_mutation "M5 state dropped while a prompt is open" "$MATCH" '[
  ["  foldFrames(match, [frame]);\n}", "  if (match.asks.length > 0) return;\n  foldFrames(match, [frame]);\n}"]
]'

echo "== restored"
cp "$MATCH_BACKUP" "$MATCH"
cp "$BOARD_BACKUP" "$BOARD"
if run_tests; then echo "    pass"; else echo "    RESTORED FILES FAIL"; status=1; fi
exit $status
