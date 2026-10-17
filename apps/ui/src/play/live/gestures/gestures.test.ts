// @vitest-environment jsdom
/*
 * The pointer layer, against a real server replaying a real game.
 *
 * **Every assertion here is about WHAT WENT ON THE WIRE** — the frames that
 * left through `selectCard` / `selectPlayer` and reached the replay server —
 * and never about what was drawn. The arrow, the marquee and the intent mark do
 * have cases of their own, and they are about existence, snapping and the ONE
 * thing they must not claim (Forge's tapped state), because a picture is not a
 * proof that the right thing happened.
 *
 * ## What is re-homed, and from where
 *
 * The first block is wave 20's `describe('dragging a card, and the targeter
 * arrow')` from `../LiveBoard.test.ts`, moved with the gesture code it covers.
 * The behaviours it pins are the ones the module header of `../LiveBoard.tsx`
 * documented: the slop, the snap, stack items staying click-only, a drop on
 * nothing legal sending nothing, and no click suppression. The blocks after it
 * are wave 24 §B's four items.
 *
 * ## The harness
 *
 * `installGestures` is framework-free, so the board under it is drawn by lane
 * A's own `Board` — the markup whose contract this layer reads — mounted into a
 * plain `div` that stands in for lane C's canvas. Nothing here imports
 * `LiveBoard`: the seam is the element and the handle, and that is all this
 * proves it needs.
 *
 * jsdom has no layout, so every `getBoundingClientRect` is zeroes. The arrow's
 * geometry is therefore all 0 and nothing here asserts a coordinate; the
 * box-draw needs boxes, so the cases that sweep one STUB the boxes of the cards
 * they mean and leave every other card at the origin, where no marquee drawn
 * away from it can reach. `e2e/arrow.spec.ts` is where real boxes are measured.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, useSyncExternalStore } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { parseServerFrame, type ServerFrame } from '@hadoku/forge-wire';

import { Board } from '../../Board.tsx';
// The namespace, alongside the named `Board` import above, purely so R9's
// tests can `vi.spyOn` the two placement functions `cast.ts`/`install.ts`
// call across the lane boundary (`b.md`) without reaching into lane B's own
// `PENDING_PLACEMENTS` or its hit-testing — this file's job is "did G call
// the seam right", never "did B's geometry answer right".
import * as BoardModule from '../../Board.tsx';
import * as CastModule from './cast.ts';
import {
  answerAsk,
  attackAssignment,
  boardInteraction,
  clickCard,
  closeMatch,
  declaringBlockers,
  MARK_WAIT_MS,
  selectCard,
  selectPlayer,
  socketIoMatchTransport,
  startMatch,
  subscribe,
  type LiveMatch,
} from '../match.ts';
import { forgetPlacements, onSpellMoved } from '../placed.ts';
import { fixtureFrames, startReplayServer, untilMatch, type ReplayServer } from '../replay-server.ts';
import { needsTarget } from './cast.ts';
import { GLIDE_MS } from '../../motion.ts';
import { TAPPED_PENDING_ATTR } from './commit.ts';
import { installGestures } from './index.ts';
import { PARK_UNANSWERED_MS } from './install.ts';
import type { GestureHandle } from './types.ts';

let server: ReplayServer | null = null;
let match: LiveMatch | null = null;
let gestures: GestureHandle | null = null;

afterEach(async () => {
  vi.useRealTimers();
  gestures?.dispose();
  gestures = null;
  cleanup();
  if (match !== null) closeMatch(match);
  match = null;
  if (server !== null) await server.close();
  server = null;
  document.body.innerHTML = '';
  forgetPlacements();
  vi.restoreAllMocks();
});

/**
 * The board's own clock, held still from here to the end of the test. A second
 * click waits `MARK_WAIT_MS` for Forge's mark on what the first made current
 * (`afterMarked`); here Forge is the test, marking over a real socket once the
 * first click has arrived, and on a loaded host that round trip has outlasted
 * the window. Held, the window closes only when a test moves the clock past it.
 * Only `setTimeout` and `clearTimeout` are faked: the sockets took theirs when
 * they were made, and a held test's settle sleeps on `node:timers/promises`.
 */
function holdBoardClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

/**
 * Lane A's board, subscribed to the handle — everything `LiveBoard` puts around
 * it is lane C's and none of it is this layer's business.
 */
function Canvas({ match: m }: { match: LiveMatch }) {
  useSyncExternalStore(
    (listener) => subscribe(m, listener),
    () => m.revision,
  );
  if (m.view === null) return null;
  const offered = boardInteraction(m);
  return createElement(Board, {
    view: m.view,
    interaction: {
      ...offered,
      onSelectCard: (cardId: number) => clickCard(m, cardId),
      onSelectPlayer: (playerId: number) => selectPlayer(m, playerId),
    },
  });
}

let changes = 0;

async function gestureBoard(playerId = 0) {
  changes = 0;
  const s = (server = await startReplayServer({ playerId }));
  const m = (match = startMatch({
    matchId: s.matchId,
    transport: socketIoMatchTransport({ url: s.url, path: '/socket.io/', transports: ['websocket'] }),
  }));
  const canvas = document.createElement('div');
  canvas.className = 'live';
  document.body.append(canvas);
  render(createElement(Canvas, { match: m }), { container: canvas });
  await untilMatch(m, () => expect(m.stats.snapshots).toBe(1));
  const frames = fixtureFrames();
  for (const f of frames) s.send(f);
  // Delivery first, on the counter that says so, then what the delivery draws.
  await untilMatch(m, () => expect(m.stats.applied).toBe(frames.length));
  await waitFor(() => expect(canvas.querySelector('[data-board-overlay]')).not.toBeNull());
  gestures = installGestures({
    canvas,
    match: m,
    onChange: () => {
      changes += 1;
    },
  });
  return { s, m, canvas };
}

const notify = (raw: unknown[]): ServerFrame[] => raw.map((r) => parseServerFrame(r));

const prompt = (message: string) =>
  parseServerFrame({ kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message, card: null });
/** A prompt that names the ability it is about — what `InputPayMana` announces itself with. */
const promptFor = (message: string, cardId: number) =>
  parseServerFrame({
    kind: 'notify',
    method: 'showPromptMessage',
    player: { kind: 'player', id: 0 },
    message,
    card: { kind: 'card', id: cardId },
  });
/** `InputPayMana`'s bar: `lblAuto` in button 1. `enable1` is the auto-pay offer, not the input. */
const autoBar = (enable1: boolean) =>
  parseServerFrame({
    kind: 'notify',
    method: 'updateButtons',
    owner: { kind: 'player', id: 0 },
    label1: 'Auto',
    label2: 'Cancel',
    enable1,
    enable2: true,
    focus1: enable1,
  });
/** Any other input's bar — a priority window's. */
const okBar = () =>
  parseServerFrame({
    kind: 'notify',
    method: 'updateButtons',
    owner: { kind: 'player', id: 0 },
    label1: 'OK',
    label2: 'Cancel',
    enable1: true,
    enable2: true,
    focus1: true,
  });
/**
 * `InputAttack`'s own bar — button 2 reads `Alpha Strike` before anything is
 * declared, `Call Back` once something is (`match.ts`'s `CALL_BACK_LABEL`).
 * The one bar shape that makes a defender (card or player) a drop target.
 */
const attackBar = (declared = false) =>
  parseServerFrame({
    kind: 'notify',
    method: 'updateButtons',
    owner: { kind: 'player', id: 0 },
    label1: 'OK',
    label2: declared ? 'Call Back' : 'Alpha Strike',
    enable1: true,
    enable2: true,
    focus1: true,
  });
const actionable = (ids: number[]) =>
  parseServerFrame({ kind: 'notify', method: 'setWeaklySelectable', cards: ids.map((id) => ({ kind: 'card', id })) });
const selectables = (ids: number[], min: number, max: number) =>
  parseServerFrame({ kind: 'notify', method: 'setSelectables', cards: ids.map((id) => ({ kind: 'card', id })), min, max });
const highlight = (ids: number[], on: boolean) =>
  parseServerFrame({
    kind: 'notify',
    method: 'setHighlighted',
    entities: ids.map((id) => ({ kind: 'card', id })),
    on,
  });
const highlightPlayers = (ids: number[], on: boolean) =>
  parseServerFrame({
    kind: 'notify',
    method: 'setHighlighted',
    entities: ids.map((id) => ({ kind: 'player', id })),
    on,
  });

/** The Game object's wire key: `(_type << 28) | _id`, and `WireType.Game` is 3. */
const GAME_KEY = String((3 << 28) | 1);

let seq = 27;

/** One synthetic state delta. The state channel carries the phase; no prose is read. */
function stateDelta(objectDeltas: Record<string, unknown>): ServerFrame {
  seq += 1;
  return parseServerFrame({
    kind: 'notify',
    method: 'applyDelta',
    payload: {
      packet: { seq, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas, events: [] },
    },
  });
}

const phaseDelta = (phase: string, playerTurn: number): ServerFrame =>
  stateDelta({
    [GAME_KEY]: {
      _type: 3,
      _id: 1,
      Phase: { t: 'enum', c: 'forge.game.phase.PhaseType', v: phase },
      PlayerTurn: { t: 'int', v: playerTurn },
    },
  });

const attackingDelta = (ids: number[]): ServerFrame =>
  stateDelta(Object.fromEntries(ids.map((id) => [String(id), { _type: 0, _id: id, Attacking: { t: 'bool', v: true } }])));

/** The viewer's hand as Forge now holds it — a card being cast leaves it the moment the cast goes out. */
const handDelta = (ids: number[]): ServerFrame =>
  stateDelta({
    [String((1 << 28) | 0)]: { _type: 1, _id: 0, Hand: { t: 'list', v: ids.map((id) => ({ t: 'int', v: id })) } },
  });

/** What actually left this client, as `[method, id]` pairs. The whole point of these tests. */
const sent = (s: ReplayServer): unknown[] =>
  s.clientFrames().map((f) => {
    if (!f.ok || f.value.kind !== 'act') return f;
    const act = f.value;
    if (act.method === 'selectCard') return ['selectCard', act.card.id];
    if (act.method === 'selectPlayer') return ['selectPlayer', act.player.id];
    return [act.method];
  });

const cardEl = (c: HTMLElement, id: number) => c.querySelector<HTMLElement>(`[data-board-card="${id}"]`)!;
const faceEl = (c: HTMLElement, id: number) => c.querySelector<HTMLElement>(`[data-player-face][data-player-id="${id}"]`)!;
const overlayOf = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-board-overlay]')!;

