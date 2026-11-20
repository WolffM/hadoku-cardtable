/*
 * The cards that ask several seats (`choices.ts`), against the engine:
 * Paliano, the High City and Regicide's three colours, and Deal Broker's
 * exchange after the last pick.
 */

import { describe, expect, it } from 'vitest';
import { DraftViewSchema, semanticIssues, type DraftCard, type DraftView } from '@hadoku/shared';
import { answer, asksOf, createDraft, packOf, pick, waitingOn, type DraftState } from '../engine.ts';
import { runBots } from '../bot.ts';
import { timeoutPick } from '../pick-timer.ts';
import { spectatorView, viewFor, watcherView } from '../view.ts';
import { card, finish, reply, table, take } from './actions.test.ts';

const BROKER = 'Deal Broker';

const ownAsks = (state: DraftState, seat: number) => {
  const own = viewFor(state, seat).viewer;
  return own.kind === 'seat' ? (own.asks ?? []) : [];
};
const ownSeen = (state: DraftState, seat: number) => {
  const own = viewFor(state, seat).viewer;
  return own.kind === 'seat' ? (own.seen ?? []) : [];
};
const logOf = (view: DraftView) => (view.log ?? []).map((l) => [l.seatId, l.verb, ...(l.cards ?? []).map((c) => c.cardId), l.detail].filter((x) => x !== undefined).join(' '));
const keys = (state: DraftState, seat: number) => asksOf(state, seat)[0]?.options?.map((o) => o.key);

/** Two people, two rounds of three: each is the other's left and right neighbour. */
function tableOfTwo(first: DraftCard): DraftState {
  const packs = Array.from({ length: 2 }, (_, r) => Array.from({ length: 2 }, (_, s) => Array.from({ length: 3 }, (_, i) => card(`r${r}s${s}c${i}`))));
  packs[0]![0]![0] = first;
  return createDraft({
    draftId: 'draft:two',
    seed: 'two',
    packs,
    seatCount: 2,
    packCount: 2,
    packSize: 3,
    humans: [
      { participantId: 'fk:alice', displayName: 'alice' },
      { participantId: 'fk:bob', displayName: 'bob' },
    ],
  });
}

