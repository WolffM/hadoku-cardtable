/*
 * The cards that only reveal themselves and note something (`noters.ts`),
 * against the engine: what each notes, what the table is told, what stays
 * hidden, and a whole draft finishing with each in it.
 */

import { describe, expect, it } from 'vitest';
import { semanticIssues, type DraftCard } from '@hadoku/shared';
import { createDraft, packOf, receiverOf, withDraftDefaults, type DraftState } from '../engine.ts';
import { runBots } from '../bot.ts';
import { timeoutPick } from '../pick-timer.ts';
import { spectatorView, viewFor, watcherView } from '../view.ts';
import { card, finish, table, take } from './actions.test.ts';

const COUNTERS = ['Custodi Peacekeeper', 'Garbage Fire', 'Lurking Automaton', 'Pyretic Hunter'] as const;
const named = (name: string, n = 0) => card(`${name.toLowerCase().replaceAll(' ', '-')}-${n}`, name);
const lines = (state: DraftState) => spectatorView(state).log?.map((l) => `${l.seatId} ${l.verb} ${l.cards?.map((c) => c.name).join('+') ?? ''}${l.detail === undefined ? '' : ` ${l.detail}`}`) ?? [];

/** Seat 0 picks the first card in front of it, after the bots have passed it what they can. */
function next(state: DraftState): DraftState {
  const fed = runBots(state).state;
  return take(fed, 0, packOf(fed, 0)[0]!.cardId);
}

/** Every payload a card could leak through: the other seats, a watcher of another seat and the spectator. */
function others(state: DraftState): string {
  return JSON.stringify([viewFor(state, 1), viewFor(state, 2), watcherView(state, 2), spectatorView(state)]);
}

describe.each(COUNTERS)('%s', (name) => {
  it('is revealed to the table and notes one for the first card of the round', () => {
    const state = take(table([named(name)]), 0, named(name).cardId);
    expect(state.notes[0]).toEqual({ [name]: ['1'] });
    expect(lines(state)).toEqual([`0 revealed ${name}`, `0 noted ${name} 1`]);
    for (const view of [viewFor(state, 0), viewFor(state, 1), watcherView(state, 2), spectatorView(state)]) expect(semanticIssues(view)).toEqual([]);
    expect(state.faceUp[0]).toEqual([]);
    expect(state.asks).toEqual([]);
  });

  it('notes how many cards its seat has drafted this round, itself included, and starts again each round', () => {
    // Seat 0 passes the card round the table of four: it comes back as its fifth pick.
    let state = table([card('a'), named(name)]);
    state = take(state, 0, 'a');
    for (let n = 0; n < 3; n++) state = next(state);
    state = runBots(state).state;
    const last = packOf(state, 0);
    const mine = last.find((c) => c.name === name);
    if (mine === undefined) {
      // A bot took it on the way round: it noted its own count, and seat 0 nothing.
      const holder = state.pools.findIndex((p) => p.some((c) => c.name === name));
      expect(state.notes[holder]![name]).toHaveLength(1);
      expect(state.notes[0]).toEqual({});
      return;
    }
    state = take(state, 0, mine.cardId);
    expect(state.notes[0]).toEqual({ [name]: ['5'] });
  });

  it('a second copy in a later round notes that round\'s count beside the first', () => {
    let state = take(table([named(name, 0)]), 0, named(name, 0).cardId);
    while (state.packNumber === 1) state = next(state);
    state = runBots(next(state)).state;
    packOf(state, 0)[0] = named(name, 1);
    state = take(state, 0, named(name, 1).cardId);
    expect(state.notes[0]).toEqual({ [name]: ['1', '2'] });
  });

  it('a pick that took two cards counts two', () => {
    // Seat 0 holds the Librarian, and takes the card and one more with it as its second pick.
    let state = take(table([card('librarian', 'Cogwork Librarian')]), 0, 'librarian');
    state = runBots(state).state;
    const pack = packOf(state, 0);
    pack[0] = named(name);
    state = take(state, 0, pack[1]!.cardId, { use: ['librarian'], extra: named(name).cardId });
    expect(state.roundPicks[0]).toBe(2);
    expect(state.roundCards[0]).toBe(3);
    expect(state.notes[0]).toEqual({ [name]: ['3'] });
  });

  it('the number is its seat\'s own: no other payload carries the notes', () => {
    const state = take(table([named(name)]), 0, named(name).cardId);
    expect(others(state)).not.toContain('"notes"');
  });

  it('a bot notes it too, a run-out timer notes it, and the draft finishes', () => {
    const bots = table();
    bots.queues[1]![0] = [named(name)];
    const after = runBots(bots).state;
    expect(after.notes[1]).toEqual({ [name]: ['1'] });
    expect(lines(after)).toContain(`1 revealed ${name}`);

    const timed = timeoutPick(table([named(name), named(name, 1), named(name, 2), named(name, 3), named(name, 4)]), 0);
    expect(timed?.ok === true && timed.state.notes[0]).toEqual({ [name]: ['1'] });
    const done = finish(table([named(name)]));
    expect(done.status).toBe('complete');
    expect(done.pools.flat()).toHaveLength(60);
    expect(done.notes.flatMap((n) => Object.keys(n))).toEqual([name]);
  });
});