/** Press on `from`, move over `over`, release there. Past the slop, so it is a drag. */
function drag(from: HTMLElement, over: HTMLElement): void {
  fireEvent.pointerDown(from, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(over, { clientX: 200, clientY: 140 });
  fireEvent.pointerUp(over, { clientX: 200, clientY: 140 });
}

/** jsdom has no layout: give this element the box the case needs. */
function boxAt(el: Element, left: number, top: number, w = 40, h = 56): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
const mineOf = (m: LiveMatch) => m.view!.players.find((p) => p.isViewer)!;
const theirsOf = (m: LiveMatch) => m.view!.players.find((p) => !p.isViewer)!;

describe('needsTarget — which cards need a target', () => {
  it('Instant, Sorcery, and an Aura subtype do', () => {
    expect(needsTarget('Instant')).toBe(true);
    expect(needsTarget('Sorcery')).toBe(true);
    expect(needsTarget('Enchantment — Aura')).toBe(true);
    expect(needsTarget('Tribal Sorcery — Goblin')).toBe(true);
  });
  it('everything else does not, including a null type line', () => {
    expect(needsTarget('Creature — Bear')).toBe(false);
    expect(needsTarget('Basic Land — Mountain')).toBe(false);
    expect(needsTarget('Artifact')).toBe(false);
    expect(needsTarget('Enchantment')).toBe(false);
    expect(needsTarget('Planeswalker — Jace')).toBe(false);
    expect(needsTarget(null)).toBe(false);
  });
});

/* ── wave 20, re-homed from ../LiveBoard.test.ts ──────────────────────── */

describe('dragging a card, and the targeter arrow', () => {
  it('a drag from a card Forge offered onto the opponent’s seat sends selectCard then selectPlayer', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const [source, other] = [mine[0]!, mine[1]!];
    // A selection Forge wants TWO of, so the source is sent as well as the drop.
    for (const f of notify([prompt('Choose two'), selectables([source, other], 1, 2)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());

    drag(cardEl(canvas, source), faceEl(canvas, 1));
    await s.untilClientFrames(2);
    expect(sent(s)).toEqual([
      ['selectCard', source],
      ['selectPlayer', 1],
    ]);
  });

  it('a drag from one offered card onto another sends both, in order', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const [source, target] = [mine[0]!, mine[1]!];
    for (const f of notify([prompt('Choose two'), selectables([source, target], 1, 2)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());

    drag(cardEl(canvas, source), cardEl(canvas, target));
    await s.untilClientFrames(2);
    expect(sent(s)).toEqual([
      ['selectCard', source],
      ['selectCard', target],
    ]);
  });

  it('Forge wants ONE thing: the drop is what the player pointed at, and it is the only frame sent', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const [source, target] = [mine[0]!, mine[1]!];
    for (const f of notify([prompt('Choose a target'), selectables([source, target], 1, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables!.max).toBe(1));

    drag(cardEl(canvas, source), cardEl(canvas, target));
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', target]]);
  });

  it('a drag of a card Forge did not offer does nothing and says nothing', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Choose a target'), selectables([mine[0]!], 1, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());

    // The opponent's card is not offered — dragged to the stack (the one zone
    // no seat owns) or off the board entirely, it sends nothing.
    const stack = canvas.querySelector<HTMLElement>('[data-zone="stack"]')!;
    drag(cardEl(canvas, theirs[0]!), stack);
    drag(cardEl(canvas, theirs[0]!), document.body);
    expect(m.lastError).toBeNull();
    expect(s.clientFrames()).toHaveLength(0);

    // Proven against a barrier: the next legitimate act must be the FIRST
    // frame the server sees, so a refused drag cannot be hiding behind a wire.
    fireEvent.click(cardEl(canvas, mine[0]!).querySelector('button')!);
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', mine[0]!]]);
  });

  it('inside a selection, an offered card dropped where nothing is offered is used — a spell drags out of its own target ask', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Choose a target'), selectables([mine[0]!, mine[1]!], 1, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());

    drag(cardEl(canvas, mine[0]!), cardEl(canvas, theirs[0]!));
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', mine[0]!]]);

    // And a drop outside every zone still does nothing and says nothing.
    drag(cardEl(canvas, mine[1]!), document.body);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames()).toHaveLength(1);
  });

  /*
   * Wave 20's zone drop, and it is asserted from the HAND.
   *
   * *"Dragging a land onto the table is #6's whole point"* — and #6 is a card in
   * hand. No hand card is ever `Board.tsx`'s own arrangement, because dragging
   * one out of hand is how it is played — so every hand card is this layer's,
   * which the `data-arrange-card` assertion below pins from this side. The battlefield
   * side of the partition has its own case further down.
   */
  it('outside a selection, a hand card dropped on the table is the one frame a click sends — and it is not sent twice', async () => {
    const { s, m, canvas } = await gestureBoard();
    const hand = mineOf(m).hand!.map((c) => c.id);
    expect(hand.length).toBeGreaterThan(0);
    for (const f of notify([prompt('Priority'), actionable([hand[0]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    expect(cardEl(canvas, hand[0]!).hasAttribute('data-arrange-card')).toBe(false);

    // R7: a hand card only casts by crossing into the VIEWER'S OWN
    // battlefield (`./cast.ts`'s `overOwnBattlefield`) — dropping it on the
    // opponent's would not be "playing it" either, so `[data-owner="you"]`
    // is load-bearing here, not incidental.
    const zone = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;
    drag(cardEl(canvas, hand[0]!), zone);
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', hand[0]!]]);
  });

  it('a press that does not move is still a click, and sends exactly once', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([mine[0]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());

    const face = cardEl(canvas, mine[0]!).querySelector<HTMLButtonElement>('button')!;
    fireEvent.pointerDown(face, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(face, { clientX: 12, clientY: 11 });
    fireEvent.pointerUp(face, { clientX: 12, clientY: 11 });
    fireEvent.click(face);
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', mine[0]!]]);
  });

  /**
   * §E.2. The operator, 2026-09-27: dragging on the table highlighted the words
   * the pointer crossed. A press this layer CLAIMS refuses the browser's default
   * from the press itself, because `./gestures.css`'s `user-select: none` is
   * written only once the press has passed the slop and the selection has begun
   * by then.
   *
   * It is deliberately NOT done on a press the arrangement owns: cancelling
   * `pointerdown` is also how the native HTML5 drag is cancelled, and that press
   * IS a native drag. The card carries a static `user-select: none` instead
   * (`../../board.css`), which is what covers it.
   */
  it('refuses the browser’s default on a press it claims, and never on the arrangement’s', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const hand = mineOf(m).hand!.map((c) => c.id);
    /*
     * A hand card, Forge-offered or not, is this layer's OWN press now — the
     * hand reorder — never the arrangement's: `CardOnBoard` never makes ANY
     * hand card arrangeable, so there is only this layer's own claim. Right-click lets the lift go
     * with nothing sent, so the dangling press does not reach the next
     * assertion.
     */
    for (const f of notify([prompt('Priority'), actionable([mine[0]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const arrangeable = cardEl(canvas, hand.at(-1)!);
    expect(arrangeable.hasAttribute('data-arrange-card'), 'never the arrangement’s to begin with').toBe(false);
    expect(
      fireEvent.pointerDown(arrangeable, { button: 0, clientX: 10, clientY: 10 }),
      'the hand reorder claims the press',
    ).toBe(false);
    fireEvent.pointerUp(arrangeable, { clientX: 10, clientY: 10 });
    fireEvent.pointerDown(arrangeable, { button: 2, clientX: 10, clientY: 10 });
    expect(s.clientFrames(), 'the cancelled lift sent nothing').toHaveLength(0);

    // And Forge ASKING about a permanent: this layer claims that press, so the
    // browser's default — a text selection — is refused at the press itself.
    for (const f of notify([prompt('Choose a target'), selectables([mine[0]!], 1, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    expect(
      fireEvent.pointerDown(cardEl(canvas, mine[0]!), { button: 0, clientX: 10, clientY: 10 }),
      'a claimed press selects no text',
    ).toBe(false);
    fireEvent.pointerUp(cardEl(canvas, mine[0]!), { clientX: 10, clientY: 10 });
    // A press that never moved is a click, not a drag, so neither sent anything.
    expect(s.clientFrames(), 'and neither press sent anything').toHaveLength(0);
  });

  it('the arrow is drawn into lane A’s overlay and snaps to the legal target under the pointer', async () => {
    const { s, m, canvas } = await gestureBoard();
    const overlay = overlayOf(canvas);
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Choose a target'), selectables([mine[0]!, mine[1]!], 1, 2)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());

    expect(overlay.querySelector('[data-testid="targeter"]')).toBeNull();
    fireEvent.pointerDown(cardEl(canvas, mine[0]!), { button: 0, clientX: 10, clientY: 10 });
    // Over nothing in particular: the arrow follows the pointer, unsnapped.
    fireEvent.pointerMove(cardEl(canvas, theirs[0]!), { clientX: 120, clientY: 90 });
    const arrow = await waitFor(() => overlay.querySelector<SVGElement>('[data-testid="targeter"]')!);
    expect(arrow.dataset.source).toBe(String(mine[0]));
    expect(arrow.dataset.mode).toBe('drag');
    expect(arrow.dataset.target).toBeUndefined();
    expect(arrow.dataset.snapped).toBeUndefined();
    expect(arrow.querySelector('path')).not.toBeNull();
    expect(arrow.querySelector('polygon')).not.toBeNull();

    // Over a card Forge DID offer: it snaps.
    fireEvent.pointerMove(cardEl(canvas, mine[1]!), { clientX: 200, clientY: 140 });
    await waitFor(() =>
      expect(overlay.querySelector<SVGElement>('[data-testid="targeter"]')!.dataset.target).toBe(`card:${mine[1]}`),
    );
    expect(overlay.querySelector<SVGElement>('[data-testid="targeter"]')!.dataset.snapped).toBe('true');

    fireEvent.pointerUp(cardEl(canvas, mine[1]!), { clientX: 200, clientY: 140 });
    await waitFor(() => expect(overlay.querySelector('[data-testid="targeter"]')).toBeNull());
    expect(sent(s)).toEqual([
      ['selectCard', mine[0]!],
      ['selectCard', mine[1]!],
    ]);
    // The seam told lane C its picture changed, rather than leaving it to poll.
    expect(changes).toBeGreaterThan(0);
  });

  it('Q11 — the head lands on the nearest of the card’s eight edge points to the tail, never its centre', async () => {
    const { s, m, canvas } = await gestureBoard();
    const overlay = overlayOf(canvas);
    const mine = mineOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Choose a target'), selectables([mine[0]!, mine[1]!], 1, 2)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    boxAt(overlay, 0, 0, 800, 600);
    boxAt(cardEl(canvas, mine[0]!), 0, 0); // tail: centre (20, 28)

    const tipAfterMovingOver = async (left: number, top: number): Promise<{ x: number; y: number }> => {
      boxAt(cardEl(canvas, mine[1]!), left, top);
      fireEvent.pointerDown(cardEl(canvas, mine[0]!), { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(cardEl(canvas, mine[1]!), { clientX: left + 20, clientY: top + 28 });
      const shaft = await waitFor(() => {
        const found = overlay.querySelector('[data-testid="targeter"] path');
        expect(found?.getAttribute('d')).not.toBeNull();
        return found!;
      });
      // `M x1 y1 Q cx cy x2 y2`: the tip is the last pair.
      const [x2, y2] = shaft.getAttribute('d')!.trim().split(/\s+/).slice(-2).map(Number) as [number, number];
      const tip = { x: x2, y: y2 };
      fireEvent.pointerCancel(window);
      return tip;
    };

    // Target to the upper-left of nothing: far to the right and below — the
    // nearest point to a tail at (20, 28) is the top-left CORNER.
    expect(await tipAfterMovingOver(300, 100)).toEqual({ x: 300, y: 100 });
    // Directly below the tail: the nearest point is the top MIDPOINT.
    expect(await tipAfterMovingOver(0, 300)).toEqual({ x: 20, y: 300 });
    // Never the centre, in either case.
    expect(s.clientFrames()).toHaveLength(0);
  });

  it('with no overlay root the arrow is not drawn, and the drag still sends', async () => {
    const { s, m, canvas } = await gestureBoard();
    // Lane A owns the overlay; a board drawn without one must still be
    // playable, so take it away and drive the same gesture.
    canvas.querySelector('[data-board-overlay]')?.remove();
    expect(canvas.querySelector('[data-board-overlay]')).toBeNull();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Choose two'), selectables([mine[0]!, mine[1]!], 1, 2)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());

    fireEvent.pointerDown(cardEl(canvas, mine[0]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(cardEl(canvas, mine[1]!), { clientX: 200, clientY: 140 });
    expect(document.querySelector('[data-testid="targeter"]')).toBeNull();
    fireEvent.pointerUp(cardEl(canvas, mine[1]!), { clientX: 200, clientY: 140 });
    await s.untilClientFrames(2);
    expect(sent(s)).toEqual([
      ['selectCard', mine[0]!],
      ['selectCard', mine[1]!],
    ]);
  });

  it('a pointing gesture inside a selection needs no source: the drop alone is sent', async () => {
    const { s, m, canvas } = await gestureBoard();
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    // Forge offers only the opponent's creature — nothing of the viewer's to
    // drag from, which is the ordinary shape of a targeting input.
    for (const f of notify([prompt('Choose a target'), selectables([theirs[0]!], 1, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());

    const stack = canvas.querySelector<HTMLElement>('[data-zone="stack"]') ?? canvas.querySelector<HTMLElement>('.board')!;
    fireEvent.pointerDown(stack, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(faceEl(canvas, 1), { clientX: 200, clientY: 140 });
    fireEvent.pointerUp(faceEl(canvas, 1), { clientX: 200, clientY: 140 });
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectPlayer', 1]]);
  });

  // The operator, 2026-10-04: "the arrow for 'graps of darkness' should not snap to player
  // avatars. player is not a valid target for that spell." The bridge now names the players a
  // selection accepts; a face it did not name takes no arrow and no release.
  describe('a selection that names its players', () => {
    const withPlayers = (cards: number[], players: number[]) =>
      parseServerFrame({
        kind: 'notify',
        method: 'setSelectables',
        cards: cards.map((id) => ({ kind: 'card', id })),
        min: 1,
        max: 1,
        players: players.map((id) => ({ kind: 'player', id })),
      });

    async function pointAtFace(players: number[]) {
      const { s, m, canvas } = await gestureBoard();
      const theirs = theirsOf(m).battlefield.map((c) => c.id);
      for (const f of notify([prompt('Choose a target')])) s.send(f);
      s.send(withPlayers([theirs[0]!], players));
      await untilMatch(m, () => expect(m.selectables).not.toBeNull());
      const stack = canvas.querySelector<HTMLElement>('[data-zone="stack"]') ?? canvas.querySelector<HTMLElement>('.board')!;
      fireEvent.pointerDown(stack, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(faceEl(canvas, 1), { clientX: 200, clientY: 140 });
      fireEvent.pointerUp(faceEl(canvas, 1), { clientX: 200, clientY: 140 });
      await new Promise((r) => setTimeout(r, 50));
      return s;
    }

    it('no player named (Doom Blade, Grasp of Darkness): a release on a face sends nothing', async () => {
      const s = await pointAtFace([]);
      expect(sent(s)).toEqual([]);
    });

    it('the player named: a release on that face answers it', async () => {
      const s = await pointAtFace([1]);
      expect(sent(s)).toEqual([['selectPlayer', 1]]);
    });
  });

  // The operator, 2026-10-04: "right-click shouldn't bring up the chrome context menu on the board."
  it('a right-click on the board never opens the browser menu, with or without a gesture', async () => {
    const { s, canvas } = await gestureBoard();
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    canvas.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(s.clientFrames()).toHaveLength(0);
  });

  it('a pointercancel drops the gesture: the arrow goes and nothing is sent', async () => {
    const { s, m, canvas } = await gestureBoard();
    const overlay = overlayOf(canvas);
    const mine = mineOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Choose two'), selectables([mine[0]!, mine[1]!], 1, 2)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());

    fireEvent.pointerDown(cardEl(canvas, mine[0]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(cardEl(canvas, mine[1]!), { clientX: 200, clientY: 140 });
    await waitFor(() => expect(overlay.querySelector('[data-testid="targeter"]')).not.toBeNull());
    // `e2e/arrow.spec.ts` cancels exactly this way, on `window`.
    fireEvent.pointerCancel(window, {});
    await waitFor(() => expect(overlay.querySelector('[data-testid="targeter"]')).toBeNull());
    expect(s.clientFrames()).toHaveLength(0);
  });

  it('dispose takes the layer away: no arrow, no marks, and a drag sends nothing', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Choose two'), selectables([mine[0]!, mine[1]!], 1, 2)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    gestures!.dispose();
    gestures = null;

    drag(cardEl(canvas, mine[0]!), cardEl(canvas, mine[1]!));
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames()).toHaveLength(0);
    expect(canvas.querySelector('[data-testid="targeter"]')).toBeNull();
    expect(canvas.querySelector('[data-attack-intent]')).toBeNull();
  });
});

/* ── the partition with lane A's arrange gesture ─────────────────────── */

/**
 * Lane A's §A.1 arrange gesture and this layer both start on a press. The
 * partition, checked here from both sides:
 *
 *  - a card `boardInteraction` OFFERED is this layer's, arrangeable or not;
 *  - anything carrying `data-arrange-card` is lane A's, and this layer starts
 *    no gesture on it and sends nothing on release;
 *  - empty table space is unchanged — both the box-draw and the source-less
 *    pointing gesture still start there.
 *
 * `data-arrange-card` is set by hand in these cases rather than waited for, so
 * the partition is pinned whatever `CardOnBoard`'s own rule draws. A press this
 * layer claims is cancelled, and `useArrangeDrag` skips a cancelled press.
 */
describe('the press is partitioned with lane A’s arrange gesture', () => {
  it('declaring blockers, the offered creature is THIS layer’s though it stays arrangeable — the press is claimed', async () => {
    const { s, m, canvas } = await gestureBoard();
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    const blocker = mineOf(m).battlefield[0]!.id;
    s.send(phaseDelta('COMBAT_DECLARE_BLOCKERS', theirsOf(m).id));
    s.send(attackingDelta([theirs[0]!]));
    await untilMatch(m, () => expect(m.view!.phase).toBe('COMBAT_DECLARE_BLOCKERS'));
    for (const f of notify([prompt('Select a blocker'), actionable([blocker]), highlight([theirs[0]!], true)])) s.send(f);
    await untilMatch(m, () => expect(m.highlighted!.size).toBe(1));
    // Forge publishes NO selection in combat declaration, so lane A's rule
    // (`!selectionOpen`) leaves the blocker arrangeable. This layer must still win.
    cardEl(canvas, blocker).setAttribute('data-arrange-card', 'creatures');
    expect(boardInteraction(m).selectionOpen).toBe(false);

    expect(fireEvent.pointerDown(cardEl(canvas, blocker), { button: 0, clientX: 10, clientY: 10 }), 'claimed').toBe(false);
    fireEvent.pointerMove(cardEl(canvas, theirs[0]!), { clientX: 200, clientY: 140 });
    fireEvent.pointerUp(cardEl(canvas, theirs[0]!), { clientX: 200, clientY: 140 });
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', blocker]]);
  });

  it('outside combat declaration, arranging wins even on a card Forge offered — and a CLICK still plays it', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([mine[0]!, mine[1]!])])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.size).toBe(2));
    // At priority Forge's ACTIONABLE set names most of the viewer's own
    // permanents — "you could", not "I am asking" — and lane A keeps those
    // arrangeable. Claiming the press is what turned `e2e/table-fit.spec.ts` red.
    expect(cardEl(canvas, mine[0]!).hasAttribute('data-arrange-card')).toBe(true);

    // Nothing claimed: the press is not cancelled, so the arrangement keeps it.
    expect(fireEvent.pointerDown(cardEl(canvas, mine[0]!), { button: 0, clientX: 10, clientY: 10 })).toBe(true);
    fireEvent.pointerMove(cardEl(canvas, mine[1]!), { clientX: 200, clientY: 140 });
    expect(overlayOf(canvas).querySelector('[data-testid="targeter"]')).toBeNull();
    fireEvent.pointerUp(cardEl(canvas, mine[1]!), { clientX: 200, clientY: 140 });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames()).toHaveLength(0);

    // The affordance is not lost, only the drag: the card's own face still plays it.
    fireEvent.click(cardEl(canvas, mine[0]!).querySelector('button')!);
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', mine[0]!]]);
  });

  it('a NON-offered arrangeable card starts no gesture and sends nothing on release', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    // A selection is open and names only the OPPONENT's creature, so the
    // viewer's own battlefield is all un-offered — and all arrangeable.
    for (const f of notify([prompt('Choose a target'), selectables([theirs[0]!], 1, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    for (const id of mine) cardEl(canvas, id).setAttribute('data-arrange-card', 'creatures');
    expect(boardInteraction(m).selectable.has(mine[0]!)).toBe(false);

    // THE SAFETY CONTROL. Without the guard this press starts the source-less
    // pointing gesture, the release lands on Forge's one legal target, and one
    // press both rearranges the battlefield and sends `selectCard`.
    drag(cardEl(canvas, mine[0]!), cardEl(canvas, theirs[0]!));
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames()).toHaveLength(0);
    expect(overlayOf(canvas).querySelector('[data-testid="targeter"]')).toBeNull();
    expect(canvas.hasAttribute('data-dragging')).toBe(false);

    // Proven against a barrier: the next legitimate act is the FIRST frame the
    // server sees, so a refused gesture cannot be hiding behind a slow wire.
    fireEvent.click(cardEl(canvas, theirs[0]!).querySelector('button')!);
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', theirs[0]!]]);
  });

  /**
   * Wave 27 §A.6: **rearranging is not an act**, so a press that starts one must
   * be claimable with NO OFFER OPEN — which is most of a game.
   *
   * `install.ts` gets there twice over and both halves matter. `arrangeable`
   * returns before every branch, so the arrangement owns the press whatever else
   * is true; and with `match.selectables === null` the source-less pointing
   * gesture does not start at all, which is the line the brief names. Neither is
   * reached by WIDENING what counts as an offer — that is how a click on a card
   * Forge never named becomes an act — so this asserts the offer is still empty
   * while the press goes through.
   *
   * **The two guards are redundant of each other here, and deliberately so.**
   * Mutation-tested: removing either one alone leaves this green, because the
   * other still returns; removing both fails it. They stop being redundant the
   * moment an offer IS open, which is the case above.
   */
  it('with NOTHING offered, a press on the viewer’s own card is the arrangement’s and sends nothing', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    // No selection, and not even an actionable set: Forge has named nothing.
    expect(m.selectables, 'no offer is open').toBeNull();
    const offered = boardInteraction(m);
    expect(offered.selectable.size + offered.selectablePlayers.size, 'and nothing on the board is Forge’s').toBe(0);
    expect(offered.selectionOpen, 'no selection is open either').toBe(false);
    // Which is exactly when lane A makes the viewer's own battlefield arrangeable.
    expect(cardEl(canvas, mine[0]!).hasAttribute('data-arrange-card'), 'the arrangement owns this press').toBe(true);

    /*
     * Asserted WHILE THE PRESS IS HELD, which is the only moment that can tell
     * the two apart: with nothing selectable `commitDrag` can never send, so a
     * gesture that wrongly started would leave nothing behind on release and a
     * check after the fact would pass either way (it did — this case was written
     * that way first and neither mutation of `install.ts` failed it).
     */
    const from = cardEl(canvas, mine[0]!);
    fireEvent.pointerDown(from, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(cardEl(canvas, theirs[0]!), { clientX: 200, clientY: 140 });
    expect(canvas.hasAttribute('data-dragging'), 'this layer did not take the press').toBe(false);
    expect(overlayOf(canvas).querySelector('[data-testid="targeter"]'), 'and drew no arrow').toBeNull();
    fireEvent.pointerUp(cardEl(canvas, theirs[0]!), { clientX: 200, clientY: 140 });

    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames(), 'an arrangement puts nothing on the wire').toHaveLength(0);
    // The offer is still empty afterwards — the press was not bought by widening it.
    expect(m.selectables).toBeNull();
    expect(boardInteraction(m).selectable.size).toBe(0);
  });

  it('declaring attackers, a box-draw MAY start on an arrangeable permanent — the press is claimed', async () => {
    const { s, m, canvas } = await declaringAttackersBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const [offered, from] = [mine[0]!, mine[1]!];
    for (const f of notify([prompt('Declare attackers'), actionable([offered])])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.size).toBe(1));
    cardEl(canvas, from).setAttribute('data-arrange-card', 'creatures');
    boxAt(overlayOf(canvas), 0, 0, 800, 600);
    boxAt(cardEl(canvas, offered), 120, 120);
    boxAt(cardEl(canvas, from), 100, 100);

    expect(fireEvent.pointerDown(cardEl(canvas, from), { button: 0, clientX: 100, clientY: 100 }), 'claimed').toBe(false);
    fireEvent.pointerMove(cardEl(canvas, offered), { clientX: 400, clientY: 400 });
    expect(overlayOf(canvas).querySelector('[data-testid="marquee"]')).not.toBeNull();
    fireEvent.pointerUp(cardEl(canvas, offered), { clientX: 400, clientY: 400 });
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', offered]]);
  });

  /*
   * The mana payment, and it is the other half of the same axis as combat.
   *
   * `e2e/play.spec.ts:970-972` pays for a spell it just cast by dragging a land
   * ALREADY on the battlefield; `e2e/table-fit.spec.ts` drags an equally-offered
   * land between rows to ARRANGE it. Only "which input is Forge parked on" tells
   * them apart, and `payingMana` reads that off the prompt's own card plus the
   * payment input's button label — never off the prompt's prose.
   */
  it('during a payment, an offered battlefield land is THIS layer’s though it stays arrangeable — the press is claimed', async () => {
    const { s, m, canvas } = await gestureBoard();
    const land = mineOf(m).battlefield[0]!.id;
    // Forge's payment input: the bar first (it is emitted before the prompt), then
    // the prompt naming the ability paid for, then what can pay.
    for (const f of [autoBar(true), promptFor('Pay {1}{U}', land), actionable([land])]) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.has(land)).toBe(true));
    expect(cardEl(canvas, land).hasAttribute('data-arrange-card')).toBe(true);

    expect(fireEvent.pointerDown(cardEl(canvas, land), { button: 0, clientX: 10, clientY: 10 }), 'claimed').toBe(false);
    const zone = canvas.querySelector<HTMLElement>('[data-zone="battlefield"]')!;
    fireEvent.pointerMove(zone, { clientX: 200, clientY: 140 });
    fireEvent.pointerUp(zone, { clientX: 200, clientY: 140 });
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', land]]);
  });

  it('a payment whose cost cannot be auto-paid is still a payment — the Auto bar is disabled and the drag still pays', async () => {
    const { s, m, canvas } = await gestureBoard();
    const land = mineOf(m).battlefield[0]!.id;
    // `InputPayMana.java:391` — the input's FIRST bar, Auto present and disabled.
    // Tapping sources by hand is exactly what this window is for.
    for (const f of [autoBar(false), promptFor('Pay {7}', land), actionable([land])]) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.has(land)).toBe(true));

    drag(cardEl(canvas, land), canvas.querySelector<HTMLElement>('[data-zone="battlefield"]')!);
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', land]]);
  });

  /**
   * THE STALE-BAR CASE (lane E's hazard). Forge emits `updateButtons` BEFORE
   * `showPromptMessage`, so an `Auto` bar can outlive the payment that set it. A
   * press under a stale bar must arrange, not pay — `table-fit` drags an offered
   * land with hands paused mid-game, which is exactly when the last bar is stale.
   */
  it('a STALE Auto bar does not make this layer claim the press: the prompt, not the bar, says which input is live', async () => {
    const { s, m, canvas } = await gestureBoard();
    const land = mineOf(m).battlefield[0]!.id;
    for (const f of [autoBar(true), promptFor('Pay {1}{U}', land), actionable([land])]) s.send(f);
    await untilMatch(m, () => expect(m.promptCard).toBe(land));

    // The payment ends and priority comes back. Forge's next PROMPT names no
    // card; the Auto bar has not been replaced yet.
    s.send(prompt('Priority'));
    await untilMatch(m, () => expect(m.promptCard).toBeNull());
    expect(m.buttons!.label1).toBe('Auto'); // still stale, and still enabled
    expect(m.buttons!.enable1).toBe(true);
    expect(boardInteraction(m).selectable.has(land)).toBe(true);

    // Nothing claimed, so lane A's arrange gesture keeps the press.
    expect(fireEvent.pointerDown(cardEl(canvas, land), { button: 0, clientX: 10, clientY: 10 })).toBe(true);
    const zone = canvas.querySelector<HTMLElement>('[data-zone="battlefield"]')!;
    fireEvent.pointerMove(zone, { clientX: 200, clientY: 140 });
    fireEvent.pointerUp(zone, { clientX: 200, clientY: 140 });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames()).toHaveLength(0);

    // A barrier: the click still works, so the refusal was the gesture's and not the wire's.
    fireEvent.click(cardEl(canvas, land).querySelector('button')!);
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', land]]);
  });

  it('an ordinary priority window with its own bar is arranging’s, land and all', async () => {
    const { s, m, canvas } = await gestureBoard();
    const land = mineOf(m).battlefield[0]!.id;
    for (const f of [okBar(), prompt('Priority'), actionable([land])]) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.has(land)).toBe(true));

    expect(fireEvent.pointerDown(cardEl(canvas, land), { button: 0, clientX: 10, clientY: 10 })).toBe(true);
    const zone = canvas.querySelector<HTMLElement>('[data-zone="battlefield"]')!;
    fireEvent.pointerMove(zone, { clientX: 200, clientY: 140 });
    fireEvent.pointerUp(zone, { clientX: 200, clientY: 140 });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames()).toHaveLength(0);
  });

  it('outside declare-attackers an arrangeable permanent starts no box-draw at all', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([mine[0]!])])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.size).toBe(1));
    cardEl(canvas, mine[1]!).setAttribute('data-arrange-card', 'creatures');
    boxAt(overlayOf(canvas), 0, 0, 800, 600);
    boxAt(cardEl(canvas, mine[0]!), 120, 120);
    boxAt(cardEl(canvas, mine[1]!), 100, 100);

    fireEvent.pointerDown(cardEl(canvas, mine[1]!), { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(cardEl(canvas, mine[0]!), { clientX: 400, clientY: 400 });
    expect(overlayOf(canvas).querySelector('[data-testid="marquee"]')).toBeNull();
    fireEvent.pointerUp(cardEl(canvas, mine[0]!), { clientX: 400, clientY: 400 });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames()).toHaveLength(0);
  });

  it('empty table space is unchanged: the box-draw still starts there', async () => {
    const { s, m, canvas } = await declaringAttackersBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Declare attackers'), actionable([mine[0]!])])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.size).toBe(1));
    // Every card arrangeable — the ZONE is not.
    for (const id of mine) cardEl(canvas, id).setAttribute('data-arrange-card', 'creatures');
    boxAt(overlayOf(canvas), 0, 0, 800, 600);
    boxAt(cardEl(canvas, mine[0]!), 120, 120);

    const zone = canvas.querySelector<HTMLElement>('[data-zone="battlefield"]')!;
    fireEvent.pointerDown(zone, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(zone, { clientX: 300, clientY: 300 });
    expect(overlayOf(canvas).querySelector('[data-testid="marquee"]')).not.toBeNull();
    fireEvent.pointerUp(zone, { clientX: 300, clientY: 300 });
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', mine[0]!]]);
  });

  it('empty table space is unchanged: the source-less pointing gesture still starts there', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Choose a target'), selectables([theirs[0]!], 1, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    for (const id of mine) cardEl(canvas, id).setAttribute('data-arrange-card', 'creatures');

    const stack = canvas.querySelector<HTMLElement>('[data-zone="stack"]') ?? canvas.querySelector<HTMLElement>('.board')!;
    fireEvent.pointerDown(stack, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(faceEl(canvas, 1), { clientX: 200, clientY: 140 });
    fireEvent.pointerUp(faceEl(canvas, 1), { clientX: 200, clientY: 140 });
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectPlayer', 1]]);
  });
});

/* ── §B.1 — selecting an attacker marks it immediately ───────────────── */

/**
 * The phase comes off the STATE CHANNEL (`GameView.Phase` / `PlayerTurn`), which
 * is why these cases send a synthetic `applyDelta` rather than a sentence: the
 * wave's rule §0b forbids reading Forge's prose, and the phase has been a
 * structured fact on the wire since Tier C landed.
 */
async function declaringAttackersBoard() {
  const ctx = await gestureBoard();
  const me = mineOf(ctx.m);
  ctx.s.send(phaseDelta('COMBAT_DECLARE_ATTACKERS', me.id));
  await untilMatch(ctx.m, () => expect(ctx.m.view!.phase).toBe('COMBAT_DECLARE_ATTACKERS'));
  expect(ctx.m.view!.activePlayerId).toBe(me.id);
  return ctx;
}

describe('§B.1 — an attacker is marked at SELECTION, and the mark is not Forge’s tapped state', () => {
  it('a click marks the card the moment the frame leaves, and the wire carries exactly one selectCard', async () => {
    const { s, m, canvas } = await declaringAttackersBoard();
    const attacker = mineOf(m).battlefield.find((c) => !c.tapped)!.id;
    for (const f of notify([prompt('Declare attackers'), actionable([attacker])])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.has(attacker)).toBe(true));

    const li = cardEl(canvas, attacker);
    expect(li.hasAttribute('data-attack-intent')).toBe(false);
    fireEvent.click(li.querySelector('button')!);

    await waitFor(() => expect(cardEl(canvas, attacker).dataset.attackIntent).toBe('sent'));
    expect(sent(s)).toEqual([['selectCard', attacker]]);
  });

  it('the mark never claims Forge’s tapped state: an untapped attacker stays untapped', async () => {
    const { s, m, canvas } = await declaringAttackersBoard();
    const card = mineOf(m).battlefield.find((c) => !c.tapped)!;
    for (const f of notify([prompt('Declare attackers'), actionable([card.id])])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.has(card.id)).toBe(true));

    fireEvent.click(cardEl(canvas, card.id).querySelector('button')!);
    await waitFor(() => expect(cardEl(canvas, card.id).dataset.attackIntent).toBe('sent'));

    // THE SAFETY CONTROL. Forge taps an attacker when the declaration lands;
    // until then this seat's intent is a different claim, and it must not be
    // dressed as the engine's truth.
    const li = cardEl(canvas, card.id);
    expect(li.hasAttribute('data-tapped')).toBe(false);
    expect(mineOf(m).battlefield.find((c) => c.id === card.id)!.tapped).toBe(false);
  });

  it('Forge agreed: its own Attacking takes the mark over', async () => {
    const { s, m, canvas } = await declaringAttackersBoard();
    const attacker = mineOf(m).battlefield.find((c) => !c.tapped)!.id;
    for (const f of notify([prompt('Declare attackers'), actionable([attacker])])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.has(attacker)).toBe(true));
    fireEvent.click(cardEl(canvas, attacker).querySelector('button')!);
    await waitFor(() => expect(cardEl(canvas, attacker).dataset.attackIntent).toBe('sent'));

    s.send(attackingDelta([attacker]));
    await waitFor(() => expect(cardEl(canvas, attacker).dataset.attackIntent).toBe('declared'));
  });

  it('Forge did NOT declare it: the disagreement is shown, not papered over', async () => {
    const { s, m, canvas } = await declaringAttackersBoard();
    const attacker = mineOf(m).battlefield.find((c) => !c.tapped)!.id;
    for (const f of notify([prompt('Declare attackers'), actionable([attacker])])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.has(attacker)).toBe(true));
    fireEvent.click(cardEl(canvas, attacker).querySelector('button')!);
    await waitFor(() => expect(cardEl(canvas, attacker).dataset.attackIntent).toBe('sent'));

    // Forge speaks again and still offers the card. `pushAttackerCandidates`
    // drops the attackers it HAS declared, so an id re-offered is an id it did
    // not take — Forge wins, and the card says so.
    s.send(actionable([attacker]));
    await waitFor(() => expect(cardEl(canvas, attacker).dataset.attackIntent).toBe('refused'));
    expect(cardEl(canvas, attacker).hasAttribute('data-tapped')).toBe(false);
  });

  it('outside declare-attackers nothing is marked at all', async () => {
    const { s, m, canvas } = await gestureBoard();
    const card = mineOf(m).battlefield[0]!.id;
    for (const f of notify([prompt('Priority'), actionable([card])])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.has(card)).toBe(true));
    fireEvent.click(cardEl(canvas, card).querySelector('button')!);
    await s.untilClientFrames(1);
    expect(canvas.querySelector('[data-attack-intent]')).toBeNull();
  });
});

/* ── §B.2 — box-draw multi-select ────────────────────────────────────── */

describe('§B.2 — a box-draw declares several attackers, and only ones Forge offered', () => {
  it('every offered creature the marquee touched is sent, each as its own selectCard', async () => {
    const { s, m, canvas } = await declaringAttackersBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const [a, b, far] = [mine[0]!, mine[1]!, mine[2]!];
    for (const f of notify([prompt('Declare attackers'), actionable([a, b, far])])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.size).toBe(3));

    boxAt(overlayOf(canvas), 0, 0, 800, 600);
    boxAt(cardEl(canvas, a), 120, 120);
    boxAt(cardEl(canvas, b), 180, 120);
    boxAt(cardEl(canvas, far), 600, 400);

    const zone = canvas.querySelector<HTMLElement>('[data-zone="battlefield"]')!;
    fireEvent.pointerDown(zone, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(zone, { clientX: 300, clientY: 300 });
    // The marquee is drawn while it is being drawn.
    expect(overlayOf(canvas).querySelector('[data-testid="marquee"]')).not.toBeNull();
    fireEvent.pointerUp(zone, { clientX: 300, clientY: 300 });

    await s.untilClientFrames(2);
    expect(sent(s)).toEqual([
      ['selectCard', a],
      ['selectCard', b],
    ]);
    expect(overlayOf(canvas).querySelector('[data-testid="marquee"]')).toBeNull();
  });

  it('a card inside the box that Forge did NOT offer is never sent', async () => {
    const { s, m, canvas } = await declaringAttackersBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    const offered = mine[0]!;
    const notOffered = mine[1]!;
    // Forge names ONE of the two creatures under the box, and the opponent's
    // creature is under it too.
    for (const f of notify([prompt('Declare attackers'), actionable([offered])])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.size).toBe(1));

    boxAt(overlayOf(canvas), 0, 0, 800, 600);
    boxAt(cardEl(canvas, offered), 120, 120);
    boxAt(cardEl(canvas, notOffered), 180, 120);
    boxAt(cardEl(canvas, theirs[0]!), 220, 160);

    const zone = canvas.querySelector<HTMLElement>('[data-zone="battlefield"]')!;
    fireEvent.pointerDown(zone, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(zone, { clientX: 400, clientY: 400 });
    fireEvent.pointerUp(zone, { clientX: 400, clientY: 400 });

    await s.untilClientFrames(1);
    // Exactly one frame, and it is the one Forge named. A barrier follows, so a
    // second frame cannot be merely late.
    expect(sent(s)).toEqual([['selectCard', offered]]);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent(s)).toEqual([['selectCard', offered]]);
  });

  it('a box that never passes the slop is a click, and sends nothing of its own', async () => {
    const { s, m, canvas } = await declaringAttackersBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Declare attackers'), actionable([mine[0]!])])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.size).toBe(1));
    boxAt(overlayOf(canvas), 0, 0, 800, 600);
    boxAt(cardEl(canvas, mine[0]!), 100, 100);

    const zone = canvas.querySelector<HTMLElement>('[data-zone="battlefield"]')!;
    fireEvent.pointerDown(zone, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(zone, { clientX: 102, clientY: 101 });
    fireEvent.pointerUp(zone, { clientX: 102, clientY: 101 });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames()).toHaveLength(0);
  });

  it('outside declare-attackers a press on the table starts no box at all', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([mine[0]!])])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.size).toBe(1));
    boxAt(overlayOf(canvas), 0, 0, 800, 600);
    boxAt(cardEl(canvas, mine[0]!), 120, 120);

    const zone = canvas.querySelector<HTMLElement>('[data-zone="battlefield"]')!;
    fireEvent.pointerDown(zone, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(zone, { clientX: 300, clientY: 300 });
    expect(overlayOf(canvas).querySelector('[data-testid="marquee"]')).toBeNull();
    fireEvent.pointerUp(zone, { clientX: 300, clientY: 300 });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames()).toHaveLength(0);
  });
});

