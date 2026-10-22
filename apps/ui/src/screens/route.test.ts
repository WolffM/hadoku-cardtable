/*
 * Hash routing, as pure functions.
 *
 * Everything an invite link can go wrong in happens in a string, so it is
 * tested as a string: no DOM here, no `environment` pragma, node. The DOM half
 * of the shell is `lobby.test.ts`, which drives the real front door.
 *
 * What used to live here as well — minting a pod id, and reading a pasted link
 * back into a route — is gone with wave 23's one front door. The room list is
 * the only way to start a game, the server mints the id, and there is no join
 * box to paste into. The one thing kept from that era is the `#/draft/<id>`
 * route itself, and it is tested here as what it now is: a legacy alias.
 *
 * `.test.ts` and not `.test.tsx` on purpose. The root vitest config globs
 * `apps/*\/src/**\/*.test.ts`, so a `.tsx` test is silently NOT COLLECTED — a
 * green gate that ran nothing. This repo has been bitten by that four times;
 * see `apps/ui/src/components/DraftScreen.test.ts`'s header.
 */

import { describe, expect, it } from 'vitest';

import { canonicalAddress, parseRoute, routeUrl, routeHash, type Route } from './route.ts';

describe('parseRoute', () => {
  it('reads the routes', () => {
    expect(parseRoute('#/')).toEqual({ kind: 'lobby' });
    expect(parseRoute('#/sounds')).toEqual({ kind: 'sounds' });
    expect(parseRoute('#/sounds/sandbox')).toEqual({ kind: 'sounds-sandbox' });
    expect(parseRoute('#/sounds/music')).toEqual({ kind: 'sounds-music' });
    expect(parseRoute('#/sounds/music/')).toEqual({ kind: 'sounds-music' });
    expect(parseRoute('#/ui')).toEqual({ kind: 'ui' });
    expect(parseRoute('#/stats')).toEqual({ kind: 'stats' });
    expect(parseRoute('#/stats/Bella')).toEqual({ kind: 'stats', player: 'Bella' });
    expect(parseRoute('#/tournaments')).toEqual({ kind: 'stats', tournaments: true });
    expect(parseRoute('#/room/r-1a2b3c4d5e6f')).toEqual({ kind: 'room', roomId: 'r-1a2b3c4d5e6f' });
    expect(parseRoute('#/deck/friday-cube')).toEqual({ kind: 'deck', draftId: 'friday-cube' });
    expect(parseRoute('#/decks')).toEqual({ kind: 'decks' });
    expect(parseRoute('#/decks/r-friday')).toEqual({ kind: 'decks', draftId: 'r-friday' });
    expect(parseRoute('#/inventory')).toEqual({ kind: 'inventory' });
  });

  it('is the lobby for an empty, missing or unrecognised hash', () => {
    // A mistyped invite link has to land on the room list, which offers a way
    // in, not on an error page that offers nothing.
    for (const hash of ['', '#', '#/', '//', '#/nonsense', '#/draft', '#/draft/a/b', '#/deck/']) {
      expect(parseRoute(hash), hash).toEqual({ kind: 'lobby' });
    }
  });

  it('tolerates the shapes a person or an app actually produces', () => {
    // No `#`; no leading slash; a trailing slash; percent-encoding.
    expect(parseRoute('/room/x')).toEqual({ kind: 'room', roomId: 'x' });
    expect(parseRoute('room/x')).toEqual({ kind: 'room', roomId: 'x' });
    expect(parseRoute('#/room/x/')).toEqual({ kind: 'room', roomId: 'x' });
    expect(parseRoute('#/deck/friday%20cube')).toEqual({
      kind: 'deck',
      draftId: 'friday cube',
    });
  });

  it('does not throw on a malformed percent-escape', () => {
    // `decodeURIComponent('%zz')` throws. A pasted link is exactly where one
    // comes from, and a crash there takes the whole app down.
    expect(parseRoute('#/room/%zz')).toEqual({ kind: 'room', roomId: '%zz' });
  });

  it('round-trips every route through routeHash', () => {
    const routes: Route[] = [
      { kind: 'lobby' },
      { kind: 'sounds' },
      { kind: 'sounds-sandbox' },
      { kind: 'sounds-music' },
      { kind: 'ui' },
      { kind: 'draft', draftId: 'amber-lantern-k7q4' },
      { kind: 'deck', draftId: 'amber-lantern-k7q4' },
      { kind: 'play' },
      { kind: 'match', matchId: 'm-0123456789ab' },
      { kind: 'room', roomId: 'r-friday-k7q4' },
      // The id that needs encoding on the way out and decoding on the way back.
      { kind: 'room', roomId: 'friday room/2' },
      { kind: 'stats' },
      { kind: 'stats', player: 'Bella Two' },
      { kind: 'stats', tournaments: true },
      { kind: 'decks' },
      { kind: 'decks', draftId: 'r-friday' },
      { kind: 'inventory' },
    ];
    for (const route of routes) {
      expect(parseRoute(routeHash(route)), routeHash(route)).toEqual(route);
    }
  });
});

