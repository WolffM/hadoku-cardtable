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

import { describe, expect, it } from 'vitest';
import { mostUsedPrinting, type PrintingVote } from './build-art-ids.ts';

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
