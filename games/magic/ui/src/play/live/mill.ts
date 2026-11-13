/*
 * Cards milled: put from a library into a graveyard, by a mill, a self-mill or a surveil. The operator,
 * 2026-11-01: "we need a 'milling' animation. something for cards put into the graveyard from the library."
 *
 * ## What is a mill, and from what
 *
 * {@link millsOf} diffs two views: a card in a graveyard now whose id was in a library before
 * (`BoardPlayer.libraryIds`, top first). Forge keeps a card's id across a zone change, and every seat
 * gets every library's ids (never their faces), so both screens find the same mills from the same frames,
 * the opponent's library as well as their own, live or in a replay. Nothing here knows a card's name.
 *
 * A card a player looks at can leave every zone list for a frame before it goes anywhere: Forge takes it out
 * of the library and puts it down a packet later (`games/magic/server/src/play/visibility.ts`'s `heldLibrary`, which
 * keeps it listed for a seat that knows it, and only for one). On the other seat's screen a surveil's card was
 * then in no zone before the frame that put it in the graveyard (measured: Notion Rain, one of its two cards
 * missed there). {@link setAsideAfter} remembers such a card, one that left a library list for no zone while
 * its owner's hand did not grow, and {@link millsOf} counts it as the library's. A hand that grew may have
 * drawn it, and a drawn card later discarded is no mill, so a frame in which a player's hand grows sets none of
 * their cards aside and forgets the ones they had.
 *
 * ## How it is drawn
 *
 * The pile draws the milled cards at once (`Board.tsx` renders the graveyard as it is). This module
 * hides each one there (`departures.ts`'s `[data-departure-landing]`) and flies a copy of it
 * (`departures.ts`'s `copyOfCard`), face up, from its library's count mark under the owner's avatar into
 * its place on the pile, where the hidden card is shown as the copy lands. The copies go one by one,
 * top of the library first, `MILL_STAGGER_MS` apart, from the beat `live/numbers.ts` gives (the
 * resolution's effects, after a reveal's beat).
 *
 * A big mill is a riffle, not a queue of flights: {@link millTiming} keeps the whole run inside
 * `MILL_MAX_MS` (about the length of the mill sound) by shortening the flights and the gap between
 * them, and flies at most `MILL_MAX_FLYERS` copies, picked evenly through the run; the rest are shown
 * as the last copy lands.
 *
 * ## The art first
 *
 * A milled card from the other library was never on this screen before, so its art may still be
 * loading: the run starts once every flown card's art has decoded (`artReady`), the pile keeping them
 * hidden meanwhile (the operator, 2026-10-09: "i really dont want a no-art card to show ever"). A run
 * whose art takes longer than `ART_WAIT_MS` is shown in the pile without a flight.
 *
 * ## It holds nothing
 *
 * The cards are in the graveyard already, so nothing waits for their flight but the spell that milled them, which
 * stays on the stack until the last lands. The other seat's next frame is not held for it (`pace.ts`): Forge sends
 * one mill in more than one frame (Glimpse the Unthinkable: nine cards, then the tenth with the resolution), and a
 * hold kept the second frame off the other screen until the first run had landed, a second and a half for one mill.
 * A run that starts while another is flying flies beside it.
 *
 * Reduced motion: no flight; each card fades in on the pile at its turn.
 */

import type { BoardView } from '../adapter.ts';
import { artReady, cardImageUrl } from '../../draft/cardImage.ts';
import { prefersReducedMotion } from '@hadoku/ui-shell/motion';
import { faceBox, overlayOf } from './board-dom.ts';
import { copyOfCard, LANDING_ATTR } from './departures.ts';
import './mill.css';
import { markTempo } from './tempo.ts';

/** One card milled: out of `fromPlayerId`'s library (`index` from its top) into `toPlayerId`'s graveyard. */
export interface Mill {
  readonly cardId: number;
  readonly fromPlayerId: number;
  readonly toPlayerId: number;
  readonly index: number;
  readonly scryfallId?: string;
}

/** A card out of a library and in no zone since: whose library, its place there, and how many views ago. */
export interface SetAside {
  readonly playerId: number;
  readonly index: number;
  readonly views: number;
}

/** How many views a card stays set aside before it is forgotten. */
export const SET_ASIDE_VIEWS = 30;

