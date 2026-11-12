/*
 * The room screen's route entry point: `#/room/<id>` and `#/play` both land here.
 *
 * Everything the room actually draws — Magic's deck/mode/tournament/gauntlet state, the room's
 * own feed/table reads, the whole `RoomTableScreen` — lives in `./magic-room-ui.tsx` now (w106
 * §M). What stays here is the one thing that has to: building the room's injected clients (a
 * table client over a stub fetch for tests, the real one in production, and so on for the rest)
 * and handing them down through `rooms/game-clients.tsx`'s generic context, exactly the way
 * `ConstructedScreenProps` used to hand them down as plain function parameters.
 *
 * A handful of pure, Magic-flavoured exports (`DeckOption`, `DeckChooser`, `DeckArt`,
 * `draftedDeckOption`, `openDraftedDeck`, `draftedDeckOf`, `CROWN`, `groupSetsByBlock`,
 * `DRAFTED_BASICS`, `PeekedDeck`) are re-exported from `./magic-room-ui.tsx` below, unchanged,
 * because other screens, and this screen's own tests, import them from this exact path.
 */

import { useMemo } from 'react';

import type { DraftTransport } from '../draft/socket.ts';
import { type MyDecksClient } from '../deck/myDecks.ts';
import { roomFeed, type RoomFeed } from '../rooms/follow.ts';
import { type Fetch, type RoomsClient } from '../rooms/api.ts';
import { GameClientsProvider } from '../rooms/game-clients.tsx';
import { secureRandom, tablesClient, type TablesClient } from './tables.ts';
import { fetchDeckRecords } from '../stats/source.ts';
import type { DeckRecords } from '../stats/deckOrder.ts';
import { NoRoom, RoomTableScreen, type MagicRoomClients } from './magic-room-ui.tsx';

export {
  CROWN,
  DeckArt,
  DeckChooser,
  DRAFTED_BASICS,
  draftedDeckOf,
  draftedDeckOption,
  groupSetsByBlock,
  libraryDeckPeek,
  openDraftedDeck,
  type DeckOption,
  type PeekedDeck,
} from './magic-room-ui.tsx';

export interface ConstructedScreenProps {
  /** Tests pass a client over a stub fetch. Production passes nothing. */
  client?: TablesClient;
  /** The room whose table this is. `App` threads it from `#/room/<id>`. */
  roomId?: string;
  /** One table of the room's rounds, from `#/room/<id>/table/<table>` (`pod/TablePage.tsx`); absent is the hub. */
  tableId?: string;
  /** What says the room changed. Tests pass their own; production passes nothing. */
  feed?: RoomFeed;
  /** Tests pass a rooms client so the join-on-entry can be driven. Production passes nothing. */
  rooms?: RoomsClient;
  /** Tests pass the stream probe's `fetch`. Production passes nothing. */
  streamFetch?: Fetch;
  /** Where `Random` gets its number. Tests pin it; production passes nothing. */
  rand?: () => number;
  /**
   * The draft pod's transport, threaded to `PodScreen` once a draft room has
   * started. Tests pass a stub; production passes nothing and gets socket.io.
   */
  makeTransport?: () => DraftTransport;
  /** Everyone's record per deck, for the picker's order. Tests pass a stub; production passes nothing and asks the stats service. */
  deckRecords?: () => Promise<DeckRecords>;
  /** Free pick's "My decks" (`deck/myDecks.ts`). Tests pass a stub; production passes nothing. */
  myDecks?: MyDecksClient;
}

export function ConstructedScreen({
  client: given,
  roomId,
  tableId,
  feed = roomFeed(),
  rooms,
  streamFetch,
  rand = secureRandom,
  makeTransport,
  deckRecords = fetchDeckRecords,
  myDecks,
}: ConstructedScreenProps) {
  const client = useMemo(() => given ?? tablesClient(), [given]);
  const clients = useMemo<MagicRoomClients>(
    () => ({ client, feed, rooms, streamFetch, rand, makeTransport, deckRecords, myDecks }),
    [client, feed, rooms, streamFetch, rand, makeTransport, deckRecords, myDecks],
  );
  return roomId === undefined ? (
    <NoRoom />
  ) : (
    <GameClientsProvider value={clients}>
      <RoomTableScreen roomId={roomId} tableId={tableId} />
    </GameClientsProvider>
  );
}
