// @vitest-environment jsdom
/**
 * The symbols are the fonts', and these tests say which fonts and which classes.
 *
 * D20 (operator, 2026-09-27) replaced "we draw our own" with Keyrune and Mana
 * (`docs/LICENSING.md` §3.2). So the old assertions — a disc per colour, the
 * Phyrexian mark as a dashed ring, `{T}` spelled TAP — are gone, and what is
 * pinned instead is the thing that can actually break silently:
 *
 *   1. **Every class `ManaPip` can emit exists in the vendored CSS.** Read out of
 *      `../symbols/mana.css` rather than asserted from memory, so a re-vendor
 *      that drops a glyph fails here instead of shipping an empty box.
 *   2. **A hybrid goes through Mana's OWN split.** `ms-cost` plus the pair's
 *      class, and nothing of ours. A hand-rolled split renders `{W}` fine and
 *      breaks `{W/U}`, which is the whole reason the pack ships whole.
 *   3. **An unrecognised token is still printed.** Pre-D20 rule, unchanged: a
 *      cost that silently drops a symbol is worse than an ugly one.
 *   4. **`.pip` + `data-token` still locate a symbol.** Three test files outside
 *      this file's lane select on that pair; it is a contract, not styling.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';

import { colorWordToken, ManaCost, ManaPip, SetSymbol, readManaToken } from './ManaPip.tsx';
import { CardTile } from './CardTile.tsx';
import type { DraftCard } from '../draft/types.ts';

afterEach(cleanup);

const here = import.meta.dirname ?? 'apps/ui/src/components';
const MANA_CSS = readFileSync(resolve(here, '../symbols/mana.css'), 'utf8');
const KEYRUNE_CSS = readFileSync(resolve(here, '../symbols/keyrune.css'), 'utf8');

/** Every `ms-…` the vendored pack gives a glyph to, i.e. has a `::before` for. */
const manaGlyphs = (): Set<string> => {
  const found = new Set<string>();
  for (const m of MANA_CSS.matchAll(/\.ms-([a-z0-9-]+)::?before\b/g)) found.add(m[1]);
  return found;
};

/** Same for Keyrune's set symbols. */
const setGlyphs = (): Set<string> => {
  const found = new Set<string>();
  for (const m of KEYRUNE_CSS.matchAll(/\.ss-([a-z0-9-]+)::?before\b/g)) found.add(m[1]);
  return found;
};

/** The ten hybrid pairs, in the order the font names them. */
const PAIRS = ['WU', 'WB', 'UB', 'UR', 'BR', 'BG', 'RW', 'RG', 'GW', 'GU'];

/**
 * Every token the app can hand `ManaPip`. `play/adapter.ts`'s `SHARD_TOKEN` is
 * the authority for the cost side — all 41 of its values are here — plus the
 * generic amounts, and the tokens that only ever turn up inline in rules text
 * (`{T}`, `{Q}`, `{E}`).
 */
const EVERY_TOKEN = [
  ...Array.from({ length: 21 }, (_, i) => String(i)),
  '100',
  '1000000',
  'W',
  'U',
  'B',
  'R',
  'G',
  'C',
  'S',
  'X',
  'Y',
  'Z',
  'E',
  'P',
  'T',
  'Q',
  '½',
  '∞',
  ...PAIRS.map((p) => `${p[0]}/${p[1]}`),
  ...PAIRS.map((p) => `${p[0]}/${p[1]}/P`),
  ...['W', 'U', 'B', 'R', 'G'].map((c) => `2/${c}`),
  ...['W', 'U', 'B', 'R', 'G'].map((c) => `C/${c}`),
  ...['W', 'U', 'B', 'R', 'G'].map((c) => `${c}/P`),
];