/** Every card id `view` lists anywhere: a library, a hand it shows, the table, a pile, the stack. */
function listed(view: BoardView): Set<number> {
  const out = new Set<number>();
  for (const p of view.players) {
    for (const id of p.libraryIds ?? []) out.add(id);
    for (const c of [...(p.hand ?? []), ...(p.handShown ?? []), ...(p.libraryTop ?? []), ...p.battlefield, ...p.graveyard, ...p.exile]) if (c !== null) out.add(c.id);
  }
  for (const item of view.stack) if (item.sourceCardId !== null) out.add(item.sourceCardId);
  return out;
}

/** The cards set aside after `next` (see the header): `carried`'s still in no zone, and any `next` took out of a library for none. Pure. */
export function setAsideAfter(prev: BoardView | null, next: BoardView, carried: ReadonlyMap<number, SetAside> = new Map()): Map<number, SetAside> {
  const now = listed(next);
  // A hand that grew may hold one of its owner's cards set aside (Impulse's pick): theirs are forgotten.
  const drew = new Set(next.players.filter((p) => p.handCount > (prev?.players.find((b) => b.id === p.id)?.handCount ?? p.handCount)).map((p) => p.id));
  const out = new Map<number, SetAside>();
  for (const [id, aside] of carried) if (!now.has(id) && !drew.has(aside.playerId) && aside.views + 1 < SET_ASIDE_VIEWS) out.set(id, { ...aside, views: aside.views + 1 });
  for (const before of prev?.players ?? []) {
    const after = next.players.find((p) => p.id === before.id);
    if (after === undefined) continue;
    const gone = (before.libraryIds ?? []).flatMap((id, index) => (now.has(id) ? [] : [{ id, index }]));
    if (gone.length === 0 || drew.has(before.id)) continue;
    for (const { id, index } of gone) out.set(id, { playerId: before.id, index, views: 0 });
  }
  return out;
}

/** The cards in a graveyard in `next` that were in a library in `prev`, or set aside from one since (`setAside`), each library top first. Pure. */
export function millsOf(prev: BoardView | null, next: BoardView, setAside: ReadonlyMap<number, SetAside> = new Map()): Mill[] {
  if (prev === null) return [];
  const inLibrary = new Map<number, { playerId: number; index: number }>();
  for (const [id, aside] of setAside) inLibrary.set(id, aside);
  for (const player of prev.players) (player.libraryIds ?? []).forEach((id, index) => inLibrary.set(id, { playerId: player.id, index }));
  if (inLibrary.size === 0) return [];
  const out: Mill[] = [];
  for (const player of next.players) {
    for (const card of player.graveyard) {
      const was = inLibrary.get(card.id);
      if (was === undefined) continue;
      const scryfallId = card.card.scryfallId;
      out.push({ cardId: card.id, fromPlayerId: was.playerId, toPlayerId: player.id, index: was.index, ...(scryfallId === undefined ? {} : { scryfallId }) });
    }
  }
  return out.sort((a, b) => a.fromPlayerId - b.fromPlayerId || a.index - b.index);
}

/** One card's flight, library to pile. */
export const MILL_FLIGHT_MS = 560;
/** Between one card leaving the library and the next. */
export const MILL_STAGGER_MS = 120;
/** A riffle's flights: shorter, so a big mill still ends inside `MILL_MAX_MS`. */
export const RIFFLE_FLIGHT_MS = 380;
/** The longest a run takes, its last card landed: about the mill sound's length (`g.mill`, 0.8 s). */
export const MILL_MAX_MS = 1000;
/** The most copies one run flies; the cards between them are shown as the last lands. */
export const MILL_MAX_FLYERS = 12;
/** The longest a run waits for its art before its cards are shown on the pile without flying. */
export const ART_WAIT_MS = 1500;
/** Reduced motion: each card's fade on the pile. */
export const MILL_FADE_MS = 240;

export interface MillTiming {
  /** Each flight's length. */
  readonly flightMs: number;
  /** When each card of the run leaves its library (ms from the run's start), or null for one that does not fly. */
  readonly starts: readonly (number | null)[];
  /** When the last card is on the pile. */
  readonly totalMs: number;
}

