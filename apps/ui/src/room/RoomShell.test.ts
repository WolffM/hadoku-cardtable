// @vitest-environment jsdom
/*
 * The room wrapper's refusals, and the one thing it must NOT refuse.
 *
 * The interesting cases are all the ones where the room does NOT appear: a
 * table that will not draw because chat is unavailable is an outage, and a
 * room key we guessed is two unrelated groups sharing a chat.
 *
 * The exception is the theme (w22 §G). There, dropping a value is the bug:
 * `RoomChrome` reads a falsy `theme` prop as "consult my own store, then
 * hard-code `dark`", so a name we refuse to forward becomes an actively wrong
 * `dark` chrome beside a light page — the split-theme bug the operator
 * reported. See `RoomShell.tsx`'s comment on `watchpartyTheme` for the shipped
 * `Do()` that makes that true.
 *
 * `.test.ts`, not `.test.tsx`, and `createElement` instead of JSX — the root
 * vitest config globs `apps/*\/src/**\/*.test.ts` and a `.tsx` test is not
 * collected (see `chrome/theme-agreement.test.ts` and `screens/lobby.test.ts`,
 * which explain the same constraint). jsdom, because the second theme arm
 * renders.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, useLayoutEffect, useRef, type ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

/*
 * A theme name this install's `Theme` union does not contain.
 *
 * The scenario it stands in for is real and not hypothetical: `watchparty-ui`
 * takes `@wolffm/themes` as a plain dependency (`^5.8.5`), not a peer, so a
 * host outside that range resolves a second nested copy and two distinct
 * unions exist. `THEMES` is asserted below rather than eyeballed, so this stays
 * honest if a future `@wolffm/themes` ships an `aurora` family.
 *
 * `vi.hoisted`, because `vi.mock` factories are hoisted above every import and
 * a plain `const` would be out of scope inside one.
 */
const { UNKNOWN_THEME, viewer } = vi.hoisted(() => ({
  UNKNOWN_THEME: 'aurora-dusk',
  /** The tier whoami answers with; a spec sets it before rendering. */
  viewer: { tier: 'friend' as 'friend' | 'member' },
}));

vi.mock('@wolffm/prefs-client', () => ({
  whoami: () =>
    Promise.resolve({ userId: 'u-test', userType: viewer.tier, name: 'Test Friend' }),
}));

vi.mock('@wolffm/watchparty-ui/room-chrome.css', () => ({}));

vi.mock('@wolffm/watchparty-ui/room-chrome', () => ({
  /*
   * Stands in for the real component, reproducing its shipped fallback rather
   * than testing watchparty's code: a truthy `theme` prop is honoured
   * VERBATIM and unvalidated, and only a FALSY one reaches the
   * store-then-`dark` path. `theme || 'dark'` is that branch exactly;
   * `theme ?? 'dark'` would not be, because it would let `''` through as a
   * theme the real chrome would reject.
   */
  RoomChrome: ({
    theme,
    userType,
    serverOrigin,
    roomOrigin,
    children,
  }: {
    theme?: string;
    userType?: string;
    serverOrigin?: string;
    roomOrigin?: string;
    children: ReactNode;
  }) =>
    // The real chrome's own content column, so the host's rules for its child are tested against it.
    createElement(
      'div',
      { 'data-testid': 'room-chrome', 'data-theme': theme || 'dark', 'data-user-type': userType, 'data-server-origin': serverOrigin, 'data-room-origin': roomOrigin },
      createElement('div', { className: 'wp-room-chrome-frame__content' }, children),
    ),
}));

/*
 * The page's theme, forced to a name outside the union. Spreads the real module
 * so `THEMES` below is the shipped list and not a fixture — the assertion that
 * `UNKNOWN_THEME` is genuinely unknown has to be made against the real union to
 * mean anything.
 */
vi.mock('@wolffm/themes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wolffm/themes')>()),
  useHadokuTheme: () => ({ theme: UNKNOWN_THEME }),
}));

// The vi.mock calls above are hoisted above these imports by vitest's
// transform, so the mocked modules are in place before RoomShell loads them.
import { THEMES } from '@wolffm/themes';

import { RoomShell, cardtableOrigin, roomKeyFor, watchpartyTheme } from '@hadoku/game-ui/room/RoomShell.tsx';
import { roomIdFor } from '../App.tsx';
import { parseRoute } from '@hadoku/game-ui/screens/route.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  viewer.tier = 'friend';
});

/*
 * The room is cardtable's: the chrome's whole room socket goes to `roomOrigin`, this app's own
 * origin, and only the characters' art still comes from watchparty's `serverOrigin`.
 */
