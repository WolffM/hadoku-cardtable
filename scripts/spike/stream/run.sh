#!/usr/bin/env bash
# Streaming spike (wave 14, lane C): cost one streamed Forge match honestly.
#
# THIS BUILDS NOTHING THE PRODUCT USES. It exists so every number in
# docs/spikes/streaming.md came from something that ran. Read that doc first.
#
#   ./run.sh build                 build the container image, print its size
#   ./run.sh up [N]                start N match containers (default 1)
#   ./run.sh prep [N]              dismiss Forge's first-run dialog, fill the screen
#   ./run.sh boot                  time a cold container to a usable Forge window
#   ./run.sh cost [N]              RAM / CPU / disk for N running containers
#   ./run.sh latency-rfb [i]       click-to-pixel over the VNC wire, container i
#   ./run.sh latency-xvfb          click-to-pixel at the X server, host Xvfb
#   ./run.sh host-forge            Forge desktop on a host Xvfb (for latency-xvfb)
#   ./run.sh host-prep             same first-run cleanup, for the host copy
#   ./run.sh down                  stop and remove everything this script started
#
# Host safety, because hokon runs 24 PM2 services (including production
# cardtable) and is this repo's CI runner:
#   - display :90 and ports 5990+/6090+ are checked free before use
#   - nothing is written under /tmp/cardtable-play (that is production's)
#   - `down` kills every process and container this script starts
set -euo pipefail

IMAGE=cardtable-stream-spike:w14
NAME_PREFIX=ct-stream
DISPLAY_NUM=${DISPLAY_NUM:-90}
VNC_BASE=${VNC_BASE:-5990}
WEB_BASE=${WEB_BASE:-6090}
FORGE_JAR=${FORGE_JAR:-$HOME/.local/share/cardtable/forge.jar}
FORGE_RES=${FORGE_RES:-$HOME/repos/hadoku-cardtable/forge/forge-gui/res}
WORK=${WORK:-$HOME/.cache/w14-stream}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Screen coordinates of the two left-menu entries we alternate between, and of
# the panel heading that changes when you do. Valid for Forge 2.0.15 at
# 1280x800 with the window filling the screen. Re-derive them from a screenshot
# if the UI moves; nothing here guesses.
CLICK_A=68,253      # "Constructed"
CLICK_B=71,285      # "Booster Draft"
WATCH=420,50,520,30 # "Sanctioned Format: ..." heading
DIALOG_OK=485,379   # "Not Now" on the card-image download prompt. NOT "Download Now".

die() { echo "$*" >&2; exit 1; }
port_free() { ! ss -ltn "sport = :$1" | grep -q LISTEN; }

cmd_build() {
    [ -f "$FORGE_JAR" ] || die "no Forge jar at $FORGE_JAR"
    docker build -t "$IMAGE" "$HERE"
    echo
    echo "image size (docker image inspect .Size, bytes): $(docker image inspect "$IMAGE" --format '{{.Size}}')"
    docker history "$IMAGE" --format '{{.Size}}\t{{.CreatedBy}}' | head -8
}

cmd_up() {
    local n=${1:-1} i vnc web
    [ -f "$FORGE_JAR" ] || die "no Forge jar at $FORGE_JAR"
    [ -d "$FORGE_RES" ] || die "no Forge res at $FORGE_RES"
    for ((i = 0; i < n; i++)); do
        vnc=$((VNC_BASE + i)); web=$((WEB_BASE + i))
        port_free "$vnc" || die "port $vnc is in use - pick another VNC_BASE"
        port_free "$web" || die "port $web is in use - pick another WEB_BASE"
        docker run -d --name "$NAME_PREFIX-$i" \
            -p "127.0.0.1:$vnc:5900" -p "127.0.0.1:$web:6080" \
            -v "$FORGE_JAR:/opt/forge/forge.jar:ro" \
            -v "$FORGE_RES:/opt/forge/res:ro" \
            "$IMAGE" >/dev/null
        echo "$NAME_PREFIX-$i up: vnc 127.0.0.1:$vnc, noVNC http://127.0.0.1:$web/vnc.html"
        # Stagger: Forge's card-database boot burns most of a core, and six of
        # them starting together measures the thundering herd, not a match.
        sleep 20
    done
}

