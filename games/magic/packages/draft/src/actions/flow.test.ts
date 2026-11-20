/*
 * The cards that change where packs go and what a seat may see (`flow.ts`):
 * Canal Dredger and Archdemon of Paliano, against the engine.
 */

import { describe, expect, it } from 'vitest';
import { DraftViewSchema, semanticIssues, type DraftCard } from '@hadoku/shared';
import { answer, asksOf, decisionSize, isBlind, packOf, pick, usesOf, waitingOn, type DraftEvent, type DraftState } from '../engine.ts';
import { runBots } from '../bot.ts';
import { timeoutPick } from '../pick-timer.ts';
import { spectatorView, viewFor, watcherView } from '../view.ts';
import { card, finish, reply, table, take } from './actions.test.ts';

const DREDGER = 'Canal Dredger';
const ARCHDEMON = 'Archdemon of Paliano';

const dredger = (id = 'dredger') => card(id, DREDGER);
const archdemon = (id = 'demon') => card(id, ARCHDEMON, 'Creature — Demon');

/** Every seat in turn takes the first card in front of it, `times` over. */
function lockstep(state: DraftState, times: number): DraftState {
  let current = state;
  for (let n = 0; n < times; n++) {
    for (let s = 0; s < current.seatCount; s++) current = take(current, s, packOf(current, s)[0]!.cardId);
  }
  return current;
}

const ids = (cards: readonly DraftCard[] | undefined) => (cards ?? []).map((c) => c.cardId);
const lines = (state: DraftState) => state.log.map((l) => `${l.seatId} ${l.verb}${l.cards === undefined ? '' : ` ${l.cards[0]?.name}`}${l.detail === undefined ? '' : ` ${l.detail}`}`);
/** Every card the draft holds anywhere a card can be: in front of a seat, in a pool, or held by an open question. */
const everywhere = (state: DraftState) => [
  ...state.queues.flat(2),
  ...state.pools.flat(),
  ...state.asks.flatMap((a) => (a.data?.cards as DraftCard[] | undefined) ?? []),
  ...state.rounds.slice(state.packNumber).flat(2),
];

/** Seat 0 drafted a Dredger first, and every seat is down to a pack of two. */
function oneDredger(): DraftState {
  let state = take(table([dredger()]), 0, 'dredger');
  for (const s of [1, 2, 3]) state = take(state, s, packOf(state, s)[0]!.cardId);
  return lockstep(state, 2);
}

/** Seats 0 and 2 each drafted a Dredger first, and every seat is down to a pack of two. */
function twoDredgers(): DraftState {
  const start = table([dredger('dredger0')]);
  start.queues[2]![0]![0] = dredger('dredger2');
  let state = take(start, 0, 'dredger0');
  state = take(state, 2, 'dredger2');
  for (const s of [1, 3]) state = take(state, s, packOf(state, s)[0]!.cardId);
  return lockstep(state, 2);
}

