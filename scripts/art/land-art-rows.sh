#!/bin/bash
# cardtable's land hook (devkit.config.json `land.hooks.beforeCheck`): the art rows for the cards
# this land adds. Run by the devkit's land.sh in its worktree (the latest main plus the land's
# commits), with NODE_BIN and LAND_LOG set; a non-zero exit refuses the land.
#
# The art table's rows are derived data: every card a scenario places or a deck lists gets one.
# Derive them here, from the shared Scryfall cache (docs/WAVE_WORKTREE.md; it lived in the main checkout
# until production moved to /home/hadoku/srv on 2026-10-22), so a new scenario's cards land with
# their rows instead of reddening the coverage suite on main. `--no-tokens`: only the rows this
# land's cards need, never the token rows a whole rebuild would bring. A no-op (3 s) otherwise.
set -euo pipefail
: "${NODE_BIN:?run by land.sh}" "${LAND_LOG:?run by land.sh}"
ART_CACHE="${CARDTABLE_SCRYFALL_DIR:-$HOME/.local/share/cardtable/scryfall}"
if [ -f "$ART_CACHE/cards.jsonl" ]; then
  PATH="$NODE_BIN:$PATH" node --max-old-space-size=6144 scripts/art/build-art-ids.ts --no-tokens --cache="$ART_CACHE" > "$LAND_LOG.log" 2>&1 \
    || { tail -20 "$LAND_LOG.log"; echo "land: art rows FAILED — nothing pushed (log $LAND_LOG.log)" >&2; exit 5; }
  if ! git diff --quiet -- games/magic/server/src/play/art-ids.json; then
    git commit -qm "art: rows for the cards this land's scenarios and decks place" -- games/magic/server/src/play/art-ids.json
    echo "land: art rows — $(grep -oE 'added [0-9]+ new' "$LAND_LOG.log")"
  fi
else
  echo "land: no Scryfall cache at $ART_CACHE — art rows not derived; the coverage suite still runs"
fi