/** How a run of `count` cards flies (see the header's riffle). Pure. */
export function millTiming(count: number): MillTiming {
  if (count <= 0) return { flightMs: 0, starts: [], totalMs: 0 };
  const flyers = Math.min(count, MILL_MAX_FLYERS);
  const full = MILL_FLIGHT_MS + (flyers - 1) * MILL_STAGGER_MS;
  const flightMs = full <= MILL_MAX_MS ? MILL_FLIGHT_MS : RIFFLE_FLIGHT_MS;
  const staggerMs = flyers === 1 ? 0 : Math.min(MILL_STAGGER_MS, (MILL_MAX_MS - flightMs) / (flyers - 1));
  const starts: (number | null)[] = Array.from({ length: count }, () => null);
  for (let i = 0; i < flyers; i++) {
    const at = flyers === 1 ? 0 : Math.round((i * (count - 1)) / (flyers - 1));
    starts[at] = Math.round(i * staggerMs);
  }
  return { flightMs, starts, totalMs: Math.round((flyers - 1) * staggerMs + flightMs) };
}

/** On a flying copy: the milled card's id. */
export const MILL_ATTR = 'data-mill';
/** On a pile card fading in (reduced motion). */
const FADE_ATTR = 'data-mill-fade';

export interface MillHandle {
  /**
   * Draw `mills` (one frame's), starting `delayMs` from now, at `tempo` (`./tempo.ts`: `delayMs` and the return are on
   * the run's own clock). Hides them on their piles at once. Returns when the last lands, from now.
   */
  fly(mills: readonly Mill[], delayMs: number, tempo?: number): number;
  dispose(): void;
}

function seatOf(canvas: HTMLElement, playerId: number): ParentNode {
  return faceBox(canvas, playerId)?.closest('.seat') ?? canvas;
}

function pileCard(canvas: HTMLElement, mill: Mill): HTMLElement | null {
  const sel = `[data-zone="graveyard"] [data-board-card="${mill.cardId}"]`;
  return seatOf(canvas, mill.toPlayerId).querySelector<HTMLElement>(sel) ?? canvas.querySelector<HTMLElement>(sel);
}

/** Where a library's cards leave from: its count mark under the owner's avatar, else the owner's face. */
function libraryOf(canvas: HTMLElement, playerId: number): HTMLElement | null {
  return seatOf(canvas, playerId).querySelector<HTMLElement>('[data-testid="library-count"]') ?? faceBox(canvas, playerId);
}

