#!/usr/bin/env bash
#
# The host agent (apps/agent) for a fleet-manager hosting claw: one file, `run`,
# bundled for the claw's node 22, with the coordinator's public key written in.
#
#   deploy.sh keygen <dir>          a fresh Ed25519 key: <dir>/signing.key (0600, one line of
#                                   base64 PKCS#8, the vault item CARDTABLE_AGENT_SIGNING_KEY's
#                                   value). Printed nowhere.
#   deploy.sh build <dir>           <dir>/run, and its sha256 on stdout
#   deploy.sh install <node> <dir>  fleet hosting <node> --install <dir>/run --sha256 …
#                                   (the manager runs this, under a lease drain; the agent restarts
#                                   and adopts its JVMs)
#
# `build` takes the key from CARDTABLE_AGENT_SIGNING_KEY (run it under dev-vault), or from
# AGENT_KEY_FILE; only the public half reaches the bundle.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
FLEET=${FLEET:-$HOME/repos/hadoku-fleet-manager/dist/cli.js}
ESBUILD=${ESBUILD:-$ROOT/apps/server/node_modules/.bin/esbuild}
# The claws run node 22 (/usr/bin/node); the bundle is checked with one.
NODE22=${NODE22:-/usr/local/bin/node}

cmd=${1:?usage: deploy.sh keygen|build|install ...}
shift
case $cmd in
keygen)
	mkdir -p "$1"
	(umask 077 && openssl genpkey -algorithm ed25519 -outform DER | base64 -w0 > "$1/signing.key")
	echo "key in $1/signing.key"
	;;
build)
	out=$1
	mkdir -p "$out"
	if [ -z "${CARDTABLE_AGENT_SIGNING_KEY:-}" ]; then
		CARDTABLE_AGENT_SIGNING_KEY=$(cat "${AGENT_KEY_FILE:?CARDTABLE_AGENT_SIGNING_KEY or AGENT_KEY_FILE}")
	fi
	pub=$(CARDTABLE_AGENT_SIGNING_KEY=$CARDTABLE_AGENT_SIGNING_KEY node --input-type=module -e "
		import { privateKeyFrom, publicPemOf } from '$ROOT/apps/server/src/play/remote/wire.ts';
		process.stdout.write(JSON.stringify(publicPemOf(privateKeyFrom(process.env.CARDTABLE_AGENT_SIGNING_KEY))));
	")
	version=$(git -C "$ROOT" rev-parse --short=12 HEAD)$(git -C "$ROOT" diff --quiet HEAD -- apps/agent apps/server/src/play/remote || echo -dirty)
	"$ESBUILD" "$ROOT/apps/agent/src/main.ts" --bundle --platform=node --format=esm --target=node22 \
		--define:AGENT_PUBLIC_KEY="$pub" --define:AGENT_VERSION="\"$version\"" \
		--banner:js='#!/usr/bin/node' --log-level=warning --outfile="$out/run"
	chmod 0755 "$out/run"
	"$NODE22" --check "$out/run"
	bytes=$(stat -c %s "$out/run")
	[ "$bytes" -le $((64 * 1024 * 1024)) ] || { echo "deploy.sh: run is $bytes bytes, over fleet-manager's 64 MB" >&2; exit 1; }
	sha256sum "$out/run" | cut -d' ' -f1
	;;
install)
	node "$FLEET" hosting "$1" --install "$2/run" --sha256 "$(sha256sum "$2/run" | cut -d' ' -f1)" --json
	;;
*)
	echo "deploy.sh: unknown command $cmd" >&2
	exit 2
	;;
esac
