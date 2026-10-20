/*
 * The socket driver, against a stub transport.
 *
 * There is no server to talk to — it is being built in parallel — and there
 * would be no point testing against one anyway: what can go wrong here is the
 * DISPATCH, not socket.io. So the transport is three methods and a test can
 * hand the driver any sequence of envelopes it likes, including the ones a
 * healthy server would never send.
 *
 * The payloads are the five COMMITTED fixtures, re-stamped with the sequence
 * numbers each case needs. Inventing a payload here would test the driver
 * against a shape nothing else in the repo agrees with.
 *
 * The assertion that matters most is a negative and a COUNT: a run of
 * duplicates must produce exactly zero resync requests. "It did not throw" is
 * not the property — a client that answers a retransmit burst with a request
 * per duplicate does not throw either, it just takes the server down.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  DRAFT_CHANNEL,
  safeParseClientMessage,
  stateMessage,
  updateMessage,
  errorMessage,
  type ClientMessage,
  type DraftView,
} from '@hadoku/shared';

import { loadFixtures } from './fixtures.ts';
import {
  applyPick,
  closeDraft,
  cubeName,
  cubeSize,
  ingest,
  isComplete,
  myPool,
  mySeat,
  socketPath,
  startDraft,
  type DraftTransport,
  type SocketDraft,
} from './socket.ts';

/* ── A stub transport ────────────────────────────────────────────────── */

interface Stub {
  transport: DraftTransport;
  /** Everything the driver put on the wire, in order. */
  sent: { event: string; message: unknown }[];
  /** Deliver an event to the driver, as socket.io would. */
  fire(event: string, payload?: unknown): void;
  disconnects: number;
}

function makeStub(): Stub {
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  const stub: Stub = {
    sent: [],
    disconnects: 0,
    fire(event, payload) {
      for (const h of handlers.get(event) ?? []) h(payload);
    },
    transport: {
      on(event, handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      emit(event, message) {
        stub.sent.push({ event, message });
      },
      disconnect() {
        stub.disconnects += 1;
      },
    },
  };
  return stub;
}

/** Everything the driver sent, parsed — junk on our own wire is a failure too. */
function outbound(stub: Stub): ClientMessage[] {
  return stub.sent.map((s) => {
    expect(s.event).toBe(DRAFT_CHANNEL.clientToServer);
    const parsed = safeParseClientMessage(s.message);
    if (!parsed.ok) {
      throw new Error(
        `the driver emitted something that is not a ClientMessage:\n` +
          parsed.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n'),
      );
    }
    return parsed.value;
  });
}

function countOf(stub: Stub, type: ClientMessage['type']): number {
  return outbound(stub).filter((m) => m.type === type).length;
}

/* ── Payloads ────────────────────────────────────────────────────────── */

const FIXTURES = loadFixtures();

/** A committed fixture, re-stamped onto a given point in a given stream. */
function at(seq: number, epoch = 'e1', index = 0): DraftView {
  const base = FIXTURES[index];
  if (base === undefined) throw new Error('no fixture');
  return { ...base, epoch, seq };
}

function connect(stub: Stub): SocketDraft {
  return startDraft({ draftId: 'draft:test', transport: stub.transport });
}

/* ── The base path ───────────────────────────────────────────────────── */

describe('the socket.io path carries the base prefix', () => {
  it('turns /cardtable/ into /cardtable/socket.io/', () => {
    // The edge strips /cardtable, so the SERVER sees its own default
    // /socket.io/ — but the browser has to ask for the prefixed one.
    expect(socketPath('/cardtable/')).toBe('/cardtable/socket.io/');
  });

  it('tolerates a base with no trailing slash, and a root base', () => {
    expect(socketPath('/cardtable')).toBe('/cardtable/socket.io/');
    expect(socketPath('/')).toBe('/socket.io/');
    expect(socketPath('')).toBe('/socket.io/');
  });

  it('never emits a double slash, which 404s just as well', () => {
    for (const base of ['/cardtable/', '/cardtable', '/', '']) {
      expect(socketPath(base)).not.toContain('//');
    }
  });
});

/* ── Joining ─────────────────────────────────────────────────────────── */

describe('joining', () => {
  let stub: Stub;
  beforeEach(() => {
    stub = makeStub();
  });

  it('joins with a draft id and NOTHING that says who we are', () => {
    connect(stub);
    const messages = outbound(stub);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: 'join', draftId: 'draft:test' });
    // The server derives identity from the edge headers. If this ever grows a
    // field, `safeParseClientMessage` above fails before this line does.
    expect(JSON.stringify(messages[0])).not.toMatch(/participant|seat|token|name/i);
  });

  it('does not re-join on the FIRST connect — the buffered join covered it', () => {
    connect(stub);
    stub.fire('connect');
    expect(countOf(stub, 'join')).toBe(1);
  });

  it('re-joins after a reconnect, which is how a refresh returns to its seat', () => {
    const draft = connect(stub);
    stub.fire('connect');
    stub.fire('disconnect');
    expect(draft.connected).toBe(false);
    stub.fire('connect');
    expect(draft.connected).toBe(true);
    expect(countOf(stub, 'join')).toBe(2);
    // A re-join is answered with a snapshot, so it must NOT also ask for a
    // resync — that would be two full-state responses for one reconnect.
    expect(countOf(stub, 'resync')).toBe(0);
  });

  it('leaves and hangs up', () => {
    const draft = connect(stub);
    closeDraft(draft);
    expect(countOf(stub, 'leave')).toBe(1);
    expect(stub.disconnects).toBe(1);
    expect(draft.connected).toBe(false);
  });
});