# Forge's first run asks whether to download the card-image index, and opens at
# 800x600 on a 1280x800 screen. A player would not stream that, so neither do we.
cmd_prep() {
    local n=${1:-1} i win
    for ((i = 0; i < n; i++)); do
        # shellcheck disable=SC2086  # "x,y" must split into two xdotool args
        docker exec -e DISPLAY=:1 "$NAME_PREFIX-$i" xdotool mousemove ${DIALOG_OK/,/ } click 1 || true
        sleep 2
        win=$(docker exec -e DISPLAY=:1 "$NAME_PREFIX-$i" \
              xdotool search --onlyvisible --name '^Forge: ' | head -1)
        [ -n "$win" ] || die "$NAME_PREFIX-$i has no Forge window"
        docker exec -e DISPLAY=:1 "$NAME_PREFIX-$i" xdotool windowmove "$win" 0 0 windowsize "$win" 1280 800
        echo "$NAME_PREFIX-$i prepped (window $win)"
    done
    sleep 3
}

# Cold start: `docker run` to a Forge window that answers RFB. This is what a
# player waits through when a match is created, unless something keeps a
# container warm the way apps/server's JVM pool keeps a spare.
cmd_boot() {
    local t0 t_window t_rfb
    port_free "$VNC_BASE" || die "port $VNC_BASE is in use"
    docker rm -f "$NAME_PREFIX-boot" >/dev/null 2>&1 || true
    t0=$(date +%s.%N)
    docker run -d --name "$NAME_PREFIX-boot" -p "127.0.0.1:$VNC_BASE:5900" \
        -v "$FORGE_JAR:/opt/forge/forge.jar:ro" -v "$FORGE_RES:/opt/forge/res:ro" \
        "$IMAGE" >/dev/null
    until docker exec -e DISPLAY=:1 "$NAME_PREFIX-boot" \
          xdotool search --onlyvisible --name '^Forge: ' >/dev/null 2>&1; do sleep 0.2; done
    t_window=$(date +%s.%N)
    until python3 -c "
import socket, sys
try:
    s = socket.create_connection(('127.0.0.1', $VNC_BASE), 2); s.recv(12); s.close()
except OSError:
    sys.exit(1)" >/dev/null 2>&1; do sleep 0.2; done
    t_rfb=$(date +%s.%N)
    python3 -c "print(f'Forge window up after {$t_window - $t0:.1f} s; RFB answering after {$t_rfb - $t0:.1f} s')"
    docker rm -f "$NAME_PREFIX-boot" >/dev/null
}

cmd_cost() {
    local n=${1:-1} i
    echo "== per container, docker stats (one sample each) =="
    for ((i = 0; i < n; i++)); do
        printf '%s  ' "$NAME_PREFIX-$i"
        docker stats --no-stream --format '{{.CPUPerc}} CPU, {{.MemUsage}}' "$NAME_PREFIX-$i"
    done
    echo "== writable layer (docker ps -s) =="
    docker ps -s --filter "name=$NAME_PREFIX" --format '{{.Names}} {{.Size}}'
    echo "== processes inside $NAME_PREFIX-0 =="
    docker exec "$NAME_PREFIX-0" sh -c 'ps -eo rss,comm --sort=-rss | head -6'
    echo "== host =="
    free -m | head -2
}

cmd_latency_rfb() {
    local i=${1:-0}
    shift || true
    python3 "$HERE/rfb-latency.py" --host 127.0.0.1 --port $((VNC_BASE + i)) \
        --watch "$WATCH" --clicks "$CLICK_A" --clicks "$CLICK_B" "$@"
}

cmd_latency_xvfb() {
    python3 "$HERE/latency.py" --display ":$DISPLAY_NUM" \
        --region "$WATCH" --clicks "$CLICK_A" --clicks "$CLICK_B" "$@"
}