/*
 * Ledger Z3 (the operator, 2026-10-06, choosing cards to put on the bottom):
 * "it's also strange that i can drag an arrow from them."
 */
describe('the London mulligan’s bottom pick: a hand card is a click, never an arrow', () => {
  it('a press on an offered hand card is not claimed, and moving the pointer draws nothing', async () => {
    const { s, m, canvas } = await gestureBoard();
    // What Forge sends for the bottom pick: its prompt and bar (the input is live), and its own flag; no selection, no actionable set.
    for (const f of notify([prompt('Return 1 card(s) to the bottom of your library'), okBar()])) s.send(f);
    s.send(stateDelta({ [GAME_KEY]: { _type: 3, _id: 1, Mulligan: { t: 'bool', v: true } } }));
    const hand = mineOf(m).hand!.map((c) => c.id);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.has(hand[0]!), 'Forge’s flag offers the hand').toBe(true));
    const card = cardEl(canvas, hand[0]!);
    const press = fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 });
    expect(press, 'the press is left to the click').toBe(true);
    expect(card.hasAttribute('data-cast-lift'), 'nothing is lifted').toBe(false);
    const myBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;
    fireEvent.pointerMove(myBattlefield, { clientX: 400, clientY: 300 });
    expect(overlayOf(canvas).querySelector('[data-testid="targeter"]'), 'no arrow').toBeNull();
    fireEvent.pointerUp(myBattlefield, { clientX: 400, clientY: 300 });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames(), 'and the drag sent nothing').toHaveLength(0);
  });
});

/*
 * The operator, 2026-10-06: "can we make it so i can draw boxes to tap things?
 * drawing boxes to attack seems to work, so why not lands?"
 */
describe('a box drawn over the viewer’s own lands taps them, one at a time', () => {
  /** A card's `Tapped`, as Forge reports it. */
  const tappedDelta = (id: number): ServerFrame => stateDelta({ [String(id)]: { _type: 0, _id: id, Tapped: { t: 'bool', v: true } } });
  /** What Forge sends the moment it takes a click at priority, before any state: the offer is withdrawn. */
  const offerWithdrawn = (): ServerFrame => parseServerFrame({ kind: 'notify', method: 'clearWeaklySelectable' });

  async function landsOffered() {
    const board = await gestureBoard();
    const { s, m, canvas } = board;
    // The recorded game left most of this seat's permanents tapped: untap them, as an untap step would.
    const untap = mineOf(m).battlefield.filter((c) => c.tapped).map((c) => c.id);
    if (untap.length > 0) {
      s.send(stateDelta(Object.fromEntries(untap.map((id) => [String(id), { _type: 0, _id: id, Tapped: { t: 'bool', v: false } }]))));
      await untilMatch(m, () => expect(mineOf(m).battlefield.some((c) => c.tapped)).toBe(false));
    }
    const mine = mineOf(m).battlefield;
    const lands = mine.filter((c) => c.card.typeLine.includes('Land')).map((c) => c.id);
    const other = mine.find((c) => !c.card.typeLine.includes('Land'))?.id;
    expect(lands.length, 'the fixture gives this seat two lands').toBeGreaterThanOrEqual(2);
    const offered = other === undefined ? lands : [...lands, other];
    for (const f of notify([prompt('Priority'), actionable(offered), okBar()])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.size).toBe(offered.length));
    boxAt(overlayOf(canvas), 0, 0, 800, 600);
    lands.forEach((id, i) => boxAt(cardEl(canvas, id), 120 + i * 60, 120));
    if (other !== undefined) boxAt(cardEl(canvas, other), 150, 200);
    const zone = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;
    /** Draw a box from (100,100) to (x,y) on empty table. */
    const sweep = (x: number, y: number): void => {
      fireEvent.pointerDown(zone, { button: 0, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(zone, { clientX: x, clientY: y });
      expect(overlayOf(canvas).querySelector('[data-testid="marquee"]'), 'the box is drawn').not.toBeNull();
      fireEvent.pointerUp(zone, { clientX: x, clientY: y });
    };
    return { ...board, lands, other, offered, sweep };
  }

  it('the first land goes out at the release, and each next one only after the board shows the one before it tapped', async () => {
    const { s, lands, offered, sweep } = await landsOffered();
    sweep(700, 300);
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', lands[0]]]);
    await new Promise((r) => setTimeout(r, 80));
    expect(s.clientFrames(), 'the second waits for Forge').toHaveLength(1);

    // Forge takes the click, taps the land, and only then offers the board again.
    s.send(offerWithdrawn());
    s.send(tappedDelta(lands[0]!));
    await new Promise((r) => setTimeout(r, 80));
    expect(s.clientFrames(), 'tapped, but not offered again yet: still waiting').toHaveLength(1);
    for (const f of notify([prompt('Priority'), actionable(offered.filter((id) => id !== lands[0])), okBar()])) s.send(f);
    await s.untilClientFrames(2);
    expect(sent(s)[1]).toEqual(['selectCard', lands[1]]);
  });

  /*
   * The operator, 2026-10-08: "when drawing a box to tap
   * lands, can we have them all tap simultaneously rather than one at a
   * time?" The SEND stays one at a time (the test above) — this is the DRAWN
   * state, which no longer waits on it.
   */
  it('the release draws every boxed land tapped at once, before Forge has confirmed any of them', async () => {
    const { s, canvas, lands, sweep } = await landsOffered();
    sweep(700, 300);
    // Only the first land has gone out on the wire…
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', lands[0]]]);
    // …but every land the box touched is already drawn tapped.
    for (const id of lands) {
      expect(cardEl(canvas, id!).hasAttribute(TAPPED_PENDING_ATTR), `land ${id} is drawn tapped-pending at the release`).toBe(true);
    }
  });

  it('only lands: an offered creature inside the box is not activated, and a land outside it is not tapped', async () => {
    const { s, lands, other, sweep } = await landsOffered();
    // A box that covers the first land and the creature below it, and stops short of the second land.
    sweep(170, 300);
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', lands[0]]]);
    expect(other, 'the fixture has an offered non-land in the box').toBeDefined();
    await new Promise((r) => setTimeout(r, 80));
    expect(s.clientFrames()).toHaveLength(1);
  });

  it('the ability question Forge asks about the land in flight does not end the sweep', async () => {
    const { s, m, lands, offered, sweep } = await landsOffered();
    sweep(700, 300);
    await s.untilClientFrames(1);
    // What real Forge sends for every land click (wire recorded 2026-10-06): which ability? One is on offer.
    s.send(
      parseServerFrame({
        kind: 'ask',
        callId: 's0-1',
        method: 'getAbilityToPlay',
        hostCard: { kind: 'card', id: lands[0] },
        abilities: [{ kind: 'spellAbility', id: 249, label: '{T}: Add {W}.' }],
        triggerEvent: null,
      }),
    );
    await untilMatch(m, () => expect(m.asks).toHaveLength(1));
    // Answered (the prompt layer does it for a one-ability ask; here, by hand), then the tap lands and the board is offered again.
    expect(answerAsk(m, 's0-1', 'getAbilityToPlay', { kind: 'spellAbility', id: 249, label: '{T}: Add {W}.' })).toBe(true);
    s.send(offerWithdrawn());
    s.send(tappedDelta(lands[0]!));
    for (const f of notify([prompt('Priority'), actionable(offered.filter((id) => id !== lands[0])), okBar()])) s.send(f);
    await waitFor(() =>
      expect(sent(s).filter((f) => Array.isArray(f) && f[0] === 'selectCard')).toEqual([
        ['selectCard', lands[0]],
        ['selectCard', lands[1]],
      ]),
    );
  });

  it('a question from Forge ends the sweep: nothing more is sent', async () => {
    const { s, m, canvas, lands, sweep } = await landsOffered();
    sweep(700, 300);
    await s.untilClientFrames(1);
    s.send(offerWithdrawn());
    s.send(tappedDelta(lands[0]!));
    for (const f of notify([prompt('Choose a target'), selectables([lands[1]!], 1, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    for (const f of notify([prompt('Priority'), actionable([lands[1]!]), okBar()])) s.send(f);
    await new Promise((r) => setTimeout(r, 120));
    expect(sent(s), 'the land a selection named was not tapped by a sweep that had ended').toEqual([['selectCard', lands[0]]]);
    // The land the sweep never reached is no longer drawn pending once the sweep ends.
    expect(cardEl(canvas, lands[1]!).hasAttribute(TAPPED_PENDING_ATTR)).toBe(false);
  });

  it('with no land of this seat’s to tap, a press on the table starts no box', async () => {
    const { s, m, canvas } = await gestureBoard();
    const creature = mineOf(m).battlefield.find((c) => !c.card.typeLine.includes('Land'))!.id;
    for (const f of notify([prompt('Priority'), actionable([creature]), okBar()])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.size).toBe(1));
    const zone = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;
    fireEvent.pointerDown(zone, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(zone, { clientX: 300, clientY: 300 });
    expect(overlayOf(canvas).querySelector('[data-testid="marquee"]')).toBeNull();
    fireEvent.pointerUp(zone, { clientX: 300, clientY: 300 });
    expect(s.clientFrames()).toHaveLength(0);
  });
});

/*
 * Wave 32 Q14 — pulling attackers back.
 *
 * Forge toggles: `InputAttack.onCardSelected` undeclares a creature that is
 * already attacking (`InputAttack.java:208-218`). It does NOT keep a declared
 * attacker in `setWeaklySelectable` (`pushAttackerCandidates` drops it,
 * `PlayerControllerHuman.java:1613-1614`), so what puts one in the offer is
 * `boardInteraction` (`../match.ts`, lane S) — these cases stand for that offer
 * with a `setWeaklySelectable` that names the declared attacker, and prove what
 * THIS layer does with it.
 */
describe('Q14 — a click or a box pulls declared attackers back', () => {
  async function declared() {
    const ctx = await declaringAttackersBoard();
    const mine = mineOf(ctx.m).battlefield.map((c) => c.id);
    const [a, b, free] = [mine[0]!, mine[1]!, mine[2]!];
    ctx.s.send(attackingDelta([a, b]));
    for (const f of notify([prompt('Declare attackers'), actionable([a, b, free])])) ctx.s.send(f);
    await untilMatch(ctx.m, () => expect(boardInteraction(ctx.m).selectable.size).toBe(3));
    await untilMatch(ctx.m, () => expect(mineOf(ctx.m).battlefield.find((c) => c.id === a)!.attacking).toBe(true));
    boxAt(overlayOf(ctx.canvas), 0, 0, 800, 600);
    boxAt(cardEl(ctx.canvas, a), 120, 120);
    boxAt(cardEl(ctx.canvas, b), 180, 120);
    boxAt(cardEl(ctx.canvas, free), 240, 120);
    return { ...ctx, a, b, free };
  }

  const sweep = (canvas: HTMLElement, right: number) => {
    const zone = canvas.querySelector<HTMLElement>('[data-zone="battlefield"]')!;
    fireEvent.pointerDown(zone, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(zone, { clientX: right, clientY: 300 });
    fireEvent.pointerUp(zone, { clientX: right, clientY: 300 });
  };

  it('a click on a declared attacker sends the one selectCard that undeclares it', async () => {
    const { s, canvas, a } = await declared();
    fireEvent.click(cardEl(canvas, a).querySelector('button')!);
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', a]]);
  });

  it('a box over only declared attackers pulls every one of them back', async () => {
    const { s, a, b, canvas } = await declared();
    sweep(canvas, 230); // touches a and b, not the free creature
    await s.untilClientFrames(2);
    expect(sent(s)).toEqual([
      ['selectCard', a],
      ['selectCard', b],
    ]);
  });

  it('a box over declared AND undeclared creatures declares the undeclared and leaves the declared alone', async () => {
    const { s, free, canvas } = await declared();
    sweep(canvas, 400); // touches a, b and the free creature
    await s.untilClientFrames(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent(s)).toEqual([['selectCard', free]]);
  });
});

/* ── §B.3 — blocking by drag ─────────────────────────────────────────── */

describe('§B.3 — a blocker is assigned by dragging it onto an attacker', () => {
  /**
   * Declare blockers, as `InputBlock` publishes it: the opponent is the active
   * player, two of its creatures are attacking, Forge has highlighted the one it
   * auto-selected, and this seat's own creature is the blocker candidate.
   */
  async function blockingBoard() {
    const ctx = await gestureBoard();
    const { s, m } = ctx;
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    const blocker = mineOf(m).battlefield[0]!.id;
    s.send(phaseDelta('COMBAT_DECLARE_BLOCKERS', theirsOf(m).id));
    s.send(attackingDelta([theirs[0]!, theirs[1]!]));
    await untilMatch(m, () => expect(m.view!.phase).toBe('COMBAT_DECLARE_BLOCKERS'));
    for (const f of notify([prompt('Select a blocker'), actionable([blocker]), highlight([theirs[0]!], true)])) s.send(f);
    await untilMatch(m, () => expect(m.highlighted!.size).toBe(1));
    return { ...ctx, blocker, attackers: [theirs[0]!, theirs[1]!] as const };
  }

  it('the two frames go out ATTACKER first, which is the order InputBlock needs', async () => {
    const { s, canvas, blocker, attackers } = await blockingBoard();
    holdBoardClock();
    // The SECOND attacker: it is not the one Forge highlighted, so it reaches
    // the offered set only through `blockTargets`.
    drag(cardEl(canvas, blocker), cardEl(canvas, attackers[1]));
    // The attacker's click goes out alone: the blocker's waits until Forge has made that attacker the
    // current one, because Forge may apply two quick clicks in either order (`afterMarked`).
    await s.untilClientFrames(1);
    await sleep(50);
    expect(sent(s)).toEqual([['selectCard', attackers[1]]]);
    // `InputBlock.setCurrentAttacker`: the old one unmarked, the new one marked.
    s.send(highlight([attackers[0]!], false));
    s.send(highlight([attackers[1]!], true));
    await s.untilClientFrames(2);
    expect(sent(s)).toEqual([
      ['selectCard', attackers[1]],
      ['selectCard', blocker],
    ]);
  });

  it('the attacker Forge had already selected needs no click of its own: one frame, the blocker', async () => {
    const { s, m, canvas, blocker, attackers } = await blockingBoard();
    // Forge highlighted this one, which is how `setCurrentAttacker` says it is
    // already the current attacker — clicking it again would be a no-op, and
    // `../combat-drag.jvm.test.ts` measured exactly one frame here against a
    // real engine.
    expect(m.highlighted!.has(attackers[0])).toBe(true);
    drag(cardEl(canvas, blocker), cardEl(canvas, attackers[0]));
    await s.untilClientFrames(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent(s)).toEqual([['selectCard', blocker]]);
  });

  it('a click on the creature blocks nothing: blocking is by drag only', async () => {
    const { s, canvas, blocker } = await blockingBoard();
    fireEvent.click(cardEl(canvas, blocker).querySelector('button')!);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames()).toHaveLength(0);
  });

  it('dropped back on its own spot, an unassigned creature sends nothing', async () => {
    const { s, canvas, blocker } = await blockingBoard();
    drag(cardEl(canvas, blocker), cardEl(canvas, blocker));
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames()).toHaveLength(0);
  });

  it('a drop on nothing legal sends nothing — the blocker dragged off the table', async () => {
    const { s, canvas, blocker } = await blockingBoard();
    drag(cardEl(canvas, blocker), document.body);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames()).toHaveLength(0);
  });

  it('no attacker is offered while nothing is highlighted — that is not InputBlock', async () => {
    const { s, m, canvas } = await gestureBoard();
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    const blocker = mineOf(m).battlefield[0]!.id;
    s.send(phaseDelta('COMBAT_DECLARE_BLOCKERS', theirsOf(m).id));
    s.send(attackingDelta([theirs[0]!]));
    await untilMatch(m, () => expect(m.view!.phase).toBe('COMBAT_DECLARE_BLOCKERS'));
    for (const f of notify([prompt('Priority'), actionable([blocker])])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.has(blocker)).toBe(true));
    expect(boardInteraction(m).selectable.has(theirs[0]!)).toBe(false);

    // The drop lands on an inert card inside a zone, which is the plain
    // "the card is being used" frame — one, not two, and not the attacker's.
    drag(cardEl(canvas, blocker), cardEl(canvas, theirs[0]!));
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', blocker]]);
  });
});

/* ── the undo offer and the lasting block arrow ───────────────────────── */

describe('a block already assigned stays clickable, and draws its own arrow', () => {
  /**
   * Same board as `blockingBoard` above, carried one step further: the block
   * has gone out (Forge no longer offers this card as a CANDIDATE — it is no
   * longer unassigned — but the wire's planned map still names it).
   */
  async function alreadyBlocking() {
    const ctx = await gestureBoard();
    const { s, m } = ctx;
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    const blocker = mineOf(m).battlefield[0]!.id;
    /** Forge's `CombatView`: the blocker planned on the first attacker (`pblk`), or on none. */
    const combat = (pblk: number[], blk: number[] = [], second: number[] = []): ServerFrame =>
      stateDelta({
        [GAME_KEY]: {
          _type: 3,
          _id: 1,
          CombatView: {
            t: 'combat',
            atk: [[theirs[0]!], [theirs[1]!]],
            def: [
              [1, mineOf(m).id],
              [1, mineOf(m).id],
            ],
            blk: [blk, []],
            pblk: [pblk, second],
          },
        },
      });
    s.send(phaseDelta('COMBAT_DECLARE_BLOCKERS', theirsOf(m).id));
    s.send(attackingDelta([theirs[0]!, theirs[1]!]));
    await untilMatch(m, () => expect(m.view!.phase).toBe('COMBAT_DECLARE_BLOCKERS'));
    // `pushBlockerCandidates` has dropped it (it is assigned, not a candidate
    // any more); only the wire's planned map still names it. The attacker it
    // blocks is `InputBlock`'s current one.
    for (const f of notify([prompt('Select a blocker'), actionable([]), highlight([theirs[0]!], true)])) s.send(f);
    s.send(combat([blocker]));
    await untilMatch(m, () => expect(boardInteraction(m).selectable.has(blocker)).toBe(true));
    return { ...ctx, blocker, attacker: theirs[0]!, other: theirs[1]!, combat };
  }

  it('is offered off the planned map alone, and dropping it back on its own spot is Forge’s own undo', async () => {
    const { s, canvas, blocker } = await alreadyBlocking();
    drag(cardEl(canvas, blocker), cardEl(canvas, blocker));
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', blocker]]);
  });

  it('dragged onto a different attacker it MOVES: the undo, then the new attacker, then the blocker', async () => {
    const { s, canvas, blocker, attacker, other, combat } = await alreadyBlocking();
    holdBoardClock();
    drag(cardEl(canvas, blocker), cardEl(canvas, other));
    // The undo first, on the attacker it blocks (already current): one frame.
    await s.untilClientFrames(1);
    await sleep(50);
    expect(sent(s)).toEqual([['selectCard', blocker]]);
    // Forge undoes it and offers it again as a candidate.
    s.send(combat([]));
    for (const f of notify([actionable([blocker])])) s.send(f);
    await s.untilClientFrames(2);
    await sleep(50);
    expect(sent(s)).toEqual([
      ['selectCard', blocker],
      ['selectCard', other],
    ]);
    // `setCurrentAttacker`: the other attacker is current now, and the blocker's click follows.
    s.send(highlight([attacker], false));
    s.send(highlight([other], true));
    await s.untilClientFrames(3);
    expect(sent(s)).toEqual([
      ['selectCard', blocker],
      ['selectCard', other],
      ['selectCard', blocker],
    ]);
  });

  it('a creature Forge still offers as a candidate (it can block one more) keeps its first block', async () => {
    const { s, canvas, blocker, other } = await alreadyBlocking();
    for (const f of notify([actionable([blocker])])) s.send(f);
    await new Promise((r) => setTimeout(r, 50));
    drag(cardEl(canvas, blocker), cardEl(canvas, other));
    await s.untilClientFrames(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent(s)).toEqual([['selectCard', other]]);
  });

  it('dropped on the attacker it already blocks, nothing is sent', async () => {
    const { s, canvas, blocker, attacker } = await alreadyBlocking();
    drag(cardEl(canvas, blocker), cardEl(canvas, attacker));
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames()).toHaveLength(0);
  });

  it('draws a lasting arrow from the blocker to its attacker while declaring, off the PLANNED map', async () => {
    const { canvas, blocker, attacker } = await alreadyBlocking();
    await waitFor(() =>
      expect(
        overlayOf(canvas).querySelector(`[data-testid="stack-target-arrow"][data-key="block:${blocker}:${attacker}"]`),
      ).not.toBeNull(),
    );
  });

  it('the arrow disappears the moment Forge’s own next frame drops the assignment — no click of ours in between', async () => {
    const { s, canvas, blocker, attacker, combat } = await alreadyBlocking();
    await waitFor(() =>
      expect(overlayOf(canvas).querySelector(`[data-testid="stack-target-arrow"][data-key="block:${blocker}:${attacker}"]`)).not.toBeNull(),
    );
    s.send(combat([]));
    await waitFor(() =>
      expect(overlayOf(canvas).querySelector(`[data-testid="stack-target-arrow"][data-key="block:${blocker}:${attacker}"]`)).toBeNull(),
    );
  });

  it('the arrow stays once Forge moves past InputBlock', async () => {
    const { s, m, canvas, blocker, attacker } = await alreadyBlocking();
    // `GameView.updateCombat` starts sending `blk` too once declare-blockers
    // has resolved (`Combat.java:677-679`) — the step ending, as Forge sends it.
    s.send(phaseDelta('COMBAT_FIRST_STRIKE_DAMAGE', theirsOf(m).id));
    s.send(
      stateDelta({
        [GAME_KEY]: {
          _type: 3,
          _id: 1,
          CombatView: { t: 'combat', atk: [[attacker]], def: [[1, mineOf(m).id]], blk: [[blocker]], pblk: [[blocker]] },
        },
      }),
    );
    await untilMatch(m, () => expect(declaringBlockers(m)).toBe(false));
    await waitFor(() =>
      expect(
        overlayOf(canvas).querySelector(`[data-testid="stack-target-arrow"][data-key="block:${blocker}:${attacker}"]`),
      ).not.toBeNull(),
    );
  });
});

/* ── the attacker watches the blocks being made ───────────────────────── */

describe('on the attacking screen, the defender’s blocks draw as they are assigned', () => {
  it('a block Forge has not confirmed yet draws its arrow, and drops it when undone', async () => {
    const { s, m, canvas } = await gestureBoard();
    const attacker = mineOf(m).battlefield[0]!.id;
    const blocker = theirsOf(m).battlefield[0]!.id;
    const combat = (pblk: number[]): ServerFrame =>
      stateDelta({
        [GAME_KEY]: {
          _type: 3,
          _id: 1,
          CombatView: { t: 'combat', atk: [[attacker]], def: [[1, theirsOf(m).id]], blk: [[]], pblk: [pblk] },
        },
      });
    s.send(phaseDelta('COMBAT_DECLARE_BLOCKERS', mineOf(m).id));
    s.send(attackingDelta([attacker]));
    await untilMatch(m, () => expect(m.view!.phase).toBe('COMBAT_DECLARE_BLOCKERS'));
    expect(declaringBlockers(m)).toBe(false);
    const arrow = () => overlayOf(canvas).querySelector(`[data-testid="stack-target-arrow"][data-key="block:${blocker}:${attacker}"]`);

    s.send(combat([blocker]));
    await waitFor(() => expect(arrow()).not.toBeNull());
    s.send(combat([]));
    await waitFor(() => expect(arrow()).toBeNull());
  });
});

/* ── X1/W14 — attacking a planeswalker or a face by drag ─────────────── */

/**
 * `Type` crosses as a `cardtype` tag (`wire.ts`): sup/core/sub joined by
 * `adapter.ts`'s `typeLineOf`. Retyping one of the opponent's existing
 * battlefield cards is how this file gives itself a planeswalker to attack —
 * the fixture's real capture has none, and `attackDefenders` (`match.ts`) goes
 * off the CURRENT type line, exactly as a Magus-of-the-Moon-style effect
 * would. `cardStateKeyOf` is the CardState delta key (`cardId*16 + 0`, the
 * same ordinal-0 assumption `adapter.test.ts`'s `renameCard` makes for this
 * fixture).
 */
const cardStateKeyOf = (id: number) => String((4 << 28) | (id * 16));
const retypeDelta = (id: number, core: string[], sub: string[] = []): ServerFrame =>
  stateDelta({
    [cardStateKeyOf(id)]: { _type: 4, _id: id * 16, Type: { t: 'cardtype', sup: [], core, sub, all: false, exc: [] } },
  });

describe('X1/W14 — a drop on a planeswalker or a face attacks it; the defender’s frame goes first', () => {
  /** Declaring attackers, with the opponent's first battlefield card retyped a planeswalker. */
  async function attackingBoard() {
    const ctx = await declaringAttackersBoard();
    const { s, m } = ctx;
    const attacker = mineOf(m).battlefield.find((c) => !c.tapped)!.id;
    const pw = theirsOf(m).battlefield[0]!.id;
    s.send(retypeDelta(pw, ['Planeswalker'], ['Jace']));
    await untilMatch(m, () => expect(theirsOf(m).battlefield.find((c) => c.id === pw)!.card.typeLine).toContain('Planeswalker'));
    // The live window itself, bar included — a defender (card or player) is
    // only ever offered while Forge's own bar for this exact window is live,
    // never merely because the phase changed and the actionable set named
    // this seat's own creatures.
    for (const f of notify([prompt('Declare attackers'), attackBar(), actionable([attacker])])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.has(attacker)).toBe(true));
    return { ...ctx, attacker, pw };
  }

  it('a drop on the opponent’s planeswalker sends selectCard(pw), then selectCard(attacker)', async () => {
    const { s, m, canvas, attacker, pw } = await attackingBoard();
    await untilMatch(m, () => expect(boardInteraction(m).selectable.has(pw)).toBe(true));
    holdBoardClock();
    drag(cardEl(canvas, attacker), cardEl(canvas, pw));
    // Only the defender's click until Forge marks the planeswalker current (`InputAttack.setCurrentDefender`).
    await s.untilClientFrames(1);
    await sleep(50);
    expect(sent(s)).toEqual([['selectCard', pw]]);
    s.send(highlight([pw], true));
    await s.untilClientFrames(2);
    expect(sent(s)).toEqual([
      ['selectCard', pw],
      ['selectCard', attacker],
    ]);
  });

  it('if Forge never marks the planeswalker, the attacker’s click is never sent', async () => {
    const { s, m, canvas, attacker, pw } = await attackingBoard();
    await untilMatch(m, () => expect(boardInteraction(m).selectable.has(pw)).toBe(true));
    holdBoardClock();
    drag(cardEl(canvas, attacker), cardEl(canvas, pw));
    await s.untilClientFrames(1);
    // Past the wait: sending the attacker now would declare it against whatever was current before.
    vi.advanceTimersByTime(MARK_WAIT_MS);
    await sleep(50);
    expect(sent(s)).toEqual([['selectCard', pw]]);
  });

  it('a drop on the opponent’s face sends selectPlayer, then selectCard once Forge marks them', async () => {
    const { s, m, canvas, attacker } = await attackingBoard();
    const opponent = theirsOf(m).id;
    holdBoardClock();
    drag(cardEl(canvas, attacker), faceEl(canvas, opponent));
    await s.untilClientFrames(1);
    s.send(highlightPlayers([opponent], true));
    await s.untilClientFrames(2);
    expect(sent(s)).toEqual([
      ['selectPlayer', opponent],
      ['selectCard', attacker],
    ]);
  });

  it('a drop on the face Forge already has as the defender sends only the attacker', async () => {
    const { s, m, canvas, attacker } = await attackingBoard();
    const opponent = theirsOf(m).id;
    s.send(highlightPlayers([opponent], true));
    await untilMatch(m, () => expect(m.highlightedPlayers?.has(opponent)).toBe(true));
    drag(cardEl(canvas, attacker), faceEl(canvas, opponent));
    await s.untilClientFrames(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent(s)).toEqual([['selectCard', attacker]]);
  });

  it('a drop on the defender it already attacks sends nothing — Forge would toggle it off', async () => {
    const { s, m, canvas, attacker } = await attackingBoard();
    const opponent = theirsOf(m).id;
    // Already declared: Forge's own CombatView says this band's defender is the opponent.
    s.send(
      stateDelta({
        [GAME_KEY]: {
          _type: 3,
          _id: 1,
          CombatView: { t: 'combat', atk: [[attacker]], def: [[1, opponent]], blk: [[]], pblk: [[]] },
        },
      }),
    );
    await untilMatch(m, () => expect(attackAssignment(m, attacker, { kind: 'player', id: opponent })).toBe('already'));
    drag(cardEl(canvas, attacker), faceEl(canvas, opponent));
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames()).toHaveLength(0);
  });
});

