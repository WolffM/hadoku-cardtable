/*
 * The patch-notes parser, against a REAL release file — never a fixture, because the whole point is
 * that `docs/releases/*.md` already has the shape this reads (`./patchNotes.ts`'s own header).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { newestFirst, parseReleaseNotes, versionOfPath } from './patchNotes.ts';

const RELEASE_PATH = fileURLToPath(new URL('../../../../docs/releases/v0.36.0.md', import.meta.url));

describe('parseReleaseNotes', () => {
  it('reads the title and the first three New/Changed bullets of a real release file', () => {
    const markdown = readFileSync(RELEASE_PATH, 'utf8');
    const parsed = parseReleaseNotes(markdown, 'v0.36.0');
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBe('v0.36.0');
    expect(parsed?.title).toBe('Clearer turns and choices');
    expect(parsed?.bullets).toHaveLength(3);
    // New's own bullet first, with its bold marker stripped.
    expect(parsed?.bullets[0]).toBe('The table dims while you pick. While you choose a target, attackers or blockers, the rest of the table goes dark so the cards you can pick stand out.');
    // Then Changed's, in its own order.
    expect(parsed?.bullets[1]).toBe('Next Phase has moved into the question box. When the game waits on you it asks "Proceed to Combat?" (or whichever step is next) with a Next Phase button. With a spell on the stack it asks "Resolve <spell>?" with a Resolve button, and Done Attacking and Done Blocking sit at its bottom left.');
    expect(parsed?.bullets[2]).toBe('Whose turn it is is easier to see: a brighter edge light, in your colour on your turn.');
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
