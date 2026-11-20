/*
 * The cards drafted face up and used with a later pick (`pick-uses.ts`),
 * against the engine: one `describe` a card, then the uses armed together.
 */

import { describe, expect, it } from 'vitest';
import { semanticIssues, type DraftCard } from '@hadoku/shared';
import { packOf, pick, receiverOf, usesOf, type DraftState, type PickOptions } from '../engine.ts';
import { runBots } from '../bot.ts';
import { timeoutPick } from '../pick-timer.ts';
import { spectatorView, viewFor, watcherView } from '../view.ts';
import { card, finish, table, take } from './actions.test.ts';
import { creatureTypesOf, keywordsOf } from './card-text.ts';

const OPERATIVE = "Leovold's Operative";
const AGENT = 'Agent of Acquisitions';
const GRINDER = 'Cogwork Grinder';
const ANIMUS = 'Animus of Predation';
const BANNERET = 'Noble Banneret';
const VANGUARD = 'Paliano Vanguard';
const CAPTAIN = 'Smuggler Captain';

/** The same state with the head of seat 0's pack replaced. */
function withFirst(state: DraftState, first: DraftCard): DraftState {
  const next = structuredClone({ ...state, table: null }) as unknown as DraftState;
  next.table = state.table;
  next.queues[0]![0]![0] = first;
  return next;
}

/** Seat 0 has drafted every card of `names` (ids `h0`, `h1`, …), one from the head of each pack it was passed, and holds a fresh pack. */
function holding(...names: string[]): DraftState {
  let state = table();
  names.forEach((name, i) => {
    state = runBots(take(withFirst(state, card(`h${i}`, name)), 0, `h${i}`)).state;
  });
  return state;
}

const refused = (state: DraftState, cardId: string, options: PickOptions) => {
  const result = pick(state, 0, cardId, options);
  return result.ok ? 'ok' : result.reason;
};

const lines = (state: DraftState) => (spectatorView(state).log ?? []).map((l) => [l.seatId, l.verb, ...(l.cards ?? []).map((c) => c.name), ...(l.detail === undefined ? [] : [l.detail])].join(' '));

/** Every payload anybody is sent. */
const everyView = (state: DraftState) => [viewFor(state, 0), viewFor(state, 1), viewFor(state, 2), viewFor(state, 3), watcherView(state, 0), spectatorView(state)];

const land = (id: string) => card(id, `Land ${id}`, 'Land');
const knight = (id: string, name = `Knight ${id}`) => card(id, name, 'Creature — Human Knight');

