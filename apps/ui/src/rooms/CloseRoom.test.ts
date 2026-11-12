// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { CloseRoom } from './CloseRoom.tsx';
import { currentRoute } from '../screens/route.ts';

afterEach(() => {
  cleanup();
  globalThis.location.hash = '';
});

describe('the room owner’s Close', () => {
  it('asks once more, and closing goes back to the lobby', async () => {
    globalThis.location.hash = '#/room/r-cube';
    const close = vi.fn(async () => ({ ok: true as const }));
    render(createElement(CloseRoom, { roomId: 'r-cube', rooms: { close } }));

    fireEvent.click(screen.getByTestId('room-close'));
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('room-close-no'));
    expect(screen.getByTestId('room-close')).toBeTruthy();

    fireEvent.click(screen.getByTestId('room-close'));
    fireEvent.click(screen.getByTestId('room-close-yes'));
    expect(close).toHaveBeenCalledWith('r-cube');
    await waitFor(() => expect(currentRoute()).toEqual({ kind: 'lobby' }));
  });

  it('shows the server’s refusal and stays', async () => {
    globalThis.location.hash = '#/room/r-cube';
    const close = vi.fn(async () => ({ ok: false as const, message: 'Could not close the room: only the room owner can close it.' }));
    render(createElement(CloseRoom, { roomId: 'r-cube', rooms: { close } }));
    fireEvent.click(screen.getByTestId('room-close'));
    fireEvent.click(screen.getByTestId('room-close-yes'));
    await waitFor(() => expect(screen.getByTestId('room-close-error').textContent).toContain('only the room owner'));
    expect(currentRoute()).toEqual({ kind: 'room', roomId: 'r-cube' });
  });
});

describe('the room owner’s Reset, beside Close', () => {
  it('asks once more, and resetting keeps the room open', async () => {
    globalThis.location.hash = '#/room/r-cube';
    const close = vi.fn(async () => ({ ok: true as const }));
    const reset = vi.fn(async () => null);
    render(createElement(CloseRoom, { roomId: 'r-cube', rooms: { close }, reset }));

    fireEvent.click(screen.getByTestId('room-reset'));
    expect(reset).not.toHaveBeenCalled();
    expect(screen.queryByTestId('room-close'), 'one question at a time').toBeNull();
    fireEvent.click(screen.getByTestId('room-reset-no'));

    fireEvent.click(screen.getByTestId('room-reset'));
    fireEvent.click(screen.getByTestId('room-reset-yes'));
    expect(reset).toHaveBeenCalledWith('r-cube');
    await waitFor(() => expect(screen.getByTestId('room-reset')).toBeTruthy());
    expect(close).not.toHaveBeenCalled();
    expect(currentRoute()).toEqual({ kind: 'room', roomId: 'r-cube' });
  });

  it('shows the server’s refusal and stays asked', async () => {
    const reset = vi.fn(async () => 'a draft or tournament under way can only be closed');
    render(createElement(CloseRoom, { roomId: 'r-cube', rooms: { close: vi.fn() }, reset }));
    fireEvent.click(screen.getByTestId('room-reset'));
    fireEvent.click(screen.getByTestId('room-reset-yes'));
    await waitFor(() => expect(screen.getByTestId('room-reset-error').textContent).toContain('under way'));
  });

  it('is not offered where a room cannot be reset', () => {
    render(createElement(CloseRoom, { roomId: 'r-cube', rooms: { close: vi.fn() }, resettable: false }));
    expect(screen.queryByTestId('room-reset')).toBeNull();
    expect(screen.getByTestId('room-close')).toBeTruthy();
  });
});
