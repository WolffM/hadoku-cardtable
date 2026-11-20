/*
 * The cards that let one seat see something hidden (`peeks.ts`), against the
 * engine: what each shows, to whom, and that no other recipient's payload
 * carries it.
 */

import { describe, expect, it } from 'vitest';
import { semanticIssues, type DraftCard, type DraftView } from '@hadoku/shared';
import { draftActionCards } from './index.ts';
import { answer, asksOf, packOf, pick, useNow, usesOf, type DraftState } from '../engine.ts';
import { runBots } from '../bot.ts';
import { timeoutPick } from '../pick-timer.ts';
import { spectatorView, viewFor, watcherView } from '../view.ts';
import { card, finish, reply, table, take } from './actions.test.ts';

const SEATS = [0, 1, 2, 3];

/** Every payload that is not `seat`'s own: the other seats', a watcher of each seat (of `seat` too), and a spectator's. */
function othersThan(state: DraftState, seat: number): { who: string; view: DraftView }[] {
  return [
    ...SEATS.filter((s) => s !== seat).map((s) => ({ who: `seat ${s}`, view: viewFor(state, s) })),
    ...SEATS.map((s) => ({ who: `a watcher of seat ${s}`, view: watcherView(state, s) })),
    { who: 'a spectator', view: spectatorView(state) },
  ];
}

/**
 * Nobody but `seat` is sent anything a card showed, and the cards shown are in
 * no payload but those of `holders` (the seats that hold them in a pack or a
 * pool of their own, and whoever watches those seats).
 */
function expectShownOnlyTo(state: DraftState, seat: number, cardIds: string[], holders: number[] = []): void {
  for (const { who, view } of othersThan(state, seat)) {
    const text = JSON.stringify(view);
    expect('seen' in view.viewer, `${who} is sent nothing shown`).toBe(false);
    expect(text, who).not.toContain('"seen"');
    expect(semanticIssues(view), who).toEqual([]);
    if (holders.some((h) => who.endsWith(`seat ${h}`))) continue;
    for (const id of cardIds) expect(text, `${who} is not sent ${id}`).not.toContain(`"${id}"`);
  }
  expect(semanticIssues(viewFor(state, seat))).toEqual([]);
}

const seenBy = (state: DraftState, seat: number) => {
  const own = viewFor(state, seat).viewer;
  return own.kind === 'seat' ? (own.seen ?? []).map((e) => `${e.source}: ${e.cards.map((c) => c.cardId).join(',')} ${e.detail ?? ''}`) : [];
};

const logOf = (state: DraftState) => (spectatorView(state).log ?? []).map((l) => `${l.seatId} ${l.verb} ${(l.cards ?? []).map((c) => c.cardId).join(',')}${l.detail === undefined ? '' : ` ${l.detail}`}`);

/** Seat 1's first pack is five of one card, so the bot there drafts one whatever it likes. */
function botHolds(name: string): DraftState {
  const state = table();
  state.queues[1]![0] = Array.from({ length: 5 }, (_, i) => card(`bot${i}`, name));
  return state;
}

const refusal = (result: ReturnType<typeof pick>) => (result.ok ? 'ok' : result.reason);

it('the four cards are in the table of draft actions', () => {
  expect(draftActionCards()).toEqual(expect.arrayContaining(['Cogwork Spy', 'Illusionary Informant', 'Spire Phantasm', 'Whispergear Sneak']));
});