/* ── The classifySeq dispatch, verdict by verdict ────────────────────── */

describe('classifySeq dispatch', () => {
  let stub: Stub;
  let draft: SocketDraft;
  beforeEach(() => {
    stub = makeStub();
    draft = connect(stub);
  });

  it('ok — applies, in order', () => {
    ingest(draft, stateMessage(at(1)));
    ingest(draft, updateMessage(at(2)));
    ingest(draft, updateMessage(at(3)));
    expect(draft.stats.applied).toBe(3);
    expect(draft.cursor).toEqual({ epoch: 'e1', seq: 3 });
    expect(draft.lastVerdict).toBe('ok');
    expect(countOf(stub, 'resync')).toBe(0);
  });

  it('duplicate — drops, and a RUN of them asks for NOTHING', () => {
    ingest(draft, stateMessage(at(1)));
    ingest(draft, updateMessage(at(2)));
    const before = draft.stats.applied;

    // A retransmit burst: the same envelope eight times, plus older ones.
    for (let i = 0; i < 8; i++) ingest(draft, updateMessage(at(2)));
    for (const seq of [1, 2, 1, 2, 1]) ingest(draft, updateMessage(at(seq)));

    expect(draft.stats.duplicatesDropped).toBe(13);
    // THE assertion: a count, not an absence of a throw.
    expect(countOf(stub, 'resync')).toBe(0);
    expect(draft.stats.resyncsRequested).toBe(0);
    // And nothing was re-applied.
    expect(draft.stats.applied).toBe(before);
    expect(draft.cursor).toEqual({ epoch: 'e1', seq: 2 });
  });

  it('duplicate — an OLD snapshot does not clobber newer state', () => {
    ingest(draft, stateMessage(at(1)));
    ingest(draft, updateMessage(at(2)));
    ingest(draft, updateMessage(at(3)));
    ingest(draft, stateMessage(at(2)));
    expect(draft.cursor).toEqual({ epoch: 'e1', seq: 3 });
    expect(countOf(stub, 'resync')).toBe(0);
  });

  it("a watch's answer — the same moment over another drafter's shoulder — is adopted; a stale or repeated one is not", () => {
    const seat = at(1);
    if (seat.viewer.kind !== 'seat') throw new Error('expected a seat fixture');
    const watching = (seq: number, seatId: number): DraftView => ({
      ...at(seq),
      viewer: { kind: 'watcher', seatId, pack: seat.viewer.kind === 'seat' ? seat.viewer.pack : [], pool: [] },
    });
    ingest(draft, stateMessage(watching(1, 0)));
    ingest(draft, updateMessage(watching(2, 0)));
    ingest(draft, stateMessage(watching(2, 3)));
    expect(draft.view?.viewer).toMatchObject({ kind: 'watcher', seatId: 3 });
    ingest(draft, stateMessage(watching(2, 3)));
    ingest(draft, stateMessage(watching(1, 5)));
    expect(draft.view?.viewer).toMatchObject({ kind: 'watcher', seatId: 3 });
    expect(draft.stats.duplicatesDropped).toBe(2);
    expect(countOf(stub, 'resync')).toBe(0);
  });

  it('gap — asks for a resync, carrying the cursor it actually has', () => {
    ingest(draft, stateMessage(at(1)));
    ingest(draft, updateMessage(at(9)));

    expect(draft.stats.gaps).toBe(1);
    expect(countOf(stub, 'resync')).toBe(1);
    const req = outbound(stub).find((m) => m.type === 'resync');
    expect(req).toEqual({ type: 'resync', draftId: 'draft:test', have: { epoch: 'e1', seq: 1 } });
    // The gapped envelope was NOT applied — that is what a gap means.
    expect(draft.cursor).toEqual({ epoch: 'e1', seq: 1 });
  });

  it('gap — several out-of-order envelopes produce ONE request, not one each', () => {
    ingest(draft, stateMessage(at(1)));
    for (const seq of [9, 10, 11, 12]) ingest(draft, updateMessage(at(seq)));
    expect(countOf(stub, 'resync')).toBe(1);

    // …and the resync's answer re-arms it, so a later gap is still reported.
    ingest(draft, stateMessage(at(12)));
    ingest(draft, updateMessage(at(20)));
    expect(countOf(stub, 'resync')).toBe(2);
  });

  it('gap — a SNAPSHOT is the baseline and is never answered with a resync', () => {
    ingest(draft, stateMessage(at(1)));
    ingest(draft, stateMessage(at(500)));
    expect(draft.cursor).toEqual({ epoch: 'e1', seq: 500 });
    expect(countOf(stub, 'resync')).toBe(0);
  });

  it('epoch-change — discards local state, then refetches', () => {
    ingest(draft, stateMessage(at(1)));
    ingest(draft, updateMessage(at(2)));
    expect(draft.view).not.toBeNull();

    // The server restarted and is counting from 1 again. Under a seq-only
    // cursor this reads as a duplicate and the client discards live events for
    // the rest of the draft.
    ingest(draft, updateMessage(at(1, 'e2')));

    expect(draft.stats.epochChanges).toBe(1);
    expect(draft.view).toBeNull();
    expect(draft.cursor).toBeNull();
    expect(countOf(stub, 'resync')).toBe(1);
    expect(outbound(stub).find((m) => m.type === 'resync')).toEqual({
      type: 'resync',
      draftId: 'draft:test',
      have: null,
    });
  });

  it('epoch-change arriving as a snapshot rebuilds in place, no request', () => {
    ingest(draft, stateMessage(at(1)));
    ingest(draft, stateMessage(at(1, 'e2')));
    expect(draft.cursor).toEqual({ epoch: 'e2', seq: 1 });
    expect(draft.stats.epochChanges).toBe(1);
    expect(countOf(stub, 'resync')).toBe(0);
  });
});