describe('routeUrl', () => {
  it('builds a room invite link under the /cardtable/ prefix', () => {
    // This is what an invite link IS now: `inviteUrl` and its pod hash are gone,
    // and the room screen is what a friend opens.
    expect(
      routeUrl({ kind: 'room', roomId: 'r-1a2b3c4d5e6f' }, {
        origin: 'https://hadoku.me',
        pathname: '/cardtable/',
      }),
    ).toBe('https://hadoku.me/cardtable/#/room/r-1a2b3c4d5e6f');
  });

  it('makes a match link the same way', () => {
    expect(
      routeUrl({ kind: 'match', matchId: 'm-0123456789ab' }, {
        origin: 'https://hadoku.me',
        pathname: '/cardtable/',
      }),
    ).toBe('https://hadoku.me/cardtable/#/match/m-0123456789ab');
  });

  it('does not compound when the page already has a hash', () => {
    // The bug this exists to prevent: building from `href` yields
    // `…/cardtable/#/room/a#/room/b`, which parses as nothing.
    const url = routeUrl({ kind: 'room', roomId: 'b' }, {
      origin: 'https://hadoku.me',
      pathname: '/cardtable/',
    });
    expect(url.split('#')).toHaveLength(2);
    expect(parseRoute(`#${url.split('#')[1]}`)).toEqual({ kind: 'room', roomId: 'b' });
  });
});

describe('the legacy draft route', () => {
  it('still parses, because links to it are already out there', () => {
    // `App.tsx` redirects it to `#/room/<draftId>` and renders nothing. Deleting
    // the route would make a link somebody was sent land on the lobby with no
    // explanation; keeping it costs one case in each of two switches.
    expect(parseRoute('#/draft/amber-lantern-k7q4')).toEqual({
      kind: 'draft',
      draftId: 'amber-lantern-k7q4',
    });
    expect(parseRoute('#/draft/r-1a2b3c4d5e6f')).toEqual({
      kind: 'draft',
      draftId: 'r-1a2b3c4d5e6f',
    });
  });

  it('carries the id the room route wants, unchanged', () => {
    // The redirect is the whole translation: a draft id and a room id are one
    // id since wave 23. If these two ever disagreed, an old link would open a
    // different room from the one it named.
    const id = 'r-1a2b3c4d5e6f';
    const legacy = parseRoute(`#/draft/${id}`);
    if (legacy.kind !== 'draft') throw new Error('expected the legacy draft route');
    expect(routeHash({ kind: 'room', roomId: legacy.draftId })).toBe(`#/room/${id}`);
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
});

describe('room routes', () => {
  it('reads #/room/<id>, and a room with no id is the lobby', () => {
    expect(parseRoute('#/room/r-friday-k7q4')).toEqual({ kind: 'room', roomId: 'r-friday-k7q4' });
    for (const hash of ['#/room', '#/room/', '#/room/a/b']) {
      expect(parseRoute(hash), hash).toEqual({ kind: 'lobby' });
    }
  });
});

describe('canonicalAddress', () => {
  const at = (pathname: string, hash = '', search = '') => canonicalAddress({ pathname, search, hash }, '/cardtable/');

  it('leaves the app page alone', () => {
    expect(at('/cardtable/')).toBeNull();
    expect(at('/cardtable/', '#/room/r-2d29801ec7ed')).toBeNull();
  });

  it('drops a stray path under a hash, keeping the hash', () => {
    expect(at('/cardtable/sounds/music', '#/room/r-2d29801ec7ed')).toBe('/cardtable/#/room/r-2d29801ec7ed');
  });

  it('moves a stray path that is a route into the hash', () => {
    expect(at('/cardtable/sounds/music')).toBe('/cardtable/#/sounds/music');
    expect(at('/cardtable/sounds/music', '#/')).toBe('/cardtable/#/sounds/music');
    expect(at('/cardtable/room/r-2d29801ec7ed/')).toBe('/cardtable/#/room/r-2d29801ec7ed');
  });

  it('drops a stray path that is no route', () => {
    expect(at('/cardtable/index.html')).toBe('/cardtable/');
    expect(at('/cardtable', '', '?x=1')).toBe('/cardtable/?x=1');
  });
});