describe('reading a cost token', () => {
  it('maps the five colours, the odd ones and a generic amount to the font class', () => {
    expect(readManaToken('W').mana).toBe('w');
    expect(readManaToken('U').mana).toBe('u');
    expect(readManaToken('B').mana).toBe('b');
    expect(readManaToken('R').mana).toBe('r');
    expect(readManaToken('G').mana).toBe('g');
    expect(readManaToken('C').mana).toBe('c');
    expect(readManaToken('S').mana).toBe('s');
    expect(readManaToken('X').mana).toBe('x');
    expect(readManaToken('Y').mana).toBe('y');
    expect(readManaToken('Z').mana).toBe('z');
    expect(readManaToken('E').mana).toBe('e');
    expect(readManaToken('0').mana).toBe('0');
    expect(readManaToken('12').mana).toBe('12');
  });

  it('maps tap and untap to the font too, instead of spelling them out', () => {
    expect(readManaToken('T').mana).toBe('tap');
    expect(readManaToken('Q').mana).toBe('untap');
  });

  it('gives a hybrid the pair class, in the order the font names it', () => {
    expect(readManaToken('W/U').mana).toBe('wu');
    expect(readManaToken('R/W').mana).toBe('rw');
    expect(readManaToken('G/U').mana).toBe('gu');
    // Written the other way round by some other source: still the font's pair,
    // never an `ms-uw` that does not exist.
    expect(readManaToken('U/W').mana).toBe('wu');
    expect(readManaToken('W/R').mana).toBe('rw');
  });

  it('gives a twobrid and a colourless hybrid the generic half first', () => {
    expect(readManaToken('2/W').mana).toBe('2w');
    expect(readManaToken('2/G').mana).toBe('2g');
    expect(readManaToken('C/U').mana).toBe('cu');
  });

  it('gives Phyrexian the colour plus p, and hybrid Phyrexian the pair plus p', () => {
    expect(readManaToken('B/P').mana).toBe('bp');
    expect(readManaToken('W/P').mana).toBe('wp');
    expect(readManaToken('W/U/P').mana).toBe('wup');
    expect(readManaToken('G/U/P').mana).toBe('gup');
  });

  it('has no class for a token it does not know, and keeps the token as the label', () => {
    expect(readManaToken('ZZZ').mana).toBe(null);
    expect(readManaToken('ZZZ').label).toBe('ZZZ');
    // A generic amount past the font's 20 (100 and 1000000 excepted).
    expect(readManaToken('21').mana).toBe(null);
    expect(readManaToken('21').label).toBe('21');
    // `{1/2}` is not a hybrid of 1 and 2 — the half symbol's token is `½`.
    expect(readManaToken('1/2').mana).toBe(null);
    expect(readManaToken('½').mana).toBe('1-2');
  });
});

describe('reading a Forge colour-question label', () => {
  // `DialogPrompts.tsx`'s `showOptionDialog` — Forge's "Select Mana to
  // Produce" names the colours in words (T2: folded here from a second table).
  it('maps the five colour words and both colourless spellings to a token', () => {
    expect(colorWordToken('White')).toBe('W');
    expect(colorWordToken(' blue ')).toBe('U');
    expect(colorWordToken('Black')).toBe('B');
    expect(colorWordToken('Red')).toBe('R');
    expect(colorWordToken('Green')).toBe('G');
    expect(colorWordToken('Colorless')).toBe('C');
    expect(colorWordToken('Colourless')).toBe('C');
  });

  it('is null for a label that names no colour, so the caller draws it as text', () => {
    expect(colorWordToken('Play first')).toBeNull();
  });
});

describe('the fonts actually carry what we ask for', () => {
  it('has a glyph for every class ManaPip can emit', () => {
    const glyphs = manaGlyphs();
    const missing = EVERY_TOKEN.map((t) => readManaToken(t).mana).filter(
      (cls) => cls === null || !glyphs.has(cls),
    );
    expect(missing).toEqual([]);
    // Sanity: the set was really read, not silently empty.
    expect(glyphs.size).toBeGreaterThan(400);
  });

  it('has a set symbol for all 12 set codes the nine eras use', () => {
    const glyphs = setGlyphs();
    const eras = ['AVR', 'DKA', 'ISD', 'M11', 'M12', 'M13', 'MBS', 'NPH', 'ROE', 'SOM', 'WWK', 'ZEN'];
    expect(eras.filter((code) => !glyphs.has(code.toLowerCase()))).toEqual([]);
  });
});

