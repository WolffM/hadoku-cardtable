/*
 * The room feed's client half: when a following screen reads, and what one
 * shared socket says to the server. The server half is
 * `apps/server/src/room/feed.test.ts`, over a real socket.io server.
 */

import { describe, expect, it } from 'vitest';
import { ROOM_FEED_CHANNEL, type RoomWatch } from '@hadoku/shared';

import { createRoomFeed, FALLBACK_MS, socketPings, type FeedSocket, type FeedTarget, type PageVisibility, type PingSource } from './feed.ts';

/** A page whose visibility a test flips, telling every listener as a browser does. */
function page(): PageVisibility & { setHidden(hidden: boolean): void } {
  let hidden = false;
  const listeners = new Set<() => void>();
  return {
    hidden: () => hidden,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setHidden: (h) => {
      hidden = h;
      for (const l of [...listeners]) l();
    },
  };
}

/** Pings a test sends by hand. */
function pings(): PingSource & { ping(): void; count(): number } {
  const subs = new Set<() => void>();
  return {
    subscribe: (_target, onPing) => {
      subs.add(onPing);
      return () => subs.delete(onPing);
    },
    ping: () => {
      for (const s of [...subs]) s();
    },
    count: () => subs.size,
  };
}

/** A clock whose intervals a test fires by hand. */
function clock() {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  return {
    setInterval: (fn: () => void, ms: number) => {
      timers.set((next += 1), { fn, ms });
      return next;
    },
    clearInterval: (h: unknown) => {
      timers.delete(h as number);
    },
    tick: () => {
      for (const t of [...timers.values()]) t.fn();
    },
    periods: () => [...timers.values()].map((t) => t.ms),
  };
}

function follow(target: FeedTarget = { room: 'r-1' }) {
  const p = page();
  const source = pings();
  const c = clock();
  const feed = createRoomFeed({ pings: source, page: p, setInterval: c.setInterval, clearInterval: c.clearInterval });
  let reads = 0;
  const stop = feed.follow(target, () => {
    reads += 1;
  });
  return { p, source, c, stop, reads: () => reads };
}

describe('a screen following a room', () => {
  it('reads once at the start, then only when the server says the room changed', () => {
    const f = follow();
    expect(f.reads()).toBe(1);
    f.source.ping();
    expect(f.reads()).toBe(2);
    f.source.ping();
    expect(f.reads()).toBe(3);
  });

  it('keeps one slow resilience read while visible, and no fast one', () => {
    const f = follow();
    expect(f.c.periods()).toEqual([FALLBACK_MS]);
    expect(FALLBACK_MS).toBeGreaterThanOrEqual(30_000);
    f.c.tick();
    expect(f.reads()).toBe(2);
  });

  it('a hidden tab reads nothing — no ping, no resilience read — and reads once when shown again', () => {
    const f = follow();
    f.p.setHidden(true);
    f.source.ping();
    f.source.ping();
    f.c.tick();
    expect(f.reads(), 'hidden: only the read it started with').toBe(1);
    f.p.setHidden(false);
    expect(f.reads(), 'shown: one read').toBe(2);
  });

  it('a screen that starts hidden reads nothing until it is shown', () => {
    const p = page();
    p.setHidden(true);
    const source = pings();
    const c = clock();
    let reads = 0;
    createRoomFeed({ pings: source, page: p, setInterval: c.setInterval, clearInterval: c.clearInterval }).follow({ room: 'r-1' }, () => {
      reads += 1;
    });
    source.ping();
    expect(reads).toBe(0);
    p.setHidden(false);
    expect(reads).toBe(1);
  });

  it('stopping lets go of the pings, the timer and the visibility listener', () => {
    const f = follow();
    f.stop();
    expect(f.source.count()).toBe(0);
    expect(f.c.periods()).toEqual([]);
    f.p.setHidden(true);
    f.p.setHidden(false);
    expect(f.reads()).toBe(1);
  });
});

