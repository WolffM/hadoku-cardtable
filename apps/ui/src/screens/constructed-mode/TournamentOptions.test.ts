// @vitest-environment jsdom
/*
 * Tournament + Decks toggles: visibility (Decks only once Tournament is on)
 * and locking (the leader edits, everybody else reads the same state
 * disabled, both lock once the caller says so).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import { TournamentOptions } from './TournamentOptions.tsx';

afterEach(cleanup);

function props(over: Partial<Parameters<typeof TournamentOptions>[0]> = {}) {
  return {
    tournament: false,
    tournamentDecks: 'locked' as const,
    leader: true,
    disabled: false,
    onTournament: vi.fn(),
    onDecks: vi.fn(),
    ...over,
  };
}

describe('TournamentOptions', () => {
  it('draws the Tournament toggle off, and no Decks toggle at all', () => {
    render(createElement(TournamentOptions, props()));
    const toggle = screen.getByTestId('tournament-toggle');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('tournament-decks')).toBeNull();
  });

  it('draws the Decks toggle only once Tournament is on, defaulting to Locked', () => {
    render(createElement(TournamentOptions, props({ tournament: true })));
    expect(screen.getByTestId('tournament-toggle').getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByTestId('tournament-decks-locked') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('tournament-decks-per-round') as HTMLInputElement).checked).toBe(false);
  });

  it('the leader presses Tournament on, and Decks on Each round', () => {
    const onTournament = vi.fn();
    const onDecks = vi.fn();
    const { rerender } = render(createElement(TournamentOptions, props({ onTournament, onDecks })));
    screen.getByTestId('tournament-toggle').click();
    expect(onTournament).toHaveBeenCalledWith(true);

    rerender(createElement(TournamentOptions, props({ tournament: true, onTournament, onDecks })));
    screen.getByTestId('tournament-decks-per-round').click();
    expect(onDecks).toHaveBeenCalledWith('per-round');
  });

  it('a non-leader reads both controls, disabled, never able to move them', () => {
    render(createElement(TournamentOptions, props({ tournament: true, leader: false })));
    expect((screen.getByTestId('tournament-toggle') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('tournament-decks-locked') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('tournament-decks-per-round') as HTMLInputElement).disabled).toBe(true);
    // Still visible, still showing the room's actual state — not hidden.
    expect((screen.getByTestId('tournament-decks-locked') as HTMLInputElement).checked).toBe(true);
  });

  it('locks once the seats do, even for the leader', () => {
    render(createElement(TournamentOptions, props({ tournament: true, disabled: true })));
    expect((screen.getByTestId('tournament-toggle') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('tournament-decks-locked') as HTMLInputElement).disabled).toBe(true);
  });
});
