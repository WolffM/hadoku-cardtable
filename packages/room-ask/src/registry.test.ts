/**
 * SPDX-License-Identifier: MIT
 *
 * Part of `@hadoku/room-ask`, which is MIT — the single carve-out in a repo
 * that is otherwise GPL-3.0-or-later. Written clean-room from the requirement
 * in `docs/requests/P4_ASK_REGISTRY.md` and from nothing else.
 *
 * A-1 … A-17 are that document's §4 test list, one `it` each and named for it.
 * A-18 … A-20 cover behaviour the spec left open and this package decided.
 */

import { describe, expect, it } from 'vitest';
import {
  createSeatTable,
  formatParticipantId,
  isDurableParticipantId,
  padWithBots,
  seatParticipant,
  unseatParticipant,
  type ParticipantId,
  type SeatId,
  type SeatTable,
} from '@wolffm/rooms-protocol';

import { createManualClock, type ManualClock } from './clock.ts';
import { AskCancelledError, AskNotSeatedError, AskTimeoutError } from './errors.ts';
import { createAskRegistry, type AskRegistry } from './registry.ts';
import type { AskEnvelope, AskId } from './types.ts';

const P = formatParticipantId('account', '1111111111111111');
const Q = formatParticipantId('account', '2222222222222222');
const R = formatParticipantId('account', '3333333333333333');
const EPH = formatParticipantId('ephemeral', 'socket-eph-1');

const T0 = 1_700_000_000_000;

interface Sent {
  target: ParticipantId;
  socketKey: string;
  envelope: AskEnvelope;
}

interface Harness {
  seats: SeatTable;
  clock: ManualClock;
  sent: Sent[];
  reg: AskRegistry;
  /** Envelopes written to one socket, in emit order. */
  sentTo(socketKey: string): Sent[];
}

function harness(capacity: number | null = 8): Harness {
  const seats = createSeatTable(capacity);
  const clock = createManualClock(T0);
  const sent: Sent[] = [];
  const reg = createAskRegistry({
    seats,
    clock,
    deliver: (target, socketKey, envelope) => sent.push({ target, socketKey, envelope }),
  });
  return { seats, clock, sent, reg, sentTo: (k) => sent.filter((s) => s.socketKey === k) };
}

/** Lets a test assert "still pending" without awaiting something that never settles. */
interface Tracked<T> {
  settled: boolean;
  value?: T;
  error?: unknown;
  promise: Promise<T>;
}

