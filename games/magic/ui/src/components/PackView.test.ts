// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { DraftCard } from '../draft/types.ts';
import { setRolePlayer } from '@hadoku/game-ui/sound/index.ts';
import type { SoundEvent } from '@hadoku/ui-shell/sound';
import { PackView } from './PackView.tsx';

function card(i: number): DraftCard {
  return {
    cardId: `c${i}`,
    name: `Card ${i}`,
    manaCost: ['1'],
    manaValue: 1,
    colors: [],
    typeLine: 'Artifact',
    oracleText: '',
    setCode: 'TST',
    collectorNumber: String(i),
    rarity: 'common',
  };
}
const PACK = Array.from({ length: 15 }, (_, i) => card(i));

// The fan draws only once it has measured its box; jsdom has no layout, so the
// box is a stub: 1000 x 600, the size of the pack's three quarters on a laptop.
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly cb: () => void) {}
      observe(): void {
        this.cb();
      }
      disconnect(): void {}
    },
  );
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1000, height: 600, left: 0, top: 0, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
});
afterEach(() => {
  cleanup();
  setRolePlayer(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const open = (): number => [...document.querySelectorAll('.pack__slot')].findIndex((s) => s.hasAttribute('data-focused'));
const tile = (i: number) => screen.getAllByTestId('card')[i]!;
const step = (by: 1 | -1) => fireEvent.keyDown(window, { key: by > 0 ? 'ArrowRight' : 'ArrowLeft' });
const wheelOn = (el: Element): WheelEvent => {
  const e = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(e);
  });
  return e;
};

function mount(onPick = vi.fn()) {
  const utils = render(createElement(PackView, { cards: PACK, layout: 'fan', onPick, disabled: false, emptyNote: '' }));
  return { onPick, ...utils };
}

describe('the fan', () => {
  it('opens on the first card', () => {
    mount();
    expect(screen.getByTestId('pack').className).toContain('pack--fan');
    expect(open()).toBe(0);
  });

  // 2026-11-16: hovering the currently viewed draft card zooms it like every other hover —
  // the open card alone is inspectable while picking; its neighbours, read in the related row
  // instead (the operator, 2026-10-19: no enlarged DUPLICATE beside the already-full-size open
  // card), are not.
  it('gives the shared inspector only the open card to zoom, in a picking fan', () => {
    mount();
    const slots = [...screen.getByTestId('pack').querySelectorAll('.pack__slot')];
    const tagged = slots.filter((el) => /^w\d+$/.test(el.getAttribute('data-card-id') ?? ''));
    expect(tagged).toHaveLength(1);
    expect(tagged[0]!.hasAttribute('data-focused')).toBe(true);
  });

  it('moves the inspector tag with the open card as the arrow keys step it', () => {
    mount();
    step(1);
    const slots = [...screen.getByTestId('pack').querySelectorAll('.pack__slot')];
    const tagged = slots.filter((el) => /^w\d+$/.test(el.getAttribute('data-card-id') ?? ''));
    expect(tagged).toHaveLength(1);
    expect(tagged[0]!.hasAttribute('data-focused')).toBe(true);
    expect(open()).toBe(1);
  });

  // The operator, 2026-11-01, on Rally's sample pack: a fan nothing picks from is read, so hover opens the inspector.
  it('a fan nothing picks from opens the inspector on its drawn cards', () => {
    const dfc = { ...card(0), name: 'Front', faces: [{ ...card(99), name: 'Back' }] } as DraftCard;
    render(createElement(PackView, { cards: [dfc, ...PACK.slice(1)], layout: 'fan', disabled: false, emptyNote: '' }));
    const drawn = [...screen.getByTestId('pack').querySelectorAll('.pack__slot:not([data-off])')];
    expect(drawn.length).toBeGreaterThan(0);
    for (const slot of drawn) expect(slot.getAttribute('data-card-id')).toMatch(/^w\d+$/);
  });

  // The operator, 2026-11-05: "mouse wheel was never supposed to move the fan, only left and right
  // arrow do that. mouse wheel is reserved for seeing transforms".
  it('never moves on the wheel, over a card or not, and leaves the wheel to the inspector and the page', () => {
    const dfc = { ...card(0), name: 'Front', faces: [{ ...card(99), name: 'Back' }] } as DraftCard;
    render(createElement(PackView, { cards: [dfc, ...PACK.slice(1)], layout: 'fan', disabled: false, emptyNote: '' }));
    for (const el of [tile(0), tile(1), screen.getByTestId('pack')]) {
      expect(wheelOn(el).defaultPrevented).toBe(false);
      expect(open()).toBe(0);
    }
  });

  it('steps one card per arrow key, either way, and stops at the ends', () => {
    mount();
    step(1);
    expect(open()).toBe(1);
    step(1);
    step(1);
    expect(open()).toBe(3);
    step(-1);
    step(-1);
    expect(open()).toBe(1);
    for (let i = 0; i < 20; i++) step(-1);
    expect(open()).toBe(0);
    for (let i = 0; i < 30; i++) step(1);
    expect(open()).toBe(14);
  });

  it('opens a card that is not open on the first click, and picks it on the next', () => {
    const { onPick } = mount();
    fireEvent.click(tile(3));
    expect(onPick).not.toHaveBeenCalled();
    expect(open()).toBe(3);
    fireEvent.click(tile(3));
    expect(onPick).toHaveBeenCalledWith('c3');
  });

  it('picks the open card on one click', () => {
    const { onPick } = mount();
    fireEvent.click(tile(0));
    expect(onPick).toHaveBeenCalledWith('c0');
  });

  it('draws seven cards from the first, and the rest once the row is stepped to them', () => {
    mount();
    const drawn = () => [...document.querySelectorAll('.pack__slot')].flatMap((el, i) => (el.hasAttribute('data-off') ? [] : [i]));
    expect(drawn()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (let i = 0; i < 10; i++) step(1);
    expect(drawn()).toEqual([7, 8, 9, 10, 11, 12, 13]);
    for (let i = 0; i < 10; i++) step(1);
    expect(drawn()).toEqual([8, 9, 10, 11, 12, 13, 14]);
  });

  it('opens nothing by passing the pointer over a card', () => {
    mount();
    fireEvent.pointerMove(screen.getByTestId('pack'), { clientX: 10, clientY: 300 });
    fireEvent.pointerEnter(tile(5).parentElement!);
    expect(open()).toBe(0);
  });

  // The operator, 2026-10-22: "hovering over cards with transforms no longer shows the related state" —
  // the related row read a table built off one cube, so a card any other cube or set deals had none.
  it('shows the hovered card’s back face and tokens under it, for any card', async () => {
    vi.stubGlobal(
      'Image',
      class {
        src = '';
        decode(): Promise<void> {
          return Promise.resolve();
        }
      },
    );
    const delver: DraftCard = {
      ...card(0),
      name: 'Delver of Secrets // Insectile Aberration',
      faces: [{ ...card(1), scryfallId: '11bf83bb-c95b-4b4f-9a56-ce7a1816307a#back', name: 'Insectile Aberration' }],
    };
    const pick: DraftCard = { ...card(2), name: 'Goldvein Pick' };
    const root = document.createElement('div');
    const layer = document.createElement('div');
    layer.setAttribute('data-board-zoom', '');
    const host = document.createElement('div');
    root.append(host, layer);
    document.body.append(root);
    render(createElement(PackView, { cards: [delver, pick, ...PACK.slice(3)], layout: 'fan', onPick: vi.fn(), disabled: false, emptyNote: '' }), { container: host });
    const related = async (i: number) => {
      await act(async () => {
        fireEvent.pointerEnter(tile(i).parentElement!);
      });
      return [...(layer.querySelector('[data-testid="pack-related"]')?.querySelectorAll('img') ?? [])].map((img) => img.alt);
    };
    expect(await related(0)).toEqual(['Insectile Aberration']);
    expect(await related(1)).toEqual(['Treasure']);
    root.remove();
  });

  it('picks the open card on Enter, and moves along the row on the arrows', () => {
    const { onPick } = mount();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(open()).toBe(2);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(open()).toBe(1);
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('c1');
  });

  it('leaves Enter alone while it is typed into a field, or while picking is off', () => {
    const onPick = vi.fn();
    const field = document.createElement('input');
    document.body.append(field);
    const { rerender } = render(createElement(PackView, { cards: PACK, layout: 'fan', onPick, disabled: false, emptyNote: '' }));
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
    rerender(createElement(PackView, { cards: PACK, layout: 'fan', onPick, disabled: true, emptyNote: '' }));
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
    field.remove();
  });

  it('plays the scroll sound once per step of the open card, and not on opening, at an end, or for a new pack', () => {
    const roles: string[] = [];
    setRolePlayer({ play: (e: SoundEvent) => void roles.push(e.role) });
    const { rerender, onPick } = mount();
    expect(roles).toEqual([]);
    step(1);
    step(1);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    // Opening a card by clicking it is a step, not a pick: no pick sound.
    fireEvent.click(tile(3));
    expect(open()).toBe(3);
    expect(roles).toEqual(['ui.draft-scroll', 'ui.draft-scroll', 'ui.draft-scroll', 'ui.draft-scroll']);
    fireEvent.click(tile(3));
    expect(onPick).toHaveBeenCalledWith(PACK[3]!.cardId);
    expect(roles.at(-1)).toBe('ui.draft-pick');
    roles.pop();
    for (let i = 0; i < 10; i++) step(-1);
    expect(roles).toHaveLength(7);
    rerender(createElement(PackView, { cards: PACK.slice(1), layout: 'fan', onPick, disabled: false, emptyNote: '' }));
    expect(roles).toHaveLength(7);
  });

  it('opens a new pack on its first card', () => {
    const { rerender, onPick } = mount();
    step(1);
    step(1);
    step(1);
    expect(open()).toBe(3);
    rerender(createElement(PackView, { cards: PACK.slice(1), layout: 'fan', onPick, disabled: false, emptyNote: '' }));
    expect(open()).toBe(0);
  });
});

describe('the grid', () => {
  it('picks on one click, with no card held open', () => {
    const onPick = vi.fn();
    render(createElement(PackView, { cards: PACK, layout: 'grid', onPick, disabled: false, emptyNote: '' }));
    expect(open()).toBe(-1);
    fireEvent.click(tile(3));
    expect(onPick).toHaveBeenCalledWith('c3');
  });

  it('picks the card under the pointer on Enter, and nothing once the pointer has left', () => {
    const onPick = vi.fn();
    render(createElement(PackView, { cards: PACK, layout: 'grid', onPick, disabled: false, emptyNote: '' }));
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.pointerEnter(tile(9).parentElement!);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('c9');
    fireEvent.pointerLeave(screen.getByTestId('pack'));
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledTimes(1);
  });
  // 15 cards in two rows of 8 columns at the stubbed 1000 x 600.
  it('moves a cursor with the arrow keys, a card along or a row up and down, and Enter picks it', () => {
    const onPick = vi.fn();
    render(createElement(PackView, { cards: PACK, layout: 'grid', onPick, disabled: false, emptyNote: '' }));
    expect(open()).toBe(-1);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(open()).toBe(0);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(open()).toBe(2);
    // A row is as many cards as the fitted grid draws across.
    const cols = Number(/repeat\((\d+)/.exec(screen.getByTestId('pack').style.gridTemplateColumns)![1]);
    expect(cols).toBeGreaterThan(1);
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(open()).toBe(2 + cols);
    // Past the bottom row it stays put.
    const bottom = 2 + cols * Math.floor((PACK.length - 1 - 2) / cols);
    for (let i = 0; i < 4; i++) fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(open()).toBe(bottom);
    for (let i = 0; i < 4; i++) fireEvent.keyDown(window, { key: 'ArrowUp' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(open()).toBe(1);
    // The pointer moves the same cursor, and the keys go on from there.
    fireEvent.pointerEnter(tile(6).parentElement!);
    expect(open()).toBe(6);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('c7');
  });

  // The operator, 2026-10-20: the wheel over a hovered grid card should turn to its tokens too.
  it("gives a card's tokens to the inspector's wheel after its back face", () => {
    const fable: DraftCard = {
      ...card(0),
      name: 'Fable of the Mirror-Breaker // Reflection of Kiki-Jiki',
      scryfallId: '24c0d87b-0049-4beb-b9cb-6f813b7aa7dc',
      faces: [{ ...card(1), scryfallId: '24c0d87b-0049-4beb-b9cb-6f813b7aa7dc#back', name: 'Reflection of Kiki-Jiki' }],
    };
    render(createElement(PackView, { cards: [fable], layout: 'grid', onPick: vi.fn(), disabled: false, emptyNote: '' }));
    const key = tile(0).getAttribute('data-faces');
    const faces = [...document.querySelectorAll(`[data-faces-of="${key}"] .card`)].map((el) => el.querySelector('.card__name')?.textContent);
    expect(faces).toEqual(['Reflection of Kiki-Jiki', 'Goblin Shaman', 'Treasure', 'Copy']);
  });
});

// The operator, 2026-11-07: "the card picked should be the one currently hovered." The pack says
// which card that is as it changes; the server takes it when the pick's time runs out.
describe('the lean: the card the drafter would take now', () => {
  const leans = (onLean: ReturnType<typeof vi.fn>): (string | null)[] => onLean.mock.calls.map((c) => c[0] as string | null);

  it('in the fan, is the open card, then the card under the pointer, then the open card again', () => {
    const onLean = vi.fn();
    render(createElement(PackView, { cards: PACK, layout: 'fan', onPick: vi.fn(), onLean, disabled: false, emptyNote: '' }));
    expect(leans(onLean).at(-1)).toBe('c0');
    fireEvent.pointerEnter(tile(2).parentElement!);
    expect(leans(onLean).at(-1)).toBe('c2');
    fireEvent.pointerLeave(tile(2).parentElement!);
    expect(leans(onLean).at(-1)).toBe('c0');
    step(1);
    expect(leans(onLean).at(-1)).toBe('c1');
  });

  it('in the grid, is nothing until a card is hovered or reached by the keyboard', () => {
    const onLean = vi.fn();
    render(createElement(PackView, { cards: PACK, layout: 'grid', onPick: vi.fn(), onLean, disabled: false, emptyNote: '' }));
    expect(leans(onLean)).toEqual([null]);
    fireEvent.pointerEnter(tile(7).parentElement!);
    expect(leans(onLean).at(-1)).toBe('c7');
  });

  it('says each change once, not on every render', () => {
    const onLean = vi.fn();
    const { rerender } = render(createElement(PackView, { cards: PACK, layout: 'fan', onPick: vi.fn(), onLean, disabled: false, emptyNote: '' }));
    const said = leans(onLean);
    expect(said.at(-1)).toBe('c0');
    rerender(createElement(PackView, { cards: PACK, layout: 'fan', onPick: vi.fn(), onLean, disabled: true, emptyNote: '' }));
    expect(leans(onLean)).toEqual(said);
  });
});

/* ── dragging: a card out of the pack, and the fan's row sideways ─────── */

/** A pointer event with a place: this DOM's own `PointerEvent` (where it has one) drops the coordinates. */
function pointer(el: Element, type: string, x: number, y: number): void {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  Object.defineProperty(e, 'pointerType', { value: 'mouse' });
  act(() => {
    el.dispatchEvent(e);
  });
}

/** Press `el` and drag it by `dx`, `dy` in two moves; `release` lets go there, and fires the click a real release on the same card would. */
function drag(el: Element, dx: number, dy: number, release = true): void {
  pointer(el, 'pointerdown', 500, 300);
  pointer(el, 'pointermove', 500 + dx / 2, 300 + dy / 2);
  pointer(el, 'pointermove', 500 + dx, 300 + dy);
  if (!release) return;
  pointer(el, 'pointerup', 500 + dx, 300 + dy);
  fireEvent.click(el);
}

/** What is under the pointer wherever it is: an element inside the picks (their sideboard when `side`), or nothing. */
function pointerOver(where: 'picks' | 'sideboard' | 'nothing'): void {
  const picks = document.createElement('section');
  picks.setAttribute('data-pick-drop', '');
  const main = picks.appendChild(document.createElement('div'));
  main.setAttribute('data-drop-area', 'deck');
  const side = picks.appendChild(document.createElement('div'));
  side.setAttribute('data-drop-area', 'pool');
  document.body.append(picks);
  document.elementFromPoint = () => (where === 'nothing' ? document.body : where === 'sideboard' ? side : main);
}

describe('dragging a card out of the pack (the operator, 2026-11-19)', () => {
  afterEach(() => {
    document.querySelectorAll('[data-pick-drop]').forEach((el) => el.remove());
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it('takes the card let go over the picks, saying where its copy was let go', () => {
    pointerOver('picks');
    const { onPick } = mount();
    drag(tile(2), 30, 250);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0]).toBe('c2');
    expect(onPick.mock.calls[0]![1]).toMatchObject({ to: 'deck', from: { left: 30, top: 250, width: 1000, height: 600 } });
  });

  it('takes the card into the sideboard when it is let go over the sideboard', () => {
    pointerOver('sideboard');
    const { onPick } = mount();
    drag(tile(1), 120, 250);
    expect(onPick).toHaveBeenCalledWith('c1', expect.objectContaining({ to: 'pool' }));
  });

  it('puts the card back when it is let go anywhere else, and the release picks nothing', () => {
    pointerOver('nothing');
    const { onPick } = mount();
    drag(tile(0), 0, -120);
    expect(onPick).not.toHaveBeenCalled();
    expect(document.querySelector('.pack__slot[data-lifted]')).toBeNull();
    expect(screen.getAllByTestId('card')).toHaveLength(15);
  });

  it('marks the card lifted while it is in the air, and tells the screen what it is over', () => {
    pointerOver('sideboard');
    const onLift = vi.fn();
    render(createElement(PackView, { cards: PACK, layout: 'fan', onPick: vi.fn(), onLift, disabled: false, emptyNote: '' }));
    drag(tile(3), 10, 200, false);
    expect([...document.querySelectorAll('.pack__slot')].findIndex((s) => s.hasAttribute('data-lifted'))).toBe(3);
    expect(onLift).toHaveBeenLastCalledWith({ over: 'pool' });
    pointer(tile(3), 'pointerup', 510, 500);
    expect(onLift).toHaveBeenLastCalledWith(null);
  });

  it('draws the lifted card’s copy in the screen’s top layer, where the pointer has taken it, ringed over somewhere that takes it', () => {
    pointerOver('picks');
    const layer = document.body.appendChild(document.createElement('div'));
    layer.setAttribute('data-board-zoom', '');
    mount();
    drag(tile(3), 40, 200, false);
    const ghost = layer.querySelector<HTMLElement>('[data-testid="pack-ghost"]')!;
    expect(ghost.querySelector('.card__name')?.textContent).toBe('Card 3');
    expect(ghost.querySelector('button')).toBeNull();
    expect(ghost.style.left).toBe('40px');
    expect(ghost.style.top).toBe('200px');
    expect(ghost.getAttribute('data-over')).toBe('deck');
    pointer(tile(3), 'pointercancel', 540, 500);
    expect(layer.querySelector('[data-testid="pack-ghost"]')).toBeNull();
    layer.remove();
  });

  it('Escape puts a lifted card back', () => {
    pointerOver('picks');
    const { onPick } = mount();
    drag(tile(0), 0, 200, false);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('.pack__slot[data-lifted]')).toBeNull();
    pointer(tile(0), 'pointerup', 500, 500);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('a press that does not travel is still a click: it opens a card, then takes it', () => {
    pointerOver('picks');
    const { onPick } = mount();
    drag(tile(2), 3, 3);
    expect(open()).toBe(2);
    expect(onPick).not.toHaveBeenCalled();
    drag(tile(2), 2, -4);
    expect(onPick).toHaveBeenCalledWith('c2');
  });

  it('lifts nothing while picking is off, or from a pack nothing picks from', () => {
    pointerOver('picks');
    const onPick = vi.fn();
    const { unmount } = render(createElement(PackView, { cards: PACK, layout: 'fan', onPick, disabled: true, emptyNote: '' }));
    drag(tile(0), 0, 250, false);
    expect(document.querySelector('.pack__slot[data-lifted]')).toBeNull();
    unmount();
    render(createElement(PackView, { cards: PACK, layout: 'fan', disabled: false, emptyNote: '' }));
    drag(tile(0), 0, 250, false);
    expect(document.querySelector('.pack__slot[data-lifted]')).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('lifts from the grid too, whichever way the card is dragged', () => {
    pointerOver('picks');
    const onPick = vi.fn();
    render(createElement(PackView, { cards: PACK, layout: 'grid', onPick, disabled: false, emptyNote: '' }));
    drag(tile(4), 200, 10);
    expect(onPick).toHaveBeenCalledWith('c4', expect.objectContaining({ to: 'deck' }));
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});

describe('dragging the fan sideways (the operator, 2026-11-19)', () => {
  // The stubbed box is 1000 wide: a card every 116 px.
  it('scrolls the row with the pointer, a card per step, and the release picks nothing', () => {
    const { onPick } = mount();
    drag(tile(0), -240, 10);
    expect(open()).toBe(2);
    drag(tile(2), 120, -8);
    expect(open()).toBe(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('stops at the pack’s ends', () => {
    mount();
    drag(tile(0), 400, 0);
    expect(open()).toBe(0);
    drag(tile(0), -5000, 0);
    expect(open()).toBe(14);
  });

  it('a flat stroke along the row pans; a card dragged off on a diagonal lifts', () => {
    const { onPick } = mount();
    drag(tile(0), -200, 99, false);
    expect(document.querySelector('.pack__slot[data-lifted]')).toBeNull();
    expect(open()).toBe(2);
    pointer(tile(0), 'pointerup', 300, 399);
    drag(tile(0), -200, 101, false);
    expect(document.querySelector('.pack__slot[data-lifted]')).not.toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('pans from the pack’s own background, whichever way it is dragged, and a pack nothing picks from pans from its cards', () => {
    render(createElement(PackView, { cards: PACK, layout: 'fan', disabled: false, emptyNote: '' }));
    drag(screen.getByTestId('pack'), -120, 300);
    expect(open()).toBe(1);
    drag(tile(1), -120, 300);
    expect(open()).toBe(2);
  });

  it('plays the scroll sound for each card it passes', () => {
    const roles: string[] = [];
    setRolePlayer({ play: (e: SoundEvent) => void roles.push(e.role) });
    mount();
    drag(tile(0), -240, 0);
    expect(roles.filter((role) => role === 'ui.draft-scroll').length).toBeGreaterThanOrEqual(1);
    expect(roles).not.toContain('ui.draft-pick');
  });

  it('the wheel still never moves the row, and the arrows still do', () => {
    mount();
    wheelOn(tile(0));
    expect(open()).toBe(0);
    step(1);
    expect(open()).toBe(1);
  });
});