describe('roomOrigin (the room served by cardtable)', () => {
  it('passes this app’s own origin as the room’s, never watchparty’s', async () => {
    render(createElement(RoomShell, { roomId: 'm-test', children: createElement('div', null, 'content') }));
    const chrome = await waitFor(() => screen.getByTestId('room-chrome'));
    const { serverOrigin, roomOrigin } = chrome.dataset;
    expect(roomOrigin).toBe(cardtableOrigin());
    expect(roomOrigin).not.toBe(serverOrigin);
    expect(roomOrigin).not.toMatch(/\/watchparty$/);
  });
});

describe('the viewer\'s tier', () => {
  /*
   * The chrome reads `public` as signed out: no display name for chat (`Md()` in
   * `dist/chunks/index-*.js`, 0.45.13) and a sign-in redirect on hadoku.me. A
   * member is signed in, so the chrome must hear `member`, which it ranks itself.
   */
  it('reaches the chrome as the tier whoami answered, a member included', async () => {
    viewer.tier = 'member';
    render(createElement(RoomShell, { roomId: 'm-test', children: createElement('div', null, 'content') }));
    await waitFor(() => expect(screen.getByTestId('room-chrome').dataset.userType).toBe('member'));
  });
});

/*
 * Wave 89 §B: the portrait chat-sheet CSS in `live.css` keys off `data-collapsible` on
 * `.room-shell`, this component's own wrapper — not off the `collapsible` prop itself, which
 * `RoomChrome` reads but a stylesheet in another file cannot see. Present only when `collapsible`
 * is true (a match route), absent for the room lobby (`collapsible={false}`), so Settled 10 ("the
 * room lobby is unchanged") holds without this file knowing what route it is.
 */
describe('the portrait chat-sheet attribute (wave 89 §B)', () => {
  it('carries data-collapsible when collapsible (the default, a match route)', async () => {
    render(createElement(RoomShell, { roomId: 'm-test', children: createElement('div', null, 'content') }));
    await waitFor(() => screen.getByTestId('room-chrome'));
    expect(screen.getByTestId('room-shell').dataset.collapsible).toBe('');
  });

  it('carries no data-collapsible when collapsible is false (the room lobby)', async () => {
    render(createElement(RoomShell, { roomId: 'm-test', collapsible: false, children: createElement('div', null, 'content') }));
    await waitFor(() => screen.getByTestId('room-chrome'));
    expect(screen.getByTestId('room-shell').dataset.collapsible).toBeUndefined();
  });
});

describe('the room key for a pod or match', () => {
  it('prefixes ids watchparty will accept without provisioning', () => {
    expect(roomKeyFor('m-090bf01ba811')).toBe('cardtable-m-090bf01ba811');
    expect(roomKeyFor('e2e-two-friends')).toBe('cardtable-e2e-two-friends');
  });

  it('refuses rather than coerces, so two ids cannot collapse into one room', () => {
    // Uppercase is the live hazard: lowercasing "AB" and "ab" would put two
    // unrelated groups in one room, each reading the other's chat.
    expect(roomKeyFor('M-090BF01BA811')).toBeNull();
    expect(roomKeyFor('pod_1')).toBeNull();
    expect(roomKeyFor('pod 1')).toBeNull();
    expect(roomKeyFor('')).toBeNull();
  });

  it('refuses an id past watchparty\'s 40-character bound', () => {
    expect(roomKeyFor('a'.repeat(40))).toBe(`cardtable-${'a'.repeat(40)}`);
    expect(roomKeyFor('a'.repeat(41))).toBeNull();
  });
});