describe('rendering a pip', () => {
  it('is an element we build carrying a vendored class, never an image', () => {
    const { container } = render(createElement(ManaPip, { token: 'R' }));
    expect(container.querySelectorAll('img')).toHaveLength(0);
    // The `.pip` + `data-token` pair three other suites select on.
    const pip = container.querySelector('.pip');
    expect(pip?.tagName).toBe('SPAN');
    expect(pip?.getAttribute('data-token')).toBe('R');
    const glyph = container.querySelector('.ms');
    expect(glyph?.className).toBe('ms ms-r ms-cost');
    expect(glyph?.getAttribute('aria-label')).toBe('red');
  });

  it('draws a hybrid through Mana’s own split, not one of ours', () => {
    const { container } = render(createElement(ManaPip, { token: 'W/U' }));
    const glyph = container.querySelector('.ms');
    // `ms-cost` is what drives `--ms-split-top` / `--ms-split-bottom` and the
    // two half-glyphs; without it a hybrid is a blank disc.
    expect(glyph?.classList.contains('ms-cost')).toBe(true);
    expect(glyph?.classList.contains('ms-wu')).toBe(true);
    // No hand-rolled split survives anywhere in the tree.
    expect(container.querySelectorAll('[class*="pip--split"]')).toHaveLength(0);
  });

  it('draws a twobrid and a Phyrexian pip through the same split system', () => {
    const two = render(createElement(ManaPip, { token: '2/W' }));
    expect(two.container.querySelector('.ms')?.className).toBe('ms ms-2w ms-cost');
    cleanup();
    const phy = render(createElement(ManaPip, { token: 'B/P' }));
    expect(phy.container.querySelector('.ms')?.className).toBe('ms ms-bp ms-cost');
  });

  it('prints an unrecognised token rather than dropping it', () => {
    const { container } = render(createElement(ManaPip, { token: 'ZZZ' }));
    const pip = container.querySelector('.pip');
    expect(pip?.textContent).toBe('ZZZ');
    expect(container.querySelectorAll('.ms')).toHaveLength(0);
  });

  it('a cost renders one pip per token, in order', () => {
    const { container } = render(createElement(ManaCost, { cost: ['1', 'B/P', 'B/P'] }));
    const pips = [...container.querySelectorAll('.pip')];
    expect(pips.map((p) => p.getAttribute('data-token'))).toEqual(['1', 'B/P', 'B/P']);
    expect(pips.map((p) => p.querySelector('.ms')?.className)).toEqual([
      'ms ms-1 ms-cost',
      'ms ms-bp ms-cost',
      'ms ms-bp ms-cost',
    ]);
  });

  it('an empty cost renders nothing at all, so a land shows no pip', () => {
    const { container } = render(createElement(ManaCost, { cost: [] }));
    expect(container.querySelectorAll('.pip')).toHaveLength(0);
  });
});

describe('a set symbol', () => {
  it('is Keyrune’s glyph for the lowercased code', () => {
    const { container } = render(createElement(SetSymbol, { code: 'ZEN' }));
    expect(container.querySelector('.ss')?.className).toBe('ss ss-zen');
    expect(container.querySelector('.setsym')?.getAttribute('aria-label')).toBe('set ZEN');
  });

  it('carries the raw code, so a set with no glyph degrades to its code', () => {
    // H2R is one of the three cube set codes Keyrune has no glyph for.
    expect(setGlyphs().has('h2r')).toBe(false);
    const { container } = render(createElement(SetSymbol, { code: 'H2R' }));
    expect(container.textContent).toContain('H2R');
  });

  it('takes an accessible name when given one', () => {
    const { container } = render(createElement(SetSymbol, { code: 'ZEN', label: 'Zendikar' }));
    expect(container.querySelector('.setsym')?.getAttribute('aria-label')).toBe('Zendikar');
  });
});