/* ── What the envelope says it carries ───────────────────────────────── */

describe('a full-state update is not a delta', () => {
  let stub: Stub;
  let draft: SocketDraft;
  beforeEach(() => {
    stub = makeStub();
    draft = connect(stub);
    ingest(draft, stateMessage(at(1)));
  });

  it('applies across a seq jump with NO resync — a pick and the bots behind it', () => {
    // One human pick plus six bot picks is seven engine bumps and one envelope.
    ingest(draft, updateMessage(at(8), 'full-state'));

    // classifySeq is not overruled about what happened…
    expect(draft.lastVerdict).toBe('gap');
    expect(draft.stats.gaps).toBe(1);
    // …but nothing was lost, so nothing is asked for.
    expect(draft.stats.gapsBridged).toBe(1);
    expect(countOf(stub, 'resync')).toBe(0);
    expect(draft.resyncPending).toBe(false);
    expect(draft.cursor).toEqual({ epoch: 'e1', seq: 8 });
    expect(draft.view?.seq).toBe(8);
    expect(draft.stats.applied).toBe(2);
  });

  it('a whole draft of jumping rounds costs zero resyncs, not one per round', () => {
    for (let round = 1; round <= 45; round++) {
      ingest(draft, updateMessage(at(1 + round * 7), 'full-state'));
    }
    expect(draft.stats.gapsBridged).toBe(45);
    expect(countOf(stub, 'resync')).toBe(0);
    expect(draft.cursor).toEqual({ epoch: 'e1', seq: 1 + 45 * 7 });
  });

  it('is still dropped when it is OLD — full state does not clobber newer state', () => {
    ingest(draft, updateMessage(at(8), 'full-state'));
    ingest(draft, updateMessage(at(5), 'full-state'));
    expect(draft.cursor).toEqual({ epoch: 'e1', seq: 8 });
    expect(draft.stats.duplicatesDropped).toBe(1);
    expect(countOf(stub, 'resync')).toBe(0);
  });

  it('epoch-change — still discards local state and refetches, whatever it carries', () => {
    ingest(draft, updateMessage(at(8), 'full-state'));
    expect(draft.view).not.toBeNull();

    ingest(draft, updateMessage(at(3, 'e2'), 'full-state'));

    expect(draft.lastVerdict).toBe('epoch-change');
    expect(draft.stats.epochChanges).toBe(1);
    expect(draft.stats.gapsBridged).toBe(1);
    // Discarded, not adopted: a restart is the one thing a complete payload
    // does not make safe to take as a step.
    expect(draft.view).toBeNull();
    expect(draft.cursor).toBeNull();
    expect(countOf(stub, 'resync')).toBe(1);
    expect(outbound(stub).find((m) => m.type === 'resync')).toEqual({
      type: 'resync',
      draftId: 'draft:test',
      have: null,
    });
  });

  it('an explicit delta with a gap still resyncs', () => {
    ingest(draft, updateMessage(at(8), 'delta'));
    expect(draft.stats.gaps).toBe(1);
    expect(draft.stats.gapsBridged).toBe(0);
    expect(countOf(stub, 'resync')).toBe(1);
    expect(draft.cursor).toEqual({ epoch: 'e1', seq: 1 });
  });

  it('an UNMARKED update with a gap still resyncs — absent means delta', () => {
    ingest(draft, updateMessage(at(8)));
    expect(draft.stats.gapsBridged).toBe(0);
    expect(countOf(stub, 'resync')).toBe(1);
    expect(draft.cursor).toEqual({ epoch: 'e1', seq: 1 });
  });

  it('answers an outstanding resync, and the late snapshot then drops as a duplicate', () => {
    ingest(draft, updateMessage(at(8)));
    expect(draft.resyncPending).toBe(true);
    ingest(draft, updateMessage(at(15), 'full-state'));
    expect(draft.resyncPending).toBe(false);
    ingest(draft, stateMessage(at(8)));
    expect(draft.cursor).toEqual({ epoch: 'e1', seq: 15 });
    expect(countOf(stub, 'resync')).toBe(1);
  });
});

