/*
 * Your deck's colours, told to the socket that holds the seat once it has
 * joined, so the match can play the music of one of them (the operator,
 * 2026-10-16: "when we load up a deck with more than one color we pick one at
 * random. the music starts when the game starts").
 *
 * Folded on the server from the `.dck` Forge was handed, the same fold as the
 * room screen's pips and the match stats (`@hadoku/deck`'s `deckColorsByName`).
 * `null` is a socket with no deck of its own: a watcher.
 *
 * Its own event for the reason `forge:art` is: the snapshot schema is mirrored
 * byte for byte in `apps/ui/src/play/live/transport.ts`. Sent on every join and
 * resync, before `forge:role`, so a client has it by the time it knows which
 * kind of socket it is.
 */
import { z } from 'zod';

import { ManaColorSchema } from './draft.ts';

export const DECK_COLORS_EVENT = 'forge:deck-colors';

/** Server → one socket, after its join or resync ack. */
export const DeckColorsSchema = z
  .object({
    matchId: z.string().min(1),
    colors: z.array(ManaColorSchema).max(5).nullable(),
  })
  .strict();
export type DeckColors = z.output<typeof DeckColorsSchema>;
