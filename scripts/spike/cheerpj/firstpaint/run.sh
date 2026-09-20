#!/usr/bin/env bash
#
# Wave 15, lane D -- click-to-pixel rig for CheerpJ.
#
# Self-contained: it uses its OWN cache and its OWN port because three other
# lanes drive the shared CheerpJ harness in the same worktree at the same time.
# It reads scripts/spike/cheerpj/serve.mjs (which honours Range -- CheerpJ will
# not start without that) but never writes to it; every file this lane owns is
# under scripts/spike/cheerpj/firstpaint/.
#
# Nothing here writes inside the repo or inside forge/ (decision D2).
# The toolchain is off $PATH on purpose (decision D14): Temurin JDK 21 lives
# under ~/.local/opt and `which javac` finding nothing is not a missing JDK.
#
# Usage:
#   ./run.sh build                 compile PaintProbe, stamp a build id, stage
#   ./run.sh serve                 foreground static server (eyeball it)
#   ./run.sh measure [args...]     the click-to-pixel run  (n=40, 50 ms hold)
#                                  FP_MODE=release makes the Java target act on
#                                  the mouse RELEASE, as Forge's Swing UI does
#                                  (docs/spikes/streaming.md), so the number is
#                                  press->pixel with the hold inside it.
#   ./run.sh control-noclick       NEGATIVE CONTROL: sampler runs, no click
#   ./run.sh control-nolistener    NEGATIVE CONTROL: clicks land, Java ignores
#   ./run.sh control-noise         NEGATIVE CONTROL: canvas moves on its own
#   ./run.sh coldload              cold-cache byte and time cost of the runtime
#   ./run.sh forgejar [args...]    point the rig at Forge's own main()
#
# Extra args after `measure` / `forgejar` go straight to clicktopixel.mjs, e.g.
#   ./run.sh measure --reps 40 --hold 100
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARED="$(cd "$HERE/.." && pwd)"
SPIKE_CACHE="${SPIKE_CACHE:-$HOME/.cache/w15d-firstpaint}"
WWW="$SPIKE_CACHE/www"
PORT="${PORT:-8743}"

FORGE_JAR="${CARDTABLE_FORGE_JAR:-$HOME/.local/share/cardtable/forge.jar}"
JDK_HOME="${JDK_HOME:-$(ls -d "$HOME"/.local/opt/jdk-21* 2>/dev/null | head -1)}"
PW_CORE="${PW_CORE:-$(ls -d "$HOME"/repos/hadoku-cardtable/node_modules/.pnpm/playwright-core@*/node_modules/playwright-core 2>/dev/null | tail -1)}"

use_toolchain() {
    if [[ -z "$JDK_HOME" || ! -x "$JDK_HOME/bin/javac" ]]; then
        echo "no JDK at \$JDK_HOME=$JDK_HOME -- look in ~/.local/opt (decision D14)" >&2
        exit 1
    fi
    export JAVA_HOME="$JDK_HOME"
    export PATH="$JAVA_HOME/bin:$PATH"
}

