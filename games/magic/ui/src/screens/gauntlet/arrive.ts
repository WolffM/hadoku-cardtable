/*
 * From the ban/pick board into choosing a deck: the step change both seats receive at once (the
 * snake's last pick puts the server in `choose`), drawn as something the decks themselves do rather
 * than a cut (the operator, 2026-11-02: "it looks a bit cheap at the moment that it hard cuts to the
 * next step there").
 *
 * For the length of it the board as it was left (`GauntletBoard`'s `leaving`) lies under the choose
 * screen, which is live from its first frame. Everything the choose screen carries over from the
 * board — each surviving deck, each player's name, the era's title — is drawn by the choose screen
 * itself, starting where the board drew it: the board's own copy steps aside at once, and the choose
 * screen's real element travels and resizes from that box into its own, as the room's mode cards do
 * (`constructed-mode/ModeRow.tsx`): no snapshot of either size is ever drawn, so nothing is
 * stretched. Every deck sets off at once (a glide, the operator's pick of two, 2026-11-02: "Glide
 * looks nice, ship it"), about 0.85 s. The banned decks fall away off the board, its empty slots
 * and turn banner fade, and what is the choose screen's alone (the game's number, each seat's
 * Chosen pill) eases in. The choose screen's height goes from the board's to its own on the same
 * curve, so a page scrolled to the board slides with the decks instead of jumping after them.
 *
 * Nothing waits on it. The tiles that fly are the choose screen's own buttons, pressable throughout,
 * and a press holds the motion still until it is let go, so the tile under the pointer is still the
 * one under it when the click lands. Under `prefers-reduced-motion` it is a crossfade: the whole
 * board out, the choose screen in. A face is drawn by `DeckArt` alone, which never draws one before
 * its art decodes.
 *
 * Built as measure (the DOM), {@link plan} (pure: boxes in, animations out) and run (the DOM), so the
 * choreography is tested without a layout engine.
 */
import type { GauntletView } from '@hadoku/shared';

import { HOUSE_CURVE } from '../../play/lift.ts';
import { prefersReducedMotion } from '@hadoku/ui-shell/motion';

/**
 * The board to leave, when `next` is the step change out of ban/pick: the board as it was last
 * drawn (`prev`), with the last pick still lying where it was pressed. A screen that opens on the
 * choice (a reload, a late joiner) or comes back to it after a game has no board to leave.
 */
export function boardToLeave(prev: GauntletView | null, next: GauntletView): GauntletView | null {
  return prev !== null && prev.phase === 'banpick' && next.phase === 'choose' ? prev : null;
}

/** A box in viewport coordinates. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the transition moves, read off the two screens. `E` is an element; {@link plan} never looks inside one. */
export interface Measured<E> {
  /** The board as it was left. */
  board: E;
  /** The choose screen's own parts that a crossfade fades in: its title and its seats. */
  content: readonly E[];
  /**
   * Each of the choose screen's deck tiles, in reading order: the box the board drew the same deck in,
   * its own, and the rows each tile is laid out in at either end (`rows`, px, as many at both ends; a
   * row the board's tile does not draw is 0). `reveal`: what the board's tile did not show (a column's
   * tile has no pilot line), which comes in over the flight.
   */
  tiles: readonly { el: E; from: Box | null; to: Box; rows?: readonly [readonly number[], readonly number[]]; reveal?: readonly E[] }[];
  /** The board's banned decks, in draw order. */
  banned: readonly E[];
  /** The board's parts that only fade: its empty slots and its turn banner. */
  fading: readonly E[];
  /** Parts both screens draw, at the same size: the era's title and each player's name. */
  carried: readonly { el: E; from: Box; to: Box }[];
  /** The choose screen's parts the board had none of: the game's number and each seat's pill. */
  arriving: readonly E[];
  /** The choose screen's rows of picks, held at their own height while their tiles are smaller. */
  rows: readonly { el: E; h: number }[];
  /** The choose screen itself: as tall as the board it replaces, then its own height. */
  screen: { el: E; from: number; to: number };
}

export interface Step<E> {
  el: E;
  keyframes: Keyframe[];
  timing: KeyframeAnimationOptions;
}

/** The crossfade under `prefers-reduced-motion`. */
export const CROSSFADE_MS = 320;

/** One deck's flight, and between one deck setting off and the next: every deck at once, near enough. */
const FLY_MS = 700;
const FLY_STAGGER_MS = 30;
/** One banned deck's fall, and between one and the next. */
const FALL_MS = 420;
const FALL_STAGGER_MS = 40;
/** The board's slots and turn banner fading. */
const FADE_MS = 260;
/** The choose screen's own parts easing in, from when, and for how long. */
const ARRIVE_FROM_MS = 450;
const ARRIVE_MS = 300;

/** How a banned deck falls off the board: a short drop, a slight turn, gone. */
const FALL_EASE = 'cubic-bezier(0.5, 0, 0.75, 0)';
/** How what fades, fades. */
const FADE_EASE = 'ease-out';

const px = (n: number): string => `${Math.round(n * 100) / 100}px`;

