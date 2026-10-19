// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { CloseRoom } from './CloseRoom.tsx';

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
    await waitFor(() => expect(globalThis.location.hash).toBe('#/'));
  });

  it('shows the server’s refusal and stays', async () => {
    globalThis.location.hash = '#/room/r-cube';
    const close = vi.fn(async () => ({ ok: false as const, message: 'Could not close the room: only the room owner can close it.' }));
    render(createElement(CloseRoom, { roomId: 'r-cube', rooms: { close } }));
    fireEvent.click(screen.getByTestId('room-close'));
    fireEvent.click(screen.getByTestId('room-close-yes'));
    await waitFor(() => expect(screen.getByTestId('room-close-error').textContent).toContain('only the room owner'));
    expect(globalThis.location.hash).toBe('#/room/r-cube');
  });
});