export function installMill(
  canvas: HTMLElement,
  reduced: () => boolean = prefersReducedMotion,
  report?: (data: Record<string, string | number | boolean>) => void,
): MillHandle {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const flyers = new Set<HTMLElement>();
  /** Every card hidden on a pile and not yet shown. */
  const hidden = new Set<number>();
  let live = true;

  function schedule(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      timers.delete(t);
      if (live) fn();
    }, ms);
    timers.add(t);
  }

  /** Show a hidden card on its pile, as it is drawn now (React may have drawn the pile again meanwhile). */
  function show(mill: Mill, tempo: number, fade = false): void {
    if (!hidden.delete(mill.cardId)) return;
    const el = pileCard(canvas, mill);
    if (el === null) return;
    el.removeAttribute(LANDING_ATTR);
    if (!fade) return;
    markTempo(el, tempo);
    el.setAttribute(FADE_ATTR, '');
    schedule(() => el.removeAttribute(FADE_ATTR), MILL_FADE_MS / tempo);
  }

  /** Fly one library's run: every box read, then every copy built. */
  function run(mills: readonly Mill[], artWaitMs: number, tempo: number): void {
    const timing = millTiming(mills.length);
    const root = overlayOf(canvas);
    const still = reduced() || root === null;
    // How each run was drawn, for the match log: what flew, and what could not be found to fly.
    const telemetry = (flying: number, unplaced: number): void =>
      report?.({ what: 'mill', library: mills[0]!.fromPlayerId, cards: mills.length, flying, unplaced, artWaitMs, totalMs: timing.totalMs, reduced: still });
    if (still) {
      telemetry(0, 0);
      mills.forEach((m, i) => schedule(() => show(m, tempo, true), Math.round((i * (timing.totalMs - MILL_FADE_MS)) / Math.max(1, mills.length - 1)) / tempo));
      return;
    }
    const box = root.getBoundingClientRect();
    const from = libraryOf(canvas, mills[0]!.fromPlayerId)?.getBoundingClientRect() ?? null;
    const plans = mills.flatMap((mill, i) => {
      const start = timing.starts[i];
      const el = pileCard(canvas, mill);
      if (start == null || el === null || from === null) return [];
      return [{ mill, start, el, at: el.getBoundingClientRect() }];
    });
    telemetry(plans.length, mills.filter((m, i) => timing.starts[i] != null && pileCard(canvas, m) === null).length + (from === null ? 1 : 0));
    for (const { mill, start, el, at } of plans) {
      const wrap = document.createElement('div');
      wrap.className = 'board-departure board-mill';
      wrap.setAttribute(MILL_ATTR, String(mill.cardId));
      wrap.setAttribute('aria-hidden', 'true');
      wrap.style.left = `${at.left - box.left}px`;
      wrap.style.top = `${at.top - box.top}px`;
      wrap.style.width = `${at.width}px`;
      wrap.style.setProperty('--card-w', `${at.width}px`);
      wrap.style.setProperty('--mill-ms', `${timing.flightMs}ms`);
      markTempo(wrap, tempo);
      wrap.style.setProperty('--from-x', `${from!.left + from!.width / 2 - (at.left + at.width / 2)}px`);
      wrap.style.setProperty('--from-y', `${from!.top + from!.height / 2 - (at.top + at.height / 2)}px`);
      wrap.style.setProperty('--from-scale', String(at.width > 0 ? Math.min(1, Math.max(0.2, from!.width / at.width)) : 1));
      // Each its own small turn on the way, seeded by the card, so a riffle does not fly as one block.
      wrap.style.setProperty('--mill-turn', `${((mill.cardId * 37) % 17) - 8}deg`);
      const piece = document.createElement('div');
      piece.className = 'board-departure__piece';
      // Copied from the pile card it hides: the copy is drawn.
      const copy = copyOfCard(el);
      copy.removeAttribute(LANDING_ATTR);
      piece.append(copy);
      wrap.append(piece);
      const launch = (): void => {
        root.append(wrap);
        flyers.add(wrap);
        schedule(() => {
          show(mill, tempo);
          wrap.remove();
          flyers.delete(wrap);
        }, timing.flightMs / tempo);
      };
      if (start === 0) launch();
      else schedule(launch, start / tempo);
    }
    // The cards that do not fly, and any whose pile card or library was not found, show as the run ends.
    const flown = new Set(plans.map((p) => p.mill.cardId));
    schedule(() => {
      for (const m of mills) if (!flown.has(m.cardId)) show(m, tempo);
    }, timing.totalMs / tempo);
  }

  return {
    fly(mills, delayMs, tempo = 1) {
      if (!live || mills.length === 0) return 0;
      for (const mill of mills) {
        const el = pileCard(canvas, mill);
        if (el === null) continue;
        el.setAttribute(LANDING_ATTR, '');
        hidden.add(mill.cardId);
      }
      const byLibrary = new Map<number, Mill[]>();
      for (const m of mills) byLibrary.set(m.fromPlayerId, [...(byLibrary.get(m.fromPlayerId) ?? []), m]);
      let longest = 0;
      for (const batch of byLibrary.values()) {
        longest = Math.max(longest, millTiming(batch.length).totalMs);
        const start = (): void => {
          // Every flown card's art decoded first; a run whose art never comes is shown without flying.
          let waiting = 1;
          let started = false;
          const asked = Date.now();
          const go = (): void => {
            if (--waiting > 0 || started || !live) return;
            started = true;
            run(batch, Date.now() - asked, tempo);
          };
          for (const m of batch) if (!artReady(cardImageUrl(m.scryfallId), go)) waiting += 1;
          schedule(() => {
            if (started) return;
            started = true;
            report?.({ what: 'mill', library: batch[0]!.fromPlayerId, cards: batch.length, flying: 0, unplaced: 0, artWaitMs: ART_WAIT_MS, totalMs: 0, reduced: false });
            for (const m of batch) show(m, tempo);
          }, ART_WAIT_MS);
          go();
        };
        // No beat to wait for: started in this commit, so no frame shows the card neither on its pile nor flying.
        if (delayMs <= 0) start();
        else schedule(start, delayMs / tempo);
      }
      return delayMs + longest;
    },
    dispose() {
      live = false;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const el of flyers) el.remove();
      flyers.clear();
      for (const id of hidden) canvas.querySelector(`[data-zone="graveyard"] [data-board-card="${id}"]`)?.removeAttribute(LANDING_ATTR);
      hidden.clear();
    },
  };
}