describe("Leovold's Operative", () => {
  it('is drafted face up and offered with a pick while the pack holds two cards', () => {
    const state = holding(OPERATIVE);
    expect(state.faceUp[0]).toEqual(['h0']);
    expect(usesOf(state, 0)).toEqual([{ with: 'h0', name: OPERATIVE, when: 'pick', extra: true }]);
    expect(usesOf(state, 1)).toEqual([]);
  });

  it('takes a second card, is turned face down and kept, and its seat passes the next pack on whole after being shown it', () => {
    const before = holding(OPERATIVE);
    const pack = packOf(before, 0);
    const [a, b] = [pack[0]!.cardId, pack[1]!.cardId];
    const result = pick(before, 0, a, { use: ['h0'], extra: b });
    if (!result.ok) throw new Error(result.reason);
    let state = result.state;

    expect(state.pools[0]!.map((c) => c.cardId)).toEqual(['h0', a, b]);
    expect(state.faceUp[0]).toEqual([]);
    expect(usesOf(state, 0)).toEqual([]);
    expect(lines(state).slice(-1)).toEqual([`0 turned face down ${OPERATIVE}`]);
    expect(result.events.map((e) => e.type).slice(0, 3)).toEqual(['used', 'picked', 'picked']);

    // The bots pass seat 0 its next pack: it goes straight on to the next seat, whole.
    const pooled = state.pools[0]!.length;
    state = runBots(state).state;
    const shown = state.seen[0]!;
    expect(shown).toHaveLength(1);
    expect(shown[0]!.source).toBe(OPERATIVE);
    expect(state.pools[0]).toHaveLength(pooled);
    expect(state.effects[0]).toEqual([]);
    // What she was shown went on round the table: every card of it is in front of, or in the pool of, another seat.
    const elsewhere = [1, 2, 3].flatMap((s) => [...state.queues[s]!.flat(), ...state.pools[s]!]).map((c) => c.cardId);
    expect(shown[0]!.cards.length).toBeGreaterThan(0);
    for (const c of shown[0]!.cards) expect(elsewhere).toContain(c.cardId);
    // Nobody else is shown it, and the pack after that one is hers to draft.
    for (const view of [viewFor(state, 1), spectatorView(state), watcherView(state, 0)]) {
      expect(JSON.stringify(view)).not.toContain('"seen"');
      expect(semanticIssues(view)).toEqual([]);
    }
    const own = viewFor(state, 0).viewer;
    expect(own.kind === 'seat' && own.seen?.[0]?.cards.map((c) => c.cardId)).toEqual(shown[0]!.cards.map((c) => c.cardId));
    if (packOf(state, 0).length === 0) state = runBots(state).state;
    if (packOf(state, 0).length > 0) {
      state = take(state, 0, packOf(state, 0)[0]!.cardId);
      expect(state.pools[0]).toHaveLength(pooled + 1);
    }
  });

  it('the pack passed on whole reaches the next seat with every card it had', () => {
    let state = holding(OPERATIVE);
    const pack = packOf(state, 0);
    state = take(state, 0, pack[0]!.cardId, { use: ['h0'], extra: pack[1]!.cardId });
    state = runBots(state).state;
    const shown = state.seen[0]![0]!.cards.map((c) => c.cardId);
    // Every card she was shown is in a later pool or pack of somebody else, never hers.
    const done = finish(state);
    expect(done.status).toBe('complete');
    for (const id of shown) expect(done.pools[0]!.map((c) => c.cardId)).not.toContain(id);
    expect(done.pools.flat()).toHaveLength(60);
    expect(new Set(done.pools.flat().map((c) => c.cardId)).size).toBe(60);
  });

  it('refuses without a second card, with a second Operative on the same second card, and with a Librarian on it', () => {
    const state = holding(OPERATIVE, OPERATIVE, 'Cogwork Librarian');
    const pack = packOf(state, 0);
    const [a, b] = [pack[0]!.cardId, pack[1]!.cardId];
    expect(refused(state, a, { use: ['h0'] })).toBe('use-refused');
    expect(refused(state, a, { use: ['h0', 'h1'], extra: b })).toBe('use-refused');
    expect(refused(state, a, { use: ['h0', 'h2'], extra: b })).toBe('use-refused');
    expect(refused(state, a, { use: ['h2', 'h0'], extra: b })).toBe('use-refused');
    expect(refused(state, a, { use: ['h1'], extra: b })).toBe('ok');
  });

  it('two copies are two uses, on two picks', () => {
    let state = holding(OPERATIVE, OPERATIVE);
    let pack = packOf(state, 0);
    state = take(state, 0, pack[0]!.cardId, { use: ['h0'], extra: pack[1]!.cardId });
    expect(state.faceUp[0]).toEqual(['h1']);
    // On to the next round's first pack, one card a pick.
    for (let guard = 0; guard < 20 && state.packNumber === 1; guard++) {
      state = runBots(state).state;
      const mine = packOf(state, 0)[0];
      if (mine !== undefined) state = take(state, 0, mine.cardId);
    }
    state = runBots(state).state;
    pack = packOf(state, 0);
    expect(pack.length).toBeGreaterThanOrEqual(2);
    state = take(state, 0, pack[0]!.cardId, { use: ['h1'], extra: pack[1]!.cardId });
    expect(state.faceUp[0]).toEqual([]);
    expect(finish(state).pools.flat()).toHaveLength(60);
  });

  it('a bot holding it never uses it, and a run-out timer picks one card', () => {
    const packs = table();
    packs.queues[1]![0]![0] = card('bot-op', OPERATIVE);
    const done = finish(packs);
    expect(done.status).toBe('complete');
    expect(done.pools.map((p) => p.length)).toEqual([15, 15, 15, 15]);
    const state = holding(OPERATIVE);
    const timed = timeoutPick(state, 0);
    expect(timed?.ok === true && timed.state.pools[0]).toHaveLength(2);
    expect(timed?.ok === true && timed.state.faceUp[0]).toEqual(['h0']);
  });
});

