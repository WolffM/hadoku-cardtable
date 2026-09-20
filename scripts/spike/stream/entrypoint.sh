#!/bin/sh
# Xvfb -> Forge desktop -> x11vnc -> websockify/noVNC, one container per match.
# SPIKE ONLY. See docs/spikes/streaming.md.
set -eu

: "${DISPLAY:=:1}"
: "${SCREEN:=1280x800x24}"
: "${VNC_PORT:=5900}"
: "${WEB_PORT:=6080}"
: "${FORGE_JAR:=/opt/forge/forge.jar}"
: "${FORGE_RES:=/opt/forge/res}"
: "${JAVA_OPTS:=-Xmx1g}"

[ -f "$FORGE_JAR" ] || { echo "no jar at $FORGE_JAR - bind-mount it" >&2; exit 2; }
[ -d "$FORGE_RES" ] || { echo "no res at $FORGE_RES - bind-mount it" >&2; exit 2; }

# Forge reads res/ and its profile relative to cwd (same staging the server's
# jvmHost does, apps/server/src/play/host.ts stageRunDir).
mkdir -p /run/forge/user/decks/constructed /run/forge/cache
ln -sfn "$FORGE_RES" /run/forge/res
cat > /run/forge/forge.profile.properties <<EOF
userDir=/run/forge/user/
cacheDir=/run/forge/cache/
decksDir=/run/forge/user/decks/
decksConstructedDir=/run/forge/user/decks/constructed/
EOF

Xvfb "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp &
xvfb=$!

# Wait for the X server rather than sleeping a guessed interval.
i=0
until xdotool getdisplaygeometry >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -gt 100 ] && { echo "Xvfb never came up" >&2; exit 3; }
    sleep 0.1
done

# shellcheck disable=SC2086  # JAVA_OPTS is a flag list on purpose
java $JAVA_OPTS -jar "$FORGE_JAR" &
forge=$!

# -nopw/-listen 0.0.0.0 is safe ONLY because this port never leaves the host in
# this spike. A real deployment terminates auth at the edge and the container
# port stays on the container network.
x11vnc -display "$DISPLAY" -rfbport "$VNC_PORT" -listen 0.0.0.0 \
       -forever -shared -nopw -noxdamage -wait 5 -defer 5 -quiet &
vnc=$!

websockify --web /usr/share/novnc "$WEB_PORT" "localhost:$VNC_PORT" &
web=$!

trap 'kill $xvfb $forge $vnc $web 2>/dev/null || true' TERM INT
# The match is over when Forge is over; everything else is scaffolding.
wait $forge
kill $xvfb $vnc $web 2>/dev/null || true
