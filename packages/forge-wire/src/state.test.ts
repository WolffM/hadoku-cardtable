import { describe, expect, it } from 'vitest';

import { deltaKeyOf } from './tier-c.ts';
import { cardIdOfState, cardStateKey, coreTypes, currentFace, DELTA_TYPE, deltaKey, idsOf, intOf, strOf, type PropertyBag } from './state.ts';

const card = (id: number, props: PropertyBag = {}): [string, PropertyBag] => [deltaKey(DELTA_TYPE.card, id), { _type: DELTA_TYPE.card, _id: id, ...props }];
const face = (cardId: number, ordinal: number, props: PropertyBag): [string, PropertyBag] => [
  cardStateKey(cardId, ordinal),
  { _type: DELTA_TYPE.cardState, _id: cardId * 16 + ordinal, ...props },
];
const cardtype = (core: string[]) => ({ t: 'cardtype', sup: [], core, sub: [], all: false, exc: [] });

describe('delta keys', () => {
  it('is the decimal spelling of makeDeltaKey, and a state id finds its card again', () => {
    expect(deltaKey(DELTA_TYPE.game, 1)).toBe(String(deltaKeyOf(3, 1)));
    expect(cardStateKey(7, 2)).toBe(String(deltaKeyOf(4, 7 * 16 + 2)));
    expect(cardIdOfState(7 * 16 + 2)).toBe(7);
  });
});

describe('readers', () => {
  it('read absent, null and other-tagged values as absent', () => {
    const obj = { a: { t: 'int', v: 3 }, b: null, c: { t: 'str', v: 'x' }, d: { t: 'long', v: 9 } };
    expect(intOf(obj, 'a')).toBe(3);
    expect(intOf(obj, 'd')).toBe(9);
    expect(intOf(obj, 'b')).toBeNull();
    expect(intOf(obj, 'c')).toBeNull();
    expect(strOf(obj, 'c')).toBe('x');
    expect(intOf(undefined, 'a')).toBeNull();
  });

  it('drops Forge’s -1 from an id list', () => {
    expect(idsOf({ L: { t: 'list', v: [{ t: 'int', v: 4 }, { t: 'int', v: -1 }, null] } }, 'L')).toEqual([4]);
  });
});

describe('currentFace and coreTypes', () => {
  it('follow the card’s CurrentState to the face it shows', () => {
    const state = new Map([card(5, { CurrentState: { t: 'int', v: 1 } }), face(5, 0, { Type: cardtype(['Creature']) }), face(5, 1, { Type: cardtype(['Land']) })]);
    expect(currentFace(state, 5)?._id).toBe(5 * 16 + 1);
    expect(coreTypes(state, 5)).toEqual(['Land']);
  });

  it('say null for a face whose type is not known, which is not a face with no types', () => {
    expect(coreTypes(new Map([card(5)]), 5)).toBeNull();
    expect(coreTypes(new Map([card(5), face(5, 0, { Type: cardtype([]) })]), 5)).toEqual([]);
  });
});
