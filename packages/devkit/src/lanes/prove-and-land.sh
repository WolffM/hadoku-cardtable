#!/bin/bash
# Prove a lane on the claws on the latest main, and land it only if that proof is green.
#
#   scripts/lanes/prove-and-land.sh [--dry-run] <worktree> -f only=e2e -f specs="stacking --repeat-each=3"
#   scripts/lanes/prove-and-land.sh <worktree> -f only=jvm -f jvm=games/magic/server/src/play/priority.jvm.test.ts
#
#   scripts/lanes/prove-and-land.sh --plan <worktree> [-f …]   # say what it would do; push and land nothing
#
# The proof is the config's `proof.workflow` (cardtable: forge.yml) and every `-f` is passed to
# its dispatch as given (only, specs, jvm, full, video). A repo with no `proof` block skips the
# proof: rebase, then land. `--plan` changes nothing: it names the base, the proof and its
# inputs, and runs the proof's `select` hook (when the config names one) over the branch's
# changes, printing what the proof would pick for them.
# The retro of 2026-10-20 found 64% of lands rebuilt three or more times because the proof ran
# on a stale base, so the order here is fixed: fetch, rebase the lane onto origin/main, push
# that exact HEAD to verify/<branch>, dispatch, wait (watch-run.sh), and on green run land.sh
# through the dev-vault wrapper from the main checkout, as the manager does. land.sh
# cherry-picks onto an even newer main if one landed meanwhile; what it pushes was proven
# one rebase earlier at most. `--dry-run` passes through to land.sh: everything but the push.
#
# It never removes the worktree or the lane branch (the caller does), only verify/<branch>.
# Exit 0 landed, 1 proof red, 2 rebase refused (conflicts listed), 3 dispatch or watch
# failed, 4 land refused (its log is printed).
set -euo pipefail
# shellcheck source=../lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"; devkit_load

R=$(dk_env REPO); R=${R:-$DK_REPO}
DRY=''; PLAN=0
case ${1:-} in --dry-run) DRY=--dry-run; shift ;; --plan) PLAN=1; shift ;; esac
W=${1:-}; shift || true
# A proof needs its inputs; without a proof workflow there are none to give.
{ [ -d "$W" ] && { [ $# -ge 2 ] || [ -z "$DK_PROOF_WORKFLOW" ] || [ $PLAN = 1 ]; }; } || { sed -n '4,6p' "$0" | sed 's/^# *//' >&2; exit 3; }
W=$(cd "$W" && pwd)
MAIN=$(dirname "$(git -C "$W" rev-parse --path-format=absolute --git-common-dir)")
HERE=$(cd "$(dirname "$0")" && pwd)
B=$(git -C "$W" rev-parse --abbrev-ref HEAD)
case $B in main|HEAD) echo "prove: $W is on $B — run it from a lane branch" >&2; exit 2 ;; esac
[ "$W" = "$MAIN" ] && { echo "prove: never from the main checkout (it is the deploy tree)" >&2; exit 2; }
V=verify/$B
LOGS=$DK_SCRATCH_DIR/prove-and-land; mkdir -p "$LOGS"

if [ $PLAN = 1 ]; then
  git -C "$W" fetch -q origin main
  echo "prove: plan for $B at $(git -C "$W" rev-parse --short HEAD), $(git -C "$W" rev-list --count origin/main..HEAD) commit(s) over origin/main $(git -C "$W" rev-parse --short origin/main)"
  if [ -z "$DK_PROOF_WORKFLOW" ]; then
    echo "prove: no proof workflow in devkit.config.json — would rebase onto origin/main and land with no proof"
  else
    echo "prove: would push verify/$B and dispatch $DK_PROOF_WORKFLOW on $R${*:+ with $*}"
    if [ -n "$DK_PROOF_SELECT" ]; then
      CH=$(mktemp "$LOGS/changes-XXXXXX.json")
      "$DK_NODE" "$DK_SRC/lanes/changes.ts" "$W" origin/main HEAD > "$CH"
      echo "prove: $DK_PROOF_WORKFLOW's selection ($(basename "$DK_PROOF_SELECT")) for these changes:"
      case $DK_PROOF_SELECT in
        *.ts) "$DK_NODE" "$DK_PROOF_SELECT" "$CH" --root "$W" ;;
        *) "$DK_PROOF_SELECT" "$CH" --root "$W" ;;
      esac | sed 's/^/  /'
      rm -f "$CH"
    fi
  fi
  echo "prove: then land-worktree.sh${DRY:+ $DRY} $W — nothing pushed, nothing landed (plan)"
  exit 0
