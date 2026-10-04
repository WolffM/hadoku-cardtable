import { describe, expect, it } from 'vitest';

import type { WireObject } from '../wire.ts';
import { cardStateKey, deltaKey, WireType } from '../wire.ts';
import { lookupFromState } from './lookup.ts';

const card = (id: number): [string, WireObject] => [deltaKey(WireType.Card, id), { _type: WireType.Card, _id: id }];
const face = (id: number, name: string, setCode: string): [string, WireObject] => [
  cardStateKey(id, 0),
  { _type: WireType.CardState, _id: id * 16, Name: { t: 'str', v: name }, SetCode: { t: 'str', v: setCode } },
];

describe('lookupFromState', () => {
  it("reads a card's name and set code off its current face", () => {
    const lookup = lookupFromState(new Map([card(12), face(12, 'Forest', 'TRK')]));
    expect(lookup.card(12)).toMatchObject({ name: 'Forest', setCode: 'TRK' });
  });

  // prompts.jvm, 2026-10-03: a card another player revealed reached seat 1 as
  // an object with no face yet. An invented name ("card #47") became the art
  // key; null lets the caller fall back to Forge's own label.
  it('a card object whose face has not arrived has facts with a null name, never an invented one', () => {
    const lookup = lookupFromState(new Map([card(47)]));
    expect(lookup.card(47)?.name).toBeNull();
  });

  it('no object at all is no facts', () => {
    expect(lookupFromState(new Map()).card(5)).toBeUndefined();
  });
});
