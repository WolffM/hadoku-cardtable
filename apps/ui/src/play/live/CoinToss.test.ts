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

import { CoinToss, FLIP_MS } from './CoinToss.tsx';

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
    const { getByTestId } = render(createElement(CoinToss, { winner: 0, name: 'Alice', avatarId: undefined, loserAvatarId: undefined, at: Date.now() }));
    expect(getByTestId('coin-toss').style.getPropertyValue('--flip-ms')).toBe(`${FLIP_MS}ms`);
  });

  it('a screen that learns of the toss late joins the same flip part-way, so both land together', () => {
    const { getByTestId } = render(createElement(CoinToss, { winner: 0, name: 'Alice', avatarId: undefined, loserAvatarId: undefined, at: Date.now() - 800 }));
    const delay = Number.parseFloat(getByTestId('coin-toss').style.getPropertyValue('--flip-delay'));
    expect(delay).toBeLessThanOrEqual(-800);
    expect(delay).toBeGreaterThan(-900);
  });
});
