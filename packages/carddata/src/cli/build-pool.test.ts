/*
 * `cardColors` — the class fix for a gap the operator found live in the
 * shipped pool: Jace, Vryn's Prodigy showed colourless. Scryfall leaves the
 * CARD-level `colors` field off multi-faced layouts (`transform`,
 * `modal_dfc` — confirmed against `packages/carddata/data/cards.jsonl`:
 * every `colors === null` card there is one of `art_series`, `transform`,
 * `modal_dfc`, `double_faced_token` or `reversible_card`); the real colour
 * lives on each face instead. `split`, `flip`, `adventure` and `meld` cards
 * already carry a card-level `colors` in the data (Fire // Ice: `['R','U']`),
 * so the "union of the faces" branch below is a correctness net for data
 * that varies, not the common path — tested directly anyway, per layout.
 *
 * One function, used by every `toDraftCard` call, so the fix lands for all
 * 8 shortlist cube builds (and the UI's bundled pool, regenerated
 * separately) at once rather than per-card.
 */

import { describe, expect, it } from 'vitest';
import { cardColors } from './build-pool.ts';

describe('cardColors', () => {
  it('Jace, Vryn\'s Prodigy // Jace, Telepath Unbound (transform): the front face\'s colour, not colourless', () => {
    const jace = {
      layout: 'transform',
      colors: null,
      card_faces: [{ colors: ['U'] }, { colors: ['U'] }],
    };
    expect(cardColors(jace)).toEqual(['U']);
  });

  it('a modal DFC whose two faces differ still takes the FRONT face\'s colour', () => {
    const mdfc = {
      layout: 'modal_dfc',
      colors: null,
      card_faces: [{ colors: ['W'] }, { colors: ['B'] }],
    };
    expect(cardColors(mdfc)).toEqual(['W']);
  });

  it('Fire // Ice (split): both halves are one card — union of the faces', () => {
    const fireIce = {
      layout: 'split',
      colors: null,
      card_faces: [{ colors: ['R'] }, { colors: ['U'] }],
    };
    expect(cardColors(fireIce)).toEqual(['R', 'U']);
  });

  it('an adventure card unions its faces the same way', () => {
    const adventure = {
      layout: 'adventure',
      colors: null,
      card_faces: [{ colors: ['U'] }, { colors: ['U'] }],
    };
    expect(cardColors(adventure)).toEqual(['U']);
  });

  it('the common case — a card-level colors array already present — is unaffected', () => {
    expect(cardColors({ colors: ['G'] })).toEqual(['G']);
    expect(cardColors({ colors: ['R', 'U'], layout: 'split' })).toEqual(['R', 'U']);
  });

  it('a colourless card, with or without faces, stays colourless', () => {
    expect(cardColors({ colors: [] })).toEqual([]);
    expect(cardColors({})).toEqual([]);
    expect(cardColors({ layout: 'transform', colors: null, card_faces: [{ colors: [] }, { colors: [] }] })).toEqual([]);
  });

  it('drops a value Scryfall never sends — defence, not data we expect', () => {
    expect(cardColors({ colors: ['G', 'X', 7] })).toEqual(['G']);
  });
});
