// @vitest-environment jsdom
/*
 * Tempo (`tempo.ts`): the scale, what keys an instance, the count per turn, and what `installNumbers` draws at
 * each tempo — the same resolution again plays faster, Blasphemous Act is one instance, and a new turn starts at 1×.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BoardCard, BoardPlayer, BoardView, StackEntry } from '../adapter.ts';
import { BOLT_STAGGER_MS, HIT_MS } from '../motion.ts';
import type { Departure } from './departures.ts';
import { diffViews, installNumbers, type ViewDiff } from './numbers.ts';
import {
  boardTempoCount,
  countInstance,
  instanceKey,
  itemKey,
  markTempo,
  nextResolveTempo,
  nextTempo,
  noteResolutionsSent,
  noteResolvedTempo,
  noteTempoStack,
  quicken,
  resolvedTempo,
  TEMPO_CAP,
  TEMPO_PROPERTY,
  TEMPO_STEP,
  tempoCount,
  tempoOf,
} from './tempo.ts';

function card(id: number, name: string, opts: Partial<BoardCard> = {}): BoardCard {
  return {
    id,
    card: { cardId: `c${id}`, name, manaCost: [], manaValue: 0, colors: [], typeLine: 'Creature', oracleText: '', setCode: 'TST', collectorNumber: String(id), rarity: 'common' },
    tapped: false,
    summoningSick: false,
    damage: 0,
    counters: [],
    attacking: false,
    blocking: false,
    token: false,
    ...opts,
  };
}

function player(id: number, life: number, opts: { battlefield?: BoardCard[]; graveyard?: BoardCard[]; isViewer?: boolean } = {}): BoardPlayer {
  return {
    id,
    name: `P${id}`,
    life,
    isViewer: opts.isViewer ?? false,
    isActive: false,
    hasPriority: false,
    hasLost: false,
    hand: null,
    handCount: 0,
    libraryCount: 0,
    battlefield: opts.battlefield ?? [],
    graveyard: opts.graveyard ?? [],
    exile: [],
  };
}

function view(players: BoardPlayer[], stack: StackEntry[] = [], turn = 1): BoardView {
  return { seq: 1, title: 't', turn, phase: null, phaseLabel: '', activePlayerId: null, players, stack, gameOver: false, missingCardIds: [] };
}

function ability(id: number, sourceCardId: number, sourceName: string, abilityText: string): StackEntry {
  return { id, description: `${sourceName}: ${abilityText} (targeting ${id})`, sourceCardId, sourceName, sourceCard: null, controllerName: 'P0', isAbility: true, abilityText };
}

function spell(id: number, sourceCardId: number, sourceName: string): StackEntry {
  return { id, description: sourceName, sourceCardId, sourceName, sourceCard: null, controllerName: 'P0', isAbility: false };
}

const NO_DIFF: ViewDiff = { life: [], damage: [], resolved: [], arrivals: [], hits: [], faceHits: [], departures: [], attacks: [], pt: [] };

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  boardTempoCount();
});

describe('tempoOf', () => {
  it('a key seen once plays at 1×; each repeat TEMPO_STEP faster, to TEMPO_CAP at the seventh, and never past it', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 30].map(tempoOf)).toEqual([1, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.5, 2.5]);
    expect(TEMPO_STEP).toBe(0.25);
    expect(TEMPO_CAP).toBe(2.5);
  });

  it('is never slower for a later repeat', () => {
    for (let n = 1; n < 40; n++) expect(tempoOf(n + 1)).toBeGreaterThanOrEqual(tempoOf(n));
  });
});

describe('itemKey', () => {
  it('an ability is its source’s name and its own words — not the stack instance’s targets, not the card’s id', () => {
    const first = ability(40, 8, 'Thopter Foundry', '{1}, Sacrifice a nontoken artifact: Create a 1/1 Thopter.');
    const again = ability(55, 8, 'Thopter Foundry', '{1}, Sacrifice a nontoken artifact: Create a 1/1 Thopter.');
    expect(itemKey(first)).toBe(itemKey(again));
    expect(itemKey(first)).toBe('Thopter Foundry|{1}, Sacrifice a nontoken artifact: Create a 1/1 Thopter.');
  });

  it('a spell is its name: every copy, from any card, is the same thing drawn again', () => {
    expect(itemKey(spell(40, 9, 'Grapeshot'))).toBe(itemKey(spell(41, 77, 'Grapeshot')));
    expect(itemKey(spell(40, 9, 'Grapeshot'))).not.toBe(itemKey(ability(41, 9, 'Grapeshot', 'Storm')));
  });

  it('two abilities of one card are two keys', () => {
    expect(itemKey(ability(1, 8, 'Sword of the Meek', 'Equipped creature gets +1/+2.'))).not.toBe(itemKey(ability(2, 8, 'Sword of the Meek', 'Whenever a 1/1 creature enters, return this.')));
  });
});

describe('instanceKey', () => {
  const board = view([player(0, 20, { battlefield: [card(8, 'Thopter Foundry')] }), player(1, 20)]);

  it('a resolution is one instance however much it draws: Blasphemous Act is one key, whatever its fireballs hit', () => {
    const act = spell(40, 99, 'Blasphemous Act');
    const departures = [5, 6, 7].map((id) => ({ cardId: id, playerId: 1, to: 'graveyard', toPlayerId: 1, card: card(id, `Bear ${id}`), index: 0 }) as Departure);
    const diff: ViewDiff = {
      ...NO_DIFF,
      resolved: [act],
      hits: [5, 6, 7].map((id, i) => ({ seq: i + 1, cardId: id, sourceId: 99, amount: 13 })),
      departures,
    };
    expect(instanceKey(diff, [], board)).toBe('resolve:Blasphemous Act|spell');
  });

  it('without a resolution, by what it draws: a sacrifice is its card leaving, a token its maker, combat its blows', () => {
    const sword = { cardId: 9, playerId: 0, to: 'graveyard', toPlayerId: 0, card: card(9, 'Sword of the Meek'), index: 1 } as Departure;
    expect(instanceKey({ ...NO_DIFF, departures: [sword] }, [], board)).toBe('leave:Sword of the Meek>graveyard');
    expect(instanceKey({ ...NO_DIFF, arrivals: [{ cardId: 30, source: 8, origin: 'token', heft: 1 }] }, [], board)).toBe('arrive:Thopter Foundry');
    expect(instanceKey({ ...NO_DIFF, faceHits: [{ seq: 1, playerId: 1, sourceId: 8, amount: 2, combat: true }] }, [], board)).toBe('blows');
    expect(instanceKey({ ...NO_DIFF, attacks: [8] }, [], board)).toBe('attack');
    expect(instanceKey({ ...NO_DIFF, life: [{ playerId: 0, from: 20, to: 18 }] }, [], board)).toBe('life');
  });

  it('a view that draws nothing is no instance', () => {
    expect(instanceKey(NO_DIFF, [], board)).toBeNull();
    expect(instanceKey({ ...NO_DIFF, damage: [{ cardId: 8, ownerId: 0, from: 2, to: 0 }] }, [], board), 'a cleanup wipe is not drawn').toBeNull();
  });
});

describe('countInstance', () => {
  it('counts each key on its own, and a new turn starts every count again', () => {
    const count = tempoCount();
    expect([countInstance(count, 'a', 1), countInstance(count, 'a', 1), countInstance(count, 'b', 1), countInstance(count, 'a', 1)]).toEqual([1, 2, 1, 3]);
    expect(nextTempo(count, 'a', 1)).toBe(tempoOf(4));
    expect(nextTempo(count, 'a', 2), 'the next turn has seen nothing yet').toBe(1);
    expect(countInstance(count, 'a', 2)).toBe(1);
    expect(countInstance(count, 'b', 2)).toBe(1);
  });
});

describe('the board’s tempo, for the pacer and the stack layer', () => {
  it('the next resolution is the top of the stack as last drawn, at the tempo its next instance will play', () => {
    const count = boardTempoCount();
    const foundry = ability(40, 8, 'Thopter Foundry', 'Make a Thopter.');
    expect(nextResolveTempo(), 'an empty stack').toBe(1);
    noteTempoStack(view([], [foundry]));
    expect(nextResolveTempo()).toBe(1);
    countInstance(count, `resolve:${itemKey(foundry)}`, 1);
    countInstance(count, `resolve:${itemKey(foundry)}`, 1);
    expect(nextResolveTempo(), 'its third this turn').toBe(tempoOf(3));
    noteTempoStack(view([], [foundry], 2));
    expect(nextResolveTempo(), 'next turn').toBe(1);
  });

  it('what the pacer has sent resolving counts before the board draws it, so a chain’s next gap is at the next one’s tempo', () => {
    const count = boardTempoCount();
    const triggers = [3, 2, 1].map((n) => ability(100 + n, 9, 'Valakut, the Molten Pinnacle', 'Whenever a Mountain enters, deal 3 damage.'));
    const key = `resolve:${itemKey(triggers[0]!)}`;
    noteTempoStack(view([], triggers));
    expect(nextResolveTempo(), 'the first').toBe(1);
    noteResolutionsSent([103]);
    expect(nextResolveTempo(), 'the first is on its way: the next is the second').toBe(1.25);
    noteResolutionsSent([102]);
    expect(nextResolveTempo(), 'and the third').toBe(1.5);
    // The board draws the first leaving: counted once, never twice.
    countInstance(count, key, 1);
    noteTempoStack(view([], triggers.slice(1)));
    expect(nextResolveTempo()).toBe(1.5);
    noteResolutionsSent([999]);
    expect(nextResolveTempo(), 'an item the board never drew is no instance of anything').toBe(1.5);
  });

  it('a resolved item keeps the tempo it resolved at; one never drawn resolving is 1', () => {
    boardTempoCount();
    noteResolvedTempo(40, 1.75);
    expect(resolvedTempo(40)).toBe(1.75);
    expect(resolvedTempo(41)).toBe(1);
  });
});

describe('the browser’s side of an instance’s clock', () => {
  it('markTempo writes the property every beat sheet divides by; quicken plays an animation that much faster', () => {
    const el = document.createElement('div');
    markTempo(el, 2.25);
    expect(el.style.getPropertyValue(TEMPO_PROPERTY)).toBe('2.25');
    const anim = { playbackRate: 1 } as Animation;
    expect(quicken(anim, 1.5).playbackRate).toBe(1.5);
    expect(quicken({ playbackRate: 1 } as Animation, 1).playbackRate).toBe(1);
  });

  it('every finite beat a beat sheet animates divides its length by --tempo', () => {
    const here = import.meta.dirname ?? 'games/magic/ui/src/play/live';
    const sheets = ['numbers.css', 'projectile.css', 'crash.css', 'departures.css', 'mill.css', 'pt-impact.css'];
    for (const sheet of sheets) {
      const css = readFileSync(resolve(here, sheet), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [, value] of css.matchAll(/(?<![\w-])animation(?:-delay|-duration)?\s*:([^;{}]*)/g)) {
        if (value!.includes('infinite') || !/\d+m?s\b|-ms\b/.test(value!)) continue;
        // Every length in it is inside a `/ var(--tempo, 1)`.
        const bare = value!.replace(/calc\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\/ var\(--tempo, 1\)\)/g, '');
        expect(bare, `${sheet}: ${value!.trim()}`).not.toMatch(/\d+m?s\b|var\(--[\w-]+-ms/);
      }
    }
  });
});

/* ── installNumbers: what each instance draws ─────────────────────────── */

