#!/usr/bin/env bash
#
# hadoku-cardtable Wave 8 lane B — capture real GameEvents and decode them to JSON.
#
# The same OVERLAY pattern as scripts/spike/tierc/run.sh, whose guards are copied
# here rather than sourced (this lane may not edit scripts/spike/**, and sourcing
# a script that dispatches on $1 at the bottom would run it). It compiles only
# the two .java files beside this script, against the stock fat jar plus the
# stock forge-gui-desktop test-classes, into $WORK_DIR. It writes nothing into
# FORGE_DIR and never builds: build a scratch Forge copy with
# `scripts/spike/tierc/run.sh build` first.
#
# Usage:
#   FORGE_DIR=/path/to/built-forge-copy WORK_DIR=/tmp/x OUT_DIR=/tmp/y \
#     bash packages/forge-wire/src/events/capture/run.sh [-D...]
#
#   -Devents.games=N       games to play (default 1; 0 = merge only)
#   -Devents.samples=N     fixture cap per class (default 12)
#   -Devents.decks=A,B,..  seat these quest precons first (host, remote, ...)
#   -Devents.merge=D1,D2   fold earlier OUT_DIRs' census + events into this one
#
# OUT_DIR receives events.ndjson (every decoded event — tens of MB, scratch
# only), census.json and fixtures/<Class>.json. The run exits non-zero if any
# wrapped item fails to decode, any value falls to the UNKNOWN rule, or our
# per-class histogram differs from stock Forge's own unwrap.
#
# The committed fixtures/ were produced by exactly this sequence (random
# precons, so a re-run fires a slightly different set of classes):
#
#   run.sh -Devents.games=40                                      # OUT_DIR=A
#   run.sh -Devents.games=60 \
#     "-Devents.decks=Draconic Rage,Dungeons of Death,Planar Portal,Aura of Courage"   # OUT_DIR=B
#   run.sh -Devents.games=0 -Devents.merge=A,B                    # OUT_DIR=M
#   node packages/forge-wire/src/events/capture/validate-dump.ts A/events.ndjson  # and B
#   cp M/census.json M/fixtures/*.json packages/forge-wire/src/events/fixtures/
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../../.." && pwd -P)"
WORK_DIR="${WORK_DIR:?set WORK_DIR to a scratch directory}"
OUT_DIR="${OUT_DIR:?set OUT_DIR to a scratch directory}"

if [[ -z "${JAVA_HOME:-}" ]]; then
  JAVA_HOME="$(ls -d "$HOME"/.local/opt/jdk-21* 2>/dev/null | head -1 || true)"
fi
[[ -n "$JAVA_HOME" && -x "$JAVA_HOME/bin/javac" ]] || { echo "No JDK 21 (javac) — set JAVA_HOME; see ~/.local/opt." >&2; exit 2; }

[[ -n "${FORGE_DIR:-}" ]] || { echo "FORGE_DIR is not set (a BUILT scratch copy, never the vendored forge/)." >&2; exit 2; }
FORGE_DIR="$(cd "$FORGE_DIR" && pwd -P)"
if [[ -e "$REPO/forge" && "$FORGE_DIR" == "$(cd "$REPO/forge" && pwd -P)" ]]; then
  echo "FORGE_DIR is the vendored forge/ tree ($FORGE_DIR). Refusing: it must stay pristine." >&2
  exit 2
fi

JAR="$(ls -1 "$FORGE_DIR"/forge-gui-desktop/target/forge-gui-desktop-*-jar-with-dependencies.jar 2>/dev/null | head -1 || true)"
[[ -n "$JAR" ]] || { echo "No fat jar under $FORGE_DIR. Run scripts/spike/tierc/run.sh build first." >&2; exit 1; }
TC="$FORGE_DIR/forge-gui-desktop/target/test-classes"
[[ -d "$TC/forge/net" ]] || { echo "No compiled net harness at $TC/forge/net." >&2; exit 1; }

mkdir -p "$WORK_DIR" "$OUT_DIR"
CLASSES="$WORK_DIR/classes"
rm -rf "$CLASSES"; mkdir -p "$CLASSES"
"$JAVA_HOME/bin/javac" -Xlint:all -Werror -Xlint:-processing -Xlint:-serial -cp "$JAR:$TC" -d "$CLASSES" "$HERE"/*.java

# Forge resolves res/ relative to the working directory (see tierc/run.sh).
RUN="$WORK_DIR/run"
rm -rf "$RUN"; mkdir -p "$RUN/user/decks/constructed" "$RUN/cache"
ln -s "$FORGE_DIR/forge-gui/res" "$RUN/res"
cat > "$RUN/forge.profile.properties" <<PROPS
userDir=$RUN/user/
cacheDir=$RUN/cache/
decksDir=$RUN/user/decks/
decksConstructedDir=$RUN/user/decks/constructed/
PROPS

cd "$RUN"
exec "$JAVA_HOME/bin/java" -Djava.awt.headless=true -Dsentry.dsn= -Devents.outDir="$OUT_DIR" "$@" \
  -cp "$JAR:$TC:$CLASSES" hadoku.events.EventCapture
