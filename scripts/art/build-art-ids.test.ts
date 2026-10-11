/*
 * `mostUsedPrinting` is the rule that picks a bare-name row's printing: the id
 * the committed decks and pools voted for most, ties broken by the newest
 * release. Tested here against a fabricated fixture rather than the real
 * Scryfall cache — that cache is gitignored and absent in CI, and the rule
 * being correct does not depend on which printings actually exist.
 *
 * Importing the module must not run its CLI (`main()`'s file reads and
 * network-cache access) — proven by `import.meta.main` guarding that call;
 * this file importing cleanly, with no file-system side effect, is the proof.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { faceRows, mostUsedPrinting, otherFaces, scenarioNames, type PrintingVote } from './build-art-ids.ts';

describe('mostUsedPrinting', () => {
  it('picks the printing with the most votes, not the first one cast', () => {
    // The first vote cast is the OLD Alpha printing — a "first write wins"
    // rule (the behaviour this wave replaces) would pick it. The majority of
    // votes are for the modern printing, cast later, and that is what must win.
    const votes: PrintingVote[] = [
      { name: 'Forest', id: 'old-alpha', releasedAt: '1993-08-05' },
      { name: 'Forest', id: 'old-alpha', releasedAt: '1993-08-05' },
      { name: 'Forest', id: 'modern', releasedAt: '2016-04-08' },
      { name: 'Forest', id: 'modern', releasedAt: '2016-04-08' },
      { name: 'Forest', id: 'modern', releasedAt: '2016-04-08' },
    ];
    expect(mostUsedPrinting(votes).get('Forest')).toBe('modern');
  });

  it('breaks a tied vote count by the newest release', () => {
    const votes: PrintingVote[] = [
      { name: 'Island', id: 'older', releasedAt: '2001-01-01' },
      { name: 'Island', id: 'newer', releasedAt: '2010-01-01' },
    ];
    expect(mostUsedPrinting(votes).get('Island')).toBe('newer');
  });

  it('breaks a tied count AND a tied release date by id, so the result is total', () => {
    const votes: PrintingVote[] = [
      { name: 'Plains', id: 'zzz', releasedAt: '2001-01-01' },
      { name: 'Plains', id: 'aaa', releasedAt: '2001-01-01' },
    ];
    expect(mostUsedPrinting(votes).get('Plains')).toBe('aaa');
  });

  it('treats a missing releasedAt as the oldest possible date, never a crash', () => {
    const votes: PrintingVote[] = [
      { name: 'Swamp', id: 'dated', releasedAt: '1993-08-05' },
      { name: 'Swamp', id: 'undated', releasedAt: null },
    ];
    expect(mostUsedPrinting(votes).get('Swamp')).toBe('dated');
  });

  it('is independent of vote order', () => {
    // Tied count (2 each) — the newest release (b) wins, in either order.
    const votes: PrintingVote[] = [
      { name: 'Mountain', id: 'b', releasedAt: '2020-01-01' },
      { name: 'Mountain', id: 'a', releasedAt: '1999-01-01' },
      { name: 'Mountain', id: 'a', releasedAt: '1999-01-01' },
      { name: 'Mountain', id: 'b', releasedAt: '2020-01-01' },
    ];
    const forward = mostUsedPrinting(votes).get('Mountain');
    const backward = mostUsedPrinting([...votes].reverse()).get('Mountain');
    expect(forward).toBe('b');
    expect(backward).toBe('b');
  });

  it('names no winner for a name nothing voted on', () => {
    expect(mostUsedPrinting([]).size).toBe(0);
  });

  it('keeps every name independent of every other name', () => {
    const votes: PrintingVote[] = [
      { name: 'Forest', id: 'forest-id', releasedAt: '2000-01-01' },
      { name: 'Island', id: 'island-id', releasedAt: '2000-01-01' },
    ];
    const winners = mostUsedPrinting(votes);
    expect(winners.get('Forest')).toBe('forest-id');
    expect(winners.get('Island')).toBe('island-id');
  });
});

describe('the committed table covers every card a test scenario places', () => {
  it('a scenario card has an art row (the e2e Grizzly Bears was drawn without art)', () => {
    const read = (rel: string): unknown => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
    const { ids } = read('../../apps/ui/src/draft/art-ids.json') as { ids: Record<string, string> };
    const { cards } = read('../../apps/ui/src/draft/pool.json') as { cards: { name: string }[] };
    const known = new Set([...Object.keys(ids).map((key) => key.split('|')[0]), ...cards.map((c) => c.name)]);
    const names = scenarioNames();
    expect(names).toContain('Grizzly Bears');
    expect(names.filter((name) => !known.has(name))).toEqual([]);
  });
});

describe('otherFaces: every face Forge can name, and the art it draws', () => {
  const card = (layout: string, faces: string[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'card-id',
    layout,
    set_type: 'expansion',
    card_faces: faces.map((name) => ({ name })),
    ...extra,
  });

  it("a transform or modal back face draws the card's back image", () => {
    expect(otherFaces(card('transform', ['Delver of Secrets', 'Insectile Aberration']))).toEqual([{ name: 'Insectile Aberration', artId: 'card-id#back' }]);
    expect(otherFaces(card('modal_dfc', ['Witch Enchanter', 'Witch-Blessed Meadow']))).toEqual([{ name: 'Witch-Blessed Meadow', artId: 'card-id#back' }]);
  });

  it("split halves, an adventure and a flip card's other face draw the card's one image", () => {
    expect(otherFaces(card('split', ['Life', 'Death']))).toEqual([
      { name: 'Life', artId: 'card-id' },
      { name: 'Death', artId: 'card-id' },
    ]);
    expect(otherFaces(card('adventure', ['Bonecrusher Giant', 'Stomp']))).toEqual([{ name: 'Stomp', artId: 'card-id' }]);
    expect(otherFaces(card('flip', ['Jushi Apprentice', 'Tomoya the Revealer']))).toEqual([{ name: 'Tomoya the Revealer', artId: 'card-id' }]);
  });

  it('a meld half names its melded card, which draws its own image', () => {
    const half = card('meld', [], {
      all_parts: [
        { id: 'urza-lord', component: 'meld_part', name: 'Urza, Lord Protector' },
        { id: 'urza-pw', component: 'meld_result', name: 'Urza, Planeswalker' },
      ],
    });
    expect(otherFaces(half)).toEqual([{ name: 'Urza, Planeswalker', artId: 'urza-pw' }]);
  });

  it('a single-faced card and a token printing name nothing more', () => {
    expect(otherFaces(card('normal', []))).toEqual([]);
    expect(otherFaces(card('flip', ['Monster', 'Virtuous'], { set_type: 'token' }))).toEqual([]);
  });
});

describe('faceRows: each face keyed the way its front is', () => {
  const delver = { id: 'delver', layout: 'transform', set_type: 'expansion', card_faces: [{ name: 'Delver of Secrets' }, { name: 'Insectile Aberration' }] };
  const byId = (id: string): Record<string, unknown> | undefined => (id === 'delver' ? delver : undefined);

  it('gives the back face the exact and bare keys its front has, and skips a card with one face', () => {
    expect(
      faceRows(
        [
          ['Delver of Secrets|ISD', 'delver'],
          ['Delver of Secrets', 'delver'],
          ['Lightning Bolt', 'bolt'],
        ],
        byId,
      ),
    ).toEqual([
      ['Insectile Aberration|ISD', 'delver#back'],
      ['Insectile Aberration', 'delver#back'],
    ]);
  });

  it('keeps the first source for a key, as the table does', () => {
    const reprint = { ...delver, id: 'delver-2' };
    const rows = faceRows(
      [
        ['Delver of Secrets', 'delver'],
        ['Delver of Secrets // Insectile Aberration', 'delver-2'],
      ],
      (id) => (id === 'delver' ? delver : id === 'delver-2' ? reprint : undefined),
    );
    expect(rows).toEqual([['Insectile Aberration', 'delver#back']]);
  });
});
