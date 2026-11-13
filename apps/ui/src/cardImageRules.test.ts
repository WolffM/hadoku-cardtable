/*
 * Scryfall's image guidelines, held by the stylesheets: "Do not blur, sharpen,
 * desaturate, or color-shift card images." A state a card is in (summoning
 * sick, countered, disabled) is drawn as a layer over the image or as motion,
 * never as a filter on it — and a filter on any ancestor of a card image is a
 * filter on the image.
 *
 * One exception, the operator's (docs/DECISIONS.md D22): a spell held on the stack is seen through a
 * heat haze and a little more saturated. It is listed by its exact selector, so any other rule that
 * filters a card still fails here.
 */

// @reads apps/ui/src/*.css packages/ui-shell/src/*.css packages/game-ui/src/*.css
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { uiPath, uiSheets } from './ui-sources.testing.ts';

const COLOUR_FILTER = /(?<!backdrop-)filter:\s*[^;]*\b(grayscale|brightness|saturate|sepia|hue-rotate|blur|contrast|invert)\(/;
const CARD_SELECTOR = /card|art|chip|deck|placed|stack|pile|hand|inspect|board/i;
const ALLOWED = new Set(['.placed__hover > :is(.placed__tile, .placed__back)']);

describe('card images are never filtered', () => {
  it('no rule that can reach a card image carries a colour filter', () => {
    const offenders: string[] = [];
    for (const file of uiSheets()) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = rule[1]!.trim();
        if (ALLOWED.has(selector)) continue;
        if (CARD_SELECTOR.test(selector) && COLOUR_FILTER.test(rule[2]!)) offenders.push(`${uiPath(file)}: ${selector}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
