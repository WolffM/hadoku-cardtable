// @vitest-environment jsdom
/*
 * §A's done-when, driven rather than described.
 *
 * The bar is: *a person who has never seen this app can start a pod, send a
 * link, and reach a draft.* A screenshot proves that once. This mounts the real
 * `App` at the real front door, clicks the real "Start a pod" button, takes the
 * invite link off the screen the way a person would, opens THAT LINK in a
 * second mount, and asserts both browsers joined the same pod and both render
 * the draft — which proves it every time anyone runs `pnpm check`.
 *
 * The socket is a stub, the same three-method stub `socket.test.ts` uses, so
 * this needs no server and leaves no open handle. What it cannot prove is that
 * a real server answers a join with a snapshot; that is the "two browsers, one
 * pod" item the board has carried since Wave 5, and it needs two
 * friend-authenticated browser sessions, not a test runner.
 *
 * The payload is the COMMITTED fixture. Inventing one here would test the shell
 * against a shape nothing else in the repo agrees with.
 *
 * `.test.ts`, not `.test.tsx`, and `createElement` instead of JSX: the root
 * vitest config globs `apps/*\/src/**\/*.test.ts` and a `.tsx` test is not
 * collected. The `@vitest-environment jsdom` pragma has to be line 1 of the
 * file or `environment` stays `node` and every DOM call throws.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DRAFT_CHANNEL, safeParseClientMessage, stateMessage, type ClientMessage } from '@hadoku/shared';

import { App } from '../App.tsx';
import { loadFixtures } from '../draft/fixtures.ts';
import { parseRoute } from './route.ts';
import type { DraftTransport } from '../draft/socket.ts';

/* ── the stub socket ─────────────────────────────────────────────────── */

interface Stub {
  make: () => DraftTransport;
  sent: { event: string; message: unknown }[];
  /** Deliver an event to every driver that subscribed, as socket.io would. */
  fire(event: string, payload?: unknown): void;
}

function makeStub(): Stub {
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  const stub: Stub = {
    sent: [],
    fire(event, payload) {
      act(() => {
        for (const h of handlers.get(event) ?? []) h(payload);
      });
    },
    make: () => ({
      on(event, handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      emit(event, message) {
        stub.sent.push({ event, message });
      },
      disconnect() {},
    }),
  };
  return stub;
}

/** Every message the client put on the wire, parsed — our own junk counts too. */
function outbound(stub: Stub): ClientMessage[] {
  return stub.sent.map((s) => {
    expect(s.event).toBe(DRAFT_CHANNEL.clientToServer);
    const parsed = safeParseClientMessage(s.message);
    if (!parsed.ok) {
      throw new Error(
        `the shell emitted something that is not a ClientMessage:\n` +
          parsed.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n'),
      );
    }
    return parsed.value;
  });
}

const joinedIds = (stub: Stub): string[] =>
  outbound(stub)
    .filter((m) => m.type === 'join')
    .map((m) => m.draftId);

/* ── the payload a server would answer a join with ───────────────────── */

const OPENING = loadFixtures()[0];

const openPod = (stub: Stub): void => {
  stub.fire(DRAFT_CHANNEL.serverToClient, stateMessage(OPENING, { name: 'Test Cube', size: 540 }));
};

/* ── mounting ────────────────────────────────────────────────────────── */

function open(stub: Stub, hash = '') {
  globalThis.location.hash = hash;
  return render(createElement(App, { transport: stub.make }));
}

beforeEach(() => {
  globalThis.location.hash = '';
});
afterEach(cleanup);

/* ── the lobby ───────────────────────────────────────────────────────── */

describe('the front door', () => {
  it('is the lobby, not the developer harness', () => {
    const stub = makeStub();
    open(stub);
    expect(screen.getByTestId('lobby')).toBeTruthy();
    expect(screen.getByTestId('start-pod')).toBeTruthy();
    // The harness is still in the build; it is just no longer what you meet.
    expect(screen.queryByText('Fixtures — five committed payloads')).toBeNull();
    expect(screen.queryByTestId('pack')).toBeNull();
  });

  it('still has the harness, one hash away', () => {
    const stub = makeStub();
    open(stub, '#/debug');
    expect(screen.getByText('Fixtures — five committed payloads')).toBeTruthy();
    expect(screen.queryByTestId('lobby')).toBeNull();
  });

  it('shows the lobby for an invite link that was mangled in transit', () => {
    const stub = makeStub();
    open(stub, '#/draft');
    expect(screen.getByTestId('lobby')).toBeTruthy();
  });
});

/* ── start a pod ─────────────────────────────────────────────────────── */

describe('starting a pod', () => {
  it('mints an id, joins it, and lands in that pod', () => {
    const stub = makeStub();
    open(stub);

    fireEvent.click(screen.getByTestId('start-pod'));

    const route = parseRoute(globalThis.location.hash);
    expect(route.kind).toBe('draft');
    if (route.kind !== 'draft') throw new Error('unreachable');
    expect(route.draftId).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{4}$/);

    expect(screen.getByTestId('pod')).toBeTruthy();
    // "Start a pod" IS "mint an id and join it" — there is no create call.
    // `apps/server/src/room/socket.ts` opens the room on join.
    expect(joinedIds(stub)).toEqual([route.draftId]);
  });

  it('shows the link to send before the server has answered anything', () => {
    const stub = makeStub();
    open(stub);
    fireEvent.click(screen.getByTestId('start-pod'));

    // No snapshot has arrived, and the invite is already usable: the pod exists
    // the moment the server sees the join, so waiting to show the link would
    // only delay the friends.
    expect(screen.getByTestId('pod-waiting')).toBeTruthy();

    const url = (screen.getByTestId('invite-url') as HTMLInputElement).value;
    const route = parseRoute(globalThis.location.hash);
    if (route.kind !== 'draft') throw new Error('expected a draft route');
    expect(url).toBe(`${globalThis.location.origin}${globalThis.location.pathname}#/draft/${route.draftId}`);
    expect(url.startsWith('http')).toBe(true);
  });

  it('renders the draft once the server answers', () => {
    const stub = makeStub();
    open(stub);
    fireEvent.click(screen.getByTestId('start-pod'));
    openPod(stub);

    expect(within(screen.getByTestId('pack')).queryAllByTestId('card')).toHaveLength(15);
  });

  it('reports who is at the table from the server snapshot, not from a guess', () => {
    const stub = makeStub();
    open(stub);
    fireEvent.click(screen.getByTestId('start-pod'));

    // Before the snapshot there is nothing the server has confirmed, and the
    // bar says so rather than showing a plausible 0/8.
    expect(screen.getByTestId('pod-seats').textContent).toContain('no seats yet');
    expect(screen.queryByTestId('pod-tally')).toBeNull();

    openPod(stub);

    // The committed fixture seats four people and four bots in a pod of eight.
    const tally = screen.getByTestId('pod-tally').textContent ?? '';
    expect(tally).toContain('4 people');
    expect(tally).toContain('4 bots');
    expect(tally).toContain('of 8 seats');
    expect(tally).toContain('you are seat 0');
  });
});

