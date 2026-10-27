/*
 * The art behind a room card (the operator's rulings, 2026-10-27, ruling 10): a lookup, never a URL
 * (AGENTS.md, "A card's art is a lookup, not a URL") — this module only ever returns a Scryfall id,
 * and the caller resolves it through `../draft/cardImage.ts`'s `cardImageUrl`, same as everywhere
 * else in the app.
 *
 * Two of the order's three steps are implemented:
 *
 *   (a) the room's own art — a constructed table's deck art card, which the room body's
 *       `tableGames` already carries as a card NAME (`@hadoku/shared`'s `TableSeatDeck.art`,
 *       "a name, looked up for its art" — never an id). Resolved through the same committed
 *       `art-ids.json` the library screen reads (`ConstructedScreen.tsx`'s own `deckCardArtId`),
 *       rather than importing that screen.
 *   (c) one of four format pictures — Standard / Modern / Legacy / Draft — each one iconic card's
 *       name, in `FORMAT_ART` below, resolved the same way. Swapping one is a one-line edit to that
 *       table.
 *
 * (b) — the format era's newest set as of the era date — is NOT implemented. `TableFormat.sets`
 * (`apps/ui/src/screens/tables.ts`) names an era's legal sets but not a release date for any of
 * them, and there is no committed "one card that stands for this set" table either; building both
 * is new data the room list does not have today, so this step is skipped (the brief's own
 * permission: "if (b) needs data the UI does not have, skip (b), say so"). A draft room's OWN cube
 * or set (the other half of (a)) is skipped for the same reason: `RoomView.pod.plan` names a
 * `cubeId`/set `code`, never an art id, and the cube/set catalogue that resolves one
 * (`RoomsClient.listCubes()`) is not loaded by the room list today.
 */
import { artIdIndexFromTable, scryfallIdFor, type ArtIdIndex, type ArtIdTableFile } from '@hadoku/carddata/art';

import artIdsData from '../draft/art-ids.json' with { type: 'json' };
import type { RoomView } from '../rooms/api.ts';

const ART_IDS: ArtIdIndex = artIdIndexFromTable(artIdsData as ArtIdTableFile);

/** By name, through the committed table — the one lookup this module needs, never a URL. */
function idFor(name: string): string | undefined {
  return scryfallIdFor(ART_IDS, name, '');
}

/**
 * One iconic card per format picture, swappable with a one-line edit (ruling 10's own words:
 * "put the four in ONE small data table so swapping is a one-line edit"). Not a legality claim —
 * Standard rotates and these do not — just a recognisable card for its family's background.
 */
export const FORMAT_ART: Readonly<Record<'standard' | 'modern' | 'legacy' | 'draft', string>> = {
  standard: 'Llanowar Elves',
  modern: 'Tarmogoyf',
  legacy: 'Lightning Bolt',
  draft: 'Sol Ring',
};

/** Which `FORMAT_ART` row a room falls back to: its Classic/Gauntlet era's family, or `draft` for a draft room. */
function formatArtFamily(room: RoomView): keyof typeof FORMAT_ART {
  if (room.gameType === 'draft') return 'draft';
  if (room.mode === 'gauntlet') {
    const era = (room.modeOptions as { era?: string } | null)?.era;
    if (era?.startsWith('modern-') === true) return 'modern';
    if (era?.startsWith('legacy-') === true) return 'legacy';
    return 'standard';
  }
  // Classic (and an unset mode, which still reads a format era): the room's own `format` id is
  // `<family>-<date>` for Modern/Legacy and a bare date for Standard (`formatLabel.ts`).
  if (room.format.startsWith('modern-')) return 'modern';
  if (room.format.startsWith('legacy-')) return 'legacy';
  return 'standard';
}

/** The room's own constructed table's deck art — the first seat whose deck the server saw one of, or `undefined`. */
function ownDeckArt(room: RoomView): string | undefined {
  if (room.tableGames === undefined) return undefined;
  for (const table of room.tables) {
    const game = room.tableGames[table.id];
    if (game === undefined) continue;
    for (const deck of game.decks) {
      if (deck?.art !== null && deck?.art !== undefined) {
        const id = idFor(deck.art);
        if (id !== undefined) return id;
      }
    }
  }
  return undefined;
}

/** The art id to draw behind a room card: the room's own deck art first, then its format's picture. */
export function roomArtId(room: RoomView): string | undefined {
  return ownDeckArt(room) ?? idFor(FORMAT_ART[formatArtFamily(room)]);
}