describe.each(['Paliano, the High City', 'Regicide'])('%s', (name) => {
  const drafted = () => take(table([card('three', name, 'Legendary Land')]), 0, 'three');

  it('is revealed to the table as it is drafted, and is not left face up', () => {
    const state = drafted();
    for (const view of [viewFor(state, 1), spectatorView(state)]) {
      expect(view.log?.map((l) => `${l.seatId} ${l.verb} ${l.cards?.[0]?.name}`)).toEqual([`0 revealed ${name}`]);
      expect(view.seats[0]?.faceUp).toBeUndefined();
      expect(semanticIssues(view)).toEqual([]);
    }
  });

  it('asks the player to the right, then its drafter, then the player to the left, each for a colour not yet chosen', () => {
    let state = drafted();
    // Seat 3 is to seat 0's right: it alone is asked, with all five.
    expect(state.asks.map((a) => a.seatId)).toEqual([3]);
    expect(ownAsks(state, 3).map((a) => [a.source, a.title, a.options?.map((o) => o.key)])).toEqual([[name, 'Choose a color for alice', ['white', 'blue', 'black', 'red', 'green']]]);
    expect(ownAsks(state, 0)).toEqual([]);
    expect(ownAsks(state, 1)).toEqual([]);

    state = reply(state, 3, 'red');
    expect(state.asks.map((a) => a.seatId)).toEqual([0]);
    expect(keys(state, 0)).toEqual(['white', 'blue', 'black', 'green']);

    state = reply(state, 0, 'white');
    expect(state.asks.map((a) => a.seatId)).toEqual([1]);
    expect(keys(state, 1)).toEqual(['blue', 'black', 'green']);
    expect(state.notes[0]).toEqual({});

    state = reply(state, 1, 'green');
    expect(state.asks).toEqual([]);
    // Forge's own note: one entry, the three colours in the order chosen.
    expect(state.notes[0]).toEqual({ [name]: ['red,white,green'] });
    expect(state.notes[1]).toEqual({});
    expect(state.notes[3]).toEqual({});
    for (const view of [viewFor(state, 0), viewFor(state, 2), watcherView(state, 1), spectatorView(state)]) {
      expect(DraftViewSchema.parse(view).log?.at(-1)).toEqual({ n: 2, seatId: 0, verb: 'noted', detail: `red, white, green for ${name}` });
      expect(semanticIssues(view)).toEqual([]);
    }
  });

  it('stops the asked seat from picking until it answers, and nobody else', () => {
    const state = drafted();
    expect(waitingOn(state)).toContain(3);
    expect(pick(state, 3, packOf(state, 3)[0]!.cardId)).toMatchObject({ ok: false, reason: 'ask-open' });
    expect(pick(state, 1, packOf(state, 1)[0]!.cardId)).toMatchObject({ ok: true });
    const answered = reply(state, 3, 'blue');
    expect(pick(answered, 3, packOf(answered, 3)[0]!.cardId)).toMatchObject({ ok: true });
  });

  it('refuses an answer from another seat, a colour already chosen, and anything that is no colour', () => {
    const state = reply(drafted(), 3, 'red');
    const open = asksOf(state, 0)[0]!;
    expect(answer(state, 1, open.id, 'white')).toMatchObject({ ok: false, reason: 'unknown-ask' });
    expect(answer(state, 0, open.id, 'red')).toMatchObject({ ok: false, reason: 'bad-answer' });
    expect(answer(state, 0, open.id, 'purple')).toMatchObject({ ok: false, reason: 'bad-answer' });
    expect(state.asks).toHaveLength(1);
  });

  it('in a pod of two the one neighbour chooses first and last', () => {
    let state = take(tableOfTwo(card('three', name, 'Instant')), 0, 'three');
    expect(state.asks.map((a) => a.seatId)).toEqual([1]);
    state = reply(state, 1, 'black');
    expect(state.asks.map((a) => a.seatId)).toEqual([0]);
    state = reply(state, 0, 'blue');
    expect(state.asks.map((a) => a.seatId)).toEqual([1]);
    expect(keys(state, 1)).toEqual(['white', 'red', 'green']);
    state = reply(state, 1, 'green');
    expect(state.notes[0]).toEqual({ [name]: ['black,blue,green'] });
  });

  it('bots, and a seat whose time runs out, choose the first colour offered', () => {
    // Seat 3 and seat 1 are bots; seat 0's time runs out on its own ask.
    let state = runBots(drafted()).state;
    expect(state.asks.map((a) => a.seatId)).toEqual([0]);
    expect(keys(state, 0)).toEqual(['blue', 'black', 'red', 'green']);
    const timed = timeoutPick(state, 0);
    if (timed?.ok !== true) throw new Error('the timer should answer');
    state = runBots(timed.state).state;
    expect(state.asks).toEqual([]);
    expect(state.notes[0]).toEqual({ [name]: ['white,blue,black'] });
  });

  it('a bot that drafts it has its colours chosen, and the draft finishes', () => {
    const start = table();
    start.queues[1]![0]![0] = card('three', name, 'Instant');
    let state = start;
    // Seat 1 takes it: its right is seat 0, a person.
    state = take(state, 1, 'three');
    expect(state.asks.map((a) => a.seatId)).toEqual([0]);
    state = finish(state);
    expect(state.status).toBe('complete');
    expect(state.notes[1]).toEqual({ [name]: ['white,blue,black'] });
    expect(state.pools.map((p) => p.length)).toEqual([15, 15, 15, 15]);
  });

  it('taken as the round\'s last card, the round waits for the three colours', () => {
    let state = table();
    for (let n = 0; n < 4; n++) {
      state = runBots(state).state;
      state = take(state, 0, packOf(state, 0)[0]!.cardId);
    }
    state = runBots(state).state;
    state.queues[0]![0] = [card('three', name, 'Instant')];
    state = take(state, 0, 'three');
    expect(state.packNumber).toBe(1);
    state = reply(reply(reply(state, 3, 'green'), 0, 'red'), 1, 'black');
    expect(state.packNumber).toBe(2);
    expect(state.notes[0]).toEqual({ [name]: ['green,red,black'] });
    expect(finish(state).status).toBe('complete');
  });
});

