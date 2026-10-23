// @vitest-environment jsdom
/*
 * A permanent leaving the battlefield (`departures.ts`): which cards left and where to, which exit
 * motion each plays, and the stand-in drawn over the place its row keeps.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BoardCard, BoardPlayer, BoardView } from '../adapter.ts';
import { departureCause, departuresOf, DISSOLVE_SWEEP, EXIT_MOTIONS, shards, exitMotionFor, installDepartures, LANDING_ATTR, LEAVING_GAP_ATTR, specks, type Departure, type DepartureCause } from './departures.ts';

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

function departure(to: Departure['to'], cause?: DepartureCause): Departure {
  return { cardId: 7, playerId: 0, to, toPlayerId: 0, card: { id: 7 } as BoardCard, index: 0, ...(cause === undefined ? {} : { cause }) };
}

function board(): HTMLElement {
  const canvas = document.createElement('div');
  canvas.innerHTML = `
    <div data-zone="battlefield"><ul><li class="board-card" data-board-card="7" data-card-id="7" data-testid="board-card"><span class="name">Thalia</span></li></ul></div>
    <div data-board-overlay=""></div>`;
  canvas.querySelector<HTMLElement>('[data-board-overlay]')!.getBoundingClientRect = () => rect(0, 0, 1000, 800);
  document.body.append(canvas);
  return canvas;
}

/** What `Board.tsx` draws in the commit the card left in: its place kept as a gap. */
function keepPlace(canvas: HTMLElement): void {
  const gap = document.createElement('li');
  gap.className = 'zone__gap';
  gap.setAttribute(LEAVING_GAP_ATTR, '7');
  gap.getBoundingClientRect = () => rect(300, 400, 60, 84);
  canvas.querySelector('[data-board-card="7"]')!.replaceWith(gap);
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('exitMotionFor', () => {
  it('Forge’s causes fold to a departure’s: lethal damage and deathtouch are damage', () => {
    expect(departureCause('LETHAL_DAMAGE')).toBe('damage');
    expect(departureCause('DEATHTOUCH')).toBe('damage');
    expect(departureCause('DESTROYED')).toBe('destroyed');
    expect(departureCause('SACRIFICED')).toBe('sacrificed');
    expect(departureCause('ZERO_TOUGHNESS')).toBe('zero-toughness');
    expect(departureCause('STATE_RULE')).toBe('state-rule');
  });

  it('killed by damage it cracks and crumbles; destroyed is sliced; every other death crumples', () => {
    expect(exitMotionFor(departure('graveyard', 'damage'))).toBe('shatter');
    expect(exitMotionFor(departure('graveyard', 'destroyed'))).toBe('slice');
    for (const cause of ['sacrificed', 'zero-toughness', 'state-rule'] as const) expect(exitMotionFor(departure('graveyard', cause)), cause).toBe('crumple');
  });

  it('with no cause (a Forge too old to say, and no hit): killed by damage it shatters; destroyed any other way (a graveyard, or gone) is sliced', () => {
    expect(exitMotionFor(departure('graveyard', 'damage'))).toBe('shatter');
    expect(exitMotionFor(departure('graveyard'))).toBe('slice');
    expect(exitMotionFor(departure('gone'))).toBe('slice');
    expect(exitMotionFor(departure('gone', 'damage'))).toBe('shatter');
  });

  it('exiled dissolves', () => {
    expect(exitMotionFor(departure('exile'))).toBe('dissolve');
  });

  it('back to a hand flies there, face up', () => {
    expect(exitMotionFor(departure('hand'))).toBe('return');
  });
});

describe('departuresOf', () => {
  const card = (id: number): BoardCard => ({ id }) as BoardCard;
  const player = (id: number, over: Partial<BoardPlayer>): BoardPlayer =>
    ({ id, hand: null, handCount: 3, battlefield: [], graveyard: [], exile: [], ...over }) as BoardPlayer;
  const view = (...players: BoardPlayer[]): BoardView => ({ players }) as unknown as BoardView;

  it('a card in a hand this screen sees went to that hand, face up', () => {
    const prev = view(player(0, { hand: [], handCount: 0, battlefield: [card(7)] }), player(1, {}));
    const next = view(player(0, { hand: [card(7)], handCount: 1 }), player(1, {}));
    expect(departuresOf(prev, next)).toEqual([expect.objectContaining({ cardId: 7, to: 'hand', toPlayerId: 0 })]);
  });

  it('a card found nowhere went to a hidden hand that grew — its own player’s first — and nowhere shown when none did', () => {
    const prev = view(player(0, { hand: [] }), player(1, { battlefield: [card(7), card(8)] }));
    const intoTheirs = view(player(0, { hand: [] }), player(1, { handCount: 4 }));
    expect(departuresOf(prev, intoTheirs).map((d) => [d.cardId, d.to, d.toPlayerId])).toEqual([
      [7, 'hand', 1],
      [8, 'gone', 1],
    ]);
  });

  it('a card a hidden hand shows this screen is found there, face up', () => {
    const prev = view(player(0, { hand: [] }), player(1, { battlefield: [card(7)] }));
    const next = view(player(0, { hand: [] }), player(1, { handCount: 4, handShown: [null, null, null, card(7)] }));
    expect(departuresOf(prev, next).map((d) => [d.to, d.toPlayerId])).toEqual([['hand', 1]]);
  });
});

describe('installDepartures', () => {
  it('a copy of the card as it was stands over its place, still until its beat, then plays its motion and is gone, and the place is given back', () => {
    vi.useFakeTimers();
    const canvas = board();
    const onDone = vi.fn();
    const handle = installDepartures(canvas, { onDone });
    handle.snapshot();
    keepPlace(canvas);
    handle.leave([{ departure: departure('graveyard', 'sacrificed'), delayMs: 100 }]);

    const standIn = canvas.querySelector<HTMLElement>('[data-board-overlay] .board-departure')!;
    expect(standIn.getAttribute('data-exit')).toBe('crumple');
    expect(standIn.querySelectorAll('.board-departure__piece'), 'one copy').toHaveLength(1);
    expect(standIn.hasAttribute('data-exit-go'), 'still, until its beat').toBe(false);
    expect([standIn.style.left, standIn.style.top, standIn.style.width]).toEqual(['300px', '400px', '60px']);
    expect(standIn.textContent, 'the card as it was drawn').toBe('Thalia');
    expect(standIn.querySelector('[data-card-id], [data-board-card], [data-testid]'), 'no card of the board’s: nothing finds it as one').toBeNull();

    vi.advanceTimersByTime(100);
    expect(standIn.hasAttribute('data-exit-go'), 'its motion plays').toBe(true);
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(EXIT_MOTIONS.crumple.ms);
    expect(canvas.querySelector('.board-departure')).toBeNull();
    expect(onDone).toHaveBeenCalledWith(7);
    handle.dispose();
  });

  it('a commit’s departures read every box before drawing any stand-in: a read after one is drawn lays the page out again, once per card', () => {
    vi.useFakeTimers();
    const canvas = document.createElement('div');
    canvas.innerHTML = `
      <div data-zone="battlefield"><ul>
        <li class="board-card" data-board-card="7"><span class="name">Thalia</span></li>
        <li class="board-card" data-board-card="8"><span class="name">Bear</span></li>
      </ul></div>
      <div data-board-overlay=""></div>`;
    document.body.append(canvas);
    const order: string[] = [];
    const overlay = canvas.querySelector<HTMLElement>('[data-board-overlay]')!;
    overlay.getBoundingClientRect = () => (order.push('read'), rect(0, 0, 1000, 800));
    const append = overlay.append.bind(overlay);
    overlay.append = (...nodes) => (order.push('write'), append(...nodes));
    const handle = installDepartures(canvas, { onDone: () => undefined });
    handle.snapshot();
    for (const [id, left] of [[7, 300], [8, 380]] as const) {
      const gap = document.createElement('li');
      gap.setAttribute(LEAVING_GAP_ATTR, String(id));
      gap.getBoundingClientRect = () => (order.push('read'), rect(left, 400, 60, 84));
      canvas.querySelector(`[data-board-card="${id}"]`)!.replaceWith(gap);
    }
    handle.leave([
      { departure: departure('graveyard'), delayMs: 0 },
      { departure: { ...departure('graveyard'), cardId: 8, card: { id: 8 } as BoardCard }, delayMs: 0 },
    ]);
    expect(canvas.querySelectorAll('.board-departure')).toHaveLength(2);
    expect(order.lastIndexOf('read'), `every read before the first stand-in is drawn: ${order.join(' ')}`).toBeLessThan(order.indexOf('write'));
    handle.dispose();
  });

  it('reduced motion: no copy; the place is given back at the beat', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
    const canvas = board();
    const onDone = vi.fn();
    const handle = installDepartures(canvas, { onDone });
    handle.snapshot();
    keepPlace(canvas);
    handle.leave([{ departure: departure('graveyard'), delayMs: 100 }]);
    expect(canvas.querySelector('.board-departure')).toBeNull();
    vi.advanceTimersByTime(100);
    expect(onDone).toHaveBeenCalledWith(7);
    handle.dispose();
  });

  it('a slice is drawn as two copies of the card, the two halves, and goes once its motion is over', () => {
    vi.useFakeTimers();
    const canvas = board();
    const onDone = vi.fn();
    const handle = installDepartures(canvas, { onDone });
    handle.snapshot();
    keepPlace(canvas);
    handle.leave([{ departure: departure('graveyard'), delayMs: 0 }]);
    const standIn = canvas.querySelector<HTMLElement>('.board-departure')!;
    expect(standIn.getAttribute('data-exit')).toBe('slice');
    expect([...standIn.querySelectorAll<HTMLElement>('.board-departure__piece')].map((p) => [p.dataset.piece, p.textContent])).toEqual([
      ['1', 'Thalia'],
      ['2', 'Thalia'],
    ]);
    vi.advanceTimersByTime(EXIT_MOTIONS.slice.ms);
    expect(canvas.querySelector('.board-departure')).toBeNull();
    expect(onDone).toHaveBeenCalledWith(7);
    handle.dispose();
  });

  it('a commit with no departure to draw reads no card’s box: only one that draws departures does, before its writes', () => {
    const canvas = board();
    const card = canvas.querySelector<HTMLElement>('[data-board-card="7"]')!;
    const read = vi.fn(() => rect(300, 380, 60, 84));
    card.getBoundingClientRect = read;
    const handle = installDepartures(canvas, { onDone: () => undefined });
    handle.snapshot();
    handle.snapshot();
    handle.snapshot();
    expect(read, 'three commits, no departure').not.toHaveBeenCalled();
    handle.capture();
    expect(read, 'the commit drawing one reads each card once').toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('reports how the board held still in a commit that drew departures: the copy off its card, and the most any card moved', () => {
    vi.useFakeTimers();
    const canvas = board();
    const report = vi.fn();
    const handle = installDepartures(canvas, { onDone: () => undefined, report });
    canvas.querySelector<HTMLElement>('[data-board-card="7"]')!.getBoundingClientRect = () => rect(300, 380, 60, 84);
    handle.snapshot();
    handle.capture();
    keepPlace(canvas); // the gap stands at (300, 400): 20 px lower than the card was
    handle.leave([{ departure: departure('graveyard'), delayMs: 0 }]);
    handle.snapshot();
    vi.advanceTimersByTime(250);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ what: 'departure-layout', departures: 1, copyDx: 0, copyDy: 20 }));
    handle.dispose();
  });

  it('back to a hand: the copy is aimed at its own card there, which is hidden until the copy arrives', () => {
    vi.useFakeTimers();
    const canvas = board();
    const handle = installDepartures(canvas, { onDone: () => undefined });
    handle.snapshot();
    keepPlace(canvas);
    const hand = document.createElement('section');
    hand.setAttribute('data-zone', 'hand');
    hand.innerHTML = '<ul><li class="board-card" data-board-card="7"></li></ul>';
    canvas.append(hand);
    const own = hand.querySelector<HTMLElement>('li')!;
    own.getBoundingClientRect = () => rect(500, 700, 45, 63);
    handle.leave([{ departure: departure('hand'), delayMs: 50 }]);
    const standIn = canvas.querySelector<HTMLElement>('.board-departure')!;
    expect(standIn.getAttribute('data-exit')).toBe('return');
    // From the gap's centre (330, 442) to the card's (522.5, 731.5), at the card's width over the gap's.
    expect(['--to-x', '--to-y', '--to-scale'].map((v) => standIn.style.getPropertyValue(v))).toEqual(['192.5px', '289.5px', '0.75']);
    expect(own.hasAttribute(LANDING_ATTR), 'not drawn twice while the copy flies').toBe(true);
    vi.advanceTimersByTime(50 + EXIT_MOTIONS.return.ms);
    expect(own.hasAttribute(LANDING_ATTR)).toBe(false);
    expect(canvas.querySelector('.board-departure')).toBeNull();
    handle.dispose();
  });

  it('into a hidden hand: the card, face up, flown to the newest back — and a second card to the one before it', () => {
    vi.useFakeTimers();
    const canvas = board();
    const handle = installDepartures(canvas, { onDone: () => undefined });
    canvas.querySelector('[data-zone="battlefield"] ul')!.insertAdjacentHTML('beforeend', '<li class="board-card" data-board-card="8"></li>');
    handle.snapshot();
    keepPlace(canvas);
    const gap8 = document.createElement('li');
    gap8.setAttribute(LEAVING_GAP_ATTR, '8');
    gap8.getBoundingClientRect = () => rect(370, 400, 60, 84);
    canvas.querySelector('[data-board-card="8"]')!.replaceWith(gap8);
    const seat = document.createElement('div');
    seat.className = 'seat';
    seat.innerHTML = `<div data-player-face="" data-player-id="1"></div>
      <section data-zone="hand"><ul class="card-backs"><li class="card-back" data-card-back=""></li><li class="card-back" data-card-back=""></li></ul></section>`;
    canvas.append(seat);
    const newest = seat.querySelectorAll<HTMLElement>('.card-back')[1]!;
    handle.leave([{ departure: { ...departure('hand'), toPlayerId: 1 }, delayMs: 0 }]);
    const standIn = canvas.querySelector<HTMLElement>('.board-departure')!;
    expect(standIn.getAttribute('data-exit')).toBe('return');
    expect([...standIn.querySelectorAll('.board-departure__piece')].map((p) => p.firstElementChild!.className)).toEqual(['board-card']);
    expect(newest.hasAttribute(LANDING_ATTR)).toBe(true);
    expect(seat.querySelectorAll('.card-back')[0]!.hasAttribute(LANDING_ATTR)).toBe(false);
    handle.leave([{ departure: { ...departure('hand'), cardId: 8, toPlayerId: 1 }, delayMs: 0 }]);
    expect(seat.querySelectorAll('.card-back')[0]!.hasAttribute(LANDING_ATTR), 'a second card into the hand lands on the next back').toBe(true);
    vi.advanceTimersByTime(EXIT_MOTIONS.return.ms);
    expect(newest.hasAttribute(LANDING_ATTR)).toBe(false);
    handle.dispose();
  });

  it('a dissolve is drawn in the colour of what exiled it, shedding its motes, and grey for nothing', () => {
    const canvas = board();
    const handle = installDepartures(canvas, { onDone: () => undefined });
    handle.snapshot();
    keepPlace(canvas);
    handle.leave([{ departure: { ...departure('exile'), hue: 'U' }, delayMs: 0 }]);
    const standIn = canvas.querySelector<HTMLElement>('.board-departure')!;
    expect(standIn.getAttribute('data-colour')).toBe('U');
    expect(standIn.querySelectorAll('.board-departure__speck')).toHaveLength(EXIT_MOTIONS.dissolve.specks);
    expect(standIn.querySelectorAll('.board-departure__piece'), 'the card and its crumbs').toHaveLength(2);
    handle.dispose();
    const plain = board();
    const again = installDepartures(plain, { onDone: () => undefined });
    again.snapshot();
    keepPlace(plain);
    again.leave([{ departure: departure('exile'), delayMs: 0 }]);
    expect(plain.querySelector('.board-departure')!.hasAttribute('data-colour')).toBe(false);
    again.dispose();
  });

  it('a turned card’s stand-in is the turned card’s box: its centring margins are dropped and the stand-in moved down by them', () => {
    const canvas = board();
    const card = canvas.querySelector<HTMLElement>('[data-board-card="7"]')!;
    card.style.marginTop = '26px';
    card.style.marginBottom = '26px';
    const handle = installDepartures(canvas, { onDone: () => undefined });
    handle.snapshot();
    keepPlace(canvas);
    handle.leave([{ departure: departure('exile'), delayMs: 0 }]);
    const standIn = canvas.querySelector<HTMLElement>('.board-departure')!;
    expect(standIn.style.top).toBe('426px');
    for (const copy of standIn.querySelectorAll<HTMLElement>('.board-departure__piece > .board-card')) expect(copy.style.marginBlock).toBe('0px');
    handle.dispose();
  });

  it('killed by damage: seven pieces, each clipped to its shard and sent its own way, the cracks drawn over them, and falling dust', () => {
    const canvas = board();
    const handle = installDepartures(canvas, { onDone: () => undefined });
    handle.snapshot();
    keepPlace(canvas);
    handle.leave([{ departure: departure('graveyard', 'damage'), delayMs: 0 }]);
    const standIn = canvas.querySelector<HTMLElement>('.board-departure')!;
    expect(standIn.getAttribute('data-exit')).toBe('shatter');
    const pieces = [...standIn.querySelectorAll<HTMLElement>('.board-departure__piece')];
    expect(pieces).toHaveLength(EXIT_MOTIONS.shatter.pieces);
    expect(pieces.every((p) => p.style.clipPath.startsWith('polygon(')), 'each a shard').toBe(true);
    expect(new Set(pieces.map((p) => p.style.getPropertyValue('--dx'))).size, 'each its own way').toBe(pieces.length);
    expect(standIn.querySelectorAll('.board-departure__cracks polyline')).toHaveLength(EXIT_MOTIONS.shatter.pieces);
    expect(standIn.querySelectorAll('.board-departure__speck')).toHaveLength(EXIT_MOTIONS.shatter.specks);
    handle.dispose();
  });

  it('dispose takes every copy down', () => {
    const canvas = board();
    const handle = installDepartures(canvas, { onDone: () => undefined });
    handle.snapshot();
    keepPlace(canvas);
    handle.leave([{ departure: departure('exile'), delayMs: 0 }]);
    expect(canvas.querySelector('.board-departure[data-exit="dissolve"]')).not.toBeNull();
    handle.dispose();
    expect(canvas.querySelector('.board-departure')).toBeNull();
  });
});

