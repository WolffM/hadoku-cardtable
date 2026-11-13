// @vitest-environment jsdom
/*
 * With the chat column hidden, the room's latest lines float over the table: watchparty's own
 * over-video overlay, drawn by the installed `RoomChrome` beside its collapsed rail. This mounts
 * the REAL chrome (RoomShell.test.ts stands in for it) and plays the room through its own store,
 * which it publishes only under `debug`: no room server answers here, so the line is put where
 * the chrome's socket would put it.
 *
 * `.test.ts` and `createElement`: the root vitest config collects no `.tsx` test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { RoomChrome } from '@wolffm/watchparty-ui/room-chrome';

interface ChromeStore {
  getState(): { chromeChatCollapsed: boolean };
  setState(patch: object): void;
}
const store = (): ChromeStore => (window as unknown as { __ZUSTAND_STORE__: ChromeStore }).__ZUSTAND_STORE__;

function mount(collapsible: boolean): void {
  render(
    createElement(RoomChrome, {
      roomKey: 'cardtable-r-floating',
      serverOrigin: 'http://127.0.0.1:9',
      roomOrigin: 'http://127.0.0.1:9',
      theme: 'light',
      collapsible,
      debug: true,
      children: createElement('div', { 'data-testid': 'table' }, 'the table'),
    }),
  );
}

function say(text: string): void {
  act(() => {
    store().setState({ chat: [{ id: `m-${text}`, clientId: 'c-bob', author: 'bob', name: 'Bob', sprite: null, text, ts: Date.now(), live: true }] });
  });
}

const floating = (): HTMLElement | null => screen.queryByTestId('floating-chat');

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('the floating chat over the table', () => {
  it('floats the latest line beside the collapsed rail, click-through, and is gone once the column opens', async () => {
    mount(true);
    say('while open');
    expect(screen.getByText('while open'), 'the column shows the line').toBeTruthy();
    expect(floating(), 'nothing floats while the column is open').toBeNull();

    act(() => screen.getByRole('button', { name: 'Hide chat' }).click());
    expect(store().getState().chromeChatCollapsed).toBe(true);
    say('while hidden');
    const overlay = await screen.findByTestId('floating-chat');
    expect(overlay.textContent).toContain('while hidden');
    expect(overlay.className).toContain('pointer-events-none');
    expect(overlay.closest('.wp-room-chrome'), 'drawn by the chrome, beside its rail').not.toBeNull();

    act(() => screen.getByRole('button', { name: 'Show chat' }).click());
    expect(floating(), 'the column has the line again, so nothing floats').toBeNull();
  });

  it('a screen that keeps the column open (the room lobby) never floats, whatever the viewer saved', () => {
    mount(false);
    act(() => store().setState({ chromeChatCollapsed: true }));
    say('in the lobby');
    expect(floating()).toBeNull();
  });
});
