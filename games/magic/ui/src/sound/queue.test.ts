import { describe, expect, it } from 'vitest';

import type { SoundTake } from '@hadoku/shared';

import { candidatesFor, emptyCells, freshFor, queueCells, queueOrder, QUEUE_CHOICES } from './queue.ts';

function take(file: string, section: SoundTake['section'] = 'Moments'): SoundTake {
  return { file, sound: file, name: file, group: 'g', section, label: file, seconds: 1, prompt: 'p' };
}

describe('the queue’s order', () => {
  it('serves empty cells only: roles first in group order, then mono colours, never music', () => {
    const q = emptyCells({ 'ui.hover-card|play': ['x/take-1.ogg'] });
    expect(q[0]!.cell).toBe('ui.select|play');
    expect(q.some((i) => i.cell.startsWith('music.'))).toBe(false);
    expect(q.some((i) => i.cell === 'ui.hover-card|play')).toBe(false);
    const firstColour = q.findIndex((i) => !i.cell.endsWith('|play'));
    expect(q[firstColour]!.cell).toBe('W|spell');
    expect(q.slice(firstColour).every((i) => !i.cell.endsWith('|play'))).toBe(true);
    expect(q.find((i) => i.cell === 'U|basic')).toEqual({ cell: 'U|basic', title: 'Island', sub: 'Mono blue' });
    expect(q.find((i) => i.cell === 'RW|spell')!.title).toBe('Boros spell');
    expect(q.some((i) => i.cell === 'WU|basic')).toBe(false);
  });

  it('with a seed the order is random but repeatable, and holds every empty cell once', () => {
    const plain = queueOrder({}, []).map((i) => i.cell);
    const a = queueOrder({}, [], 42).map((i) => i.cell);
    expect(a).not.toEqual(plain);
    expect([...a].sort()).toEqual([...plain].sort());
    expect(queueOrder({}, [], 42).map((i) => i.cell)).toEqual(a);
    expect(queueOrder({}, [], 7).map((i) => i.cell)).not.toEqual(a);
    expect(queueOrder({}, [a[0]!], 42).at(-1)!.cell).toBe(a[0]);
  });

  it('a skipped cell goes to the back, in the order it was skipped', () => {
    const q = queueOrder({}, ['ui.select|play', 'ui.hover-card|play']);
    expect(q.slice(-2).map((i) => i.cell)).toEqual(['ui.select|play', 'ui.hover-card|play']);
    expect(q[0]!.cell).toBe('ui.lift|play');
  });
});

describe('a filled cell with new candidates (2026-10-11)', () => {
  const cells = { 'g.tap|play': ['g.tap/take-1.ogg'], 'g.draw|play': ['m-draw/take-1.ogg'] };
  const takes = [take('g.tap/take-1.ogg'), take('g.tap/take-v1-7100.ogg'), take('m-draw/take-1.ogg'), take('lib-owl/take-1.ogg', 'Library')];

  it('is served beside the empty cells, marked filled; a filled cell with nothing new is not', () => {
    const q = queueCells(cells, takes);
    expect(q.find((i) => i.cell === 'g.tap|play')).toMatchObject({ filled: true, title: 'Tap' });
    expect(q.some((i) => i.cell === 'g.draw|play')).toBe(false);
    expect(q.find((i) => i.cell === 'ui.select|play')?.filled).toBeUndefined();
    expect(queueOrder(cells, [], 1, takes).some((i) => i.cell === 'g.tap|play')).toBe(true);
  });

  it('is offered only its own takes placed nowhere — never the library fill, never what it already has', () => {
    const placed = new Set(Object.values(cells).flat());
    expect(freshFor('g.tap|play', takes, placed).map((t) => t.file)).toEqual(['g.tap/take-v1-7100.ogg']);
  });
});

describe('the queue’s candidates', () => {
  const takes = [
    take('g.tap/take-1.ogg'),
    take('g.tap/take-2.ogg'),
    take('m-draw/take-1.ogg'),
    take('g.draw/take-1.ogg'),
    take('g.r2/take-1.ogg', 'Colour sounds'),
    take('g.creature/take-1.ogg', 'Colour sounds'),
    take('land-island/take-1.ogg', 'Land types'),
    take('u.land/take-1.ogg', 'Land types'),
    take('lib-owl/take-1.ogg', 'Library'),
    take('lib-bear/take-1.ogg', 'Library'),
    take('lib-frog/take-1.ogg', 'Library'),
  ];

  it('offers a role its own takes, and the older moment folder made for it', () => {
    expect(candidatesFor('g.draw|play', takes, new Set()).map((t) => t.file)).toEqual(['g.draw/take-1.ogg', 'm-draw/take-1.ogg', expect.stringMatching(/^lib-/)]);
  });

  it('offers a cut or reversed take before the take it was made from', () => {
    const c = candidatesFor('g.counter-on|play', [take('g.counter-on/take-v1-5000.ogg'), take('g.counter-on/take-v1-5000-half.ogg')], new Set());
    expect(c[0]!.file).toBe('g.counter-on/take-v1-5000-half.ogg');
    expect(candidatesFor('g.tap|play', [take('g.tap/take-v3-5002.ogg'), take('g.tap/take-rev-v3-5002.ogg')], new Set()).map((t) => t.file)).toEqual([
      'g.tap/take-rev-v3-5002.ogg',
      'g.tap/take-v3-5002.ogg',
    ]);
  });

  it('puts a takes already placed elsewhere after the ones placed nowhere', () => {
    expect(candidatesFor('g.tap|play', takes, new Set(['g.tap/take-1.ogg']))[0]!.file).toBe('g.tap/take-2.ogg');
  });

  it('offers a colour cell its own column first, never a role’s folder that shares the letter', () => {
    // `g.creature` is green's creature folder AND the "Creature voice" role's id: the shape decides.
    const c = candidatesFor('G|creature', takes, new Set()).map((t) => t.file);
    expect(c.slice(0, 2)).toEqual(['g.creature/take-1.ogg', 'g.r2/take-1.ogg']);
    expect(c.some((f) => f.startsWith('g.tap/') || f.startsWith('g.draw/'))).toBe(false);
  });

  it('offers a basic land its land takes, then its colour’s land', () => {
    expect(candidatesFor('U|basic', takes, new Set()).slice(0, 2).map((t) => t.file)).toEqual(['land-island/take-1.ogg', 'u.land/take-1.ogg']);
  });

  it('offers a colour cell the takes harvested into its own folder, `u-spell` as well as `u.spell`', () => {
    const own = [take('u-spell/take-1.ogg'), take('u-spell/take-v1-11000.ogg'), take('u-basic/take-1.ogg')];
    expect(candidatesFor('U|spell', own, new Set()).slice(0, 2).map((t) => t.file)).toEqual(['u-spell/take-1.ogg', 'u-spell/take-v1-11000.ogg']);
    expect(candidatesFor('U|basic', own, new Set())[0]!.file).toBe('u-basic/take-1.ogg');
  });

  it('fills a thin choice to three from the library, never past six, and never twice the same', () => {
    const thin = candidatesFor('WU|spell', takes, new Set());
    expect(thin).toHaveLength(3);
    expect(thin.every((t) => t.section === 'Library')).toBe(true);
    expect(new Set(thin.map((t) => t.file)).size).toBe(3);
    const many = Array.from({ length: 9 }, (_, i) => take(`g.tap/take-${String(i + 10)}.ogg`));
    expect(candidatesFor('g.tap|play', many, new Set())).toHaveLength(QUEUE_CHOICES);
  });
});
