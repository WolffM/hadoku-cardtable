// @vitest-environment jsdom
/*
 * The pod's 8-seat grid: empty seats offer Sit, my own seat offers Stand,
 * every occupied seat shows a ready pill, and sitting is refused once I
 * already hold one. `.test.ts`, not `.test.tsx` — the root vitest config
 * globs `apps/*\/src/**\/*.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';

import { PodSeats } from './PodSeats.tsx';
import { POD_AI, POD_CLOSED, POD_SEATS, type PodSeats as PodSeatsValue } from './wire.ts';

afterEach(cleanup);

const emptySeats = (): PodSeatsValue => Array.from({ length: POD_SEATS }, () => null);

describe('the pod seat grid', () => {
  it('offers the owner Close on an open seat and Open on a closed one, and nobody else either', () => {
    const seats = emptySeats();
    seats[7] = { memberId: POD_CLOSED, name: '' };
    const onClose = vi.fn();
    const props = {
      seats,
      leaderId: 'u-alice',
      readyOf: () => false,
      avatarIdOf: () => undefined,
      onSit: () => undefined,
      onStand: () => undefined,
      onAi: () => undefined,
      onClose,
    };
    const { rerender } = render(createElement(PodSeats, { ...props, myMemberId: 'u-bob' }));
    expect(screen.getByTestId('pod-seat-7').textContent).toContain('Closed');
    expect(screen.queryByTestId('pod-seat-close')).toBeNull();
    expect(screen.queryByTestId('pod-seat-open')).toBeNull();
    expect(screen.getAllByTestId('pod-seat-sit')).toHaveLength(POD_SEATS - 1);

    rerender(createElement(PodSeats, { ...props, myMemberId: 'u-alice' }));
    expect(screen.getAllByTestId('pod-seat-close')).toHaveLength(POD_SEATS - 1);
    screen.getAllByTestId('pod-seat-close')[0]!.click();
    expect(onClose).toHaveBeenCalledWith(0, true);
    screen.getByTestId('pod-seat-open').click();
    expect(onClose).toHaveBeenCalledWith(7, false);
  });

  it('draws all 8 seats, empty ones offering Sit', () => {
    render(
      createElement(PodSeats, {
        seats: emptySeats(),
        myMemberId: null,
        leaderId: '',
        readyOf: () => false,
        avatarIdOf: () => undefined,
        onSit: () => undefined,
        onStand: () => undefined,
        onAi: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(screen.getAllByTestId('pod-seat-sit')).toHaveLength(POD_SEATS);
    expect(screen.queryByTestId('pod-seat-stand')).toBeNull();
  });

  it('shows the occupant’s name, a ready pill, and no Sit button once seated', () => {
    const seats = emptySeats();
    seats[2] = { memberId: 'u-alice', name: 'Alice' };
    render(
      createElement(PodSeats, {
        seats,
        myMemberId: null,
        leaderId: '',
        readyOf: (id) => id === 'u-alice',
        avatarIdOf: () => undefined,
        onSit: () => undefined,
        onStand: () => undefined,
        onAi: () => undefined,
        onClose: () => undefined,
      }),
    );
    const row = screen.getByTestId('pod-seat-2');
    expect(row.textContent).toContain('Alice');
    expect(screen.getByTestId('pod-seat-2-ready').getAttribute('data-state')).toBe('yes');
    expect(screen.getAllByTestId('pod-seat-sit')).toHaveLength(POD_SEATS - 1);
  });

  // The operator, 2026-10-22: "'Hadoku (you)' i dont need you written next to my name".
  it('gives my own seat a Stand button and nobody else’s, with no "(you)" beside my name', () => {
    const seats = emptySeats();
    seats[0] = { memberId: 'u-me', name: 'Me' };
    seats[1] = { memberId: 'u-other', name: 'Other' };
    render(
      createElement(PodSeats, {
        seats,
        myMemberId: 'u-me',
        leaderId: '',
        readyOf: () => false,
        avatarIdOf: () => undefined,
        onSit: () => undefined,
        onStand: () => undefined,
        onAi: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(screen.getByTestId('pod-seat-0').querySelector('.pod-seats__label')?.textContent).toBe('Me');
    expect(screen.getByTestId('pod-seat-0').contains(screen.getByTestId('pod-seat-stand'))).toBe(true);
    expect(screen.getAllByTestId('pod-seat-stand')).toHaveLength(1);
  });

  // The operator, 2026-10-22: "adding AI to sit at the table isn't loading their avatar picutres".
  it('draws an AI seat with its own character’s picture', () => {
    const seats = emptySeats();
    seats[1] = { memberId: POD_AI, name: 'Sage', avatarId: 'sage' };
    render(
      createElement(PodSeats, {
        seats,
        myMemberId: 'u-me',
        leaderId: '',
        readyOf: () => false,
        avatarIdOf: () => undefined,
        onSit: () => undefined,
        onStand: () => undefined,
        onAi: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(screen.getByTestId('pod-seat-1').querySelector('img')?.getAttribute('src')).toMatch(/sage/);
  });

  // A tournament AI entrant is `ai:<seat>` on the wire (`room/lobby.ts`'s
  // `aiEntrantId`), never the bare `ai` a draft pod's shared bot uses — the
  // same AI look and Remove button, or the AI button silently stops working
  // for a tournament seat.
  it('draws a TOURNAMENT AI seat (`ai:3`) with the same AI look and Remove as the draft pod’s `ai`', () => {
    const seats = emptySeats();
    seats[3] = { memberId: 'ai:3', name: 'Knight', avatarId: 'knight' };
    const onAi = vi.fn();
    render(
      createElement(PodSeats, {
        seats,
        myMemberId: 'u-me',
        leaderId: '',
        readyOf: () => false,
        avatarIdOf: () => undefined,
        onSit: () => undefined,
        onStand: () => undefined,
        onAi,
        onClose: () => undefined,
      }),
    );
    const row = screen.getByTestId('pod-seat-3');
    expect(row.getAttribute('data-ai')).toBe('');
    expect(row.querySelector('img')?.getAttribute('src')).toMatch(/knight/);
    screen.getByTestId('pod-seat-ai-remove').click();
    expect(onAi).toHaveBeenCalledWith(3, false);
  });

  it('crowns the leader’s seat, wherever it is', () => {
    const seats = emptySeats();
    seats[5] = { memberId: 'u-lead', name: 'Leader' };
    render(
      createElement(PodSeats, {
        seats,
        myMemberId: null,
        leaderId: 'u-lead',
        readyOf: () => false,
        avatarIdOf: () => undefined,
        onSit: () => undefined,
        onStand: () => undefined,
        onAi: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(screen.getByTestId('pod-seat-5-leader')).toBeTruthy();
  });

  it('refuses Sit while I already hold a seat — one seat per person', () => {
    const seats = emptySeats();
    seats[0] = { memberId: 'u-me', name: 'Me' };
    render(
      createElement(PodSeats, {
        seats,
        myMemberId: 'u-me',
        leaderId: '',
        readyOf: () => false,
        avatarIdOf: () => undefined,
        onSit: () => undefined,
        onStand: () => undefined,
        onAi: () => undefined,
        onClose: () => undefined,
      }),
    );
    for (const btn of screen.getAllByTestId('pod-seat-sit')) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('calls onSit with the seat index while nobody holds a seat yet', () => {
    const onSit = vi.fn();
    render(
      createElement(PodSeats, {
        seats: emptySeats(),
        myMemberId: 'u-me',
        leaderId: '',
        readyOf: () => false,
        avatarIdOf: () => undefined,
        onSit,
        onStand: () => undefined,
        onAi: () => undefined,
        onClose: () => undefined,
      }),
    );
    screen.getByTestId('pod-seat-3').querySelector('button')?.click();
    expect(onSit).toHaveBeenCalledWith(3);
  });

  it('calls onStand with no arguments from my own seat', () => {
    const onStand = vi.fn();
    const seats = emptySeats();
    seats[0] = { memberId: 'u-me', name: 'Me' };
    render(
      createElement(PodSeats, {
        seats,
        myMemberId: 'u-me',
        leaderId: '',
        readyOf: () => false,
        avatarIdOf: () => undefined,
        onSit: () => undefined,
        onStand,
        onAi: () => undefined,
        onClose: () => undefined,
      }),
    );
    screen.getByTestId('pod-seat-stand').click();
    expect(onStand).toHaveBeenCalledWith();
  });

  // AF305 §B: the pod is a strip of avatars, not the 1v1 table's rows — every
  // seat, open, closed, the AI's or a person's, is the same shape: one
  // avatar (dashed+open / "×"+closed / "AI" / an initial, ringed once ready)
  // with its label underneath, reachable with no hover (every action is its
  // own visible, labelled button, never a hover-only affordance).
  it('draws every kind of seat as one avatar + a label, never a hover-only action', () => {
    const seats = emptySeats();
    seats[1] = { memberId: 'u-me', name: 'A name long enough to need its ellipsis at any width this list is drawn' };
    seats[2] = { memberId: 'ai', name: 'AI' };
    seats[3] = { memberId: POD_CLOSED, name: '' };
    render(
      createElement(PodSeats, {
        seats,
        myMemberId: 'u-me',
        leaderId: 'u-me',
        readyOf: () => true,
        avatarIdOf: () => undefined,
        onSit: () => undefined,
        onStand: () => undefined,
        onAi: () => undefined,
        onClose: () => undefined,
      }),
    );
    for (const row of screen.getByTestId('pod-seats').children) {
      const id = row.getAttribute('data-testid') ?? '';
      expect(row.classList.contains('pod-seats__seat'), id).toBe(true);
      expect(row.querySelector('.pod-seats__avatar, .pod-seats__avatar-wrap'), `${id}: an avatar`).not.toBeNull();
      expect(row.querySelector('.pod-seats__label'), `${id}: a label under it`).not.toBeNull();
      // Every action on the row is a plain, always-rendered button — nothing gated on `:hover`.
      for (const btn of row.querySelectorAll('button')) {
        expect(btn.className, `${id}: ${btn.textContent}`).not.toMatch(/hover/i);
      }
    }
  });

  it('the seated ready ring and the open seat’s dashed "+" are each the seat’s own avatar — the ready pill stays too', () => {
    const seats = emptySeats();
    seats[0] = { memberId: 'u-alice', name: 'Alice' };
    render(
      createElement(PodSeats, {
        seats,
        myMemberId: null,
        leaderId: '',
        readyOf: () => true,
        avatarIdOf: () => undefined,
        onSit: () => undefined,
        onStand: () => undefined,
        onAi: () => undefined,
        onClose: () => undefined,
      }),
    );
    const seated = screen.getByTestId('pod-seat-0').querySelector('.pod-seats__avatar');
    expect(seated?.getAttribute('data-ready'), 'the ring token is on the avatar itself').toBe('true');
    expect(screen.getByTestId('pod-seat-0-ready').getAttribute('data-state'), 'the pill is still drawn too').toBe('yes');

    const open = screen.getAllByTestId('pod-seat-sit')[0]!;
    expect(open.className).toContain('pod-seats__avatar--open');
  });

  // AF305 §D: a seated member's real watchparty avatar (`Avatar`, same component SeatBar/PodBracket use),
  // not a drawn initial — the initial stays only as `Avatar`'s own fallback for a member with none.
  it("draws a seated member's own avatar image when they have one, and falls back to their initial when they do not", () => {
    const seats = emptySeats();
    seats[0] = { memberId: 'u-has-avatar', name: 'Has Avatar' };
    seats[1] = { memberId: 'u-no-avatar', name: 'No Avatar' };
    render(
      createElement(PodSeats, {
        seats,
        myMemberId: null,
        leaderId: '',
        readyOf: () => false,
        avatarIdOf: (id) => (id === 'u-has-avatar' ? 'some-avatar-id' : undefined),
        onSit: () => undefined,
        onStand: () => undefined,
        onAi: () => undefined,
        onClose: () => undefined,
      }),
    );
    const withAvatar = screen.getByTestId('pod-seat-0').querySelector('.pod-seats__avatar img');
    expect(withAvatar, 'a real avatar image').not.toBeNull();

    const withoutAvatar = screen.getByTestId('pod-seat-1').querySelector('.pod-seats__avatar');
    expect(withoutAvatar?.querySelector('img'), 'no image for a member with none').toBeNull();
    expect(withoutAvatar?.textContent, "falls back to the member's own initial").toBe('N');
  });

  /*
   * forge.yml 39844107553: the driver only ever pressed AI, and the server took
   * AI seat 2, then seat 2 given back, then AI seat 3 — the press landed on the
   * seat's Remove, drawn into the very node its AI had been.
   */
  describe('a press meant for one action never fires its inverse', () => {
    const seatsWithAi = (): PodSeatsValue => {
      const seats = emptySeats();
      seats[0] = { memberId: 'u-alice', name: 'Alice' };
      return seats;
    };
    const propsOf = (seats: PodSeatsValue, onAi: (seat: number, on: boolean) => void) => ({
      seats,
      myMemberId: 'u-alice',
      leaderId: 'u-alice',
      readyOf: () => false,
      avatarIdOf: () => undefined,
      onSit: () => undefined,
      onStand: () => undefined,
      onAi,
      onClose: () => undefined,
    });

    it('a press resolved against the AI button, landing after the room fills the seat, does not remove the AI', () => {
      const onAi = vi.fn();
      const before = seatsWithAi();
      const { rerender } = render(createElement(PodSeats, propsOf(before, onAi)));
      const aiButton = screen.getAllByTestId('pod-seat-ai').find((b) => b.dataset.seat === '2')!;
      const after = seatsWithAi();
      after[2] = { memberId: POD_AI, name: 'AI' };
      rerender(createElement(PodSeats, propsOf(after, onAi)));
      fireEvent.click(aiButton, { detail: 1 });
      expect(onAi).not.toHaveBeenCalledWith(2, false);
    });

    it('the second click of a double click on AI does nothing on the Remove that the first click drew', () => {
      const onAi = vi.fn();
      const { rerender } = render(createElement(PodSeats, propsOf(seatsWithAi(), onAi)));
      fireEvent.click(screen.getAllByTestId('pod-seat-ai').find((b) => b.dataset.seat === '2')!, { detail: 1 });
      expect(onAi).toHaveBeenCalledWith(2, true);
      const after = seatsWithAi();
      after[2] = { memberId: POD_AI, name: 'AI' };
      rerender(createElement(PodSeats, propsOf(after, onAi)));
      fireEvent.click(screen.getByTestId('pod-seat-ai-remove'), { detail: 2 });
      expect(onAi).toHaveBeenCalledTimes(1);
      // A deliberate press on Remove still removes.
      fireEvent.click(screen.getByTestId('pod-seat-ai-remove'), { detail: 1 });
      expect(onAi).toHaveBeenLastCalledWith(2, false);
    });
  });
});