describe('the count of cards drafted this round', () => {
  it('is one a pick for an ordinary pick, and a saved draft without it reads its picks', () => {
    const state = next(next(table()));
    expect(state.roundCards[0]).toBe(2);
    const { roundCards: _dropped, ...saved } = state;
    expect(withDraftDefaults(saved).roundCards).toEqual(state.roundPicks);
  });
});

describe('Cogwork Tracker', () => {
  const tracker = () => named('Cogwork Tracker');

  it('taken from a pack its drafter opened, is revealed and notes nobody', () => {
    const state = take(table([tracker()]), 0, tracker().cardId);
    expect(state.notes[0]).toEqual({});
    expect(lines(state)).toEqual(['0 revealed Cogwork Tracker']);
  });

  it('notes the seat that passed it, and says so to the table', () => {
    // Seat 0 passes it left to seat 1.
    let state = take(table([card('a'), tracker()]), 0, 'a');
    const to = receiverOf(state, 0);
    state = take(state, to, packOf(state, to)[0]!.cardId);
    expect(packOf(state, to).map((c) => c.name)).toContain('Cogwork Tracker');
    state = take(state, to, tracker().cardId);
    expect(state.notes[to]).toEqual({ 'Cogwork Tracker': ['0'] });
    expect(lines(state)).toEqual([`${to} revealed Cogwork Tracker`, `${to} noted Cogwork Tracker alice`]);
    for (const view of [viewFor(state, 0), viewFor(state, to), spectatorView(state)]) expect(semanticIssues(view)).toEqual([]);
  });

  it('in an even round notes the seat on the other side', () => {
    let state = table();
    while (state.packNumber === 1) state = next(state);
    state.queues[0]![0]![1] = tracker();
    state = take(state, 0, packOf(state, 0)[0]!.cardId);
    const to = receiverOf(state, 0);
    expect(to).toBe(3);
    while (!packOf(state, to).some((c) => c.name === 'Cogwork Tracker')) state = take(state, to, packOf(state, to)[0]!.cardId);
    state = take(state, to, tracker().cardId);
    expect(state.notes[to]).toEqual({ 'Cogwork Tracker': ['0'] });
  });

  it('a draft with it finishes, whoever takes it', () => {
    const done = finish(table([card('a'), tracker()]));
    expect(done.status).toBe('complete');
    expect(done.pools.flat()).toHaveLength(60);
  });
});