describe('Canal Dredger', () => {
  it('is drafted face up, public to the whole table', () => {
    const state = take(table([dredger()]), 0, 'dredger');
    for (const view of [viewFor(state, 1), spectatorView(state)]) {
      expect(DraftViewSchema.parse(view).seats[0]?.faceUp?.map((c) => c.name)).toEqual([DREDGER]);
      expect(semanticIssues(view)).toEqual([]);
    }
    expect(lines(state)).toEqual([`0 drafted face up ${DREDGER}`]);
  });

  it('a pack passed with more than one card goes to the next seat as ever', () => {
    const state = take(table([dredger()]), 0, 'dredger');
    expect(state.queues[1]).toHaveLength(2);
    expect(state.queues[0]).toHaveLength(0);
  });

  it('the last card of another seat\'s pack goes to the seat that drafted it, not to the next seat', () => {
    const before = oneDredger();
    const pack = packOf(before, 1);
    expect(pack).toHaveLength(2);
    const result = pick(before, 1, pack[0]!.cardId);
    if (!result.ok) throw new Error(result.reason);
    const after = result.state;
    expect(ids(after.queues[0]!.at(-1))).toEqual([pack[1]!.cardId]);
    expect(after.packMeta[0]!.at(-1)).toEqual({ id: before.packMeta[1]![0]!.id, from: 1 });
    expect(after.queues[2]).toHaveLength(before.queues[2]!.length);
    expect(result.events.filter((e): e is Extract<DraftEvent, { type: 'pack-passed' }> => e.type === 'pack-passed').map((e) => [e.from, e.to])).toEqual([[1, 0]]);
    expect(asksOf(after, 1)).toEqual([]);
    expect(lines(after).at(-1)).toBe('1 passed the last card to alice');
    // The card's name is not told to the table.
    expect(JSON.stringify(spectatorView(after))).not.toContain(`"${pack[1]!.cardId}"`);
  });

  it('its own drafter passes the last card to itself, and takes it', () => {
    const before = oneDredger();
    const pack = packOf(before, 0);
    const after = take(before, 0, pack[0]!.cardId);
    expect(ids(after.queues[0]!.at(-1))).toEqual([pack[1]!.cardId]);
    expect(after.packMeta[0]!.at(-1)?.from).toBe(0);
    expect(after.queues[1]).toHaveLength(before.queues[1]!.length);
    const took = take(after, 0, pack[1]!.cardId);
    expect(ids(took.pools[0])).toContain(pack[1]!.cardId);
  });

  it('the round ends only when every last card is taken', () => {
    let state = oneDredger();
    for (let s = 0; s < 4; s++) state = take(state, s, packOf(state, s)[0]!.cardId);
    expect(state.packNumber).toBe(1);
    expect(state.queues.map((q) => q.length)).toEqual([4, 0, 0, 0]);
    for (let n = 0; n < 3; n++) state = take(state, 0, packOf(state, 0)[0]!.cardId);
    expect(state.packNumber).toBe(1);
    state = take(state, 0, packOf(state, 0)[0]!.cardId);
    expect(state.packNumber).toBe(2);
    expect(state.pools.map((p) => p.length)).toEqual([8, 4, 4, 4]);
  });

  it('holds for a seat that drafts it mid-round: only last cards passed after that', () => {
    let state = lockstep(table(), 3);
    state.queues[0]![0]![0] = dredger();
    state = take(state, 1, packOf(state, 1)[0]!.cardId);
    expect(state.queues[2]!.at(-1)).toHaveLength(1);
    state = take(state, 0, 'dredger');
    expect(state.queues[0]!.at(-1)).toHaveLength(1);
    state = take(state, 3, packOf(state, 3)[0]!.cardId);
    expect(state.queues[0]).toHaveLength(2);
  });

  it('goes on after the Dredger is turned face down or leaves the pool: its seat drafted it', () => {
    const before = oneDredger();
    before.faceUp[0] = [];
    before.pools[0] = before.pools[0]!.filter((c) => c.cardId !== 'dredger');
    const after = take(before, 1, packOf(before, 1)[0]!.cardId);
    expect(after.queues[0]!.at(-1)).toHaveLength(1);
  });

  describe('with several seats that drafted one', () => {
    it('a seat that drafted one keeps its own last card, unasked', () => {
      const before = twoDredgers();
      const pack = packOf(before, 2);
      const after = take(before, 2, pack[0]!.cardId);
      expect(after.asks).toEqual([]);
      expect(ids(after.queues[2]!.at(-1))).toEqual([pack[1]!.cardId]);
      expect(lines(after).at(-1)).toBe('2 kept the last card');
    });

    it('any other seat is asked which, and the card is in front of nobody until it answers', () => {
      const before = twoDredgers();
      const pack = packOf(before, 1);
      const last = pack[1]!.cardId;
      const asked = take(before, 1, pack[0]!.cardId);

      const own = viewFor(asked, 1).viewer;
      if (own.kind !== 'seat') throw new Error('expected a seat');
      expect(own.asks).toEqual([
        {
          id: asksOf(asked, 1)[0]!.id,
          source: DREDGER,
          title: 'Pass the last card to',
          options: [
            { key: '0', label: 'alice' },
            { key: '2', label: asked.displayNames[2] },
          ],
        },
      ]);
      expect(semanticIssues(viewFor(asked, 1))).toEqual([]);
      expect(ids(asked.queues.flat(2))).not.toContain(last);
      expect(ids(asked.pools.flat())).not.toContain(last);
      expect(ids(everywhere(asked))).toContain(last);
      expect(waitingOn(asked)).toContain(1);
      for (const view of [viewFor(asked, 0), viewFor(asked, 2), spectatorView(asked)]) {
        expect(JSON.stringify(view)).not.toContain(`"${last}"`);
        expect(view.viewer.kind === 'seat' && view.viewer.asks).toBeFalsy();
      }

      const open = asksOf(asked, 1)[0]!;
      expect(answer(asked, 0, open.id, '0')).toMatchObject({ ok: false, reason: 'unknown-ask' });
      expect(answer(asked, 1, open.id, '1')).toMatchObject({ ok: false, reason: 'bad-answer' });
      expect(answer(asked, 1, open.id, '3')).toMatchObject({ ok: false, reason: 'bad-answer' });

      const sent = reply(asked, 1, '0');
      expect(sent.asks).toEqual([]);
      expect(ids(sent.queues[0]!.at(-1))).toEqual([last]);
      expect(sent.packMeta[0]!.at(-1)).toEqual({ id: before.packMeta[1]![0]!.id, from: 1 });
      expect(lines(sent).at(-1)).toBe('1 passed the last card to alice');
    });

    it('the round does not end while the question is open', () => {
      let state = twoDredgers();
      for (const s of [0, 2, 3, 1]) state = take(state, s, packOf(state, s)[0]!.cardId);
      // Seat 3 was asked too: answer it, and take every last card but the one seat 1 holds.
      state = reply(state, 3, '0');
      for (let guard = 0; guard < 8 && state.queues.some((q) => q.length > 0); guard++) {
        for (const s of [0, 2]) if (packOf(state, s).length > 0) state = take(state, s, packOf(state, s)[0]!.cardId);
      }
      expect(state.queues.every((q) => q.length === 0)).toBe(true);
      expect(state.packNumber).toBe(1);
      state = reply(state, 1, '2');
      expect(state.packNumber).toBe(1);
      state = take(state, 2, packOf(state, 2)[0]!.cardId);
      expect(state.packNumber).toBe(2);
    });

    it('a bot, and a seat whose time runs out, pass it to the nearest such seat the way packs are passing', () => {
      const before = twoDredgers();
      // Left in round one: from seat 1 the next is seat 2; from seat 3 it is seat 0.
      const one = take(before, 1, packOf(before, 1)[0]!.cardId);
      expect(asksOf(one, 1)[0]?.fallback).toBe('2');
      const timed = timeoutPick(one, 1);
      expect(timed?.ok === true && timed.state.asks).toEqual([]);
      expect(timed?.ok === true && timed.state.queues[2]!.at(-1)).toHaveLength(1);
      const three = take(before, 3, packOf(before, 3)[0]!.cardId);
      expect(asksOf(three, 3)[0]?.fallback).toBe('0');

      const bots = runBots(before).state;
      expect(bots.asks).toEqual([]);

      // Right in round two: from seat 1 the next is seat 0.
      let second = finishRound(before);
      expect(second.packNumber).toBe(2);
      second = lockstep(second, 3);
      second = take(second, 1, packOf(second, 1)[0]!.cardId);
      expect(asksOf(second, 1)[0]?.fallback).toBe('0');
    });

    it('a whole draft finishes with every card in a pool', () => {
      const done = finish(twoDredgers());
      expect(done.status).toBe('complete');
      expect(done.asks).toEqual([]);
      expect(new Set(ids(done.pools.flat())).size).toBe(60);
      expect(done.pools[1]!.length + done.pools[3]!.length).toBe(24);
    });
  });

  it('a whole draft with one finishes: its seat holds every pack\'s last card', () => {
    const done = finish(take(table([dredger()]), 0, 'dredger'));
    expect(done.status).toBe('complete');
    expect(done.pools.map((p) => p.length)).toEqual([24, 12, 12, 12]);
    expect(new Set(ids(done.pools.flat())).size).toBe(60);
  });

  it('a bot that drafted it is passed the last cards too', () => {
    const start = table();
    start.queues[1]![0]![0] = dredger();
    const done = finish(take(start, 1, 'dredger'));
    expect(done.status).toBe('complete');
    expect(done.pools.map((p) => p.length)).toEqual([12, 24, 12, 12]);
  });

  it('a pack Lore Seeker added has a last card like any other', () => {
    const spare = Array.from({ length: 5 }, (_, i) => card(`spare${i}`));
    let state = runBots(take(table([dredger()], [spare]), 0, 'dredger')).state;
    state.queues[0]![0]![0] = card('seeker', 'Lore Seeker');
    state = reply(take(state, 0, 'seeker'), 0, 'yes');
    expect(ids(packOf(state, 0))).toEqual(ids(spare));
    const done = finish(state);
    expect(done.status).toBe('complete');
    expect(new Set(ids(done.pools.flat())).size).toBe(65);
    // Twelve packs dealt and one added: thirteen last cards, each kept or passed to seat 0.
    expect(lines(done).filter((l) => l.endsWith('kept the last card') || l.endsWith('passed the last card to alice'))).toHaveLength(13);
    expect(done.pools[0]).toHaveLength(15 - 3 + 13 + 1);
  });
});

