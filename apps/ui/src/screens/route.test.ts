/*
 * Hash routing, as pure functions.
 *
 * Everything an invite link can go wrong in happens in a string, so it is
 * tested as a string: no DOM here, no `environment` pragma, node. The DOM half
 * of the shell is `lobby.test.ts`, which drives the real lobby.
 *
 * `.test.ts` and not `.test.tsx` on purpose. The root vitest config globs
 * `apps/*\/src/**\/*.test.ts`, so a `.tsx` test is silently NOT COLLECTED — a
 * green gate that ran nothing. This repo has been bitten by that four times;
 * see `apps/ui/src/components/DraftScreen.test.ts`'s header.
 */

import { describe, expect, it } from 'vitest';

import {
  draftIdFromInput,
  inviteUrl,
  joinRouteFromInput,
  mintDraftId,
  parseRoute,
  routeUrl,
  routeHash,
  type Route,
} from './route.ts';

describe('parseRoute', () => {
  it('reads the four routes', () => {
    expect(parseRoute('#/')).toEqual({ kind: 'lobby' });
    expect(parseRoute('#/debug')).toEqual({ kind: 'debug' });
    expect(parseRoute('#/draft/friday-cube')).toEqual({ kind: 'draft', draftId: 'friday-cube' });
    expect(parseRoute('#/deck/friday-cube')).toEqual({ kind: 'deck', draftId: 'friday-cube' });
  });

  it('is the lobby for an empty, missing or unrecognised hash', () => {
    // A mistyped invite link has to land on a screen that explains itself and
    // offers a join box, not on an error page that offers nothing.
    for (const hash of ['', '#', '#/', '//', '#/nonsense', '#/draft', '#/draft/a/b', '#/deck/']) {
      expect(parseRoute(hash), hash).toEqual({ kind: 'lobby' });
    }
  });

  it('tolerates the shapes a person or an app actually produces', () => {
    // No `#`; no leading slash; a trailing slash; percent-encoding.
    expect(parseRoute('/draft/x')).toEqual({ kind: 'draft', draftId: 'x' });
    expect(parseRoute('draft/x')).toEqual({ kind: 'draft', draftId: 'x' });
    expect(parseRoute('#/draft/x/')).toEqual({ kind: 'draft', draftId: 'x' });
    expect(parseRoute('#/draft/friday%20cube')).toEqual({
      kind: 'draft',
      draftId: 'friday cube',
    });
  });

  it('does not throw on a malformed percent-escape', () => {
    // `decodeURIComponent('%zz')` throws. A pasted link is exactly where one
    // comes from, and a crash there takes the whole app down.
    expect(parseRoute('#/draft/%zz')).toEqual({ kind: 'draft', draftId: '%zz' });
  });

  it('round-trips every route through routeHash', () => {
    const routes: Route[] = [
      { kind: 'lobby' },
      { kind: 'debug' },
      { kind: 'draft', draftId: 'amber-lantern-k7q4' },
      { kind: 'deck', draftId: 'amber-lantern-k7q4' },
      { kind: 'play' },
      { kind: 'match', matchId: 'm-0123456789ab' },
      // The id that needs encoding on the way out and decoding on the way back.
      { kind: 'draft', draftId: 'friday cube/2' },
    ];
    for (const route of routes) {
      expect(parseRoute(routeHash(route)), routeHash(route)).toEqual(route);
    }
  });
});

describe('inviteUrl', () => {
  it('carries the /cardtable/ prefix the app is deployed under', () => {
    expect(
      inviteUrl('amber-lantern-k7q4', {
        origin: 'https://hadoku.me',
        pathname: '/cardtable/',
      }),
    ).toBe('https://hadoku.me/cardtable/#/draft/amber-lantern-k7q4');
  });

  it('does not compound when the page already has a hash', () => {
    // The bug this exists to prevent: building from `href` yields
    // `…/cardtable/#/draft/a#/draft/b`, which parses as nothing.
    const url = inviteUrl('b', { origin: 'https://hadoku.me', pathname: '/cardtable/' });
    expect(url.split('#')).toHaveLength(2);
    expect(parseRoute(`#${url.split('#')[1]}`)).toEqual({ kind: 'draft', draftId: 'b' });
  });
});

