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
#   ./run.sh stage-forge           stage the PATCHED Forge jar + res-boot.zip
#   ./run.sh explore [--step ...]  boot Forge and look at it (screenshots)
#   ./run.sh forge-measure [args]  click-to-pixel against Forge's own UI
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
    # Lane B's Bootstrap is compiled FROM ITS OWN SOURCE PATH into this lane's
    # jar. It is read, never copied and never edited: the unpack-into-/files/
    # route is lane B's finding and duplicating the file would let the two
    # copies drift. -cp the Forge jar because Bootstrap reflects onto
    # forge.view.Main.
    javac --release 17 -nowarn -cp "$FORGE_JAR" -d "$SPIKE_CACHE/classes" \
        "$HERE"/java/spike/*.java \
        "$SHARED"/assets/java/spike/Bootstrap.java "$SHARED"/assets/java/spike/XStreamProbe.java
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

# --- Forge under CheerpJ ----------------------------------------------------
#
# The patched jar is built by lane B's driver pointed at THIS lane's cache
# (SPIKE_CACHE is its own env var), with lane B's three patches plus this
# lane's patches/ applied on top. See docs/spikes/cheerpj-firstpaint.md.
#
# Trap 7: lane B's build-forge wrapper returns 0 on BUILD FAILURE. Never trust
# its exit code -- grep maven's own line, which is what forge_jar() does.
PATCHED_JAR="$SPIKE_CACHE/forge-patched/forge-gui-desktop/target/forge-gui-desktop-2.0.15-SNAPSHOT-jar-with-dependencies.jar"

cmd_stage_forge() {
    if ! grep -q '^\[INFO\] BUILD SUCCESS' "$SPIKE_CACHE/forge-build.log" 2>/dev/null; then
        echo "no 'BUILD SUCCESS' in $SPIKE_CACHE/forge-build.log -- the jar is stale or absent" >&2
        exit 1
    fi
    [[ -f "$PATCHED_JAR" ]] || { echo "no patched jar at $PATCHED_JAR" >&2; exit 1; }
    [[ -f "$SPIKE_CACHE/zipbuild/res-boot.zip" ]] || { echo "no res-boot.zip in $SPIKE_CACHE/zipbuild" >&2; exit 1; }
    mkdir -p "$WWW"
    cp -f "$PATCHED_JAR" "$WWW/forge.jar"
    cp -f "$SPIKE_CACHE/zipbuild/res-boot.zip" "$WWW/res-boot.zip"
    ls -l --time-style=full-iso "$WWW/forge.jar" "$WWW/res-boot.zip"
    echo "patch proof -- FView must NOT reference VBazaarUI:"
    "$JDK_HOME/bin/javap" -p -c -cp "$WWW/forge.jar" forge.view.FView 2>/dev/null \
        | grep -c 'VBazaarUI' || true
}

# Query string for the Forge boot, shared by explore and measure.
forge_qs() {
    local wipe=""
    [[ "${FP_WIPE:-0}" == "1" ]] && wipe="&wipe=1"
    local nat=""
    [[ -n "${FP_NATIVES:-}" ]] && nat="&natives=$FP_NATIVES"
    local build; build="$(cat "$WWW/BUILDID" 2>/dev/null || echo unknown)"
    echo "build=$build&target=boot&w=${FP_W:-1280}&h=${FP_H:-800}$wipe$nat"\
"&args=/app/res-boot.zip%7C/files/%7Cforge.view.Main"\
"&props=user.dir%3D/files/%7Cuser.home%3D/files%7Cforge.assetsDir%3D/files/${FP_PROPS:+%7C$FP_PROPS}"
}

# Lane B's XStream probe, run through THIS lane's harness so the natives
# binding can be tested. FP_NATIVES=unsafe binds Java_jdk_internal_misc_Unsafe_*;
# XS_VENDOR sets java.vm.vendor, which is null under CheerpJ and is the FIRST of
# the two stacked causes lane B found.
cmd_probe_xstream() {
    require_staged
    start_server
    local build; build="$(cat "$WWW/BUILDID" 2>/dev/null || echo unknown)"
    local nat=""
    [[ -n "${FP_NATIVES:-}" ]] && nat="&natives=$FP_NATIVES"
    local a=""
    [[ -n "${XS_VENDOR:-}" ]] && a="&args=$(printf %s "$XS_VENDOR" | sed 's/ /%20/g')"
    PW_CORE="$PW_CORE" node "$HERE/explore.mjs" \
        "http://127.0.0.1:$PORT/index.html?build=$build&target=main&main=${XS_MAIN:-spike.XStreamProbe}$a$nat" \
        --ready "${XS_READY:-XS VERDICT}" --budget 180000 --tail 80 \
        --shot-dir "$SPIKE_CACHE/shots" "$@"
}

cmd_explore() {
    require_staged
    start_server
    PW_CORE="$PW_CORE" node "$HERE/explore.mjs" \
        "http://127.0.0.1:$PORT/index.html?$(forge_qs)" \
        --shot-dir "$SPIKE_CACHE/shots" "$@"
}

# Click-to-pixel against Forge's OWN UI.
#
# The pre-navigation is Wave 14 lane C's route through the streamed desktop,
# replayed here: dismiss Forge's first-run card-image dialog, pick a random
# deck, Start. Coordinates are CANVAS coordinates at the 800x600 the document
# frame comes up at (FView.java sets that as its minimum size), read off
# $SPIKE_CACHE/shots/41-dialog-gone.png.
#
# The last click is "Ignore" on Forge's "Invalid Deck" dialog: Random Deck can
# land on a preconstructed deck that fails Forge's own legality check ("must not
# contain more than 0 copies of the card Gleemox") and Forge asks before
# starting. That is a normal game-rules prompt, not an error, and it only
# appears for some decks -- so the click is a no-op when it is absent.
#
# awaitcanvas is what makes it deterministic: under CheerpJ every AWT window is
# its own canvas, so the splash (450x450) giving way to the document frame
# (800x600) is the signal that the home screen exists. A fixed sleep either
# races the boot or throws minutes away -- the boot's duration moves ~8x with
# host load.
#
# FP_TARGET / FP_WATCH override what is clicked and watched once a match is up.
#
# The click at 48,576 after shot:match answers Forge's game-setup prompt, and
# the measurement is taken at the MULLIGAN prompt that follows it -- hand dealt,
# board static, nothing running. Both facts were paid for:
#
#   - Stopping BEFORE that click measures the coin-toss screen, where the hand
#     is still EMPTY. The clicks land on a bare hand panel, nothing repaints,
#     and the rig refuses with NO-CHANGE-ON-WARMUP, changedPixels 0.
#   - Clicking TWICE answers the mulligan too and starts the game. A live game
#     is not a quiet baseline: the AI takes its turn, and the watch strip showed
#     25-51 changed pixels BEFORE every click, so the rig refused 39 of 40 reps
#     with NOISY-BASELINE. That is the Phase 1 control firing on a real target.
#
# Which question Forge asks first is not deterministic -- winning the coin toss
# gives Play/Draw, losing it goes straight to Keep/Mulligan -- and both render
# their first button at this coordinate. So one click lands on the mulligan
# prompt when we won the toss, and in a live game when we lost it. The second
# case is visible as NOISY-BASELINE drops, and the run is simply repeated.
# Pinning a deck and a seed would remove the coin flip; that was not done.
cmd_forge_measure() {
    require_staged
    start_server
    PW_CORE="$PW_CORE" node "$HERE/clicktopixel.mjs" \
        "http://127.0.0.1:$PORT/index.html?$(forge_qs)" \
        --ready "${FP_READY:-Read cards:}" --boot-budget 900000 \
        --pre awaitcanvas:800x600,900000 \
        --pre wait:8000 \
        --pre shot:home \
        --pre click:485,380 \
        --pre wait:15000 \
        --pre click:702,460 \
        --pre wait:20000 \
        --pre click:407,543 \
        --pre wait:45000 \
        --pre shot:after-start \
        --pre click:338,362 \
        --pre wait:90000 \
        --pre shot:match \
        --pre click:48,576 \
        --pre wait:20000 \
        --pre shot:hand \
        --screenshot "$SPIKE_CACHE/shots/measure.png" \
        --reps 40 --hold 50 --jitter 25 --budget 8000 "$@"
}
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
    stage-forge)        cmd_stage_forge ;;
    explore)            shift || true; cmd_explore "$@" ;;
    probe-xstream)      shift || true; cmd_probe_xstream "$@" ;;
    forge-measure)      shift || true; cmd_forge_measure "$@" ;;
    serve)              cmd_serve ;;
    measure)            shift || true; cmd_measure "$@" ;;
    forgejar)           shift || true; cmd_forgejar "$@" ;;
    control-noclick)    shift || true; cmd_control_noclick "$@" ;;
    control-nolistener) shift || true; cmd_control_nolistener "$@" ;;
    control-noise)      shift || true; cmd_control_noise "$@" ;;
    coldload)           shift || true; cmd_coldload "$@" ;;
    *) echo "unknown command: $1" >&2; exit 2 ;;
esac