describe('Agent of Acquisitions', () => {
  it('takes the whole pack whatever card was pressed, passes nothing, and is turned face down', () => {
    const before = holding(AGENT);
    const pack = packOf(before, 0);
    expect(usesOf(before, 0)).toEqual([{ with: 'h0', name: AGENT, when: 'pick' }]);
    const result = pick(before, 0, pack[2]!.cardId, { use: ['h0'] });
    if (!result.ok) throw new Error(result.reason);
    const state = result.state;
    expect(state.pools[0]!.map((c) => c.cardId).sort()).toEqual(['h0', ...pack.map((c) => c.cardId)].sort());
    // No card of that pack is in front of anybody.
    const taken = pack.map((c) => c.cardId);
    expect(state.queues.flat(2).filter((c) => taken.includes(c.cardId))).toEqual([]);
    expect(state.faceUp[0]).toEqual([]);
    expect(lines(state).slice(-1)).toEqual([`0 turned face down ${AGENT}`]);
    // The cards she took are hidden like any pick.
    const other = JSON.stringify(viewFor(state, 1));
    for (const c of pack) expect(other).not.toContain(`"${c.cardId}"`);
  });

  it('for the rest of that round every pack that reaches the seat passes on whole, shown to it; the next round it drafts again', () => {
    let state = holding(AGENT);
    state = take(state, 0, packOf(state, 0)[0]!.cardId, { use: ['h0'] });
    const pooled = state.pools[0]!.length;
    for (let guard = 0; guard < 50 && state.packNumber === 1; guard++) {
      expect(packOf(state, 0)).toEqual([]);
      expect(timeoutPick(state, 0)).toBeNull();
      state = runBots(state).state;
    }
    expect(state.packNumber).toBe(2);
    expect(state.pools[0]).toHaveLength(pooled);
    expect(state.seen[0]!.length).toBeGreaterThan(0);
    expect(state.seen[0]!.every((s) => s.source === AGENT)).toBe(true);
    expect(packOf(state, 0)).toHaveLength(5);
    state = take(state, 0, packOf(state, 0)[0]!.cardId);
    expect(state.pools[0]).toHaveLength(pooled + 1);
    // The spent effect is gone once she drafts again.
    expect(state.effects[0]).toEqual([]);
    const done = finish(state);
    expect(done.status).toBe('complete');
    expect(done.pools.flat()).toHaveLength(60);
    expect(new Set(done.pools.flat().map((c) => c.cardId)).size).toBe(60);
  });

  it('each card taken is drafted in its own right: one drafted face up lies face up', () => {
    const state = withFirst(holding(AGENT), card('lib', 'Cogwork Librarian'));
    const after = take(state, 0, packOf(state, 0)[1]!.cardId, { use: ['h0'] });
    expect(after.faceUp[0]).toEqual(['lib']);
  });

  it('refuses a second card, a second Agent on the same pick, and an Operative with it', () => {
    const state = holding(AGENT, AGENT, OPERATIVE);
    const pack = packOf(state, 0);
    const [a, b] = [pack[0]!.cardId, pack[1]!.cardId];
    expect(refused(state, a, { use: ['h0'], extra: b })).toBe('use-refused');
    expect(refused(state, a, { use: ['h0', 'h1'] })).toBe('use-refused');
    expect(refused(state, a, { use: ['h0', 'h2'], extra: b })).toBe('use-refused');
    expect(refused(state, a, { use: ['h2', 'h0'], extra: b })).toBe('use-refused');
  });

  it('with every seat stopped from drafting, what is left of the round is drafted by nobody and the draft still ends', () => {
    let state = holding(AGENT);
    state = take(state, 0, packOf(state, 0)[0]!.cardId, { use: ['h0'] });
    const mine = state.effects[0]!;
    expect(mine).toHaveLength(1);
    for (let s = 1; s < 4; s++) state.effects[s] = structuredClone(mine);
    const done = finish(state);
    expect(done.status).toBe('complete');
    expect(done.pools.flat().length).toBeLessThan(60);
    expect(new Set(done.pools.flat().map((c) => c.cardId)).size).toBe(done.pools.flat().length);
  });

  it('a bot holding it drafts as ever', () => {
    const packs = table();
    packs.queues[2]![0]![0] = card('bot-agent', AGENT);
    expect(finish(packs).pools.map((p) => p.length)).toEqual([15, 15, 15, 15]);
  });
});

