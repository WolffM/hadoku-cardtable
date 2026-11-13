// @vitest-environment jsdom
/**
 * A creature's power or toughness changing lands on its P/T badge (`./pt-impact.ts`), through the
 * resolution beats `./numbers.ts` already draws: the pure diff, and the DOM it drives.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BoardCard, BoardPlayer, BoardView, StackEntry } from '../adapter.ts';
import { BEAT_STAGGER_MS } from '../motion.ts';
import { diffViews, installNumbers } from './numbers.ts';
import { impactBadge, PT_IMPACT_MS, ptChanges, ptDirection, type PT, type PTChange } from './pt-impact.ts';

function creature(id: number, power: number | undefined, toughness: number | undefined, extra: Partial<BoardCard> = {}): BoardCard {
  return {
    id,
    card: {
      cardId: `c${id}`,
      name: `Card ${id}`,
      manaCost: [],
      manaValue: 0,
      colors: [],
      typeLine: power === undefined ? 'Enchantment' : 'Creature',
      oracleText: '',
      setCode: 'TST',
      collectorNumber: String(id),
      rarity: 'common',
      ...(power === undefined ? {} : { power: String(power) }),
      ...(toughness === undefined ? {} : { toughness: String(toughness) }),
    },
    tapped: false,
    summoningSick: false,
    damage: 0,
    counters: [],
    attacking: false,
    blocking: false,
    token: false,
    ...extra,
  };
}

function player(id: number, battlefield: BoardCard[], isViewer = false): BoardPlayer {
  return {
    id,
    name: `P${id}`,
    life: 20,
    isViewer,
    isActive: false,
    hasPriority: false,
    hasLost: false,
    hand: null,
    handCount: 0,
    libraryCount: 0,
    battlefield,
    graveyard: [],
    exile: [],
  };
}

function view(players: BoardPlayer[], stack: StackEntry[] = []): BoardView {
  return { seq: 1, title: 't', turn: 1, phase: null, phaseLabel: '', activePlayerId: null, players, stack, gameOver: false, missingCardIds: [] };
}

const item = (id: number, sourceCardId: number | null): StackEntry => ({ id, description: '', sourceCardId, sourceName: null, sourceCard: null, controllerName: null, isAbility: true });

describe('ptChanges', () => {
  it('a pump, a shrink and a counter are each a change, keyed by card, from what it was to what it is', () => {
    const before = view([player(0, [creature(1, 2, 2), creature(2, 3, 3)]), player(1, [creature(3, 1, 1)])]);
    const after = view([player(0, [creature(1, 5, 5), creature(2, 3, 3)]), player(1, [creature(3, 2, 2, { counters: [{ name: 'P1P1', count: 1 }] as BoardCard['counters'] })])]);
    expect(ptChanges(before, after)).toEqual([
      { cardId: 1, from: { power: 2, toughness: 2 }, to: { power: 5, toughness: 5 } },
      { cardId: 3, from: { power: 1, toughness: 1 }, to: { power: 2, toughness: 2 } },
    ]);
  });

  it('damage is not a change of power or toughness: it has its own hit', () => {
    const before = view([player(0, [creature(1, 3, 3)])]);
    const after = view([player(0, [creature(1, 3, 3, { damage: 2 })])]);
    expect(ptChanges(before, after)).toEqual([]);
    expect(diffViews(before, after).pt).toEqual([]);
  });

  it('a creature that arrived, left, or only now became one has no before, and is not a change', () => {
    const before = view([player(0, [creature(1, 2, 2), creature(2, undefined, undefined)])]);
    const after = view([player(0, [creature(2, 4, 4), creature(5, 1, 1)])]);
    expect(ptChanges(before, after)).toEqual([]);
  });

  it('a creature that changed sides is the same card: its change still counts', () => {
    const before = view([player(0, [creature(1, 2, 2)]), player(1, [])]);
    const after = view([player(0, []), player(1, [creature(1, 3, 3)])]);
    expect(ptChanges(before, after)).toEqual([{ cardId: 1, from: { power: 2, toughness: 2 }, to: { power: 3, toughness: 3 } }]);
  });

  it('diffViews carries the changes for numbers.ts to draw', () => {
    const before = view([player(0, [creature(1, 3, 3)])]);
    const after = view([player(0, [creature(1, 1, 1)])]);
    expect(diffViews(before, after).pt).toEqual([{ cardId: 1, from: { power: 3, toughness: 3 }, to: { power: 1, toughness: 1 } }]);
  });
});

describe('ptDirection', () => {
  const change = (from: PT, to: PT): PTChange => ({ cardId: 1, from, to });
  it('bigger overall is up, smaller is down, a trade goes by its power', () => {
    expect(ptDirection(change({ power: 2, toughness: 2 }, { power: 3, toughness: 3 }))).toBe('up');
    expect(ptDirection(change({ power: 3, toughness: 3 }, { power: 1, toughness: 1 }))).toBe('down');
    expect(ptDirection(change({ power: 2, toughness: 2 }, { power: 3, toughness: 2 }))).toBe('up');
    expect(ptDirection(change({ power: 2, toughness: 4 }, { power: 4, toughness: 2 }))).toBe('up');
    expect(ptDirection(change({ power: 4, toughness: 2 }, { power: 2, toughness: 4 }))).toBe('down');
  });
});

/* ── the DOM: the badge, and installNumbers drawing it ─────────────────── */