# The host-side half of the comparison: the same app on a bare Xvfb, so the
# difference between the two latency numbers is exactly the VNC hop.
cmd_host_forge() {
    local java run
    java=$(echo "$HOME"/.local/opt/jdk-21*/bin/java)
    [ -x "$java" ] || die "no JDK under ~/.local/opt (it is off PATH on purpose)"
    [ -e "/tmp/.X11-unix/X$DISPLAY_NUM" ] && die "display :$DISPLAY_NUM is taken"
    run="$WORK/run"
    rm -rf "$run"; mkdir -p "$run/user/decks/constructed" "$run/cache" "$WORK/out"
    ln -sfn "$FORGE_RES" "$run/res"
    printf 'userDir=%s/user/\ncacheDir=%s/cache/\ndecksDir=%s/user/decks/\ndecksConstructedDir=%s/user/decks/constructed/\n' \
        "$run" "$run" "$run" "$run" > "$run/forge.profile.properties"
    Xvfb ":$DISPLAY_NUM" -screen 0 1280x800x24 -nolisten tcp > "$WORK/out/xvfb.log" 2>&1 &
    echo $! > "$WORK/out/xvfb.pid"
    # `timeout` matters: an xdotool that connects while Xvfb is still opening
    # its socket blocks forever on the X handshake, and the loop never spins.
    until DISPLAY=":$DISPLAY_NUM" timeout 2 xdotool getdisplaygeometry >/dev/null 2>&1; do sleep 0.2; done
    ( cd "$run" && exec env DISPLAY=":$DISPLAY_NUM" "$java" -jar "$FORGE_JAR" ) > "$WORK/out/forge.log" 2>&1 &
    echo $! > "$WORK/out/forge.pid"
    echo "Xvfb :$DISPLAY_NUM + Forge started; wait ~25s, then:"
    echo "  $0 host-prep"
    echo "  $0 latency-xvfb --reps 40 --fps 200"
}

# Same first-run cleanup as cmd_prep, for the host Xvfb copy.
cmd_host_prep() {
    local win
    until DISPLAY=":$DISPLAY_NUM" timeout 2 xdotool search --onlyvisible --name '^Forge: ' >/dev/null 2>&1; do sleep 1; done
    # shellcheck disable=SC2086  # "x,y" must split into two xdotool args
    DISPLAY=":$DISPLAY_NUM" xdotool mousemove ${DIALOG_OK/,/ } click 1
    sleep 2
    win=$(DISPLAY=":$DISPLAY_NUM" xdotool search --onlyvisible --name '^Forge: ' | head -1)
    [ -n "$win" ] || die "no Forge window on :$DISPLAY_NUM"
    DISPLAY=":$DISPLAY_NUM" xdotool windowmove "$win" 0 0 windowsize "$win" 1280 800
    sleep 3
    echo "host Forge prepped (window $win)"
}

cmd_down() {
    local pidfile pid
    for pidfile in "$WORK/out/forge.pid" "$WORK/out/xvfb.pid"; do
        [ -f "$pidfile" ] || continue
        pid=$(cat "$pidfile"); kill "$pid" 2>/dev/null || true
        rm -f "$pidfile"
    done
    docker ps -aq --filter "name=$NAME_PREFIX" | while read -r c; do
        docker rm -f "$c" >/dev/null && echo "removed $c"
    done
    echo "down. remaining: $(docker ps -aq --filter "name=$NAME_PREFIX" | wc -l) containers"
}

case "${1:-}" in
    build)        shift; cmd_build "$@" ;;
    up)           shift; cmd_up "$@" ;;
    prep)         shift; cmd_prep "$@" ;;
    boot)         shift; cmd_boot "$@" ;;
    cost)         shift; cmd_cost "$@" ;;
    latency-rfb)  shift; cmd_latency_rfb "$@" ;;
    latency-xvfb) shift; cmd_latency_xvfb "$@" ;;
    host-forge)   shift; cmd_host_forge "$@" ;;
    host-prep)    shift; cmd_host_prep "$@" ;;
    down)         shift; cmd_down "$@" ;;
    *) sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