describe('Cogwork Grinder', () => {
  it('removes the picked card from the draft face down: no pool, no pack, and the table is not told which', () => {
    const before = holding(GRINDER);
    const pack = packOf(before, 0);
    const gone = pack[0]!;
    const to = receiverOf(before, 0);
    const state = take(before, 0, gone.cardId, { use: ['h0'] });
    expect(state.pools[0]!.map((c) => c.cardId)).toEqual(['h0']);
    expect(state.queues[to]!.at(-1)!.map((c) => c.cardId)).toEqual(pack.slice(1).map((c) => c.cardId));
    expect(state.notes[0]).toEqual({ [GRINDER]: [gone.name] });
    expect(lines(state).slice(-1)).toEqual(['0 removed a card from the draft face down']);
    for (const view of everyView(state)) {
      expect(JSON.stringify(view)).not.toContain(`"${gone.cardId}"`);
      expect(JSON.stringify(view)).not.toContain(gone.name);
      expect(semanticIssues(view)).toEqual([]);
    }
  });

  it('stays face up and is used on every later pick', () => {
    let state = holding(GRINDER);
    for (let n = 0; n < 3; n++) {
      expect(usesOf(state, 0)).toEqual([{ with: 'h0', name: GRINDER, when: 'pick' }]);
      state = runBots(take(state, 0, packOf(state, 0)[0]!.cardId, { use: ['h0'] })).state;
    }
    expect(state.faceUp[0]).toEqual(['h0']);
    expect(state.notes[0]![GRINDER]).toHaveLength(3);
    expect(state.pools[0]).toHaveLength(1);
    const done = finish(state);
    expect(done.status).toBe('complete');
    expect(done.pools.flat()).toHaveLength(57);
    expect(done.pools[0]).toHaveLength(12);
    // A pool short of a full draft's cards is still told the draft has ended.
    expect(viewFor(done, 0).complete).toBe(true);
    expect(viewFor(state, 0).complete).toBe(false);
  });

  it('two Grinders on one pick are refused: a card is removed once', () => {
    const state = holding(GRINDER, GRINDER);
    const a = packOf(state, 0)[0]!.cardId;
    expect(refused(state, a, { use: ['h0', 'h1'] })).toBe('use-refused');
    expect(refused(state, a, { use: ['h1'] })).toBe('ok');
  });

  it('a bot holding it, and a run-out timer, remove nothing', () => {
    const packs = table();
    packs.queues[1]![0]![0] = card('bot-grinder', GRINDER);
    expect(finish(packs).pools.flat()).toHaveLength(60);
    const timed = timeoutPick(holding(GRINDER), 0);
    expect(timed?.ok === true && timed.state.pools[0]).toHaveLength(2);
    expect(timed?.ok === true && timed.state.notes[0]).toEqual({});
  });
});