/** A socket a test connects, drops, acknowledges for and speaks for. */
function fakeSocket() {
  const handlers = new Map<string, ((payload?: unknown) => void)[]>();
  const sent: RoomWatch[] = [];
  const acks: (() => void)[] = [];
  let connected = false;
  let closed = 0;
  const socket: FeedSocket = {
    on: (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    emit: (event, payload, ack) => {
      if (event !== ROOM_FEED_CHANNEL.watch) return;
      sent.push(payload as RoomWatch);
      acks.push(ack);
    },
    get connected() {
      return connected;
    },
    close: () => {
      closed += 1;
      connected = false;
    },
  };
  const fire = (event: string, payload?: unknown): void => {
    for (const h of handlers.get(event) ?? []) h(payload);
  };
  return {
    socket,
    sent,
    closed: () => closed,
    connect: () => {
      connected = true;
      fire('connect');
    },
    drop: () => {
      connected = false;
    },
    /** The server takes in every watch sent so far. */
    ack: () => {
      for (const a of acks.splice(0)) a();
    },
    /** The server takes in the oldest watch not yet taken. */
    ackOldest: () => acks.shift()?.(),
    say: (payload: unknown) => fire(ROOM_FEED_CHANNEL.changed, payload),
  };
}

describe('the page’s one socket', () => {
  it('opens for the first follower, says everything the page follows, and closes after the last', async () => {
    const fake = fakeSocket();
    let opened = 0;
    const source = socketPings(() => {
      opened += 1;
      return fake.socket;
    });
    const a = source.subscribe({ room: 'r-1' }, () => undefined);
    fake.connect();
    expect(fake.sent.at(-1)).toEqual({ rooms: ['r-1'], list: false });
    const b = source.subscribe('list', () => undefined);
    const c = source.subscribe({ room: 'r-1' }, () => undefined);
    expect(opened, 'one socket for the page').toBe(1);
    expect(fake.sent.at(-1)).toEqual({ rooms: ['r-1'], list: true });
    a();
    c();
    expect(fake.sent.at(-1)).toEqual({ rooms: [], list: true });
    expect(fake.closed()).toBe(0);
    b();
    await Promise.resolve();
    expect(fake.closed(), 'nothing follows: closed').toBe(1);
  });

  it('a follower that replaces the last one in the same tick keeps the socket, and the watch names only it', async () => {
    const fake = fakeSocket();
    let opened = 0;
    const source = socketPings(() => {
      opened += 1;
      return fake.socket;
    });
    const room = source.subscribe({ room: 'r-1' }, () => undefined);
    fake.connect();
    room();
    const list = source.subscribe('list', () => undefined);
    await Promise.resolve();
    expect(opened, 'the room screen gave way to the lobby on the same connection').toBe(1);
    expect(fake.closed()).toBe(0);
    expect(fake.sent.at(-1)).toEqual({ rooms: [], list: true });
    list();
    await Promise.resolve();
    expect(fake.closed()).toBe(1);
    source.subscribe({ room: 'r-2' }, () => undefined);
    expect(opened, 'a follower after the close opens a new one').toBe(2);
  });

  it('a ping reaches the followers of that room, or of the list, and nobody else', () => {
    const fake = fakeSocket();
    const source = socketPings(() => fake.socket);
    const heard: string[] = [];
    source.subscribe({ room: 'r-1' }, () => heard.push('r-1'));
    source.subscribe({ room: 'r-2' }, () => heard.push('r-2'));
    source.subscribe('list', () => heard.push('list'));
    fake.connect();
    fake.ack();
    heard.length = 0;
    fake.say({ room: 'r-2' });
    fake.say({ list: true });
    fake.say({ room: 'r-9' });
    fake.say({ nonsense: 1 });
    expect(heard).toEqual(['r-2', 'list']);
  });

  it('reads once more when the server confirms the watch — at the start, for a late follower, and after a drop', () => {
    const fake = fakeSocket();
    const source = socketPings(() => fake.socket);
    const heard: string[] = [];
    source.subscribe({ room: 'r-1' }, () => heard.push('r-1'));
    fake.connect();
    expect(heard, 'nothing is confirmed until the server says so').toEqual([]);
    fake.ack();
    expect(heard, 'confirmed: one catch-up read').toEqual(['r-1']);

    // A follower that joins later is caught up by ITS watch's ack, and the first is not read again.
    source.subscribe('list', () => heard.push('list'));
    fake.ack();
    expect(heard).toEqual(['r-1', 'list']);

    fake.drop();
    fake.connect();
    fake.ack();
    expect(heard, 'back after a drop: everyone once').toEqual(['r-1', 'list', 'r-1', 'list']);
  });

  it('an ack for a watch sent before a follower arrived does not count for it', () => {
    const fake = fakeSocket();
    const source = socketPings(() => fake.socket);
    const heard: string[] = [];
    source.subscribe({ room: 'r-1' }, () => heard.push('r-1'));
    fake.connect();
    source.subscribe({ room: 'r-2' }, () => heard.push('r-2'));
    fake.ackOldest();
    expect(heard, 'the first watch named only r-1').toEqual(['r-1']);
    fake.ackOldest();
    expect(heard).toEqual(['r-1', 'r-2']);
  });
});
