#!/usr/bin/env bash
#
# hadoku-cardtable PR-4 spike 3 (Wave 7, lane A) — Tier C: seat two players in a
# real match and ask whether the delta stream survives a JSON round trip.
#
# An OVERLAY, in the pattern Waves 1, 3 and 6 all used. It writes no Java into
# the Forge checkout: the only thing it compiles is scripts/spike/tierc/src, and
# it compiles that against the stock fat jar plus the stock forge-gui-desktop
# test-classes. Maven's own target/ dirs are the only thing it creates in
# FORGE_DIR, which is why FORGE_DIR must be a SCRATCH COPY and never the repo's
# vendored forge/ submodule (D2/O1: the submodule is pinned at 2cd497c and stays
# byte-for-byte stock).
#
# The guards below (need_forge_dir, assert_forge_pristine) are COPIED from
# scripts/spike/itoclient/run.sh rather than sourced: that file is Wave 6's and
# sharing it would couple two lanes' files together. They are not weakened —
# need_forge_dir still resolves symlinks with `pwd -P`, and
# assert_forge_pristine still checks for target/ dirs AND asks git, because
# Forge's own .gitignore line 33 covers `target` and `git status` alone reported
# "pristine" through the whole Wave 6 incident.
#
# Usage:
#   FORGE_DIR=/path/to/forge-copy ./run.sh <build|match|capture|all|verify-pristine|mutate>
#
#   build             mvn install of forge-gui-desktop (-DskipTests still
#                     COMPILES src/test/java/forge/net, which is the harness)
#   match             phase 1: stock UnifiedNetworkHarness, 2 players, 1 remote.
#                     Asserts the stock client's DeltaLoggingGuiGame counted a
#                     NON-ZERO number of delta packets. Zero is a failure.
#   capture           phase 2: our own remote client captures real DeltaPackets
#                     off the wire and runs the JSON round trip over them.
#   mutate            runs the three mutations that prove the assertions can
#                     fail. Each must exit non-zero or this mode fails loudly:
#                       A  -Dtierc.remoteClients=0     no client -> no deltas
#                       B  -Dforge.deltasync=false     state arm off (the packet
#                                                      COUNT does not move — see
#                                                      docs/spikes/tier-c.md)
#                       C  -Dtierc.mutate=corrupt-value  comparator must catch it
#   all               build, match, capture, verify-pristine
#   verify-pristine   assert the repo's vendored forge/ submodule is untouched
#
# Environment:
#   FORGE_DIR   Forge checkout to build in. Required; no default, because the
#               obvious default is the vendored tree and that must stay clean.
#   JAVA_HOME   A JDK 21. Defaults to the user-local Temurin that Wave 1 lane B
#               installed under ~/.local/opt (decision D14) — `java` on PATH is
#               a Debian JRE with no javac, and Maven then fails with the
#               misleading "release version 17 not supported".
#   WORK_DIR    Scratch run directory. Default:
#               ${TMPDIR:-/tmp}/cardtable-tierc-spike
#   OUT_DIR     Where census.tsv/coverage.tsv/sample-*.json are written.
#               Default: scripts/spike/tierc/out, which is COMMITTED — /tmp here
#               is tmpfs and empties on reboot, so a transcript left there has
#               not been kept.
#
# Transcripts in out/ are named `.txt`, not `.log`, ON PURPOSE: the repo's
# .gitignore line 22 is a bare `*.log`, so a committed `.log` transcript is
# silently dropped and the evidence a doc cites stops existing. Redirect
# with `> out/<name>.txt`.
#
set -euo pipefail

MODE="${1:-all}"
SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="${WORK_DIR:-${TMPDIR:-/tmp}/cardtable-tierc-spike}"
OUT_DIR="${OUT_DIR:-$SPIKE_DIR/out}"

# Wave 1 lane B put a real JDK here; `which javac` finds nothing because it is
# not on PATH, which is what makes "there is no compiler on this host" a
# tempting and wrong conclusion. It has misled two sessions already.
if [[ -z "${JAVA_HOME:-}" ]]; then
  JAVA_HOME="$(ls -d "$HOME"/.local/opt/jdk-21* 2>/dev/null | head -1 || true)"
fi
if [[ -z "$JAVA_HOME" || ! -x "$JAVA_HOME/bin/javac" ]]; then
  echo "No JDK 21. Set JAVA_HOME to one with bin/javac." >&2
  echo "A JRE is not enough: maven-compiler-plugin then reports the misleading" >&2
  echo "'release version 17 not supported'." >&2
  exit 2
fi
export JAVA_HOME
JAVAC="$JAVA_HOME/bin/javac"
JAVA="$JAVA_HOME/bin/java"
MVN="${MVN:-mvn}"