function track<T>(promise: Promise<T>): Tracked<T> {
  const state: Tracked<T> = { settled: false, promise };
  promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (error) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

/** Drain the microtask queue so `track` has observed everything. */
const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

const askIdOf = (reg: AskRegistry, index = 0): AskId => {
  const row = reg.pending()[index];
  if (!row) throw new Error(`no pending ask at index ${index}`);
  return row.askId;
};

describe('participant fixtures', () => {
  it('uses durable ids for the reconnect cases and an ephemeral one for the gate', () => {
    expect([P, Q, R].every(isDurableParticipantId)).toBe(true);
    expect(isDurableParticipantId(EPH)).toBe(false);
  });
});

describe('§4.1 required', () => {
  it('A-1 — an ask that times out returns the declared value', async () => {
    const h = harness();
    seatParticipant(h.seats, P);
    h.reg.attach(P, 's1');

    const asked = track(
      h.reg.ask<'pass'>(P, 'pick', { pack: 1 }, { timeoutMs: 5_000, onTimeout: { mode: 'value', value: 'pass' } }),
    );

    h.clock.advance(5_000);
    await tick();

    expect(asked.settled).toBe(true);
    expect(asked.error).toBeUndefined();
    await expect(asked.promise).resolves.toBe('pass');
    expect(h.reg.stats().timedOut).toBe(1);
    expect(h.reg.stats().replied).toBe(0);
    expect(h.reg.pending()).toEqual([]);
  });

  it('A-2 — an ask replayed after reconnect resolves', async () => {
    const h = harness();
    seatParticipant(h.seats, P);
    h.reg.attach(P, 's1');

    const asked = track(
      h.reg.ask<number>(P, 'pick', { pack: 1, cards: ['a', 'b'] }, { timeoutMs: 60_000, onTimeout: { mode: 'throw' } }),
    );
    const askId = askIdOf(h.reg);

    expect(h.sentTo('s1')).toHaveLength(1);
    expect(h.sentTo('s1')[0]!.envelope.askId).toBe(askId);
    expect(h.reg.pending()[0]!.state).toBe('delivered');

    h.reg.detach(P, 's1');
    await tick();
    expect(h.reg.pending()[0]!.state).toBe('queued');
    expect(asked.settled).toBe(false);
    expect(h.reg.stats().cancelled).toBe(0);

    h.reg.attach(P, 's2');
    expect(h.sentTo('s2')).toHaveLength(1);
    expect(h.sentTo('s2')[0]!.envelope.askId).toBe(askId);
    expect(h.sentTo('s2')[0]!.envelope.payload).toEqual({ pack: 1, cards: ['a', 'b'] });

    expect(h.reg.submitReply(P, { askId, value: 42 })).toBe('matched');
    await expect(asked.promise).resolves.toBe(42);
    expect(h.reg.stats().replied).toBe(1);
  });

  it('A-3 — an ask cancelled by seat-exit rejects', async () => {
    const h = harness();
    seatParticipant(h.seats, P);
    h.reg.attach(P, 's1');

    const asked = track(h.reg.ask(P, 'pick', {}, { timeoutMs: 60_000, onTimeout: { mode: 'throw' } }));
    const askId = askIdOf(h.reg);

    unseatParticipant(h.seats, P);
    h.reg.seatExit(P);
    await tick();

    expect(asked.error).toBeInstanceOf(AskCancelledError);
    expect((asked.error as AskCancelledError).reason).toBe('seat-exit');
    expect(h.reg.stats().cancelled).toBe(1);
    expect(h.reg.pending()).toEqual([]);

    expect(h.reg.submitReply(P, { askId, value: 1 })).toBe('dropped');
    expect(h.reg.stats().droppedUnknownReplies).toBe(1);
  });

  it('A-4 — an unknown correlation id increments a counter and resolves nothing', async () => {
    const h = harness();
    seatParticipant(h.seats, P);
    h.reg.attach(P, 's1');

    const asked = track(h.reg.ask(P, 'pick', {}, { timeoutMs: 60_000, onTimeout: { mode: 'throw' } }));
    const n = askIdOf(h.reg);

    let result: 'matched' | 'dropped' | undefined;
    expect(() => {
      result = h.reg.submitReply(P, { askId: (n + 999) as AskId, value: 'x' });
    }).not.toThrow();

    expect(result).toBe('dropped');
    expect(h.reg.stats().droppedUnknownReplies).toBe(1);
    await tick();
    expect(asked.settled).toBe(false);
    expect(h.reg.stats().replied).toBe(0);
    expect(h.reg.pending()).toHaveLength(1);
    expect(h.reg.pending()[0]!.askId).toBe(n);
  });
});

describe('§4.2 added', () => {
  it('A-5 — correlation ids are monotonic', async () => {
    const h = harness();
    seatParticipant(h.seats, P);
    seatParticipant(h.seats, Q);
    h.reg.attach(P, 's1');
    h.reg.attach(Q, 't1');

    const ids: AskId[] = [];
    const opts = { timeoutMs: 60_000, onTimeout: { mode: 'throw' } } as const;
    const issue = (who: ParticipantId) => {
      const before = new Set(h.reg.pending().map((a) => a.askId));
      track(h.reg.ask(who, 'pick', {}, opts));
      const fresh = h.reg.pending().find((a) => !before.has(a.askId));
      ids.push(fresh!.askId);
    };

    issue(P);
    issue(Q);
    h.reg.detach(P, 's1');
    issue(P);
    h.reg.attach(P, 's2');
    issue(P);
    issue(Q);

    expect(ids).toHaveLength(5);
    for (let i = 1; i < ids.length; i++) expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);
    expect(new Set(ids).size).toBe(5);
    // The reconnect neither reset the counter nor handed out a used id.
    expect(ids[0]).toBe(1);
    expect(ids[4]).toBe(5);
  });

  it('A-6 — an ask issued with no live socket queues rather than failing', async () => {
    const h = harness();
    seatParticipant(h.seats, P);

    let asked!: Tracked<unknown>;
    expect(() => {
      asked = track(h.reg.ask(P, 'pick', { pack: 3 }, { timeoutMs: 60_000, onTimeout: { mode: 'throw' } }));
    }).not.toThrow();

    await tick();
    expect(asked.settled).toBe(false);
    expect(h.reg.pending()[0]!.state).toBe('queued');
    expect(h.reg.pending()[0]!.emitCount).toBe(0);
    expect(h.sent).toHaveLength(0);

    h.reg.attach(P, 's1');
    expect(h.sentTo('s1')).toHaveLength(1);
    expect(h.sentTo('s1')[0]!.envelope.payload).toEqual({ pack: 3 });
    expect(h.reg.pending()[0]!.state).toBe('delivered');
    expect(h.reg.pending()[0]!.emitCount).toBe(1);
  });

  it('A-7 — an ask can time out while queued', async () => {
    const h = harness();
    seatParticipant(h.seats, P);

    const asked = track(
      h.reg.ask<null>(P, 'pick', {}, { timeoutMs: 1_000, onTimeout: { mode: 'value', value: null } }),
    );
    const askId = askIdOf(h.reg);

    h.clock.advance(1_000);
    await expect(asked.promise).resolves.toBeNull();
    expect(h.reg.stats().timedOut).toBe(1);
    expect(h.reg.pending()).toEqual([]);

    h.reg.attach(P, 's1');
    expect(h.sent.filter((s) => s.envelope.askId === askId)).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  it('A-8 — onTimeout { mode: throw } rejects', async () => {
    const h = harness();
    seatParticipant(h.seats, P);
    h.reg.attach(P, 's1');

    const asked = track(h.reg.ask(P, 'pick', {}, { timeoutMs: 5_000, onTimeout: { mode: 'throw' } }));
    const askId = askIdOf(h.reg);

    h.clock.advance(5_000);
    await tick();

    expect(asked.error).toBeInstanceOf(AskTimeoutError);
    expect((asked.error as AskTimeoutError).askId).toBe(askId);
    expect((asked.error as AskTimeoutError).timeoutMs).toBe(5_000);
  });

  it('A-9 — abort signal rejects with reason signal', async () => {
    const h = harness();
    seatParticipant(h.seats, P);
    h.reg.attach(P, 's1');

    const ctrl = new AbortController();
    const asked = track(
      h.reg.ask(P, 'pick', {}, { timeoutMs: 60_000, onTimeout: { mode: 'throw' }, signal: ctrl.signal }),
    );

    ctrl.abort();
    await tick();

    expect(asked.error).toBeInstanceOf(AskCancelledError);
    expect((asked.error as AskCancelledError).reason).toBe('signal');
    expect(h.reg.stats().cancelled).toBe(1);

    ctrl.abort();
    await tick();
    expect(h.reg.stats().cancelled).toBe(1);
    expect(h.reg.pending()).toEqual([]);
  });

  it('A-10 — a socket drop on its own settles nothing', async () => {
    const h = harness();
    seatParticipant(h.seats, P);
    h.reg.attach(P, 's1');

    const asked = track(h.reg.ask(P, 'pick', {}, { timeoutMs: 10_000, onTimeout: { mode: 'throw' } }));

    h.reg.detach(P, 's1');
    h.clock.advance(9_999);
    await tick();

    expect(asked.settled).toBe(false);
    expect(h.reg.stats().cancelled).toBe(0);
    expect(h.reg.stats().timedOut).toBe(0);
    expect(h.reg.pending()[0]!.state).toBe('queued');
  });

  it('A-11 — a second reply to the same id is dropped and counted', async () => {
    const h = harness();
    seatParticipant(h.seats, P);
    h.reg.attach(P, 's1');

    const asked = track(h.reg.ask<string>(P, 'pick', {}, { timeoutMs: 60_000, onTimeout: { mode: 'throw' } }));
    const askId = askIdOf(h.reg);

    expect(h.reg.submitReply(P, { askId, value: 'first' })).toBe('matched');
    await tick();
    expect(asked.value).toBe('first');

    expect(h.reg.submitReply(P, { askId, value: 'second' })).toBe('dropped');
    await tick();

    expect(h.reg.stats().droppedUnknownReplies).toBe(1);
    expect(h.reg.stats().replied).toBe(1);
    expect(asked.value).toBe('first');
  });

  it('A-12 — a reply from the wrong participant is dropped and counted', async () => {
    const h = harness();
    seatParticipant(h.seats, P);
    seatParticipant(h.seats, Q);
    h.reg.attach(P, 's1');
    h.reg.attach(Q, 't1');

    const asked = track(h.reg.ask<string>(P, 'pick', {}, { timeoutMs: 60_000, onTimeout: { mode: 'throw' } }));
    const n = askIdOf(h.reg);

    expect(h.reg.submitReply(Q, { askId: n, value: 'stolen' })).toBe('dropped');
    expect(h.reg.stats().droppedUnknownReplies).toBe(1);
    await tick();
    expect(asked.settled).toBe(false);
    expect(h.reg.pending()).toHaveLength(1);

    expect(h.reg.submitReply(P, { askId: n, value: 'mine' })).toBe('matched');
    await expect(asked.promise).resolves.toBe('mine');
  });

  it('A-13 — replay order is issue order', () => {
    const h = harness();
    seatParticipant(h.seats, P);

    const opts = { timeoutMs: 60_000, onTimeout: { mode: 'throw' } } as const;
    track(h.reg.ask(P, 'pick', { n: 1 }, opts));
    track(h.reg.ask(P, 'pick', { n: 2 }, opts));
    track(h.reg.ask(P, 'pick', { n: 3 }, opts));
    expect(h.sent).toHaveLength(0);

    h.reg.attach(P, 's1');

    const got = h.sentTo('s1');
    expect(got).toHaveLength(3);
    expect(got.map((s) => s.envelope.askId)).toEqual([1, 2, 3]);
    expect(got.map((s) => s.envelope.payload)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('A-14 — an extra socket gets the same envelope, and the ask does not re-arm', async () => {
    const h = harness();
    seatParticipant(h.seats, P);
    h.reg.attach(P, 's1');

    const asked = track(h.reg.ask(P, 'pick', { pack: 7 }, { timeoutMs: 1_000, onTimeout: { mode: 'throw' } }));
    const askId = askIdOf(h.reg);
    const deadlineAt = h.reg.pending()[0]!.deadlineAt;

    h.clock.advance(600);
    h.reg.attach(P, 's2');

    expect(h.sentTo('s2')).toHaveLength(1);
    expect(h.sentTo('s2')[0]!.envelope.askId).toBe(askId);
    expect(h.sentTo('s2')[0]!.envelope.payload).toEqual({ pack: 7 });
    // Byte-identical: it is literally the same frozen envelope object.
    expect(h.sentTo('s2')[0]!.envelope).toBe(h.sentTo('s1')[0]!.envelope);
    expect(h.reg.pending()[0]!.emitCount).toBe(2);
    expect(h.reg.pending()[0]!.state).toBe('delivered');
    expect(h.reg.pending()[0]!.deadlineAt).toBe(deadlineAt);

    h.clock.advance(400); // t = 1_000: the second delivery bought no extra time
    await tick();
    expect(asked.error).toBeInstanceOf(AskTimeoutError);
    expect(h.reg.stats().timedOut).toBe(1);
  });

  it('A-15 — an unseated target rejects at issue and pollutes no counter', async () => {
    const h = harness();
    seatParticipant(h.seats, P);
    // R is "connected" (has a socket) but holds no seat.
    h.reg.attach(R, 'u1');

    await expect(
      h.reg.ask(R, 'pick', {}, { timeoutMs: 5_000, onTimeout: { mode: 'throw' } }),
    ).rejects.toBeInstanceOf(AskNotSeatedError);

    expect(h.reg.stats().issued).toBe(0);
    expect(h.reg.stats().droppedUnknownReplies).toBe(0);
    expect(h.reg.pending()).toEqual([]);
    expect(h.sent).toHaveLength(0);
  });

  it('A-16 — a SeatId ask binds to the occupant at issue time', async () => {
    const h = harness(1);
    const seat = seatParticipant(h.seats, P) as SeatId;
    expect(seat).toBe(0);
    h.reg.attach(P, 's1');

    const asked = track(h.reg.ask(seat, 'pick', {}, { timeoutMs: 60_000, onTimeout: { mode: 'throw' } }));
    const askId = askIdOf(h.reg);
    expect(h.reg.pending()[0]!.target).toBe(P);
    expect(h.reg.pending()[0]!.seat).toBe(seat);

    // Swap the seat's occupant. The host tells the registry P genuinely left.
    unseatParticipant(h.seats, P, { hold: false });
    expect(seatParticipant(h.seats, Q)).toBe(seat);
    h.reg.seatExit(P);
    await tick();

    expect(asked.error).toBeInstanceOf(AskCancelledError);
    expect((asked.error as AskCancelledError).reason).toBe('seat-exit');

    expect(h.reg.submitReply(Q, { askId, value: 'not mine to answer' })).toBe('dropped');
    expect(h.reg.stats().droppedUnknownReplies).toBe(1);
  });

  it('A-17 — counters and the dropped return never disagree', async () => {
    const h = harness(4);
    seatParticipant(h.seats, P);
    seatParticipant(h.seats, Q);
    const people: ParticipantId[] = [P, Q];
    const socketKeys: Record<ParticipantId, string[]> = { [P]: ['p1', 'p2'], [Q]: ['q1'] };
    const attached = new Set<string>();

    const rand = mulberry32(0xc0ffee); // fixed seed: a failure here is reproducible
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const tracked: Array<Tracked<unknown>> = [];

    /** Counted from RETURN VALUES ONLY — never read off stats(). */
    let droppedReturns = 0;
    const reply = (from: ParticipantId, askId: AskId, value: unknown) => {
      if (h.reg.submitReply(from, { askId, value }) === 'dropped') droppedReturns += 1;
    };

    const invariants = (step: number) => {
      const s = h.reg.stats();
      expect(
        s.replied + s.timedOut + s.cancelled + h.reg.pending().length,
        `step ${step}: issued must equal settled + pending`,
      ).toBe(s.issued);
      expect(droppedReturns, `step ${step}: 'dropped' returns must equal the counter`).toBe(
        s.droppedUnknownReplies,
      );
    };

    for (let step = 0; step < 400; step++) {
      const roll = rand();
      const who = pick(people);
      const live = h.reg.pending();

      if (roll < 0.3) {
        // issue
        tracked.push(
          track(
            h.reg.ask(
              who,
              'pick',
              { step },
              {
                timeoutMs: 500 + Math.floor(rand() * 3_000),
                onTimeout: rand() < 0.5 ? { mode: 'value', value: 'timeout' } : { mode: 'throw' },
              },
            ),
          ),
        );
      } else if (roll < 0.5 && live.length > 0) {
        // a genuine reply
        const row = pick(live);
        reply(row.target, row.askId, { step });
      } else if (roll < 0.62) {
        // a bogus reply: unknown id, settled id, or right id from the wrong seat
        const bogusRoll = rand();
        if (bogusRoll < 0.4 || live.length === 0) {
          reply(who, (10_000 + Math.floor(rand() * 1_000)) as AskId, 'bogus');
        } else {
          const row = pick(live);
          const impostor = row.target === P ? Q : P;
          reply(impostor, row.askId, 'stolen');
        }
      } else if (roll < 0.74) {
        const key = pick(socketKeys[who]!);
        attached.add(key);
        h.reg.attach(who, key);
      } else if (roll < 0.86) {
        const key = pick(socketKeys[who]!);
        attached.delete(key);
        h.reg.detach(who, key);
      } else if (roll < 0.94) {
        h.clock.advance(100 + Math.floor(rand() * 900));
      } else if (roll < 0.98) {
        h.reg.seatExit(who);
      } else if (live.length > 0) {
        h.reg.cancel(pick(live).askId, 'operator');
      }

      invariants(step);
    }

    h.clock.advance(60_000);
    invariants(400);
    h.reg.closeRoom();
    invariants(401);
    await tick();

    const s = h.reg.stats();
    // Guard against a vacuous pass: the sequence must really have exercised
    // every settle path and really have dropped some replies.
    expect(h.reg.pending()).toEqual([]);
    expect(tracked.every((t) => t.settled)).toBe(true);
    expect(s.issued).toBeGreaterThan(20);
    expect(s.replied).toBeGreaterThan(0);
    expect(s.timedOut).toBeGreaterThan(0);
    expect(s.cancelled).toBeGreaterThan(0);
    expect(droppedReturns).toBeGreaterThan(0);
    expect(s.droppedUnknownReplies).toBe(droppedReturns);
  });
});

describe('decisions this package made where the spec was open', () => {
  it('A-18 — §6.8: a SeatId resolving to a bot rejects at issue', async () => {
    const h = harness(4);
    seatParticipant(h.seats, P);
    const botSeats = padWithBots(h.seats, 2);
    expect(botSeats.length).toBeGreaterThan(0);

    await expect(
      h.reg.ask(botSeats[0]!, 'pick', {}, { timeoutMs: 1_000, onTimeout: { mode: 'throw' } }),
    ).rejects.toBeInstanceOf(AskNotSeatedError);

    // An out-of-range seat is the same answer.
    await expect(
      h.reg.ask(99 as SeatId, 'pick', {}, { timeoutMs: 1_000, onTimeout: { mode: 'throw' } }),
    ).rejects.toBeInstanceOf(AskNotSeatedError);

    expect(h.reg.stats().issued).toBe(0);
    expect(h.reg.stats().droppedUnknownReplies).toBe(0);
  });

  it('A-19 — replay is for durable ids: an ephemeral re-attach does not replay', async () => {
    const h = harness();
    seatParticipant(h.seats, EPH);
    h.reg.attach(EPH, 'socket-eph-1');

    const asked = track(h.reg.ask(EPH, 'pick', {}, { timeoutMs: 5_000, onTimeout: { mode: 'throw' } }));
    expect(h.sent).toHaveLength(1);

    h.reg.detach(EPH, 'socket-eph-1');
    expect(h.reg.pending()[0]!.state).toBe('queued');

    // There is no later socket that is "the same participant": the id IS the
    // socket. A host that attaches anyway gets no replay, and the ask times out.
    h.reg.attach(EPH, 'socket-eph-2');
    expect(h.sent).toHaveLength(1);
    expect(h.reg.pending()[0]!.state).toBe('queued');

    h.clock.advance(5_000);
    await tick();
    expect(asked.error).toBeInstanceOf(AskTimeoutError);
  });

  it('A-20 — closeRoom cancels everything pending with reason room-closed', async () => {
    const h = harness();
    seatParticipant(h.seats, P);
    seatParticipant(h.seats, Q);
    h.reg.attach(P, 's1');

    const a = track(h.reg.ask(P, 'pick', {}, { timeoutMs: 60_000, onTimeout: { mode: 'throw' } }));
    const b = track(h.reg.ask(Q, 'pick', {}, { timeoutMs: 60_000, onTimeout: { mode: 'value', value: 'x' } }));
    const askId = askIdOf(h.reg);

    h.reg.closeRoom();
    await tick();

    for (const t of [a, b]) {
      expect(t.error).toBeInstanceOf(AskCancelledError);
      expect((t.error as AskCancelledError).reason).toBe('room-closed');
    }
    expect(h.reg.stats().cancelled).toBe(2);
    expect(h.reg.pending()).toEqual([]);

    // A reply arriving after the room is gone is an unknown id, not an error.
    expect(h.reg.submitReply(P, { askId, value: 1 })).toBe('dropped');
    expect(h.reg.stats().droppedUnknownReplies).toBe(1);

    // Asking a closed room is accepted, counted and immediately cancelled, so
    // the counters stay consistent instead of quietly leaking an ask.
    const late = track(h.reg.ask(P, 'pick', {}, { timeoutMs: 60_000, onTimeout: { mode: 'throw' } }));
    await tick();
    expect((late.error as AskCancelledError).reason).toBe('room-closed');
    const s = h.reg.stats();
    expect(s.issued).toBe(s.replied + s.timedOut + s.cancelled + h.reg.pending().length);
  });

  it('cancel() is idempotent and reports whether it did anything', async () => {
    const h = harness();
    seatParticipant(h.seats, P);
    h.reg.attach(P, 's1');

    const asked = track(h.reg.ask(P, 'pick', {}, { timeoutMs: 60_000, onTimeout: { mode: 'throw' } }));
    const askId = askIdOf(h.reg);

    expect(h.reg.cancel(askId, 'operator')).toBe(true);
    expect(h.reg.cancel(askId, 'operator')).toBe(false);
    expect(h.reg.cancel(4_242 as AskId)).toBe(false);
    await tick();
    expect((asked.error as AskCancelledError).reason).toBe('operator');
    expect(h.reg.stats().cancelled).toBe(1);
  });

  it('attach/detach of a key already present or already gone moves nothing', () => {
    const h = harness();
    seatParticipant(h.seats, P);
    h.reg.attach(P, 's1');
    track(h.reg.ask(P, 'pick', {}, { timeoutMs: 60_000, onTimeout: { mode: 'throw' } }));
    expect(h.sent).toHaveLength(1);

    h.reg.attach(P, 's1');
    expect(h.sent).toHaveLength(1);
    expect(h.reg.pending()[0]!.emitCount).toBe(1);

    h.reg.detach(P, 'never-attached');
    expect(h.reg.pending()[0]!.state).toBe('delivered');
    h.reg.detach(P, 's1');
    h.reg.detach(P, 's1');
    expect(h.reg.pending()[0]!.state).toBe('queued');
    expect(h.reg.stats().queued).toBe(1);
  });
});

/** Small seeded PRNG so A-17's "randomised" sequence is one exact sequence. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