/** A box drawn as the element whose own box is `to`: offset by a transform, sized by its own width and height, laid out in `rows`. */
function placed(at: Box, to: Box, rows: readonly number[] | undefined): Keyframe {
  return {
    transform: `translate(${px(at.x - to.x)}, ${px(at.y - to.y)})`,
    width: px(at.w),
    height: px(at.h),
    ...(rows === undefined ? {} : { gridTemplateRows: rows.map(px).join(' ') }),
  };
}

/**
 * The keyframes of one flight from `from` to `to`. `rows`: the tile's rows at either end, so it is
 * laid out as the board drew it on its first frame and as its own on its last — sizes and rows move
 * on one curve, so they agree all the way.
 */
export function flightFrames(from: Box, to: Box, rows?: readonly [readonly number[], readonly number[]]): Keyframe[] {
  return [placed(from, to, rows?.[0]), placed(to, to, rows?.[1])];
}

/** A tile's rows, read off the page in px; `null` when one is not a length (nothing to move between). */
export function trackSizes(gridTemplateRows: string): number[] | null {
  const sizes = gridTemplateRows.trim().split(/\s+/).map((t) => (/^-?[\d.]+px$/.test(t) ? Number.parseFloat(t) : Number.NaN));
  return sizes.length === 0 || sizes.some(Number.isNaN) ? null : sizes;
}