describe('the content of a room', () => {
  it('mounts once, inside the chrome — never alone first and again when whoami answers', async () => {
    // Recorded at commit (a layout effect), so by the time the chrome is in the
    // DOM every mount that has happened is counted — a content drawn alone first
    // and again inside the chrome reads two, the first of them outside.
    const mounts: boolean[] = [];
    function Content() {
      const ref = useRef<HTMLDivElement>(null);
      useLayoutEffect(() => {
        mounts.push(ref.current?.closest('[data-testid="room-chrome"]') != null);
      }, []);
      return createElement('div', { ref, 'data-testid': 'content' });
    }

    render(createElement(RoomShell, { roomId: 'm-test', children: createElement(Content) }));
    await waitFor(() => screen.getByTestId('room-chrome'));

    expect(mounts).toEqual([true]);
  });

  // CI 42455075250 (w83b): a joiner's room screen is drawn before its join, with no chat
  // (`App.tsx` gates the room id on `useJoined`), and the chrome wraps it once the join lands.
  // Remounted there, it dropped bob's open Room settings and connected its draft socket twice.
  it('stays mounted when the chrome wraps it after the join, and when it goes again', async () => {
    let mounts = 0;
    let unmounts = 0;
    function Content() {
      useLayoutEffect(() => {
        mounts += 1;
        return () => {
          unmounts += 1;
        };
      }, []);
      return createElement('div', { 'data-testid': 'content' });
    }
    const content = createElement(Content);

    const view = render(createElement(RoomShell, { roomId: null, children: content }));
    expect(screen.getByTestId('content')).toBeTruthy();
    view.rerender(createElement(RoomShell, { roomId: 'r-cube', children: content }));
    await waitFor(() => expect(screen.getByTestId('room-chrome').contains(screen.getByTestId('content'))).toBe(true));
    view.rerender(createElement(RoomShell, { roomId: null, children: content }));
    expect(screen.queryByTestId('room-chrome')).toBeNull();
    expect(screen.getByTestId('content')).toBeTruthy();

    expect({ mounts, unmounts }).toEqual({ mounts: 1, unmounts: 0 });
  });

  // Main check 42457465625: the portal's two nodes sat between the chrome and the screen, so
  // `chrome.css`'s rules for a content's own child stopped reaching it — a phone's Gauntlet board
  // kept the shell's padding and clipped its pool names. Every such rule is read from the sheet.
  it('is still what the chrome styles as its content’s own child, bare and inside the chrome', async () => {
    const sheet = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packages/ui-shell/src/chrome/chrome.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const childRules = [...sheet.matchAll(/([^{}]+)\{/g)]
      .map((m) => m[1]!.trim())
      .filter((list) => /(?:cardtable-chrome|wp-room-chrome-frame)__content > (?:\*|\.shell)/.test(list) && !list.startsWith('@'));
    expect(childRules.length, 'the sheet still has its content-child rules').toBeGreaterThanOrEqual(3);
    const screenEl = createElement('div', { className: 'shell shell--fit', 'data-testid': 'fit-screen' });

    const outer = document.createElement('div');
    outer.className = 'cardtable-chrome__content';
    document.body.append(outer);
    const view = render(createElement(RoomShell, { roomId: null, children: screenEl }), { container: outer });
    const bare = screen.getByTestId('fit-screen');
    for (const list of childRules.filter((l) => l.includes('cardtable-chrome__content'))) expect(bare.matches(list), `bare: ${list}`).toBe(true);

    view.rerender(createElement(RoomShell, { roomId: 'r-cube', children: screenEl }));
    await waitFor(() => expect(screen.getByTestId('room-chrome').contains(bare)).toBe(true));
    expect(screen.getByTestId('fit-screen'), 'the same element').toBe(bare);
    for (const list of childRules.filter((l) => l.includes('wp-room-chrome-frame__content'))) expect(bare.matches(list), `in the chrome: ${list}`).toBe(true);
    outer.remove();
  });
});

/*
 * The runtime half of w22 §G. The compile-time half is `watchpartyTheme`'s
 * `Theme` return type, with no `| undefined`: a re-added `?? undefined` body
 * stops typechecking. But `Theme` is erased at runtime, so nothing in the types
 * says the function does not *also* drop the value some other way — a re-added
 * `THEMES.includes(...)` filter that returned `'dark'` instead of `undefined`
 * would compile happily and reinstate the bug. These two assert the behaviour.
 *
 * Why the neighbouring `chrome/theme-agreement.test.ts` does not cover this:
 * it pins the page theme at `'light'`, which IS in `THEMES`, so the old filter
 * returned `'light'` too. That file is green either way and pins w20 §E, not
 * this.
 */
describe('a host theme outside the chrome union still reaches the chrome', () => {
  it('returns an unrecognised theme name rather than dropping it', () => {
    // The premise, asserted rather than assumed: this name really is outside
    // the union `watchpartyTheme` claims to return.
    expect(THEMES as readonly string[]).not.toContain(UNKNOWN_THEME);

    const passed = watchpartyTheme(UNKNOWN_THEME);

    expect(passed).toBe(UNKNOWN_THEME);
    // Named separately because `undefined` is the one value that cannot be
    // ignored downstream: it is what sends the chrome to its own `dark`.
    expect(passed).not.toBeUndefined();
    // And not silently substituted either — a filter that fell back to a
    // *valid* theme would satisfy the type and still be the bug.
    expect(THEMES as readonly string[]).not.toContain(passed);
  });

  it('renders the chrome with that name on data-theme, not its own dark default', async () => {
    render(
      createElement(RoomShell, {
        roomId: 'm-test',
        children: createElement('div', null, 'content'),
      }),
    );

    // whoami is a promise, so the chrome appears on a later tick.
    const roomChrome = await waitFor(() => screen.getByTestId('room-chrome'));

    expect(roomChrome.getAttribute('data-theme')).toBe(UNKNOWN_THEME);
    // Spelled out because `dark` is the specific wrong answer the shipped
    // chrome produces for a falsy prop, and the split-theme bug the operator
    // saw was exactly a `dark` chrome beside a light page.
    expect(roomChrome.getAttribute('data-theme')).not.toBe('dark');
  });
});

/*
 * Wave 71 §G: the room this screen puts the chat in, for a `#/match/<id>`
 * route. `App.tsx`'s own `roomIdFor` is the function `RoomShell`'s `roomId`
 * prop is built from; testing it here rather than rendering
 * the whole app keeps this a pure-function test.
 *
 * `matchRoom` is `App.tsx`'s own name for the match's resolved room
 * (`useMatchRoomId`, built on `roomsClient().roomOfMatch`) — the second
 * argument stands in for it, exactly as `App` would pass it once that fetch
 * answers.
 *
 * Wave 72 §R: `useMatchRoomId` answers `null` for two different reasons (not
 * yet answered, and answered "no room"), and `roomIdFor` used to pass that
 * bare `null` straight to `RoomShell` either way. That let a match's chrome
 * flip on AFTER the board's first layout once the real room resolved — the
 * board drawn once at full width, then again narrowed — and left a
 * genuinely roomless match (a scenario, a direct vs-AI game) with no chat at
 * all, where before §G it kept its own. Falling back to the route's own
 * `matchId` fixes both: the chrome's presence is decided on the first
 * render, and a roomless match still gets a chat, its own.
 */
describe('the room a match route puts the chat in', () => {
  it('is the match’s OWN room, not a room keyed by the match id', () => {
    const route = parseRoute('#/match/m-090bf01ba811');
    expect(route).toEqual({ kind: 'match', matchId: 'm-090bf01ba811' });

    // The match's room, as `roomOfMatch` answered it — a DIFFERENT id from
    // the match's own. Reverting wave 71 §G's step 1 (`return route.matchId`
    // for the `match` case) makes this assertion fail: the function would
    // answer the match id instead of the room id below.
    expect(roomIdFor(route, 'r-cube-night')).toBe('r-cube-night');
  });

  it('falls back to the match’s OWN key while unresolved, and permanently for a match with no room — never a bare null (wave 72 §R)', () => {
    const route = parseRoute('#/match/m-090bf01ba811');
    // `null` stands for BOTH "not answered yet" and "answered: no room" —
    // `useMatchRoomId` never tells them apart — and both fall back the same
    // way: to the match's own id, which `roomKeyFor` turns into the match's
    // own `cardtable-m-<id>` chat, exactly as it did before wave 71 §G.
    // Reverting this fallback (`return matchRoomId;`) makes this fail: the
    // function would answer `null` instead.
    expect(roomIdFor(route, null)).toBe('m-090bf01ba811');
    expect(roomKeyFor(roomIdFor(route, null)!)).toBe('cardtable-m-090bf01ba811');
  });

  it('every other route is unchanged by the new parameter', () => {
    const ignored = 'r-should-be-ignored';
    expect(roomIdFor(parseRoute('#/room/r-cube-night'), null)).toBe('r-cube-night');
    expect(roomIdFor(parseRoute('#/draft/pod-1'), ignored)).toBe('pod-1');
    expect(roomIdFor(parseRoute('#/deck/pod-1'), ignored)).toBe('pod-1');
    expect(roomIdFor(parseRoute('#/'), ignored)).toBeNull();
  });
});

// The operator, 2026-11-11: "lets persist the chat between lobby and game. rooms should maintain their chat"
describe('a room’s chat', () => {
  it('is one key from the lobby through every game at every table', () => {
    const lobby = roomIdFor(parseRoute('#/room/r-cube-night'), null);
    expect(roomIdFor(parseRoute('#/match/m-000000000001'), 'r-cube-night')).toBe(lobby);
    expect(roomIdFor(parseRoute('#/match/m-000000000002'), 'r-cube-night')).toBe(lobby);
    expect(roomKeyFor(lobby!)).toBe('cardtable-r-cube-night');
  });
});