describe('Animus of Predation', () => {
  const flier = () => ({ ...knight('flier', 'Serra Angel'), oracleText: 'Flying, vigilance' });

  it('removes the picked card face up: the table is told which, and it is in no pool or pack', () => {
    const before = withFirst(holding(ANIMUS), flier());
    const state = take(before, 0, 'flier', { use: ['h0'] });
    expect(state.pools[0]!.map((c) => c.cardId)).toEqual(['h0']);
    expect(state.queues.flat(2).map((c) => c.cardId)).not.toContain('flier');
    expect(lines(state).slice(-1)).toEqual(['0 removed Serra Angel from the draft']);
    expect(state.faceUp[0]).toEqual(['h0']);
    expect(usesOf(runBots(state).state, 0).map((u) => u.name)).toEqual([ANIMUS]);
    for (const view of everyView(state)) expect(semanticIssues(view)).toEqual([]);
  });

  it('notes a removed creature\'s keywords as one entry, and nothing for a card that is no creature or has none', () => {
    let state = withFirst(holding(ANIMUS), flier());
    state = runBots(take(state, 0, 'flier', { use: ['h0'] })).state;
    expect(state.notes[0]).toEqual({ [ANIMUS]: ['Flying,Vigilance'] });
    state = withFirst(state, { ...land('spell'), typeLine: 'Instant', oracleText: 'Flying' });
    state = runBots(take(state, 0, 'spell', { use: ['h0'] })).state;
    state = withFirst(state, knight('plain'));
    state = take(state, 0, 'plain', { use: ['h0'] });
    expect(state.notes[0]).toEqual({ [ANIMUS]: ['Flying,Vigilance'] });
  });

  it('refuses with a Grinder on the same pick, in either order', () => {
    const state = holding(ANIMUS, GRINDER);
    const a = packOf(state, 0)[0]!.cardId;
    expect(refused(state, a, { use: ['h0', 'h1'] })).toBe('use-refused');
    expect(refused(state, a, { use: ['h1', 'h0'] })).toBe('use-refused');
  });

  it('a draft with removals ends', () => {
    let state = holding(ANIMUS);
    state = take(state, 0, packOf(state, 0)[0]!.cardId, { use: ['h0'] });
    const done = finish(state);
    expect(done.status).toBe('complete');
    expect(done.pools.flat()).toHaveLength(59);
  });
});

describe('the keywords and creature types a card is read for', () => {
  it('reads keyword lines, in Forge\'s capitalisation, and never a keyword inside a sentence', () => {
    expect(keywordsOf('Flying, first strike\nWhen this enters, draw a card.')).toEqual(['Flying', 'First Strike']);
    expect(keywordsOf('Double strike (This creature deals both first-strike and regular combat damage.)\nHaste')).toEqual(['Double Strike', 'Haste']);
    expect(keywordsOf('Deathtouch; lifelink\nHexproof, indestructible\nMenace, reach, vigilance')).toEqual([
      'Deathtouch',
      'Lifelink',
      'Hexproof',
      'Indestructible',
      'Menace',
      'Reach',
      'Vigilance',
    ]);
    expect(keywordsOf('Creatures you control have flying, vigilance, and haste.')).toEqual([]);
    expect(keywordsOf('{T}: Target creature gains flying until end of turn.')).toEqual([]);
    expect(keywordsOf('Flying, protection from red\nTrample\nFlying')).toEqual(['Flying']);
    expect(keywordsOf('Hexproof from black')).toEqual([]);
    expect(keywordsOf('')).toEqual([]);
  });

  it('reads the creature types after the dash of the front face', () => {
    expect(creatureTypesOf('Legendary Creature — Human Soldier')).toEqual(['Human', 'Soldier']);
    expect(creatureTypesOf('Artifact Creature — Construct')).toEqual(['Construct']);
    expect(creatureTypesOf('Creature — Human Werewolf // Creature — Werewolf')).toEqual(['Human', 'Werewolf']);
    expect(creatureTypesOf('Creature — Time Lord Doctor')).toEqual(['Time Lord', 'Doctor']);
    expect(creatureTypesOf('Creature')).toEqual([]);
    expect(creatureTypesOf('Instant')).toEqual([]);
  });
});