type Box = { left: number; top: number; width: number; height: number };
const rect = (b: Box): DOMRect => ({ ...b, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top, toJSON: () => b }) as DOMRect;

function boardDom(): { canvas: HTMLElement; overlay: HTMLElement } {
  const canvas = document.createElement('div');
  canvas.innerHTML = `
    <div class="board">
      <div data-player-face data-player-id="0" data-viewer=""><span data-testid="life">20</span></div>
      <div data-player-face data-player-id="1"><span data-testid="life">20</span></div>
      <div data-zone="battlefield" data-owner="you"><li class="board-card" data-board-card="8" data-card-id="8"></li></div>
      <div data-zone="battlefield" data-owner="them"></div>
      <div class="board__overlay" data-board-overlay=""></div>
    </div>`;
  document.body.append(canvas);
  const boxes: Record<string, Box> = {
    '[data-board-overlay]': { left: 0, top: 0, width: 1000, height: 800 },
    '[data-player-face][data-player-id="0"]': { left: 100, top: 700, width: 60, height: 60 },
    '[data-player-face][data-player-id="1"]': { left: 100, top: 20, width: 60, height: 60 },
    '[data-board-card="8"]': { left: 600, top: 500, width: 60, height: 84 },
  };
  for (const [selector, box] of Object.entries(boxes)) canvas.querySelector<HTMLElement>(selector)!.getBoundingClientRect = () => rect(box);
  return { canvas, overlay: canvas.querySelector<HTMLElement>('[data-board-overlay]')! };
}

