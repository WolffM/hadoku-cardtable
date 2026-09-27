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

import { afterEach, describe, expect, it } from 'vitest';
import { createElement, useSyncExternalStore } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { parseServerFrame, type ServerFrame } from '@hadoku/forge-wire';

import { Board } from '../../Board.tsx';
import {
  boardInteraction,
  closeMatch,
  selectCard,
  selectPlayer,
  socketIoMatchTransport,
  startMatch,
  subscribe,
  type LiveMatch,
} from '../match.ts';
import { fixtureFrames, startReplayServer, type ReplayServer } from '../replay-server.ts';
import { installGestures } from './index.ts';
import type { GestureHandle } from './types.ts';

let server: ReplayServer | null = null;
let match: LiveMatch | null = null;
let gestures: GestureHandle | null = null;

afterEach(async () => {
  gestures?.dispose();
  gestures = null;
  cleanup();
  if (match !== null) closeMatch(match);
  match = null;
  if (server !== null) await server.close();
  server = null;
  document.body.innerHTML = '';
});

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
      onSelectCard: (cardId: number) => selectCard(m, cardId),
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
  await waitFor(() => expect(m.stats.snapshots).toBe(1));
  const frames = fixtureFrames();
  for (const f of frames) s.send(f);
  // Delivery first, on the counter that says so, then what the delivery draws.
  await waitFor(() => expect(m.stats.applied).toBe(frames.length), { timeout: 10_000 });
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

const mineOf = (m: LiveMatch) => m.view!.players.find((p) => p.isViewer)!;
const theirsOf = (m: LiveMatch) => m.view!.players.find((p) => !p.isViewer)!;

/* ── wave 20, re-homed from ../LiveBoard.test.ts ──────────────────────── */

