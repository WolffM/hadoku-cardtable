// @vitest-environment jsdom
/*
 * Leaving a room (the operator, 2026-11-24: *"leave buttons seem good … And make sure clicking the
 * top bar works as well. I'd expect both to work."*): the room's own Leave and the page's way home
 * both call the game's `/leave`, then go where the HOST says home is — never a route of their own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, Fragment, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { RoomShell, type RoomShellProps } from './RoomShell.tsx';
import { leaveRoomThen, RoomHomeLink, RoomHomeProvider, type RoomHome } from './room-exit.tsx';
import { PAGE_TOOLBAR } from '../../chrome/toolbarPage.tsx';
import * as route from '../../screens/route.ts';

afterEach(cleanup);

function shell(leave: RoomShellProps['leave']): ReactNode {
  return createElement(RoomShell, {
    shellRef: () => undefined,
    dataMembers: 2,
    roomTitle: 'Friday cube',
    settled: true,
    leave,
    headerTools: createElement('button', { type: 'button', 'data-testid': 'room-settings' }, 'Room settings'),
    streamed: false,
    streamedSubLine: null,
    resolved: true,
    pending: false,
    pendingBody: null,
    streamedBody: null,
    locked: null,
    password: '',
    onPasswordChange: () => undefined,
    onPasswordSubmit: () => undefined,
    roomMissingMessage: null,
    children: createElement('p', { 'data-testid': 'room-body' }, 'the table'),
  });
}

/** A host page: its way home around a top bar's link and the room. */
function page(home: RoomHome, room: ReactNode): ReactNode {
  return createElement(
    RoomHomeProvider,
    { value: home },
    createElement(RoomHomeLink, { href: '#/', 'data-testid': 'chrome-home' } as Parameters<typeof RoomHomeLink>[0], 'Card Table'),
    room,
  );
}

/** A `/leave` that answers when the test says so, so "home only after the leave" is observable. */
function pendingLeave() {
  let answer: () => void = () => undefined;
  const leave = vi.fn(() => new Promise<unknown>((resolve) => (answer = () => resolve({ ok: true }))));
  return { leave, answer: () => answer() };
}

describe('the room page leaves', () => {
  it("draws Leave in the room's head row, beside the room's own tools", () => {
    render(page(() => undefined, shell(() => Promise.resolve())));
    const tools = screen.getByTestId('room-leave').parentElement!;
    expect(tools.className).toBe('shell__tools');
    expect(tools.contains(screen.getByTestId('room-settings'))).toBe(true);
    expect(screen.getByTestId('room-leave').textContent).toBe('Leave');
  });

  it("Leave calls the room's /leave, then goes home once it has answered", async () => {
    const home = vi.fn();
    const { leave, answer } = pendingLeave();
    render(page(home, shell(leave)));
    fireEvent.click(screen.getByTestId('room-leave'));
    expect(leave).toHaveBeenCalledTimes(1);
    expect(home).not.toHaveBeenCalled();
    expect(screen.getByTestId<HTMLButtonElement>('room-leave').disabled).toBe(true);
    answer();
    await waitFor(() => expect(home).toHaveBeenCalledTimes(1));
  });

  it("Leave still goes home when the server refuses the leave", async () => {
    const home = vi.fn();
    render(page(home, shell(() => Promise.resolve({ ok: false, message: 'Could not leave the room: no such room.' }))));
    fireEvent.click(screen.getByTestId('room-leave'));
    await waitFor(() => expect(home).toHaveBeenCalledTimes(1));
  });

  it("the page's way home leaves the room drawn, then goes home", async () => {
    const home = vi.fn();
    const { leave, answer } = pendingLeave();
    render(page(home, shell(leave)));
    const link = screen.getByTestId('chrome-home');
    expect(link.getAttribute('href')).toBe('#/');
    expect(fireEvent.click(link)).toBe(false); // the press is the link's own, never the browser's
    expect(leave).toHaveBeenCalledTimes(1);
    expect(home).not.toHaveBeenCalled();
    answer();
    await waitFor(() => expect(home).toHaveBeenCalledTimes(1));
  });

  it('the latest leave is the one called', async () => {
    const home = vi.fn();
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    const { rerender } = render(page(home, shell(first)));
    rerender(page(home, shell(second)));
    fireEvent.click(screen.getByTestId('chrome-home'));
    await waitFor(() => expect(home).toHaveBeenCalledTimes(1));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('once the room is no longer drawn, the way home only goes home', () => {
    const home = vi.fn();
    const leave = vi.fn(() => Promise.resolve());
    const { rerender } = render(page(home, shell(leave)));
    rerender(page(home, createElement(Fragment)));
    fireEvent.click(screen.getByTestId('chrome-home'));
    expect(home).toHaveBeenCalledTimes(1);
    expect(leave).not.toHaveBeenCalled();
  });

  it("the chat toolbar's Home (a page with no top bar) leaves too", async () => {
    const go = vi.spyOn(route, 'navigate').mockImplementation(() => undefined);
    try {
      const leave = vi.fn(() => Promise.resolve());
      render(page(() => undefined, shell(leave)));
      PAGE_TOOLBAR.onHome?.();
      expect(leave).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(go).toHaveBeenCalledWith({ kind: 'lobby' }));
    } finally {
      go.mockRestore();
    }
  });
});

describe('an embedding host decides what home is', () => {
  it("uses the host's own way home, never the app's route", async () => {
    const go = vi.spyOn(route, 'navigate');
    try {
      const hostHome = vi.fn();
      const leave = vi.fn(() => Promise.resolve());
      render(page(hostHome, shell(leave)));
      fireEvent.click(screen.getByTestId('room-leave'));
      await waitFor(() => expect(hostHome).toHaveBeenCalledTimes(1));
      expect(leave).toHaveBeenCalledTimes(1);
      expect(go).not.toHaveBeenCalled();
    } finally {
      go.mockRestore();
    }
  });

  it('a host with no way home (no top bar either) gets the room without a Leave', () => {
    const leave = vi.fn(() => Promise.resolve());
    render(shell(leave));
    expect(screen.getByTestId('room-body')).toBeTruthy();
    expect(screen.queryByTestId('room-leave')).toBeNull();
  });

  it('leaveRoomThen with no room drawn goes home and calls no leave', async () => {
    const home = vi.fn();
    await leaveRoomThen(home);
    expect(home).toHaveBeenCalledTimes(1);
  });
});