describe('draftIdFromInput', () => {
  it('accepts the three things a person pastes', () => {
    expect(draftIdFromInput('https://hadoku.me/cardtable/#/draft/amber-lantern-k7q4')).toBe(
      'amber-lantern-k7q4',
    );
    expect(draftIdFromInput('#/draft/amber-lantern-k7q4')).toBe('amber-lantern-k7q4');
    expect(draftIdFromInput('  amber-lantern-k7q4  ')).toBe('amber-lantern-k7q4');
  });

  it('reads a deck link as its pod, because that is the pod they mean', () => {
    expect(draftIdFromInput('https://hadoku.me/cardtable/#/deck/amber-lantern-k7q4')).toBe(
      'amber-lantern-k7q4',
    );
  });

  it('refuses what is not a pod rather than opening an empty one', () => {
    // Joining a mangled id silently opens a NEW pod nobody else is in, which
    // looks like "my friends never showed up" and is unfalsifiable from inside.
    for (const junk of [
      '',
      '   ',
      'https://hadoku.me/cardtable/',
      '#/debug',
      '#/',
      'two words',
      'a/b',
    ]) {
      expect(draftIdFromInput(junk), JSON.stringify(junk)).toBeNull();
    }
  });
});

describe('mintDraftId', () => {
  it('is adjective-noun-suffix, lowercase, with no vowels in the suffix', () => {
    const id = mintDraftId(pinned([0, 0, 0, 0, 0, 0]));
    expect(id).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{4}$/);
    expect(id.split('-')[2]).not.toMatch(/[aeiou]/);
  });

  it('is a function of its randomness, so the shape is asserted and not sampled', () => {
    const draw = [0, 0, 0, 0, 0, 0];
    expect(mintDraftId(pinned(draw))).toBe(mintDraftId(pinned(draw)));
    expect(mintDraftId(pinned([0, 0, 0, 0, 0, 0]))).not.toBe(
      mintDraftId(pinned([0.5, 0.5, 0.5, 0.5, 0.5, 0.5])),
    );
  });

  it('stays in range at the top of the interval', () => {
    // `Math.floor(0.999… * n)` is fine, but a `rand` that ever returns exactly
    // 1 would index off the end and produce `undefined-undefined-`.
    const id = mintDraftId(() => 1);
    expect(id).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{4}$/);
    expect(id).not.toContain('undefined');
  });

  it('survives the round trip through a link', () => {
    const id = mintDraftId(pinned([0.3, 0.7, 0.1, 0.9, 0.4, 0.6]));
    const url = inviteUrl(id, { origin: 'https://hadoku.me', pathname: '/cardtable/' });
    expect(draftIdFromInput(url)).toBe(id);
  });
});

describe('constructed routes', () => {
  it('reads #/play and #/match/<id>', () => {
    expect(parseRoute('#/play')).toEqual({ kind: 'play' });
    expect(parseRoute('#/match/m-0123456789ab')).toEqual({ kind: 'match', matchId: 'm-0123456789ab' });
    for (const hash of ['#/match', '#/match/', '#/play/x', '#/match/a/b']) {
      expect(parseRoute(hash), hash).toEqual({ kind: 'lobby' });
    }
  });

  it('makes a match link under the /cardtable/ prefix', () => {
    expect(routeUrl({ kind: 'match', matchId: 'm-0123456789ab' }, { origin: 'https://hadoku.me', pathname: '/cardtable/' })).toBe(
      'https://hadoku.me/cardtable/#/match/m-0123456789ab',
    );
  });
});

describe('joinRouteFromInput', () => {
  it('takes a pod link, a match link, a pod id or a match id', () => {
    expect(joinRouteFromInput('https://hadoku.me/cardtable/#/draft/amber-lantern-k7q4')).toEqual({
      kind: 'draft',
      draftId: 'amber-lantern-k7q4',
    });
    expect(joinRouteFromInput('https://hadoku.me/cardtable/#/match/m-0123456789ab')).toEqual({
      kind: 'match',
      matchId: 'm-0123456789ab',
    });
    expect(joinRouteFromInput('amber-lantern-k7q4')).toEqual({ kind: 'draft', draftId: 'amber-lantern-k7q4' });
    expect(joinRouteFromInput(' m-0123456789ab ')).toEqual({ kind: 'match', matchId: 'm-0123456789ab' });
  });

  it('refuses what is neither', () => {
    for (const input of ['', '   ', 'two words', 'https://hadoku.me/cardtable/#/play', 'a/b']) {
      expect(joinRouteFromInput(input), input).toBeNull();
    }
  });
});

/** A `rand` that hands out a fixed sequence, then repeats it. */
function pinned(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}