describe('installNumbers: the same resolution again plays faster', () => {
  /** The Foundry's ability resolving, a gain of 1 flying from it to its controller: `turn`'s `life`. */
  function loop(handle: ReturnType<typeof installNumbers>, id: number, life: number, turn = 1): void {
    const foundry = card(8, 'Thopter Foundry');
    handle.notify(view([player(0, life - 1, { isViewer: true, battlefield: [foundry] }), player(1, 20)], [ability(id, 8, 'Thopter Foundry', 'Make a Thopter. You gain 1 life.')], turn));
    handle.notify(view([player(0, life, { isViewer: true, battlefield: [foundry] }), player(1, 20)], [], turn));
  }

  it('each loop’s hit lands sooner, to the cap; the match log’s beats say how fast', () => {
    vi.useFakeTimers();
    const { canvas, overlay } = boardDom();
    const reports: Record<string, string | number | boolean>[] = [];
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false, report: (d) => reports.push(d) });
    const lands: number[] = [];
    for (let n = 1; n <= 8; n++) {
      loop(handle, 100 + n, 20 + n);
      const ball = overlay.querySelector<HTMLElement>('.effect-hit');
      expect(ball?.style.getPropertyValue('--tempo'), `loop ${n}: the mark carries its tempo`).toBe(String(tempoOf(n)));
      let ms = 0;
      while (overlay.querySelector('.effect-hit') !== null && ms < HIT_MS + 10) {
        vi.advanceTimersByTime(1);
        ms += 1;
      }
      lands.push(ms);
      vi.advanceTimersByTime(5_000);
    }
    // A timer runs to the whole ms.
    expect(lands.map((ms, i) => Math.abs(ms - HIT_MS / tempoOf(i + 1)) <= 1)).toEqual(lands.map(() => true));
    expect(lands[0]).toBe(HIT_MS);
    expect(lands[6], 'the seventh is at the cap').toBe(Math.round(HIT_MS / TEMPO_CAP));
    expect(lands[7], 'and stays there').toBe(lands[6]);
    const beats = reports.filter((r) => r.what === 'beats');
    expect(beats.map((r) => r.tempo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map(tempoOf));
    expect(Number(beats.at(-1)!.totalMs), 'the capped loop’s beats are the first’s over the cap').toBe(Math.round(Number(beats[0]!.totalMs) / TEMPO_CAP));
    handle.dispose();
  });

  it('the next turn starts again at 1×', () => {
    vi.useFakeTimers();
    const { canvas } = boardDom();
    const reports: Record<string, string | number | boolean>[] = [];
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false, report: (d) => reports.push(d) });
    for (let n = 1; n <= 3; n++) {
      loop(handle, 100 + n, 20 + n, 1);
      vi.advanceTimersByTime(5_000);
    }
    loop(handle, 200, 24, 2);
    const beats = reports.filter((r) => r.what === 'beats');
    expect(beats.map((r) => r.tempo), 'turn 2’s first is 1× again').toEqual([1, 1.25, 1.5, 1]);
    expect(beats.map((r) => r.totalMs)).toEqual([HIT_MS, Math.round(HIT_MS / 1.25), Math.round(HIT_MS / 1.5), HIT_MS]);
    handle.dispose();
  });

  it('the life counter’s punch and the number rise at the hit’s tempo', () => {
    vi.useFakeTimers();
    const { canvas, overlay } = boardDom();
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false });
    for (let n = 1; n <= 3; n++) {
      loop(handle, 100 + n, 20 + n);
      vi.advanceTimersByTime(HIT_MS / tempoOf(n));
      const life = canvas.querySelector<HTMLElement>('[data-player-id="0"] [data-testid="life"]')!;
      expect(life.dataset.lifeLanded, `loop ${n}`).toBe('punch');
      expect(life.style.getPropertyValue('--tempo')).toBe(String(tempoOf(n)));
      expect(overlay.querySelector<HTMLElement>('.board-number')?.style.getPropertyValue('--tempo')).toBe(String(tempoOf(n)));
      vi.advanceTimersByTime(5_000);
    }
    handle.dispose();
  });
});

