#!/usr/bin/env bash
# The ONE thing in this repo that talks to docker.
#
# `apps/server/src/stream/alloc.ts` provisions a streamed room's containers by
# invoking this script — it never shells `docker` inline. That is the whole
# point of the file: every container this product can create, destroy or list
# is described here, in one place an operator can read before trusting it, and
# the server's own tests run it in dry-run mode where it touches nothing.
#
#   container.sh up   <name> <hostPort> [network]   start one streamed desktop
#   container.sh down <name>                        stop and remove one
#   container.sh list <prefix>                      names we manage, one per line
#   container.sh net-down <network>                 remove a room's network
#   container.sh check                              exit 4 naming what `up` would lack
#
# `CARDTABLE_STREAM_DRY_RUN=1` prints what each command WOULD run, one
# `would: …` line per docker invocation, and exits 0 without a docker call.
# That is what makes the allocator testable on a machine with no docker at all.
#
# Host safety, because this host runs production cardtable, 24 PM2 services and
# the static stream bench that is serving a friend demo:
#   - a name must start with $CARDTABLE_STREAM_NAME_PREFIX (default
#     `cardtable-room`), and `cardtable-lab*` is refused outright whatever the
#     prefix says — those two containers are the bench and are not ours;
#   - a host port below $PORT_MIN (6100) is refused, which puts the bench's
#     6080/6081 and the e2e harness's 19xxx out of reach;
#   - `list` only ever reports names matching a prefix we were asked for, so a
#     sweep cannot see, let alone remove, a container this product did not make.
#
# Exit codes: 0 ok · 2 usage · 3 refused by a guard above · 4 docker said no.
set -euo pipefail

IMAGE=${CARDTABLE_STREAM_IMAGE:-cardtable-stream-spike:w14}
NAME_PREFIX=${CARDTABLE_STREAM_NAME_PREFIX:-cardtable-room}
FORGE_JAR=${CARDTABLE_STREAM_FORGE_JAR:-$HOME/.local/share/cardtable/forge.jar}
# The Forge resources the server itself plays with ($CARDTABLE_FORGE_RES), else
# those of the tree this script is in — the deploy clone in production
# (~/srv/hadoku-cardtable), never a fixed ~/repos path, whose forge submodule is
# wherever the operator last left it. A CI workspace checks out no submodule:
# there the server's own bundle is the only Forge on the machine.
FORGE_RES=${CARDTABLE_STREAM_FORGE_RES:-${CARDTABLE_FORGE_RES:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/forge/forge-gui/res}}
DRY=${CARDTABLE_STREAM_DRY_RUN:-0}
# The container's own noVNC port, fixed by the image's entrypoint.
CONTAINER_WEB_PORT=6080
PORT_MIN=${CARDTABLE_STREAM_PORT_MIN:-6100}
PORT_MAX=${CARDTABLE_STREAM_PORT_MAX:-6199}

die() { echo "$1" >&2; exit "${2:-3}"; }
usage() { sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 2; }

# Runs docker, or says what it would have run. Every docker call goes through
# here, so dry-run is a property of the script rather than of each caller.
docker_do() {
    if [ "$DRY" = "1" ]; then
        echo "would: docker $*"
        return 0
    fi
    docker "$@" >/dev/null || die "docker $1 failed" 4
}

check_name() {
    local name=$1
    case "$name" in
        cardtable-lab | cardtable-lab-*)
            die "refusing '$name': that is the static bench, which this script never touches" ;;
    esac
    case "$name" in
        "$NAME_PREFIX"-*) ;;
        *) die "refusing '$name': a managed container's name starts with '$NAME_PREFIX-'" ;;
    esac
    case "$name" in
        *[!a-z0-9._-]*) die "refusing '$name': not a docker-safe name" ;;
    esac
}

check_port() {
    local port=$1
    case "$port" in
        '' | *[!0-9]*) die "refusing port '$port': not a number" ;;
    esac
    [ "$port" -ge "$PORT_MIN" ] || die "refusing port $port: below $PORT_MIN (the bench and the e2e harness live under it)"
    [ "$port" -le "$PORT_MAX" ] || die "refusing port $port: above $PORT_MAX"
}

