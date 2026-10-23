#!/bin/bash
# Build and install the Forge jar for a fork pin, on hokon (docs/FORGE_JAR.md).
#
#   scripts/lanes/build-jar.sh <pin>             # build, verify, install jars/<pin>.jar
#   scripts/lanes/build-jar.sh <pin> --dry-run   # read the CI gate once, print the steps, run none
#   RUNS="<run id>…" STATE=completed scripts/lanes/build-jar.sh <pin> --dry-run   # the gate on past runs
#
# <pin> is the full 40-char WolffM/forge sha. A build on hokon slows every job running there
# enough to redden it (memory: no-builds-on-hokon-under-ci), so the build waits until no
# in-progress CI job runs off the claws. The claws are never idle, so they are not counted.
# Managers only: lanes never build or install a jar (docs/lanes/RULES.md).
#
# Installing is all a pin needs. Each environment's wrapper loads jars/<its tree's forge pin>.jar,
# so PPE takes this one at its next deploy of a main carrying the pin, and prod at the release that
# includes it (docs/RELEASE.md). Install BEFORE the pin lands: a wrapper whose pin has no jar falls
# back to forge.jar, an older engine against the new res/.
set -euo pipefail

usage() { echo "usage: $0 <40-char fork pin> [--dry-run]" >&2; exit 2; }
PIN=${1:-}; [[ $PIN =~ ^[0-9a-f]{40}$ ]] || usage; shift
DRY=0
for a in "$@"; do
  case $a in --dry-run) DRY=1 ;; *) usage ;; esac
done
[ $DRY = 1 ] || [ -z "${RUNS:-}${STATE:-}" ] || { echo "build-jar: RUNS/STATE only test the gate, with --dry-run" >&2; exit 2; }

REPO=WolffM/hadoku-cardtable
CLONE=$HOME/.cache/w7b-forge
JARS=$HOME/.local/share/cardtable/jars
export JAVA_HOME=$HOME/.local/opt/jdk-21.0.12.1+1
MVN_BIN=$HOME/.local/opt/apache-maven-3.9.16/bin

run() { echo "+ $*"; [ $DRY = 1 ] || "$@"; }

# Jobs in the given state on a runner that is not a claw (jit-claw-*, warm-claw-*; hokon's is
# jit-hokon-*), one per line: run id, runner, job. Runs default to the in-progress ones.
OFFCLAW='.jobs[] | select(.status == $s and ((.runner_name // "") | test("claw") | not)) | "\(.run_id) \(.runner_name) \(.name)"'
offclaw_jobs() {
  local r
  for r in ${RUNS:-$(gh run list -R $REPO --status in_progress --json databaseId -q '.[].databaseId')}; do
    gh api "repos/$REPO/actions/runs/$r/jobs" | jq -r --arg s "${STATE:-in_progress}" "$OFFCLAW"
  done
}

echo "build-jar: gate — in-progress CI jobs off the claws"
while :; do
  busy=$(offclaw_jobs)
  [ -z "$busy" ] && { echo "build-jar: gate open $(date -u +%T)"; break; }
  echo "$busy" | sed 's/^/build-jar:   waiting on /'
  [ $DRY = 1 ] && { echo "build-jar: dry run — a real run waits here until they finish"; break; }
  sleep 60
done

run git -C "$CLONE" fetch -q fork
run git -C "$CLONE" checkout -q --detach "$PIN"
[ $DRY = 1 ] || [ -z "$(git -C "$CLONE" status --porcelain)" ] || { echo "build-jar: $CLONE is dirty" >&2; exit 1; }
# `clean` is not optional across a pin move: an incremental build can re-package stale classes.
run env -C "$CLONE" PATH="$JAVA_HOME/bin:$MVN_BIN:$PATH" \
  mvn -q -pl forge-gui-desktop -am clean package -DskipTests -Dmaven.test.skip=true

# The two fork commits are invisible to the build: verify the compiled class carries `forge
# server` and no Sentry DSN.
echo "+ verify forge/view/Main.class: has 'server', no 'sentry'"
if [ $DRY = 0 ]; then
  JAR=$(ls "$CLONE"/forge-gui-desktop/target/forge-gui-desktop-*-jar-with-dependencies.jar)
  python3 -I - "$JAR" <<'EOF'
import sys, zipfile
c = zipfile.ZipFile(sys.argv[1]).read('forge/view/Main.class')
if b'server' not in c: sys.exit('build-jar: STOP — no `forge server` in Main.class')
if b'sentry' in c.lower(): sys.exit('build-jar: STOP — Sentry still in Main.class')
EOF
else
  JAR="$CLONE/forge-gui-desktop/target/forge-gui-desktop-*-jar-with-dependencies.jar"
fi
run mkdir -p "$JARS"
run install -m 0644 "$JAR" "$JARS/$PIN.jar"
[ $DRY = 1 ] || sha256sum "$JARS/$PIN.jar"
echo "build-jar: installed $JARS/$PIN.jar"