describe('installNumbers: Blasphemous Act is one instance', () => {
  it('every fireball of one resolution flies at that resolution’s tempo, and a second cast is the second instance', () => {
    vi.useFakeTimers();
    const { canvas, overlay } = boardDom();
    const them = canvas.querySelector('[data-zone="battlefield"][data-owner="them"]')!;
    const bears = [21, 22, 23];
    for (const [i, id] of bears.entries()) {
      them.insertAdjacentHTML('beforeend', `<li class="board-card" data-board-card="${id}" data-card-id="${id}"></li>`);
      canvas.querySelector<HTMLElement>(`[data-board-card="${id}"]`)!.getBoundingClientRect = () => rect({ left: 300 + 70 * i, top: 100, width: 60, height: 84 });
    }
    const reports: Record<string, string | number | boolean>[] = [];
    const handle = installNumbers(canvas, { reducedMotion: () => false, fastMode: () => false, report: (d) => reports.push(d) });
    const field = (damage: number) => view([player(0, 20, { isViewer: true, battlefield: [card(8, 'Thopter Foundry')] }), player(1, 20, { battlefield: bears.map((id) => card(id, `Bear ${id}`, { damage })) })]);
    const cast = (id: number, seq: number): void => {
      // The spell as the stack layer draws it: where its fireballs come from.
      overlay.insertAdjacentHTML('beforeend', `<div data-placed-spell="${id}"></div>`);
      overlay.querySelector<HTMLElement>(`[data-placed-spell="${id}"]`)!.getBoundingClientRect = () => rect({ left: 480, top: 380, width: 60, height: 84 });
      handle.notify({ ...field(0), stack: [spell(id, 99, 'Blasphemous Act')], hits: [] });
      handle.notify({ ...field(1), hits: bears.map((cardId, i) => ({ seq: seq + i, cardId, sourceId: 99, amount: 1 })) });
    };
    const tempos = (): string[] => [...overlay.querySelectorAll<HTMLElement>('.effect-hit')].map((b) => b.style.getPropertyValue('--tempo'));
    cast(40, 1);
    vi.advanceTimersByTime(2 * BOLT_STAGGER_MS);
    expect(tempos(), 'its three fireballs, one after another, all at 1×').toEqual(['1', '1', '1']);
    vi.advanceTimersByTime(3_000);
    expect(tempos(), 'every bolt has landed').toEqual([]);
    cast(41, 10);
    vi.advanceTimersByTime((2 * BOLT_STAGGER_MS) / 1.25);
    expect(tempos(), 'the second cast’s three, all at its own tempo').toEqual(['1.25', '1.25', '1.25']);
    vi.advanceTimersByTime(3_000);
    expect(reports.filter((r) => r.what === 'beats').map((r) => [r.hits, r.tempo]), 'three fireballs are one instance; the second cast the second').toEqual([
      [3, 1],
      [3, 1.25],
    ]);
    handle.dispose();
  });
});

describe('diffViews and instanceKey agree on both screens', () => {
  it('the same two views key the same instance, whichever seat diffs them', () => {
    const foundry = card(8, 'Thopter Foundry');
    const before = (viewer: 0 | 1) => view([player(0, 20, { isViewer: viewer === 0, battlefield: [foundry] }), player(1, 20, { isViewer: viewer === 1 })], [ability(40, 8, 'Thopter Foundry', 'Make a Thopter.')]);
    const after = (viewer: 0 | 1) => view([player(0, 21, { isViewer: viewer === 0, battlefield: [foundry] }), player(1, 20, { isViewer: viewer === 1 })]);
    expect(instanceKey(diffViews(before(0), after(0)), [], after(0))).toBe(instanceKey(diffViews(before(1), after(1)), [], after(1)));
  });
});
