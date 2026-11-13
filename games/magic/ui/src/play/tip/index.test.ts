// @vitest-environment jsdom
/**
 * The board's tooltip: which element's words answer a pointer (`tipAt`), where
 * the tip goes (`placeTip`), and what the marks and a forbidden card say
 * (`words.ts`). jsdom zeroes every box, so `tipAt` gets real boxes stubbed on.
 */
import { describe, expect, it } from 'vitest';

import { placeTip, tipAt } from './index.ts';
import { castForbiddenTip, costTip, flashTip, keywordTip, MARK_TIP } from './words.ts';

function box(el: Element, left: number, top: number, width: number, height: number): void {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

function card(): { li: HTMLElement; face: HTMLElement; sick: HTMLElement; member: HTMLElement } {
  document.body.innerHTML = `
    <li class="board-card" data-board-card="1">
      <button class="board-card__face"><div class="card">art</div></button>
      <ul class="board-card__marks"><li class="board-card__mark" data-mark="sick" data-tip="sick words"></li></ul>
      <ul class="board-card__pile"><li class="board-card" data-board-card="2"><button class="board-card__face"></button>
        <ul class="board-card__marks"><li class="board-card__mark" data-mark="blocking" data-tip="blocking words"></li></ul></li></ul>
    </li>`;
  const li = document.querySelector<HTMLElement>('[data-board-card="1"]')!;
  const face = li.querySelector<HTMLElement>(':scope > .board-card__face')!;
  const sick = li.querySelector<HTMLElement>('[data-mark="sick"]')!;
  const member = document.querySelector<HTMLElement>('[data-board-card="2"]')!;
  box(li, 0, 0, 100, 140);
  box(face, 0, 0, 100, 140);
  box(sick, 2, 2, 14, 14);
  box(member.querySelector('[data-mark="blocking"]')!, 10, 10, 14, 14);
  return { li, face, sick, member };
}

describe('tipAt', () => {
  it("answers a mark by its box, though the mark takes no pointer events and the target is the card's face", () => {
    const { face, sick } = card();
    expect(tipAt(face, 8, 8)).toBe(sick);
  });

  it('answers nothing over the rest of the card: the art is the inspector’s, not a mark’s', () => {
    const { face } = card();
    expect(tipAt(face, 50, 70)).toBeNull();
  });

  it("never answers with a mark of a card stacked on this one", () => {
    const { face } = card();
    expect(tipAt(face, 20, 20)).toBeNull();
  });

  it('answers with the card itself when the card carries the words (a forbidden hand card)', () => {
    const { li, face } = card();
    li.dataset.tip = 'card words';
    expect(tipAt(face, 50, 70)).toBe(li);
    expect(tipAt(face, 8, 8)?.dataset.tip, 'a mark still wins over its own card').toBe('sick words');
  });

  it('answers a mark drawn on the card’s own tile — a Room’s door — by its box', () => {
    const { face } = card();
    face.innerHTML = '<span class="board-card__doors"><span class="board-card__door"><article class="card"><span class="card__door" data-tip="Locked door"></span></article></span></span>';
    const lock = face.querySelector<HTMLElement>('.card__door')!;
    box(lock, 40, 20, 14, 14);
    expect(tipAt(face, 45, 25)).toBe(lock);
    expect(tipAt(face, 50, 100), 'not elsewhere on the door').toBeNull();
  });

  it('answers off the cards with the nearest element that carries words', () => {
    document.body.innerHTML = '<ol><li data-tip="stop words"><span>Upkeep</span></li></ol>';
    expect(tipAt(document.querySelector('span')!, 0, 0)?.dataset.tip).toBe('stop words');
  });
});

describe('placeTip', () => {
  const layer = { left: 100, top: 50, width: 800, height: 600 };
  it('sits below and right of the pointer, in the layer’s own coordinates', () => {
    expect(placeTip({ x: 300, y: 200 }, { width: 120, height: 30 }, layer)).toEqual({ left: 212, top: 166 });
  });
  it('flips to the pointer’s other side at the layer’s right and bottom edges', () => {
    expect(placeTip({ x: 880, y: 630 }, { width: 120, height: 30 }, layer)).toEqual({ left: 648, top: 534 });
  });
});

describe('words', () => {
  it('names each corner mark', () => {
    expect(MARK_TIP.sick).toMatch(/^Summoning sick/);
    expect(MARK_TIP.blocking).toBe('Blocking');
    expect(MARK_TIP.cantBlock).toBe("Can't block");
    expect(MARK_TIP.attacking).toBe('Attacking');
  });

  it('says what a granted keyword does', () => {
    expect(keywordTip('Flying')).toMatch(/^Flying: can't be blocked except by creatures with flying or reach/);
    expect(keywordTip('Banding')).toBe('Banding (from an effect)');
  });

  it('names the forbidding card and how long, from the viewer’s side', () => {
    const players = [
      { id: 7, name: 'Bob' },
      { id: 3, name: 'Alice' },
    ];
    expect(castForbiddenTip({ source: 'Reflector Mage', duration: 'UntilYourNextTurn', durationPlayer: 3 }, players, 7)).toBe(
      "Can't be cast: Reflector Mage, until Alice's next turn",
    );
    expect(castForbiddenTip({ source: 'Reflector Mage', duration: 'UntilYourNextTurn', durationPlayer: 7 }, players, 7)).toBe(
      "Can't be cast: Reflector Mage, until your next turn",
    );
    expect(castForbiddenTip({ source: 'Silence', duration: 'EndOfTurn', durationPlayer: 3 }, players, 7)).toBe("Can't be cast: Silence, this turn");
    expect(castForbiddenTip({ source: 'Meddling Mage' }, players, 7)).toBe("Can't be cast: Meddling Mage");
  });

  it('says what a held card costs now, what it would, and which cards changed it', () => {
    expect(costTip({ now: ['U'], printed: ['1', 'U'], by: ["Jace's Sanctum"] })).toBe("Costs {U} instead of {1}{U}: Jace's Sanctum");
    expect(costTip({ now: ['2', 'R'], printed: ['R'], by: ['Thalia, Guardian of Thraben', 'Sphere of Resistance'] })).toBe(
      'Costs {2}{R} instead of {R}: Thalia, Guardian of Thraben, Sphere of Resistance',
    );
    expect(flashTip('Vedalken Orrery')).toBe('Flash: can be cast any time you could cast an instant (from Vedalken Orrery)');
  });
});