describe('Cogwork Spy', () => {
  const spy = () => card('spy', 'Cogwork Spy');
  const drafted = () => take(table([spy()]), 0, 'spy');

  it('is revealed to the table as it is drafted and shows nothing yet', () => {
    const state = drafted();
    expect(logOf(state)).toEqual(['0 revealed spy']);
    expect(state.faceUp[0]).toEqual([]);
    expect(seenBy(state, 0)).toEqual([]);
    expect(asksOf(state, 0)).toEqual([]);
  });

  it('shows its drafter the next card drafted from that pack, with who drafted it, and nobody else', () => {
    let state = take(drafted(), 1, 'r0s1c0');
    expect(seenBy(state, 0), 'a card from another pack is not it').toEqual([]);
    state = take(state, 1, 'r0s0c2');
    expect(seenBy(state, 0)).toEqual(['Cogwork Spy: r0s0c2 drafted by Bot 1']);
    expectShownOnlyTo(state, 0, ['r0s0c2'], [1]);
    expect(logOf(state), 'nothing more is said in public').toEqual(['0 revealed spy']);
  });

  it('shows one card only: the pick after that from the same pack is not shown', () => {
    let state = take(take(drafted(), 1, 'r0s1c0'), 1, 'r0s0c2');
    state = take(state, 2, 'r0s2c0');
    state = take(state, 2, 'r0s1c1');
    state = take(state, 2, 'r0s0c3');
    expect(seenBy(state, 0)).toEqual(['Cogwork Spy: r0s0c2 drafted by Bot 1']);
    expect(state.packMarks).toEqual([]);
  });

  it('drafted as the last card of its pack, there is nothing to see', () => {
    const state = table();
    state.queues[0]![0] = [spy()];
    const after = take(state, 0, 'spy');
    expect(after.packMarks).toEqual([]);
    expect(logOf(after)).toEqual(['0 revealed spy']);
  });

  it('a bot that drafts it is shown the card, and no person is', () => {
    const state = runBots(botHolds('Cogwork Spy')).state;
    expect(state.pools[1]!.some((c) => c.name === 'Cogwork Spy')).toBe(true);
    expect(seenBy(state, 0)).toEqual([]);
    expect(finish(state).status).toBe('complete');
  });

  it('a seat whose time runs out is still shown, and the draft finishes with full pools', () => {
    const timed = timeoutPick(table([spy()]), 0);
    expect(timed?.ok).toBe(true);
    const done = finish(drafted());
    expect(done.status).toBe('complete');
    expect(done.pools.map((p) => p.length)).toEqual([15, 15, 15, 15]);
    expect(seenBy(done, 0)).toHaveLength(1);
    expectShownOnlyTo(done, 0, []);
  });
});

