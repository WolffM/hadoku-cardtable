import { describe, expect, it } from 'vitest';
import { SESSION_EVENTS } from '@wolffm/rooms-protocol';

import { roomSession, type SessionSocket } from './session.ts';

const ROOM = 'r-0123456789ab';
const TAB = 'tab-aaaaaaaa';

/** A socket the test plays the server for: it sees each claim, and answers when told. */
function fakeSocket() {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const claims: { payload: unknown; answer: (a: unknown) => void }[] = [];
  let connects = 0;
  const socket = {
    connected: false,
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    emit(event: string, payload: unknown, ack: (a: unknown) => void) {
      if (event === SESSION_EVENTS.claim) claims.push({ payload, answer: ack });
    },
    connect() {
      connects += 1;
      fire('connect');
    },
    close() {
      socket.connected = false;
    },
  };
  const fire = (event: string, ...args: unknown[]) => {
    if (event === 'connect') socket.connected = true;
    if (event === 'disconnect') socket.connected = false;
    for (const h of handlers.get(event) ?? []) h(...args);
  };
  return { socket: socket as SessionSocket & { connected: boolean }, claims, fire, connects: () => connects };
}

async function opened() {
  const fake = fakeSocket();
  const session = roomSession(ROOM, { connect: () => fake.socket, tabId: () => Promise.resolve(TAB) });
  await Promise.resolve();
  await Promise.resolve();
  fake.fire('connect');
  return { fake, session };
}

describe('roomSession', () => {
  it('claims on connect with the settled tab id, and plays on once granted', async () => {
    const { fake, session } = await opened();
    expect(session.state()).toBe('pending');
    expect(fake.claims.map((c) => c.payload)).toEqual([{ room: ROOM, tabId: TAB }]);
    fake.claims[0]!.answer({ room: ROOM, status: 'granted' });
    expect(session.state()).toBe('granted');
  });

  it('held asks; yes is the same claim with take, and its grant plays on', async () => {
    const { fake, session } = await opened();
    fake.claims[0]!.answer({ room: ROOM, status: 'held' });
    expect(session.state()).toBe('held');
    session.take();
    expect(fake.claims[1]!.payload).toEqual({ room: ROOM, tabId: TAB, take: true });
    fake.claims[1]!.answer({ room: ROOM, status: 'granted' });
    expect(session.state()).toBe('granted');
    // A later reconnect claims plainly: the take was spent.
    fake.fire('disconnect', 'transport close');
    fake.fire('connect');
    expect(fake.claims[2]!.payload).toEqual({ room: ROOM, tabId: TAB });
  });

  it('is taken when told, and when the server closes it; a transport drop is not a take', async () => {
    const told = await opened();
    told.fake.claims[0]!.answer({ room: ROOM, status: 'granted' });
    told.fake.fire(SESSION_EVENTS.taken, { room: 'r-another00000' });
    expect(told.session.state()).toBe('granted');
    told.fake.fire(SESSION_EVENTS.taken, { room: ROOM });
    expect(told.session.state()).toBe('taken');

    const closed = await opened();
    closed.fake.claims[0]!.answer({ room: ROOM, status: 'granted' });
    closed.fake.fire('disconnect', 'transport close');
    expect(closed.session.state()).toBe('granted');
    closed.fake.fire('disconnect', 'io server disconnect');
    expect(closed.session.state()).toBe('taken');
  });

  it('taking it back reconnects the closed socket and claims with take', async () => {
    const { fake, session } = await opened();
    fake.claims[0]!.answer({ room: ROOM, status: 'granted' });
    fake.fire('disconnect', 'io server disconnect');
    session.take();
    expect(fake.connects()).toBe(1);
    expect(fake.claims.at(-1)!.payload).toEqual({ room: ROOM, tabId: TAB, take: true });
    fake.claims.at(-1)!.answer({ room: ROOM, status: 'granted' });
    expect(session.state()).toBe('granted');
  });

  it('claims again on request while playing or watching, and never while asking', async () => {
    const { fake, session } = await opened();
    fake.claims[0]!.answer({ room: ROOM, status: 'watcher' });
    session.reclaim();
    expect(fake.claims).toHaveLength(2);
    fake.claims[1]!.answer({ room: ROOM, status: 'held' });
    expect(session.state()).toBe('held');
    session.reclaim();
    expect(fake.claims).toHaveLength(2);
  });

  it('answers the server’s beat at once', async () => {
    const { fake } = await opened();
    let acked = 0;
    fake.fire(SESSION_EVENTS.beat, () => (acked += 1));
    expect(acked).toBe(1);
  });

  it('an answer the wire does not allow plays on as refused', async () => {
    const { fake, session } = await opened();
    fake.claims[0]!.answer({ room: ROOM, status: 'maybe' });
    expect(session.state()).toBe('refused');
  });

  it('tells its listeners, and nothing after close', async () => {
    const { fake, session } = await opened();
    const seen: string[] = [];
    session.subscribe(() => seen.push(session.state()));
    fake.claims[0]!.answer({ room: ROOM, status: 'granted' });
    session.close();
    fake.fire(SESSION_EVENTS.taken, { room: ROOM });
    expect(seen).toEqual(['granted']);
  });
});
