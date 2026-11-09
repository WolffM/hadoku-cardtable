/*
 * The patch-notes parser, against a REAL release file — never a fixture, because the whole point is
 * that `docs/releases/*.md` already has the shape this reads (`./patchNotes.ts`'s own header).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { fittingBullets, newestFirst, parseReleaseNotes, versionOfPath } from './patchNotes.ts';

const RELEASE_PATH = fileURLToPath(new URL('../../../../docs/releases/v0.36.0.md', import.meta.url));

describe('parseReleaseNotes', () => {
  it('reads the title and every New, Changed and Fixed bullet of a real release file, in that order', () => {
    const markdown = readFileSync(RELEASE_PATH, 'utf8');
    const parsed = parseReleaseNotes(markdown, 'v0.36.0');
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBe('v0.36.0');
    expect(parsed?.title).toBe('Clearer turns and choices');
    const counts = Object.fromEntries((parsed?.sections ?? []).map((sec) => [sec.heading, sec.bullets.length]));
    expect(parsed?.bullets).toHaveLength(counts.New! + counts.Changed! + counts.Fixed!);
    expect(counts['Under the hood']).toBeGreaterThan(0);
    // New's own bullet first, with its bold marker stripped.
    expect(parsed?.bullets[0]).toBe('The table dims while you pick. While you choose a target, attackers or blockers, the rest of the table goes dark so the cards you can pick stand out.');
    // Then Changed's, in its own order.
    expect(parsed?.bullets[1]).toBe('Next Phase has moved into the question box. When the game waits on you it asks "Proceed to Combat?" (or whichever step is next) with a Next Phase button. With a spell on the stack it asks "Resolve <spell>?" with a Resolve button, and Done Attacking and Done Blocking sit at its bottom left. (@kawakimi)');
    expect(parsed?.bullets[2]).toBe('Whose turn it is is easier to see: a brighter edge light, in your colour on your turn. (@kawakimi)');
    // Then Fixed's; Under the hood never reaches the card.
    const fixed = parsed!.sections.find((sec) => sec.heading === 'Fixed')!.bullets;
    expect(parsed?.bullets.at(-1)).toBe(fixed.at(-1)!.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').trim());
  });

  it('fittingBullets counts the bullets whose bottom edge is inside the list', () => {
    expect(fittingBullets([20, 50, 90, 130], 100)).toBe(3);
    expect(fittingBullets([20, 50], 100)).toBe(2);
    expect(fittingBullets([120], 100)).toBe(0);
    // A later bullet never comes back after one that did not fit.
    expect(fittingBullets([20, 130, 90], 100)).toBe(1);
  });

  it('reads no bullets rather than throwing when a section is empty, and null with no heading at all', () => {
    expect(parseReleaseNotes('no heading here', 'v0.0.0')).toBeNull();
    const empty = parseReleaseNotes('# v0.0.0 — Nothing yet\n\n## New\n\n## Changed\n', 'v0.0.0');
    expect(empty).toEqual({ version: 'v0.0.0', title: 'Nothing yet', bullets: [], summary: '', sections: [] });
  });

  it('keeps every section of a real release in file order, bold kept and wrapped lines joined, for the full notes', () => {
    const parsed = parseReleaseNotes(readFileSync(RELEASE_PATH, 'utf8'), 'v0.36.0');
    expect(parsed?.summary).not.toBe('');
    expect(parsed?.sections.map((s) => s.heading)).toEqual(['New', 'Changed', 'Fixed', 'Under the hood']);
    expect(parsed?.sections[0]?.bullets[0]).toMatch(/^\*\*The table dims while you pick\.\*\* While you choose a target/);
    expect(parsed?.sections.every((s) => s.bullets.every((b) => !b.includes('\n')))).toBe(true);
  });

  it('takes the title as the bare heading when there is no em dash', () => {
    const parsed = parseReleaseNotes('# v1.0.0\n\n## New\n\n- A thing\n', 'v1.0.0');
    expect(parsed?.title).toBe('v1.0.0');
  });
});

describe('versionOfPath', () => {
  it('reads a release filename’s bare version, and nothing for a name that is not one', () => {
    expect(versionOfPath('../../../../docs/releases/v0.36.0.md')).toBe('v0.36.0');
    expect(versionOfPath('v1.2.3.md')).toBe('v1.2.3');
    expect(versionOfPath('README.md')).toBe('README');
  });
});

describe('newestFirst', () => {
  it('orders by every part as a number, not as text (v0.9.0 is older than v0.10.0)', () => {
    expect(newestFirst([{ version: 'v0.9.0' }, { version: 'v0.10.0' }, { version: 'v0.2.0' }]).map((r) => r.version)).toEqual(['v0.10.0', 'v0.9.0', 'v0.2.0']);
    expect(newestFirst([])).toEqual([]);
  });
});