describe('a room past 8: one list of seats, pods decided only at the split', () => {
  const base = {
    leaderId: 'u-alice',
    readyOf: () => false,
    avatarIdOf: () => undefined,
    onStand: () => undefined,
    onAi: () => undefined,
    onClose: () => undefined,
  };
  const full = (length: number): PodSeatsValue => Array.from({ length }, (_, i) => ({ memberId: `u-${i}`, name: `m${i}` }));

  it('draws 13 seats as one list with no pod markers', () => {
    render(createElement(PodSeats, { ...base, seats: full(13), myMemberId: 'u-0', onSit: () => undefined }));
    expect(screen.getByTestId('pod-seat-12')).toBeTruthy();
    expect(screen.getByTestId('pod-seats').querySelectorAll('li')).toHaveLength(13);
    expect(screen.getByTestId('pod-seats').textContent).not.toMatch(/Pod \d/);
    expect(screen.getByTestId('pod-seats').dataset.pods).toBeUndefined();
  });

  it('a full room offers someone who has not sat one more seat, and nobody already seated', () => {
    const onSit = vi.fn();
    const { rerender } = render(createElement(PodSeats, { ...base, seats: full(8), myMemberId: 'u-new', onSit }));
    const sit = screen.getByTestId('pod-seat-8').querySelector('[data-testid="pod-seat-sit"]') as HTMLElement;
    expect(sit.dataset.seat).toBe('8');
    fireEvent.click(sit);
    expect(onSit).toHaveBeenCalledWith(8);
    // Nobody may close a seat the room does not have yet.
    expect(screen.getByTestId('pod-seat-8').querySelector('[data-testid="pod-seat-close"]')).toBeNull();

    rerender(createElement(PodSeats, { ...base, seats: full(8), myMemberId: 'u-3', onSit }));
    expect(screen.queryByTestId('pod-seat-8')).toBeNull();
  });

  it('offers the seated owner one more seat for an AI', () => {
    const onAi = vi.fn();
    const seats = full(8);
    seats[0] = { memberId: 'u-alice', name: 'Alice' };
    render(createElement(PodSeats, { ...base, seats, myMemberId: 'u-alice', onSit: () => undefined, onAi }));
    const seat = screen.getByTestId('pod-seat-8');
    expect((seat.querySelector('[data-testid="pod-seat-sit"]') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(seat.querySelector('[data-testid="pod-seat-ai"]') as HTMLElement);
    expect(onAi).toHaveBeenCalledWith(8, true);
  });

  it('stops offering a seat at 64', () => {
    render(createElement(PodSeats, { ...base, seats: full(64), myMemberId: 'u-new', onSit: () => undefined }));
    expect(screen.queryByTestId('pod-seat-64')).toBeNull();
  });
});