/*
 * The operator, 2026-10-15: "when dragging a card to draw an arrow, if
 * hovering over the card itself it weirdly draws an arrow to the top of the
 * card. let's not allow arrows to snap to things that are not valid targets."
 * The tip snaps only to what the release would send as a target; over the
 * arrow's own source there is no arrow at all.
 */
describe('the arrow snaps only to a target the release would send', () => {
  /** The tip of the one targeter, off its shaft's `M x1 y1 Q cx cy x2 y2`. */
  const tipOf = (overlay: HTMLElement): { x: number; y: number } => {
    const d = overlay.querySelector('[data-testid="targeter"] path')!.getAttribute('d')!;
    const [x, y] = d.trim().split(/\s+/).slice(-2).map(Number) as [number, number];
    return { x, y };
  };

  async function attackers() {
    const ctx = await declaringAttackersBoard();
    const { s, m, canvas } = ctx;
    const [attacker, other] = mineOf(m).battlefield.filter((c) => !c.tapped).map((c) => c.id) as [number, number];
    for (const f of notify([prompt('Declare attackers'), attackBar(), actionable([attacker, other])])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.has(other)).toBe(true));
    const overlay = overlayOf(canvas);
    boxAt(overlay, 0, 0, 800, 600);
    boxAt(cardEl(canvas, attacker), 100, 300, 80, 112);
    boxAt(cardEl(canvas, other), 300, 300, 80, 112);
    return { ...ctx, overlay, attacker, other };
  }

  it('an attacker dragged and still over itself draws no arrow — never one into its own top edge', async () => {
    const { s, canvas, overlay, attacker } = await attackers();
    fireEvent.pointerDown(cardEl(canvas, attacker), { button: 0, clientX: 140, clientY: 400 });
    fireEvent.pointerMove(cardEl(canvas, attacker), { clientX: 150, clientY: 330 });
    await frame();
    const arrow = overlay.querySelector<SVGElement>('[data-testid="targeter"]');
    expect(arrow === null ? null : { target: arrow.dataset.target, snapped: arrow.dataset.snapped, tip: tipOf(overlay) }).toBeNull();
    fireEvent.pointerCancel(window);
    expect(s.clientFrames()).toHaveLength(0);
  });

  it('another of this seat’s attackers is no target: the tip follows the pointer, and the drop declares the dragged one only', async () => {
    const { s, canvas, overlay, attacker, other } = await attackers();
    fireEvent.pointerDown(cardEl(canvas, attacker), { button: 0, clientX: 140, clientY: 400 });
    fireEvent.pointerMove(cardEl(canvas, other), { clientX: 330, clientY: 350 });
    const arrow = await waitFor(() => overlay.querySelector<SVGElement>('[data-testid="targeter"]')!);
    expect(arrow.dataset.target).toBeUndefined();
    expect(arrow.dataset.snapped).toBeUndefined();
    expect(tipOf(overlay)).toEqual({ x: 330, y: 350 });
    fireEvent.pointerUp(cardEl(canvas, other), { clientX: 330, clientY: 350 });
    await s.untilClientFrames(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent(s)).toEqual([['selectCard', attacker]]);
  });

  it('inside a selection that offers the source too, the source is never its own target; the other offered card is', async () => {
    const { s, m, canvas } = await gestureBoard();
    const overlay = overlayOf(canvas);
    const [source, target] = mineOf(m).battlefield.map((c) => c.id) as [number, number];
    for (const f of notify([prompt('Choose two'), selectables([source, target], 1, 2)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    boxAt(overlay, 0, 0, 800, 600);
    boxAt(cardEl(canvas, source), 100, 300, 80, 112);
    boxAt(cardEl(canvas, target), 300, 300, 80, 112);

    fireEvent.pointerDown(cardEl(canvas, source), { button: 0, clientX: 140, clientY: 400 });
    fireEvent.pointerMove(cardEl(canvas, source), { clientX: 150, clientY: 330 });
    await frame();
    expect(overlay.querySelector('[data-testid="targeter"]'), 'over its own source').toBeNull();

    fireEvent.pointerMove(cardEl(canvas, target), { clientX: 330, clientY: 350 });
    await waitFor(() => expect(overlay.querySelector<SVGElement>('[data-testid="targeter"]')?.dataset.target).toBe(`card:${target}`));

    // Back over the source and let go: the source is used, exactly as before.
    fireEvent.pointerMove(cardEl(canvas, source), { clientX: 150, clientY: 330 });
    await waitFor(() => expect(overlay.querySelector('[data-testid="targeter"]')).toBeNull());
    fireEvent.pointerUp(cardEl(canvas, source), { clientX: 150, clientY: 330 });
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', source]]);
  });

  it('click targeting: the pointer over the card the arrow leaves from draws no arrow', async () => {
    const { s, m, canvas } = await gestureBoard();
    const overlay = overlayOf(canvas);
    const spell = mineOf(m).battlefield[0]!.id;
    const theirs = theirsOf(m).battlefield[0]!.id;
    for (const f of notify([prompt('Priority'), actionable([spell])])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.has(spell)).toBe(true));
    fireEvent.click(cardEl(canvas, spell).querySelector('button')!);
    await untilMatch(m, () => expect(m.lastSelectedCard).toBe(spell));
    // A selection that may take the source itself.
    for (const f of notify([prompt('Choose a target'), selectables([spell, theirs], 1, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    boxAt(overlay, 0, 0, 800, 600);
    boxAt(cardEl(canvas, spell), 100, 300, 80, 112);
    boxAt(cardEl(canvas, theirs), 300, 40, 80, 112);

    fireEvent.pointerMove(cardEl(canvas, theirs), { clientX: 330, clientY: 90 });
    await waitFor(() => expect(overlay.querySelector<SVGElement>('[data-testid="targeter"]')?.dataset.target).toBe(`card:${theirs}`));
    fireEvent.pointerMove(cardEl(canvas, spell), { clientX: 150, clientY: 330 });
    await waitFor(() => expect(overlay.querySelector('[data-testid="targeter"]')).toBeNull());
    expect(sent(s)).toEqual([['selectCard', spell]]);
  });
});

/* ── §B.4 — the arrow draws for click targeting too ──────────────────── */

describe('§B.4 — the arrow follows the pointer for CLICK targeting', () => {
  it('after a click opens a selection, a bare pointer move draws the arrow and sends nothing', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    const spell = mine[0]!;
    // The player clicks the card to cast it…
    for (const f of notify([prompt('Priority'), actionable([spell])])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.has(spell)).toBe(true));
    fireEvent.click(cardEl(canvas, spell).querySelector('button')!);
    await untilMatch(m, () => expect(m.lastSelectedCard).toBe(spell));
    // …and Forge answers with the target selection. No drag: just the pointer.
    for (const f of notify([prompt('Choose a target'), selectables([theirs[0]!], 1, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());

    const overlay = overlayOf(canvas);
    expect(overlay.querySelector('[data-testid="targeter"]')).toBeNull();
    fireEvent.pointerMove(canvas.querySelector('[data-zone="stack"]') ?? canvas, { clientX: 150, clientY: 120 });
    const arrow = await waitFor(() => overlay.querySelector<SVGElement>('[data-testid="targeter"]')!);
    expect(arrow.dataset.mode).toBe('click');
    expect(arrow.dataset.source).toBe(String(spell));
    expect(arrow.dataset.snapped).toBeUndefined();

    // Over the one card Forge offered: the same snap the drag gets.
    fireEvent.pointerMove(cardEl(canvas, theirs[0]!), { clientX: 220, clientY: 180 });
    await waitFor(() =>
      expect(overlay.querySelector<SVGElement>('[data-testid="targeter"]')!.dataset.target).toBe(`card:${theirs[0]}`),
    );
    expect(overlay.querySelector<SVGElement>('[data-testid="targeter"]')!.dataset.snapped).toBe('true');

    // Pointing is not acting: exactly the one frame the click sent.
    expect(sent(s)).toEqual([['selectCard', spell]]);
  });

  /**
   * Item 17.1 — the operator: *"by default it points at player portraits
   * which doesnt make sense at all."* `boardInteraction` makes BOTH players
   * selectable for the whole of an open selection (its own header: "the
   * players a selection input will take", read off `view.players`, not off
   * what is under the pointer) — so a portrait being a LEGAL target is not by
   * itself what draws the arrow at one. This is the actual bug, reproduced:
   * `[data-testid="player"]` is the WHOLE seat (`PlayerArea`'s outer
   * `<section>`, `Board.tsx`) — hand, battlefield, everything — not the
   * portrait, and `targetUnder` used to match on it directly. Hovering their
   * seat's own furniture (their name, in this case — not their face) used to
   * snap the arrow to them; `targets.ts`'s `targetUnder` narrows the hit-test
   * to `data-player-face` alone, and this pins it.
   */
  it('a player is a legal target for the whole selection, but the arrow only snaps to their FACE — never their whole seat by default', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([mine[0]!])])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.has(mine[0]!)).toBe(true));
    fireEvent.click(cardEl(canvas, mine[0]!).querySelector('button')!);
    // No cards named at all — Forge is asking for a PLAYER.
    for (const f of notify([prompt('Choose a target'), selectables([], 1, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    expect(boardInteraction(m).selectablePlayers.size, 'both seats are legal targets throughout the selection').toBeGreaterThan(0);

    // Their SEAT's own furniture — the name beside their face — never their
    // face itself: `[data-testid="player"]` wraps this too, which is exactly
    // the over-wide match this test pins closed.
    const them = theirsOf(m).id;
    const theirSeat = canvas.querySelector<HTMLElement>(`[data-testid="player"][data-player-id="${them}"]`)!;
    const theirName = theirSeat.querySelector<HTMLElement>('.seat__name')!;
    fireEvent.pointerMove(theirName, { clientX: 150, clientY: 120 });
    const loose = await waitFor(() => overlayOf(canvas).querySelector<SVGElement>('[data-testid="targeter"]')!);
    expect(loose.dataset.target, 'their name is inside their seat, but it is not their FACE').toBeUndefined();
    expect(loose.dataset.snapped).toBeUndefined();

    // The face element itself still snaps it — a real point, not a default.
    fireEvent.pointerMove(faceEl(canvas, them), { clientX: 220, clientY: 180 });
    await waitFor(() =>
      expect(overlayOf(canvas).querySelector<SVGElement>('[data-testid="targeter"]')!.dataset.target).toBe(`player:${them}`),
    );
    expect(sent(s)).toEqual([['selectCard', mine[0]!]]);
  });

  it('the click arrow goes when the selection does, and the pointer leaving the canvas takes it too', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([mine[0]!])])) s.send(f);
    await untilMatch(m, () => expect(boardInteraction(m).selectable.has(mine[0]!)).toBe(true));
    fireEvent.click(cardEl(canvas, mine[0]!).querySelector('button')!);
    for (const f of notify([prompt('Choose a target'), selectables([theirs[0]!], 1, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    fireEvent.pointerMove(cardEl(canvas, theirs[0]!), { clientX: 220, clientY: 180 });
    const overlay = overlayOf(canvas);
    await waitFor(() => expect(overlay.querySelector('[data-testid="targeter"]')).not.toBeNull());

    // Off the canvas: no tip to draw to.
    fireEvent.pointerMove(document.body, { clientX: 5, clientY: 5 });
    await waitFor(() => expect(overlay.querySelector('[data-testid="targeter"]')).toBeNull());

    // Back on, then Forge closes the selection: the tail is dropped with the
    // input that took the click, so nothing is drawn from a stale origin.
    fireEvent.pointerMove(cardEl(canvas, theirs[0]!), { clientX: 220, clientY: 180 });
    await waitFor(() => expect(overlay.querySelector('[data-testid="targeter"]')).not.toBeNull());
    s.send(parseServerFrame({ kind: 'notify', method: 'clearSelectables' }));
    await untilMatch(m, () => expect(m.selectables).toBeNull());
    fireEvent.pointerMove(cardEl(canvas, theirs[0]!), { clientX: 222, clientY: 182 });
    await waitFor(() => expect(overlay.querySelector('[data-testid="targeter"]')).toBeNull());
    expect(m.lastSelectedCard).toBeNull();
  });

  it('no click of ours: the tail is the stack’s own source — what a triggered ability targets FROM', async () => {
    const { s, m, canvas } = await gestureBoard();
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    // A selection with no preceding click of ours: the ability put itself on
    // the stack, so its source card is the only sensible tail.
    for (const f of notify([prompt('Choose a target'), selectables([theirs[0]!], 1, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    expect(m.lastSelectedCard).toBeNull();
    const origin = stackOrigin(m, canvas);
    expect(origin).not.toBeNull();

    fireEvent.pointerMove(cardEl(canvas, theirs[0]!), { clientX: 220, clientY: 180 });
    const arrow = await waitFor(() => overlayOf(canvas).querySelector<SVGElement>('[data-testid="targeter"]')!);
    expect(arrow.dataset.mode).toBe('click');
    expect(arrow.dataset.source).toBe(String(origin));
    expect(sent(s)).toEqual([]);
  });

  /**
   * W17 — the ledger's own diagnosis (`playtest-ledger.md`): "the arrow's
   * origin falls back to (0,0)-ish when its source has no element." World
   * Breaker's own "when you cast this spell" trigger needs its target while
   * World Breaker is still ON THE STACK — no battlefield element, no hand
   * element, nothing `cardBox` can find (`StackItem` in `../../Board.tsx`
   * carries `data-stack-id`, never `data-card-id`/`data-board-card`). The
   * tail must fall back to the STACK ITEM's own element, never a point.
   */
  it('W17 — the source card has no board element yet (still on the stack): the tail is the stack item, never a fallback point', async () => {
    const { s, m, canvas } = await gestureBoard();
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    const SOURCE_ID = 9001;
    const STACK_ID = 9101;
    // A stack-resident source with no board element of its own — the card is
    // mid-cast, in no zone the board draws. A brand-new StackItem object
    // goes through `newObjects`, never `objectDeltas`: the client has not
    // seen this id before, and a delta to an unknown object is skipped
    // outright (`fold.ts` rule 4).
    seq += 1;
    s.send(
      parseServerFrame({
        kind: 'notify',
        method: 'applyDelta',
        payload: {
          packet: {
            seq,
            checksum: 0,
            checksumProperties: [],
            newObjects: {
              [String((2 << 28) | STACK_ID)]: { _type: 2, _id: STACK_ID, SourceCard: { t: 'int', v: SOURCE_ID } },
            },
            objectDeltas: {},
            events: [],
          },
        },
      }),
    );
    s.send(stateDelta({ [GAME_KEY]: { _type: 3, _id: 1, Stack: { t: 'list', v: [{ t: 'int', v: STACK_ID }] } } }));
    await untilMatch(m, () => expect(m.view!.stack).toHaveLength(1));
    expect(m.view!.stack[0]!.sourceCardId, 'the synthetic stack item carries its source id').toBe(SOURCE_ID);
    expect(canvas.querySelector(`[data-board-card="${SOURCE_ID}"]`), 'the source has no board element').toBeNull();
    const stackEl = await waitFor(() => canvas.querySelector<HTMLElement>(`[data-stack-id="${STACK_ID}"]`)!);
    boxAt(stackEl, 500, 10, 120, 40); // centre (560, 30) — jsdom has no layout otherwise.

    for (const f of notify([prompt('Choose a target'), selectables([theirs[0]!], 1, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    expect(m.lastSelectedCard).toBeNull();

    fireEvent.pointerMove(cardEl(canvas, theirs[0]!), { clientX: 220, clientY: 180 });
    const arrow = await waitFor(() => overlayOf(canvas).querySelector<SVGElement>('[data-testid="targeter"]')!);
    expect(arrow.dataset.mode).toBe('click');
    expect(arrow.dataset.source).toBe(String(SOURCE_ID));
    // The tail sits at the stack item's own box centre — never (0,0), never
    // the overlay's own corner.
    expect(arrow.querySelector('path')!.getAttribute('d')).toMatch(/^M 560 30 Q /);
    expect(sent(s)).toEqual([]);
  });

  it('an opponent’s spell asks this seat to choose: the tail is that spell’s stack item, not the card this seat clicked last', async () => {
    const { s, m, canvas } = await gestureBoard();
    const clicked = mineOf(m).hand![0]!.id;
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    // A click of this seat's own, turns ago: on record, and nothing to do with what comes next.
    for (const f of notify([prompt('Priority'), actionable([clicked])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    selectCard(m, clicked);
    expect(m.lastSelectedCard).toBe(clicked);
    boxAt(cardEl(canvas, clicked), 100, 400);

    const SPELL = 9001;
    const STACK_ID = 9101;
    seq += 1;
    s.send(
      parseServerFrame({
        kind: 'notify',
        method: 'applyDelta',
        payload: {
          packet: {
            seq,
            checksum: 0,
            checksumProperties: [],
            newObjects: { [String((2 << 28) | STACK_ID)]: { _type: 2, _id: STACK_ID, SourceCard: { t: 'int', v: SPELL } } },
            objectDeltas: {},
            events: [],
          },
        },
      }),
    );
    s.send(stateDelta({ [GAME_KEY]: { _type: 3, _id: 1, Stack: { t: 'list', v: [{ t: 'int', v: STACK_ID }] } } }));
    const item = await waitFor(() => {
      const el = canvas.querySelector<HTMLElement>(`[data-stack-id="${STACK_ID}"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    boxAt(item, 500, 10, 120, 40); // centre (560, 30)
    // The spell's own question, as Forge announces it: the prompt names the spell.
    for (const f of notify([promptFor('Sacrifice a land', SPELL), selectables([theirs[0]!], 1, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());

    fireEvent.pointerMove(cardEl(canvas, theirs[0]!), { clientX: 220, clientY: 180 });
    const arrow = await waitFor(() => overlayOf(canvas).querySelector<SVGElement>('[data-testid="targeter"]')!);
    expect(arrow.dataset.source).toBe(String(SPELL));
    expect(arrow.querySelector('path')!.getAttribute('d'), 'from the spell on the stack, not from the card clicked turns ago').toMatch(/^M 560 30 Q /);
  });

  it('the cleanup discard — a choice with no source — draws no arrow, not even from the card clicked last', async () => {
    const { s, m, canvas } = await gestureBoard();
    const hand = mineOf(m).hand!.map((c) => c.id);
    const clicked = hand[0]!;
    // Her own click, earlier: a land drop or a cast. On record until Forge asks about something else.
    for (const f of notify([prompt('Priority'), actionable([clicked])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    selectCard(m, clicked);
    expect(m.lastSelectedCard).toBe(clicked);
    for (const id of hand) boxAt(cardEl(canvas, id), 100 + 50 * hand.indexOf(id), 400);
    // Forge's cleanup discard: `InputSelectCardsFromList` with no spell ability, so its prompt names no card.
    for (const f of notify([prompt('Cleanup Phase\nSelect 1 card(s) to discard to bring your hand down to the maximum of 7 cards.'), selectables(hand, 1, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    expect(m.promptCard).toBeNull();
    // Both tails `clickOrigin` could reach are on record — the last click and the fixture's stack
    // source — and neither is drawn: a pick among her own hand is not aiming.
    expect(m.lastSelectedCard).toBe(clicked);
    expect(stackOrigin(m, canvas)).not.toBeNull();

    fireEvent.pointerMove(cardEl(canvas, hand[1]!), { clientX: 170, clientY: 420 });
    await new Promise((r) => setTimeout(r, 30));
    expect(overlayOf(canvas).querySelector('[data-testid="targeter"]'), 'nothing is being aimed: no arrow').toBeNull();
    expect(s.clientFrames()).toHaveLength(1); // the one click, nothing from the hover
  });

  it('with nothing to draw from, the pointer draws no arrow', async () => {
    const { s, m, canvas } = await gestureBoard();
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Choose a target'), selectables([theirs[0]!], 1, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    expect(m.lastSelectedCard).toBeNull();
    // Every stack source's own card AND its stack item taken out of the DOM
    // (W17's fallback reaches the stack item itself, so both have to be gone
    // for there to be truly nothing to draw from): the tail has nowhere to
    // start, and a tail from nowhere is not guidance.
    for (const item of m.view!.stack) {
      if (item.sourceCardId !== null) canvas.querySelector(`[data-board-card="${item.sourceCardId}"]`)?.remove();
      canvas.querySelector(`[data-stack-id="${item.id}"]`)?.remove();
    }
    expect(stackOrigin(m, canvas)).toBeNull();

    fireEvent.pointerMove(theirsOf(m).battlefield[1] === undefined ? canvas : cardEl(canvas, theirs[1]!), {
      clientX: 220,
      clientY: 180,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(overlayOf(canvas).querySelector('[data-testid="targeter"]')).toBeNull();
    expect(s.clientFrames()).toHaveLength(0);
  });
});

/**
 * The first stack entry whose source card is actually drawn on the board — the
 * same walk `install.ts`'s `clickOrigin` does, written out so the case asserts
 * against a value it computed rather than a guess.
 */
function stackOrigin(m: LiveMatch, canvas: HTMLElement): number | null {
  for (const item of m.view!.stack) {
    if (item.sourceCardId === null) continue;
    if (canvas.querySelector(`[data-board-card="${item.sourceCardId}"]`) !== null) return item.sourceCardId;
  }
  return null;
}

/* ── wave 32 Q7 — a spell on the stack is a target ───────────────────── */

describe('Q7 — a "select target spell" question takes an arrow to the stack item', () => {
  /** Mana Leak's question: a mandatory getChoices over StackItemViews, min = max = 1. */
  const spellAsk = (callId: string, ids: number[]) =>
    parseServerFrame({
      kind: 'ask',
      callId,
      method: 'getChoices',
      message: 'Select target spell',
      min: 1,
      max: 1,
      choices: ids.map((id) => ({ key: `si-${id}`, label: `Spell ${id}`, ref: { kind: 'stackItem', id } })),
      selected: [],
    });

  /**
   * §S: the stack is a non-visual anchor now — `live/placed.ts` draws a real
   * item's `[data-stack-id]` into the overlay root, which is where these
   * synthetic ones go too, matching real geometry.
   */
  function stackItems(canvas: HTMLElement, ids: number[]): Record<number, HTMLElement> {
    const root = overlayOf(canvas);
    const out: Record<number, HTMLElement> = {};
    for (const id of ids) {
      const el = document.createElement('div');
      el.setAttribute('data-stack-id', String(id));
      root.append(el);
      out[id] = el;
    }
    return out;
  }

  const replies = (s: ReplayServer) =>
    s.clientFrames().map((f) => (f.ok && f.value.kind === 'reply' ? [f.value.method, f.value.result] : f));

  it('a drag from the table onto the stack item answers the question with that item, and the arrow snaps to it', async () => {
    const { s, m, canvas } = await gestureBoard();
    const [wanted, other] = [701, 702];
    const items = stackItems(canvas, [wanted, other]);
    s.send(spellAsk('c-leak', [wanted, other]));
    await untilMatch(m, () => expect(m.asks).toHaveLength(1));

    boxAt(overlayOf(canvas), 0, 0, 800, 600);
    boxAt(items[wanted]!, 300, 100, 200, 60);
    const zone = canvas.querySelector<HTMLElement>('[data-zone="battlefield"]')!;
    fireEvent.pointerDown(zone, { button: 0, clientX: 40, clientY: 400 });
    fireEvent.pointerMove(items[wanted]!, { clientX: 320, clientY: 120 });
    const arrow = await waitFor(() => overlayOf(canvas).querySelector<SVGElement>('[data-testid="targeter"]')!);
    expect(arrow.dataset.target).toBe(`stack:${wanted}`);
    expect(arrow.dataset.snapped).toBe('true');
    fireEvent.pointerUp(items[wanted]!, { clientX: 320, clientY: 120 });

    await s.untilClientFrames(1);
    expect(replies(s)).toEqual([['getChoices', [`si-${wanted}`]]]);
  });

  it('a plain click on the stack item answers it too', async () => {
    const { s, m, canvas } = await gestureBoard();
    const items = stackItems(canvas, [701, 702]);
    s.send(spellAsk('c-leak', [701, 702]));
    await untilMatch(m, () => expect(m.asks).toHaveLength(1));

    fireEvent.pointerDown(items[702]!, { button: 0, clientX: 300, clientY: 100 });
    fireEvent.pointerUp(items[702]!, { clientX: 300, clientY: 100 });
    await s.untilClientFrames(1);
    expect(replies(s)).toEqual([['getChoices', ['si-702']]]);
  });

  it('a release on a stack item the question did NOT name sends nothing', async () => {
    const { s, m, canvas } = await gestureBoard();
    const items = stackItems(canvas, [701, 999]);
    s.send(spellAsk('c-leak', [701, 702]));
    await untilMatch(m, () => expect(m.asks).toHaveLength(1));

    const zone = canvas.querySelector<HTMLElement>('[data-zone="battlefield"]')!;
    fireEvent.pointerDown(zone, { button: 0, clientX: 40, clientY: 400 });
    fireEvent.pointerMove(items[999]!, { clientX: 320, clientY: 120 });
    fireEvent.pointerUp(items[999]!, { clientX: 320, clientY: 120 });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames()).toHaveLength(0);
    expect(m.asks).toHaveLength(1);
  });

  it('with no question open, a press on a stack item starts and sends nothing', async () => {
    const { s, canvas } = await gestureBoard();
    const items = stackItems(canvas, [701]);
    fireEvent.pointerDown(items[701]!, { button: 0, clientX: 300, clientY: 100 });
    fireEvent.pointerUp(items[701]!, { clientX: 300, clientY: 100 });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames()).toHaveLength(0);
  });
});

/*
 * Casting a hand card. Nothing reaches Forge until the release: a press on a
 * card Forge offered in the VIEWER's own hand lifts it (following the
 * pointer, drawing the cues below), and the release decides, from the
 * card's CURRENT type line, what happens next — see `./cast.ts`'s
 * `needsTarget`.
 */
describe('casting a hand card: nothing reaches Forge until the release', () => {
  it('lifting a card sends nothing while it is lifted, held or click-armed', async () => {
    const { s, m, canvas } = await gestureBoard();
    const overlay = overlayOf(canvas);
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[0]!, hand[1]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const myBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;

    fireEvent.pointerDown(cardEl(canvas, hand[0]!), { button: 0, clientX: 10, clientY: 10 });
    expect(cardEl(canvas, hand[0]!).getAttribute('data-cast-lift')).toBe('lifted');
    expect(overlay.querySelector('[data-testid="targeter"]')).toBeNull();

    fireEvent.pointerMove(document.body, { clientX: 60, clientY: 60 });
    fireEvent.pointerMove(myBattlefield, { clientX: 400, clientY: 300 });
    expect(cardEl(canvas, hand[0]!).getAttribute('data-cast-lift'), 'still lifted — no settle any more').toBe('lifted');
    expect(cardEl(canvas, hand[0]!).style.left).toBe('400px');
    expect(s.clientFrames(), 'nothing sent while merely lifted').toHaveLength(0);

    fireEvent.pointerUp(myBattlefield, { clientX: 400, clientY: 300 });
    await s.untilClientFrames(1); // the first card's own release

    fireEvent.pointerDown(cardEl(canvas, hand[1]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(cardEl(canvas, hand[1]!), { clientX: 10, clientY: 10 }); // click-arms
    expect(cardEl(canvas, hand[1]!).getAttribute('data-cast-lift'), 'click-armed — still nothing sent').toBe('lifted');
    expect(s.clientFrames()).toHaveLength(1); // unchanged — the second card is only click-armed
  });

  /*
   * AD2: *"when card is dragged out of hand it should show a card that
   * matches the size of what's currently on board. sometimes cards in hand
   * can display bigger."* A hand row's own `--card-w` has no `--card-max`
   * ceiling (`board.css`'s T6 comment), so it can be bigger than the
   * battlefield's; `drawCastLift`'s `'lifted'` pins the battlefield's own
   * value onto the card the instant it lifts, not later.
   */
  it('a lifted card is sized like the battlefield’s own card, not the hand’s', async () => {
    const { s, m, canvas } = await gestureBoard();
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[0]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const myBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;
    // The battlefield's own card size, and the hand's own (bigger) one the lifted card starts with.
    myBattlefield.style.setProperty('--card-w', '64px');
    cardEl(canvas, hand[0]!).style.setProperty('--card-w', '112px');

    fireEvent.pointerDown(cardEl(canvas, hand[0]!), { button: 0, clientX: 10, clientY: 10 });
    expect(cardEl(canvas, hand[0]!).getAttribute('data-cast-lift')).toBe('lifted');
    expect(
      cardEl(canvas, hand[0]!).style.getPropertyValue('--card-w'),
      'the battlefield’s size, from the lift — not the hand’s',
    ).toBe('64px');
    expect(s.clientFrames(), 'nothing sent yet — the lift alone').toHaveLength(0);
  });

  it('stays the battlefield’s size once the press leaves the hand — it does not shrink back on the way out', async () => {
    const { s, m, canvas } = await gestureBoard();
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[0]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const myBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;
    const myHand = canvas.querySelector<HTMLElement>('[data-zone="hand"][data-owner="you"]')!;
    myBattlefield.style.setProperty('--card-w', '64px');
    cardEl(canvas, hand[0]!).style.setProperty('--card-w', '112px');

    fireEvent.pointerDown(cardEl(canvas, hand[0]!), { button: 0, clientX: 10, clientY: 10 });
    expect(cardEl(canvas, hand[0]!).style.getPropertyValue('--card-w'), 'board-sized from the press').toBe('64px');

    // Still over the hand: the reorder preview, board-sized throughout (not re-measured per move).
    fireEvent.pointerMove(myHand, { clientX: 20, clientY: 20 });
    expect(cardEl(canvas, hand[0]!).style.getPropertyValue('--card-w'), 'still board-sized inside the hand').toBe('64px');

    // Crosses out to the battlefield: the mode change to the cast gesture — and the size must not
    // revert to the card's own (bigger) hand value on the way.
    fireEvent.pointerMove(myBattlefield, { clientX: 400, clientY: 300 });
    expect(
      cardEl(canvas, hand[0]!).style.getPropertyValue('--card-w'),
      'still the battlefield’s size once it has left the hand — never the hand’s again',
    ).toBe('64px');
  });

  it('a no-target card released over the viewer’s own battlefield is played, once, at the release point', async () => {
    const { s, m, canvas } = await gestureBoard();
    const noteSpy = vi.spyOn(BoardModule, 'notePlayedTo');
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[0]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const myBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;

    fireEvent.pointerDown(cardEl(canvas, hand[0]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(myBattlefield, { clientX: 400, clientY: 300 });
    const board = canvas.querySelector<HTMLElement>('.board')!;
    expect(board.hasAttribute('data-placing'), 'her rows show their columns while it is carried').toBe(true);
    expect(myBattlefield.hasAttribute('data-drop'), 'and nothing outlines the battlefield as a whole').toBe(false);
    expect(cardEl(canvas, hand[0]!).hasAttribute('data-cast-verdict'), 'no text on a lifted card').toBe(false);

    fireEvent.pointerUp(myBattlefield, { clientX: 400, clientY: 300 });
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', hand[0]!]]);
    expect(noteSpy).toHaveBeenCalledTimes(1);
    expect(noteSpy).toHaveBeenCalledWith(hand[0], { x: 400, y: 300 });
    expect(cardEl(canvas, hand[0]!).getAttribute('data-cast-lift'), 'out of the hand’s row, and not drawn: its stand-in is').toBe('carried');
    const standIn = canvas.querySelector<HTMLElement>(`[data-cast-ghost="${hand[0]}"]`)!;
    expect(standIn.getAttribute('data-cast-lift'), 'it waits where it was let go, not back in the hand').toBe('parked');
    expect(standIn.style.left).toBe('400px');
    expect(standIn.style.top).toBe('300px');
    expect(board.hasAttribute('data-placing'), 'the columns clear with the release').toBe(false);
  });

  it('a no-target card released off the viewer’s own battlefield floats back, and nothing is sent', async () => {
    const { s, m, canvas } = await gestureBoard();
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[0]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const board = canvas.querySelector<HTMLElement>('.board')!;

    fireEvent.pointerDown(cardEl(canvas, hand[0]!), { button: 0, clientX: 10, clientY: 10 });
    expect(board.hasAttribute('data-placing'), 'still in the hand: no columns').toBe(false);
    fireEvent.pointerMove(document.body, { clientX: 900, clientY: 900 });
    expect(board.hasAttribute('data-placing'), 'out of the hand, the same columns wherever it is carried').toBe(true);
    expect(cardEl(canvas, hand[0]!).hasAttribute('data-cast-verdict'), 'no text on a lifted card').toBe(false);

    fireEvent.pointerUp(document.body, { clientX: 900, clientY: 900 });
    expect(cardEl(canvas, hand[0]!).getAttribute('data-cast-lift'), 'floating back').toBe('returning');
    expect(board.hasAttribute('data-placing'), 'and the columns are gone').toBe(false);
    await new Promise((r) => setTimeout(r, 350));
    expect(s.clientFrames()).toHaveLength(0);
    expect(cardEl(canvas, hand[0]!).getAttribute('data-cast-lift')).toBeNull();
  });

  it('any card released over the hand reorders it, and nothing is sent, whatever the card is', async () => {
    // Replaces the old "floats back" contract: a release back inside the
    // hand is now a REORDER commit, never a cancel — see `install.ts`'s
    // `resolveLift`. The cancel cue (`data-cancel-hint`) was the old cast
    // gesture's own cue for "let go here and nothing happens"; this layer no
    // longer draws it while still inside the hand, because something DOES
    // happen now (the reorder preview, `data-arrange-target`, is
    // `hand.test.ts`'s own to prove). Forge still hears nothing either way.
    const { s, m, canvas } = await gestureBoard();
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[0]!, hand[2]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const myHand = canvas.querySelector<HTMLElement>('[data-zone="hand"][data-owner="you"]')!;

    for (const id of [hand[0]!, hand[2]!]) {
      fireEvent.pointerDown(cardEl(canvas, id), { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(myHand, { clientX: 30, clientY: 20 });
      expect(myHand.hasAttribute('data-cancel-hint'), `card ${id} draws no cast cue over its own hand`).toBe(false);
      expect(cardEl(canvas, id).hasAttribute('data-cast-verdict'), 'no text on a lifted card').toBe(false);
      fireEvent.pointerUp(myHand, { clientX: 30, clientY: 20 });
    }
    await new Promise((r) => setTimeout(r, 350));
    expect(s.clientFrames()).toHaveLength(0);
  });

  it('a card that needs a target is cast at the release, wherever it was released outside the hand, and parks there', async () => {
    const { s, m, canvas } = await gestureBoard();
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[2]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const myBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;
    const theirBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="them"]')!;

    fireEvent.pointerDown(cardEl(canvas, hand[2]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(myBattlefield, { clientX: 400, clientY: 300 });
    expect(canvas.querySelector('.board')!.hasAttribute('data-placing'), 'a targeted card never lands in a row — no columns').toBe(false);
    expect(cardEl(canvas, hand[2]!).hasAttribute('data-cast-verdict'), 'no text on a lifted card').toBe(false);
    expect(s.clientFrames()).toHaveLength(0);

    fireEvent.pointerMove(theirBattlefield, { clientX: 500, clientY: 50 });
    fireEvent.pointerUp(theirBattlefield, { clientX: 500, clientY: 50 });
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', hand[2]!]]);
    expect(cardEl(canvas, hand[2]!).getAttribute('data-cast-lift')).toBe('parked');
    expect(cardEl(canvas, hand[2]!).hasAttribute('data-cast-verdict'), 'no verdict once parked').toBe(false);
    expect(cardEl(canvas, hand[2]!).style.left).toBe('500px');
  });

  it('once Forge opens the target ask, the click-targeting arrow draws from the parked card, and a click answers it', async () => {
    const { s, m, canvas } = await gestureBoard();
    const overlay = overlayOf(canvas);
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[2]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const theirBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="them"]')!;

    fireEvent.pointerDown(cardEl(canvas, hand[2]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(theirBattlefield, { clientX: 500, clientY: 50 });
    fireEvent.pointerUp(theirBattlefield, { clientX: 500, clientY: 50 });
    await s.untilClientFrames(1);

    s.send(selectables([], 0, 1)); // every player legal, same shape every other click-target case uses
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());

    fireEvent.pointerMove(faceEl(canvas, 1), { clientX: 500, clientY: 50 });
    const arrow = await waitFor(() => overlay.querySelector<SVGElement>('[data-testid="targeter"]')!);
    expect(arrow.dataset.source).toBe(String(hand[2]));
    expect(arrow.dataset.target).toBe('player:1');

    // A real click is always a press and a release on the same element first —
    // the press alone sends nothing (zero movement), and the native click that
    // follows is what Board's own markup answers with.
    const faceButton = faceEl(canvas, 1).querySelector<HTMLButtonElement>('button')!;
    fireEvent.pointerDown(faceButton, { button: 0, clientX: 500, clientY: 50 });
    fireEvent.pointerUp(faceButton, { clientX: 500, clientY: 50 });
    fireEvent.click(faceButton);
    await s.untilClientFrames(2);
    expect(sent(s)).toEqual([
      ['selectCard', hand[2]!],
      ['selectPlayer', 1],
    ]);
  });

  it('a click lifts the card with no button held; the next press is the release, at its own point', async () => {
    const { s, m, canvas } = await gestureBoard();
    const noteSpy = vi.spyOn(BoardModule, 'notePlayedTo');
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[0]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const myBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;
    const face = cardEl(canvas, hand[0]!).querySelector<HTMLButtonElement>('button')!;

    fireEvent.pointerDown(face, { button: 0, clientX: 10, clientY: 10 });
    expect(cardEl(canvas, hand[0]!).getAttribute('data-cast-lift')).toBe('lifted');
    fireEvent.pointerUp(face, { clientX: 10, clientY: 10 }); // the click — arms, does not resolve
    expect(cardEl(canvas, hand[0]!).getAttribute('data-cast-lift'), 'still lifted after the click').toBe('lifted');
    expect(s.clientFrames()).toHaveLength(0);
    expect(fireEvent.click(face), 'the native click is swallowed, not answered').toBe(false);

    fireEvent.pointerMove(myBattlefield, { clientX: 400, clientY: 300 }); // no button held: still tracked
    expect(cardEl(canvas, hand[0]!).hasAttribute('data-cast-verdict'), 'no text on a lifted card').toBe(false);
    expect(s.clientFrames()).toHaveLength(0);

    // The NEXT press is the release — plays here, not wherever the click let go.
    fireEvent.pointerDown(myBattlefield, { button: 0, clientX: 600, clientY: 480 });
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', hand[0]!]]);
    expect(noteSpy).toHaveBeenCalledWith(hand[0], { x: 600, y: 480 });
    expect(cardEl(canvas, hand[0]!).getAttribute('data-cast-lift')).toBe('carried');
    expect(canvas.querySelector<HTMLElement>(`[data-cast-ghost="${hand[0]}"]`)!.style.left).toBe('600px');
  });

  /**
   * W5 — the operator: *"if i bring something back to my hand and left click
   * it, that should also put it back in the hand."* The ledger's own note
   * flagged exactly this path to read: a click-armed card (no button held)
   * brought back over the viewer's own hand, then the NEXT press — the "left
   * click" that resolves the gesture — lands there too. `resolveLift`'s
   * `overOwnHand` check is the same one the HELD-drag case already uses
   * (`'any card released over the hand floats back'`, above); this pins the
   * CLICK-ARMED path, which had no test of its own.
   */
  it('W5 — a click-armed card brought back over the hand and left-clicked there reorders, nothing sent', async () => {
    // See the previous test's own note — a release back inside the hand is
    // a reorder commit now, so this card ends up back in the hand (its own
    // reorder is a no-op: nothing else is between it and where it started)
    // rather than floating "back home" by the old cancel path. Still
    // nothing Forge ever hears.
    const { s, m, canvas } = await gestureBoard();
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[0]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const myHand = canvas.querySelector<HTMLElement>('[data-zone="hand"][data-owner="you"]')!;
    const myBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;
    const face = cardEl(canvas, hand[0]!).querySelector<HTMLButtonElement>('button')!;

    // Lift with a click — arms, does not resolve — then carry it OUT (as the
    // operator's own words have it, "bring something back") before bringing
    // it back over the viewer's own hand, with no button held throughout.
    fireEvent.pointerDown(face, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(face, { clientX: 10, clientY: 10 });
    expect(s.clientFrames()).toHaveLength(0);
    fireEvent.pointerMove(myBattlefield, { clientX: 400, clientY: 300 });
    fireEvent.pointerMove(myHand, { clientX: 20, clientY: 20 });
    expect(myHand.hasAttribute('data-cancel-hint'), 'no cast cue over the hand any more').toBe(false);
    expect(s.clientFrames()).toHaveLength(0);

    // The next press is the "left click" that ends the gesture, over the hand.
    fireEvent.pointerDown(myHand, { button: 0, clientX: 20, clientY: 20 });
    await new Promise((r) => setTimeout(r, 350));
    expect(s.clientFrames(), 'nothing reached Forge').toHaveLength(0);
    expect(cardEl(canvas, hand[0]!).getAttribute('data-cast-lift'), 'settled, not mid-cast').toBeNull();
    expect(myHand.hasAttribute('data-cancel-hint'), 'the cue clears with the release').toBe(false);
  });

  it('Escape before any cast cancels silently — nothing was ever sent', async () => {
    const { s, m, canvas } = await gestureBoard();
    const overlay = overlayOf(canvas);
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[0]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());

    fireEvent.pointerDown(cardEl(canvas, hand[0]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(document.body, { clientX: 300, clientY: 300 });
    expect(cardEl(canvas, hand[0]!).getAttribute('data-cast-lift')).toBe('lifted');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(cardEl(canvas, hand[0]!).getAttribute('data-cast-lift')).toBe('returning');
    expect(overlay.querySelector('[data-testid="targeter"]')).toBeNull();

    fireEvent.pointerUp(document.body, { clientX: 300, clientY: 300 });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames()).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(cardEl(canvas, hand[0]!).getAttribute('data-cast-lift')).toBeNull();
  });

  it('Escape while a cast is parked and Forge is asking sends Forge’s own Cancel, not silence', async () => {
    const { s, m, canvas } = await gestureBoard();
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[2]!]), okBar()])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const theirBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="them"]')!;

    fireEvent.pointerDown(cardEl(canvas, hand[2]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(theirBattlefield, { clientX: 500, clientY: 50 });
    fireEvent.pointerUp(theirBattlefield, { clientX: 500, clientY: 50 });
    await s.untilClientFrames(1);
    s.send(selectables([theirsOf(m).battlefield[0]!.id], 1, 1));
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());

    fireEvent.keyDown(window, { key: 'Escape' });
    await s.untilClientFrames(2);
    expect(sent(s)).toEqual([['selectCard', hand[2]!], ['selectButtonCancel']]);
    expect(cardEl(canvas, hand[2]!).getAttribute('data-cast-lift')).toBe('returning');
  });

  /*
   * A no-target card has nothing left to cancel once it is lifted but not yet
   * cast, whatever the control bar's button 2 currently means — a priority
   * window's own button 2 is commonly End Turn, and a naive cancel that
   * pressed it regardless would end the turn instead of merely letting go of
   * the card.
   */
  it('right-click before any cast sends nothing, whatever button 2 currently means on the control bar', async () => {
    const { s, m, canvas } = await gestureBoard();
    const hand = mineOf(m).hand!.map((c) => c.id);
    const endTurnBar = parseServerFrame({
      kind: 'notify',
      method: 'updateButtons',
      owner: { kind: 'player', id: 0 },
      label1: 'OK',
      label2: 'End Turn',
      enable1: true,
      enable2: true,
      focus1: true,
    });
    for (const f of notify([prompt('Priority'), actionable([hand[0]!]), endTurnBar])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const myHand = canvas.querySelector<HTMLElement>('[data-zone="hand"][data-owner="you"]')!;

    fireEvent.pointerDown(cardEl(canvas, hand[0]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(myHand, { clientX: 20, clientY: 20 });
    fireEvent.pointerDown(myHand, { button: 2, clientX: 20, clientY: 20 });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent(s), 'nothing sent — not even the bar’s own End Turn').toEqual([]);
    expect(cardEl(canvas, hand[0]!).getAttribute('data-cast-lift'), 'floats back, same as any other cancel').toBe('returning');
  });

  it('right-click mid-target, while a cast is parked, sends exactly one selectButtonCancel', async () => {
    const { s, m, canvas } = await gestureBoard();
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[2]!]), okBar()])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const theirBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="them"]')!;

    fireEvent.pointerDown(cardEl(canvas, hand[2]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(theirBattlefield, { clientX: 500, clientY: 50 });
    fireEvent.pointerUp(theirBattlefield, { clientX: 500, clientY: 50 });
    await s.untilClientFrames(1);
    s.send(selectables([theirsOf(m).battlefield[0]!.id], 1, 1));
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());

    fireEvent.pointerDown(theirBattlefield, { button: 2, clientX: 500, clientY: 50 });
    fireEvent.pointerDown(theirBattlefield, { button: 2, clientX: 500, clientY: 50 }); // a second right-click: nothing left to cancel
    await s.untilClientFrames(2);
    expect(sent(s)).toEqual([['selectCard', hand[2]!], ['selectButtonCancel']]);
  });

  it('a left click on nothing Forge’s selection names, while a cast is parked, cancels the same way', async () => {
    const { s, m, canvas } = await gestureBoard();
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[2]!]), okBar()])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const theirBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="them"]')!;

    fireEvent.pointerDown(cardEl(canvas, hand[2]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(theirBattlefield, { clientX: 500, clientY: 50 });
    fireEvent.pointerUp(theirBattlefield, { clientX: 500, clientY: 50 });
    await s.untilClientFrames(1);
    s.send(selectables([theirsOf(m).battlefield[0]!.id], 1, 1));
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());

    // The zone itself, not a card inside it: nothing Forge's selection names.
    fireEvent.pointerDown(theirBattlefield, { button: 0, clientX: 999, clientY: 999 });
    await s.untilClientFrames(2);
    expect(sent(s)).toEqual([['selectCard', hand[2]!], ['selectButtonCancel']]);
  });

  /*
   * What real Forge does after the cast goes out: the card leaves the hand at
   * once and is in no zone the board draws, the priority input closes, and
   * only then does the target selection open. The board unmounts the card's
   * element for the whole of the aim.
   */
  async function parkLikeForge() {
    const board = await gestureBoard();
    const { s, m, canvas } = board;
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[2]!]), okBar()])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const theirBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="them"]')!;

    fireEvent.pointerDown(cardEl(canvas, hand[2]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(theirBattlefield, { clientX: 500, clientY: 50 });
    fireEvent.pointerUp(theirBattlefield, { clientX: 500, clientY: 50 });
    await s.untilClientFrames(1);

    s.send(handDelta(hand.filter((id) => id !== hand[2])));
    s.send(prompt('Select any target'));
    await waitFor(() => expect(canvas.querySelector(`[data-board-card="${hand[2]}"]`)).toBeNull());
    s.send(selectables([theirsOf(m).battlefield[0]!.id], 1, 1));
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    return { ...board, cast: hand[2]!, theirBattlefield };
  }

  it('a parked cast whose card the board no longer draws still answers a right-click with Forge’s Cancel', async () => {
    const { s, canvas, theirBattlefield } = await parkLikeForge();
    fireEvent.pointerDown(theirBattlefield, { button: 2, clientX: 500, clientY: 50 });
    await s.untilClientFrames(2);
    expect(sent(s).at(-1)).toEqual(['selectButtonCancel']);
    expect(canvas.querySelector('[data-cast-ghost]')?.getAttribute('data-cast-lift'), 'the stand-in floats home').toBe('returning');
  });

  it('a parked cast whose card the board no longer draws still answers Escape with Forge’s Cancel', async () => {
    const { s } = await parkLikeForge();
    fireEvent.keyDown(window, { key: 'Escape' });
    await s.untilClientFrames(2);
    expect(sent(s).at(-1)).toEqual(['selectButtonCancel']);
  });

  it('a pointercancel while a cast is parked and Forge is asking sends Forge’s Cancel', async () => {
    const { s } = await parkLikeForge();
    fireEvent.pointerCancel(window);
    await s.untilClientFrames(2);
    expect(sent(s).at(-1)).toEqual(['selectButtonCancel']);
  });

  it('a parked cast whose card the board no longer draws stays visible at the park point, and the arrow leaves from it', async () => {
    const { canvas, m, cast } = await parkLikeForge();
    const ghost = canvas.querySelector<HTMLElement>(`[data-cast-ghost="${cast}"]`);
    expect(ghost, 'a stand-in is drawn where the card was let go').not.toBeNull();
    expect(ghost!.getAttribute('data-cast-lift')).toBe('parked');
    expect(ghost!.style.left).toBe('500px');
    expect(ghost!.hasAttribute('data-board-card'), 'the stand-in is never mistaken for the card').toBe(false);

    const atRelease = await waitFor(() => overlayOf(canvas).querySelector<SVGElement>('[data-testid="targeter"]')!);
    expect(atRelease.dataset.source, 'the arrow is out from the release, before the pointer moves again').toBe(String(cast));

    const target = cardEl(canvas, theirsOf(m).battlefield[0]!.id);
    fireEvent.pointerMove(target, { clientX: 520, clientY: 60 });
    const arrow = await waitFor(() => overlayOf(canvas).querySelector<SVGElement>('[data-testid="targeter"]')!);
    expect(arrow.dataset.source).toBe(String(cast));
    expect(arrow.dataset.target).toBe(`card:${theirsOf(m).battlefield[0]!.id}`);
  });

  it('a parked cast that Forge finishes without ever asking a question clears on its own', async () => {
    const { s, m, canvas } = await gestureBoard();
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[2]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const theirBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="them"]')!;

    fireEvent.pointerDown(cardEl(canvas, hand[2]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(theirBattlefield, { clientX: 500, clientY: 50 });
    fireEvent.pointerUp(theirBattlefield, { clientX: 500, clientY: 50 });
    await s.untilClientFrames(1);
    expect(cardEl(canvas, hand[2]!).getAttribute('data-cast-lift')).toBe('parked');

    // Forge never opened a selection for this cast: it left the hand, resolved, and is in the graveyard.
    s.send(stateDelta({ [String((1 << 28) | 0)]: { _type: 1, _id: 0, Graveyard: { t: 'list', v: [{ t: 'int', v: hand[2]! }] } } }));
    s.send(handDelta(hand.filter((id) => id !== hand[2])));
    s.send(prompt('Priority'));
    await waitFor(() => expect(canvas.querySelector('[data-cast-lift]')).toBeNull());
    expect(canvas.querySelector('[data-cast-ghost]')).toBeNull();
  });

  it('an offered BATTLEFIELD card is never lifted — only a hand card is, lands tappable for mana included', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    // A battlefield permanent Forge offers (a land, for its mana ability, say)
    // must not be treated as a hand card to cast, whatever Forge offers it for.
    for (const f of notify([prompt('Priority'), actionable([mine[0]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());

    fireEvent.pointerDown(cardEl(canvas, mine[0]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(document.body, { clientX: 300, clientY: 300 });
    expect(cardEl(canvas, mine[0]!).getAttribute('data-cast-lift')).toBeNull();
    fireEvent.pointerUp(document.body, { clientX: 300, clientY: 300 });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames()).toHaveLength(0);
  });
});

/*
 * The operator, 2026-10-11, on Cabal Therapy: "it should be possible to pick up cards from the
 * graveyard if they have flashback. so i should be able to drag them and play them like a spell,
 * not have a target arrow drawn. the target arrow should come after the spell is played."
 */
describe('a card Forge offers from the graveyard is picked up like a hand card', () => {
  /** A card of the viewer's hand moved to their graveyard, and offered there at priority. */
  async function inGraveyard() {
    const board = await gestureBoard();
    const { s, m, canvas } = board;
    const hand = mineOf(m).hand!.map((c) => c.id);
    const card = hand[0]!;
    s.send(stateDelta({ [String((1 << 28) | 0)]: { _type: 1, _id: 0, Graveyard: { t: 'list', v: [{ t: 'int', v: card }] } } }));
    s.send(handDelta(hand.slice(1)));
    for (const f of notify([prompt('Priority'), actionable([card])])) s.send(f);
    await waitFor(() => expect(canvas.querySelector(`[data-zone="graveyard"][data-owner="you"] [data-board-card="${card}"]`)).not.toBeNull());
    await untilMatch(m, () => expect(m.weaklySelectable?.has(card)).toBe(true));
    const pile = canvas.querySelector<HTMLElement>('[data-zone="graveyard"][data-owner="you"]')!;
    const myBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;
    return { ...board, card, pile, myBattlefield };
  }

  it('the press lifts it, no arrow is drawn while it is carried, and the release over the table casts it', async () => {
    const { s, canvas, card, myBattlefield } = await inGraveyard();
    fireEvent.pointerDown(cardEl(canvas, card), { button: 0, clientX: 10, clientY: 10 });
    expect(cardEl(canvas, card).getAttribute('data-cast-lift')).toBe('lifted');
    fireEvent.pointerMove(myBattlefield, { clientX: 400, clientY: 300 });
    expect(cardEl(canvas, card).style.left, 'it follows the pointer').toBe('400px');
    expect(overlayOf(canvas).querySelector('[data-testid="targeter"]'), 'no arrow while it is carried').toBeNull();
    expect(s.clientFrames(), 'nothing sent while it is carried').toHaveLength(0);
    fireEvent.pointerUp(myBattlefield, { clientX: 400, clientY: 300 });
    await waitFor(() => expect(sent(s)).toEqual([['selectCard', card]]));
  });

  it('let go back over its graveyard, it goes home and nothing is sent', async () => {
    const { s, canvas, card, pile, myBattlefield } = await inGraveyard();
    fireEvent.pointerDown(cardEl(canvas, card), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(myBattlefield, { clientX: 400, clientY: 300 });
    expect(pile.hasAttribute('data-cancel-hint'), 'no cancel cue over the table').toBe(false);
    fireEvent.pointerMove(pile, { clientX: 20, clientY: 20 });
    expect(pile.hasAttribute('data-cancel-hint'), 'the cancel cue is on its own pile').toBe(true);
    fireEvent.pointerUp(pile, { clientX: 20, clientY: 20 });
    expect(pile.hasAttribute('data-cancel-hint')).toBe(false);
    await waitFor(() => expect(canvas.querySelector('[data-cast-lift]')).toBeNull(), { timeout: GLIDE_MS + 1000 });
    expect(s.clientFrames()).toHaveLength(0);
  });

  it('a selection that names the graveyard card is answered as before, never lifted', async () => {
    const { s, canvas, card } = await inGraveyard();
    s.send(selectables([card], 1, 1));
    await waitFor(() => expect(canvas.querySelector(`[data-board-card="${card}"][data-selectable]`)).not.toBeNull());
    fireEvent.pointerDown(cardEl(canvas, card), { button: 0, clientX: 10, clientY: 10 });
    expect(cardEl(canvas, card).getAttribute('data-cast-lift')).toBeNull();
    fireEvent.pointerUp(cardEl(canvas, card), { clientX: 10, clientY: 10 });
  });
});

/*
 * The operator, 2026-10-11: "Courser of Kruphix should have something where both people can see the
 * top card of the library at all times. and i should be able to click it if its a land."
 */
describe('the top card of the library, offered while the board draws it, is picked up like a hand card', () => {
  /** A card of the viewer's hand put on top of their library, its face known, and offered there at priority. */
  async function onLibrary() {
    const board = await gestureBoard();
    const { s, m, canvas } = board;
    const hand = mineOf(m).hand!.map((c) => c.id);
    const card = hand[0]!;
    s.send(stateDelta({ [String((1 << 28) | 0)]: { _type: 1, _id: 0, Library: { t: 'list', v: [{ t: 'int', v: card }] } } }));
    s.send(handDelta(hand.slice(1)));
    for (const f of notify([prompt('Priority'), actionable([card])])) s.send(f);
    await waitFor(() => expect(canvas.querySelector(`[data-zone="library"][data-owner="you"] [data-library-top][data-board-card="${card}"]`)).not.toBeNull());
    await untilMatch(m, () => expect(m.weaklySelectable?.has(card)).toBe(true));
    const myBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;
    return { ...board, card, myBattlefield };
  }

  it('a click lifts it and a click on the table plays it', async () => {
    const { s, canvas, card, myBattlefield } = await onLibrary();
    fireEvent.pointerDown(cardEl(canvas, card), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(cardEl(canvas, card), { button: 0, clientX: 10, clientY: 10 });
    expect(cardEl(canvas, card).getAttribute('data-cast-lift')).toBe('lifted');
    expect(s.clientFrames(), 'nothing sent while it is carried').toHaveLength(0);
    fireEvent.pointerMove(myBattlefield, { clientX: 400, clientY: 300 });
    fireEvent.pointerDown(myBattlefield, { button: 0, clientX: 400, clientY: 300 });
    fireEvent.pointerUp(myBattlefield, { button: 0, clientX: 400, clientY: 300 });
    await waitFor(() => expect(sent(s)).toEqual([['selectCard', card]]));
  });

  it('the next top card is drawn fresh under the avatar: nothing of the last one\'s lift stays on it', async () => {
    const { s, m, canvas, card } = await onLibrary();
    fireEvent.pointerDown(cardEl(canvas, card), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(cardEl(canvas, card), { button: 0, clientX: 10, clientY: 10 });
    expect(cardEl(canvas, card).getAttribute('data-cast-lift')).toBe('lifted');
    const rest = mineOf(m).hand!.map((c) => c.id);
    const next = rest[0]!;
    s.send(stateDelta({ [String((1 << 28) | 0)]: { _type: 1, _id: 0, Library: { t: 'list', v: [{ t: 'int', v: next }] } } }));
    s.send(handDelta(rest.slice(1)));
    await waitFor(() => expect(canvas.querySelector(`[data-zone="library"] [data-library-top][data-board-card="${next}"]`)).not.toBeNull());
    const fresh = cardEl(canvas, next);
    expect(fresh.getAttribute('style') ?? '', 'no inline position carried over').not.toMatch(/left|top|transform/);
    expect(fresh.hasAttribute('data-cast-lift')).toBe(false);
  });

  it('is never arranged, offered or not: it sits under the avatar, and a drag of it is only ever the play', async () => {
    const { s: server, canvas, card } = await onLibrary();
    expect(cardEl(canvas, card).hasAttribute('data-arrange-card')).toBe(false);
    for (const f of notify([prompt('Priority'), actionable([])])) server.send(f);
    await waitFor(() => expect(cardEl(canvas, card).hasAttribute('data-can-act')).toBe(false));
    expect(cardEl(canvas, card).hasAttribute('data-arrange-card')).toBe(false);
  });
});

/*
 * Forge can open a SELECTION that itself NAMES a hand card —
 * `InputSelectEntitiesFromList`'s "reveal a Faerie?", a discard-from-hand
 * choice, any `InputSelectEntitiesFromList`/`InputSelectTargets` over the
 * hand. `isHandCard` alone is not enough to claim that press for a lift: a
 * card Forge is asking the seat to CHOOSE is not one it is offering to CAST,
 * even sharing an id, and a selection or an open ask always outranks the
 * lift — the ordinary click/drag this layer already had before answers it
 * instead.
 */
/**
 * The operator, 2026-10-06, on a shockland and on Dark Confidant: the card
 * snapped back to the hand at the release and stayed there until Forge moved
 * it — through the "pay 2 life?" question, through the spell's time on the
 * stack — and the stack flashed a creature nobody responded to.
 */
/**
 * Holds every `GLIDE_MS` timer until `release`, so a test can look at the board mid-glide however
 * slowly the run goes. Any other timer runs as usual; a held one that is cleared never runs.
 */
function holdGlides(): { release(): void; restore(): void } {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const held = new Map<unknown, () => void>();
  const set = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((run: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms !== GLIDE_MS) return realSet(run, ms, ...args);
    const handle = realSet(() => undefined, 2 ** 30);
    held.set(handle, () => run(...args));
    return handle;
  }) as typeof setTimeout);
  const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle?: Parameters<typeof clearTimeout>[0]) => {
    held.delete(handle);
    realClear(handle);
  }) as typeof clearTimeout);
  const restore = (): void => {
    set.mockRestore();
    clear.mockRestore();
    for (const handle of held.keys()) realClear(handle as Parameters<typeof clearTimeout>[0]);
    held.clear();
  };
  return {
    release(): void {
      const due = [...held.values()];
      restore();
      for (const run of due) run();
    },
    restore,
  };
}

describe('a played card waits where it was let go until Forge has it on the battlefield', () => {
  const PLAYER_KEY = String((1 << 28) | 0);
  const ints = (ids: number[]) => ({ t: 'list', v: ids.map((id) => ({ t: 'int', v: id })) });
  /** The viewer's own zones as Forge now holds them. */
  const zones = (lists: Record<string, number[]>): ServerFrame =>
    stateDelta({ [PLAYER_KEY]: { _type: 1, _id: 0, ...Object.fromEntries(Object.entries(lists).map(([zone, ids]) => [zone, ints(ids)])) } });
  /** A spell on the stack, as a brand-new StackItem naming its card. */
  function stackItem(stackId: number, sourceCardId: number, ability = false): ServerFrame {
    seq += 1;
    return parseServerFrame({
      kind: 'notify',
      method: 'applyDelta',
      payload: {
        packet: {
          seq,
          checksum: 0,
          checksumProperties: [],
          newObjects: {
            [String((2 << 28) | stackId)]: { _type: 2, _id: stackId, SourceCard: { t: 'int', v: sourceCardId }, Ability: { t: 'bool', v: ability } },
          },
          objectDeltas: {},
          events: [],
        },
      },
    });
  }
  const stackIs = (stackIds: number[]): ServerFrame => stateDelta({ [GAME_KEY]: { _type: 3, _id: 1, Stack: ints(stackIds) } });
  const stackEl = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-zone="stack"]')!;

  /** Lift the first hand card and let it go over the viewer's own battlefield, at (400, 300). */
  async function play(motion?: () => boolean) {
    const board = await gestureBoard();
    const { s, m, canvas } = board;
    if (motion !== undefined) {
      gestures!.dispose();
      gestures = installGestures({ canvas, match: m, motion });
    }
    const hand = mineOf(m).hand!.map((c) => c.id);
    const battlefield = mineOf(m).battlefield.map((c) => c.id);
    const card = hand[0]!;
    for (const f of notify([prompt('Priority'), actionable([card]), okBar()])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const myBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;
    fireEvent.pointerDown(cardEl(canvas, card), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(myBattlefield, { clientX: 400, clientY: 300 });
    fireEvent.pointerUp(myBattlefield, { clientX: 400, clientY: 300 });
    await s.untilClientFrames(1);
    const rest = hand.filter((id) => id !== card);
    /** Forge moves it: out of the hand, onto the battlefield. */
    const arrive = () => s.send(zones({ Hand: rest, Battlefield: [...battlefield, card] }));
    return { ...board, card, rest, battlefield, myBattlefield, arrive };
  }
  const onMyBattlefield = (c: HTMLElement, id: number) =>
    c.querySelector<HTMLElement>(`[data-zone="battlefield"][data-owner="you"] [data-board-card="${id}"]`);

  it('the landing waits a frame and flies to the element the card KEEPS, even when Board re-keyed it after the frame arrived', async () => {
    // The operator, 2026-10-08 (Fast Mode off, a card let go at a column past the end): "it immediately
    // appears on the board". Board moves a placed card into its column in a layout effect after the
    // gesture's notify, and a card that becomes its own pile is a new element: the old one was hidden
    // and flown to, the new one painted at once.
    const { s, m, canvas, card, arrive } = await play(() => true);

    /*
     * `install.ts`'s own comment above `landingFrame = requestAnimationFrame(...)` is the guarantee
     * this test proves: "the next animation frame is after [Board's] commit" — true in a real browser,
     * where a layout effect always commits before the next paint. A TEST has no such ordering: a REAL
     * `requestAnimationFrame` (jsdom's own, timer-based) can fire during the `await waitFor` below, before
     * this test ever reaches `old.replaceWith(fresh)` — observed on CI, twice, under load. Holding every
     * rAF the window schedules between the arrival and the re-key, then flushing them BY HAND once the
     * re-key has actually happened, reproduces the real browser's ordering deterministically instead of
     * racing it.
     */
    let nextFrameId = 1;
    const heldFrames: { id: number; cb: FrameRequestCallback }[] = [];
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      const id = nextFrameId++;
      heldFrames.push({ id, cb });
      return id;
    });
    const cafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
      const at = heldFrames.findIndex((f) => f.id === id);
      if (at !== -1) heldFrames.splice(at, 1);
    });

    arrive();
    await waitFor(() => expect(onMyBattlefield(canvas, card)).not.toBeNull());
    const old = onMyBattlefield(canvas, card)!;
    expect(old.hasAttribute('data-cast-landing'), 'the first element is hidden from this very frame: never the card and its stand-in both').toBe(true);
    // Board's commit: the card is now a different element, somewhere else.
    const fresh = old.cloneNode(true) as HTMLElement;
    fresh.getBoundingClientRect = () => ({ left: 600, top: 500, right: 640, bottom: 556, width: 40, height: 56, x: 600, y: 500, toJSON: () => ({}) }) as DOMRect;
    old.replaceWith(fresh);

    rafSpy.mockRestore();
    cafSpy.mockRestore();
    // The frame(s) held since `arrive()` — `install.ts`'s own `landingFrame` among them — run now,
    // in the order they were requested, against the ALREADY re-keyed DOM.
    for (const { cb } of heldFrames.splice(0)) cb(performance.now());

    expect(fresh.hasAttribute('data-cast-landing'), 'the element the card keeps is the one hidden for the flight').toBe(true);
    expect(old.hasAttribute('data-cast-landing'), 'and the one React dropped is let go').toBe(false);
    const ghost = canvas.querySelector<HTMLElement>(`[data-cast-ghost="${card}"]`)!;
    expect(ghost.getAttribute('data-cast-lift')).toBe('returning');
    expect([ghost.style.left, ghost.style.top], 'and the flight ends at ITS centre').toEqual(['620px', '528px']);
    void s; void m;
  });

  it('a click-armed lift resolved by a press ON a battlefield card plays the hand card only: the click that follows is the release’s, not the card’s', async () => {
    // table-fit 2026-10-07: with free placement (Z8) the first land put down at the row's centre stays there, so the next
    // release lands on its pile — and the click after that press selected the pile's land too, a second select while
    // Forge was mid-getAbilityToPlay for the first. Lands stopped landing from the third one on.
    const { s, m, canvas } = await gestureBoard();
    const hand = mineOf(m).hand!.map((c) => c.id);
    const land = mineOf(m).battlefield[0]!.id;
    const card = hand[0]!;
    for (const f of notify([prompt('Priority'), actionable([card, land]), okBar()])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    // The hand card is clicked, not dragged: lifted, following the pointer, resolved by the next press.
    fireEvent.pointerDown(cardEl(canvas, card), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(cardEl(canvas, card), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.click(cardEl(canvas, card).querySelector('button') ?? cardEl(canvas, card));
    expect(cardEl(canvas, card).getAttribute('data-cast-lift')).toBe('lifted');
    // The press that resolves it is on the pile's land, and a click follows it as a click follows any press.
    const pile = onMyBattlefield(canvas, land)!;
    fireEvent.pointerDown(pile, { button: 0, clientX: 400, clientY: 300 });
    fireEvent.pointerUp(pile, { button: 0, clientX: 400, clientY: 300 });
    fireEvent.click(pile.querySelector('button') ?? pile);
    await s.untilClientFrames(1);
    expect(sent(s), 'the hand card went out, the land under the release did not').toEqual([['selectCard', card]]);
  });

  it('a land Forge asks a question about stays parked for the whole question, and lands when it is answered', async () => {
    const { s, m, canvas, card, arrive } = await play();
    // The shockland's "pay 2 life?": an ask, with the card still in the hand.
    s.send(parseServerFrame({ kind: 'ask', callId: 's0-1', method: 'showConfirmDialog', message: 'Pay 2 life?', title: 'Steam Vents', yesButtonText: 'Yes', noButtonText: 'No', defaultYes: true }));
    await untilMatch(m, () => expect(m.asks).toHaveLength(1));
    const standIn = canvas.querySelector<HTMLElement>(`[data-cast-ghost="${card}"]`)!;
    expect(standIn.getAttribute('data-cast-lift'), 'over the board, not back in the hand, while the question is up').toBe('parked');
    expect(standIn.style.left).toBe('400px');
    expect(cardEl(canvas, card).getAttribute('data-cast-lift'), 'the hand’s own element is out of its row and not drawn').toBe('carried');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(standIn.isConnected, 'there is nothing to cancel: it stays').toBe(true);
    expect(cardEl(canvas, card).getAttribute('data-cast-lift')).toBe('carried');
    expect(sent(s), 'and nothing more went out').toEqual([['selectCard', card]]);

    arrive();
    await waitFor(() => expect(onMyBattlefield(canvas, card)).not.toBeNull());
    await waitFor(() => expect(canvas.querySelector('[data-cast-lift]')).toBeNull());
    expect(canvas.querySelector('[data-cast-ghost]')).toBeNull();
    expect(onMyBattlefield(canvas, card)!.hasAttribute('data-cast-landing'), 'no motion asked for: it is simply there').toBe(false);
  });

  it('with motion on, its stand-in travels from the park point and the row’s own card shows when it gets there', async () => {
    const { canvas, card, arrive } = await play(() => true);
    arrive();
    const arrived = await waitFor(() => {
      const el = onMyBattlefield(canvas, card);
      expect(el?.hasAttribute('data-cast-landing')).toBe(true);
      return el!;
    });
    // The flight starts one frame after the arrival, past Board's placement commit.
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    const ghost = canvas.querySelector<HTMLElement>(`[data-cast-ghost="${card}"]`)!;
    expect(ghost, 'the stand-in is what moves').not.toBeNull();
    expect(ghost.getAttribute('data-cast-lift')).toBe('returning');
    expect(arrived.hasAttribute('data-cast-lift'), 'the card in the row is never lifted out of it').toBe(false);
    await waitFor(() => expect(canvas.querySelector('[data-cast-ghost]')).toBeNull(), { timeout: GLIDE_MS + 1000 });
    expect(arrived.hasAttribute('data-cast-landing')).toBe(false);
  });

  it('with motion on, a creature put on the stack while its stand-in glides into the gap is handed over where the stand-in comes to rest', async () => {
    // Lane U's caster telemetry (w67-shaman): handed over mid-glide, the stack card was drawn 2–4 px
    // from where the stand-in stood.
    // The row's reserved gap, which this board draws no layout for.
    const spy = vi
      .spyOn(CastModule, 'expectedGapBox')
      .mockReturnValue({ left: 500, top: 280, width: 60, height: 84, right: 560, bottom: 364, x: 500, y: 280, toJSON: () => ({}) } as DOMRect);
    // The glide ends when the test says so: on a loaded runner the steps below took longer than its 300 ms.
    const glides = holdGlides();
    try {
      const { s, m, canvas, card, rest, battlefield } = await play(() => true);
      const ghost = await waitFor(() => {
        const g = canvas.querySelector<HTMLElement>(`[data-cast-ghost="${card}"]`)!;
        expect(g.style.left, 'gliding into the gap').toBe('530px');
        return g;
      });
      s.send(zones({ Hand: rest, Battlefield: battlefield }));
      s.send(stackItem(9101, card));
      s.send(stackIs([9101]));
      await untilMatch(m, () => expect(m.view!.stack).toHaveLength(1));
      const placed = await waitFor(() => canvas.querySelector<HTMLElement>('[data-placed-spell="9101"]')!);
      expect(placed.style.left, 'drawn where the stand-in comes to rest').toBe('530px');
      expect(placed.hasAttribute('data-placed-pending'), 'but hidden while the stand-in is still on its way').toBe(true);
      expect(ghost.isConnected, 'the stand-in is what is drawn meanwhile').toBe(true);
      glides.release();
      await waitFor(() => expect(ghost.isConnected).toBe(false), { timeout: GLIDE_MS + 1000 });
      expect(placed.hasAttribute('data-placed-pending'), 'shown the moment the stand-in goes').toBe(false);
    } finally {
      glides.restore();
      spy.mockRestore();
    }
  });

  it('§S: once the spell is really on the stack, live/placed.ts draws it at the park point and the ghost hands off to it', async () => {
    const { s, m, canvas, card, rest, battlefield, arrive } = await play();
    s.send(zones({ Hand: rest, Battlefield: battlefield }));
    s.send(stackItem(9101, card));
    s.send(stackIs([9101]));
    await untilMatch(m, () => expect(m.view!.stack).toHaveLength(1));
    expect(stackEl(canvas).getAttribute('data-count'), 'Forge has one thing on the stack').toBe('1');
    expect(stackEl(canvas).getAttribute('data-carried'), 'the bookkeeping is unchanged, even though placed.ts now draws it too').toBe('1');
    // The handoff: the ghost retires the moment a matching stack item exists
    // (`gestures/install.ts`'s `syncParkedGhost`) — never both at once, pixel
    // for pixel — and `live/placed.ts` draws the SAME point from here.
    await waitFor(() => expect(canvas.querySelector(`[data-cast-ghost="${card}"]`)).toBeNull());
    const placed = await waitFor(() => canvas.querySelector<HTMLElement>('[data-placed-spell="9101"]')!);
    expect(placed.style.left, 'the card is still where it was let go').toBe('400px');
    expect(placed.hasAttribute('data-mine')).toBe(true);

    s.send(stackIs([]));
    arrive();
    await waitFor(() => expect(onMyBattlefield(canvas, card)).not.toBeNull());
    await waitFor(() => expect(canvas.querySelector('[data-placed-spell]')).toBeNull());
    expect(stackEl(canvas).getAttribute('data-count')).toBe('0');
  });

  it('a spell alone on the stack stays drawn at its park point however long the opponent takes, and through a question', async () => {
    const { s, m, canvas, card, rest, battlefield } = await play();
    s.send(zones({ Hand: rest, Battlefield: battlefield }));
    s.send(stackItem(9101, card));
    s.send(stackIs([9101]));
    await untilMatch(m, () => expect(m.view!.stack).toHaveLength(1));
    await waitFor(() => expect(canvas.querySelector('[data-placed-spell="9101"]')).not.toBeNull());
    expect(stackEl(canvas).getAttribute('data-carried'), 'the stack says a played card is also standing in for it').toBe('1');
    // The opponent holds priority a long while, then Forge asks this seat something about the resolving spell.
    await new Promise((r) => setTimeout(r, 2500));
    for (const f of notify([prompt('Choose a creature'), selectables([battlefield[0]!], 1, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    const placed = canvas.querySelector<HTMLElement>('[data-placed-spell="9101"]')!;
    expect(placed, 'still drawn, still at the park point').not.toBeNull();
    expect(placed.style.left).toBe('400px');
    expect(stackEl(canvas).getAttribute('data-carried')).toBe('1');
    expect(canvas.querySelector(`[data-cast-ghost="${card}"]`), 'the ghost stays retired').toBeNull();
  }, 15_000);

  it('a second thing on the stack: both are drawn, each at its own point', async () => {
    const { s, m, canvas, card, rest, battlefield } = await play();
    s.send(zones({ Hand: rest, Battlefield: battlefield }));
    s.send(stackItem(9101, card));
    s.send(stackIs([9101]));
    await untilMatch(m, () => expect(m.view!.stack).toHaveLength(1));
    await waitFor(() => expect(canvas.querySelector('[data-placed-spell="9101"]')).not.toBeNull());
    // Its own cast trigger, above it.
    s.send(stackItem(9102, card, true));
    s.send(stackIs([9102, 9101]));
    await waitFor(() => expect(canvas.querySelectorAll('[data-placed-spell]')).toHaveLength(2));
  });

  it('W17 — its cast trigger asks for a target: the spell is still the card where it was let go, and the arrow leaves from there', async () => {
    const { s, m, canvas, card, rest, battlefield } = await play();
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    s.send(zones({ Hand: rest, Battlefield: battlefield }));
    s.send(stackItem(9101, card));
    s.send(stackIs([9101]));
    await untilMatch(m, () => expect(m.view!.stack).toHaveLength(1));
    const placed = await waitFor(() => canvas.querySelector<HTMLElement>('[data-placed-spell="9101"]')!);
    boxAt(placed, 370, 270, 60, 60); // centre (400, 300) — jsdom has no layout otherwise.
    for (const f of notify([prompt('Choose a target'), selectables([theirs[0]!], 1, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    // The played card, waiting at its park point, is the spell — `live/placed.ts`'s own element now, not the ghost.
    expect(canvas.querySelector(`[data-cast-ghost="${card}"]`)).toBeNull();
    fireEvent.pointerMove(cardEl(canvas, theirs[0]!), { clientX: 220, clientY: 180 });
    const arrow = await waitFor(() => overlayOf(canvas).querySelector<SVGElement>('[data-testid="targeter"]')!);
    expect(arrow.dataset.source).toBe(String(card));
    expect(arrow.querySelector('path')!.getAttribute('d'), 'from where the card was let go').toMatch(/^M 400 300 Q /);

    // Its trigger joins it on the stack: both are drawn now.
    s.send(stackItem(9102, card, true));
    s.send(stackIs([9102, 9101]));
    await waitFor(() => expect(canvas.querySelectorAll('[data-placed-spell]')).toHaveLength(2));
  });

  it('AD3: once parked, the card stays at the park point however much the pointer moves — only the aim arrow follows it', async () => {
    const { s, m, canvas, card, rest, battlefield } = await play();
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    s.send(zones({ Hand: rest, Battlefield: battlefield }));
    s.send(stackItem(9101, card));
    s.send(stackIs([9101]));
    await untilMatch(m, () => expect(m.view!.stack).toHaveLength(1));
    const placed = await waitFor(() => canvas.querySelector<HTMLElement>('[data-placed-spell="9101"]')!);
    boxAt(placed, 370, 270, 60, 60); // centre (400, 300)
    for (const f of notify([prompt('Choose a target'), selectables([theirs[0]!], 1, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());

    for (const [x, y] of [
      [220, 180],
      [600, 50],
      [900, 700],
    ]) {
      fireEvent.pointerMove(canvas, { clientX: x, clientY: y });
      expect(placed.style.left, 'the card never follows the pointer').toBe('400px');
      expect(placed.style.top).toBe('300px');
      const arrow = await waitFor(() => overlayOf(canvas).querySelector<SVGElement>('[data-testid="targeter"]')!);
      expect(arrow.querySelector('path')!.getAttribute('d'), 'the arrow tip is the one thing that follows').toMatch(new RegExp(`${x} ${y}$`));
    }
  });

  it('item 5: a press on the viewer’s own placed spell moves it, and tells lane W (moveSpell/onSpellMoved)', async () => {
    const { s, m, canvas, card, rest, battlefield } = await play();
    s.send(zones({ Hand: rest, Battlefield: battlefield }));
    s.send(stackItem(9101, card));
    s.send(stackIs([9101]));
    await untilMatch(m, () => expect(m.view!.stack).toHaveLength(1));
    const placed = await waitFor(() => canvas.querySelector<HTMLElement>('[data-placed-spell="9101"]')!);
    expect(placed.hasAttribute('data-mine'), 'the viewer’s own spell — only these are draggable').toBe(true);
    const moved: Array<[number, { x: number; y: number }]> = [];
    const unsub = onSpellMoved((id, at) => moved.push([id, at]));
    const before = sent(s).length; // the park itself already sent its own selectCard — the drag must send nothing MORE
    try {
      fireEvent.pointerDown(placed, { button: 0, clientX: 400, clientY: 300 });
      fireEvent.pointerMove(window, { clientX: 500, clientY: 350 }); // past DRAG_SLOP_PX
      expect(placed.style.left, 'moved live, mid-drag').toBe('500px');
      expect(placed.style.top).toBe('350px');
      fireEvent.pointerUp(window, { clientX: 520, clientY: 360 });
      expect(placed.style.left, 'settles at the release point').toBe('520px');
      expect(placed.style.top).toBe('360px');
      expect(sent(s).length, 'no cast, no target — nothing new reaches Forge').toBe(before);
      expect(moved.some(([id]) => id === 9101), 'lane W hears every move, by the stack item’s own id').toBe(true);
    } finally {
      unsub();
    }
  });

  it('a creature that is countered just lets go: no landing, nothing left over the board', async () => {
    const { s, m, canvas, card, rest, battlefield } = await play(() => true);
    s.send(zones({ Hand: rest, Battlefield: battlefield }));
    s.send(stackItem(9101, card));
    s.send(stackIs([9101]));
    await untilMatch(m, () => expect(m.view!.stack).toHaveLength(1));
    s.send(stackIs([]));
    s.send(zones({ Graveyard: [card] }));
    await waitFor(() => expect(canvas.querySelector('[data-cast-ghost]')).toBeNull());
    expect(canvas.querySelector('[data-cast-lift]')).toBeNull();
    expect(canvas.querySelector('[data-cast-landing]')).toBeNull();
  });

  it('a play Forge never answers floats back to the hand after PARK_UNANSWERED_MS', async () => {
    const { s, canvas, card } = await play();
    const standIn = canvas.querySelector<HTMLElement>(`[data-cast-ghost="${card}"]`)!;
    expect(standIn.getAttribute('data-cast-lift')).toBe('parked');
    await waitFor(() => expect(standIn.getAttribute('data-cast-lift')).toBe('returning'), { timeout: PARK_UNANSWERED_MS + 2000 });
    await waitFor(() => expect(canvas.querySelector('[data-cast-lift]')).toBeNull(), { timeout: GLIDE_MS + 1000 });
    expect(canvas.querySelector('[data-cast-ghost]'), 'and the stand-in goes with it').toBeNull();
    expect(sent(s), 'nothing was sent to undo it').toEqual([['selectCard', card]]);
  }, 20_000);

  /*
   * CI run 37539089085 (2026-10-06): a land Forge never played was still parked
   * when the cleanup discard opened, and stayed hidden in the hand with the
   * discard unable to click it. The discard offers the card itself: it goes home
   * to be chosen.
   */
  it('a play Forge never answers goes home when a decision offers the card itself', async () => {
    const { s, m, canvas, card, rest } = await play();
    const standIn = canvas.querySelector<HTMLElement>(`[data-cast-ghost="${card}"]`)!;
    expect(standIn.getAttribute('data-cast-lift')).toBe('parked');
    expect(cardEl(canvas, card).getAttribute('data-cast-lift'), 'the hand element is carried (hidden) while it waits').toBe('carried');
    // The cleanup discard: a selection over the whole hand, the parked card among it. Not about the play.
    s.send(prompt('Cleanup Phase\nSelect 1 card(s) to discard to bring your hand down to the maximum of 7 cards.'));
    s.send(selectables([card, ...rest], 1, 1));
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    await waitFor(() => expect(standIn.getAttribute('data-cast-lift')).toBe('returning'), { timeout: PARK_UNANSWERED_MS + 2000 });
    await waitFor(() => expect(canvas.querySelector('[data-cast-lift]'), 'the hand card is its own again').toBeNull(), { timeout: GLIDE_MS + 1000 });
    expect(sent(s), 'nothing was sent to undo it').toEqual([['selectCard', card]]);
  }, 20_000);

  it('a play Forge took and gave back, then offered in a selection, goes home at once', async () => {
    // table-fit 2026-10-07: the hidden land sat in the hand through the cleanup discard; the 4-second
    // give-up returned early on "it left the hand once" and never looked again — and the discard, which
    // offered the card itself, is Forge saying the play is over, so there is no clock to wait on at all.
    const { s, m, canvas, card, rest, battlefield } = await play();
    const standIn = canvas.querySelector<HTMLElement>(`[data-cast-ghost="${card}"]`)!;
    // Forge moves it out of the hand (not yet on the battlefield)…
    s.send(zones({ Hand: rest, Battlefield: battlefield }));
    await untilMatch(m, () => expect(mineOf(m).hand!.some((c) => c.id === card)).toBe(false));
    // …the cleanup discard opens…
    s.send(prompt('Cleanup Phase\nSelect 1 card(s) to discard to bring your hand down to the maximum of 7 cards.'));
    s.send(selectables([card, ...rest], 1, 1));
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    // …and the card is back in the hand, offered for the discard, with the selection still open.
    s.send(zones({ Hand: [card, ...rest], Battlefield: battlefield }));
    await untilMatch(m, () => expect(mineOf(m).hand!.some((c) => c.id === card)).toBe(true));
    await waitFor(() => expect(standIn.getAttribute('data-cast-lift')).toBe('returning'), { timeout: 1500 });
    await waitFor(() => expect(canvas.querySelector('[data-cast-lift]'), 'the hand card is its own again').toBeNull(), { timeout: GLIDE_MS + 1000 });
  }, 20_000);

  it('a play Forge IS asking about keeps waiting past PARK_UNANSWERED_MS', async () => {
    const { s, m, canvas, card } = await play();
    const standIn = canvas.querySelector<HTMLElement>(`[data-cast-ghost="${card}"]`)!;
    // Forge's question names the card: its own getAbilityToPlay, as every land click gets.
    s.send(
      parseServerFrame({
        kind: 'ask',
        callId: 's0-9',
        method: 'getAbilityToPlay',
        hostCard: { kind: 'card', id: card },
        abilities: [{ kind: 'spellAbility', id: 7, label: 'Play land' }],
        triggerEvent: null,
      }),
    );
    await untilMatch(m, () => expect(m.asks).toHaveLength(1));
    await new Promise((r) => setTimeout(r, PARK_UNANSWERED_MS + 500));
    expect(standIn.getAttribute('data-cast-lift'), 'still parked').toBe('parked');
  }, 20_000);

  it('a modal spell keeps waiting past PARK_UNANSWERED_MS while its modes are chosen, the card still in the hand', async () => {
    // The operator on Cryptic Command, 2026-10-11: "it seems to go back to hand after doing the first selection".
    const { s, m, canvas, card } = await play();
    const standIn = canvas.querySelector<HTMLElement>(`[data-cast-ghost="${card}"]`)!;
    s.send(
      parseServerFrame({
        kind: 'ask',
        callId: 's0-65',
        method: 'getChoices',
        message: 'Alice activated Cryptic Command - Choose a mode',
        min: 2,
        max: 2,
        choices: [
          { key: 'c0', label: 'Counter target spell.', ref: { kind: 'spellAbility', id: 741 } },
          { key: 'c1', label: 'Draw a card.', ref: { kind: 'spellAbility', id: 744 } },
          { key: 'c2', label: 'Tap all creatures your opponents control.', ref: { kind: 'spellAbility', id: 743 } },
        ],
        selected: [],
        modes: { min: 2, max: 2, card: { kind: 'card', id: card } },
      }),
    );
    await untilMatch(m, () => expect(m.asks).toHaveLength(1));
    await new Promise((r) => setTimeout(r, PARK_UNANSWERED_MS + 500));
    expect(standIn.getAttribute('data-cast-lift'), 'still parked').toBe('parked');
  }, 20_000);

  /*
   * The operator, 2026-10-15: Cavern of Souls floated home under its own creature-type question, a
   * `getChoices` over plain words that names no card ("As Cavern of Souls enters, choose a creature
   * type" — a replacement, asked while the land is still in the hand). "Cards should never time out
   * and return to hand while decisions like this are on the screen."
   */
  it('a play keeps waiting past PARK_UNANSWERED_MS while any question is open, even one that names no card', async () => {
    const { s, m, canvas, card } = await play();
    const standIn = canvas.querySelector<HTMLElement>(`[data-cast-ghost="${card}"]`)!;
    s.send(
      parseServerFrame({
        kind: 'ask',
        callId: 's0-36',
        method: 'getChoices',
        message: 'Choose a creature type',
        min: 1,
        max: 1,
        choices: [
          { key: 'c0', label: 'Goblin', ref: null },
          { key: 'c1', label: 'Human', ref: null },
        ],
        selected: [],
      }),
    );
    await untilMatch(m, () => expect(m.asks).toHaveLength(1));
    await new Promise((r) => setTimeout(r, PARK_UNANSWERED_MS * 2 + 500));
    expect(standIn.getAttribute('data-cast-lift'), 'still parked').toBe('parked');
    expect(cardEl(canvas, card).getAttribute('data-cast-lift'), 'and not drawn in the hand').toBe('carried');
  }, 20_000);

  it('a play keeps waiting past PARK_UNANSWERED_MS while a selection that does not offer it is open', async () => {
    const { s, m, canvas, card, rest } = await play();
    const standIn = canvas.querySelector<HTMLElement>(`[data-cast-ghost="${card}"]`)!;
    s.send(prompt('Select a card to put on top of your library'));
    s.send(selectables(rest, 1, 1));
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    await new Promise((r) => setTimeout(r, PARK_UNANSWERED_MS + 500));
    expect(standIn.getAttribute('data-cast-lift'), 'still parked').toBe('parked');
  }, 20_000);

  it('a play goes home at once when an open question offers the card itself as an answer', async () => {
    const { s, m, canvas, card } = await play();
    const standIn = canvas.querySelector<HTMLElement>(`[data-cast-ghost="${card}"]`)!;
    s.send(
      parseServerFrame({
        kind: 'ask',
        callId: 's0-40',
        method: 'getChoices',
        message: 'Choose a card to discard',
        min: 1,
        max: 1,
        choices: [{ key: 'c0', label: 'Forest', ref: { kind: 'card', id: card } }],
        selected: [],
      }),
    );
    await untilMatch(m, () => expect(m.asks).toHaveLength(1));
    await waitFor(() => expect(standIn.getAttribute('data-cast-lift')).toBe('returning'), { timeout: 1500 });
    await waitFor(() => expect(canvas.querySelector('[data-cast-lift]'), 'the hand card is its own again').toBeNull(), { timeout: GLIDE_MS + 1000 });
  }, 20_000);

  it('a card Forge stopped offering between the lift and the release is not sent, and floats back', async () => {
    const { s, m, canvas } = await gestureBoard();
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[0]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const myBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;
    fireEvent.pointerDown(cardEl(canvas, hand[0]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(myBattlefield, { clientX: 400, clientY: 300 });
    s.send(actionable([]));
    await untilMatch(m, () => expect(m.weaklySelectable?.size ?? 0).toBe(0));
    fireEvent.pointerUp(myBattlefield, { clientX: 400, clientY: 300 });
    expect(cardEl(canvas, hand[0]!).getAttribute('data-cast-lift')).toBe('returning');
    expect(s.clientFrames()).toHaveLength(0);
  });
});

describe('a hand card named by an open selection or ask is an ordinary click, never lifted', () => {
  it('a selection naming a hand card: no lift, and a plain click sends selectCard at once', async () => {
    const { s, m, canvas } = await gestureBoard();
    const hand = mineOf(m).hand!.map((c) => c.id);
    // The selection names the hand card directly, not Forge's priority-time actionable set.
    for (const f of notify([prompt('Reveal a Faerie?'), selectables([hand[0]!], 0, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());

    const face = cardEl(canvas, hand[0]!).querySelector<HTMLButtonElement>('button')!;
    fireEvent.pointerDown(face, { button: 0, clientX: 10, clientY: 10 });
    expect(cardEl(canvas, hand[0]!).getAttribute('data-cast-lift'), 'no lift while a selection is open').toBeNull();
    fireEvent.pointerUp(face, { clientX: 10, clientY: 10 });
    // Not suppressed this time — this press was never claimed as a lift.
    expect(fireEvent.click(face), 'the native click reaches Board, unclaimed').toBe(true);
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', hand[0]!]]);
    expect(cardEl(canvas, hand[0]!).getAttribute('data-cast-lift')).toBeNull();
  });

  it('a selection naming a hand card: a drag still works the pre-wave way — commitDrag on release, no lift/arrow', async () => {
    const { s, m, canvas } = await gestureBoard();
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Reveal a Faerie?'), selectables([hand[0]!], 0, 1)])) s.send(f);
    await untilMatch(m, () => expect(m.selectables).not.toBeNull());
    const myBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;

    fireEvent.pointerDown(cardEl(canvas, hand[0]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(myBattlefield, { clientX: 400, clientY: 300 });
    expect(cardEl(canvas, hand[0]!).getAttribute('data-cast-lift'), 'never lifted — this was never a cast').toBeNull();
    expect(s.clientFrames(), 'the ordinary drag sends nothing until release').toHaveLength(0);
    fireEvent.pointerUp(myBattlefield, { clientX: 400, clientY: 300 });
    await s.untilClientFrames(1);
    expect(sent(s)).toEqual([['selectCard', hand[0]!]]);
  });

  it('an open ASK naming nothing offered: a hand card otherwise actionable still does not lift', async () => {
    const { s, m, canvas } = await gestureBoard();
    const hand = mineOf(m).hand!.map((c) => c.id);
    // The actionable set alone would make this card castable — but an open
    // ask empties `boardInteraction`'s whole offer first, so the card is not
    // even "under" the press.
    const dialogAsk = parseServerFrame({
      kind: 'ask',
      callId: 'c-ask',
      method: 'showOptionDialog',
      message: 'Choose one',
      title: 'Choose',
      icon: null,
      options: ['A', 'B'],
      defaultOption: 0,
    });
    for (const f of notify([prompt('Priority'), actionable([hand[0]!]), dialogAsk])) s.send(f);
    await untilMatch(m, () => expect(m.asks).toHaveLength(1));

    fireEvent.pointerDown(cardEl(canvas, hand[0]!), { button: 0, clientX: 10, clientY: 10 });
    expect(cardEl(canvas, hand[0]!).getAttribute('data-cast-lift'), 'an open ask outranks the actionable set').toBeNull();
    fireEvent.pointerUp(cardEl(canvas, hand[0]!), { clientX: 10, clientY: 10 });
    await new Promise((r) => setTimeout(r, 30));
    expect(s.clientFrames(), 'nothing sent — this press claimed no gesture of ours').toHaveLength(0);
  });

  it('no selection, no ask, the card IS in the actionable set: lifts exactly as before', async () => {
    const { s, m, canvas } = await gestureBoard();
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[0]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());

    fireEvent.pointerDown(cardEl(canvas, hand[0]!), { button: 0, clientX: 10, clientY: 10 });
    expect(cardEl(canvas, hand[0]!).getAttribute('data-cast-lift')).toBe('lifted');
  });
});

/*
 * `selectCard` alone never told `Board` WHERE the player put a card, so a
 * newly-arrived permanent always appended to the end of its row.
 * `Board.tsx` exports `notePlayedTo`/`previewPlayedTo` for exactly this; these
 * cases are about THIS lane's half of the contract — that the seam is called
 * at the right moments with the right arguments — never about `Board`'s own
 * hit-testing geometry, which is its own suite's job (`Board.test.ts`).
 */
describe('a cast tells Board where it landed, through the seam Board provides', () => {
  it('calls notePlayedTo exactly once, at the release, with the release’s own point', async () => {
    const { s, m, canvas } = await gestureBoard();
    const noteSpy = vi.spyOn(BoardModule, 'notePlayedTo');
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[0]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const myBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;

    fireEvent.pointerDown(cardEl(canvas, hand[0]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(myBattlefield, { clientX: 400, clientY: 300 });
    expect(noteSpy, 'still lifted — nothing sent yet').not.toHaveBeenCalled();
    fireEvent.pointerMove(myBattlefield, { clientX: 650, clientY: 500 });
    fireEvent.pointerUp(myBattlefield, { clientX: 700, clientY: 520 });
    expect(noteSpy).toHaveBeenCalledTimes(1);
    expect(noteSpy).toHaveBeenCalledWith(hand[0], { x: 700, y: 520 });
  });

  it('previewPlayedTo tracks the pointer for a no-target card over the viewer’s own battlefield, and goes null off it', async () => {
    const { s, m, canvas } = await gestureBoard();
    const previewSpy = vi.spyOn(BoardModule, 'previewPlayedTo');
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[0]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const myBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;
    const myHand = canvas.querySelector<HTMLElement>('[data-zone="hand"][data-owner="you"]')!;

    fireEvent.pointerDown(cardEl(canvas, hand[0]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(myHand, { clientX: 60, clientY: 714 });
    expect(previewSpy).toHaveBeenLastCalledWith(null);
    fireEvent.pointerMove(myBattlefield, { clientX: 400, clientY: 300 });
    await frame();
    expect(previewSpy).toHaveBeenLastCalledWith({ x: 400, y: 300 });
    fireEvent.pointerMove(myBattlefield, { clientX: 450, clientY: 320 });
    await frame();
    expect(previewSpy).toHaveBeenLastCalledWith({ x: 450, y: 320 });
    fireEvent.pointerUp(myBattlefield, { clientX: 450, clientY: 320 });
    expect(previewSpy).toHaveBeenLastCalledWith(null);
  });

  it('the preview runs once per frame, with the last point — not once per pointer move', async () => {
    // The operator, 2026-10-07: the lifted card "gets stuck" the moment it crosses onto the battlefield.
    // previewPlayedTo measures every slot and pile; per move it forced a layout per move.
    const { s, m, canvas } = await gestureBoard();
    const previewSpy = vi.spyOn(BoardModule, 'previewPlayedTo');
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[0]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const myBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;
    fireEvent.pointerDown(cardEl(canvas, hand[0]!), { button: 0, clientX: 10, clientY: 10 });
    previewSpy.mockClear();
    for (let i = 0; i < 20; i++) fireEvent.pointerMove(myBattlefield, { clientX: 300 + i * 5, clientY: 300 });
    expect(previewSpy, 'nothing measured inside the moves themselves').not.toHaveBeenCalled();
    await frame();
    expect(previewSpy).toHaveBeenCalledTimes(1);
    expect(previewSpy).toHaveBeenLastCalledWith({ x: 395, y: 300 });
    fireEvent.pointerUp(myBattlefield, { clientX: 395, clientY: 300 });
    expect(previewSpy, 'the lift ending clears it at once').toHaveBeenLastCalledWith(null);
  });

  it('previewPlayedTo is never called for a card that needs a target — it never lands in a row', async () => {
    const { s, m, canvas } = await gestureBoard();
    const previewSpy = vi.spyOn(BoardModule, 'previewPlayedTo');
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[2]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const myBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;

    fireEvent.pointerDown(cardEl(canvas, hand[2]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(myBattlefield, { clientX: 400, clientY: 300 });
    await frame();
    expect(previewSpy).not.toHaveBeenCalledWith({ x: 400, y: 300 });
  });

  it('previewPlayedTo is cleared on Escape, same as the lift itself', async () => {
    const { s, m, canvas } = await gestureBoard();
    const previewSpy = vi.spyOn(BoardModule, 'previewPlayedTo');
    const hand = mineOf(m).hand!.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([hand[0]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const myBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;

    fireEvent.pointerDown(cardEl(canvas, hand[0]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(myBattlefield, { clientX: 400, clientY: 300 });
    await frame();
    expect(previewSpy).toHaveBeenLastCalledWith({ x: 400, y: 300 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(previewSpy).toHaveBeenLastCalledWith(null);
    fireEvent.pointerUp(myBattlefield, { clientX: 400, clientY: 300 });
  });

  it('neither function is ever called for a BATTLEFIELD card (a land tapped for mana, say)', async () => {
    const { s, m, canvas } = await gestureBoard();
    const noteSpy = vi.spyOn(BoardModule, 'notePlayedTo');
    const previewSpy = vi.spyOn(BoardModule, 'previewPlayedTo');
    const mine = mineOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([mine[0]!])])) s.send(f);
    await untilMatch(m, () => expect(m.weaklySelectable).not.toBeNull());
    const myBattlefield = canvas.querySelector<HTMLElement>('[data-zone="battlefield"][data-owner="you"]')!;

    fireEvent.pointerDown(cardEl(canvas, mine[0]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(myBattlefield, { clientX: 400, clientY: 300 });
    fireEvent.pointerUp(myBattlefield, { clientX: 400, clientY: 300 });
    expect(noteSpy).not.toHaveBeenCalled();
    expect(previewSpy).not.toHaveBeenCalled();
  });
});