describe('Spire Phantasm', () => {
  const phantasm = () => card('phantasm', 'Spire Phantasm');
  const drafted = () => take(table([phantasm()]), 0, 'phantasm');
  /** Seat 1 drafts from its own pack, then `cardId` from the pack the Phantasm came from. */
  const nextDrafts = (state: DraftState, cardId: string) => take(take(state, 1, 'r0s1c0'), 1, cardId);

  it('is revealed, and asks its drafter alone to guess among the cards left in that pack', () => {
    const state = drafted();
    expect(logOf(state)).toEqual(['0 revealed phantasm']);
    const own = viewFor(state, 0).viewer;
    if (own.kind !== 'seat') throw new Error('expected a seat');
    expect(own.asks?.map((a) => [a.source, a.cards?.map((c) => c.cardId)])).toEqual([['Spire Phantasm', ['r0s0c1', 'r0s0c2', 'r0s0c3', 'r0s0c4']]]);
    expect(own.asks?.[0] !== undefined && 'data' in own.asks[0]).toBe(false);
    for (const { who, view } of othersThan(state, 0)) expect('asks' in view.viewer, who).toBe(false);
    const open = asksOf(state, 0)[0]!;
    expect(refusal(answer(state, 1, open.id, 'r0s0c1'))).toBe('unknown-ask');
    expect(refusal(answer(state, 0, open.id, 'phantasm'))).toBe('bad-answer');
    expect(refusal(answer(state, 0, open.id, 'r1s0c0'))).toBe('bad-answer');
  });

  it('the guess stays private until the card is drafted', () => {
    const state = reply(drafted(), 0, 'r0s0c2');
    expect(logOf(state)).toEqual(['0 revealed phantasm']);
    for (const { who, view } of othersThan(state, 0)) {
      if (who.endsWith('seat 1')) continue; // the pack itself is in front of seat 1
      expect(JSON.stringify(view), who).not.toContain('r0s0c2');
    }
    expect(JSON.stringify(viewFor(state, 1))).not.toContain('guess');
  });

  it('a right guess: the drafted card is revealed to the table, and the guessed name is noted for the guesser', () => {
    const state = nextDrafts(reply(drafted(), 0, 'r0s0c2'), 'r0s0c2');
    expect(logOf(state)).toEqual(['0 revealed phantasm', '1 revealed r0s0c2 as alice guessed']);
    expect(state.notes[0]).toEqual({ 'Spire Phantasm': ['Card r0s0c2'] });
    for (const { view } of othersThan(state, 0)) expect(semanticIssues(view)).toEqual([]);
    expect(state.packMarks).toEqual([]);
  });

  it('a wrong guess: the drafted card is revealed all the same, and nothing is noted', () => {
    const state = nextDrafts(reply(drafted(), 0, 'r0s0c2'), 'r0s0c3');
    expect(logOf(state)).toEqual(['0 revealed phantasm', '1 revealed r0s0c3 (alice guessed Card r0s0c2)']);
    expect(state.notes[0]).toEqual({});
    // Only the next card drafted from the pack is revealed.
    const later = take(take(take(state, 2, 'r0s2c0'), 2, 'r0s1c1'), 2, 'r0s0c2');
    expect(logOf(later)).toHaveLength(2);
    expect(later.notes[0]).toEqual({});
  });

  it('a card drafted from the pack before the guess is in is kept unseen, and revealed once it is', () => {
    const waiting = nextDrafts(drafted(), 'r0s0c2');
    expect(logOf(waiting)).toEqual(['0 revealed phantasm']);
    const own = viewFor(waiting, 0).viewer;
    expect(own.kind === 'seat' && own.asks?.[0] !== undefined && 'data' in own.asks[0]).toBe(false);
    expect(JSON.stringify(viewFor(waiting, 0)), 'the card kept with the question is not sent').not.toContain('"drafted":');
    for (const { who, view } of othersThan(waiting, 0)) {
      if (who.endsWith('seat 1')) continue;
      expect(JSON.stringify(view), who).not.toContain('r0s0c2');
    }
    const right = reply(waiting, 0, 'r0s0c2');
    expect(logOf(right)).toEqual(['0 revealed phantasm', '1 revealed r0s0c2 as alice guessed']);
    expect(right.notes[0]).toEqual({ 'Spire Phantasm': ['Card r0s0c2'] });
    const wrong = reply(waiting, 0, 'r0s0c4');
    expect(logOf(wrong)).toEqual(['0 revealed phantasm', '1 revealed r0s0c2 (alice guessed Card r0s0c4)']);
    expect(wrong.notes[0]).toEqual({});
  });

  it('a name the pack holds twice is one choice', () => {
    const state = table([phantasm(), card('twin-a', 'Twin'), card('twin-b', 'Twin')]);
    const asked = take(state, 0, 'phantasm');
    expect(asksOf(asked, 0)[0]?.cards?.map((c) => c.cardId)).toEqual(['twin-a', 'r0s0c3', 'r0s0c4']);
    // The guess is of the name: the other copy drafted is a right guess.
    const done = nextDrafts(reply(asked, 0, 'twin-a'), 'twin-b');
    expect(done.notes[0]).toEqual({ 'Spire Phantasm': ['Twin'] });
  });

  it('drafted as the last card of its pack, there is nothing to guess and nothing is asked', () => {
    const state = table();
    state.queues[0]![0] = [phantasm()];
    const after = take(state, 0, 'phantasm');
    expect(asksOf(after, 0)).toEqual([]);
    expect(after.packMarks).toEqual([]);
  });

  it('a seat whose time runs out guesses the first card, and a bot that drafts it leaves no question open', () => {
    const timed = timeoutPick(drafted(), 0);
    if (timed?.ok !== true) throw new Error('the timer did not act');
    expect(asksOf(timed.state, 0)).toEqual([]);
    const revealed = nextDrafts(timed.state, 'r0s0c1');
    expect(revealed.notes[0]).toEqual({ 'Spire Phantasm': ['Card r0s0c1'] });

    const bots = runBots(botHolds('Spire Phantasm')).state;
    expect(bots.pools[1]!.some((c) => c.name === 'Spire Phantasm')).toBe(true);
    expect(bots.asks).toEqual([]);
    expect(finish(bots).status).toBe('complete');
  });

  it('the whole draft finishes with full pools', () => {
    const done = finish(drafted());
    expect(done.status).toBe('complete');
    expect(done.pools.map((p) => p.length)).toEqual([15, 15, 15, 15]);
  });
});