/* ── send the link ───────────────────────────────────────────────────── */

describe('sending the link', () => {
  it('takes a second browser to the same pod', () => {
    // Browser one: start a pod and read the link off the screen.
    const host = makeStub();
    const first = open(host);
    fireEvent.click(screen.getByTestId('start-pod'));
    const link = (screen.getByTestId('invite-url') as HTMLInputElement).value;
    const podId = joinedIds(host)[0];
    first.unmount();

    // Browser two: paste that link into the join box, exactly as sent.
    const guest = makeStub();
    globalThis.location.hash = '';
    render(createElement(App, { transport: guest.make }));
    fireEvent.change(screen.getByTestId('join-id'), { target: { value: link } });
    fireEvent.click(screen.getByText('Join'));

    expect(screen.getByTestId('pod')).toBeTruthy();
    expect(joinedIds(guest)).toEqual([podId]);

    openPod(guest);
    expect(within(screen.getByTestId('pack')).queryAllByTestId('card')).toHaveLength(15);
  });

  it('follows the link opened cold, with no lobby visit at all', () => {
    // The friend who clicks the link in a chat window never sees the lobby.
    const stub = makeStub();
    open(stub, '#/draft/amber-lantern-k7q4');
    expect(screen.getByTestId('pod')).toBeTruthy();
    expect(joinedIds(stub)).toEqual(['amber-lantern-k7q4']);
  });

  it('refuses a paste that is not a pod, instead of opening an empty one', () => {
    const stub = makeStub();
    open(stub);
    fireEvent.change(screen.getByTestId('join-id'), {
      target: { value: 'https://hadoku.me/cardtable/' },
    });
    fireEvent.click(screen.getByText('Join'));

    // Joining a mangled id opens a NEW pod nobody else is in, which from the
    // inside is indistinguishable from "my friends never showed up".
    expect(screen.getByTestId('join-error')).toBeTruthy();
    expect(screen.getByTestId('lobby')).toBeTruthy();
    expect(joinedIds(stub)).toEqual([]);
  });
});

/* ── picking, over the socket ────────────────────────────────────────── */

describe('the pod is the socket source', () => {
  it('sends a pick to the server rather than drafting in the tab', () => {
    const stub = makeStub();
    open(stub, '#/draft/amber-lantern-k7q4');
    openPod(stub);

    const first = within(screen.getByTestId('pack')).queryAllByTestId('card')[0];
    const cardId = first.getAttribute('data-card-id');
    expect(cardId).toBeTruthy();
    fireEvent.click(first);

    const picks = outbound(stub).filter((m) => m.type === 'pick');
    expect(picks).toHaveLength(1);
    expect(picks[0]).toEqual({ type: 'pick', draftId: 'amber-lantern-k7q4', cardId });
  });
});
