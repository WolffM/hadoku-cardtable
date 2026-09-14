#!/usr/bin/env bash
#
# hadoku-cardtable PR-4 spike (Wave 2, lane D) — does Forge start headless?
#
# An OVERLAY. It writes nothing into the Forge checkout's source tree; Maven's
# own target/ dirs are the only thing it creates there, which is why you should
# point it at a scratch copy and not at the repo's vendored forge/ (see D2/O1:
# the fork does not exist yet, so forge/ stays byte-for-byte stock).
#
# Usage:
#   FORGE_DIR=/path/to/forge ./run.sh <build|sim|protocol|all>
#
#   build     mvn install of the narrowest module set that yields SimulateMatch
#   sim       run `Main sim` — Forge's one implemented headless entry point
#   server    run `Main server` — the arm this spike is about
#   protocol  dump ProtocolMethod by reflection (authoritative method count)
#   all       build, then protocol, then sim, then server
#   verify-pristine
#             assert the repo's vendored forge/ is untouched (the point of the
#             scratch copy). Pass VENDORED_FORGE=/path to override.
#
# Environment:
#   FORGE_DIR   Forge checkout to build in. Required; no default, because the
#               obvious default is the vendored tree and that must stay clean.
#   JAVA_HOME   A JDK 21. Required: on hokon the JVM on PATH is a Debian JRE
#               with no javac, and Maven then fails with the misleading
#               "release version 17 not supported".
#   WORK_DIR    Scratch run directory (deck store, Forge profile, logs).
#               Default: ${TMPDIR:-/tmp}/forge-headless-spike
#
set -euo pipefail

MODE="${1:-all}"

if [[ -z "${FORGE_DIR:-}" ]]; then
  echo "FORGE_DIR is not set. Point it at a Forge checkout you are willing to" >&2
  echo "let Maven write target/ dirs into — NOT the repo's vendored forge/." >&2
  exit 2
fi
FORGE_DIR="$(cd "$FORGE_DIR" && pwd)"

if [[ -z "${JAVA_HOME:-}" ]]; then
  echo "JAVA_HOME is not set. A JDK 21 is required (a JRE is not enough: the" >&2
  echo "maven-compiler-plugin reports 'release version 17 not supported' when" >&2
  echo "it cannot find javac)." >&2
  exit 2
fi
JAVAC="$JAVA_HOME/bin/javac"
JAVA="$JAVA_HOME/bin/java"
[[ -x "$JAVAC" ]] || { echo "No javac at $JAVAC — that is a JRE, not a JDK." >&2; exit 2; }

MVN="${MVN:-mvn}"
WORK_DIR="${WORK_DIR:-${TMPDIR:-/tmp}/forge-headless-spike}"
SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The version string has no "git" in it, so GuiDesktop.getAssetsDir() returns
# "" and ForgeConstants.RES_DIR resolves to "res/" relative to the working
# directory. Hence: run from a directory whose res/ is Forge's.
FATJAR_GLOB="$FORGE_DIR/forge-gui-desktop/target/forge-gui-desktop-*-jar-with-dependencies.jar"

fatjar() {
  # shellcheck disable=SC2086
  local j
  j=$(ls -1 $FATJAR_GLOB 2>/dev/null | head -1 || true)
  [[ -n "$j" ]] || { echo "No fat jar found. Run '$0 build' first." >&2; exit 1; }
  echo "$j"
}

do_build() {
  echo "==> build: mvn install -pl forge-gui-desktop -am -DskipTests"
  ( cd "$FORGE_DIR" && "$MVN" -B install -pl forge-gui-desktop -am -DskipTests -Dmaven.javadoc.skip=true )
}

do_protocol() {
  local jar out
  jar="$(fatjar)"
  out="$WORK_DIR/protocol"
  mkdir -p "$out"
  echo "==> protocol: reflecting over forge.gamemodes.net.ProtocolMethod"
  "$JAVAC" -cp "$jar" -d "$out" "$SPIKE_DIR/src/ProtocolDump.java"
  "$JAVA" -cp "$jar:$out" ProtocolDump
}

# Stage a throwaway Forge profile + deck store so the sim does not write into
# the user's real ~/.forge, and so the run is reproducible from nothing.
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
  # Two shipped quest precons — real 60-card constructed decks, no card images
  # involved. Any two .dck under res/quest/precons/ would do.
  cp "$FORGE_DIR/forge-gui/res/quest/precons/Abzan Siege.dck" "$run/user/decks/constructed/"
  cp "$FORGE_DIR/forge-gui/res/quest/precons/Air Forces.dck" "$run/user/decks/constructed/"
  echo "$run"
}

do_sim() {
  local jar run
  jar="$(fatjar)"
  run="$(stage_run_dir)"
  echo "==> sim: forge.view.Main sim -d 'Abzan Siege.dck' 'Air Forces.dck' -n 1 -s 1234 -q"
  # -Djava.awt.headless=true: Main forces it for command-line modes anyway, set
  #   here so the run does not depend on that staying true.
  # SENTRY_DSN/sentry.dsn: Main.main() calls Sentry.init with upstream's
  #   hardcoded DSN before it ever reads the mode argument. Nothing here can
  #   stop that from the outside; see the doc. This at least does not add one.
  ( cd "$run" && "$JAVA" \
      -Djava.awt.headless=true \
      -Dsentry.dsn= \
      -cp "$jar" forge.view.Main sim -d "Abzan Siege.dck" "Air Forces.dck" -n 1 -s 1234 -q )
}

do_server() {
  local jar run
  jar="$(fatjar)"
  run="$WORK_DIR/run"
  [[ -d "$run" ]] || run="$(stage_run_dir)"
  echo "==> server: forge.view.Main server"
  ( cd "$run" && "$JAVA" -Djava.awt.headless=true -cp "$jar" forge.view.Main server )
}

do_verify_pristine() {
  local vendored="${VENDORED_FORGE:-$(cd "$SPIKE_DIR/../../.." && pwd)/forge}"
  echo "==> verify-pristine: $vendored"
  if [[ ! -d "$vendored/.git" ]]; then
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
  build)            do_build ;;
  sim)              do_sim ;;
  server)           do_server ;;
  protocol)         do_protocol ;;
  verify-pristine)  do_verify_pristine ;;
  all)              do_build; do_protocol; do_sim; do_server ;;
  *) echo "Unknown mode '$MODE'. Use build|sim|server|protocol|verify-pristine|all." >&2; exit 2 ;;
esac