/** Every seat takes first cards, and answers with the first option, until the next round opens. */
function finishRound(state: DraftState): DraftState {
  let current = state;
  const round = current.packNumber;
  for (let guard = 0; guard < 200 && current.packNumber === round && current.status !== 'complete'; guard++) {
    for (let s = 0; s < current.seatCount && current.packNumber === round; s++) {
      const open = asksOf(current, s)[0];
      if (open !== undefined) current = reply(current, s, open.options![0]!.key);
      else if (packOf(current, s).length > 0) current = take(current, s, packOf(current, s)[0]!.cardId);
    }
  }
  return current;
}

/** Seat 0 drafted the Archdemon by name, and the bots have passed it a pack. */
const withArchdemon = () => runBots(take(table([archdemon()]), 0, 'demon')).state;

/** One pick at random by seat 0, with the bots after it. */
const blindPick = (state: DraftState) => runBots(take(state, 0, 'blind')).state;

describe('Archdemon of Paliano', () => {
  it('is drafted by name, face up, and its seat may no longer look at the pack in front of it', () => {
    const start = table([archdemon()]);
    expect(isBlind(start, 0)).toBe(false);
    const state = withArchdemon();
    expect(ids(state.pools[0])).toEqual(['demon']);
    expect(state.faceUp[0]).toEqual(['demon']);
    expect(isBlind(state, 0)).toBe(true);
    expect(isBlind(state, 1)).toBe(false);

    const pack = packOf(state, 0);
    expect(pack.length).toBeGreaterThan(0);
    const own = DraftViewSchema.parse(viewFor(state, 0));
    expect(own.viewer).toMatchObject({ kind: 'seat', pack: [], packHidden: pack.length, pool: [{ cardId: 'demon' }] });
    expect(semanticIssues(own)).toEqual([]);
    expect(watcherView(state, 0).viewer).toMatchObject({ kind: 'watcher', pack: [] });
    for (const view of [viewFor(state, 0), watcherView(state, 0), viewFor(state, 1), spectatorView(state)]) {
      const sent = JSON.stringify(view);
      for (const c of pack) expect(sent).not.toContain(`"${c.cardId}"`);
      expect(view.seats[0]?.faceUp?.map((c) => c.name)).toEqual([ARCHDEMON]);
    }
    // The seat is still waited on, and its time is measured by the pack it cannot see.
    expect(waitingOn(state)).toContain(0);
    expect(decisionSize(state, 0)).toBe(pack.length);
  });

  it('with no pack in front of it the view carries no count', () => {
    const state = take(table([archdemon()]), 0, 'demon');
    expect(packOf(state, 0)).toEqual([]);
    const own = DraftViewSchema.parse(viewFor(state, 0)).viewer;
    expect('packHidden' in own).toBe(false);
  });

  it('takes a card at random whatever was named, and the seat may look at it', () => {
    const state = withArchdemon();
    const pack = packOf(state, 0);
    const taken = new Set(
      ['blind', pack[0]!.cardId, pack[1]!.cardId, 'elsewhere'].map((named) => {
        const result = pick(state, 0, named);
        if (!result.ok) throw new Error(result.reason);
        return result.state.pools[0]!.at(-1)!.cardId;
      }),
    );
    expect(taken.size).toBe(1);
    expect(ids(pack)).toContain([...taken][0]);
    const after = take(state, 0, 'blind');
    const own = viewFor(after, 0).viewer;
    expect(own.kind === 'seat' && ids(own.pool)).toEqual(['demon', [...taken][0]]);
    expect(after.queues[1]!.at(-1)).toHaveLength(pack.length - 1);
  });

  it('after three cards drafted this way it is turned face down, and the next pack is looked at', () => {
    let state = withArchdemon();
    for (let n = 0; n < 2; n++) {
      state = blindPick(state);
      expect(state.faceUp[0]).toEqual(['demon']);
      expect(isBlind(state, 0)).toBe(true);
    }
    state = blindPick(state);
    expect(state.pools[0]).toHaveLength(4);
    expect(state.faceUp[0]).toEqual([]);
    expect(state.effects[0]).toEqual([]);
    expect(isBlind(state, 0)).toBe(false);
    expect(lines(state)).toEqual([`0 drafted face up ${ARCHDEMON}`, `0 turned face down ${ARCHDEMON}`]);

    const pack = packOf(state, 0);
    expect(pack.length).toBeGreaterThan(0);
    const own = viewFor(state, 0).viewer;
    expect(own.kind === 'seat' && ids(own.pack)).toEqual(ids(pack));
    expect(own.kind === 'seat' && 'packHidden' in own).toBe(false);
    for (const view of [viewFor(state, 1), spectatorView(state)]) expect(view.seats[0]?.faceUp).toBeUndefined();
    // A card is named again.
    expect(ids(take(state, 0, pack.at(-1)!.cardId).pools[0]).at(-1)).toBe(pack.at(-1)!.cardId);
    expect(pick(state, 0, 'blind')).toMatchObject({ ok: false, reason: 'card-not-in-pack' });
  });

  it('a second one drafted at random is face up too, and each card drafted at random counts for both', () => {
    let state = blindPick(withArchdemon());
    // The pack in front of the seat is nothing but Archdemons: the next card at random is one.
    state.queues[0]![0] = packOf(state, 0).map((_, i) => archdemon(`demon${i + 2}`));
    state = blindPick(state);
    const second = state.pools[0]!.at(-1)!.cardId;
    expect(state.faceUp[0]).toEqual(['demon', second]);
    expect(state.effects[0]!.map((e) => e.n)).toEqual([1, 3]);

    state = blindPick(state);
    expect(state.faceUp[0]).toEqual([second]);
    expect(isBlind(state, 0)).toBe(true);
    state = blindPick(state);
    // The round turned over with one card still demanded: it carries into the next.
    expect(state.packNumber).toBe(2);
    expect(isBlind(state, 0)).toBe(true);
    state = blindPick(state);
    expect(state.faceUp[0]).toEqual([]);
    expect(isBlind(state, 0)).toBe(false);
    // The first by name, then one, the second, and three more: five at random.
    expect(state.pools[0]).toHaveLength(6);
    expect(lines(state).filter((l) => l.startsWith('0 turned face down'))).toHaveLength(2);
  });

  it('stops when something else turns it face down', () => {
    const state = withArchdemon();
    state.faceUp[0] = [];
    expect(isBlind(state, 0)).toBe(false);
    const after = take(state, 0, packOf(state, 0)[0]!.cardId);
    expect(after.effects[0]).toEqual([]);
  });

  it('offers no face-up card with a blind pick, and refuses one named, and a second card', () => {
    let state = runBots(take(table([card('librarian', 'Cogwork Librarian')]), 0, 'librarian')).state;
    state.queues[0]![0]![0] = archdemon();
    expect(usesOf(state, 0).map((u) => u.when)).toEqual(['pick']);
    state = runBots(take(state, 0, 'demon')).state;
    const pack = packOf(state, 0);
    expect(pack.length).toBeGreaterThanOrEqual(2);
    expect(usesOf(state, 0)).toEqual([]);
    expect(pick(state, 0, pack[0]!.cardId, { use: ['librarian'], extra: pack[1]!.cardId })).toMatchObject({ ok: false, reason: 'use-refused' });
    expect(pick(state, 0, pack[0]!.cardId, { use: ['librarian'] })).toMatchObject({ ok: false, reason: 'use-refused' });
    expect(pick(state, 0, pack[0]!.cardId, { extra: pack[1]!.cardId })).toMatchObject({ ok: false, reason: 'use-refused' });
    expect(state.faceUp[0]).toEqual(['librarian', 'demon']);
  });

  it('a seat whose time runs out drafts at random too, and it counts', () => {
    const state = withArchdemon();
    const timed = timeoutPick(state, 0);
    if (timed?.ok !== true) throw new Error('expected a pick');
    expect(ids(timed.state.pools[0]).at(-1)).toBe(ids(take(state, 0, 'blind').pools[0]).at(-1));
    expect(timed.state.effects[0]!.map((e) => e.n)).toEqual([2]);
  });

  it('a bot that drafts it drafts three at random and turns it face down; the draft finishes', () => {
    const start = table();
    start.queues[1]![0]![0] = archdemon();
    const done = finish(take(start, 1, 'demon'));
    expect(done.status).toBe('complete');
    expect(done.pools.map((p) => p.length)).toEqual([15, 15, 15, 15]);
    expect(new Set(ids(done.pools.flat())).size).toBe(60);
    expect(lines(done)).toEqual([`1 drafted face up ${ARCHDEMON}`, `1 turned face down ${ARCHDEMON}`]);
  });

  it('a whole draft finishes with a person holding it and a Dredger at the table', () => {
    const start = table([archdemon()]);
    start.queues[2]![0]![0] = dredger();
    const done = finish(take(take(start, 0, 'demon'), 2, 'dredger'));
    expect(done.status).toBe('complete');
    expect(done.faceUp[0]).toEqual([]);
    expect(new Set(ids(done.pools.flat())).size).toBe(60);
    expect(done.pools[2]).toHaveLength(24);
  });
});
