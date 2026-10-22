// @vitest-environment jsdom
/*
 * The Gauntlet's sounds (the operator, 2026-10-21: "the coinflip sound should play when deciding who
 * goes first" and "we need sound effects for selecting/banning decks"): the coin's role as it
 * appears, one per deck as the reveal deals it, one per ban and pick as the pool shows it, whoever
 * made it, and the choice on its own press. A screen opening on a moment already past hears nothing.
 */
import { createElement } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FALLBACK_ROLES, GAUNTLET_DECKS, GAUNTLET_REVEAL_MS, SOUND_ROLES, type GauntletDeck, type GauntletView } from '@hadoku/shared';

const played = vi.hoisted(() => [] as string[]);
vi.mock('../../sound/index.ts', () => ({ playRole: (role: string) => played.push(role) }));

import { GauntletScreen } from './GauntletScreen.tsx';
import { DEAL_FROM_MS, DEAL_STAGGER_MS, TITLE_MS } from './reveal.ts';
import { poolChangeRoles } from './sounds.ts';

const IDS = Array.from({ length: GAUNTLET_DECKS }, (_, i) => `deck-${i + 1}`);

function deck(id: string, over: Partial<GauntletDeck> = {}): GauntletDeck {
  return { id, name: id, archetype: id, pilot: 'Pilot', colors: ['R'], main: [{ count: 20, name: 'Mountain' }], sideboard: [], status: 'open', by: null, played: false, ...over };
}

function view(over: Partial<GauntletView> = {}): GauntletView {
  return {
    phase: 'banpick',
    you: 0,
    players: [
      { memberId: 'alice', name: 'Alice' },
      { memberId: 'bob', name: 'Bob' },
    ],
    ready: [true, true],
    era: { id: 'modern-2022', family: 'modern', title: 'Modern — 2022' },
    revealAt: Date.now() - GAUNTLET_REVEAL_MS,
    first: 1,
    decks: IDS.map((id) => deck(id)),
    step: { index: 0, seat: 1, act: 'ban', count: 1, taken: 0 },
    games: [],
    choice: null,
    winner: null,
    ...over,
  };
}

const noop = (): void => {};
const screenOf = (v: GauntletView, onChoose: (id: string) => void = noop) => createElement(GauntletScreen, { view: v, onBan: noop, onPick: noop, onChoose });

beforeEach(() => {
  played.length = 0;
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: noop, removeEventListener: noop }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the Gauntlet’s sounds', () => {
  it('the coin sounds the match’s coin role as it appears, then each deck as it is dealt', () => {
    vi.useFakeTimers();
    render(screenOf(view({ phase: 'reveal', revealAt: Date.now(), step: null })));
    expect(played).toEqual([]);
    act(() => vi.advanceTimersByTime(TITLE_MS));
    expect(played).toEqual(['g.game-start']);
    act(() => vi.advanceTimersByTime(DEAL_FROM_MS - TITLE_MS));
    expect(played).toEqual(['g.game-start', 'ui.gauntlet-deal']);
    // One deal at a time: the reveal sets its next timer once the last one has drawn.
    for (let i = 1; i < GAUNTLET_DECKS; i++) act(() => vi.advanceTimersByTime(DEAL_STAGGER_MS));
    act(() => vi.advanceTimersByTime(GAUNTLET_REVEAL_MS));
    expect(played.filter((r) => r === 'ui.gauntlet-deal')).toHaveLength(GAUNTLET_DECKS);
    expect(played.filter((r) => r === 'g.game-start'), 'the coin sounds once').toHaveLength(1);
  });

  it('a screen opening after the reveal hears none of it', () => {
    render(screenOf(view()));
    expect(played).toEqual([]);
  });

  it('a ban and a pick sound as the pool shows them, whoever made them', () => {
    const before = view();
    const { rerender } = render(screenOf(before));
    const banned = before.decks.map((d, i) => (i === 2 ? { ...d, status: 'banned' as const, by: 1 as const } : d));
    rerender(screenOf({ ...before, decks: banned }));
    expect(played, 'the other player’s ban').toEqual(['ui.gauntlet-ban']);
    const picked = banned.map((d, i) => (i === 5 ? { ...d, status: 'picked' as const, by: 0 as const } : d));
    rerender(screenOf({ ...before, decks: picked }));
    expect(played).toEqual(['ui.gauntlet-ban', 'ui.gauntlet-pick']);
  });

  it('choosing your deck for the next game sounds on the press', () => {
    const onChoose = vi.fn();
    const decks = IDS.map((id, i) => (i < 4 ? deck(id, { status: 'banned', by: (i % 2) as 0 | 1 }) : deck(id, { status: 'picked', by: (i % 2) as 0 | 1 })));
    const { getByTestId } = render(screenOf(view({ phase: 'choose', step: null, decks, choice: { mine: null, chosen: [false, false] } }), onChoose));
    fireEvent.click(getByTestId('gauntlet-choose-mine').querySelector('[data-testid="gauntlet-deck"]')!);
    expect(played).toEqual(['ui.gauntlet-choose']);
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it('a deck the pool did not have before, or one whose status did not move, sounds nothing', () => {
    expect(poolChangeRoles([], [deck('a', { status: 'banned' })])).toEqual([]);
    expect(poolChangeRoles([deck('a', { status: 'banned' })], [deck('a', { status: 'banned' })])).toEqual([]);
  });

  it('each role is in the builder, and plays a sound the app already had until one is assigned', () => {
    for (const role of ['ui.gauntlet-deal', 'ui.gauntlet-ban', 'ui.gauntlet-pick', 'ui.gauntlet-choose']) {
      expect(SOUND_ROLES.get(role)?.bus).toBe('ui');
      expect(SOUND_ROLES.has(FALLBACK_ROLES[role]!), `${role} falls back to a real role`).toBe(true);
    }
  });
});