describe('Deal Broker', () => {
  const broker = (id = 'broker') => card(id, BROKER);

  /** Every pick made (seat 0 takes the first card each time) with no ask answered for seat 0. */
  function toTheEnd(start: DraftState): DraftState {
    let state = start;
    for (let guard = 0; guard < 200 && !state.finishing && state.status !== 'complete'; guard++) {
      state = runBots(state).state;
      const mine = packOf(state, 0)[0];
      if (mine !== undefined && asksOf(state, 0).length === 0) state = take(state, 0, mine.cardId);
    }
    return state;
  }

  /** Seat 0 drafted the Broker first and the last pick is made. */
  const afterTheDraft = () => toTheEnd(take(table([broker()]), 0, 'broker'));
  const mine = (state: DraftState, seat: number, n = 1) => state.pools[seat]![n]!;

  it('is drafted face up and asks nothing while the draft runs', () => {
    const state = take(table([broker()]), 0, 'broker');
    expect(spectatorView(state).seats[0]?.faceUp?.map((c) => c.name)).toEqual([BROKER]);
    expect(state.asks).toEqual([]);
    const later = take(runBots(state).state, 0, packOf(runBots(state).state, 0)[0]!.cardId);
    expect(later.asks).toEqual([]);
  });

  it('after the last pick its holder may reveal a card of its pool, and the draft is not complete until it answers', () => {
    const state = afterTheDraft();
    expect(state.status).toBe('drafting');
    expect(state.pools.map((p) => p.length)).toEqual([15, 15, 15, 15]);
    expect(state.asks.map((a) => a.seatId)).toEqual([0]);
    const [open] = ownAsks(state, 0);
    expect(open?.source).toBe(BROKER);
    expect(open?.options?.map((o) => o.key)).toEqual(['no']);
    expect(open?.cards?.map((c) => c.cardId)).toEqual(state.pools[0]!.map((c) => c.cardId));
    expect(waitingOn(state)).toEqual([0]);
    expect(semanticIssues(viewFor(state, 0))).toEqual([]);
    expect(ownAsks(state, 1)).toEqual([]);
  });

  it('tells every screen the draft is not over while a question is open, though every pool is full', () => {
    const state = afterTheDraft();
    for (const view of [viewFor(state, 0), viewFor(state, 1), watcherView(state, 2), spectatorView(state)]) expect(DraftViewSchema.parse(view).complete).toBe(false);
    const done = reply(state, 0, 'no');
    for (const view of [viewFor(done, 0), viewFor(done, 1), spectatorView(done)]) expect(view.complete).toBe(true);
    // A draft with no card that changes it carries no word: a full pool is its end.
    expect('complete' in viewFor(table(), 0)).toBe(false);
    expect('complete' in viewFor(finish(table()), 0)).toBe(false);
    // The card counts from the deal on, wherever it is: in a pack, or in a round not yet opened.
    expect(viewFor(table([broker()]), 3).complete).toBe(false);
    const later = table();
    later.rounds[2]![3]![4] = broker();
    expect(spectatorView(later).complete).toBe(false);
  });

  it('declined: nothing is revealed and the draft is complete', () => {
    const state = reply(afterTheDraft(), 0, 'no');
    expect(state.status).toBe('complete');
    expect(logOf(spectatorView(state))).toEqual(['0 drafted face up broker']);
  });

  it('the revealed card is public, and each other seat is asked to offer a card of its own pool', () => {
    const before = afterTheDraft();
    const revealed = mine(before, 0);
    const state = reply(before, 0, revealed.cardId);
    for (const view of [viewFor(state, 2), spectatorView(state)]) {
      expect(logOf(view).at(-1)).toBe(`0 revealed ${revealed.cardId} for ${BROKER}`);
      expect(semanticIssues(view)).toEqual([]);
    }
    expect(state.asks.map((a) => a.seatId)).toEqual([1, 2, 3]);
    for (const seat of [1, 2, 3]) {
      const [open] = ownAsks(state, seat);
      expect(open?.title).toBe(`Offer alice a card for ${revealed.name}?`);
      expect(open?.cards?.map((c) => c.cardId)).toEqual(state.pools[seat]!.map((c) => c.cardId));
      expect(open?.options?.map((o) => o.key)).toEqual(['no']);
    }
    expect(ownAsks(state, 0)).toEqual([]);
    expect(state.status).toBe('drafting');
  });

  it('an offer is shown to the holder alone, and the holder is asked once every seat has answered', () => {
    const before = afterTheDraft();
    let state = reply(before, 0, mine(before, 0).cardId);
    const offer1 = mine(state, 1, 3);
    const offer3 = mine(state, 3, 5);
    state = reply(state, 1, offer1.cardId);
    expect(ownAsks(state, 0)).toEqual([]);
    state = reply(state, 2, 'no');
    state = reply(state, 3, offer3.cardId);

    expect(ownSeen(state, 0).map((e) => [e.source, e.cards.map((c) => c.cardId), e.detail])).toEqual([
      [BROKER, [offer1.cardId], 'offered by Bot 1'],
      [BROKER, [offer3.cardId], 'offered by Bot 3'],
    ]);
    const [open] = ownAsks(state, 0);
    expect(open?.cards?.map((c) => c.cardId)).toEqual([offer1.cardId, offer3.cardId]);
    expect(open?.options?.map((o) => o.key)).toEqual(['no']);
    expect(state.asks).toHaveLength(1);
    expect(semanticIssues(viewFor(state, 0))).toEqual([]);
    // Nobody but the holder is sent an offered card: not the other seats, not a watcher of the holder, not the table.
    for (const view of [viewFor(state, 2), viewFor(state, 3), watcherView(state, 0), spectatorView(state)]) {
      expect(JSON.stringify(view)).not.toContain(`"${offer1.cardId}"`);
      expect(semanticIssues(view)).toEqual([]);
    }
    expect(JSON.stringify(viewFor(state, 1))).not.toContain(`"${offer3.cardId}"`);
    expect(logOf(spectatorView(state))).toHaveLength(2);
  });

  it('accepted: the two cards change pools, the table is told, and the draft is complete', () => {
    const before = afterTheDraft();
    const revealed = mine(before, 0);
    let state = reply(before, 0, revealed.cardId);
    const offer1 = mine(state, 1, 3);
    const offer3 = mine(state, 3, 5);
    state = reply(reply(reply(state, 1, offer1.cardId), 2, 'no'), 3, offer3.cardId);
    state = reply(state, 0, offer3.cardId);

    expect(state.status).toBe('complete');
    const ids = (seat: number) => state.pools[seat]!.map((c) => c.cardId);
    expect(ids(0)).toContain(offer3.cardId);
    expect(ids(0)).not.toContain(revealed.cardId);
    expect(ids(3)).toContain(revealed.cardId);
    expect(ids(3)).not.toContain(offer3.cardId);
    expect(ids(1)).toContain(offer1.cardId);
    expect(state.pools.map((p) => p.length)).toEqual([15, 15, 15, 15]);
    expect(new Set(state.pools.flat().map((c) => c.cardId)).size).toBe(60);
    expect(state.effects[0]).toEqual([]);
    for (const view of [viewFor(state, 2), spectatorView(state)]) {
      expect(logOf(view).at(-1)).toBe(`0 exchanged ${revealed.cardId} ${offer3.cardId} with Bot 3`);
      // The offer that was not accepted stays private.
      expect(JSON.stringify(view)).not.toContain(`"${offer1.cardId}"`);
      expect(semanticIssues(view)).toEqual([]);
    }
  });

  it('no offer accepted: nothing changes hands and nothing is said of the offers', () => {
    const before = afterTheDraft();
    let state = reply(before, 0, mine(before, 0).cardId);
    const offer = mine(state, 2, 2);
    state = reply(reply(reply(state, 1, 'no'), 2, offer.cardId), 3, 'no');
    const pools = state.pools.map((p) => p.map((c) => c.cardId));
    state = reply(state, 0, 'no');
    expect(state.status).toBe('complete');
    expect(state.pools.map((p) => p.map((c) => c.cardId))).toEqual(pools);
    expect(logOf(spectatorView(state))).toHaveLength(2);
    expect(JSON.stringify(spectatorView(state))).not.toContain(`"${offer.cardId}"`);
  });

  it('with no offer at all the holder is asked nothing more', () => {
    const before = afterTheDraft();
    const state = reply(reply(reply(reply(before, 0, mine(before, 0).cardId), 1, 'no'), 2, 'no'), 3, 'no');
    expect(state.status).toBe('complete');
    expect(state.effects[0]).toEqual([]);
  });

  it('what each seat noted under the exchanged cards\' names goes with them', () => {
    const before = afterTheDraft();
    const revealed = mine(before, 0);
    const offer = mine(before, 2, 4);
    before.notes[0] = { [revealed.name]: ['white,blue,black'], Elsewhere: ['kept'] };
    before.notes[2] = { [offer.name]: ['3'] };
    let state = reply(before, 0, revealed.cardId);
    state = reply(reply(reply(state, 1, 'no'), 2, offer.cardId), 3, 'no');
    state = reply(state, 0, offer.cardId);
    expect(state.notes[0]).toEqual({ Elsewhere: ['kept'], [offer.name]: ['3'] });
    expect(state.notes[2]).toEqual({ [revealed.name]: ['white,blue,black'] });
  });

  it('a seat still holding a card of the name keeps its notes as well', () => {
    const before = afterTheDraft();
    const revealed = mine(before, 0);
    before.pools[0]![2] = { ...before.pools[0]![2]!, name: revealed.name };
    before.notes[0] = { [revealed.name]: ['1', '2'] };
    const offer = mine(before, 1);
    let state = reply(before, 0, revealed.cardId);
    state = reply(reply(reply(state, 1, offer.cardId), 2, 'no'), 3, 'no');
    state = reply(state, 0, offer.cardId);
    expect(state.notes[0]).toEqual({ [revealed.name]: ['1', '2'] });
    expect(state.notes[1]).toEqual({ [revealed.name]: ['1', '2'] });
  });

  it('refuses a card of somebody else\'s pool, an answer to another seat\'s ask, and a pick', () => {
    const before = afterTheDraft();
    const open = asksOf(before, 0)[0]!;
    expect(answer(before, 0, open.id, mine(before, 1).cardId)).toMatchObject({ ok: false, reason: 'bad-answer' });
    expect(answer(before, 1, open.id, 'no')).toMatchObject({ ok: false, reason: 'unknown-ask' });
    expect(pick(before, 0, mine(before, 0).cardId)).toMatchObject({ ok: false, reason: 'ask-open' });

    const state = reply(before, 0, mine(before, 0).cardId);
    const theirs = asksOf(state, 1)[0]!;
    expect(answer(state, 1, theirs.id, mine(state, 2).cardId)).toMatchObject({ ok: false, reason: 'bad-answer' });
    expect(answer(state, 2, theirs.id, 'no')).toMatchObject({ ok: false, reason: 'unknown-ask' });

    const offer = mine(state, 1);
    const offered = reply(reply(reply(state, 1, offer.cardId), 2, 'no'), 3, 'no');
    const accept = asksOf(offered, 0)[0]!;
    // Only a card that was offered can be accepted.
    expect(answer(offered, 0, accept.id, mine(offered, 2).cardId)).toMatchObject({ ok: false, reason: 'bad-answer' });
    expect(answer(offered, 0, accept.id, mine(offered, 0).cardId)).toMatchObject({ ok: false, reason: 'bad-answer' });
  });

  it('bots decline to offer, and a holder whose time runs out reveals nothing', () => {
    const before = afterTheDraft();
    const timed = timeoutPick(before, 0);
    expect(timed?.ok === true && timed.state.status).toBe('complete');

    // The holder reveals, the bots answer: no offers, so the draft completes.
    const state = runBots(reply(before, 0, mine(before, 0).cardId)).state;
    expect(state.status).toBe('complete');
    expect(state.pools.map((p) => p.length)).toEqual([15, 15, 15, 15]);
  });

  it('a seat whose time runs out on the offers accepts none', () => {
    const before = afterTheDraft();
    let state = reply(before, 0, mine(before, 0).cardId);
    state = reply(reply(reply(state, 1, mine(state, 1).cardId), 2, 'no'), 3, 'no');
    const timed = timeoutPick(state, 0);
    if (timed?.ok !== true) throw new Error('the timer should answer');
    expect(timed.state.status).toBe('complete');
    expect(timed.state.pools.map((p) => p.map((c) => c.cardId))).toEqual(state.pools.map((p) => p.map((c) => c.cardId)));
  });

  it('a bot holding one reveals nothing, and the whole draft finishes', () => {
    const start = table();
    start.queues[1]![0]![0] = broker();
    const state = finish(take(start, 1, 'broker'));
    expect(state.status).toBe('complete');
    expect(state.faceUp[1]).toEqual(['broker']);
    expect(logOf(spectatorView(state))).toEqual(['1 drafted face up broker']);
    expect(state.pools.map((p) => p.length)).toEqual([15, 15, 15, 15]);
  });

  it('several run one at a time in seat order, a seat holding two running twice', () => {
    const start = table([broker('broker-a')]);
    start.queues[2]![0]![0] = broker('broker-c');
    start.rounds[1]![0]![0] = broker('broker-b');
    let state = take(take(start, 0, 'broker-a'), 2, 'broker-c');
    // Seat 0 takes its second Broker as round two opens.
    for (let guard = 0; guard < 200 && state.packNumber < 2; guard++) {
      state = runBots(state).state;
      const next = packOf(state, 0)[0];
      if (next !== undefined) state = take(state, 0, next.cardId);
    }
    state = toTheEnd(take(state, 0, 'broker-b'));
    expect(state.faceUp[0]).toEqual(['broker-a', 'broker-b']);

    expect(state.asks.map((a) => a.seatId)).toEqual([0]);
    state = reply(state, 0, 'no');
    // Its second, and only then seat 2's.
    expect(state.asks.map((a) => a.seatId)).toEqual([0]);
    state = reply(state, 0, mine(state, 0).cardId);
    expect(state.asks.map((a) => a.seatId)).toEqual([1, 2, 3]);
    state = reply(reply(reply(state, 1, 'no'), 2, 'no'), 3, 'no');
    expect(state.asks.map((a) => a.seatId)).toEqual([2]);
    expect(state.status).toBe('drafting');
    state = reply(state, 2, 'no');
    expect(state.status).toBe('complete');
  });

  it('one that is no longer face up when the draft ends asks nothing', () => {
    const drafted = take(table([broker()]), 0, 'broker');
    drafted.faceUp[0] = [];
    const state = toTheEnd(drafted);
    expect(state.asks).toEqual([]);
    expect(state.status).toBe('complete');
  });
});