/** Every animation of the transition. `reduced`: the crossfade alone. */
export function plan<E>(m: Measured<E>, reduced: boolean): Step<E>[] {
  if (reduced) {
    const fade = { duration: CROSSFADE_MS, easing: FADE_EASE } as const;
    return [
      { el: m.board, keyframes: [{ opacity: 1 }, { opacity: 0 }], timing: { ...fade, fill: 'forwards' } },
      ...m.content.map((el) => ({ el, keyframes: [{ opacity: 0 }, { opacity: 1 }], timing: { ...fade, fill: 'backwards' } as const })),
    ];
  }
  const flights = m.tiles.flatMap(({ el, from, to, rows, reveal = [] }, i): Step<E>[] => {
    const timing = { duration: FLY_MS, delay: i * FLY_STAGGER_MS, easing: HOUSE_CURVE, fill: 'backwards' } as const;
    // A deck the board did not draw (none should be) comes in where it ends, as the chrome does.
    if (from === null) return [{ el, keyframes: [{ opacity: 0 }, { opacity: 1 }], timing }];
    return [{ el, keyframes: flightFrames(from, to, rows), timing }, ...reveal.map((part) => ({ el: part, keyframes: [{ opacity: 0 }, { opacity: 1 }], timing: { ...timing, easing: FADE_EASE } }))];
  });
  const landed = Math.max(...m.tiles.map((_, i) => i * FLY_STAGGER_MS + FLY_MS));
  const end = Math.max(ARRIVE_FROM_MS + ARRIVE_MS, landed);
  return [
    // The choose screen starts as tall as the board and shortens (or grows) to its own height with the
    // decks, the board clipped to it: a page scrolled to the board slides to the choose screen with
    // them, where it would jump once the board was gone.
    { el: m.screen.el, keyframes: [{ height: px(m.screen.from) }, { height: px(m.screen.to) }], timing: { duration: landed, easing: HOUSE_CURVE, fill: 'backwards' } },
    ...flights,
    ...m.banned.map((el, i) => ({
      el,
      // Alternate tilts, so four bans do not fall as one sheet.
      keyframes: [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(48px) rotate(${i % 2 === 0 ? -5 : 5}deg)` }],
      timing: { duration: FALL_MS, delay: i * FALL_STAGGER_MS, easing: FALL_EASE, fill: 'forwards' } as const,
    })),
    ...m.fading.map((el) => ({ el, keyframes: [{ opacity: 1 }, { opacity: 0 }], timing: { duration: FADE_MS, easing: FADE_EASE, fill: 'forwards' } as const })),
    ...m.carried.map(({ el, from, to }) => ({
      el,
      keyframes: [{ transform: `translate(${px(from.x - to.x)}, ${px(from.y - to.y)})` }, { transform: 'none' }],
      timing: { duration: FLY_MS, easing: HOUSE_CURVE, fill: 'backwards' } as const,
    })),
    ...m.arriving.map((el) => ({
      el,
      keyframes: [
        { opacity: 0, transform: 'translateY(-4px)' },
        { opacity: 1, transform: 'none' },
      ],
      timing: { duration: ARRIVE_MS, delay: ARRIVE_FROM_MS, easing: FADE_EASE, fill: 'backwards' } as const,
    })),
    ...m.rows.map(({ el, h }) => ({ el, keyframes: [{ height: px(h) }, { height: px(h) }], timing: { duration: end } })),
  ];
}

/** The whole transition's length: when its last animation ends. */
export function planMs<E>(steps: readonly Step<E>[]): number {
  return Math.max(0, ...steps.map((s) => Number(s.timing.delay ?? 0) + Number(s.timing.duration ?? 0)));
}

const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

/** The two screens, read: the choose screen `section` and the board it is leaving, drawn inside it. */
export function measure(section: HTMLElement, board: HTMLElement): Measured<HTMLElement> {
  const all = <T extends Element = HTMLElement>(root: ParentNode, sel: string): T[] => [...root.querySelectorAll<T & HTMLElement>(sel)];
  const own = (sel: string): HTMLElement[] => all(section, sel).filter((el) => !board.contains(el));
  const boardTile = new Map(all(board, '.gauntlet-tile').map((el) => [el.dataset.deckId, el] as const));
  const carry = (pairs: readonly (readonly [Element | null, HTMLElement | null])[]) =>
    pairs.flatMap(([from, el]) => (from === null || el === null ? [] : [{ el, from: boxOf(from), to: boxOf(el) }]));
  return {
    board,
    content: own(':scope > .gauntlet__title, :scope > .gauntlet__seats'),
    tiles: own('.gauntlet__picks > .gauntlet-tile').map((el) => {
      const from = boardTile.get(el.dataset.deckId);
      if (from === undefined) return { el, from: null, to: boxOf(el) };
      // A part is named by its first class: a face that decoded late carries a second one.
      const part = (c: Element): string => c.classList[0] ?? c.tagName;
      const was = new Set([...from.children].filter((c) => getComputedStyle(c).display !== 'none').map(part));
      const a = trackSizes(getComputedStyle(from).gridTemplateRows);
      const b = trackSizes(getComputedStyle(el).gridTemplateRows);
      const n = Math.max(a?.length ?? 0, b?.length ?? 0);
      const pad = (sizes: number[]): number[] => [...sizes, ...Array<number>(n - sizes.length).fill(0)];
      return {
        el,
        from: boxOf(from),
        to: boxOf(el),
        ...(a === null || b === null ? {} : { rows: [pad(a), pad(b)] as const }),
        reveal: [...el.children].filter((c): c is HTMLElement => c instanceof HTMLElement && getComputedStyle(c).display !== 'none' && !was.has(part(c))),
      };
    }),
    banned: all(board, '.gauntlet-tile[data-status="banned"]'),
    fading: all(board, '.gauntlet__slot, .gauntlet__turn'),
    carried: carry([
      [board.querySelector('.gauntlet__era'), section.querySelector<HTMLElement>(':scope > .gauntlet__title > .gauntlet__era')],
      ...own('.gauntlet__seat-head > .gauntlet__player').map((el) => [board.querySelector(`.gauntlet__player[data-seat="${el.dataset.seat}"]`), el] as const),
    ]),
    arriving: own(':scope > .gauntlet__title > .gauntlet__game, .gauntlet__seat-head > .pill'),
    rows: own('.gauntlet__picks').map((el) => ({ el, h: el.getBoundingClientRect().height })),
    // The board is clipped to the choose screen's box (`gauntlet.css`), so its own height is where its parts end.
    screen: { el: section, from: Math.max(0, ...[...board.children].map((c) => c.getBoundingClientRect().bottom)) - board.getBoundingClientRect().top, to: section.getBoundingClientRect().height },
  };
}

export interface Arriving {
  /** Settles once every part has come to rest; never if cancelled first. */
  done: Promise<void>;
  cancel: () => void;
}

/**
 * Runs the transition on `section` (the choose screen) over `board` (the board it leaves, drawn inside
 * it), measured as both are drawn now. A browser that cannot animate elements is done at once.
 */
export function arrive(section: HTMLElement, board: HTMLElement): Arriving {
  if (typeof section.animate !== 'function') return { done: Promise.resolve(), cancel: () => undefined };
  const reduced = prefersReducedMotion();
  const running = plan(measure(section, board), reduced).map((s) => s.el.animate(s.keyframes, s.timing));
  // Drawn unclipped, the board holds the page open as the board before it did, so the first layout
  // clamps no scroll; clipped once the choose screen's own height holds it (`gauntlet.css`).
  if (!reduced) board.dataset.held = '';
  // A press holds every part still, so the click lands on the tile that was under the pointer when it went down.
  const held = new Set<Animation>();
  const hold = (): void => {
    for (const a of running) {
      if (a.playState !== 'running') continue;
      a.pause();
      held.add(a);
    }
  };
  const release = (): void => {
    for (const a of held) a.play();
    held.clear();
  };
  section.addEventListener('pointerdown', hold, true);
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  let live = true;
  const stop = (): void => {
    live = false;
    section.removeEventListener('pointerdown', hold, true);
    window.removeEventListener('pointerup', release, true);
    window.removeEventListener('pointercancel', release, true);
  };
  const done = new Promise<void>((resolve) => {
    void Promise.all(running.map((a) => a.finished)).then(
      () => {
        if (!live) return;
        stop();
        resolve();
      },
      // Only `cancel` below rejects a `finished`: the screen went, and nothing is left to settle.
      () => undefined,
    );
  });
  return {
    done,
    cancel: () => {
      stop();
      for (const a of running) a.cancel();
    },
  };
}