need_forge_dir() {
  if [[ -z "${FORGE_DIR:-}" ]]; then
    echo "FORGE_DIR is not set. Point it at a Forge checkout you are willing to" >&2
    echo "let Maven write target/ dirs into — NOT the repo's vendored forge/." >&2
    exit 2
  fi
  # `pwd -P`, not `pwd`. The logical form keeps symlinks, and this guard is a
  # STRING comparison — so from a git worktree, where `forge/` resolves into the
  # main checkout, `<worktree>/forge` never equalled `<main>/forge` and the
  # guard waved a Maven build straight into the vendored tree. That happened on
  # 2026-09-16: six `target/` dirs, in the one tree D2 requires stay pristine.
  FORGE_DIR="$(cd "$FORGE_DIR" && pwd -P)"
  local vendored
  vendored="$(cd "$SPIKE_DIR/../../.." && pwd -P)/forge"
  if [[ -e "$vendored" ]] && [[ "$FORGE_DIR" == "$(cd "$vendored" && pwd -P)" ]]; then
    echo "FORGE_DIR is the vendored forge/ tree (resolved: $FORGE_DIR)." >&2
    echo "Refusing: it must stay pristine." >&2
    exit 2
  fi
}

# Is the vendored tree actually untouched?
#
# `git status --porcelain` is NOT enough and reported "pristine" through the
# whole incident above: Forge's own .gitignore line 33 covers `target`, so git
# cannot see build output in the tree it is being asked about. A check that
# cannot fail for the thing you are checking is not a check.
#
# So: ask git AND look for build output directly.
assert_forge_pristine() {
  local vendored dirty targets
  vendored="$(cd "$SPIKE_DIR/../../.." && pwd -P)/forge"
  [[ -d "$vendored" ]] || { echo "no vendored forge/ to check"; return 0; }
  dirty="$(git -C "$vendored" status --porcelain | wc -l)"
  targets="$(find "$vendored" -maxdepth 3 -name target -type d 2>/dev/null | wc -l)"
  if [[ "$dirty" -ne 0 || "$targets" -ne 0 ]]; then
    echo "forge/ is NOT pristine: $dirty tracked changes, $targets target/ dirs." >&2
    find "$vendored" -maxdepth 3 -name target -type d 2>/dev/null >&2
    return 1
  fi
  echo "forge/ pristine: 0 tracked changes, 0 target/ dirs (both checked)."
  echo "forge/ HEAD $(git -C "$vendored" rev-parse HEAD)"
}

FATJAR_GLOB_SUFFIX='forge-gui-desktop/target/forge-gui-desktop-*-jar-with-dependencies.jar'

fatjar() {
  local j
  # shellcheck disable=SC2086
  j=$(ls -1 $FORGE_DIR/$FATJAR_GLOB_SUFFIX 2>/dev/null | head -1 || true)
  [[ -n "$j" ]] || { echo "No fat jar found. Run '$0 build' first." >&2; exit 1; }
  echo "$j"
}

# The stock net harness (TestUtils, HeadlessGuiDesktop, HeadlessNetworkGuiGame,
# UnifiedNetworkHarness, PortAllocator, TestDeckLoader) lives in
# forge-gui-desktop's TEST sources. `-DskipTests` skips RUNNING tests but still
# compiles them, so an ordinary build produces these. None of them imports
# testng or junit, so the fat jar is the only other thing on the classpath.
testclasses() {
  local d="$FORGE_DIR/forge-gui-desktop/target/test-classes"
  [[ -d "$d/forge/net" ]] || {
    echo "No compiled net harness at $d/forge/net. Run '$0 build' first." >&2
    exit 1
  }
  echo "$d"
}

do_build() {
  need_forge_dir
  echo "==> build: mvn install -pl forge-gui-desktop -am -DskipTests"
  ( cd "$FORGE_DIR" && "$MVN" -B install -pl forge-gui-desktop -am -DskipTests -Dmaven.javadoc.skip=true )
}