# What `up` needs from this machine beyond docker: a Forge to mount. The e2e
# spec asks this before it provisions, so it skips where `up` would refuse.
cmd_check() {
    [ -f "$FORGE_JAR" ] || die "no Forge jar at $FORGE_JAR" 4
    [ -d "$FORGE_RES/cardsfolder" ] || die "no Forge res at $FORGE_RES" 4
}

cmd_up() {
    local name=${1:-} port=${2:-} network=${3:-}
    [ -n "$name" ] && [ -n "$port" ] || usage
    check_name "$name"
    check_port "$port"

    if [ "$DRY" != "1" ]; then
        cmd_check
        # A port this script does not own is a port it does not take.
        if ss -ltn "sport = :$port" | grep -q LISTEN; then
            die "port $port is already listening" 4
        fi
    fi

    local net_args=()
    if [ -n "$network" ]; then
        case "$network" in
            cardtable-lab) die "refusing network 'cardtable-lab': that is the bench's" ;;
            *[!a-z0-9._-]*) die "refusing network '$network': not a docker-safe name" ;;
        esac
        # The seats of one room must reach each other by container name — that
        # is how Forge's own Online lobby joins a host (the bench proved it).
        if [ "$DRY" = "1" ]; then
            echo "would: docker network create $network"
        elif ! docker network inspect "$network" >/dev/null 2>&1; then
            docker network create "$network" >/dev/null || die "docker network create failed" 4
        fi
        net_args=(--network "$network")
    fi

    docker_do run -d --name "$name" \
        "${net_args[@]}" \
        -p "127.0.0.1:$port:$CONTAINER_WEB_PORT" \
        -v "$FORGE_JAR:/opt/forge/forge.jar:ro" \
        -v "$FORGE_RES:/opt/forge/res:ro" \
        "$IMAGE"
    echo "up $name $port"
}

cmd_down() {
    local name=${1:-}
    [ -n "$name" ] || usage
    check_name "$name"
    # `rm -f` on a container that is already gone is success, not an error:
    # reclaim runs on a timer and must be idempotent.
    if [ "$DRY" = "1" ]; then
        echo "would: docker rm -f $name"
    else
        docker rm -f "$name" >/dev/null 2>&1 || true
    fi
    echo "down $name"
}

# Every container we manage, so a sweep can find what a restart orphaned. The
# filter is a prefix WE were given and is checked the same way a name is: this
# can never list the bench.
cmd_list() {
    local prefix=${1:-$NAME_PREFIX}
    case "$prefix" in
        cardtable-lab*) die "refusing prefix '$prefix': that is the bench's" ;;
        *[!a-z0-9._-]*) die "refusing prefix '$prefix': not a docker-safe prefix" ;;
    esac
    if [ "$DRY" = "1" ]; then return 0; fi
    docker ps -a --filter "name=^/$prefix-" --format '{{.Names}}'
}

cmd_net_down() {
    local network=${1:-}
    [ -n "$network" ] || usage
    case "$network" in
        cardtable-lab) die "refusing network 'cardtable-lab': that is the bench's" ;;
        *[!a-z0-9._-]*) die "refusing network '$network': not a docker-safe name" ;;
    esac
    if [ "$DRY" = "1" ]; then
        echo "would: docker network rm $network"
    else
        # Still in use by a container we did not reclaim → leave it. Failing
        # here would abort a sweep that has more rooms to reclaim.
        docker network rm "$network" >/dev/null 2>&1 || true
    fi
    echo "net-down $network"
}

case "${1:-}" in
    check)    shift; cmd_check ;;
    up)       shift; cmd_up "$@" ;;
    down)     shift; cmd_down "$@" ;;
    list)     shift; cmd_list "$@" ;;
    net-down) shift; cmd_net_down "$@" ;;
    *) usage ;;
esac
