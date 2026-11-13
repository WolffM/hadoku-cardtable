/*
 * The art ids the server lays on every face a seat may see (`games/magic/server/src/play/visibility.ts`'s
 * `withArt`, deciding with `art-ids.ts`), for a test that adapts Forge's raw stream or a state it
 * built by hand: the board draws the id a face carries and looks nothing up itself. The resolver is
 * the server's own, from the committed tables and no catalog — as a host without one runs it.
 */
import { DELTA_TYPE } from '@hadoku/forge-wire';

import { namedArt } from '../../../../games/magic/server/src/http/card-art.ts';
import { createArtIds, type ArtIds } from '../../../../games/magic/server/src/play/art-ids.ts';
import { resetNamedArtForTests } from '../screens/libraryPeek.ts';
import { withArt, type WireObj } from '../../../../games/magic/server/src/play/visibility.ts';
import type { WireState } from './fold.ts';
import type { WireObject } from './wire.ts';

const ART = createArtIds(null);

/** `state` with every face's art id on it, as a seat that sees the whole table is sent it; `art` decides them. */
export function withServerArt(state: WireState, art: ArtIds = ART): Map<string, WireObject> {
  const raw = state as ReadonlyMap<string, WireObj>;
  return new Map([...state].map(([key, obj]) => [key, obj._type === DELTA_TYPE.cardState ? (withArt(raw, obj as WireObj, art, true) as WireObject) : obj]));
}

/** A resolver that answers each name from `ids`, for a test's own made-up ids. */
export function artFrom(ids: ReadonlyMap<string, string>): ArtIds {
  const card = (name: string) => {
    const scryfallId = ids.get(name);
    return scryfallId === undefined ? undefined : { scryfallId };
  };
  return { face: ({ name }) => card(name), card, images: () => [], backs: () => [] };
}

/** The id the server gives a card by its name and Forge set. */
export function serverArtId(name: string, set = ''): string | undefined {
  return ART.card(name, set)?.scryfallId;
}

/** Every card a screen knows only by its name is answered as `GET /api/cards/art` answers it, from a fresh page. */
export function serveNamedArt(): void {
  resetNamedArtForTests(async (input) => {
    const names = new URL(String(input), 'http://localhost').searchParams.getAll('n');
    return new Response(JSON.stringify({ art: namedArt(names, ART) }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}
