// @vitest-environment jsdom
/*
 * The operator, 2026-10-09: "coinflip animation is too fast and flips too many times". The flip's
 * length lives in one place (`FLIP_MS`) and reaches the stylesheet as `--flip-ms`; a late screen joins
 * the same flip part-way through rather than starting it over.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { CoinToss, FLIP_MS, SideFace, TossCoin } from './CoinToss.tsx';
import { CoinFlips, freshFlips, FLIP_LINGER_MS, FLIPS_SHOWN } from './coin-flip.tsx';
import { shownFlip } from './shown.ts';

const CSS = readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/play/live', 'coin-toss.css'), 'utf8');

afterEach(cleanup);

describe('the coin toss’s pace', () => {
  it('flips for at least two seconds, three turns at most', () => {
    expect(FLIP_MS).toBeGreaterThanOrEqual(2000);
    const turns = Number(/rotateY\((\d+(?:\.\d+)?)turn\)\s*translateY/.exec(CSS)?.[1]);
    expect(turns).toBeGreaterThan(0);
    expect(turns, 'whole turns, so it lands on the winner’s face').toBe(Math.round(turns));
    expect(turns).toBeLessThanOrEqual(3);
  });

  it('the stylesheet takes its length from FLIP_MS, never a second number', () => {
    expect(CSS).toMatch(/animation:\s*coin-toss-flip\s+var\(--flip-ms\)/);
    const { getByTestId } = render(createElement(TossCoin, { toss: { winner: 0, name: 'Alice', avatarId: undefined, loserAvatarId: undefined, at: Date.now() } }));
    expect(getByTestId('coin-toss').style.getPropertyValue('--flip-ms')).toBe(`${FLIP_MS}ms`);
  });

  it('a screen that learns of the toss late joins the same flip part-way, so both land together', () => {
    const { getByTestId } = render(createElement(TossCoin, { toss: { winner: 0, name: 'Alice', avatarId: undefined, loserAvatarId: undefined, at: Date.now() - 800 } }));
    const delay = Number.parseFloat(getByTestId('coin-toss').style.getPropertyValue('--flip-delay'));
    expect(delay).toBeLessThanOrEqual(-800);
    expect(delay).toBeGreaterThan(-900);
  });
});

describe('the loser’s wait (the operator, 2026-10-09: "after coinflip is complete, it should show a waiting text for the person who lost")', () => {
  it('once the coin lands, the seat that lost reads that the winner is choosing — never during the flip', () => {
    const flipping = render(createElement(TossCoin, { toss: { winner: 0, name: 'Alice', avatarId: undefined, loserAvatarId: undefined, at: Date.now() }, waiting: true }));
    expect(flipping.queryByTestId('coin-toss-wait'), 'not while it flips').toBeNull();
    cleanup();
    const landed = render(createElement(TossCoin, { toss: { winner: 0, name: 'Alice', avatarId: undefined, loserAvatarId: undefined, at: Date.now() - FLIP_MS - 50 }, waiting: true }));
    expect(landed.getByTestId('coin-toss-wait').textContent).toBe('Alice is choosing to play or draw…');
  });

  it('the winner, who is the one choosing, never reads it', () => {
    const { queryByTestId } = render(createElement(TossCoin, { toss: { winner: 0, name: 'Alice', avatarId: undefined, loserAvatarId: undefined, at: Date.now() - FLIP_MS - 50 } }));
    expect(queryByTestId('coin-toss-wait')).toBeNull();
  });
});

describe('a coin flipped in the game is the same coin (the operator, 2026-10-27: "for coin flip we should just use the coinflip animation we already have")', () => {
  const flip = (over: Partial<Parameters<typeof shownFlip>[0]> = {}, at = Date.now()) =>
    shownFlip({ player: { kind: 'player', id: 0 }, outcome: 'heads', won: null, source: { kind: 'card', id: 9 }, ...over }, 'Alice’s flip comes up heads', at);

  it('lands on the face Forge’s flip came up, heads or tails on its two sides, Forge’s words under it', () => {
    const { getAllByTestId } = render(createElement(CoinFlips, { flips: [flip({ outcome: 'tails' })], viewer: 0, onFlip: () => undefined }));
    const [coin] = getAllByTestId('coin-flip');
    expect(coin!.dataset).toMatchObject({ outcome: 'tails', flipper: 'you' });
    expect(coin!.querySelector('.coin-toss__face--front')!.textContent).toBe('T');
    expect(coin!.querySelector('.coin-toss__face--back')!.textContent).toBe('H');
    expect(coin!.querySelector('.coin-toss__name')!.textContent).toBe('Alice’s flip comes up heads');
    expect(coin!.style.getPropertyValue('--flip-ms'), 'the toss’s own pace').toBe(`${FLIP_MS}ms`);
  });

  it('a called flip says whether the call was won; an uncalled one says nothing of it', () => {
    const won = render(createElement(CoinToss, { front: createElement(SideFace, { side: 'heads' }), back: null, caption: '', at: 0, won: true }));
    expect(won.getByTestId('coin-toss').dataset.won).toBe('true');
    cleanup();
    const lost = render(createElement(CoinToss, { front: null, back: null, caption: '', at: 0, won: false }));
    expect(lost.getByTestId('coin-toss').dataset.won).toBe('false');
    cleanup();
    const uncalled = render(createElement(CoinToss, { front: null, back: null, caption: '', at: 0, won: null }));
    expect('won' in uncalled.getByTestId('coin-toss').dataset).toBe(false);
    expect(CSS).toMatch(/\[data-won='true'\][^{]*\{[^}]*var\(--success\)/);
    expect(CSS).toMatch(/\[data-won='false'\][^{]*\{[^}]*var\(--danger\)/);
  });

  it('the other seat’s flip is theirs; each new flip is told once, a stale one never', () => {
    const told: number[] = [];
    const a = flip({ player: { kind: 'player', id: 1 } });
    const stale = flip({}, Date.now() - FLIP_MS - 10);
    const view = render(createElement(CoinFlips, { flips: [stale, a], viewer: 0, onFlip: (f) => told.push(f.id) }));
    expect(view.getAllByTestId('coin-flip').at(-1)!.dataset.flipper).toBe('them');
    view.rerender(createElement(CoinFlips, { flips: [stale, a], viewer: 0, onFlip: (f) => told.push(f.id) }));
    expect(told).toEqual([a.id]);
  });

  it('keeps a coin a moment after it lands, then lets it go; a run of flips shows its latest few', () => {
    const now = Date.now();
    expect(freshFlips([flip({}, now - FLIP_MS - FLIP_LINGER_MS + 10)], now)).toHaveLength(1);
    expect(freshFlips([flip({}, now - FLIP_MS - FLIP_LINGER_MS - 10)], now)).toHaveLength(0);
    const run = Array.from({ length: FLIPS_SHOWN + 3 }, () => flip({}, now));
    expect(freshFlips(run, now)).toEqual(run.slice(-FLIPS_SHOWN));
  });
});