/* ── Errors and junk ─────────────────────────────────────────────────── */

describe('rejections', () => {
  let stub: Stub;
  let draft: SocketDraft;
  beforeEach(() => {
    stub = makeStub();
    draft = connect(stub);
    ingest(draft, stateMessage(at(4)));
  });

  it('surfaces a rejection as a code, and leaves the stream alone', () => {
    ingest(draft, errorMessage({ epoch: 'e1', seq: 4 }, 'already-picked', 'seat 0'));
    expect(draft.lastError).toEqual({ code: 'already-picked', detail: 'seat 0' });
    expect(draft.stats.rejected).toBe(1);
    expect(draft.cursor).toEqual({ epoch: 'e1', seq: 4 });
    expect(draft.stats.applied).toBe(1);
  });

  it('never answers a rejection with a resync — including rate limiting', () => {
    for (let i = 0; i < 10; i++) {
      ingest(draft, errorMessage({ epoch: 'e1', seq: 4 }, 'rate-limited'));
    }
    expect(draft.stats.rejected).toBe(10);
    expect(countOf(stub, 'resync')).toBe(0);
  });

  it('clears the rejection once a payload applies', () => {
    ingest(draft, errorMessage({ epoch: 'e1', seq: 4 }, 'not-your-turn'));
    expect(draft.lastError).not.toBeNull();
    ingest(draft, updateMessage(at(5)));
    expect(draft.lastError).toBeNull();
  });

  it('refuses junk, and does not apply it', () => {
    for (const junk of [null, 42, {}, { type: 'update' }, { type: 'nope' }]) {
      ingest(draft, junk);
    }
    expect(draft.stats.invalid).toBe(5);
    expect(draft.stats.applied).toBe(1);
    expect(draft.cursor).toEqual({ epoch: 'e1', seq: 4 });
  });

  it('refuses a payload that leaks another seat, even from OUR OWN server', () => {
    const leaky = at(5);
    const seats = leaky.seats.map((s) => ({ ...s }));
    (seats[1] as unknown as Record<string, unknown>).pack = [{ cardId: 'x', name: 'Ancestral Recall' }];
    ingest(draft, updateMessage({ ...leaky, seats }));

    expect(draft.stats.invalid).toBe(1);
    expect(draft.stats.applied).toBe(1);
    expect(draft.lastInvalid?.some((e) => e.path.includes('seats[1]'))).toBe(true);
  });

  it('refuses a payload carrying an image URL (D13)', () => {
    const view = at(5);
    if (view.viewer.kind !== 'seat') throw new Error('fixture 0 must be a seat view');
    const pack = view.viewer.pack.map((c) => ({ ...c }));
    (pack[0] as unknown as Record<string, unknown>).art = 'https://cards.scryfall.io/normal/x.jpg';
    ingest(draft, updateMessage({ ...view, viewer: { ...view.viewer, pack } }));

    expect(draft.stats.invalid).toBe(1);
    expect(draft.lastInvalid?.some((e) => /D13/.test(e.message))).toBe(true);
  });
});