fi

if [ -n "$(git -C "$W" status --porcelain --untracked-files=no)" ]; then
  echo "prove: $W has uncommitted changes — commit them (a WIP commit is fine) first" >&2
  git -C "$W" status --short --untracked-files=no >&2; exit 2
fi
git -C "$W" fetch -q origin main
if ! git -C "$W" rebase -q origin/main >/dev/null 2>&1; then
  echo "prove: $B does not rebase onto origin/main; conflicts:" >&2
  git -C "$W" diff --name-only --diff-filter=U | sed 's/^/  /' >&2
  git -C "$W" rebase --abort; exit 2
fi
SHA=$(git -C "$W" rev-parse HEAD)
echo "prove: $B at ${SHA:0:12}, $(git -C "$W" rev-list --count origin/main..HEAD) commit(s) on origin/main $(git -C "$W" rev-parse --short origin/main)"
# A new branch makes the remote print a pull-request hint; only a refused push says anything.
if [ -z "$DK_PROOF_WORKFLOW" ]; then
  echo "prove: no proof workflow in devkit.config.json — landing on the rebase alone"
else
out=$(git -C "$W" push -q -f origin "HEAD:refs/heads/$V" 2>&1) || { echo "$out" >&2; exit 3; }

# The config's `proof.maxInFlight` (cardtable: three jdk21 claws): more dispatches than that only
# queue (memory: one dispatch per proof).
busy() { gh run list -R "$R" --workflow "$DK_PROOF_WORKFLOW" --event workflow_dispatch --limit 40 --json status \
  --jq '[.[] | select(.status == "queued" or .status == "in_progress")] | length'; }
while [ "$(busy || echo 0)" -ge "$DK_PROOF_MAX_IN_FLIGHT" ]; do echo "prove: $DK_PROOF_MAX_IN_FLIGHT dispatches in flight — waiting"; sleep 90; done

since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run "$DK_PROOF_WORKFLOW" -R "$R" --ref "$V" "$@" || { echo "prove: dispatch refused" >&2; exit 3; }
id=''
for _ in 1 2 3 4 5 6 7 8; do
  sleep 15
  id=$(gh run list -R "$R" --workflow "$DK_PROOF_WORKFLOW" --branch "$V" --event workflow_dispatch --limit 5 \
    --json databaseId,createdAt,headSha --jq "[.[] | select(.createdAt >= \"$since\" and .headSha == \"$SHA\")][0].databaseId // empty")
  [ -n "$id" ] && break
done
[ -n "$id" ] || { echo "prove: dispatched, but no run for $V at ${SHA:0:12} appeared in 2 min" >&2; exit 3; }
echo "prove: run $id https://github.com/$R/actions/runs/$id"

set +e; bash "$HERE/watch-run.sh" "$id"; red=$?; set -e
git -C "$W" push -q origin ":refs/heads/$V" 2>/dev/null || echo "prove: could not delete $V" >&2
[ $red = 0 ] || { echo "prove: run $id is not green — nothing landed" >&2; [ $red = 1 ] && exit 1; exit 3; }
fi

# The manager's invocation (`land-worktree.sh`: the dev-vault wrapper from the main checkout,
# Node 24). Its exit status is land.sh's own, not a pipe's: `land.sh | tail && cleanup` read a
# refused land as success twice. A zero exit with no `land: pushed` line is not a land either.
LOG=$LOGS/${B//\//_}.land.log
set +e
bash "$HERE/land-worktree.sh" $DRY "$W" > "$LOG" 2>&1
rc=$?; set -e
grep -E '^land: (ledger|bumped|art rows|pushed|dry run|nothing|.*(FAILED|refused|moved|apply|rejected))' "$LOG" || true
if [ $rc != 0 ]; then tail -20 "$LOG"; echo "prove: land.sh exited $rc — nothing landed (log $LOG)" >&2; exit 4; fi
if [ -z "$DRY" ] && ! grep -q '^land: pushed\|^land: nothing to land' "$LOG"; then
  echo "prove: land.sh exited 0 without a 'land: pushed' line — treat it as not landed (log $LOG)" >&2; exit 4
fi
echo "prove: ${DRY:+dry-run }land done for $B (log $LOG)"
