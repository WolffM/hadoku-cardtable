/**
 * A card's colour, as one symbol — the one place a colour set becomes a symbol
 * or a key. A mono card is its colour's pip, a card of two or more colours is
 * ONE gold symbol (the operator, 2026-10-21: "just show a gold symbol for
 * multi-color"), a card of none is the colourless pip. There are no pair
 * symbols for a card's colour: Mana's `ms-wu`-style pairs are hybrid COST
 * symbols, and stay in `ManaPip`'s cost parser.
 *
 * Colours arrive in whatever order the source wrote them (Flame of Anor comes
 * as `['R','U']`), so nothing here may depend on that order.
 */

import type { ManaColor } from '../draft/types.ts';
import { ManaPip } from './ManaPip.tsx';

const WUBRG: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

/** `colors` as one key in WUBRG order, each colour once: `['R','U']` → `'UR'`, none → `''`. */
export function wubrgKey(colors: readonly ManaColor[]): string {
  return WUBRG.filter((c) => colors.includes(c)).join('');
}

/** A colour set's symbol: the colour itself, `'M'` (gold) for two or more, `'C'` for none. */
export type ColorSymbolId = ManaColor | 'M' | 'C';

export function colorSymbolOf(colors: readonly ManaColor[]): ColorSymbolId {
  const key = wubrgKey(colors);
  if (key === '') return 'C';
  if (key.length > 1) return 'M';
  return key as ManaColor;
}

/**
 * The symbol for a colour set, or for an already-resolved `symbol`. Gold is
 * Mana's own multicolour glyph in its two-tone gold (`ms-duo-color ms-grad`);
 * `.colorsym` gives the overlaid half its positioned box.
 */
export function ColorSymbol(props: { colors: readonly ManaColor[] } | { symbol: ColorSymbolId }) {
  const symbol = 'symbol' in props ? props.symbol : colorSymbolOf(props.colors);
  if (symbol !== 'M') return <ManaPip token={symbol} />;
  return <i className="colorsym ms ms-multicolor ms-duo ms-duo-color ms-grad" role="img" aria-label="multicolour" title="multicolour" />;
}
