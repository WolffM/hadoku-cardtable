#!/usr/bin/env bash
# Judges a vitest JSON report of the `*.jvm.test.ts` suites against three
# pinned lists, by name, not by count. `forge.yml` runs it twice: on each
# forge-jvm shard's own report (always partial: a shard holds only its share),
# and once on every shard's report merged, which is the only place a full run
# can see that a pinned test is gone.
#
#   FULL=true|false NIGHTLY=true|false scripts/ci/judge-jvm-report.sh <report.json>
#
# Either list going stale in EITHER direction is a red:
#  - a skip (or todo) that is not on `expected_skips`, or one on it that
#    no longer skips. With the jar present no `describe.skipIf` fires,
#    so that list is empty.
#  - a failure that is not on `known_failing`, or a pinned test that no
#    longer fails (it passed, or is gone). So the list can only shrink:
#    fixing a pinned test reds the job until its line is deleted.
#  - `known_flaky` is for a measured race that passes some runs: it may
#    pass or fail, but it must still exist. Each entry names its rate.
# Each entry is a test's full name (`describe > it`), with a comment
# above it giving the one-line reason and the evidence file.
# A report that was never written is a red too, not a silent pass.
#
# FULL: the whole set ran (every suite, no override), so every pinned test is
# judged; otherwise only the pinned tests this report ran.
# NIGHTLY: whether the `[nightly]` tests ran (`CARDTABLE_JVM_NIGHTLY`).
set -euo pipefail
report=${1:?usage: judge-jvm-report.sh <report.json>}
test -s "$report" || { echo "::error::$report is empty or missing — the jvm run did not finish writing its report"; exit 1; }
# One full test name per line; `#` lines are the reasons, not entries.
# `grep` exits 1 on an empty list, which pipefail would turn into a red.
pinned() { { grep -vE '^[[:space:]]*(#|$)' || true; } | jq -R . | jq -sc 'sort'; }
expected_skips=$(pinned <<'LIST'
LIST
)
known_failing=$(pinned <<'LIST'
LIST
)
known_flaky=$(pinned <<'LIST'
LIST
)
jq -e --argjson full "${FULL:?}" --argjson nightly "${NIGHTLY:?}" --argjson skips "$expected_skips" --argjson failing "$known_failing" --argjson flaky "$known_flaky" '
  [.testResults[].assertionResults[]] as $all
  | [$all[].fullName] as $ran
  | def inrun: if $full then . else map(select(. as $n | $ran | index($n) != null)) end;
    # On a push the `[nightly]` tests gate themselves off: that skip is
    # expected, and a pin on one of them has nothing to be judged against.
    def onpush: if $nightly then . else map(select(contains("[nightly]") | not)) end;
    ($failing | inrun | onpush) as $failing
  | ($skips | inrun) as $skips
  | ([$all[] | select(.status == "failed") | .fullName] | sort - $flaky) as $failed
  | ([$all[] | select(.status != "passed" and .status != "failed") | .fullName] | sort | onpush) as $skipped
  | {
      "failed, not pinned": ($failed - $failing),
      "pinned as failing, did not fail": ($failing - $failed),
      "skipped, not pinned": ($skipped - $skips),
      "pinned as skipped, did not skip": ($skips - $skipped),
      "no tests at all": (if ($all | length) == 0 then ["the report holds no test"] else [] end)
    }
  | . + {"pinned as flaky, not in the report": (if $full then ($flaky - $ran) else [] end)}
  | with_entries(select(.value | length > 0))
  | if length == 0 then true else (., false) end
' "$report" || { echo "::error::the jvm report does not match the pinned lists (see the object above)"; exit 1; }
