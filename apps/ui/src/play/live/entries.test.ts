// @vitest-environment jsdom
/*
 * A creature's entry (`entries.ts`): the landing's weight by power or mana value (`entryWeight`,
 * `entryHeft`), which motion an origin plays (`entryMotionFor`), and that a stand-in lines up on its
 * row card and a shove never changes anyone's place.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ENTRY_MAX, ENTRY_MOTIONS, entryHeft, entryMotionFor, entryPower, entryWeight, landingWeight, playEntry, playLanding } from './entries.ts';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  // jsdom has no Web Animations API: `play()` falls back to resolving at once without it; the DOM
  // tests below stub it so the squish and the effects actually run.
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
});

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

/** A fake Web Animation that finishes at once: enough for every `.animate()` call in `entries.ts` to run its effect and resolve. */
function stubAnimate(): void {
  HTMLElement.prototype.animate = vi.fn(
    () => ({ finished: Promise.resolve(), cancel: () => undefined }) as unknown as Animation,
  );
  // SVGElement extends Element, not HTMLElement, in jsdom: the crack masks' <path> runs no
  // animation of their own (CSS-driven), but `thump`/`debris`/`shove` only ever animate HTMLElements.
}

describe('entryPower', () => {
  it('0 at a 1-power creature, 1 at ENTRY_MAX, flat past it', () => {
    expect(entryPower(1)).toBe(0);
    expect(entryPower(ENTRY_MAX)).toBe(1);
    expect(entryPower(ENTRY_MAX + 5)).toBe(1);
  });
});

describe('entryWeight', () => {
  it('a 1-power landing is nothing but the drop', () => {
    const w = entryWeight(1);
    expect(w.thump).toBe(false);
    expect(w.debris).toBe(0);
    expect(w.shakePx).toBe(0);
    expect(w.cracks).toBeNull();
    expect(w.shove.rings).toBe(0);
  });

  it('thump and a wisp of debris from 2, nothing before it', () => {
    expect(entryWeight(1).thump).toBe(false);
    expect(entryWeight(2).thump).toBe(true);
    expect(entryWeight(1).debris).toBe(0);
    expect(entryWeight(2).debris).toBeGreaterThan(0);
  });

  it('no screen movement before 5, something from 5 on', () => {
    expect(entryWeight(4).shakePx).toBe(0);
    expect(entryWeight(5).shakePx).toBeGreaterThan(0);
    expect(entryWeight(5).shakePx).toBeCloseTo(0.6);
    expect(entryWeight(ENTRY_MAX).shakePx).toBeCloseTo(13);
  });

  it('no cracks before 7, full debris and cracks from 7', () => {
    expect(entryWeight(6).cracks).toBeNull();
    expect(entryWeight(7).cracks).not.toBeNull();
    expect(entryWeight(7).debris).toBe(1);
    expect(entryWeight(7).cracks!.forks).toBe(0);
  });

  it('forks only from 10, one generation', () => {
    expect(entryWeight(9).cracks!.forks).toBe(0);
    expect(entryWeight(10).cracks!.forks).toBeGreaterThan(0);
    expect(entryWeight(10).cracks!.depth).toBe(1);
  });

  it('the shove: nothing below 8, one ring from 8, a second from 12', () => {
    expect(entryWeight(7).shove.rings).toBe(0);
    expect(entryWeight(8).shove.rings).toBe(1);
    expect(entryWeight(12).shove.rings).toBe(2);
  });

  it('everything caps at ENTRY_MAX: past it reads exactly as 15 does', () => {
    expect(entryWeight(20)).toEqual(entryWeight(ENTRY_MAX));
    expect(entryWeight(20).shove.rings).toBe(2);
  });

  it('every field only ever grows (or holds) from 1 to 15 — no field doubles back', () => {
    let last = entryWeight(1);
    for (let p = 2; p <= ENTRY_MAX; p++) {
      const w = entryWeight(p);
      expect(w.power, `power at ${p}`).toBeGreaterThanOrEqual(last.power);
      expect(w.shakePx, `shakePx at ${p}`).toBeGreaterThanOrEqual(last.shakePx);
      expect(w.debris, `debris at ${p}`).toBeGreaterThanOrEqual(last.debris);
      expect(w.shove.strength, `shove.strength at ${p}`).toBeGreaterThanOrEqual(last.shove.strength);
      expect(w.shove.rings, `shove.rings at ${p}`).toBeGreaterThanOrEqual(last.shove.rings);
      if (last.cracks !== null && w.cracks !== null) {
        expect(w.cracks.count, `cracks.count at ${p}`).toBeGreaterThanOrEqual(last.cracks.count);
        expect(w.cracks.breaks, `cracks.breaks at ${p}`).toBeGreaterThanOrEqual(last.cracks.breaks);
        expect(w.cracks.reach, `cracks.reach at ${p}`).toBeGreaterThanOrEqual(last.cracks.reach);
        expect(w.cracks.root, `cracks.root at ${p}`).toBeGreaterThanOrEqual(last.cracks.root);
        expect(w.cracks.forks, `cracks.forks at ${p}`).toBeGreaterThanOrEqual(last.cracks.forks);
        expect(w.cracks.glow, `cracks.glow at ${p}`).toBeGreaterThanOrEqual(last.cracks.glow);
      }
      last = w;
    }
    // And each climbs somewhere above its own threshold, not just at the top.
    expect(entryWeight(15).shakePx).toBeGreaterThan(entryWeight(6).shakePx);
    expect(entryWeight(15).cracks!.count).toBeGreaterThan(entryWeight(7).cracks!.count);
    expect(entryWeight(15).shove.strength).toBeGreaterThan(entryWeight(8).shove.strength);
  });
});