describe.each([
  [BANNERET, 'creature' as const, (c: DraftCard) => [c.name]],
  [VANGUARD, 'creature' as const, () => ['Human', 'Knight']],
  [CAPTAIN, undefined, (c: DraftCard) => [c.name]],
])('%s', (name, needs, noted) => {
  it('is offered with a pick, saying what the picked card must be', () => {
    const state = withFirst(holding(name), knight('k'));
    expect(usesOf(state, 0)).toEqual([{ with: 'h0', name, when: 'pick', ...(needs === undefined ? {} : { needs }) }]);
  });

  it('reveals the picked card to the table, notes it, is turned face down, and the card is still drafted', () => {
    const before = withFirst(holding(name), knight('k', 'Knight of Tests'));
    const state = take(before, 0, 'k', { use: ['h0'] });
    expect(state.pools[0]!.map((c) => c.cardId)).toEqual(['h0', 'k']);
    expect(state.notes[0]).toEqual({ [name]: noted(knight('k', 'Knight of Tests')) });
    expect(state.faceUp[0]).toEqual([]);
    expect(lines(state).slice(-2)).toEqual([`0 revealed Knight of Tests for ${name}`, `0 turned face down ${name}`]);
    expect(usesOf(runBots(state).state, 0)).toEqual([]);
    for (const view of everyView(state)) expect(semanticIssues(view)).toEqual([]);
    // Revealed once: the card is hidden in her pool like any other after.
    const other = viewFor(state, 1);
    expect(other.seats[0]?.faceUp).toBeUndefined();
  });

  it(needs === undefined ? 'takes a card that is no creature' : 'refuses a card that is no creature, and is not offered when the pack holds none', () => {
    const before = withFirst(holding(name), land('l'));
    if (needs === undefined) {
      const state = take(before, 0, 'l', { use: ['h0'] });
      expect(state.notes[0]).toEqual({ [name]: ['Land l'] });
      return;
    }
    expect(refused(before, 'l', { use: ['h0'] })).toBe('use-refused');
    expect(before.faceUp[0]).toEqual(['h0']);
    const barren = structuredClone({ ...before, table: null }) as unknown as DraftState;
    barren.table = before.table;
    barren.queues[0]![0] = barren.queues[0]![0]!.map((c) => ({ ...c, typeLine: 'Land' }));
    expect(usesOf(barren, 0)).toEqual([]);
  });

  it('a bot holding it, and a run-out timer, note nothing; the draft ends with full pools', () => {
    const packs = table();
    packs.queues[1]![0]![0] = card('bot-held', name);
    const done = finish(packs);
    expect(done.status).toBe('complete');
    expect(done.notes).toEqual([{}, {}, {}, {}]);
    const used = finish(take(withFirst(holding(name), knight('k')), 0, 'k', { use: ['h0'] }));
    expect(used.status).toBe('complete');
    expect(used.pools.map((p) => p.length)).toEqual([15, 15, 15, 15]);
    const timed = timeoutPick(holding(name), 0);
    expect(timed?.ok === true && timed.state.notes[0]).toEqual({});
  });
});

describe('Paliano Vanguard', () => {
  it('a creature with no creature type is revealed and nothing is noted', () => {
    const before = withFirst(holding(VANGUARD), card('bare', 'Bare', 'Creature'));
    const state = take(before, 0, 'bare', { use: ['h0'] });
    expect(state.notes[0]).toEqual({});
    expect(state.faceUp[0]).toEqual([]);
  });
});

