#!/usr/bin/env bash
# Film one promo clip: `e2e/promo/shoot.sh valakut`. Needs the UI and server built in this tree
# (`pnpm --filter @hadoku/ui build && pnpm --filter @hadoku/server build`) and this tree's own Forge pin
# built as a jar (docs/FORGE_JAR.md). Footage lands in e2e/.run/promo/<clip>/.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
pin=$(git -C "$root" ls-tree HEAD forge | awk '{print $3}')
export PATH="$HOME/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"
export CARDTABLE_FORGE_JAR="${CARDTABLE_FORGE_JAR:-$HOME/.local/share/cardtable/jars/$pin.jar}"
export CARDTABLE_FORGE_RES="${CARDTABLE_FORGE_RES:-/home/hadoku/srv/hadoku-cardtable/forge/forge-gui/res}"
export CARDTABLE_PLAY_WORK_DIR="${CARDTABLE_PLAY_WORK_DIR:-$HOME/.cache/cardtable-play-work/promo}"
# The deploy tree's sound library, read only: the clips carry the game's own sound.
export CARDTABLE_SOUNDS_DIR="${CARDTABLE_SOUNDS_DIR:-/home/hadoku/srv/hadoku-cardtable/apps/server/data/sounds}"
export CARDTABLE_E2E_PLAY_EDGE_PORT="${CARDTABLE_E2E_PLAY_EDGE_PORT:-19328}"
export CARDTABLE_E2E_PLAY_SERVER_PORT="${CARDTABLE_E2E_PLAY_SERVER_PORT:-19228}"
test -f "$CARDTABLE_FORGE_JAR" || { echo "shoot: no jar for pin $pin at $CARDTABLE_FORGE_JAR" >&2; exit 1; }
cd "$root/e2e"
exec npx playwright test --config promo/playwright.config.ts "$@"