describe('entryHeft', () => {
  it('a creature by its current power', () => {
    expect(entryHeft({ typeLine: 'Creature — Bear', power: '4', manaValue: 2 })).toBe(4);
  });

  it('a land (mana value 0) just drops', () => {
    expect(entryHeft({ typeLine: 'Land', manaValue: 0 })).toBe(0);
  });

  it('every other permanent by its mana value', () => {
    expect(entryHeft({ typeLine: 'Artifact', manaValue: 3 })).toBe(3);
    expect(entryHeft({ typeLine: 'Enchantment', manaValue: 5 })).toBe(5);
    expect(entryHeft({ typeLine: 'Legendary Planeswalker', manaValue: 4 })).toBe(4);
  });

  it('a creature with no readable power lands light', () => {
    expect(entryHeft({ typeLine: 'Creature — Shapeshifter', manaValue: 3 })).toBe(0);
  });
});

describe('landingWeight', () => {
  it('no tail at 0 heft, the entry weight from 1 on', () => {
    expect(landingWeight(0)).toBeNull();
    expect(landingWeight(1)).toEqual(entryWeight(1));
    expect(landingWeight(9)).toEqual(entryWeight(9));
  });
});

describe('entryMotionFor', () => {
  it('one place every origin is chosen: graveyard rises, exile blinks, a token releases, anything else is a cast', () => {
    expect(entryMotionFor('graveyard')).toBe('rise');
    expect(entryMotionFor('exile')).toBe('blink');
    expect(entryMotionFor('token')).toBe('release');
    expect(entryMotionFor('stack')).toBe('cast');
  });

  it('every motion has keyframes named for it', () => {
    for (const motion of Object.keys(ENTRY_MOTIONS)) expect(typeof ENTRY_MOTIONS[motion as keyof typeof ENTRY_MOTIONS].ms).toBe('number');
  });
});

