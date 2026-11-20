/*
 * Cards that change the draft itself (`actions/`), against the engine: what
 * the registry holds, what a card makes public and what stays hidden, and the
 * two cards the foundation carries, Cogwork Librarian and Lore Seeker. Each
 * other family's tests sit beside its own file.
 */

import { describe, expect, it } from 'vitest';
import { DraftViewSchema, semanticIssues, type DraftCard } from '@hadoku/shared';
import { actionsOf, draftActionCards } from './index.ts';
import { answer, asksOf, createDraft, packOf, pick, receiverOf, usesOf, waitingOn, type DraftState, type PickOptions } from '../engine.ts';
import { runBots } from '../bot.ts';
import { timeoutPick } from '../pick-timer.ts';
import { spectatorView, viewFor, watcherView } from '../view.ts';

const SEATS = 4;
const PACK = 5;

export function card(cardId: string, name = `Card ${cardId}`, typeLine = 'Artifact Creature — Construct'): DraftCard {
  return { cardId, name, manaCost: ['4'], manaValue: 4, colors: [], typeLine, oracleText: '', setCode: 'TST', collectorNumber: '1', rarity: 'uncommon' };
}

/**
 * Four seats, three rounds of five, seat 0 the one human. `first` replaces the
 * first cards of seat 0's first pack; `spares` are packs left unopened.
 */
export function table(first: DraftCard[] = [], spares: DraftCard[][] = []): DraftState {
  const packs = Array.from({ length: 3 }, (_, r) =>
    Array.from({ length: SEATS }, (_, s) => Array.from({ length: PACK }, (_, i) => card(`r${r}s${s}c${i}`))),
  );
  first.forEach((c, i) => (packs[0]![0]![i] = c));
  return createDraft({
    draftId: 'draft:actions',
    seed: 'actions',
    packs,
    seatCount: SEATS,
    packCount: 3,
    packSize: PACK,
    humans: [{ participantId: 'fk:alice', displayName: 'alice' }],
    spares: { 'cube:test': spares },
    roundSources: ['cube:test', 'cube:test', 'cube:test'],
  });
}

export function take(state: DraftState, seat: number, cardId: string, options?: PickOptions): DraftState {
  const result = pick(state, seat, cardId, options);
  if (!result.ok) throw new Error(`pick refused: ${result.reason}`);
  return result.state;
}

export function reply(state: DraftState, seat: number, choice: string): DraftState {
  const open = asksOf(state, seat)[0];
  if (open === undefined) throw new Error(`seat ${seat} has no open ask`);
  const result = answer(state, seat, open.id, choice);
  if (!result.ok) throw new Error(`answer refused: ${result.reason}`);
  return result.state;
}

/** Bots and seat 0 (first card each time) until the draft is complete. */
export function finish(state: DraftState): DraftState {
  let current = state;
  for (let guard = 0; guard < 500 && current.status !== 'complete'; guard++) {
    current = runBots(current).state;
    if (current.status === 'complete') break;
    const timed = timeoutPick(current, 0);
    if (timed?.ok === true) current = timed.state;
  }
  return current;
}

const librarian = () => card('librarian', 'Cogwork Librarian');
const seeker = () => card('seeker', 'Lore Seeker');
const sparePack = (n: number) => Array.from({ length: PACK }, (_, i) => card(`spare${n}c${i}`));

/** Seat 0 has drafted the Librarian and the bots have passed it a second pack. */
const withLibrarian = () => runBots(take(table([librarian()]), 0, 'librarian')).state;

describe('the table of draft actions', () => {
  it('names the cards built so far and nothing ordinary', () => {
    expect(draftActionCards()).toEqual(expect.arrayContaining(['Cogwork Librarian', 'Lore Seeker']));
    expect(actionsOf('Lightning Bolt')).toEqual({});
  });
});

describe('a card drafted face up', () => {
  it('is public on every payload, and no other card of that seat is', () => {
    const state = take(withLibrarian(), 0, packOf(withLibrarian(), 0)[0]!.cardId);
    for (const view of [viewFor(state, 0), viewFor(state, 1), watcherView(state, 2), spectatorView(state)]) {
      expect(DraftViewSchema.parse(view).seats[0]?.faceUp?.map((c) => c.name)).toEqual(['Cogwork Librarian']);
      expect(view.seats.slice(1).every((s) => s.faceUp === undefined)).toBe(true);
      expect(view.log?.map((l) => `${l.seatId} ${l.verb} ${l.cards?.[0]?.name}`)).toEqual(['0 drafted face up Cogwork Librarian']);
      expect(semanticIssues(view)).toEqual([]);
    }
    const other = JSON.stringify(viewFor(state, 1));
    for (const c of state.pools[0] as DraftCard[]) {
      if (c.cardId !== 'librarian') expect(other).not.toContain(`"${c.cardId}"`);
    }
  });

  it('an ordinary pick leaves nothing face up and says nothing', () => {
    const state = take(table(), 0, 'r0s0c1');
    expect(state.faceUp).toEqual([[], [], [], []]);
    expect(viewFor(state, 1).seats[0]?.faceUp).toBeUndefined();
    expect(viewFor(state, 1).log).toBeUndefined();
  });
});

