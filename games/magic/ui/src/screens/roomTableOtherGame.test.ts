// @vitest-environment jsdom
/**
 * A room of a game Magic does not play, opened cold from its invite link, never says "no such room".
 *
 * Magic's table route 404s every such room, and the room screen asks it anyway until the room's
 * own read has said what the room plays. When the table read, the join it triggers and the
 * re-read after it have all answered before the room's type has, the re-read's 404 was kept as
 * the room's error, and nothing cleared it once the type said there is no table to wait for —
 * so `room-missing` stayed up over a game panel that was already playing.
 *
 * No JSX: the root vitest config collects `*.test.ts` only.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { RoomBodySchema } from '@hadoku/shared';
import { GameClientsProvider } from '@hadoku/game-ui/rooms/game-clients.tsx';

import type { RoomsClient } from '../rooms/api.ts';
import { RoomTableScreen, type MagicRoomClients } from './magic-room-ui.tsx';
import type { TablesClient } from './tables.ts';

afterEach(cleanup);

const ROOM_ID = 'r-0123456789ab';

/** What `rooms.get` answers for a room that is there. */
type RoomView = NonNullable<Awaited<ReturnType<RoomsClient['get']>>>;

/** A promise that never settles: a call this test does not answer. */
const pending = (): Promise<never> => new Promise<never>(() => {});

/** Every method answers `pending()` except the ones the test names. */
function stub<T extends object>(given: Partial<T>): T {
  return new Proxy(given, { get: (target, key) => (key in target ? target[key as keyof T] : pending) }) as T;
}

function otherGameRoom(): RoomView {
  return RoomBodySchema.parse({
    id: ROOM_ID,
    name: 'another game',
    creator: 'alice',
    leader: 'alice',
    gameType: 'some-other-game',
    locked: false,
    members: [
      { id: 'alice', name: 'alice' },
      { id: 'bob', name: 'bob' },
    ],
    seats: ['alice', 'bob'],
    you: { id: 'bob' },
  });
}

describe('a room of a game Magic does not play', () => {
  it('never shows "no such room" when its type is known only after the table read, its join and its re-read all 404', async () => {
    let answerRoom: (room: RoomView) => void = () => {};
    const roomRead = new Promise<RoomView>((resolve) => (answerRoom = resolve));
    let tableReads = 0;
    let joins = 0;
    const client = stub<TablesClient>({
      table: () => {
        tableReads += 1;
        return Promise.resolve({ ok: false, error: 'No such room.', status: 404 });
      },
    });
    const rooms = stub<RoomsClient>({
      get: () => roomRead,
      join: () => {
        joins += 1;
        return Promise.resolve({ ok: true, room: otherGameRoom() });
      },
    });
    const clients: MagicRoomClients = {
      client,
      rooms,
      feed: { follow: (_target, refresh) => (refresh(), () => {}) },
      rand: () => 0.5,
      deckRecords: pending,
    };

    render(createElement(GameClientsProvider<MagicRoomClients>, { value: clients, children: createElement(RoomTableScreen, { roomId: ROOM_ID, tableId: undefined }) }));
    await act(async () => {});
    expect(tableReads, 'the table was read, joined and read again before the room answered').toBe(2);
    expect(joins).toBe(1);

    await act(async () => answerRoom(otherGameRoom()));
    expect(screen.queryByTestId('room-missing')).toBeNull();
  });
});
