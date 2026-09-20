# One match = one container: Forge desktop (Swing) on a private X server,
# encoded to RFB by x11vnc and handed to a browser by noVNC/websockify.
#
# THIS IS A SPIKE ARTEFACT. Nothing in the product builds or runs it. It exists
# so `docs/spikes/streaming.md` can quote numbers that came from something that
# actually ran. See that doc before you reach for this.
#
# Deliberately NOT baked in:
#   - the Forge jar (~39 MB)  -> bind-mounted at /opt/forge/forge.jar
#   - Forge's res/ (~462 MB)  -> bind-mounted read-only at /opt/forge/res
# Both are build outputs of the pinned submodule, not source, and res/ is
# identical for every match: baking it would multiply 462 MB by the number of
# images, and mounting it read-only shares one copy across every container.
# It also keeps card-image bytes out of anything we could accidentally push.

FROM eclipse-temurin:21-jre-noble

# xvfb        the X server the app draws into (no GPU, no physical screen)
# x11vnc      screen-scrapes that X server and speaks RFB
# novnc       the browser-side RFB client (static HTML/JS)
# websockify  wraps the RFB TCP socket in a WebSocket so a browser can reach it
# xdotool     only for the latency harness; drop it for a real deployment
# libx*/fonts what Swing needs to render at all
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        xvfb \
        x11vnc \
        novnc \
        websockify \
        xdotool \
        libxrender1 \
        libxtst6 \
        libxi6 \
        fontconfig \
        fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

ENV DISPLAY=:1 \
    SCREEN=1280x800x24 \
    VNC_PORT=5900 \
    WEB_PORT=6080 \
    FORGE_JAR=/opt/forge/forge.jar \
    JAVA_OPTS=-Xmx1g

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Forge writes its profile, decks and cache under the run dir, which is its cwd.
WORKDIR /run/forge
EXPOSE 5900 6080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
