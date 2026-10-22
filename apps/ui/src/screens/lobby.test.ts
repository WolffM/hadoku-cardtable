// @vitest-environment jsdom
/*
 * The front door, driven rather than described.
 *
 * The bar since wave 23 is: *there is exactly one way to start a game, and a
 * link somebody was already sent still works.* This mounts the real `App` at
 * the real front door and asserts what is there (the room list) and what is not
 * (the draft-pods section, "Start a pod", the join box, the pick-both-decks
 * screen) — so the deletion cannot be quietly undone by a later wave without a
 * red test.
 *
 * ## What moved out of this file, and where it went
 *
 * This used to drive a whole pod through a stub socket: click "Start a pod",
 * read the invite link off the screen, paste it into a second mount, assert both
 * browsers joined the same draft. None of those controls exist now. A draft is a
 * room, so that behaviour is `screens/constructed.test.ts` (the room screen's
 * two phases) and `e2e/draft.spec.ts` (two friends drafting, from the room list
 * alone, against a real server). Do not rebuild it here: this file's subject is
 * the door, not what is behind it.
 *
 * `.test.ts`, not `.test.tsx`, and `createElement` instead of JSX: the root
 * vitest config globs `apps/*\/src/**\/*.test.ts` and a `.tsx` test is not
 * collected. The `@vitest-environment jsdom` pragma has to be line 1 of the
 * file or `environment` stays `node` and every DOM call throws.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';

import { App } from '../App.tsx';
import { parseRoute } from './route.ts';
import type { DraftTransport } from '../draft/socket.ts';

/*
 * A transport that does nothing.
 *
 * Not a test double for a draft — this file no longer drives one — but the App's
 * default `makeTransport` opens a real same-origin socket.io connection, and a
 * jsdom test must never do that. Passing this keeps the room screen inert and
 * leaves no open handle.
 */
const inert = (): DraftTransport => ({
  on() {},
  emit() {},
  disconnect() {},
});

/*
 * jsdom does not implement `Element.prototype.scrollTo` at all — not a stub, the
 * method is simply absent. Nothing here calls it; watchparty's `ChatLog` does
 * (`@wolffm/watchparty-ui/src/components/ChatLog.tsx:33`), in a mount effect, and
 * a room route mounts `RoomChrome`: `whoami()` answers a 404 with an ANON
 * identity rather than a failure (`@wolffm/prefs-client` `fetchWhoamiRaw`
 * returns null on `!resp.ok` and `adaptWhoami` turns that into anon), so
 * `RoomShell`'s "no identity, no chrome" guard does not fire under a stub fetch.
 *
 * The throw lands outside React's error boundary as an unhandled exception, so
 * every test still PASSES and vitest still exits 1. One jsdom gap, filled here
 * rather than worked around by not testing the redirect.
 */
globalThis.Element.prototype.scrollTo ??= function scrollTo() {};

function open(hash = '') {
  globalThis.location.hash = hash;
  return render(createElement(App, { transport: inert }));
}

/*
 * The front page asks the server for its rooms. This answers the way
 * `GET /api/rooms` does, with one room, and answers everything else (whoami
 * included) 404 — which is what keeps `RoomShell` from mounting a chrome here.
 *
 * `ready` and `draftStartedAt` are the fields wave 23 added; a room in its
 * lobby phase carries them as `false` and `null`.
 */
const ONE_ROOM = {
  id: 'r-friday',
  name: 'Friday night',
  creator: 'http-a',
  leader: 'http-a',
  gameType: 'constructed-1v1',
  locked: false,
  members: [{ id: 'http-a', name: 'alice', joinedAt: '2026-09-19T00:00:00.000Z', ready: false }],
  matchId: null,
  draftStartedAt: null,
  createdAt: '2026-09-19T00:00:00.000Z',
};

beforeEach(() => {
  globalThis.location.hash = '';
  vi.stubGlobal('fetch', async (url: string) =>
    String(url).endsWith('/api/rooms')
      ? new Response(JSON.stringify({ rooms: [ONE_ROOM] }), { status: 200 })
      : new Response('{}', { status: 404 }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  globalThis.location.hash = '';
});

/* ── one door ────────────────────────────────────────────────────────── */

describe('the front door', () => {
  it('is the lobby, not a draft', () => {
    open();
    expect(screen.getByTestId('lobby')).toBeTruthy();
    expect(screen.queryByTestId('pack')).toBeNull();
  });

  it('is the room list, and nothing else', async () => {
    open();
    const rooms = screen.getByTestId('rooms');
    await waitFor(() => expect(within(rooms).getAllByTestId('room-row')).toHaveLength(1));
    expect(within(rooms).getByTestId('room-name').textContent).toBe('Friday night');
    expect(within(rooms).getByTestId('room-create-open')).toBeTruthy();
    expect(within(rooms).queryByTestId('room-create'), 'the form waits behind its button').toBeNull();
    // `ONE_ROOM` carries no `clientMode` — the shape a server older than the
    // field sends. It reads as our table, so it carries no streamed label.
    expect(within(rooms).queryByTestId('room-mode')).toBeNull();
    // The pick-both-decks screen the operator rejected has no way in from here.
    expect(screen.queryByTestId('play-constructed')).toBeNull();
  });

  it('offers no second way to start a game', () => {
    // The operator, on finding two doors to one idea: *"why do we have 'start a
    // pod' as a button but we also have 'game type' selector at the top? …
    // only one entrypoint."* A draft is a room now, so the create form's
    // `draft` game type is the only way to start one, and every control the
    // pod section had is gone rather than hidden.
    open();
    expect(screen.queryByTestId('draft-pods')).toBeNull();
    expect(screen.queryByTestId('start-pod')).toBeNull();
    expect(screen.queryByTestId('join-id')).toBeNull();
    expect(screen.queryByTestId('join-error')).toBeNull();
    expect(screen.queryByText('Join a pod or a match')).toBeNull();
  });

  it('shows the lobby for an invite link that was mangled in transit', () => {
    open('#/draft');
    expect(screen.getByTestId('lobby')).toBeTruthy();
  });

  it('shows the lobby where the developer harness was', () => {
    open('#/debug');
    expect(screen.getByTestId('lobby')).toBeTruthy();
  });
});

/* ── the link somebody was already sent ──────────────────────────────── */

describe('a legacy pod link', () => {
  it('redirects #/draft/<id> to that room and renders no pod of its own', async () => {
    // Those links are in people's chat windows. A draft id and a room id are
    // one id now, so the redirect is the whole translation — and if the id
    // never was a room, the room screen's own "no such room" is the answer,
    // which is honest about a pod that lived in a dead server's memory.
    open('#/draft/amber-lantern-k7q4');

    await waitFor(() =>
      expect(parseRoute(globalThis.location.hash)).toEqual({
        kind: 'room',
        roomId: 'amber-lantern-k7q4',
      }),
    );
    expect(screen.queryByTestId('lobby')).toBeNull();
    // Nothing of the old pod screen is reachable by that route any more; the
    // pod is content the room renders once its draft has started.
    expect(screen.queryByTestId('start-pod')).toBeNull();
    expect(screen.queryByTestId('join-id')).toBeNull();
  });

  it('keeps a deck link on the deck, not redirected anywhere', () => {
    // `#/deck/<draftId>` is NOT legacy — the deck builder is still reached by
    // that hash from a finished draft, and redirecting it would strand the
    // pool somebody just drafted.
    open('#/deck/amber-lantern-k7q4');
    expect(parseRoute(globalThis.location.hash)).toEqual({
      kind: 'deck',
      draftId: 'amber-lantern-k7q4',
    });
  });
});
