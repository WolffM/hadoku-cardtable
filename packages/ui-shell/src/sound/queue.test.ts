/*
 * The queue's mechanics — order, shuffling, candidate ranking and padding —
 * against a synthetic catalog and ranking function. The real cell grammar,
 * colour matrix and folder-naming rules are Magic's own
 * (`apps/ui/src/sound/queue.ts` and its test), not this package's.
 */
import { describe, expect, it } from 'vitest';

import { createSoundQueue, type QueueItem, type QueueTake } from './queue.ts';

interface Take extends QueueTake {
  section: 'Moments' | 'Library';
}

function take(file: string, section: Take['section'] = 'Moments'): Take {
  return { file, section };
}

/** Three cells in catalog order: `a`, `b`, `c`. A take's folder (its name before `/`) ranks 0 for its own cell, 1 for `fallback-<cell>`, else `null`. */
const CATALOG: readonly QueueItem[] = [
  { cell: 'a', title: 'A', sub: 'sub-a' },
  { cell: 'b', title: 'B', sub: 'sub-b' },
  { cell: 'c', title: 'C', sub: 'sub-c' },
];

function rankFor(cell: string, folder: string): number | null {
  if (folder === cell) return 0;
  if (folder === `near-${cell}`) return 1;
  return null;
}

function queue(isFallback: (t: Take) => boolean = (t) => t.section === 'Library') {
  return createSoundQueue<Take>({ catalog: CATALOG, rankFor, isEdited: (t) => t.file.endsWith('-edited.ogg'), isFallback });
}

describe('emptyCells and queueOrder', () => {
  it('serves only the empty cells, in catalog order', () => {
    const q = queue().emptyCells({ a: ['a/take-1.ogg'] });
    expect(q.map((i) => i.cell)).toEqual(['b', 'c']);
  });

  it('with a seed the order is random but repeatable, and holds every empty cell once', () => {
    const plain = queue().queueOrder({}, []).map((i) => i.cell);
    const seeded = queue().queueOrder({}, [], 42).map((i) => i.cell);
    expect(seeded).not.toEqual(plain);
    expect([...seeded].sort()).toEqual([...plain].sort());
    expect(queue().queueOrder({}, [], 42).map((i) => i.cell)).toEqual(seeded);
    expect(queue().queueOrder({}, [], 7).map((i) => i.cell)).not.toEqual(seeded);
  });

  it('a skipped cell goes to the back, in the order it was skipped', () => {
    const q = queue().queueOrder({}, ['a', 'b']);
    expect(q.map((i) => i.cell)).toEqual(['c', 'a', 'b']);
  });
});

describe('a filled cell with new candidates', () => {
  const cells = { a: ['a/take-1.ogg'], b: ['near-b/take-1.ogg'] };
  const takes = [take('a/take-1.ogg'), take('a/take-2.ogg'), take('near-b/take-1.ogg'), take('lib-x/take-1.ogg', 'Library')];

  it('is served beside the empty cells, marked filled; a filled cell with nothing new is not', () => {
    const q = queue().queueCells(cells, takes);
    expect(q.find((i) => i.cell === 'a')).toMatchObject({ filled: true, title: 'A' });
    expect(q.some((i) => i.cell === 'b')).toBe(false);
    expect(q.find((i) => i.cell === 'c')?.filled).toBeUndefined();
  });

  it('is offered only its own takes placed nowhere — never the fallback pool, never what it already has', () => {
    const placed = new Set(Object.values(cells).flat());
    expect(queue().freshFor('a', takes, placed).map((t) => t.file)).toEqual(['a/take-2.ogg']);
  });
});

describe('candidatesFor', () => {
  const takes = [
    take('a/take-1.ogg'),
    take('a/take-2.ogg'),
    take('near-a/take-1.ogg'),
    take('lib-1/take-1.ogg', 'Library'),
    take('lib-2/take-1.ogg', 'Library'),
    take('lib-3/take-1.ogg', 'Library'),
  ];

  it('offers a cell its own takes, then its near-fallback folder', () => {
    expect(queue().candidatesFor('a', takes, new Set()).map((t) => t.file).slice(0, 3)).toEqual(['a/take-1.ogg', 'a/take-2.ogg', 'near-a/take-1.ogg']);
  });

  it('offers an edited take before the take it was made from', () => {
    const edited = [take('a/take-1.ogg'), take('a/take-1-edited.ogg')];
    expect(queue().candidatesFor('a', edited, new Set()).map((t) => t.file)).toEqual(['a/take-1-edited.ogg', 'a/take-1.ogg']);
  });

  it('puts a take already placed elsewhere after the ones placed nowhere', () => {
    expect(queue().candidatesFor('a', takes, new Set(['a/take-1.ogg']))[0]!.file).toBe('a/take-2.ogg');
  });

  it('fills a thin choice to three from the fallback pool, never past six, never twice the same', () => {
    const thin = queue().candidatesFor('b', takes, new Set()); // `b`'s own folder is absent here
    expect(thin).toHaveLength(3);
    expect(thin.every((t) => t.section === 'Library')).toBe(true);
    expect(new Set(thin.map((t) => t.file)).size).toBe(3);
    const many = Array.from({ length: 9 }, (_, i) => take(`a/take-${String(i + 10)}.ogg`));
    expect(queue().candidatesFor('a', many, new Set())).toHaveLength(queue().QUEUE_CHOICES);
  });

  it('a configured minChoices/maxChoices overrides the defaults', () => {
    const q = createSoundQueue<Take>({ catalog: CATALOG, rankFor, isFallback: (t) => t.section === 'Library', maxChoices: 2, minChoices: 1 });
    expect(q.QUEUE_CHOICES).toBe(2);
    expect(q.candidatesFor('a', takes, new Set())).toHaveLength(2);
    expect(q.candidatesFor('b', [take('lib-1/take-1.ogg', 'Library')], new Set())).toHaveLength(1);
  });
});