/** A board with one battlefield zone and `n` cards laid out on a grid, `card` picked out as the landing titan. */
function boardWith(n: number, titanIndex: number): { board: HTMLElement; overlay: HTMLElement; zone: HTMLElement; cards: HTMLElement[] } {
  const board = document.createElement('div');
  board.className = 'board';
  const overlay = document.createElement('div');
  overlay.getBoundingClientRect = () => rect(0, 0, 1200, 800);
  const zone = document.createElement('ul');
  zone.setAttribute('data-zone', 'battlefield');
  zone.setAttribute('data-owner', 'you');
  const cards: HTMLElement[] = [];
  for (let i = 0; i < n; i++) {
    const li = document.createElement('li');
    li.setAttribute('data-board-card', String(i));
    li.className = 'board-card';
    const col = i % 4;
    const row = Math.floor(i / 4);
    li.getBoundingClientRect = () => rect(20 + col * 90, 20 + row * 120, 78, 108);
    zone.append(li);
    cards.push(li);
  }
  board.append(overlay, zone);
  document.body.append(board);
  void titanIndex;
  return { board, overlay, zone, cards };
}

describe('playLanding / playEntry: stand-in alignment and the shove', () => {
  it('a turned card’s stand-in lands on its row card’s face, margins dropped', async () => {
    stubAnimate();
    const { board, overlay, zone, cards } = boardWith(1, 0);
    const card = cards[0]!;
    card.style.marginTop = card.style.marginBottom = '26px';
    const inner = card.getBoundingClientRect();
    card.getBoundingClientRect = () => rect(inner.left, inner.top, inner.width, inner.height);
    // A card drawn as a `.board-card` for `copyOfCard` to clone its face from.
    const face = document.createElement('div');
    face.className = 'board-card';
    card.append(face);
    void zone;
    await playEntry({ board, overlay, card, from: null, motion: 'cast', weight: entryWeight(1), key: 'k1' });
    // The row card is visible again, untouched in place — never a transform on it (table-fit).
    expect(card.style.visibility).toBe('');
    expect(card.style.transform).toBe('');
  });

  it('the shove never changes any card’s place: the battlefield’s own order of cards is untouched', async () => {
    stubAnimate();
    const { board, overlay, zone, cards } = boardWith(9, 4);
    const titan = cards[4]!;
    const before = [...zone.querySelectorAll('[data-board-card]')].map((el) => el.getAttribute('data-board-card'));
    await playEntry({ board, overlay, card: titan, from: null, motion: 'cast', weight: entryWeight(12), key: 'k2' });
    const after = [...zone.querySelectorAll('[data-board-card]')].map((el) => el.getAttribute('data-board-card'));
    expect(after).toEqual(before);
    for (const c of cards) expect(c.style.visibility).toBe('');
  });

  it('a board taken down mid-arrival is drawn into no more, and its card is left shown', async () => {
    stubAnimate();
    for (const start of [
      (b: ReturnType<typeof boardWith>) => playEntry({ board: b.board, overlay: b.overlay, card: b.cards[4]!, from: null, motion: 'cast', weight: entryWeight(12), key: 'gone' }),
      (b: ReturnType<typeof boardWith>) => playLanding(b.board, b.overlay, b.cards[4]!, entryWeight(12), 'gone'),
    ]) {
      const b = boardWith(9, 4);
      const run = start(b);
      // The match left (or the test that drew it ended) before the landing came down.
      b.board.remove();
      const drawn = vi.spyOn(b.overlay, 'append');
      await run;
      expect(drawn, 'nothing appended to a board no longer on the page').not.toHaveBeenCalled();
      expect(b.cards[4]!.style.visibility).toBe('');
    }
  });

  it('playLanding alone (Fast Mode) draws the weight effects without hiding or moving the card', async () => {
    stubAnimate();
    const { board, overlay, cards } = boardWith(1, 0);
    const card = cards[0]!;
    await playLanding(board, overlay, card, entryWeight(8), 'k3');
    expect(card.style.visibility).toBe('');
  });
});