describe('Illusionary Informant', () => {
  const informant = () => card('informant', 'Illusionary Informant');
  const drafted = () => take(table([informant()]), 0, 'informant');
  const used = () => {
    const result = useNow(drafted(), 0, 'informant', '1');
    if (!result.ok) throw new Error(result.reason);
    return result.state;
  };

  it('is drafted face up and offered to its drafter at any time, pointed at another seat', () => {
    const state = drafted();
    expect(packOf(state, 0), 'no pack is in front of its drafter').toEqual([]);
    expect(spectatorView(state).seats[0]?.faceUp?.map((c) => c.cardId)).toEqual(['informant']);
    expect(usesOf(state, 0)).toEqual([
      {
        with: 'informant',
        name: 'Illusionary Informant',
        when: 'now',
        targets: [
          { key: '1', label: 'Bot 1' },
          { key: '2', label: 'Bot 2' },
          { key: '3', label: 'Bot 3' },
        ],
      },
    ]);
    for (const { who, view } of othersThan(state, 0)) expect('uses' in view.viewer, who).toBe(false);
  });

  it('turned face down, it shows its user the next card that seat drafts, and nobody else', () => {
    let state = used();
    expect(state.faceUp[0]).toEqual([]);
    expect(state.pools[0]!.map((c) => c.cardId)).toEqual(['informant']);
    expect(logOf(state)).toEqual(['0 drafted face up informant', '0 turned face down informant']);
    expect(usesOf(state, 0)).toEqual([]);
    for (const view of [viewFor(state, 1), spectatorView(state)]) expect(view.seats[0]?.faceUp).toBeUndefined();

    state = take(state, 2, 'r0s2c0');
    expect(seenBy(state, 0), 'another seat\'s pick is not it').toEqual([]);
    state = take(state, 1, 'r0s1c3');
    expect(seenBy(state, 0)).toEqual(['Illusionary Informant: r0s1c3 drafted by Bot 1']);
    expectShownOnlyTo(state, 0, ['r0s1c3'], [1]);

    state = take(state, 1, 'r0s0c1');
    expect(seenBy(state, 0), 'one card only').toHaveLength(1);
    expect(state.effects[0]).toEqual([]);
  });

  it('refuses no seat, its own seat, a seat that is not there, another seat using it, and a second use', () => {
    const state = drafted();
    expect(refusal(useNow(state, 0, 'informant'))).toBe('use-refused');
    expect(refusal(useNow(state, 0, 'informant', '0'))).toBe('use-refused');
    expect(refusal(useNow(state, 0, 'informant', '9'))).toBe('use-refused');
    expect(refusal(useNow(state, 1, 'informant', '0'))).toBe('use-refused');
    expect(refusal(useNow(used(), 0, 'informant', '2'))).toBe('use-refused');
    expect(state.faceUp[0], 'a refused use changes nothing').toEqual(['informant']);
  });

  it('a bot and a run-out timer never use it, and the draft finishes', () => {
    const bots = runBots(botHolds('Illusionary Informant')).state;
    const held = bots.pools[1]!.filter((c) => c.name === 'Illusionary Informant').map((c) => c.cardId);
    expect(held.length).toBeGreaterThan(0);
    expect(bots.faceUp[1]).toEqual(held);
    const done = finish(drafted());
    expect(done.status).toBe('complete');
    expect(done.faceUp[0]).toEqual(['informant']);
    expect(done.pools.map((p) => p.length)).toEqual([15, 15, 15, 15]);
    expect(finish(used()).status).toBe('complete');
  });
});