describe('uses armed together with one pick', () => {
  it('a Banneret, a Vanguard and a Captain all take the same creature: each notes it and each is turned face down', () => {
    const before = withFirst(holding(BANNERET, VANGUARD, CAPTAIN, BANNERET), knight('k', 'Knight of Tests'));
    const state = take(before, 0, 'k', { use: ['h0', 'h1', 'h2', 'h3'] });
    expect(state.notes[0]).toEqual({ [BANNERET]: ['Knight of Tests', 'Knight of Tests'], [VANGUARD]: ['Human', 'Knight'], [CAPTAIN]: ['Knight of Tests'] });
    expect(state.faceUp[0]).toEqual([]);
    expect(state.pools[0]!.map((c) => c.cardId)).toContain('k');
  });

  it('removing a card and revealing it for a note is refused, in either order', () => {
    for (const remover of [GRINDER, ANIMUS]) {
      for (const noter of [BANNERET, VANGUARD, CAPTAIN]) {
        const state = withFirst(holding(remover, noter), knight('k'));
        expect(refused(state, 'k', { use: ['h0', 'h1'] })).toBe('use-refused');
        expect(refused(state, 'k', { use: ['h1', 'h0'] })).toBe('use-refused');
      }
    }
  });

  it('an Operative with a Grinder: the pick is removed and the second card is kept', () => {
    const before = holding(OPERATIVE, GRINDER);
    const pack = packOf(before, 0);
    const [a, b] = [pack[0]!, pack[1]!];
    for (const use of [['h0', 'h1'], ['h1', 'h0']]) {
      const state = take(before, 0, a.cardId, { use, extra: b.cardId });
      expect(state.pools[0]!.map((c) => c.cardId)).toEqual(['h0', 'h1', b.cardId]);
      expect(state.notes[0]).toEqual({ [GRINDER]: [a.name] });
      expect(state.faceUp[0]).toEqual(['h1']);
    }
  });

  it('an Operative with a Banneret: the pick is the card revealed and noted, and both cards are kept', () => {
    const before = withFirst(holding(OPERATIVE, BANNERET), knight('k', 'Knight of Tests'));
    const b = packOf(before, 0)[1]!.cardId;
    const state = take(before, 0, 'k', { use: ['h0', 'h1'], extra: b });
    expect(state.pools[0]!.map((c) => c.cardId)).toEqual(['h0', 'h1', 'k', b]);
    expect(state.notes[0]).toEqual({ [BANNERET]: ['Knight of Tests'] });
    expect(state.faceUp[0]).toEqual([]);
  });

  it('an Agent with a Grinder: the pressed card is removed and the rest of the pack is taken', () => {
    const before = holding(AGENT, GRINDER);
    const pack = packOf(before, 0);
    for (const use of [['h0', 'h1'], ['h1', 'h0']]) {
      const state = take(before, 0, pack[1]!.cardId, { use });
      expect(state.pools[0]!.map((c) => c.cardId).sort()).toEqual(['h0', 'h1', ...pack.filter((_, i) => i !== 1).map((c) => c.cardId)].sort());
      expect(state.notes[0]).toEqual({ [GRINDER]: [pack[1]!.name] });
    }
  });

  it('an Agent with a Captain: the pressed card is the one revealed and noted', () => {
    const before = holding(AGENT, CAPTAIN);
    const pack = packOf(before, 0);
    const state = take(before, 0, pack[1]!.cardId, { use: ['h0', 'h1'] });
    expect(state.notes[0]).toEqual({ [CAPTAIN]: [pack[1]!.name] });
    expect(state.pools[0]).toHaveLength(2 + pack.length);
  });

  it('two Librarians on one second card are refused', () => {
    const state = holding('Cogwork Librarian', 'Cogwork Librarian');
    const pack = packOf(state, 0);
    expect(refused(state, pack[0]!.cardId, { use: ['h0', 'h1'], extra: pack[1]!.cardId })).toBe('use-refused');
  });
});
