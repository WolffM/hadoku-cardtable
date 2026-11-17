// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import type { DraftCard } from '@hadoku/shared';
import type { Fetch } from '@hadoku/game-ui/http.ts';

import { AbilityChip, configureLiveArtistForTests } from './AbilityChip.tsx';

afterEach(() => {
  cleanup();
  configureLiveArtistForTests(null);
});

function draftCard(name: string, scryfallId: string): DraftCard {
  return {
    cardId: `c-${name}`,
    name,
    manaCost: [],
    manaValue: 0,
    colors: [],
    typeLine: 'Instant',
    oracleText: `${name}'s rules text.`,
    setCode: 'TST',
    collectorNumber: '1',
    rarity: 'common',
    scryfallId,
  };
}

/** A `Fetch` stub answering `GET .../art/<id>/artist` from `byId` (never found: 404, like the real route). */
function stubArtistFetch(byId: Record<string, string>): Fetch {
  return async (input) => {
    const m = /\/art\/([^/]+)\/artist$/.exec(new URL(input, 'http://localhost/').pathname);
    const artist = m === null ? undefined : byId[m[1]!];
    const body = artist === undefined ? '' : JSON.stringify({ artist });
    return new Response(body, { status: artist === undefined ? 404 : 200, headers: { 'content-type': 'application/json' } });
  };
}

describe('AF632: a source the committed artist table never covered', () => {
  // `Descendant of Storms` — in the real, committed cube pool, so `useArtist` (the fast, no-request
  // path `draft/artists.ts` reads from `art-artists.json`) answers it a string, same fixture
  // `placed.test.ts` already depends on (`f632be90-9e7f-41f8-a52e-a2952354d730` → Lie Setiawan).
  const CUBE_ID = 'f632be90-9e7f-41f8-a52e-a2952354d730';
  // A real UUID, no cube and no committed table row — the live route is the only way to credit it.
  const LIVE_ID = '8810ebb4-9e51-46f0-a54a-a0b4d77b762a';

  it('a cube card still draws from the committed table, no request at all', async () => {
    configureLiveArtistForTests(stubArtistFetch({})); // the live route would answer nothing useful; it must never be asked
    const source = draftCard('Descendant of Storms', CUBE_ID);
    const { container } = render(createElement(AbilityChip, { source, name: 'Descendant of Storms', text: 'draw a card' }));
    await vi.waitFor(() => expect(container.querySelector('.placed__chip-credit')).not.toBeNull());
    expect(container.querySelector('img.placed__chip-art')).not.toBeNull();
    expect(container.querySelector('.placed__chip-credit')!.textContent).toBe('Illus. Lie Setiawan · ™ & © WotC');
  });

  it("an id the table never covered draws no art UNTIL the live route answers, then it does (RED → GREEN of AF632's own mechanism)", async () => {
    configureLiveArtistForTests(stubArtistFetch({ [LIVE_ID]: 'Fixture Artist C' }));
    const source = draftCard('Dragonologist', LIVE_ID);
    const { container } = render(createElement(AbilityChip, { source, name: 'Dragonologist', text: 'look at the top six' }));
    // Before the live route answers: the committed table has already said "no" (it is a real,
    // synchronous, already-loaded table by the time this test runs); no art yet, same contract as
    // "a source with no printed art of its own" — not yet credited is not yet drawn.
    expect(container.querySelector('img.placed__chip-art')).toBeNull();
    await vi.waitFor(() => expect(container.querySelector('.placed__chip-credit')).not.toBeNull());
    expect(container.querySelector('img.placed__chip-art')).not.toBeNull();
    expect(container.querySelector('.placed__chip-credit')!.textContent).toBe('Illus. Fixture Artist C · ™ & © WotC');
  });

  it('the live route 404ing (an id truly nobody credits) leaves the chip exactly as before: no art, no credit, just its name', async () => {
    let settled = false;
    const fetchImpl: Fetch = async (...args) => {
      try {
        return await stubArtistFetch({})(...args);
      } finally {
        settled = true;
      }
    };
    configureLiveArtistForTests(fetchImpl);
    const source = draftCard('Nobody', '00000000-0000-4000-8000-000000000000');
    const { container } = render(createElement(AbilityChip, { source, name: 'Nobody', text: 'does nothing' }));
    await vi.waitFor(() => expect(settled, 'the live route was asked and answered').toBe(true));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.placed__chip-credit')).toBeNull();
    expect(container.querySelector('.placed__chip-name')!.textContent).toBe('Nobody');
  });

  it('a source with no id at all (an emblem, an effect) never asks the live route', () => {
    const fetchImpl = vi.fn(stubArtistFetch({}));
    configureLiveArtistForTests(fetchImpl);
    // No wait needed: a null id never starts an effect that calls out, and React Testing Library's
    // `render` already flushes every effect synchronously (it wraps the mount in `act`).
    const { container } = render(createElement(AbilityChip, { source: null, name: 'Emblem — Elspeth', text: 'creatures you control get +1/+1' }));
    expect(container.querySelector('img')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