describe('Whispergear Sneak', () => {
  const sneak = () => card('sneak', 'Whispergear Sneak');
  const drafted = () => take(table([sneak()]), 0, 'sneak');
  const look = (state: DraftState, target: string) => {
    const result = useNow(state, 0, 'sneak', target);
    if (!result.ok) throw new Error(result.reason);
    return result.state;
  };
  const ids = (cards: DraftCard[]) => cards.map((c) => c.cardId);

  it('is offered every unopened pack and every pack waiting behind the one a seat is looking at, by seat', () => {
    const state = drafted();
    const waiting = state.packMeta[1]![1]!.id;
    expect(usesOf(state, 0)).toEqual([
      {
        with: 'sneak',
        name: 'Whispergear Sneak',
        when: 'now',
        targets: [
          { key: 'round:1:0', label: 'Pack 2', group: 'alice' },
          { key: 'round:2:0', label: 'Pack 3', group: 'alice' },
          { key: `pack:${waiting}`, label: 'Waiting 1', group: 'Bot 1' },
          { key: 'round:1:1', label: 'Pack 2', group: 'Bot 1' },
          { key: 'round:2:1', label: 'Pack 3', group: 'Bot 1' },
          { key: 'round:1:2', label: 'Pack 2', group: 'Bot 2' },
          { key: 'round:2:2', label: 'Pack 3', group: 'Bot 2' },
          { key: 'round:1:3', label: 'Pack 2', group: 'Bot 3' },
          { key: 'round:2:3', label: 'Pack 3', group: 'Bot 3' },
        ],
      },
    ]);
  });

  it('turned face down, it shows its user an unopened pack, and nobody else', () => {
    const state = look(drafted(), 'round:1:2');
    expect(state.faceUp[0]).toEqual([]);
    expect(logOf(state)).toEqual(['0 drafted face up sneak', '0 turned face down sneak']);
    expect(seenBy(state, 0)).toEqual(["Whispergear Sneak: r1s2c0,r1s2c1,r1s2c2,r1s2c3,r1s2c4 in Bot 2's pack 2"]);
    expectShownOnlyTo(state, 0, ['r1s2c0', 'r1s2c1', 'r1s2c2', 'r1s2c3', 'r1s2c4']);
    expect(ids(state.rounds[1]![2]!), 'the pack is still unopened, whole').toHaveLength(5);
    expect(usesOf(state, 0)).toEqual([]);
  });

  it('shows a pack waiting behind the one a seat is looking at', () => {
    const before = drafted();
    const state = look(before, `pack:${before.packMeta[1]![1]!.id}`);
    expect(seenBy(state, 0)).toEqual(['Whispergear Sneak: r0s0c1,r0s0c2,r0s0c3,r0s0c4 waiting for Bot 1']);
    expectShownOnlyTo(state, 0, ['r0s0c1', 'r0s0c2', 'r0s0c3', 'r0s0c4']);
    expect(ids(state.queues[1]![1]!)).toEqual(['r0s0c1', 'r0s0c2', 'r0s0c3', 'r0s0c4']);
  });

  it('refuses the pack a seat is looking at, a pack that has since come in front of a seat, no pack, and another seat using it', () => {
    const state = drafted();
    const waiting = `pack:${state.packMeta[1]![1]!.id}`;
    expect(refusal(useNow(state, 0, 'sneak', `pack:${state.packMeta[1]![0]!.id}`))).toBe('use-refused');
    expect(refusal(useNow(state, 0, 'sneak', 'round:0:1')), 'this round is opened').toBe('use-refused');
    expect(refusal(useNow(state, 0, 'sneak'))).toBe('use-refused');
    expect(refusal(useNow(state, 0, 'sneak', 'nonsense'))).toBe('use-refused');
    expect(refusal(useNow(state, 1, 'sneak', 'round:1:2'))).toBe('use-refused');
    const moved = take(state, 1, 'r0s1c0');
    expect(refusal(useNow(moved, 0, 'sneak', waiting)), 'seat 1 is looking at it now').toBe('use-refused');
    expect(refusal(useNow(look(state, waiting), 0, 'sneak', 'round:1:2')), 'it is face down').toBe('use-refused');
    expect(state.faceUp[0]).toEqual(['sneak']);
  });

  it('with no pack unopened and none waiting, it is not offered', () => {
    const state = drafted();
    const last = { ...state, packNumber: 3, queues: state.queues.map((q) => q.slice(0, 1)), packMeta: state.packMeta.map((m) => m.slice(0, 1)) };
    expect(usesOf(last, 0)).toEqual([]);
    expect(refusal(useNow(last, 0, 'sneak', 'round:2:1'))).toBe('use-refused');
  });

  it('a bot and a run-out timer never use it, and the draft finishes', () => {
    const bots = runBots(botHolds('Whispergear Sneak')).state;
    const held = bots.pools[1]!.filter((c) => c.name === 'Whispergear Sneak').map((c) => c.cardId);
    expect(held.length).toBeGreaterThan(0);
    expect(bots.faceUp[1]).toEqual(held);
    const done = finish(drafted());
    expect(done.status).toBe('complete');
    expect(done.faceUp[0]).toEqual(['sneak']);
    expect(done.pools.map((p) => p.length)).toEqual([15, 15, 15, 15]);
    expect(finish(look(drafted(), 'round:2:3')).status).toBe('complete');
  });
});
