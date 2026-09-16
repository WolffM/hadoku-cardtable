#!/usr/bin/env bash
#
# hadoku-cardtable PR-4 spike 2 (Wave 6, lane F) — drive one real IToClient
# call across a real socket.
#
# An OVERLAY, in the pattern Waves 1 and 3 both used. It writes no Java into
# the Forge checkout: the only thing it compiles is scripts/spike/itoclient/src,
# and it compiles that against the stock fat jar plus the stock forge-gui-desktop
# test-classes. Maven's own target/ dirs are the only thing it creates in
# FORGE_DIR, which is why FORGE_DIR must be a SCRATCH COPY and never the repo's
# vendored forge/ (D2/O1: the fork does not exist yet, so forge/ stays
# byte-for-byte stock).
#
# Usage:
#   FORGE_DIR=/path/to/forge-copy ./run.sh <build|spike|all|verify-pristine>
#
#   build             mvn install of forge-gui-desktop (-DskipTests still
#                     COMPILES src/test/java/forge/net, which is the harness)
#   spike             compile + run IToClientSpike against the built tree
#   all               build, then spike, then verify-pristine
#   verify-pristine   assert the repo's vendored forge/ is untouched
#
# Environment:
#   FORGE_DIR   Forge checkout to build in. Required; no default, because the
#               obvious default is the vendored tree and that must stay clean.
#   JAVA_HOME   A JDK 21. Defaults to the user-local Temurin that Wave 1 lane B
#               installed under ~/.local/opt (decision D14) — `java` on PATH is
#               a Debian JRE with no javac, and Maven then fails with the
#               misleading "release version 17 not supported".
#   WORK_DIR    Scratch run directory. Default:
#               ${TMPDIR:-/tmp}/cardtable-itoclient-spike
#
set -euo pipefail

MODE="${1:-all}"
SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="${WORK_DIR:-${TMPDIR:-/tmp}/cardtable-itoclient-spike}"

# Wave 1 lane B put a real JDK here; `which javac` finds nothing because it is
# not on PATH, which is what makes "there is no compiler on this host" a
# tempting and wrong conclusion.
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
  # STRING comparison — so from a git worktree, where `forge/` is a symlink to
  # the main checkout, `<worktree>/forge` never equalled `<main>/forge` and the
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
# PortAllocator) lives in forge-gui-desktop's TEST sources. `-DskipTests` skips
# RUNNING tests but still compiles them, so an ordinary build produces these.
# None of the four imports testng or junit, so the fat jar is the only other
# thing on the classpath.
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

do_spike() {
  need_forge_dir
  local jar tc out run
  jar="$(fatjar)"
  tc="$(testclasses)"
  out="$WORK_DIR/classes"
  rm -rf "$out"; mkdir -p "$out"

  echo "==> compile: $SPIKE_DIR/src/IToClientSpike.java"
  "$JAVAC" -cp "$jar:$tc" -d "$out" "$SPIKE_DIR/src/IToClientSpike.java"

  run="$(stage_run_dir)"
  echo "==> run: spike.IToClientSpike"
  # -Djava.awt.headless=true: nothing here opens a window; assert it.
  # -Dsentry.dsn=: Main.main() is not the entry point here, so upstream's
  #   hardcoded DSN is never initialised — set anyway so the run adds none.
  ( cd "$run" && "$JAVA" \
      -Djava.awt.headless=true \
      -Dsentry.dsn= \
      -cp "$jar:$tc:$out" spike.IToClientSpike )
}

do_verify_pristine() {
  local vendored="${VENDORED_FORGE:-$(cd "$SPIKE_DIR/../../.." && pwd)/forge}"
  echo "==> verify-pristine: $vendored"
  if [[ ! -e "$vendored/.git" ]]; then
    echo "No git checkout at $vendored — nothing to verify." >&2
    return 0
  fi
  local dirty
  dirty=$(git -C "$vendored" status --porcelain)
  if [[ -n "$dirty" ]]; then
    echo "DIRTY — this spike was supposed to build in a copy:" >&2
    echo "$dirty" >&2
    exit 1
  fi
  echo "clean; HEAD $(git -C "$vendored" rev-parse HEAD)"
}

mkdir -p "$WORK_DIR"

case "$MODE" in
  build)           do_build ;;
  spike)           do_spike ;;
  all)             do_build; do_spike; do_verify_pristine ;;
  verify-pristine) do_verify_pristine ;;
  *) echo "Unknown mode '$MODE'. Use build|spike|all|verify-pristine." >&2; exit 2 ;;
esac