describe('Cogwork Librarian', () => {
  it('is offered to its drafter alone, with a pick, while the pack holds two cards', () => {
    const state = withLibrarian();
    expect(usesOf(state, 0)).toEqual([{ with: 'librarian', name: 'Cogwork Librarian', when: 'pick', extra: true }]);
    const own = viewFor(state, 0).viewer;
    expect(own.kind === 'seat' && own.uses).toEqual(usesOf(state, 0));
    expect('uses' in watcherView(state, 0).viewer).toBe(false);
    expect(usesOf(state, 1)).toEqual([]);
    expect(usesOf(table([librarian()]), 0)).toEqual([]);
  });

  it('takes two cards and goes into the pack in their place', () => {
    const before = withLibrarian();
    const pack = packOf(before, 0);
    const [a, b] = [pack[0]!.cardId, pack[1]!.cardId];
    const to = receiverOf(before, 0);
    const queued = before.queues[to]!.length;
    const result = pick(before, 0, a, { use: ['librarian'], extra: b });
    if (!result.ok) throw new Error(result.reason);
    const after = result.state;

    expect(after.pools[0]!.map((c) => c.cardId)).toEqual([a, b]);
    expect(after.faceUp[0]).toEqual([]);
    expect(after.roundPicks[0]).toBe(before.roundPicks[0]! + 1);
    const passed = after.queues[to]![queued]!;
    expect(passed).toHaveLength(pack.length - 1);
    expect(passed.map((c) => c.cardId)).toContain('librarian');
    expect(passed.map((c) => c.cardId)).not.toContain(a);
    expect(passed.map((c) => c.cardId)).not.toContain(b);
    expect(result.events.map((e) => e.type)).toEqual(['used', 'picked', 'picked', 'pack-passed']);
    expect(usesOf(after, 0)).toEqual([]);
    expect(viewFor(after, 1).seats[0]?.faceUp).toBeUndefined();
    // A refused act leaves the state it was given untouched.
    expect(before.pools[0]!.map((c) => c.cardId)).toEqual(['librarian']);
  });

  it('is face up again in front of whoever drafts it next', () => {
    const before = withLibrarian();
    const pack = packOf(before, 0);
    const to = receiverOf(before, 0);
    let state = take(before, 0, pack[0]!.cardId, { use: ['librarian'], extra: pack[1]!.cardId });
    while (!packOf(state, to).some((c) => c.cardId === 'librarian')) state = take(state, to, packOf(state, to)[0]!.cardId);
    state = take(state, to, 'librarian');
    expect(state.faceUp[to]).toEqual(['librarian']);
    expect(spectatorView(state).seats[to]?.faceUp?.map((c) => c.cardId)).toEqual(['librarian']);
  });

  it('refuses a second card without it, with the same card twice, with a card not in the pack, and from another seat', () => {
    const state = withLibrarian();
    const pack = packOf(state, 0);
    const [a, b] = [pack[0]!.cardId, pack[1]!.cardId];
    const refused = (seat: number, cardId: string, options: PickOptions) => {
      const result = pick(state, seat, cardId, options);
      return result.ok ? 'ok' : result.reason;
    };
    expect(refused(0, a, { extra: b })).toBe('use-refused');
    expect(refused(0, a, { use: ['nothing'], extra: b })).toBe('use-refused');
    expect(refused(0, a, { use: ['librarian'] })).toBe('use-refused');
    expect(refused(0, a, { use: ['librarian'], extra: a })).toBe('use-refused');
    expect(refused(0, a, { use: ['librarian'], extra: 'elsewhere' })).toBe('use-refused');
    const theirs = packOf(state, 1);
    if (theirs.length >= 2) expect(refused(1, theirs[0]!.cardId, { use: ['librarian'], extra: theirs[1]!.cardId })).toBe('use-refused');
    expect(packOf(state, 0)).toBe(pack);
  });

  it('keeps every seat at one card a pick: the draft ends with full pools', () => {
    let state = withLibrarian();
    const pack = packOf(state, 0);
    state = finish(take(state, 0, pack[0]!.cardId, { use: ['librarian'], extra: pack[1]!.cardId }));
    expect(state.status).toBe('complete');
    expect(state.pools.map((p) => p.length)).toEqual([15, 15, 15, 15]);
    expect(new Set(state.pools.flat().map((c) => c.cardId)).size).toBe(60);
  });
});