describe('Aether Searcher', () => {
  const searcher = (n = 0) => named('Aether Searcher', n);

  it('is revealed, and the next card its seat drafts is revealed to the table and noted by name', () => {
    let state = take(table([searcher()]), 0, searcher().cardId);
    expect(lines(state)).toEqual(['0 revealed Aether Searcher']);
    expect(state.notes[0]).toEqual({});
    state = runBots(state).state;
    const second = packOf(state, 0)[0]!;
    state = take(state, 0, second.cardId);
    expect(state.notes[0]).toEqual({ 'Aether Searcher': [second.name] });
    const told = spectatorView(state).log?.filter((l) => l.seatId === 0).at(-1);
    expect(told).toMatchObject({ verb: 'revealed and noted', cards: [{ cardId: second.cardId }] });
    for (const view of [viewFor(state, 1), spectatorView(state)]) expect(semanticIssues(view)).toEqual([]);
  });

  it('reveals that one card only: the card after it stays hidden', () => {
    let state = next(take(table([searcher()]), 0, searcher().cardId));
    state = runBots(state).state;
    const third = packOf(state, 0)[0]!;
    state = take(state, 0, third.cardId);
    expect(state.notes[0]!['Aether Searcher']).toHaveLength(1);
    expect(state.effects[0]).toEqual([]);
    expect(others(state)).not.toContain(`"${third.cardId}"`);
  });

  it('taken as a round\'s last card, waits for the first card of the next round', () => {
    let state = table();
    for (let n = 0; n < 4; n++) state = next(state);
    state = runBots(state).state;
    state.queues[0]![0] = [searcher()];
    state = take(state, 0, searcher().cardId);
    state = runBots(state).state;
    expect(state.packNumber).toBe(2);
    const first = packOf(state, 0)[0]!;
    state = take(state, 0, first.cardId);
    expect(state.notes[0]).toEqual({ 'Aether Searcher': [first.name] });
  });

  it('two taken one after the other: the second is the first\'s next card, and the card after is the second\'s', () => {
    let state = take(table([searcher(0)]), 0, searcher(0).cardId);
    state = runBots(state).state;
    packOf(state, 0)[0] = searcher(1);
    state = take(state, 0, searcher(1).cardId);
    expect(state.notes[0]).toEqual({ 'Aether Searcher': ['Aether Searcher'] });
    state = runBots(state).state;
    const third = packOf(state, 0)[0]!;
    state = take(state, 0, third.cardId);
    expect(state.notes[0]).toEqual({ 'Aether Searcher': ['Aether Searcher', third.name] });
  });

  it('taken first of two with the Librarian, the second card of that pick is its next card', () => {
    let state = take(table([card('librarian', 'Cogwork Librarian')]), 0, 'librarian');
    state = runBots(state).state;
    const pack = packOf(state, 0);
    pack[0] = searcher();
    const second: DraftCard = pack[1]!;
    state = take(state, 0, searcher().cardId, { use: ['librarian'], extra: second.cardId });
    expect(state.notes[0]).toEqual({ 'Aether Searcher': [second.name] });
    expect(state.effects[0]).toEqual([]);
  });

  it('a bot notes its next card, a run-out timer\'s pick is noted, and the draft finishes', () => {
    const bots = table();
    bots.queues[1]![0] = [searcher()];
    let state = runBots(bots).state;
    state = runBots(take(state, 0, packOf(state, 0)[0]!.cardId)).state;
    expect(state.notes[1]!['Aether Searcher']).toHaveLength(1);

    const timed = timeoutPick(runBots(take(table([searcher()]), 0, searcher().cardId)).state, 0);
    expect(timed?.ok === true && timed.state.notes[0]!['Aether Searcher']).toHaveLength(1);

    const done = finish(take(table([searcher()]), 0, searcher().cardId));
    expect(done.status).toBe('complete');
    expect(done.pools.flat()).toHaveLength(60);
    expect(done.effects.flat()).toEqual([]);
  });

  it('survives a save between the two picks', () => {
    const saved = JSON.parse(JSON.stringify(take(table([searcher()]), 0, searcher().cardId))) as DraftState;
    const state = next(createDraftFrom(saved));
    expect(state.notes[0]!['Aether Searcher']).toHaveLength(1);
  });
});

/** A draft read back from its saved JSON, as the room restores one. */
function createDraftFrom(saved: DraftState): DraftState {
  const fresh = createDraft({ draftId: saved.draftId, seed: saved.seed, packs: [], seatCount: saved.seatCount, packCount: saved.packCount, packSize: saved.packSize, humans: [{ participantId: 'fk:alice', displayName: 'alice' }] });
  return withDraftDefaults({ ...saved, table: fresh.table });
}