describe('specks', () => {
  it('a card always comes apart the same way, each mote leaving as the edge passes it, from the bottom left corner on', () => {
    expect(specks(7, 28)).toEqual(specks(7, 28));
    expect(specks(7, 28)).not.toEqual(specks(8, 28));
    for (const s of specks(7, 28)) {
      expect(s.at).toBeGreaterThanOrEqual(0);
      expect(s.at).toBeLessThanOrEqual(DISSOLVE_SWEEP);
      expect(s.at).toBeCloseTo(((s.x + 1 - s.y) / 2) * DISSOLVE_SWEEP);
      expect(s.dy, 'up and away').toBeLessThan(0);
    }
  });
});

describe('shards', () => {
  it('a card always breaks the same way: cracks from one point out to its edges, one shard between each two, every shard falling', () => {
    expect(shards(7, 7)).toEqual(shards(7, 7));
    const { clips, cracks, parts } = shards(7, 7);
    expect([clips.length, cracks.length, parts.length]).toEqual([7, 7, 7]);
    const start = cracks.map((c) => c.split(' ')[0]);
    expect(new Set(start).size, 'every crack runs from one point').toBe(1);
    for (const c of cracks) {
      const [x, y] = c.split(' ').at(-1)!.split(',').map(Number);
      expect(x === 0 || x === 100 || y === 0 || y === 100 || Math.abs(x! - 100) < 0.05 || Math.abs(y! - 100) < 0.05 || x! < 0.05 || y! < 0.05, `${c} ends on an edge`).toBe(true);
    }
    for (const p of parts) expect(p.dy, 'it falls').toBeGreaterThan(0);
  });
});
