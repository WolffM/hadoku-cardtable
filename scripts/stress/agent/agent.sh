#!/usr/bin/env bash
#
# The §A test agent on a fleet-manager hosting slice — docs/planning/hosting-test-plan.md §A.
# agent.mjs says what it is (and is not); this script builds, installs and feeds it from hokon.
#
#   agent.sh keygen <dir>             a fresh Ed25519 pair, per test campaign: <dir>/key.pem (0600), pub.pem
#   agent.sh build <dir>              <dir>/run: agent.mjs with pub.pem written in; prints its sha256
#   agent.sh install <node> <dir>     fleet hosting <node> --install <dir>/run --sha256 …
#   agent.sh pack <dir>               <dir>/jdk.tgz and <dir>/stage.tgz (ForgeScale, the jar, trimmed res, decks)
#   agent.sh push <node> <dir>        upload both, unpack them as jdk/ and stage/
#   agent.sh call <node> <dir> <METHOD> <path> [<json>]
#   agent.sh wait <node> <dir> <run id>   until the run exits; prints its status
#
# Environment: JAR (the Forge jar ForgeScale is built against), JDK, RES, as scripts/stress/run.sh.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
JDK=${JDK:-$HOME/.local/opt/jdk-21.0.12.1+1}
FLEET=${FLEET:-$HOME/repos/hadoku-fleet-manager/dist/cli.js}

call() { # <node> <dir> <METHOD> <path> [<body>]
	local node=$1 dir=$2
	shift 2
	AGENT_KEY="$dir/key.pem" node "$HERE/call.mjs" "$node" "$@"
}

push() { # <node> <dir> <tgz> <as>
	local sha
	sha=$(sha256sum "$3" | cut -d' ' -f1)
	call "$1" "$2" PUT "/blob/$sha" "@$3"
	call "$1" "$2" POST /unpack "{\"sha\":\"$sha\",\"as\":\"$4\"}"
}

cmd=${1:?usage: agent.sh keygen|build|install|pack|push|call ...}
shift
case $cmd in
keygen)
	mkdir -p "$1"
	(umask 077 && openssl genpkey -algorithm ed25519 -out "$1/key.pem")
	openssl pkey -in "$1/key.pem" -pubout -out "$1/pub.pem"
	echo "keys in $1"
	;;
build)
	PUB=$(awk 'BEGIN{ORS="\\n"} {print}' "$1/pub.pem") python3 -I -c '
import os, sys
src = open(sys.argv[1]).read()
assert src.count("__AGENT_PUBLIC_KEY__") == 1
open(sys.argv[2], "w").write(src.replace("__AGENT_PUBLIC_KEY__", os.environ["PUB"]))
' "$HERE/agent.mjs" "$1/run"
	chmod 0755 "$1/run"
	node --check "$1/run"
	sha256sum "$1/run" | cut -d' ' -f1
	;;
install)
	node "$FLEET" hosting "$1" --install "$2/run" --sha256 "$(sha256sum "$2/run" | cut -d' ' -f1)" --json
	;;
pack)
	tar -czf "$1/jdk.tgz" -C "$(dirname "$JDK")" --exclude=jmods --exclude=lib/src.zip --exclude=man --exclude=demo "$(basename "$JDK")"
	STAGE="$1/stage" "$HERE/../run.sh" build-stage
	tar -czf "$1/stage.tgz" -C "$1" stage
	ls -la "$1/jdk.tgz" "$1/stage.tgz"
	;;
push)
	push "$1" "$2" "$2/jdk.tgz" jdk
	push "$1" "$2" "$2/stage.tgz" stage
	;;
call)
	call "$@"
	;;
wait)
	until out=$(call "$1" "$2" GET "/stress/$3") && ! grep -q '"exit":null' <<< "$out"; do sleep 30; done
	echo "$out"
	;;
*)
	echo "agent.sh: unknown command $cmd" >&2
	exit 2
	;;
esac
