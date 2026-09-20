#!/usr/bin/env bash
#
# Wave 14, lane B -- CheerpJ go/no-go spike driver.
#
# Nothing here writes inside the repo or inside forge/ (decision D2). Everything
# it builds lands in $SPIKE_CACHE, default ~/.cache/w14b-cheerpj, and the static
# site it serves is assembled there from copies.
#
# The toolchain is off $PATH on purpose (decision D14): Temurin JDK 21 under
# ~/.local/opt. `which javac` finds nothing and that is not a missing toolchain.
#
# Usage:
#   ./run.sh build              compile the probes, stage the static site
#   ./run.sh serve              foreground static server on $PORT (ctrl-C to stop)
#   ./run.sh measure [probe]    launch headless Chromium at the page, print JSON
#                               probe = net (default) | swing | fs | natives | forgejar
#   ./run.sh all                build + measure net + measure swing
#
# `measure` starts and stops its own server, so `serve` is only for eyeballing
# the page in a real browser.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPIKE_CACHE="${SPIKE_CACHE:-$HOME/.cache/w14b-cheerpj}"
WWW="$SPIKE_CACHE/www"
PORT="${PORT:-8731}"

FORGE_JAR="${CARDTABLE_FORGE_JAR:-$HOME/.local/share/cardtable/forge.jar}"
JDK_HOME="${JDK_HOME:-$(ls -d "$HOME"/.local/opt/jdk-21* 2>/dev/null | head -1)}"

# playwright-core is not a dependency of this spike; it is already installed in
# the repo's pnpm store for the e2e suite and is used read-only. No pnpm command
# is run: lane D owns the node toolchain this wave.
PW_CORE="${PW_CORE:-$(ls -d "$HOME"/repos/hadoku-cardtable/node_modules/.pnpm/playwright-core@*/node_modules/playwright-core 2>/dev/null | tail -1)}"

use_toolchain() {
    if [[ -z "$JDK_HOME" || ! -x "$JDK_HOME/bin/javac" ]]; then
        echo "no JDK at \$JDK_HOME=$JDK_HOME -- see scripts/spike/run.sh bootstrap" >&2
        exit 1
    fi
    export JAVA_HOME="$JDK_HOME"
    export PATH="$JAVA_HOME/bin:$PATH"
}

cmd_build() {
    use_toolchain
    if [[ ! -f "$FORGE_JAR" ]]; then
        echo "no Forge jar at $FORGE_JAR -- see docs/FORGE_JAR.md" >&2
        exit 1
    fi
    rm -rf "$SPIKE_CACHE/classes"
    mkdir -p "$SPIKE_CACHE/classes" "$WWW"

    # --release 17 matches forge/pom.xml:27 (maven.compiler.release). CheerpJ 4.3
    # supports Java 8, 11 and 17; class files above 17 are out of its range, so the
    # probes must not be compiled at 21 even though the JDK is 21.
    javac --release 17 -nowarn -cp "$FORGE_JAR" -d "$SPIKE_CACHE/classes" \
        "$HERE"/java/spike/*.java
    "$JAVA_HOME/bin/jar" --create --file "$WWW/probe.jar" -C "$SPIKE_CACHE/classes" .

    cp -f "$HERE/index.html" "$WWW/index.html"
    cp -f "$FORGE_JAR" "$WWW/forge.jar"

    # SPIKE_WITH_SKINS=1 also stages res/skins (18 MB), which is what Forge's
    # SplashFrame needs before it will paint. Read-only, out of the repo, from the
    # vendored clone -- never built in, never written to (decision D2). The rest of
    # res/ (cardsfolder alone is 132 MB) is deliberately NOT staged: this spike
    # stops at "does the Swing UI paint", not "does a game start".
    if [[ "${SPIKE_WITH_SKINS:-0}" == "1" ]]; then
        local res="${CARDTABLE_FORGE_RES:-$HOME/repos/hadoku-cardtable/forge/forge-gui/res}"
        mkdir -p "$WWW/res"
        rm -rf "$WWW/res/skins"
        cp -a "$res/skins" "$WWW/res/skins"
        du -sh "$WWW/res/skins"
    fi
    ls -l "$WWW"
    echo "class file major version of the probe:"
    "$JAVA_HOME/bin/javap" -verbose -cp "$SPIKE_CACHE/classes" spike.NetProbe | grep -E '^  (major|minor)'
}

cmd_serve() {
    # NOT `python3 -m http.server`: it does not honour Range, and CheerpJ then
    # refuses to start ("HTTP server does not support the 'Range' header.
    # CheerpJ cannot run."). serve.mjs exists for exactly that reason.
    exec node "$HERE/serve.mjs" "$WWW" "$PORT"
}

cmd_measure() {
    local probe="${1:-net}"
    if [[ ! -f "$WWW/index.html" ]]; then
        echo "not staged -- run './run.sh build' first" >&2
        exit 1
    fi
    if [[ -z "$PW_CORE" || ! -d "$PW_CORE" ]]; then
        echo "no playwright-core found (\$PW_CORE=$PW_CORE)" >&2
        exit 1
    fi
    # stderr is kept when SPIKE_LOG_REQUESTS=1, so the Range-request transcript
    # in docs/spikes/cheerpj.md can be reproduced from this script alone.
    if [[ "${SPIKE_LOG_REQUESTS:-0}" == "1" ]]; then
        node "$HERE/serve.mjs" "$WWW" "$PORT" >/dev/null &
    else
        node "$HERE/serve.mjs" "$WWW" "$PORT" >/dev/null 2>&1 &
    fi
    local srv=$!
    trap 'kill '"$srv"' 2>/dev/null || true' EXIT
    # Wait for the port rather than sleeping a guessed interval.
    for _ in $(seq 1 50); do
        if curl -fs -o /dev/null "http://127.0.0.1:$PORT/index.html"; then break; fi
        sleep 0.2
    done
    PW_CORE="$PW_CORE" node "$HERE/measure.mjs" "http://127.0.0.1:$PORT/index.html?probe=$probe"
}

cmd_all() {
    cmd_build
    cmd_measure net
    cmd_measure swing
}

case "${1:-all}" in
    build)   cmd_build ;;
    serve)   cmd_serve ;;
    measure) shift; cmd_measure "$@" ;;
    all)     cmd_all ;;
    *) echo "unknown command: $1" >&2; exit 2 ;;
esac