compile_spike() {
  local jar tc out
  jar="$(fatjar)"
  tc="$(testclasses)"
  out="$WORK_DIR/classes"
  rm -rf "$out"; mkdir -p "$out"
  echo "==> compile: $SPIKE_DIR/src/*.java" >&2
  "$JAVAC" -Xlint:-unchecked -cp "$jar:$tc" -d "$out" "$SPIKE_DIR"/src/*.java >&2
  echo "$out"
}

# Forge's version string carries no "git", so GuiDesktop.getAssetsDir() returns
# "" and ForgeConstants.RES_DIR resolves to "res/" relative to the working
# directory. Hence: run from a directory whose res/ is Forge's.
stage_run_dir() {
  local run="$WORK_DIR/run"
  rm -rf "$run"
  mkdir -p "$run/user/decks/constructed" "$run/cache"
  ln -s "$FORGE_DIR/forge-gui/res" "$run/res"
  cat > "$run/forge.profile.properties" <<EOF
userDir=$run/user/
cacheDir=$run/cache/
decksDir=$run/user/decks/
decksConstructedDir=$run/user/decks/constructed/
EOF
  echo "$run"
}

# run_java <main-class> [extra -D flags...]
run_java() {
  need_forge_dir
  local main="$1"; shift
  local jar tc out run
  jar="$(fatjar)"
  tc="$(testclasses)"
  out="$(compile_spike)"
  run="$(stage_run_dir)"
  mkdir -p "$OUT_DIR"
  # -Djava.awt.headless=true: nothing here opens a window; assert it.
  # -Dsentry.dsn=: Main.main() is not the entry point here, so upstream's
  #   hardcoded DSN is never initialised — set anyway so the run adds none.
  ( cd "$run" && "$JAVA" \
      -Djava.awt.headless=true \
      -Dsentry.dsn= \
      -Dtierc.outDir="$OUT_DIR" \
      "$@" \
      -cp "$jar:$tc:$out" "$main" )
}

do_match() {
  run_java spike.tierc.MatchPhase "$@"
}

do_capture() {
  run_java spike.tierc.CapturePhase "$@"
}

do_verify_pristine() {
  echo "==> verify-pristine"
  assert_forge_pristine
}

# Both mutations run against OUR OWN spike sources / our own spike run.
# Neither disables a guard, and neither runs anything against the vendored tree.
do_mutate() {
  # A mutated run must not overwrite the committed census/coverage/samples that
  # the UNMUTATED run produced — the transcript is the evidence.
  OUT_DIR="$WORK_DIR/mutate-out"
  mkdir -p "$OUT_DIR"
  echo "(mutation artifacts go to $OUT_DIR, not the committed out/ dir)"
  local rc

  echo "############################################################"
  echo "# mutation A — remove the remote client, so no delta can flow."
  echo "#   -Dtierc.remoteClients=0 sends UnifiedNetworkHarness down its"
  echo "#   local-AI path: nobody connects, so deltaPacketsReceived is 0"
  echo "#   and clientOpenViewCalled is false. Phase 1 must FAIL."
  echo "############################################################"
  set +e
  do_match -Dtierc.remoteClients=0
  rc=$?
  set -e
  echo "mutation A (no remote client): exit=$rc   [expected: non-zero]"
  if [[ "$rc" -eq 0 ]]; then
    echo "MUTATION A DID NOT BITE — the delta assertion cannot fail, so it is not a check." >&2
    return 1
  fi

  echo
  echo "############################################################"
  echo "# mutation B — suppress the STATE arm of the delta stream."
  echo "#   -Dforge.deltasync=false is read by TestUtils, which sets"
  echo "#   RemoteClientGuiGame.useDeltaSync=false. The server then stops"
  echo "#   building state deltas but KEEPS sending applyDelta carrying"
  echo "#   DeltaPacket.eventsOnly(...), so a packet COUNT does not move."
  echo "#   Phase 2's 'at least one packet carried STATE' must FAIL."
  echo "#   (This mutation was first aimed at phase 1 and did not bite:"
  echo "#    49 packets arrived anyway. That is why the assertion exists.)"
  echo "############################################################"
  set +e
  do_capture -Dforge.deltasync=false -Dtierc.games=1
  rc=$?
  set -e
  echo "mutation B (state arm off): exit=$rc   [expected: non-zero]"
  if [[ "$rc" -eq 0 ]]; then
    echo "MUTATION B DID NOT BITE — the 'carried state' assertion cannot fail." >&2
    return 1
  fi

  echo
  echo "############################################################"
  echo "# mutation C — corrupt one decoded value in the JSON round trip."
  echo "#   -Dtierc.mutate=corrupt-value perturbs the FIRST decoded value"
  echo "#   in JsonDelta's decode path. The comparator must then report a"
  echo "#   mismatch and phase 2 must FAIL."
  echo "############################################################"
  set +e
  do_capture -Dtierc.mutate=corrupt-value -Dtierc.games=1
  rc=$?
  set -e
  echo "mutation C (corrupt-value): exit=$rc   [expected: non-zero]"
  if [[ "$rc" -eq 0 ]]; then
    echo "MUTATION C DID NOT BITE — the round-trip comparator cannot fail." >&2
    return 1
  fi

  echo
  echo "All three mutations bit. Re-run '$0 match' and '$0 capture' unmutated to restore."
}

mkdir -p "$WORK_DIR"

case "$MODE" in
  build)           shift || true; do_build ;;
  match)           shift || true; do_match "$@" ;;
  capture)         shift || true; do_capture "$@" ;;
  mutate)          shift || true; do_mutate ;;
  all)             do_build; do_match; do_capture; do_verify_pristine ;;
  verify-pristine) do_verify_pristine ;;
  *) echo "Unknown mode '$MODE'. Use build|match|capture|mutate|all|verify-pristine." >&2; exit 2 ;;
esac