describe('dragging a card, and the targeter arrow', () => {
  it('a drag from a card Forge offered onto the opponent’s seat sends selectCard then selectPlayer', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const [source, other] = [mine[0]!, mine[1]!];
    // A selection Forge wants TWO of, so the source is sent as well as the drop.
    for (const f of notify([prompt('Choose two'), selectables([source, other], 1, 2)])) s.send(f);
    await waitFor(() => expect(m.selectables).not.toBeNull());

    drag(cardEl(canvas, source), faceEl(canvas, 1));
    await waitFor(() => expect(s.clientFrames()).toHaveLength(2));
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
    await waitFor(() => expect(m.selectables).not.toBeNull());

    drag(cardEl(canvas, source), cardEl(canvas, target));
    await waitFor(() => expect(s.clientFrames()).toHaveLength(2));
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
    await waitFor(() => expect(m.selectables!.max).toBe(1));

    drag(cardEl(canvas, source), cardEl(canvas, target));
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
    expect(sent(s)).toEqual([['selectCard', target]]);
  });

  it('a drag of a card Forge did not offer does nothing and says nothing', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Choose a target'), selectables([mine[0]!], 1, 1)])) s.send(f);
    await waitFor(() => expect(m.selectables).not.toBeNull());

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
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
    expect(sent(s)).toEqual([['selectCard', mine[0]!]]);
  });

  it('inside a selection, an offered card dropped where nothing is offered is used — a spell drags out of its own target ask', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Choose a target'), selectables([mine[0]!, mine[1]!], 1, 1)])) s.send(f);
    await waitFor(() => expect(m.selectables).not.toBeNull());

    drag(cardEl(canvas, mine[0]!), cardEl(canvas, theirs[0]!));
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
    expect(sent(s)).toEqual([['selectCard', mine[0]!]]);

    // And a drop outside every zone still does nothing and says nothing.
    drag(cardEl(canvas, mine[1]!), document.body);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames()).toHaveLength(1);
  });

  it('outside a selection, a drop on the table is the one frame a click sends — and it is not sent twice', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([mine[0]!])])) s.send(f);
    await waitFor(() => expect(m.weaklySelectable).not.toBeNull());

    const zone = canvas.querySelector<HTMLElement>('[data-zone="battlefield"]')!;
    drag(cardEl(canvas, mine[0]!), zone);
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
    expect(sent(s)).toEqual([['selectCard', mine[0]!]]);
  });

  it('a press that does not move is still a click, and sends exactly once', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([mine[0]!])])) s.send(f);
    await waitFor(() => expect(m.weaklySelectable).not.toBeNull());

    const face = cardEl(canvas, mine[0]!).querySelector<HTMLButtonElement>('button')!;
    fireEvent.pointerDown(face, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(face, { clientX: 12, clientY: 11 });
    fireEvent.pointerUp(face, { clientX: 12, clientY: 11 });
    fireEvent.click(face);
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
    expect(sent(s)).toEqual([['selectCard', mine[0]!]]);
  });

  it('the arrow is drawn into lane A’s overlay and snaps to the legal target under the pointer', async () => {
    const { s, m, canvas } = await gestureBoard();
    const overlay = overlayOf(canvas);
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Choose a target'), selectables([mine[0]!, mine[1]!], 1, 2)])) s.send(f);
    await waitFor(() => expect(m.selectables).not.toBeNull());

    expect(overlay.querySelector('[data-testid="targeter"]')).toBeNull();
    fireEvent.pointerDown(cardEl(canvas, mine[0]!), { button: 0, clientX: 10, clientY: 10 });
    // Over nothing in particular: the arrow follows the pointer, unsnapped.
    fireEvent.pointerMove(cardEl(canvas, theirs[0]!), { clientX: 120, clientY: 90 });
    const arrow = await waitFor(() => overlay.querySelector<SVGElement>('[data-testid="targeter"]')!);
    expect(arrow.dataset.source).toBe(String(mine[0]));
    expect(arrow.dataset.mode).toBe('drag');
    expect(arrow.dataset.target).toBeUndefined();
    expect(arrow.dataset.snapped).toBeUndefined();
    expect(arrow.querySelector('line')).not.toBeNull();
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

  it('with no overlay root the arrow is not drawn, and the drag still sends', async () => {
    const { s, m, canvas } = await gestureBoard();
    // Lane A owns the overlay; a board drawn without one must still be
    // playable, so take it away and drive the same gesture.
    canvas.querySelector('[data-board-overlay]')?.remove();
    expect(canvas.querySelector('[data-board-overlay]')).toBeNull();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Choose two'), selectables([mine[0]!, mine[1]!], 1, 2)])) s.send(f);
    await waitFor(() => expect(m.selectables).not.toBeNull());

    fireEvent.pointerDown(cardEl(canvas, mine[0]!), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(cardEl(canvas, mine[1]!), { clientX: 200, clientY: 140 });
    expect(document.querySelector('[data-testid="targeter"]')).toBeNull();
    fireEvent.pointerUp(cardEl(canvas, mine[1]!), { clientX: 200, clientY: 140 });
    await waitFor(() => expect(s.clientFrames()).toHaveLength(2));
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
    await waitFor(() => expect(m.selectables).not.toBeNull());

    const stack = canvas.querySelector<HTMLElement>('[data-zone="stack"]') ?? canvas.querySelector<HTMLElement>('.board')!;
    fireEvent.pointerDown(stack, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(faceEl(canvas, 1), { clientX: 200, clientY: 140 });
    fireEvent.pointerUp(faceEl(canvas, 1), { clientX: 200, clientY: 140 });
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
    expect(sent(s)).toEqual([['selectPlayer', 1]]);
  });

  it('a pointercancel drops the gesture: the arrow goes and nothing is sent', async () => {
    const { s, m, canvas } = await gestureBoard();
    const overlay = overlayOf(canvas);
    const mine = mineOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Choose two'), selectables([mine[0]!, mine[1]!], 1, 2)])) s.send(f);
    await waitFor(() => expect(m.selectables).not.toBeNull());

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
    await waitFor(() => expect(m.selectables).not.toBeNull());
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
 *  - a card `boardInteraction` OFFERED is this layer's, `draggable` or not;
 *  - anything the browser will drag natively is lane A's, and this layer starts
 *    no gesture on it and sends nothing on release;
 *  - empty table space is unchanged — both the box-draw and the source-less
 *    pointing gesture still start there.
 *
 * `draggable` is set by hand in these cases rather than waited for, so the
 * partition is pinned whichever order the two lanes' halves land in (lane A's
 * half is `draggable = arranging !== undefined && row !== undefined &&
 * !selectable`). Either half alone is enough; both is the point.
 */
describe('the press is partitioned with lane A’s arrange gesture', () => {
  it('a card Forge offered is still THIS layer’s, even when it is natively draggable', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Choose two'), selectables([mine[0]!, mine[1]!], 1, 2)])) s.send(f);
    await waitFor(() => expect(m.selectables).not.toBeNull());
    // Lane A's OLD markup: every own-battlefield card draggable, offered or not.
    cardEl(canvas, mine[0]!).setAttribute('draggable', 'true');
    cardEl(canvas, mine[1]!).setAttribute('draggable', 'true');

    drag(cardEl(canvas, mine[0]!), cardEl(canvas, mine[1]!));
    await waitFor(() => expect(s.clientFrames()).toHaveLength(2));
    expect(sent(s)).toEqual([
      ['selectCard', mine[0]!],
      ['selectCard', mine[1]!],
    ]);
  });

  it('a NON-offered draggable card starts no gesture and sends nothing on release', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    // A selection is open and names only the OPPONENT's creature, so the
    // viewer's own battlefield is all un-offered — and all draggable.
    for (const f of notify([prompt('Choose a target'), selectables([theirs[0]!], 1, 1)])) s.send(f);
    await waitFor(() => expect(m.selectables).not.toBeNull());
    for (const id of mine) cardEl(canvas, id).setAttribute('draggable', 'true');
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
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
    expect(sent(s)).toEqual([['selectCard', theirs[0]!]]);
  });

  it('a draggable card starts no box-draw either — one press does not rearrange AND attack', async () => {
    const { s, m, canvas } = await declaringAttackersBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const [offered, dragHandle] = [mine[0]!, mine[1]!];
    for (const f of notify([prompt('Declare attackers'), actionable([offered])])) s.send(f);
    await waitFor(() => expect(boardInteraction(m).selectable.size).toBe(1));
    cardEl(canvas, dragHandle).setAttribute('draggable', 'true');
    boxAt(overlayOf(canvas), 0, 0, 800, 600);
    boxAt(cardEl(canvas, offered), 120, 120);
    boxAt(cardEl(canvas, dragHandle), 100, 100);

    fireEvent.pointerDown(cardEl(canvas, dragHandle), { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(cardEl(canvas, offered), { clientX: 400, clientY: 400 });
    expect(overlayOf(canvas).querySelector('[data-testid="marquee"]')).toBeNull();
    fireEvent.pointerUp(cardEl(canvas, offered), { clientX: 400, clientY: 400 });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clientFrames()).toHaveLength(0);
  });

  it('empty table space is unchanged: the box-draw still starts there', async () => {
    const { s, m, canvas } = await declaringAttackersBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Declare attackers'), actionable([mine[0]!])])) s.send(f);
    await waitFor(() => expect(boardInteraction(m).selectable.size).toBe(1));
    // Every card draggable, as lane A's old markup had it — the ZONE is not.
    for (const id of mine) cardEl(canvas, id).setAttribute('draggable', 'true');
    boxAt(overlayOf(canvas), 0, 0, 800, 600);
    boxAt(cardEl(canvas, mine[0]!), 120, 120);

    const zone = canvas.querySelector<HTMLElement>('[data-zone="battlefield"]')!;
    fireEvent.pointerDown(zone, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(zone, { clientX: 300, clientY: 300 });
    expect(overlayOf(canvas).querySelector('[data-testid="marquee"]')).not.toBeNull();
    fireEvent.pointerUp(zone, { clientX: 300, clientY: 300 });
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
    expect(sent(s)).toEqual([['selectCard', mine[0]!]]);
  });

  it('empty table space is unchanged: the source-less pointing gesture still starts there', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Choose a target'), selectables([theirs[0]!], 1, 1)])) s.send(f);
    await waitFor(() => expect(m.selectables).not.toBeNull());
    for (const id of mine) cardEl(canvas, id).setAttribute('draggable', 'true');

    const stack = canvas.querySelector<HTMLElement>('[data-zone="stack"]') ?? canvas.querySelector<HTMLElement>('.board')!;
    fireEvent.pointerDown(stack, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(faceEl(canvas, 1), { clientX: 200, clientY: 140 });
    fireEvent.pointerUp(faceEl(canvas, 1), { clientX: 200, clientY: 140 });
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
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
  await waitFor(() => expect(ctx.m.view!.phase).toBe('COMBAT_DECLARE_ATTACKERS'));
  expect(ctx.m.view!.activePlayerId).toBe(me.id);
  return ctx;
}

describe('§B.1 — an attacker is marked at SELECTION, and the mark is not Forge’s tapped state', () => {
  it('a click marks the card the moment the frame leaves, and the wire carries exactly one selectCard', async () => {
    const { s, m, canvas } = await declaringAttackersBoard();
    const attacker = mineOf(m).battlefield.find((c) => !c.tapped)!.id;
    for (const f of notify([prompt('Declare attackers'), actionable([attacker])])) s.send(f);
    await waitFor(() => expect(boardInteraction(m).selectable.has(attacker)).toBe(true));

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
    await waitFor(() => expect(boardInteraction(m).selectable.has(card.id)).toBe(true));

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
    await waitFor(() => expect(boardInteraction(m).selectable.has(attacker)).toBe(true));
    fireEvent.click(cardEl(canvas, attacker).querySelector('button')!);
    await waitFor(() => expect(cardEl(canvas, attacker).dataset.attackIntent).toBe('sent'));

    s.send(attackingDelta([attacker]));
    await waitFor(() => expect(cardEl(canvas, attacker).dataset.attackIntent).toBe('declared'));
  });

  it('Forge did NOT declare it: the disagreement is shown, not papered over', async () => {
    const { s, m, canvas } = await declaringAttackersBoard();
    const attacker = mineOf(m).battlefield.find((c) => !c.tapped)!.id;
    for (const f of notify([prompt('Declare attackers'), actionable([attacker])])) s.send(f);
    await waitFor(() => expect(boardInteraction(m).selectable.has(attacker)).toBe(true));
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
    await waitFor(() => expect(boardInteraction(m).selectable.has(card)).toBe(true));
    fireEvent.click(cardEl(canvas, card).querySelector('button')!);
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
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
    await waitFor(() => expect(boardInteraction(m).selectable.size).toBe(3));

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

    await waitFor(() => expect(s.clientFrames()).toHaveLength(2));
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
    await waitFor(() => expect(boardInteraction(m).selectable.size).toBe(1));

    boxAt(overlayOf(canvas), 0, 0, 800, 600);
    boxAt(cardEl(canvas, offered), 120, 120);
    boxAt(cardEl(canvas, notOffered), 180, 120);
    boxAt(cardEl(canvas, theirs[0]!), 220, 160);

    const zone = canvas.querySelector<HTMLElement>('[data-zone="battlefield"]')!;
    fireEvent.pointerDown(zone, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(zone, { clientX: 400, clientY: 400 });
    fireEvent.pointerUp(zone, { clientX: 400, clientY: 400 });

    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
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
    await waitFor(() => expect(boardInteraction(m).selectable.size).toBe(1));
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
    await waitFor(() => expect(boardInteraction(m).selectable.size).toBe(1));
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
    await waitFor(() => expect(m.view!.phase).toBe('COMBAT_DECLARE_BLOCKERS'));
    for (const f of notify([prompt('Select a blocker'), actionable([blocker]), highlight([theirs[0]!], true)])) s.send(f);
    await waitFor(() => expect(m.highlighted!.size).toBe(1));
    return { ...ctx, blocker, attackers: [theirs[0]!, theirs[1]!] as const };
  }

  it('the two frames go out ATTACKER first, which is the order InputBlock needs', async () => {
    const { s, canvas, blocker, attackers } = await blockingBoard();
    // The SECOND attacker: it is not the one Forge highlighted, so it reaches
    // the offered set only through `blockTargets`.
    drag(cardEl(canvas, blocker), cardEl(canvas, attackers[1]));
    await waitFor(() => expect(s.clientFrames()).toHaveLength(2));
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
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(sent(s)).toEqual([['selectCard', blocker]]);
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
    await waitFor(() => expect(m.view!.phase).toBe('COMBAT_DECLARE_BLOCKERS'));
    for (const f of notify([prompt('Priority'), actionable([blocker])])) s.send(f);
    await waitFor(() => expect(boardInteraction(m).selectable.has(blocker)).toBe(true));
    expect(boardInteraction(m).selectable.has(theirs[0]!)).toBe(false);

    // The drop lands on an inert card inside a zone, which is the plain
    // "the card is being used" frame — one, not two, and not the attacker's.
    drag(cardEl(canvas, blocker), cardEl(canvas, theirs[0]!));
    await waitFor(() => expect(s.clientFrames()).toHaveLength(1));
    expect(sent(s)).toEqual([['selectCard', blocker]]);
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
    await waitFor(() => expect(boardInteraction(m).selectable.has(spell)).toBe(true));
    fireEvent.click(cardEl(canvas, spell).querySelector('button')!);
    await waitFor(() => expect(m.lastSelectedCard).toBe(spell));
    // …and Forge answers with the target selection. No drag: just the pointer.
    for (const f of notify([prompt('Choose a target'), selectables([theirs[0]!], 1, 1)])) s.send(f);
    await waitFor(() => expect(m.selectables).not.toBeNull());

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

  it('the click arrow goes when the selection does, and the pointer leaving the canvas takes it too', async () => {
    const { s, m, canvas } = await gestureBoard();
    const mine = mineOf(m).battlefield.map((c) => c.id);
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Priority'), actionable([mine[0]!])])) s.send(f);
    await waitFor(() => expect(boardInteraction(m).selectable.has(mine[0]!)).toBe(true));
    fireEvent.click(cardEl(canvas, mine[0]!).querySelector('button')!);
    for (const f of notify([prompt('Choose a target'), selectables([theirs[0]!], 1, 1)])) s.send(f);
    await waitFor(() => expect(m.selectables).not.toBeNull());
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
    await waitFor(() => expect(m.selectables).toBeNull());
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
    await waitFor(() => expect(m.selectables).not.toBeNull());
    expect(m.lastSelectedCard).toBeNull();
    const origin = stackOrigin(m, canvas);
    expect(origin).not.toBeNull();

    fireEvent.pointerMove(cardEl(canvas, theirs[0]!), { clientX: 220, clientY: 180 });
    const arrow = await waitFor(() => overlayOf(canvas).querySelector<SVGElement>('[data-testid="targeter"]')!);
    expect(arrow.dataset.mode).toBe('click');
    expect(arrow.dataset.source).toBe(String(origin));
    expect(sent(s)).toEqual([]);
  });

  it('with nothing to draw from, the pointer draws no arrow', async () => {
    const { s, m, canvas } = await gestureBoard();
    const theirs = theirsOf(m).battlefield.map((c) => c.id);
    for (const f of notify([prompt('Choose a target'), selectables([theirs[0]!], 1, 1)])) s.send(f);
    await waitFor(() => expect(m.selectables).not.toBeNull());
    expect(m.lastSelectedCard).toBeNull();
    // Every stack source's own card taken out of the DOM: the tail has nowhere
    // to start, and a tail from nowhere is not guidance.
    for (const item of m.view!.stack) {
      if (item.sourceCardId !== null) canvas.querySelector(`[data-board-card="${item.sourceCardId}"]`)?.remove();
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
