#!/usr/bin/env bash
# Mutation test for the live driver's sequencing rules (`match.ts`).
#
# The seq handling is a safety control, and a control is decorative until it
# has been watched failing. This breaks each rule in turn, runs the live
# tests, and requires them to FAIL; then restores the file and requires them
# to PASS. Each mutation's diff is asserted non-empty first — a mutation that
# silently matched nothing would "pass" by testing the original code.
#
#   M1  the duplicate rule: no duplicate guard, resync on `verdict !== 'ok'` —
#       exactly the bug `match.ts`'s header names.
#   M2  gap → resync: only an epoch change resyncs, so a gap is APPLIED.
#
# Run from the repo root (wrap it in the build lock when agents share a tree):
#   bash apps/ui/src/play/live/mutate-seq.sh
# Exit 0 only if every mutation was caught and the restored file passes.

set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
TARGET=apps/ui/src/play/live/match.ts
BACKUP=$(mktemp)
cp "$TARGET" "$BACKUP"
restore() { cp "$BACKUP" "$TARGET"; rm -f "$BACKUP"; }
trap restore EXIT

mutate() { # $1 = python replacement pairs, applied to $TARGET
  python3 - "$TARGET" "$1" <<'EOF'
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
  pnpm exec vitest run apps/ui/src/play/live >"$log" 2>&1
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
try_mutation() { # $1 = name, $2 = replacement pairs
  echo "== $1"
  cp "$BACKUP" "$TARGET"
  mutate "$2" || { echo "    could not apply"; status=1; return; }
  if diff -q "$BACKUP" "$TARGET" >/dev/null; then echo "    EMPTY DIFF — mutation did nothing"; status=1; return; fi
  if run_tests; then echo "    NOT CAUGHT"; status=1; else echo "    caught"; fi
}

try_mutation "M1 duplicate rule broken (resync on anything that is not ok)" '[
  ["if (verdict === '"'"'duplicate'"'"') {", "if (verdict === '"'"'duplicate'"'"' && Date.now() < 0) {"],
  ["if (needsResync(verdict)) {", "if (verdict !== '"'"'ok'"'"') {"]
]'
try_mutation "M2 gap no longer resyncs (applied instead)" '[
  ["if (needsResync(verdict)) {", "if (verdict === '"'"'epoch-change'"'"') {"]
]'

echo "== restored"
cp "$BACKUP" "$TARGET"
if run_tests; then echo "    pass"; else echo "    RESTORED FILE FAILS"; status=1; fi
exit $status
