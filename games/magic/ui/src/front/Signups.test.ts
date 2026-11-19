// @vitest-environment jsdom
// Who has signed up for an event: the chip draws the first four faces and the whole count, and
// opens the list; the list tags who is in the room and carries the row's View and Sign up. The
// room's chip is the calendar's own, found by the room's id.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventSignup, EventView } from '@hadoku/shared';

import { eventsClient, setEventsClient } from './events.ts';
import { RoomSignups, SignupsChip } from './Signups.tsx';

afterEach(cleanup);

const people: EventSignup[] = [
  { id: 'fk:hadoku', name: 'Hadoku', avatarId: 'sage', inRoom: true },
  { id: 'anon:0', name: 'Ada', inRoom: false },
  { id: 'fk:bo', name: 'Bo', inRoom: false },
  { id: 'fk:cy', name: 'Cy', inRoom: true },
  { id: 'fk:dee', name: 'Dee', inRoom: false },
];

const event = (over: Partial<EventView> = {}): EventView => ({
  id: 'e-1',
  kind: 'draft-pod',
  title: 'Draft Major #1',
  startsAt: '2026-11-29T22:30:00.000Z',
  organizer: 'Hadoku',
  mine: false,
  joined: false,
  roomId: 'r-1',
  room: null,
  signups: people,
  ...over,
});

describe('SignupsChip', () => {
  it('shows four faces and the whole count, and opens nothing until pressed', () => {
    render(createElement(SignupsChip, { event: event() }));
    const chip = screen.getByTestId('event-signups');
    expect(chip.querySelectorAll('.signups__face')).toHaveLength(4);
    expect(chip.textContent).toContain('5 signed up');
    expect(chip.getAttribute('aria-label')).toBe('Signed up: 5. Show who');
    expect(screen.queryByTestId('event-signups-modal')).toBeNull();
  });

  it('opens the list: everyone by name, In room on those in the room, and the row’s View and Sign up', () => {
    const onView = vi.fn();
    const onSignUp = vi.fn();
    render(createElement(SignupsChip, { event: event(), onView, onSignUp }));
    fireEvent.click(screen.getByTestId('event-signups'));
    const modal = screen.getByTestId('event-signups-modal');
    expect(modal.querySelector('h3')?.textContent).toBe('Signed up · 5');
    expect(modal.textContent).toContain('Draft Major #1');
    const rows = screen.getAllByTestId('event-signups-person');
    expect(rows.map((r) => r.querySelector('.signups__name')?.textContent)).toEqual(['Hadoku', 'Ada', 'Bo', 'Cy', 'Dee']);
    expect(rows.map((r) => r.querySelector('[data-testid="event-signups-in-room"]') !== null)).toEqual([true, false, false, true, false]);
    // A face with a character draws it; one without draws the initial.
    expect(rows[0]!.querySelector('img')).not.toBeNull();
    expect(rows[1]!.querySelector('.signups__face-initial')?.textContent).toBe('A');

    fireEvent.click(screen.getByTestId('event-signups-view'));
    expect(onView).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('event-signups-signup'));
    expect(onSignUp).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('event-signups-modal-close'));
    expect(screen.queryByTestId('event-signups-modal')).toBeNull();
  });

  it('has no foot where there is nothing to view or sign up for, and draws no faces for nobody', () => {
    render(createElement(SignupsChip, { event: event({ signups: [] }) }));
    const chip = screen.getByTestId('event-signups');
    expect(chip.textContent).toBe('0 signed up');
    expect(chip.querySelector('.signups__faces')).toBeNull();
    fireEvent.click(chip);
    expect(screen.getByTestId('event-signups-modal').querySelector('.ct-modal__actions')).toBeNull();
  });
});

describe('removing a sign-up', () => {
  it('is the organizer’s, on everyone but themselves, and a second press removes them and re-reads the list', async () => {
    cleanup();
    render(createElement(SignupsChip, { event: event() }));
    fireEvent.click(screen.getByTestId('event-signups'));
    expect(screen.queryByTestId('event-signups-remove'), 'not the organizer: no Remove').toBeNull();
    cleanup();

    const mine = event({ mine: true, signups: people.map((p) => (p.name === 'Hadoku' ? { ...p, you: true } : p)) });
    const removeSignup = vi.fn(async () => ({ ok: true as const, event: mine }));
    const list = vi.fn(async () => [event({ mine: true, signups: people.filter((p) => p.name !== 'Cy') })]);
    setEventsClient({ ...eventsClient(), list, removeSignup });
    render(createElement(SignupsChip, { event: mine }));
    fireEvent.click(screen.getByTestId('event-signups'));
    const rows = screen.getAllByTestId('event-signups-person');
    expect(rows.map((r) => r.querySelector('[data-testid="event-signups-remove"]') !== null)).toEqual([false, true, true, true, true]);

    fireEvent.click(rows[3]!.querySelector('[data-testid="event-signups-remove"]')!);
    expect(removeSignup, 'the first press only arms it').not.toHaveBeenCalled();
    await act(async () => fireEvent.click(rows[3]!.querySelector('[data-testid="event-signups-remove-confirm"]')!));
    expect(removeSignup).toHaveBeenCalledWith('e-1', 'fk:cy');
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe('RoomSignups', () => {
  it('draws the chip of the event whose room it is, and nothing for a room no event names', async () => {
    const list = vi.fn(async () => [event({ id: 'e-2', roomId: 'r-2', signups: people.slice(0, 2) }), event()]);
    setEventsClient({ ...eventsClient(), list });
    const { rerender } = render(createElement(RoomSignups, { roomId: 'r-1', members: 2 }));
    expect(await screen.findByTestId('event-signups')).toHaveProperty('textContent', expect.stringContaining('5 signed up'));
    expect(list).toHaveBeenCalledTimes(1);
    // Someone comes in: the list is read again.
    await act(async () => rerender(createElement(RoomSignups, { roomId: 'r-1', members: 3 })));
    expect(list).toHaveBeenCalledTimes(2);
    cleanup();

    render(createElement(RoomSignups, { roomId: 'r-9', members: 1 }));
    await act(async () => {});
    expect(screen.queryByTestId('event-signups')).toBeNull();
  });
});