/* ── The surface `live.ts` shares ────────────────────────────────────── */

describe('the same surface as the in-process source', () => {
  let stub: Stub;
  let draft: SocketDraft;
  beforeEach(() => {
    stub = makeStub();
    draft = connect(stub);
  });

  it('answers nothing useful before the first snapshot, without throwing', () => {
    expect(draft.view).toBeNull();
    expect(myPool(draft)).toEqual([]);
    expect(isComplete(draft)).toBe(false);
    expect(mySeat(draft)).toBeNull();
    expect(cubeName(draft)).toBeNull();
    expect(cubeSize(draft)).toBeNull();
  });

  it('applyPick emits a pick by card id, and says nothing about a seat', () => {
    ingest(draft, stateMessage(at(1)));
    const seat = draft.view?.viewer;
    if (seat?.kind !== 'seat') throw new Error('fixture 0 must be a seat view');
    const card = seat.pack[0];
    if (card === undefined) throw new Error('fixture 0 must have a pack');

    const same = applyPick(draft, card.cardId);
    expect(same).toBe(draft);
    const pick = outbound(stub).find((m) => m.type === 'pick');
    expect(pick).toEqual({ type: 'pick', draftId: 'draft:test', cardId: card.cardId });
  });

  it('myPool and mySeat read the viewer slice', () => {
    ingest(draft, stateMessage(at(1)));
    const seat = draft.view?.viewer;
    if (seat?.kind !== 'seat') throw new Error('fixture 0 must be a seat view');
    expect(myPool(draft)).toEqual(seat.pool);
    expect(mySeat(draft)).toBe(seat.seatId);
  });

  it('names the cube when the server names one, and stays null when it does not', () => {
    ingest(draft, stateMessage(at(1)));
    expect(cubeName(draft)).toBeNull();
    ingest(draft, stateMessage(at(2), { name: 'Vintage Cube', size: 540 }));
    expect(cubeName(draft)).toBe('Vintage Cube');
    expect(cubeSize(draft)).toBe(540);
  });

  it('isComplete is derived: the pool holds every pick the draft has', () => {
    const base = at(1);
    const viewer = base.viewer;
    if (viewer.kind !== 'seat') throw new Error('fixture 0 must be a seat view');
    const template = viewer.pack[0] ?? viewer.pool[0];
    if (template === undefined) throw new Error('fixture 0 must carry at least one card');

    // 3 packs x 15 = 45 picks. A pool of exactly that many distinct cards, and
    // a matching `pickedCount`, so the payload stays internally coherent and
    // the semantic rules do not reject it for an unrelated reason.
    const pool = Array.from({ length: base.packCount * base.packSize }, (_, i) => ({
      ...template,
      cardId: `done-${i}`,
    }));
    const complete: DraftView = {
      ...base,
      seats: base.seats.map((s) => (s.id === viewer.seatId ? { ...s, pickedCount: pool.length } : s)),
      viewer: { ...viewer, pack: [], pool },
    };

    expect(isComplete(draft)).toBe(false);
    ingest(draft, stateMessage(complete));
    expect(draft.stats.invalid).toBe(0);
    expect(isComplete(draft)).toBe(true);
  });

  it('notifies on every observable change', () => {
    const seen: number[] = [];
    const stub2 = makeStub();
    const d = startDraft({
      draftId: 'draft:test',
      transport: stub2.transport,
      onChange: (x) => seen.push(x.revision),
    });
    ingest(d, stateMessage(at(1)));
    ingest(d, updateMessage(at(2)));
    ingest(d, updateMessage(at(2)));
    expect(seen).toEqual([1, 2, 3]);
  });
});
