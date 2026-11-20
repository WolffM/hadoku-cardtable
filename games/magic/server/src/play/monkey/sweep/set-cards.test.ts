/*
 * The sweep's card list is read off a Forge `res` tree. These build a small one on disk: the list
 * is the edition's `[cards]` section and nothing after it, each name once, and a card counts as
 * scripted when its script gives it more than plain keywords.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { boardFor } from './board.ts';
import { setCards } from './set-cards.ts';

const res = mkdtempSync(join(tmpdir(), 'sweep-res-'));
afterAll(() => rmSync(res, { recursive: true, force: true }));

function script(name: string, lines: string[]): void {
  const dir = join(res, 'cardsfolder', name[0]!.toLowerCase());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name.toLowerCase().replace(/[^a-z]+/g, '_')}.txt`), [`Name:${name}`, ...lines].join('\n'));
}

mkdirSync(join(res, 'editions'), { recursive: true });
writeFileSync(join(res, 'editions', 'Other.txt'), '[metadata]\nCode=OTH\n\n[cards]\n1 C Elsewhere @Nobody\n');
writeFileSync(
  join(res, 'editions', 'Tiny Set.txt'),
  ['[metadata]', 'Code=TNY', '', '[cards]', '1 C Plain Bear @An Artist', '2 U Gift Giver @An Artist', '3 R Fire, the Loud @Two Words', '4 L Forest @A', '5 L Forest @B', '', '[showcase]', '6 R Showcase Only @C'].join('\n'),
);
script('Plain Bear', ['Types:Creature Bear', 'K:Trample', 'K:Reach']);
script('Gift Giver', ['Types:Instant', 'K:Gift', 'A:SP$ Draw | NumCards$ 1']);
script('Fire, the Loud', ['Types:Legendary Creature Elemental', 'T:Mode$ Attacks | Execute$ TrigDamage']);
script('Forest', ['Types:Basic Land Forest']);
script('Showcase Only', ['Types:Creature Bear', 'A:AB$ Draw | Cost$ T']);

describe('setCards', () => {
  it('lists the [cards] section of the edition with that code, each name once, in collector order', () => {
    expect(setCards(res, 'TNY').map((c) => `${c.rarity} ${c.name}`)).toEqual(['C Plain Bear', 'U Gift Giver', 'R Fire, the Loud', 'L Forest']);
  });

  it('calls a card scripted when it has an ability, a trigger or a keyword that asks something, and not for plain keywords', () => {
    expect(Object.fromEntries(setCards(res, 'TNY').map((c) => [c.name, c.scripted]))).toEqual({ 'Plain Bear': false, 'Gift Giver': true, 'Fire, the Loud': true, Forest: false });
  });

  it('reads each keyword without its parameters', () => {
    expect(setCards(res, 'TNY').map((c) => c.keywords)).toEqual([['Trample', 'Reach'], ['Gift'], [], []]);
  });

  it('refuses a set whose edition names a card with no script, rather than sweep without it', () => {
    writeFileSync(join(res, 'editions', 'Broken.txt'), '[metadata]\nCode=BRK\n\n[cards]\n1 C No Such Card @Nobody\n');
    expect(() => setCards(res, 'BRK')).toThrow(/No Such Card/);
  });

  it('refuses a code no edition has', () => {
    expect(() => setCards(res, 'ZZZ')).toThrow(/Code=ZZZ/);
  });
});

describe('boardFor', () => {
  it('puts the card in seat 0 hand on its own main phase, with no blank line Forge would choke on', () => {
    const text = boardFor([setCards(res, 'TNY')[2]!]);
    expect(text).toMatch(/^humanhand=Fire, the Loud;/m);
    expect(text).toMatch(/^activeplayer=human$/m);
    expect(text).toMatch(/^activephase=MAIN1$/m);
    expect(text.split('\n').every((line) => line.length > 0)).toBe(true);
  });

  it('puts every card of a match in the hand, with lands for each', () => {
    const [bear, gift] = setCards(res, 'TNY');
    const text = boardFor([bear!, gift!]);
    expect(text).toMatch(/^humanhand=Plain Bear;Gift Giver;/m);
    expect(/^humanbattlefield=(.*)$/m.exec(text)![1]!.split(';').filter((c) => c === 'Island')).toHaveLength(8);
  });
});