const TAP_CARD: DraftCard = {
  cardId: 'test/tap',
  name: 'Test Lands',
  manaCost: [],
  manaValue: 0,
  colors: [],
  typeLine: 'Land',
  oracleText: '{T}: Add {C}.\n{T}, Sacrifice Test Lands: Draw a card.',
  setCode: 'ZEN',
  collectorNumber: '1',
  rarity: 'uncommon',
};

describe('a card tile', () => {
  it('draws the tap symbol from the font now, not the word TAP', () => {
    const { container } = render(createElement(CardTile, { card: TAP_CARD }));
    const taps = [...container.querySelectorAll('.ms-tap')];
    expect(taps).toHaveLength(2);
    expect(container.textContent).not.toContain('TAP');
    // The braces are consumed, not printed.
    expect(container.textContent).not.toContain('{T}');
  });

  it('turns inline mana symbols in rules text into the same pips as a cost', () => {
    const { container } = render(createElement(CardTile, { card: TAP_CARD }));
    const tokens = [...container.querySelectorAll('.pip[data-token]')].map((p) =>
      p.getAttribute('data-token'),
    );
    expect(tokens).toContain('C');
    expect(container.querySelector('.pip[data-token="C"] .ms')?.className).toBe('ms ms-c ms-cost');
    expect(container.textContent).not.toContain('{C}');
  });

  it('shows the set symbol in the print line, with its code beside it', () => {
    const { container } = render(createElement(CardTile, { card: TAP_CARD }));
    const print = container.querySelector('.card__print');
    expect(print?.querySelector('.ss')?.className).toBe('ss ss-zen');
    expect(print?.textContent).toContain('ZEN');
  });
});

/**
 * No native browser tooltip anywhere on a card. The operator, 2026-10-27:
 * hovering a 15/15 Wurmcoil Engine on the battlefield popped up "Generic 6"
 * (the font's `title` on its cost pip) and "Power 15, toughness 15" (a tip
 * that told a sighted mouse user nothing the badge did not already show).
 * Every number and letter on a tile is drawn as text already — a `title`
 * on top of it is always a duplicate, never information. `aria-label` stays:
 * it is the one thing a screen reader gets and nothing visual repeats it.
 */
describe('no native tooltips on a card (the operator, 2026-10-27)', () => {
  const CREATURE: DraftCard = {
    cardId: 'test/creature',
    name: 'Test Wurm',
    manaCost: ['6'],
    manaValue: 6,
    colors: [],
    typeLine: 'Artifact Creature — Wurm',
    oracleText: 'Deathtouch, lifelink',
    power: '6',
    toughness: '6',
    setCode: 'ZEN',
    collectorNumber: '1',
    rarity: 'rare',
  };

  const PLANESWALKER: DraftCard = {
    ...CREATURE,
    cardId: 'test/walker',
    name: 'Test Walker',
    typeLine: 'Planeswalker',
    power: undefined,
    toughness: undefined,
    loyalty: '5',
  };

  it('carries no title on the mana cost, the P/T badge, the rarity letter or the set symbol', () => {
    const { container } = render(createElement(CardTile, { card: CREATURE }));
    expect([...container.querySelectorAll('[title]')]).toHaveLength(0);
  });

  it('nor on a planeswalker’s loyalty', () => {
    const { container } = render(createElement(CardTile, { card: PLANESWALKER }));
    expect([...container.querySelectorAll('[title]')]).toHaveLength(0);
  });

  it('still names each of them to a screen reader, with aria-label', () => {
    const { container } = render(createElement(CardTile, { card: CREATURE }));
    expect(container.querySelector('.ms-cost')?.getAttribute('aria-label')).toBe('6 generic');
    expect(container.querySelector('.card__rarity')?.getAttribute('aria-label')).toBe('rare');
    expect(container.querySelector('.card__stat')?.getAttribute('aria-label')).toBe('power / toughness 6/6');
  });
});