type Box = { left: number; top: number; width: number; height: number };
const rect = (b: Box): DOMRect => ({ ...b, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top, toJSON: () => b }) as DOMRect;

/** A board with a source (8) and two creatures (7, 9), each with the badge `Board.tsx`'s `CreaturePT` draws. */
function board(): { canvas: HTMLElement; overlay: HTMLElement; badge: (id: number) => HTMLElement } {
  const canvas = document.createElement('div');
  const pill = (id: number) =>
    `<li class="board-card" data-board-card="${id}" data-card-id="${id}"><button class="board-card__face"></button><span class="board-card__pt" data-pt=""><span class="board-card__pt-n" data-pt-of="power">2</span><span>/</span><span class="board-card__pt-n" data-pt-of="toughness">2</span></span></li>`;
  canvas.innerHTML = `
    <div class="board">
      <div data-player-face data-player-id="0" data-viewer=""><span data-testid="life">20</span></div>
      <div data-player-face data-player-id="1"><span data-testid="life">20</span></div>
      <div data-zone="battlefield" data-owner="you">${pill(8)}${pill(7)}${pill(9)}</div>
      <div data-zone="battlefield" data-owner="them"></div>
      <div class="board__overlay" data-board-overlay=""></div>
    </div>`;
  document.body.append(canvas);
  const at = (selector: string, box: Box): void => {
    canvas.querySelector<HTMLElement>(selector)!.getBoundingClientRect = () => rect(box);
  };
  at('[data-board-overlay]', { left: 0, top: 0, width: 1000, height: 800 });
  at('[data-board-card="8"]', { left: 600, top: 500, width: 60, height: 84 });
  at('[data-board-card="7"] > .board-card__face', { left: 290, top: 330, width: 60, height: 84 });
  at('[data-board-card="9"] > .board-card__face', { left: 390, top: 330, width: 60, height: 84 });
  at('[data-board-card="7"] > .board-card__pt', { left: 300, top: 400, width: 24, height: 16 });
  at('[data-board-card="9"] > .board-card__pt', { left: 400, top: 400, width: 24, height: 16 });
  return {
    canvas,
    overlay: canvas.querySelector<HTMLElement>('[data-board-overlay]')!,
    badge: (id) => canvas.querySelector<HTMLElement>(`[data-board-card="${id}"] > .board-card__pt`)!,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('impactBadge', () => {
  it('marks the direction and the numbers that moved, and clears after its run; a newer impact is not cut short by an older one', () => {
    vi.useFakeTimers();
    const { badge } = board();
    const el = badge(7);
    const after = (fn: () => void, ms: number): void => void setTimeout(fn, ms);
    impactBadge(el, { cardId: 7, from: { power: 2, toughness: 2 }, to: { power: 4, toughness: 2 } }, false, after);
    expect(el.dataset.ptImpact).toBe('up');
    expect(el.dataset.ptMoved, 'the badge names what moved: power, not toughness').toBe('power');
    vi.advanceTimersByTime(PT_IMPACT_MS / 2);
    impactBadge(el, { cardId: 7, from: { power: 4, toughness: 2 }, to: { power: 2, toughness: 0 } }, true, after);
    vi.advanceTimersByTime(PT_IMPACT_MS / 2);
    expect(el.dataset.ptImpact, 'the first impact’s clear does not end the second').toBe('down');
    expect(el.dataset.ptMoved).toBe('power toughness');
    expect(el.hasAttribute('data-pt-impact-reduced')).toBe(true);
    vi.advanceTimersByTime(PT_IMPACT_MS);
    expect(el.hasAttribute('data-pt-impact')).toBe(false);
    expect(el.hasAttribute('data-pt-moved')).toBe(false);
  });
});

describe('installNumbers: power and toughness', () => {
  const glints = (overlay: HTMLElement) =>
    [...overlay.querySelectorAll<HTMLElement>('.pt-glint')].map((g) => `${g.dataset.ptGlint} ${g.style.left},${g.style.top} ${g.style.width}x${g.style.height}`);

  it('battle cry: each creature it changed glints up, one after another a beat apart, its badge holding the old numbers until its glint; nothing travels', () => {
    vi.useFakeTimers();
    const { canvas, overlay, badge } = board();
    const held: string[] = [];
    const handle = installNumbers(canvas, {
      reducedMotion: () => false,
      fastMode: () => false,
      holdPT: (id, pt) => held.push(`hold ${id} ${pt.power}/${pt.toughness}`),
      releasePT: (id) => held.push(`release ${id}`),
    });
    const hero = creature(8, 3, 4);
    handle.notify(view([player(0, [hero, creature(7, 2, 2), creature(9, 1, 1)], true)], [item(40, 8)]));
    handle.notify(view([player(0, [hero, creature(7, 3, 2), creature(9, 2, 1)], true)]));

    expect(overlay.querySelector('.effect-hit'), 'no fireball').toBeNull();
    expect(glints(overlay), 'the first glints at once, over its own face').toEqual(['up 290px,330px 60pxx84px']);
    expect(held, 'the first lands at once, the second is held for its beat').toEqual(['hold 7 2/2', 'release 7', 'hold 9 1/1']);
    expect(badge(7).dataset.ptImpact).toBe('up');
    expect(badge(9).hasAttribute('data-pt-impact'), 'the next waits its beat').toBe(false);

    vi.advanceTimersByTime(BEAT_STAGGER_MS);
    expect(glints(overlay)).toEqual(['up 290px,330px 60pxx84px', 'up 390px,330px 60pxx84px']);
    expect(held).toContain('release 9');
    expect(badge(9).dataset.ptImpact).toBe('up');

    vi.advanceTimersByTime(PT_IMPACT_MS);
    expect(glints(overlay), 'each glint is gone after its run').toEqual([]);
    handle.dispose();
    expect(badge(9).hasAttribute('data-pt-impact'), 'a board taken down leaves no impact behind').toBe(false);
  });

  it('a shrink glints down', () => {
    vi.useFakeTimers();
    const { canvas, overlay, badge } = board();
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false });
    const gatekeeper = creature(8, 4, 3);
    handle.notify(view([player(0, [gatekeeper], true), player(1, [creature(7, 3, 3)])], [item(41, 8)]));
    handle.notify(view([player(0, [gatekeeper], true), player(1, [creature(7, 1, 1)])]));
    expect(glints(overlay)).toEqual(['down 290px,330px 60pxx84px']);
    expect(badge(7).dataset.ptImpact).toBe('down');
    handle.dispose();
    expect(glints(overlay), 'a board taken down leaves no glint').toEqual([]);
  });

  it('nothing resolved (an "until end of turn" wearing off, a lord’s static): every card glints at once', () => {
    vi.useFakeTimers();
    const { canvas, overlay } = board();
    const held: string[] = [];
    const handle = installNumbers(canvas, {
      reducedMotion: () => false,
      fastMode: () => false,
      holdPT: (id) => held.push(`hold ${id}`),
      releasePT: (id) => held.push(`release ${id}`),
    });
    handle.notify(view([player(0, [creature(7, 5, 5), creature(9, 4, 4)], true)]));
    handle.notify(view([player(0, [creature(7, 2, 2), creature(9, 1, 1)], true)]));
    expect(glints(overlay)).toEqual(['down 290px,330px 60pxx84px', 'down 390px,330px 60pxx84px']);
    expect(held).toEqual(['hold 7', 'release 7', 'hold 9', 'release 9']);
    handle.dispose();
  });

  it('reduced motion: the glint is the fade-only one, and the badge’s too', () => {
    vi.useFakeTimers();
    const { canvas, overlay, badge } = board();
    const handle = installNumbers(canvas, { reducedMotion: () => true, fastMode: () => false });
    handle.notify(view([player(0, [creature(8, 3, 4), creature(7, 2, 2)], true)], [item(43, 8)]));
    handle.notify(view([player(0, [creature(8, 3, 4), creature(7, 3, 3)], true)]));
    expect(overlay.querySelector<HTMLElement>('.pt-glint')!.hasAttribute('data-pt-glint-reduced')).toBe(true);
    expect(badge(7).hasAttribute('data-pt-impact-reduced')).toBe(true);
    handle.dispose();
  });

  it('the beats are reported, so the match log can say a P/T change was drawn', () => {
    vi.useFakeTimers();
    const { canvas } = board();
    const reports: Record<string, unknown>[] = [];
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false, report: (d) => reports.push(d) });
    handle.notify(view([player(0, [creature(8, 3, 4), creature(7, 2, 2)], true)], [item(44, 8)]));
    handle.notify(view([player(0, [creature(8, 3, 4), creature(7, 3, 3)], true)]));
    expect(reports.find((r) => r.what === 'pt')).toEqual({ what: 'pt', resolved: 44, changes: 1, staggered: 1, motion: true });
    handle.dispose();
  });
});