cmd_build() {
    use_toolchain
    rm -rf "$SPIKE_CACHE/classes"
    mkdir -p "$SPIKE_CACHE/classes" "$WWW"

    # A build id derived from the SOURCES, not from the clock alone, so a run
    # whose number did not move can be checked against the build it ran: the
    # probe prints this id and the harness log carries it. "Prove the thing you
    # changed was built before you report it."
    local srchash
    srchash="$(cat "$HERE"/java/spike/*.java "$HERE/index.html" "$HERE/rig.js" | sha1sum | cut -c1-10)"
    local buildid="$(date -u +%Y%m%dT%H%M%SZ)-$srchash"

    # --release 17: CheerpJ 4.3 refuses class files above major 61, and Forge is
    # built at 17 (forge/pom.xml:27).
    javac --release 17 -nowarn -d "$SPIKE_CACHE/classes" "$HERE"/java/spike/*.java
    echo "javac exit=$?"
    "$JAVA_HOME/bin/jar" --create --file "$WWW/firstpaint.jar" -C "$SPIKE_CACHE/classes" .

    cp -f "$HERE/index.html" "$WWW/index.html"
    cp -f "$HERE/rig.js" "$WWW/rig.js"
    printf '%s' "$buildid" > "$WWW/BUILDID"
    if [[ -f "$FORGE_JAR" ]]; then cp -f "$FORGE_JAR" "$WWW/forge.jar"; else
        echo "note: no Forge jar at $FORGE_JAR -- the paint probe does not need it" >&2
    fi

    echo "BUILDID=$buildid"
    ls -l --time-style=full-iso "$WWW"
    echo "source mtimes (must PRE-date the jar above):"
    ls -l --time-style=full-iso "$HERE"/java/spike/*.java "$HERE/index.html"
    echo "class file major version:"
    "$JAVA_HOME/bin/javap" -verbose -cp "$SPIKE_CACHE/classes" spike.PaintProbe | grep -E '^  (major|minor)'
}

require_staged() {
    if [[ ! -f "$WWW/index.html" || ! -f "$WWW/rig.js" || ! -f "$WWW/firstpaint.jar" ]]; then
        echo "not staged -- run './run.sh build' first" >&2; exit 1
    fi
    if [[ -z "$PW_CORE" || ! -d "$PW_CORE" ]]; then
        echo "no playwright-core found (\$PW_CORE=$PW_CORE)" >&2; exit 1
    fi
}

start_server() {
    node "$SHARED/serve.mjs" "$WWW" "$PORT" >/dev/null 2>&1 &
    SRV=$!
    trap 'kill '"$SRV"' 2>/dev/null || true' EXIT
    local i
    for i in $(seq 1 60); do
        if curl -fs -o /dev/null "http://127.0.0.1:$PORT/index.html"; then return 0; fi
        sleep 0.2
    done
    echo "server never answered on port $PORT" >&2; exit 1
}

drive() {   # drive <query-string> [driver args...]
    require_staged
    start_server
    local qs="$1"; shift
    local build; build="$(cat "$WWW/BUILDID" 2>/dev/null || echo unknown)"
    PW_CORE="$PW_CORE" node "$HERE/clicktopixel.mjs" \
        "http://127.0.0.1:$PORT/index.html?build=$build&$qs" "$@"
}

cmd_serve()   { exec node "$SHARED/serve.mjs" "$WWW" "$PORT"; }
cmd_measure() { drive "target=paint&mode=${FP_MODE:-normal}" --reps 40 --hold 50 "$@"; }
cmd_forgejar(){ drive 'target=forgejar' --ready "${FP_READY:-FORGE-READY}" "$@"; }

# --- negative controls -----------------------------------------------------
# Each makes the thing being measured NOT happen, in a different place, and the
# rig must report that rather than a number. All three must exit 1.
cmd_control_noclick()    { drive 'target=paint&mode=normal'     --reps 3 --no-click "$@"; }
cmd_control_nolistener() { drive 'target=paint&mode=nolistener' --reps 3 "$@"; }
cmd_control_noise()      { drive 'target=paint&mode=noise'      --reps 3 "$@"; }

cmd_coldload() {
    require_staged
    start_server
    local build; build="$(cat "$WWW/BUILDID" 2>/dev/null || echo unknown)"
    PW_CORE="$PW_CORE" node "$HERE/coldload.mjs" \
        "http://127.0.0.1:$PORT/index.html?build=$build&target=paint&mode=normal" "$@"
}

case "${1:-measure}" in
    build)              cmd_build ;;
    serve)              cmd_serve ;;
    measure)            shift || true; cmd_measure "$@" ;;
    forgejar)           shift || true; cmd_forgejar "$@" ;;
    control-noclick)    shift || true; cmd_control_noclick "$@" ;;
    control-nolistener) shift || true; cmd_control_nolistener "$@" ;;
    control-noise)      shift || true; cmd_control_noise "$@" ;;
    coldload)           shift || true; cmd_coldload "$@" ;;
    *) echo "unknown command: $1" >&2; exit 2 ;;
esac