describe('Lore Seeker', () => {
  it('is revealed to the table as it is drafted, and is hidden like any card after', () => {
    const state = take(table([seeker()], [sparePack(0)]), 0, 'seeker');
    for (const view of [viewFor(state, 1), spectatorView(state)]) {
      expect(view.log?.map((l) => `${l.seatId} ${l.verb} ${l.cards?.[0]?.name}`)).toEqual(['0 revealed Lore Seeker']);
      expect(view.seats[0]?.faceUp).toBeUndefined();
      expect(semanticIssues(view)).toEqual([]);
    }
  });

  it('asks its drafter, who picks nothing until the answer', () => {
    const state = take(table([seeker()], [sparePack(0)]), 0, 'seeker');
    const own = viewFor(state, 0).viewer;
    if (own.kind !== 'seat') throw new Error('expected a seat');
    expect(own.asks?.map((a) => [a.source, a.options?.map((o) => o.key)])).toEqual([['Lore Seeker', ['yes', 'no']]]);
    expect(viewFor(state, 1).viewer.kind === 'seat' && 'asks' in viewFor(state, 1).viewer).toBe(false);
    expect(waitingOn(state)).toContain(0);
    const fed = runBots(state).state;
    const mine = packOf(fed, 0)[0];
    if (mine !== undefined) expect(pick(fed, 0, mine.cardId)).toMatchObject({ ok: false, reason: 'ask-open' });
    const open = asksOf(state, 0)[0]!;
    expect(answer(state, 1, open.id, 'yes')).toMatchObject({ ok: false, reason: 'unknown-ask' });
    expect(answer(state, 0, open.id, 'maybe')).toMatchObject({ ok: false, reason: 'bad-answer' });
  });

  it('yes: an unopened pack is its drafter\'s next pick, passes on, and is drafted this round', () => {
    const asked = runBots(take(table([seeker()], [sparePack(0)]), 0, 'seeker')).state;
    const waiting = asked.queues[0]!.length;
    const state = reply(asked, 0, 'yes');
    expect(packOf(state, 0).map((c) => c.cardId)).toEqual(sparePack(0).map((c) => c.cardId));
    expect(state.queues[0]).toHaveLength(waiting + 1);
    expect(state.spares['cube:test']).toEqual([]);
    expect(spectatorView(state).log?.at(-1)).toMatchObject({ seatId: 0, verb: 'added a booster pack to the draft' });

    const done = finish(take(state, 0, 'spare0c0'));
    expect(done.status).toBe('complete');
    // Sixty cards dealt and five added: every one is in a pool.
    expect(done.pools.flat()).toHaveLength(65);
    expect(new Set(done.pools.flat().map((c) => c.cardId)).size).toBe(65);
    // The round it was added in ran five picks longer between the four seats.
    expect(done.pools.map((p) => p.length).sort()).not.toEqual([15, 15, 15, 15]);
  });

  it('no: nothing is added', () => {
    const state = reply(take(table([seeker()], [sparePack(0)]), 0, 'seeker'), 0, 'no');
    expect(asksOf(state, 0)).toEqual([]);
    expect(state.spares['cube:test']).toHaveLength(1);
    expect(finish(state).pools.flat()).toHaveLength(60);
  });

  it('with no pack left unopened there is nothing to ask', () => {
    const state = take(table([seeker()]), 0, 'seeker');
    expect(asksOf(state, 0)).toEqual([]);
    expect(spectatorView(state).log?.map((l) => l.verb)).toEqual(['revealed']);
  });

  it('a bot that drafts it, and a seat whose time runs out, answer no', () => {
    const packs = table([], [sparePack(0)]);
    packs.queues[1]![0]![0] = seeker();
    const bots = runBots(packs).state;
    expect(bots.asks).toEqual([]);
    const asked = take(table([seeker()], [sparePack(0)]), 0, 'seeker');
    const timed = timeoutPick(asked, 0);
    expect(timed?.ok === true && asksOf(timed.state, 0)).toEqual([]);
    expect(timed?.ok === true && timed.state.spares['cube:test']).toHaveLength(1);
  });

  it('taken as the round\'s last card, the round waits for the answer and goes on with the added pack', () => {
    // Every seat down to its last card, and seat 0's last is the Seeker.
    let state = table([], [sparePack(0)]);
    for (let n = 0; n < PACK - 1; n++) {
      state = runBots(state).state;
      state = take(state, 0, packOf(state, 0)[0]!.cardId);
    }
    state = runBots(state).state;
    const last = packOf(state, 0);
    expect(last).toHaveLength(1);
    state.queues[0]![0] = [{ ...seeker() }];
    state = take(state, 0, 'seeker');
    expect(state.packNumber).toBe(1);
    state = reply(state, 0, 'yes');
    expect(state.packNumber).toBe(1);
    expect(packOf(state, 0)).toHaveLength(PACK);
    expect(finish(state).status).toBe('complete');
  });
});
