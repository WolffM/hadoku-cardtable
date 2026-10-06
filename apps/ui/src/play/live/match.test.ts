/*
 * The live match driver, against a REAL socket.io server replaying a REAL
 * match's frames (`./replay-server.ts`), over a real `socket.io-client`
 * connection. The board state every live case ends in is compared, whole,
 * against the fixture path's — `boardFromFixture` — because the two sources
 * must agree, not merely both look plausible.
 *
 * The sequencing cases assert COUNTS, and the one that matters most is a
 * negative: a burst of duplicates produces exactly zero resync requests, on
 * the client AND as received by the server.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { parseServerFrame, type ServerFrame } from '@hadoku/forge-wire';

import type { BoardView } from '../adapter.ts';
import { boardFromFixture, PLAY_FIXTURES } from '../fixtures.ts';
import { deltaKey, WireType, type Tagged } from '../wire.ts';
import {
  abortAsk,
  answerAsk,
  answerConfirm,
  attackAssignment,
  attackIntents,
  boardInteraction,
  closeMatch,
  concede,
  currentAsk,
  declaringAttackers,
  declaringBlockers,
  declaringCombat,
  payingMana,
  isBlockAssignment,
  ingest,
  MAX_RESYNCS_WITHOUT_PROGRESS,
  nothingToDecide,
  attackersLeft,
  noteStackTargetIntent,
  pressButton,
  selectCard,
  selectPlayer,
  setFullControl,
  SAYS_KEPT,
  socketIoMatchTransport,
  startMatch,
  type LiveMatch,
  type MatchTransport,
} from './match.ts';
import { confirmAsk, fixtureFrames, startReplayServer, until, type ReplayServer } from './replay-server.ts';
import { MATCH_EVENTS, parseMatchAck, parseServerEnvelope } from './transport.ts';

const FRAMES = fixtureFrames();
const FIXTURE_VIEW = boardFromFixture(PLAY_FIXTURES[0]!);

/** A delta that changes nothing, sent to mark "everything before me has been processed". */
function sentinel(): ServerFrame {
  return parseServerFrame({
    kind: 'notify',
    method: 'applyDelta',
    payload: { packet: { seq: 27, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: {}, events: [] } },
  });
}

/** A blocking ask other than showConfirmDialog — drawn by `../prompts/`. */
function optionAsk(callId: string): ServerFrame {
  return parseServerFrame({
    kind: 'ask',
    callId,
    method: 'showOptionDialog',
    message: 'Choose a mode',
    title: 'Modes',
    icon: null,
    options: ['Deal 2 damage', 'Gain 2 life'],
    defaultOption: 0,
  });
}

let server: ReplayServer | null = null;
let match: LiveMatch | null = null;

afterEach(async () => {
  if (match !== null) closeMatch(match);
  match = null;
  if (server !== null) await server.close();
  server = null;
});

async function connect(s: ReplayServer): Promise<LiveMatch> {
  const m = startMatch({
    matchId: s.matchId,
    transport: socketIoMatchTransport({ url: s.url, path: '/socket.io/', transports: ['websocket'] }),
  });
  match = m;
  await until('the join snapshot', () => m.stats.snapshots === 1);
  return m;
}

/** Send, and wait until the client has applied it. */
async function sendAndApply(s: ReplayServer, m: LiveMatch, frames: readonly ServerFrame[]): Promise<void> {
  const target = m.stats.applied + frames.length;
  for (const f of frames) s.send(f);
  await until(`${frames.length} frame(s) applied`, () => m.stats.applied >= target);
}

async function fullGame(): Promise<{ s: ReplayServer; m: LiveMatch }> {
  const s = (server = await startReplayServer());
  const m = await connect(s);
  await sendAndApply(s, m, FRAMES);
  return { s, m };
}

describe('the transport contract', () => {
  it('a snapshot and an error both parse as the join ack', () => {
    const snapshot = { matchId: 'm', seat: 0, playerId: 0, cursor: null, frames: [FRAMES[0]] };
    expect(parseMatchAck(snapshot).ok).toBe(true);
    expect(parseMatchAck({ error: 'no such match' }).ok).toBe(true);
  });

  it('a snapshot carrying a malformed frame is refused, with the path named', () => {
    const bad = { matchId: 'm', seat: 0, playerId: 0, cursor: null, frames: [{ kind: 'notify', method: 'applyDelta' }] };
    const result = parseMatchAck(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.path)).toContain('$.frames[0].payload');
  });

  it('an envelope with a field the contract does not have is refused', () => {
    const result = parseServerEnvelope({ matchId: 'm', cursor: { epoch: 'e', seq: 1 }, frame: {}, seat: 1 });
    expect(result.ok).toBe(false);
  });

  it('a cursor must be a positive seq', () => {
    expect(parseServerEnvelope({ matchId: 'm', cursor: { epoch: 'e', seq: 0 }, frame: {} }).ok).toBe(false);
  });
});

describe('a live delta stream', () => {
  it('joins mid-game, then follows the stream to the fixture’s exact board', async () => {
    const s = (server = await startReplayServer());
    for (const f of FRAMES.slice(0, 10)) s.send(f); // before anyone joined: history only
    const m = await connect(s);

    expect(m.seat).toBe(0);
    expect(m.playerId).toBe(0);
    expect(m.cursor).toEqual({ epoch: 'epoch-a', seq: 10 });
    const early = m.view!;
    expect(early.players.map((p) => p.name)).toEqual(['Bob (Capturing)', 'Alice (Host AI)']);

    await sendAndApply(s, m, FRAMES.slice(10));
    expect(m.view).toEqual(FIXTURE_VIEW);
    expect(m.view!.turn).not.toBe(early.turn);
    expect(m.stats).toMatchObject({ snapshots: 1, applied: 17, resyncsRequested: 0, duplicatesDropped: 0, invalid: 0 });
    expect(s.resyncs).toBe(0);
  });

  it('a whole game streamed from an empty join ends on the fixture’s board', async () => {
    const { s, m } = await fullGame();
    expect(m.view).toEqual(FIXTURE_VIEW);
    expect(m.cursor).toEqual({ epoch: 'epoch-a', seq: 27 });
    expect(m.skippedDeltas).toBe(0);
    expect(s.joins).toBe(1);
  });
});

describe('sequencing: classifySeq, over the wire', () => {
  it('drops a burst of duplicates and asks for NOTHING', async () => {
    const { s, m } = await fullGame();
    for (const seq of [27, 20, 27, 1, 26, 27]) s.sendRaw(s.sent(seq));
    await sendAndApply(s, m, [sentinel()]);

    expect(m.stats.duplicatesDropped).toBe(6);
    expect(m.stats.resyncsRequested).toBe(0);
    expect(s.resyncs).toBe(0);
    expect(m.stats.gaps).toBe(0);
    expect(m.view).toEqual(FIXTURE_VIEW);
  });

  it('a gap asks for exactly one resync, and the snapshot restores the stream', async () => {
    const s = (server = await startReplayServer());
    const m = await connect(s);
    await sendAndApply(s, m, FRAMES.slice(0, 10));

    s.lose(FRAMES[10]!); // seq 11 never arrives
    s.send(FRAMES[11]!); // seq 12: a gap
    await until('the resync snapshot', () => m.stats.snapshots === 2);

    expect(m.stats.gaps).toBe(1);
    expect(m.stats.resyncsRequested).toBe(1);
    expect(s.resyncs).toBe(1);
    expect(m.cursor).toEqual({ epoch: 'epoch-a', seq: 12 });

    await sendAndApply(s, m, FRAMES.slice(12));
    expect(m.view).toEqual(FIXTURE_VIEW);
    expect(m.stats.resyncsRequested).toBe(1);
  });

  it('an epoch change discards everything and refetches', async () => {
    const { s, m } = await fullGame();
    s.restart('epoch-b');
    for (const f of FRAMES) s.send(f);
    await until('the new epoch at seq 27', () => m.cursor?.epoch === 'epoch-b' && m.cursor.seq === 27);

    expect(m.stats.epochChanges).toBe(1);
    expect(m.stats.resyncsRequested).toBe(1);
    expect(s.resyncs).toBe(1);
    expect(m.view).toEqual(FIXTURE_VIEW);
  });

  it('stops resyncing when snapshots never catch up, and says so', () => {
    // A server whose snapshot cursor lags its own stream: every frame after
    // the snapshot is a gap. Stubbed, because it is the server being wrong.
    const acks: ((err: Error | null, response: unknown) => void)[] = [];
    const transport: MatchTransport = {
      on: () => {},
      emit: () => {},
      request: (_event, _payload, onAck) => acks.push(onAck),
      disconnect: () => {},
    };
    const m = startMatch({ matchId: 'm', transport });
    const lagging = { matchId: 'm', seat: 0, playerId: 0, cursor: { epoch: 'e', seq: 1 }, frames: [FRAMES[0]] };
    acks.shift()!(null, lagging);
    for (let i = 0; i < 10; i += 1) {
      ingest(m, { matchId: 'm', cursor: { epoch: 'e', seq: 3 }, frame: FRAMES[1] });
      acks.shift()?.(null, lagging);
    }
    expect(m.stats.resyncsRequested).toBe(MAX_RESYNCS_WITHOUT_PROGRESS);
    expect(m.lastError).toMatch(/stopped after 3 resyncs/);
  });
});

describe('showConfirmDialog, end to end', () => {
  it('the ask arrives, and the answer — the opposite of the default — reaches the server', async () => {
    const { s, m } = await fullGame();
    s.send(confirmAsk('c-1', true));
    await until('the ask', () => currentAsk(m) !== null);
    expect(currentAsk(m)).toMatchObject({ callId: 'c-1', title: 'Mulligan', defaultYes: true });

    expect(answerConfirm(m, 'c-1', false)).toBe(true);
    await until('the reply at the server', () => s.clientFrames().length === 1);
    const [reply] = s.clientFrames();
    expect(reply).toEqual({
      ok: true,
      value: { kind: 'reply', callId: 'c-1', method: 'showConfirmDialog', result: false },
    });
    expect(s.received.at(-1)?.payload).toMatchObject({ matchId: s.matchId });
    expect(currentAsk(m)).toBeNull();
  });

  it('one ask gets one answer: a second click sends nothing', async () => {
    const { s, m } = await fullGame();
    s.send(confirmAsk('c-2', false));
    await until('the ask', () => currentAsk(m) !== null);
    expect(answerConfirm(m, 'c-2', true)).toBe(true);
    expect(answerConfirm(m, 'c-2', false)).toBe(false);
    expect(answerConfirm(m, 'c-other', true)).toBe(false);
    await sendAndApply(s, m, [sentinel()]);
    expect(s.clientFrames()).toHaveLength(1);
    expect(m.stats.replies).toBe(1);
  });

  it('a pending ask survives a resync: the server re-sends it after the snapshot', async () => {
    const s = (server = await startReplayServer());
    const m = await connect(s);
    await sendAndApply(s, m, FRAMES.slice(0, 5));
    s.send(confirmAsk('c-3'));
    await until('the ask', () => currentAsk(m)?.callId === 'c-3');

    s.lose(FRAMES[5]!);
    s.send(FRAMES[6]!);
    await until('the resync, and the ask again', () => m.stats.snapshots === 2 && currentAsk(m)?.callId === 'c-3');
    expect(m.stats.resyncsRequested).toBe(1);

    expect(answerConfirm(m, 'c-3', true)).toBe(true);
    await until('the reply', () => s.clientFrames().length === 1);
    expect(s.clientFrames()[0]).toMatchObject({ ok: true, value: { callId: 'c-3', result: true } });
  });
});

describe('the other fourteen asks: held open for their prompt, answered through the same seam', () => {
  it('an ask other than showConfirmDialog is held open, not aborted, and its answer reaches the server', async () => {
    const { s, m } = await fullGame();
    s.send(optionAsk('c-9'));
    await until('the ask', () => currentAsk(m)?.callId === 'c-9');
    await sendAndApply(s, m, [sentinel()]);
    expect(s.clientFrames()).toHaveLength(0);
    expect(m.stats.aborts).toBe(0);

    expect(answerAsk(m, 'c-9', 'showOptionDialog', 1)).toBe(true);
    await until('the reply at the server', () => s.clientFrames().length === 1);
    expect(s.clientFrames()[0]).toEqual({
      ok: true,
      value: { kind: 'reply', callId: 'c-9', method: 'showOptionDialog', result: 1 },
    });
    expect(currentAsk(m)).toBeNull();
  });

  it('refuses an answer for the wrong method, or one its wire schema rejects, and sends nothing', async () => {
    const { s, m } = await fullGame();
    s.send(optionAsk('c-10'));
    await until('the ask', () => currentAsk(m) !== null);
    expect(answerAsk(m, 'c-10', 'showConfirmDialog', true)).toBe(false);
    expect(answerConfirm(m, 'c-10', true)).toBe(false);
    expect(answerAsk(m, 'c-10', 'showOptionDialog', 'the first one')).toBe(false);
    expect(m.lastError).toMatch(/fails its wire schema/);
    await sendAndApply(s, m, [sentinel()]);
    expect(s.clientFrames()).toHaveLength(0);
    expect(currentAsk(m)?.callId).toBe('c-10');
  });

  it('an ask that does not parse is still aborted, and the client resyncs', async () => {
    const { s, m } = await fullGame();
    s.sendRaw({
      matchId: s.matchId,
      cursor: { epoch: 'epoch-a', seq: 28 },
      frame: { kind: 'ask', callId: 'c-bad', method: 'showConfirmDialog', message: 'no buttons' },
    });
    await until('the resync', () => m.stats.snapshots === 2);
    expect(m.stats.invalid).toBe(1);
    expect(s.clientFrames()[0]).toMatchObject({ ok: true, value: { kind: 'abort', callId: 'c-bad', reason: 'unsupported' } });
    expect(m.view).toEqual(FIXTURE_VIEW);
  });

  it('abortAsk gives up one open ask and never answers a closed one', async () => {
    const { s, m } = await fullGame();
    s.send(optionAsk('c-11'));
    await until('the ask', () => currentAsk(m) !== null);
    expect(abortAsk(m, 'c-11', 'unsupported', 'the prompt failed to draw')).toBe(true);
    expect(abortAsk(m, 'c-11', 'unsupported', 'again')).toBe(false);
    await until('the abort at the server', () => s.clientFrames().length === 1);
    expect(s.clientFrames()[0]).toMatchObject({ ok: true, value: { kind: 'abort', callId: 'c-11', reason: 'unsupported' } });
    expect(answerAsk(m, 'c-11', 'showOptionDialog', 0)).toBe(false);
  });

  it('closing the board with a question open cancels it', async () => {
    const { s, m } = await fullGame();
    s.send(confirmAsk('c-4'));
    await until('the ask', () => currentAsk(m) !== null);
    closeMatch(m);
    match = null;
    await until('the abort at the server', () => s.clientFrames().length === 1);
    expect(s.clientFrames()[0]).toMatchObject({ ok: true, value: { kind: 'abort', callId: 'c-4', reason: 'cancelled' } });
  });
});

describe('an open prompt never desyncs the board', () => {
  it('a second ask QUEUES behind the first: neither is dropped, and each gets exactly its own answer', async () => {
    // The server holds a seat's asks by callId (a probe can open one beside
    // the game's). An ask that replaced another would park Forge on the first.
    const { s, m } = await fullGame();
    s.send(optionAsk('c-first'));
    s.send(confirmAsk('c-second'));
    await until('both asks', () => m.asks.length === 2);
    expect(m.asks.map((a) => a.callId)).toEqual(['c-first', 'c-second']);
    expect(currentAsk(m)?.callId).toBe('c-first');

    expect(answerAsk(m, 'c-first', 'showOptionDialog', 0)).toBe(true);
    expect(currentAsk(m)?.callId).toBe('c-second');
    expect(answerConfirm(m, 'c-second', false)).toBe(true);
    await until('both replies', () => s.clientFrames().length === 2);
    expect(s.clientFrames().map((f) => (f.ok && f.value.kind !== 'act' ? [f.value.callId, f.value.kind] : null))).toEqual([
      ['c-first', 'reply'],
      ['c-second', 'reply'],
    ]);
    expect(m.stats.aborts).toBe(0);
  });

  it('a resync with two questions open gets BOTH back, in order, and neither is answered twice', async () => {
    const s = (server = await startReplayServer());
    const m = await connect(s);
    await sendAndApply(s, m, FRAMES.slice(0, 5));
    s.send(optionAsk('c-x'));
    s.send(confirmAsk('c-y'));
    await until('both asks', () => m.asks.length === 2);

    s.lose(FRAMES[5]!);
    s.send(FRAMES[6]!);
    await until('the resync, and both asks again', () => m.stats.snapshots === 2 && m.asks.length === 2);
    expect(m.asks.map((a) => a.callId)).toEqual(['c-x', 'c-y']);
    await sendAndApply(s, m, FRAMES.slice(7));
    expect(m.view).toEqual(FIXTURE_VIEW);
    expect(answerAsk(m, 'c-x', 'showOptionDialog', 0)).toBe(true);
    expect(answerAsk(m, 'c-x', 'showOptionDialog', 0)).toBe(false);
    expect(answerConfirm(m, 'c-y', true)).toBe(true);
    await until('two replies', () => s.clientFrames().length === 2);
  });

  it('closing with two questions open cancels BOTH', async () => {
    const { s, m } = await fullGame();
    s.send(optionAsk('c-a'));
    s.send(confirmAsk('c-b'));
    await until('both asks', () => m.asks.length === 2);
    closeMatch(m);
    match = null;
    await until('two aborts at the server', () => s.clientFrames().length === 2);
    expect(s.clientFrames().map((f) => (f.ok && f.value.kind === 'abort' ? f.value.callId : null)).sort()).toEqual(['c-a', 'c-b']);
  });

  it('state that arrives while a prompt is open is folded as if none were: same board, same cursor', async () => {
    const s = (server = await startReplayServer());
    const m = await connect(s);
    await sendAndApply(s, m, FRAMES.slice(0, 8));
    s.send(optionAsk('c-mid'));
    await until('the ask', () => currentAsk(m) !== null);

    // The rest of the game streams in with the question still unanswered.
    await sendAndApply(s, m, FRAMES.slice(8));
    expect(m.view).toEqual(FIXTURE_VIEW);
    expect(m.cursor).toEqual({ epoch: 'epoch-a', seq: FRAMES.length + 1 });
    expect(m.stats).toMatchObject({ gaps: 0, resyncsRequested: 0, invalid: 0 });
    expect(currentAsk(m)?.callId).toBe('c-mid');

    // And the answer, given after all of it, is still the one Forge asked for.
    expect(answerAsk(m, 'c-mid', 'showOptionDialog', 1)).toBe(true);
    await until('the reply', () => s.clientFrames().length === 1);
    expect(s.clientFrames()[0]).toMatchObject({ ok: true, value: { callId: 'c-mid', result: 1 } });
  });

  it('an epoch change drops the open prompt, and an answer to it afterwards sends nothing', async () => {
    const { s, m } = await fullGame();
    s.send(optionAsk('c-old'));
    await until('the ask', () => currentAsk(m) !== null);
    s.restart('epoch-b');
    for (const f of FRAMES) s.send(f);
    await until('the new epoch at seq 27', () => m.cursor?.epoch === 'epoch-b' && m.cursor.seq === 27);
    expect(currentAsk(m)).toBeNull();
    expect(answerAsk(m, 'c-old', 'showOptionDialog', 0)).toBe(false);
    expect(s.clientFrames()).toHaveLength(0);
    expect(m.view).toEqual(FIXTURE_VIEW);
  });
});

describe('what the client refuses', () => {
  it('a refused join is surfaced, not retried', async () => {
    const s = (server = await startReplayServer());
    s.refuseWith = 'no such match';
    const m = startMatch({
      matchId: s.matchId,
      transport: socketIoMatchTransport({ url: s.url, path: '/socket.io/', transports: ['websocket'] }),
    });
    match = m;
    await until('the refusal', () => m.lastError !== null);
    expect(m.lastError).toBe(`${MATCH_EVENTS.join} was refused: no such match`);
    expect(m.view).toBeNull();
    expect(s.joins).toBe(1);
  });

  it('a frame for another match is refused and does not move the cursor', async () => {
    const { s, m } = await fullGame();
    s.sendRaw({ ...s.sent(27), matchId: 'someone-else', cursor: { epoch: 'epoch-a', seq: 28 } });
    await sendAndApply(s, m, [sentinel()]);
    expect(m.stats.invalid).toBe(1);
    expect(m.cursor).toEqual({ epoch: 'epoch-a', seq: 28 });
    expect(m.stats.resyncsRequested).toBe(0);
  });
});

describe('the viewer comes from the snapshot', () => {
  it('a playerId that names no seat hides EVERY hand rather than showing one', async () => {
    const s = (server = await startReplayServer({ playerId: 99 }));
    const m = await connect(s);
    await sendAndApply(s, m, FRAMES);
    expect(m.view!.players.map((p) => [p.id, p.isViewer, p.hand, p.handCount])).toEqual([
      [0, false, null, 5],
      [1, false, null, 2],
    ]);
  });
});

/*
 * Clicking the board. Forge says what it will take — a selection's cards via
 * `setSelectables`, everything else's via `setWeaklySelectable` — and a click
 * is checked against what Forge said LAST, when it is made. Every "sends
 * nothing" below is proven against a barrier: a valid act sent after it, which
 * must be the FIRST frame the server receives (socket.io keeps a socket's
 * order), so a refused click cannot be hiding behind a slow wire.
 *
 * The case that matters most is the negative one: with an input LIVE and Forge
 * having named nothing, the board offers nothing. Restoring the old
 * `cardIdsInView` fallback — "no selection, so offer every card in view" —
 * fails it, which is the point.
 */
/* Frame builders the interaction cases share. */
const prompt = (message: string) =>
  parseServerFrame({ kind: 'notify', method: 'showPromptMessage', player: { kind: 'player', id: 0 }, message, card: null });
const bar = (enable1: boolean) =>
  parseServerFrame({
    kind: 'notify',
    method: 'updateButtons',
    owner: { kind: 'player', id: 0 },
    label1: 'OK',
    label2: 'Cancel',
    enable1,
    enable2: false,
    focus1: true,
  });
const selectables = (ids: number[], min: number, max: number) =>
  parseServerFrame({ kind: 'notify', method: 'setSelectables', cards: ids.map((id) => ({ kind: 'card', id })), min, max });
const clear = () => parseServerFrame({ kind: 'notify', method: 'clearSelectables' });
/** Forge's priority-time offer. `pushActionableCards` sends this, weighted. */
const actionable = (ids: number[]) =>
  parseServerFrame({ kind: 'notify', method: 'setWeaklySelectable', cards: ids.map((id) => ({ kind: 'card', id })) });
const clearActionable = () => parseServerFrame({ kind: 'notify', method: 'clearWeaklySelectable' });
/** Forge's mark. Incremental and signed — `on: false` is the un-mark. */
const highlight = (entities: Array<{ kind: 'card' | 'player'; id: number }>, on: boolean) =>
  parseServerFrame({ kind: 'notify', method: 'setHighlighted', entities, on });
const mark = (ids: number[], on = true) =>
  highlight(
    ids.map((id) => ({ kind: 'card' as const, id })),
    on,
  );

/** Card ids on the fixture board: the viewer's battlefield, and the opponent's. */
function ids(m: LiveMatch): { mine: number[]; theirs: number[] } {
  const players = m.view!.players;
  const mine = players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
  const theirs = players.find((p) => !p.isViewer)!.battlefield.map((c) => c.id);
  expect(mine.length).toBeGreaterThan(1);
  expect(theirs.length).toBeGreaterThan(0);
  return { mine, theirs };
}

/** The id of a NON-land on the viewer's own battlefield — the fixture's first slot is a land. */
function myNonLand(m: LiveMatch): number {
  const me = m.view!.players.find((p) => p.isViewer)!;
  const card = me.battlefield.find((c) => !c.card.typeLine.includes('Land'));
  if (card === undefined) throw new Error('the fixture has no non-land card on the viewer’s battlefield');
  return card.id;
}

/** The id of a LAND on the viewer's own battlefield. */
function myLand(m: LiveMatch): number {
  const me = m.view!.players.find((p) => p.isViewer)!;
  const card = me.battlefield.find((c) => c.card.typeLine.includes('Land'));
  if (card === undefined) throw new Error('the fixture has no land on the viewer’s battlefield');
  return card.id;
}

/** The id of a card in the viewer's own HAND matching `wantLand` (true: a land; false: a non-land). */
function myHandCard(m: LiveMatch, wantLand: boolean): number {
  const me = m.view!.players.find((p) => p.isViewer)!;
  const card = (me.hand ?? []).find((c) => c.card.typeLine.includes('Land') === wantLand);
  if (card === undefined) throw new Error(`the fixture's hand has no ${wantLand ? 'land' : 'non-land'} card`);
  return card.id;
}

const cardAct = (id: number) => ({
  ok: true,
  value: { kind: 'act', method: 'selectCard', card: { kind: 'card', id }, otherCardViewsToSelect: [], triggerEvent: null },
});

/** The Game object's wire key, and one synthetic delta. */
const GAME_KEY = String((WireType.Game << 28) | 1);
let seq = FRAMES.length;
function stateDelta(objectDeltas: Record<string, unknown>): ServerFrame {
  seq += 1;
  return parseServerFrame({
    kind: 'notify',
    method: 'applyDelta',
    payload: { packet: { seq, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas, events: [] } },
  });
}
const phase = (name: string, playerTurn: number) =>
  stateDelta({
    [GAME_KEY]: {
      _type: WireType.Game,
      _id: 1,
      Phase: { t: 'enum', c: 'forge.game.phase.PhaseType', v: name },
      PlayerTurn: { t: 'int', v: playerTurn },
    },
  });

/** Send a known-good act and require it to be the first thing the server got. */
async function barrier(s: ReplayServer, m: LiveMatch, id: number): Promise<void> {
  await sendAndApply(s, m, [prompt('barrier'), actionable([id])]);
  expect(selectCard(m, id)).toBe(true);
  await until('the barrier act', () => s.clientFrames().length >= 1);
  expect(s.clientFrames()).toEqual([cardAct(id)]);
}

describe('clicking the board: only what Forge offered', () => {

  /*
   * THE mutation target for Wave 19 §B item 1 (the operator's #1 complaint).
   * The old code answered "Forge has named nothing" with "then offer
   * everything", and this is the case that says otherwise.
   */
  it('Forge has named nothing: an input is live and the board offers NOTHING', async () => {
    const { s, m } = await fullGame();
    const { mine, theirs } = ids(m);
    // Forge's input has shown itself — prompt and an enabled bar — but it has
    // sent neither a selection nor an actionable set.
    await sendAndApply(s, m, [prompt('Priority'), bar(true)]);
    expect(m.inputLive).toBe(true);
    expect(m.selectables).toBeNull();
    expect(m.weaklySelectable).toBeNull();

    const open = boardInteraction(m);
    expect(open.selectable.size).toBe(0);
    expect(open.selectablePlayers.size).toBe(0);
    // Every card the seat can see, and every player: none of them is offered.
    for (const id of [...mine, ...theirs]) expect(open.selectable.has(id)).toBe(false);
    for (const p of m.view!.players) expect(open.selectablePlayers.has(p.id)).toBe(false);
    expect(selectCard(m, mine[0]!)).toBe(false);
    expect(selectPlayer(m, 1)).toBe(false);
    await barrier(s, m, theirs[0]!);
  });

  it('setWeaklySelectable is Forge’s answer at priority: exactly those cards, and no player', async () => {
    const { s, m } = await fullGame();
    const { mine, theirs } = ids(m);
    // Forge weights its list — a card twice when the auto-tap preview names it
    // too. Membership is all a board needs, and a duplicate is not two cards.
    await sendAndApply(s, m, [prompt('Priority'), actionable([mine[0]!, mine[0]!, theirs[0]!])]);
    expect(m.weaklySelectable).toEqual(new Set([mine[0], theirs[0]]));
    const open = boardInteraction(m);
    expect(open.selectable).toEqual(new Set([mine[0], theirs[0]]));
    expect(open.selectablePlayers.size).toBe(0);
    expect(selectCard(m, mine[1]!)).toBe(false);
    expect(selectCard(m, mine[0]!)).toBe(true);
    await until('the act', () => s.clientFrames().length === 1);
    expect(s.clientFrames()).toEqual([cardAct(mine[0]!)]);
  });

  it('an EMPTY actionable set is Forge saying "nothing here", not "I have not spoken"', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    await sendAndApply(s, m, [prompt('Priority'), actionable([])]);
    expect(m.weaklySelectable).toEqual(new Set());
    expect(boardInteraction(m).selectable.size).toBe(0);
    expect(selectCard(m, mine[0]!)).toBe(false);
    await barrier(s, m, mine[1]!);
  });

  it('clearWeaklySelectable ends the offer, and leaves the bar where it is', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    await sendAndApply(s, m, [prompt('Priority'), bar(true), actionable([mine[0]!])]);
    expect(boardInteraction(m).selectable).toEqual(new Set([mine[0]]));

    await sendAndApply(s, m, [clearActionable()]);
    expect(m.weaklySelectable).toBeNull();
    expect(boardInteraction(m).selectable.size).toBe(0);
    expect(selectCard(m, mine[0]!)).toBe(false);
    // The input has not been answered, so the bar Forge sent is still pressable.
    expect(m.inputLive).toBe(true);
    expect(pressButton(m, 'ok')).toBe(true);
    await until('the press', () => s.clientFrames().length === 1);
    expect(s.clientFrames().map((f) => (f.ok && 'method' in f.value ? f.value.method : null))).toEqual(['selectButtonOk']);
  });

  it('a card Forge dropped from the view is not offered, whichever list still names it', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    await sendAndApply(s, m, [prompt('Priority'), actionable([mine[0]!, 999_999])]);
    expect(m.weaklySelectable!.has(999_999)).toBe(true);
    expect(boardInteraction(m).selectable).toEqual(new Set([mine[0]]));
    expect(selectCard(m, 999_999)).toBe(false);
    await barrier(s, m, mine[1]!);
  });

  it('setSelectables is held with its min and max, REPLACED by the next set, and dropped by clearSelectables', async () => {
    const { s, m } = await fullGame();
    const { mine, theirs } = ids(m);
    await sendAndApply(s, m, [selectables([mine[0]!, theirs[0]!], 1, 2)]);
    expect(m.selectables).toEqual({ cards: new Set([mine[0], theirs[0]]), min: 1, max: 2, players: null });
    expect(boardInteraction(m).selectable).toEqual(new Set([mine[0], theirs[0]]));

    await sendAndApply(s, m, [selectables([mine[1]!], 0, 1)]);
    expect(m.selectables).toEqual({ cards: new Set([mine[1]]), min: 0, max: 1, players: null });
    expect(boardInteraction(m).selectable).toEqual(new Set([mine[1]]));

    await sendAndApply(s, m, [clear()]);
    expect(m.selectables).toBeNull();
    expect(boardInteraction(m).selectable.size).toBe(0);
  });

  it('a selection OUTRANKS the actionable set: only Forge’s targets, and the players a selection takes', async () => {
    const { s, m } = await fullGame();
    const { mine, theirs } = ids(m);
    await sendAndApply(s, m, [prompt('Priority'), actionable([mine[0]!, mine[1]!])]);
    expect(boardInteraction(m).selectablePlayers.size).toBe(0);

    // The spell is cast; Forge's targeting input opens.
    await sendAndApply(s, m, [selectables([theirs[0]!], 1, 1)]);
    const open = boardInteraction(m);
    expect(open.selectable).toEqual(new Set([theirs[0]]));
    expect(open.selectablePlayers).toEqual(new Set(m.view!.players.map((p) => p.id)));
    expect(selectCard(m, mine[0]!)).toBe(false);
    await barrier(s, m, theirs[0]!);
  });

  it('a click on a selectable Forge has CLEARED sends nothing', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    await sendAndApply(s, m, [prompt('Select targets'), selectables([mine[0]!], 1, 1), clear()]);
    expect(selectCard(m, mine[0]!)).toBe(false);
    await barrier(s, m, mine[1]!);
  });

  it('a click on a card only the REPLACED set held sends nothing', async () => {
    const { s, m } = await fullGame();
    const { mine, theirs } = ids(m);
    await sendAndApply(s, m, [selectables([mine[0]!, theirs[0]!], 1, 1), selectables([theirs[0]!], 1, 1)]);
    expect(selectCard(m, mine[0]!)).toBe(false);
    expect(selectCard(m, theirs[0]!)).toBe(true);
    await until('the act', () => s.clientFrames().length === 1);
    expect(s.clientFrames()).toEqual([cardAct(theirs[0]!)]);
  });

  it('a card clicked is spent until Forge speaks again: a double click sends once', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    await sendAndApply(s, m, [prompt('Priority'), actionable([mine[0]!, mine[1]!])]);
    expect(selectCard(m, mine[0]!)).toBe(true);
    expect(selectCard(m, mine[0]!)).toBe(false);
    // Another card Forge named is still Forge's to judge: an ignored click gets no answer.
    expect(selectCard(m, mine[1]!)).toBe(true);
    await until('two acts', () => s.clientFrames().length === 2);
    expect(s.clientFrames()).toEqual([cardAct(mine[0]!), cardAct(mine[1]!)]);

    await sendAndApply(s, m, [prompt('Priority again')]);
    expect(selectCard(m, mine[0]!)).toBe(true);
    await until('the third act', () => s.clientFrames().length === 3);
    expect(m.stats.replies).toBe(3);
  });

  it('nothing is clicked while a question is open, before Forge has shown an input, or for an id not on the board', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    expect(selectCard(m, mine[0]!)).toBe(false);
    expect(selectPlayer(m, 1)).toBe(false);
    await sendAndApply(s, m, [prompt('Priority'), bar(true), actionable([mine[0]!]), optionAsk('c-open')]);
    expect(boardInteraction(m).selectable.size).toBe(0);
    expect(selectCard(m, mine[0]!)).toBe(false);
    expect(pressButton(m, 'ok')).toBe(false);
    expect(answerAsk(m, 'c-open', 'showOptionDialog', 0)).toBe(true);
    await until('the reply', () => s.clientFrames().length === 1);
    expect(selectCard(m, 999_999)).toBe(false);
    expect(selectCard(m, mine[0]!)).toBe(true);
    await until('the act', () => s.clientFrames().length === 2);
    expect(s.clientFrames().map((f) => (f.ok && 'method' in f.value ? f.value.method : null))).toEqual(['showOptionDialog', 'selectCard']);
  });

  it('a button press spends the whole input: no click until Forge shows the next one', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    await sendAndApply(s, m, [prompt('Priority'), bar(true), actionable([mine[0]!])]);
    expect(pressButton(m, 'ok')).toBe(true);
    expect(selectCard(m, mine[0]!)).toBe(false);
    await until('the press', () => s.clientFrames().length === 1);
    await sendAndApply(s, m, [prompt('Next'), bar(true), actionable([mine[0]!])]);
    expect(selectCard(m, mine[0]!)).toBe(true);
    await until('the click', () => s.clientFrames().length === 2);
    expect(s.clientFrames().map((f) => (f.ok && 'method' in f.value ? f.value.method : null))).toEqual(['selectButtonOk', 'selectCard']);
  });

  it('selectPlayer carries the player, and a snapshot is followed by the selection the server re-sends', async () => {
    const { s, m } = await fullGame();
    const { theirs } = ids(m);
    await sendAndApply(s, m, [prompt('Target'), selectables([theirs[0]!], 1, 1)]);
    expect(selectPlayer(m, 1)).toBe(true);
    expect(selectPlayer(m, 1)).toBe(false);
    await until('the act', () => s.clientFrames().length === 1);
    expect(s.clientFrames()[0]).toEqual({
      ok: true,
      value: { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: 1 }, triggerEvent: null },
    });

    s.lose(prompt('lost'));
    s.send(prompt('after the gap'));
    await until('the resync', () => m.stats.snapshots === 2);
    // Wave 31 §S (P10): the snapshot clears what the client held, and the
    // server then re-sends the open selection as normal frames — a reload with a
    // selection open is no longer a soft-lock.
    await until('the selection to be re-sent', () => m.selectables !== null);
    expect([...m.selectables!.cards]).toEqual([theirs[0]]);
    expect(m.weaklySelectable).toBeNull();
    expect(selectCard(m, theirs[0]!)).toBe(true);
  });
});

/*
 * `nothingToDecide` — wave 35 §S shape 3. Three states for `weaklySelectable`
 * (null, empty, non-empty) and two for `selectables`/`asks`, and only ONE
 * combination is "nothing to decide": no ask, no selection, and Forge's
 * actionable set explicitly empty.
 */
describe('nothingToDecide: the one state End Turn gets highlighted from (R5)', () => {
  // The fixture is the viewer's own MAIN1 with an untapped Fire Urchin, a state
  // in which attacking is still to come (`attackersLeft`). Every case below
  // moves to MAIN2 first, so it tests its own reason and not that one.
  const viewerId = (m: LiveMatch) => m.view!.players.find((p) => p.isViewer)!.id;
  const pastAttackers = (m: LiveMatch) => phase('MAIN2', viewerId(m));

  it('false before any state has folded at all', () => {
    // No snapshot has landed, so every field this reads still holds its unset
    // default — `view` most of all, which is the guard that keeps them from
    // agreeing for the wrong reason.
    const inert: MatchTransport = { on: () => {}, emit: () => {}, request: () => {}, disconnect: () => {} };
    const m = startMatch({ matchId: 'nobody-joined-yet', transport: inert });
    expect(m.view).toBeNull();
    expect(nothingToDecide(m)).toBe(false);
    closeMatch(m);
  });

  it('false when Forge has named nothing yet (weaklySelectable is null, not empty)', async () => {
    const { m } = await fullGame();
    expect(m.weaklySelectable).toBeNull();
    expect(nothingToDecide(m)).toBe(false);
  });

  it('false while a selection is open, even with an empty actionable set underneath', async () => {
    const { s, m } = await fullGame();
    const { theirs } = ids(m);
    await sendAndApply(s, m, [pastAttackers(m), prompt('Priority'), actionable([])]);
    expect(nothingToDecide(m)).toBe(true);
    await sendAndApply(s, m, [selectables([theirs[0]!], 1, 1)]);
    expect(m.selectables).not.toBeNull();
    expect(nothingToDecide(m)).toBe(false);
    await barrier(s, m, theirs[0]!);
  });

  it('false while an ask is open, even with an empty actionable set underneath', async () => {
    const { s, m } = await fullGame();
    await sendAndApply(s, m, [pastAttackers(m), prompt('Priority'), actionable([])]);
    expect(nothingToDecide(m)).toBe(true);
    await sendAndApply(s, m, [optionAsk('ask-1')]);
    expect(currentAsk(m)).not.toBeNull();
    expect(nothingToDecide(m)).toBe(false);
    expect(abortAsk(m, 'ask-1', 'cancelled', 'test cleanup')).toBe(true);
  });

  it('false when Forge named at least one actionable NON-land card', async () => {
    const { s, m } = await fullGame();
    const nonLand = myNonLand(m);
    await sendAndApply(s, m, [pastAttackers(m), prompt('Priority'), actionable([nonLand])]);
    expect(nothingToDecide(m)).toBe(false);
    await barrier(s, m, nonLand);
  });

  it('true at a priority window with no open ask, no selection, and an explicit empty actionable set', async () => {
    const { s, m } = await fullGame();
    const nonLand = myNonLand(m);
    await sendAndApply(s, m, [pastAttackers(m), prompt('Priority'), bar(true), actionable([])]);
    expect(m.asks.length).toBe(0);
    expect(m.selectables).toBeNull();
    expect(m.weaklySelectable).toEqual(new Set());
    expect(nothingToDecide(m)).toBe(true);
    // And it goes false again the instant Forge names something that is NOT
    // one of the viewer's own lands.
    await sendAndApply(s, m, [actionable([nonLand])]);
    expect(nothingToDecide(m)).toBe(false);
  });

  it('clearWeaklySelectable un-decides it: Forge stopped saying "nothing", it did not start saying "something"', async () => {
    const { s, m } = await fullGame();
    await sendAndApply(s, m, [pastAttackers(m), prompt('Priority'), actionable([])]);
    expect(nothingToDecide(m)).toBe(true);
    await sendAndApply(s, m, [clearActionable()]);
    expect(m.weaklySelectable).toBeNull();
    expect(nothingToDecide(m)).toBe(false);
  });

  /*
   * Lane F's land-tapping fix (wave 35) put every untapped land with a mana
   * ability into `weaklySelectable` at ordinary priority — so an actionable
   * set naming ONLY the viewer's own battlefield lands is now the common
   * case, not "Forge found nothing", and must still read as "nothing to
   * decide" or End Turn would almost never highlight on the viewer's own
   * turn. The approximation is scoped tightly: a land anywhere OTHER than
   * the viewer's own battlefield (their hand, the opponent's board) is still
   * a real decision.
   */
  it('true when the actionable set names ONLY the viewer’s own battlefield land(s)', async () => {
    const { s, m } = await fullGame();
    const land = myLand(m);
    await sendAndApply(s, m, [pastAttackers(m), prompt('Priority'), actionable([land])]);
    expect(nothingToDecide(m)).toBe(true);
    await barrier(s, m, land);
  });

  it('false for a land on the OPPONENT’s battlefield — only the viewer’s OWN battlefield lands are ignored', async () => {
    const { s, m } = await fullGame();
    const { theirs } = ids(m);
    await sendAndApply(s, m, [pastAttackers(m), prompt('Priority'), actionable([theirs[0]!])]);
    expect(nothingToDecide(m)).toBe(false);
    await barrier(s, m, theirs[0]!);
  });

  it('false for a castable creature in hand', async () => {
    const { s, m } = await fullGame();
    const creature = myHandCard(m, false);
    await sendAndApply(s, m, [pastAttackers(m), prompt('Priority'), actionable([creature])]);
    expect(nothingToDecide(m)).toBe(false);
    await barrier(s, m, creature);
  });
  // The operator, 2026-10-03: "the 'End Turn' button shouldn't be showing
  // flashing if i have creatures that can still attack."
  it('false in the viewer\'s own MAIN1 with a creature that can still attack, even with only lands actionable', async () => {
    const { s, m } = await fullGame();
    const land = myLand(m);
    await sendAndApply(s, m, [phase('MAIN1', viewerId(m)), prompt('Priority'), actionable([land])]);
    expect(attackersLeft(m.view!)).toBe(true);
    expect(nothingToDecide(m)).toBe(false);
    await barrier(s, m, land);
  });

  it('attackersLeft: only the viewer\'s own turn, before attackers, with an untapped, unsick, non-Defender creature', async () => {
    const { s, m } = await fullGame();
    await sendAndApply(s, m, [phase('MAIN1', viewerId(m))]);
    const view = m.view!;
    expect(attackersLeft(view)).toBe(true);
    const withMine = (f: (c: BoardView['players'][number]['battlefield'][number]) => object): BoardView => ({
      ...view,
      players: view.players.map((p) => (p.isViewer ? { ...p, battlefield: p.battlefield.map((c) => ({ ...c, ...f(c) })) } : p)),
    });
    expect(attackersLeft(withMine(() => ({ tapped: true }))), 'tapped').toBe(false);
    expect(attackersLeft(withMine(() => ({ summoningSick: true }))), 'summoning sick').toBe(false);
    expect(attackersLeft(withMine((c) => ({ keywords: [...(c.keywords ?? []), 'Defender'] }))), 'Defender').toBe(false);
    for (const later of ['COMBAT_DECLARE_ATTACKERS', 'MAIN2', 'END_OF_TURN']) {
      expect(attackersLeft({ ...view, phase: later }), later).toBe(false);
    }
    const theirTurn: BoardView = { ...view, players: view.players.map((p) => ({ ...p, isActive: !p.isViewer })) };
    expect(attackersLeft(theirTurn), 'the opponent\'s turn').toBe(false);
  });

});

/*
 * `setHighlighted` — the third entity frame, Wave 22 lane L.
 *
 * `InputLondonMulligan` publishes no selection and no actionable set; the only
 * thing it says per-card is this mark (`InputLondonMulligan.java:138,144`), and
 * the bridge used to drop it, so the seat was left with prose and an OK/Auto bar
 * and nothing to click — the operator's report.
 *
 * The mutation targets, in order: delete the `setHighlighted` arm of
 * `applyFrame` and the first two fail; fold `highlighted` into `selectables`
 * instead of keeping it beside, and the fourth fails.
 */
describe('setHighlighted: Forge’s mark is offered, and never widens an offer', () => {
  it('a mark makes exactly those cards clickable when Forge has named nothing else', async () => {
    const { s, m } = await fullGame();
    const { mine, theirs } = ids(m);
    // The London mulligan's shape: prose, the OK/Auto pair, no selection, no
    // actionable set. Before the mark there is nothing to click.
    await sendAndApply(s, m, [prompt('Return 1 card(s) to the bottom of your library'), bar(false)]);
    expect(boardInteraction(m).selectable.size).toBe(0);

    await sendAndApply(s, m, [mark([mine[0]!])]);
    expect(m.highlighted).toEqual(new Set([mine[0]]));
    expect(m.selectables).toBeNull();
    expect(m.weaklySelectable).toBeNull();
    const open = boardInteraction(m);
    expect(open.selectable).toEqual(new Set([mine[0]]));
    // A mark is not the selection signal, so it offers no player either.
    expect(open.selectablePlayers.size).toBe(0);
    expect(selectCard(m, theirs[0]!)).toBe(false);
    expect(selectCard(m, mine[0]!)).toBe(true);
    await until('the act', () => s.clientFrames().length === 1);
    expect(s.clientFrames()).toEqual([cardAct(mine[0]!)]);
  });

  it('un-marking takes it back, one card at a time, and the set FOLDS rather than replacing', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    await sendAndApply(s, m, [prompt('Return 2 card(s) to the bottom of your library')]);
    // Forge marks one card per accepted click, so a second frame must ADD.
    await sendAndApply(s, m, [mark([mine[0]!]), mark([mine[1]!])]);
    expect(m.highlighted).toEqual(new Set([mine[0], mine[1]]));
    expect(boardInteraction(m).selectable).toEqual(new Set([mine[0], mine[1]]));

    await sendAndApply(s, m, [mark([mine[0]!], false)]);
    expect(m.highlighted).toEqual(new Set([mine[1]]));
    expect(boardInteraction(m).selectable).toEqual(new Set([mine[1]]));
    expect(selectCard(m, mine[0]!)).toBe(false);

    // `resetCardHighlights` un-marks the whole set at once (`:144`).
    await sendAndApply(s, m, [mark([mine[0]!, mine[1]!], false)]);
    expect(m.highlighted).toEqual(new Set());
    expect(boardInteraction(m).selectable.size).toBe(0);
    await barrier(s, m, mine[1]!);
  });

  it('clearSelectables still clears, and drops the marks of the input that stopped', async () => {
    const { s, m } = await fullGame();
    const { mine, theirs } = ids(m);
    await sendAndApply(s, m, [prompt('Select targets'), selectables([theirs[0]!], 1, 1), mark([theirs[0]!])]);
    expect(m.selectables).toEqual({ cards: new Set([theirs[0]]), min: 1, max: 1, players: null });
    expect(m.highlighted).toEqual(new Set([theirs[0]]));

    await sendAndApply(s, m, [clear()]);
    expect(m.selectables).toBeNull();
    expect(m.highlighted).toBeNull();
    expect(boardInteraction(m).selectable.size).toBe(0);
    expect(selectCard(m, theirs[0]!)).toBe(false);
    await barrier(s, m, mine[1]!);
  });

  it('a mark does NOT widen a real setSelectables — the offer wins', async () => {
    const { s, m } = await fullGame();
    const { mine, theirs } = ids(m);
    // Forge's selection offers one card; its mark names a card the selection
    // does not (a target already chosen, `InputSelectManyBase.java:127`).
    await sendAndApply(s, m, [prompt('Select targets'), selectables([theirs[0]!], 1, 1), mark([mine[0]!])]);
    expect(m.highlighted).toEqual(new Set([mine[0]]));
    expect(boardInteraction(m).selectable).toEqual(new Set([theirs[0]]));
    expect(selectCard(m, mine[0]!)).toBe(false);
    expect(selectCard(m, theirs[0]!)).toBe(true);
    await until('the act', () => s.clientFrames().length === 1);
    expect(s.clientFrames()).toEqual([cardAct(theirs[0]!)]);
  });

  it('outside a selection a mark joins the actionable set rather than replacing it', async () => {
    const { s, m } = await fullGame();
    const { mine, theirs } = ids(m);
    await sendAndApply(s, m, [prompt('Declare attackers'), actionable([mine[0]!]), mark([mine[1]!])]);
    expect(boardInteraction(m).selectable).toEqual(new Set([mine[0], mine[1]]));
    expect(selectCard(m, theirs[0]!)).toBe(false);
    await barrier(s, m, theirs[0]!);
  });

  it('a marked card the seat cannot see is not offered, and a marked PLAYER is not a click', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    await sendAndApply(s, m, [
      prompt('Return 1 card(s) to the bottom of your library'),
      mark([mine[0]!, 999_999]),
      highlight([{ kind: 'player', id: 1 }], true),
    ]);
    // The wire carried the player; the offered set is cards only, and the view
    // is still the hidden-information boundary.
    expect(m.highlighted).toEqual(new Set([mine[0], 999_999]));
    expect(boardInteraction(m).selectable).toEqual(new Set([mine[0]]));
    expect(boardInteraction(m).selectablePlayers.size).toBe(0);
    expect(selectCard(m, 999_999)).toBe(false);
    expect(selectPlayer(m, 1)).toBe(false);
    await barrier(s, m, mine[1]!);
  });

  it('a snapshot is followed by the marks too — the server re-sends them', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    await sendAndApply(s, m, [prompt('Return 1 card(s) to the bottom of your library'), mark([mine[0]!])]);
    expect(boardInteraction(m).selectable).toEqual(new Set([mine[0]]));

    s.lose(prompt('lost'));
    s.send(prompt('after the gap'));
    await until('the resync', () => m.stats.snapshots === 2);
    await until('the marks to be re-sent', () => m.highlighted !== null);
    expect([...m.highlighted!]).toEqual([mine[0]]);
    expect(selectCard(m, mine[0]!)).toBe(true);
  });
});

/*
 * The London mulligan — the operator's item #7, closed.
 *
 * `InputLondonMulligan` publishes no selection, no actionable set, and marks a
 * card only after a click it already accepted, so nothing above starts the
 * loop. What Forge DOES publish is `GameView.Mulligan`
 * (`InputLondonMulligan.java:60`, cleared at `:105`), on the state channel; and
 * the cards that input accepts are exactly the seat's own hand (`:113`,
 * `player.getZone(ZoneType.Hand).contains(c0)`).
 *
 * Two of these are hidden-information tests and they are the ones to keep: the
 * OPPONENT's hand ids are in this client's folded state (Forge's stream carries
 * zone lists as ids, and `visibility.ts` redacts faces, not lists), so "only the
 * viewer's own hand" is a claim with something real to get wrong.
 *
 * Mutation target: delete `mulliganHand`'s term from `boardInteraction`'s
 * `union` — every positive case below fails.
 */
describe('the London mulligan: Forge’s own flag makes the seat’s own hand clickable', () => {
  /** The one `GameView`'s delta key, dug out of the folded state rather than guessed. */
  function gameEntry(m: LiveMatch): { key: string; id: number } {
    for (const [key, obj] of m.state) {
      if (obj._type === WireType.Game) return { key, id: obj._id };
    }
    throw new Error('no GameView in the folded state');
  }

  let seq = 900;
  /** A state-channel delta setting `GameView.Mulligan`. `null` is Forge's "back to the default". */
  function mulligan(m: LiveMatch, on: boolean | null): ServerFrame {
    const { key, id } = gameEntry(m);
    const value: Tagged | null = on === null ? null : { t: 'bool', v: on };
    return parseServerFrame({
      kind: 'notify',
      method: 'applyDelta',
      payload: {
        packet: {
          seq: (seq += 1),
          checksum: 0,
          checksumProperties: [],
          newObjects: {},
          objectDeltas: { [key]: { _type: WireType.Game, _id: id, Mulligan: value } },
          events: [],
        },
      },
    });
  }

  /** The viewer's hand, from the view. */
  function myHand(m: LiveMatch): number[] {
    const me = m.view!.players.find((p) => p.isViewer)!;
    expect(me.hand).not.toBeNull();
    expect(me.hand!.length).toBeGreaterThan(1);
    return me.hand!.map((c) => c.id);
  }

  /**
   * The OPPONENT's hand ids, read out of the raw folded state. The view does not
   * expose them (`hand` is null for anyone but the viewer) — which is the point:
   * this client HOLDS these ids and must never offer them.
   */
  function theirHand(m: LiveMatch): number[] {
    const them = m.view!.players.find((p) => !p.isViewer)!;
    expect(them.hand).toBeNull();
    const obj = m.state.get(deltaKey(WireType.Player, them.id))!;
    const list = obj.Hand;
    expect(typeof list === 'object' && list !== null && (list.t === 'list' || list.t === 'set')).toBe(true);
    const ids = (list as { v: Tagged[] }).v.map((e) => (e as { v: number }).v);
    expect(ids).toHaveLength(them.handCount);
    expect(ids.length).toBeGreaterThan(0);
    return ids;
  }

  it('while Mulligan is up the seat’s own hand is clickable, and a click reaches Forge', async () => {
    const { s, m } = await fullGame();
    const hand = myHand(m);
    // Exactly the frames InputLondonMulligan.showMessage sends: the flag, then
    // the prose, then the OK/Auto pair. No selection, no actionable set.
    await sendAndApply(s, m, [
      mulligan(m, true),
      prompt('Return 1 card(s) to the bottom of your library'),
      bar(false),
    ]);
    expect(m.selectables).toBeNull();
    expect(m.weaklySelectable).toBeNull();
    expect(m.highlighted).toBeNull();

    const open = boardInteraction(m);
    expect(open.selectable).toEqual(new Set(hand));
    // Still no player: the mulligan takes cards, and nothing published says
    // otherwise.
    expect(open.selectablePlayers.size).toBe(0);
    expect(selectCard(m, hand[0]!)).toBe(true);
    await until('the act', () => s.clientFrames().length === 1);
    expect(s.clientFrames()).toEqual([cardAct(hand[0]!)]);

    // Forge answers an accepted click with the mark, which un-spends the card so
    // the seat can click it again to take it back. That is the whole loop.
    await sendAndApply(s, m, [mark([hand[0]!]), prompt('Return 0 card(s) to the bottom of your library'), bar(true)]);
    expect(m.highlighted).toEqual(new Set([hand[0]]));
    expect(boardInteraction(m).selectable).toEqual(new Set(hand));
    expect(selectCard(m, hand[0]!)).toBe(true);
  });

  it('ONLY the viewer’s own hand: the opponent’s hand ids are held and never offered', async () => {
    const { s, m } = await fullGame();
    const hand = myHand(m);
    const hidden = theirHand(m);
    await sendAndApply(s, m, [mulligan(m, true), prompt('Return 2 card(s) to the bottom of your library')]);

    const open = boardInteraction(m);
    expect(open.selectable).toEqual(new Set(hand));
    for (const id of hidden) {
      expect(open.selectable.has(id)).toBe(false);
      expect(selectCard(m, id)).toBe(false);
    }
    await barrier(s, m, hand[1]!);
  });

  it('the HAND only — not the battlefield, graveyard or exile the seat can also see', async () => {
    const { s, m } = await fullGame();
    const hand = myHand(m);
    await sendAndApply(s, m, [mulligan(m, true), prompt('Return 1 card(s) to the bottom of your library')]);

    const open = boardInteraction(m);
    const me = m.view!.players.find((p) => p.isViewer)!;
    const elsewhere = [...me.battlefield, ...me.graveyard, ...me.exile].map((c) => c.id);
    expect(elsewhere.length).toBeGreaterThan(0);
    for (const id of elsewhere) expect(open.selectable.has(id)).toBe(false);
    expect(open.selectable).toEqual(new Set(hand));
    // The opponent's battlefield is visible and is not part of a mulligan either.
    for (const id of ids(m).theirs) expect(open.selectable.has(id)).toBe(false);
    await barrier(s, m, hand[0]!);
  });

  it('it ends when Forge clears the flag — both as false and as a deleted property', async () => {
    const { s, m } = await fullGame();
    const hand = myHand(m);
    await sendAndApply(s, m, [mulligan(m, true), prompt('Return 1 card(s) to the bottom of your library')]);
    expect(boardInteraction(m).selectable).toEqual(new Set(hand));

    await sendAndApply(s, m, [mulligan(m, false)]);
    expect(boardInteraction(m).selectable.size).toBe(0);
    expect(selectCard(m, hand[0]!)).toBe(false);

    await sendAndApply(s, m, [mulligan(m, true)]);
    expect(boardInteraction(m).selectable).toEqual(new Set(hand));

    // `updateIsMulligan(false)` reaches us as a DELETE, because Forge drops a
    // property that equals its default (`fold.ts` rule 3).
    await sendAndApply(s, m, [mulligan(m, null)]);
    expect(boardInteraction(m).selectable.size).toBe(0);
    expect(selectCard(m, hand[0]!)).toBe(false);
    await barrier(s, m, hand[0]!);
  });

  it('a real setSelectables still wins outright while the flag is up', async () => {
    const { s, m } = await fullGame();
    const hand = myHand(m);
    const { theirs } = ids(m);
    await sendAndApply(s, m, [
      mulligan(m, true),
      prompt('Select targets'),
      selectables([theirs[0]!], 1, 1),
    ]);
    expect(boardInteraction(m).selectable).toEqual(new Set([theirs[0]]));
    for (const id of hand) expect(selectCard(m, id)).toBe(false);
    expect(selectCard(m, theirs[0]!)).toBe(true);
    await until('the act', () => s.clientFrames().length === 1);
    expect(s.clientFrames()).toEqual([cardAct(theirs[0]!)]);
  });

  it('the offer SURVIVES a resync — the flag is state, and the server re-sends the mark (wave 31 §S)', async () => {
    const { s, m } = await fullGame();
    const hand = myHand(m);
    await sendAndApply(s, m, [mulligan(m, true), prompt('Return 1 card(s) to the bottom of your library'), mark([hand[0]!])]);
    expect(boardInteraction(m).selectable).toEqual(new Set(hand));

    s.lose(prompt('lost'));
    s.send(prompt('after the gap'));
    await until('the resync', () => m.stats.snapshots === 2);
    // The snapshot itself drops the held mark (`adoptSnapshot`), and the server
    // then re-sends it: the London bottom pick is a mark, and before wave 31
    // nothing re-sent it, so a reload with it open was a soft-lock (P10).
    await until('the mark to be re-sent', () => m.highlighted !== null);
    expect([...m.highlighted!]).toEqual([hand[0]]);
    expect(m.selectables).toBeNull();
    expect(m.weaklySelectable).toBeNull();
    expect(boardInteraction(m).selectable).toEqual(new Set(hand));
    expect(selectCard(m, hand[0]!)).toBe(true);
  });

  it('the flag alone is not an affordance: nothing is offered until Forge shows an input', async () => {
    const { s, m } = await fullGame();
    const hand = myHand(m);
    await sendAndApply(s, m, [mulligan(m, true)]);
    expect(m.inputLive).toBe(false);
    expect(boardInteraction(m).selectable.size).toBe(0);
    expect(selectCard(m, hand[0]!)).toBe(false);
    await barrier(s, m, hand[0]!);
  });
});

/*
 * The says (`message` notifies) and the full-control toggle — Wave 19's §C.2
 * observability and §C.4 escape hatch, client side.
 *
 * The case that matters is the negative one: a `message` frame is DISPLAY
 * ONLY. It must not make anything clickable, unspend a click, answer an ask,
 * or send anything — the board's whole discipline is that only Forge's two
 * offered sets are affordances, and a say is not one of them.
 */
describe('the says, and full control', () => {
  const says = (text: string) =>
    parseServerFrame({ kind: 'notify', method: 'message', message: text, title: '' });

  /*
   * `SAYS_KEPT` used to be 8, mirroring the server's own per-seat cap, and the
   * panel showed nothing further back than that. This proves the client's own
   * cap is now generous enough that a full game's worth of lines (well past
   * the old eight) all survive, newest last.
   */
  it('holds a generous history, not the server’s old eight', async () => {
    const { s, m } = await fullGame();
    const n = 40;
    await sendAndApply(
      s,
      m,
      Array.from({ length: n }, (_, i) => says(`line ${i + 1}`)),
    );
    expect(m.says).toHaveLength(n);
    expect(m.says[0]).toBe('line 1');
    expect(m.says.at(-1)).toBe(`line ${n}`);
  });

  it('is still bounded, so a very long game cannot grow the log forever', async () => {
    const { s, m } = await fullGame();
    // Fill to exactly the cap in ONE round trip (`sendAndApply` sends the
    // whole batch, then waits once), rather than one await per line — the cap
    // is 2000, and a per-line await would make this test absurdly slow.
    const filler = Array.from({ length: SAYS_KEPT - 1 }, (_, i) => says(`filler ${i}`));
    await sendAndApply(s, m, [says('before the cap'), ...filler]);
    expect(m.says).toHaveLength(SAYS_KEPT);
    expect(m.says[0]).toBe('before the cap');
    // One more line past the cap: the oldest line is the one that goes.
    await sendAndApply(s, m, [says('one too many')]);
    expect(m.says).toHaveLength(SAYS_KEPT);
    expect(m.says).not.toContain('before the cap');
    expect(m.says.at(-1)).toBe('one too many');
  });

  it('a say with no text is not a line', async () => {
    const { s, m } = await fullGame();
    await sendAndApply(s, m, [says(''), says('auto-passed Upkeep step')]);
    expect(m.says).toEqual(['auto-passed Upkeep step']);
  });

  it('a snapshot clears the log, and the lines that come after it refill it', async () => {
    const { s, m } = await fullGame();
    await sendAndApply(s, m, [says('auto-passed Upkeep step'), says('paid U — Volcanic Island')]);
    expect(m.says).toHaveLength(2);

    s.lose(says('lost')); // a gap: the client must resync, and the server re-sends its kept says
    s.send(says('after the gap'));
    await until('the resync', () => m.stats.snapshots === 2);
    expect(m.says).toEqual([]);
    await sendAndApply(s, m, [says('auto-passed Draw step')]);
    expect(m.says).toEqual(['auto-passed Draw step']);
  });

  it('a message frame offers nothing, answers nothing, and spends nothing — it is display only', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    await sendAndApply(s, m, [prompt('Priority'), bar(true), actionable([mine[0]!])]);
    expect(selectCard(m, mine[0]!)).toBe(true);
    await until('the act', () => s.clientFrames().length === 1);
    const before = boardInteraction(m);
    expect(before.selectable.size).toBe(0); // mine[0] is spent; nothing else was offered

    await sendAndApply(s, m, [says('auto-passed Upkeep step')]);
    expect(m.says).toEqual(['auto-passed Upkeep step']);
    const after = boardInteraction(m);
    expect(after.selectable).toEqual(before.selectable);
    expect(after.selectablePlayers).toEqual(before.selectablePlayers);
    expect(m.inputLive).toBe(true);
    expect(m.spent.cards.has(mine[0]!)).toBe(true);
    expect(m.asks).toEqual([]);
    // And nothing was sent on the say's own account: the next legitimate act
    // must be the SECOND frame the server receives (the first was the click
    // above), with nothing between them.
    await sendAndApply(s, m, [prompt('barrier'), actionable([mine[1]!])]);
    expect(selectCard(m, mine[1]!)).toBe(true);
    await until('the barrier act', () => s.clientFrames().length >= 2);
    expect(s.clientFrames()[1]).toEqual(cardAct(mine[1]!));
  });

  it('the full-control toggle sends its event, and only when it changes', async () => {
    const { s, m } = await fullGame();
    expect(m.fullControl).toBe(false);
    expect(setFullControl(m, false)).toBe(false);
    expect(s.received.filter((r) => r.event === MATCH_EVENTS.fullControl)).toEqual([]);

    expect(setFullControl(m, true)).toBe(true);
    expect(m.fullControl).toBe(true);
    expect(setFullControl(m, true)).toBe(false); // already on: nothing crosses
    expect(setFullControl(m, false)).toBe(true);
    expect(m.fullControl).toBe(false);
    await until('both full-control emits', () => s.received.filter((r) => r.event === MATCH_EVENTS.fullControl).length >= 2);

    const seen = s.received.filter((r) => r.event === MATCH_EVENTS.fullControl);
    expect(seen).toEqual([
      { event: MATCH_EVENTS.fullControl, payload: { matchId: s.matchId, on: true } },
      { event: MATCH_EVENTS.fullControl, payload: { matchId: s.matchId, on: false } },
    ]);
    // It is a preference, not a frame: nothing of it crossed forge:c2s.
    expect(s.clientFrames()).toEqual([]);
  });
});

/*
 * The other direction of `forge:full-control` (§C.1). The server holds the
 * seat's preference and no frame carries it, so a refreshed page has no way to
 * know it — it used to draw the toggle off while the server had the seat in
 * full control, and only the next click re-synced it. The server now emits the
 * seat's state on the same event, with the same payload, to the socket it has
 * just answered a snapshot.
 *
 * Stubbed, because the inbound direction is the SERVER's to send and
 * `./replay-server.ts` does not send it (it only records the client's emits).
 * The server's half is `apps/server/src/play/socket.test.ts`'s "full control
 * survives a refresh", over real sockets, which asserts the exact bytes these
 * cases feed in — and asserts they satisfy the same strict schema this handle
 * parses them with, so the two halves cannot drift apart silently.
 */
/*
 * Concede (wave 24, §C.4's wire half).
 *
 * `IGameController.concede` has been on the wire since the beginning
 * (`forge-wire/src/tier-a.ts:52,199-202`) and has never had a sender. Lane C
 * owns the button and the confirmation; this is the send, and the cases below
 * are about what reaches the server and how often.
 */
describe('concede: the wire has always carried it, and now something sends it', () => {
  const concedeAct = { ok: true, value: { kind: 'act', method: 'concede' } };

  it('reaches the wire exactly once per call, and one more call is one more frame', async () => {
    const { s, m } = await fullGame();
    expect(concede(m)).toBe(true);
    await until('the concede act', () => s.clientFrames().length >= 1);
    expect(s.clientFrames()).toEqual([concedeAct]);
    expect(m.stats.replies).toBe(1);

    // Pressed twice (the confirmation double-fired, a key repeated): two calls,
    // two frames, and never one call that sends two.
    expect(concede(m)).toBe(true);
    await until('the second concede act', () => s.clientFrames().length >= 2);
    expect(s.clientFrames()).toEqual([concedeAct, concedeAct]);
    expect(m.stats.replies).toBe(2);
  });

  it('is NOT gated on the board: nothing is offered, nothing is asked, and it still goes', async () => {
    const { s, m } = await fullGame();
    // No prompt, no bar, no selection: `boardInteraction` offers nothing at all
    // and `pressButton` would refuse. Giving up is not an answer to a question.
    expect(boardInteraction(m).selectable.size).toBe(0);
    expect(m.inputLive).toBe(false);
    expect(pressButton(m, 'ok')).toBe(false);

    expect(concede(m)).toBe(true);
    await until('the concede act', () => s.clientFrames().length >= 1);
    expect(s.clientFrames()).toEqual([concedeAct]);
  });

  it('goes with a question still open — leaving the game is not answering it', async () => {
    const { s, m } = await fullGame();
    await sendAndApply(s, m, [confirmAsk('c-concede')]);
    expect(currentAsk(m)!.callId).toBe('c-concede');

    expect(concede(m)).toBe(true);
    await until('the concede act', () => s.clientFrames().length >= 1);
    expect(s.clientFrames()).toEqual([concedeAct]);
    // The ask is untouched: conceding did not answer it, and did not close it.
    expect(currentAsk(m)!.callId).toBe('c-concede');
  });
});

/*
 * `payingMana` — which INPUT Forge is parked on, and the stale bar it must survive.
 *
 * `e2e/play.spec.ts:970-972` pays for a cast spell by dragging a land already on
 * the battlefield; `e2e/table-fit.spec.ts` drags an equally-offered land between
 * rows to arrange it. `selectable` cannot tell those apart. What can is the input,
 * and the trap is that Forge emits `updateButtons` BEFORE `showPromptMessage`
 * (`InputConfirm.java:107-121`) so the BAR lags and can go stale — which is why
 * the load-bearing fact here is the PROMPT's own card, not the button.
 */
describe('payingMana: the payment input, and not a bar that outlived it', () => {
  const payBar = (enable1: boolean) =>
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
  const promptFor = (message: string, cardId: number) =>
    parseServerFrame({
      kind: 'notify',
      method: 'showPromptMessage',
      player: { kind: 'player', id: 0 },
      message,
      card: { kind: 'card', id: cardId },
    });

  it('promptCard is Forge’s third argument, and every prompt overwrites it — including with null', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    expect(m.promptCard).toBeNull();
    await sendAndApply(s, m, [promptFor('Pay {1}{U}', mine[0]!)]);
    expect(m.promptCard).toBe(mine[0]!);
    await sendAndApply(s, m, [prompt('Priority')]);
    expect(m.promptCard).toBeNull();
  });

  it('promptCard travels with the prompt across a snapshot — a resync mid-payment does not stop the payment', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    await sendAndApply(s, m, [payBar(true), promptFor('Pay {1}{U}', mine[0]!)]);
    expect(m.promptCard).toBe(mine[0]!);

    // `adoptSnapshot` keeps `prompt` and `buttons` on purpose — the server
    // re-sends exactly those two (`resendAfterSnapshot`) — so the prompt's CARD
    // belongs with them. Clearing it here would silently stop a payment paying
    // until Forge happened to speak again.
    s.lose(sentinel());
    s.send(sentinel());
    await until('the resync', () => m.stats.snapshots === 2);
    expect(m.prompt).toBe('Pay {1}{U}');
    expect(m.promptCard).toBe(mine[0]!);
    // …but the input is not live until Forge says so, so nothing is a payment yet.
    expect(m.inputLive).toBe(false);
    expect(payingMana(m)).toBe(false);
    await sendAndApply(s, m, [actionable([mine[0]!])]);
    expect(payingMana(m)).toBe(true);
  });

  it('the payment input: the bar names Auto and the prompt names the ability', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    expect(payingMana(m)).toBe(false);
    await sendAndApply(s, m, [payBar(true), promptFor('Pay {1}{U}', mine[0]!), actionable([mine[0]!])]);
    expect(payingMana(m)).toBe(true);
  });

  it('enable1 is the auto-pay OFFER, not the input: a cost that cannot be auto-paid is still a payment', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    // `InputPayMana.java:391` — the input's first bar, Auto present and disabled.
    // Tapping sources by hand is precisely what this window is for, so gating on
    // `enable1` would refuse the gesture exactly when it is needed most.
    await sendAndApply(s, m, [payBar(false), promptFor('Pay {7}', mine[0]!), actionable([mine[0]!])]);
    expect(m.buttons!.enable1).toBe(false);
    expect(payingMana(m)).toBe(true);
  });

  it('THE STALE BAR: an Auto bar that outlived its payment is not a payment', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    await sendAndApply(s, m, [payBar(true), promptFor('Pay {1}{U}', mine[0]!), actionable([mine[0]!])]);
    expect(payingMana(m)).toBe(true);

    // Priority comes back. Its PROMPT names no card; the bar has not caught up.
    await sendAndApply(s, m, [prompt('Priority')]);
    expect(m.buttons!.label1).toBe('Auto');
    expect(m.buttons!.enable1).toBe(true);
    expect(payingMana(m)).toBe(false);
  });

  it('a selection is not a payment, however it announces itself', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    // `InputSelectTargets` / `InputSelectManyBase` also name a card
    // (`InputSelectTargets.java:129`, `InputSelectManyBase.java:92-94`), and the
    // latter's `updateButtons` overload sets only enablement, so an Auto label can
    // still be standing. A payment opens no selection, so this is excluded.
    await sendAndApply(s, m, [payBar(true), promptFor('Choose a target', mine[0]!), selectables([mine[1]!], 1, 1)]);
    expect(m.promptCard).toBe(mine[0]!);
    expect(m.buttons!.label1).toBe('Auto');
    expect(payingMana(m)).toBe(false);
  });

  it('no live input, or a question queued in front of it, is not a payment either', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    await sendAndApply(s, m, [payBar(true), promptFor('Pay {1}{U}', mine[0]!), actionable([mine[0]!])]);
    expect(payingMana(m)).toBe(true);

    // An ask queues in front: nothing on the board is clickable, so nothing here
    // may claim a press either — the same gate `boardInteraction` uses.
    await sendAndApply(s, m, [confirmAsk('c-pay')]);
    expect(payingMana(m)).toBe(false);
    expect(answerConfirm(m, 'c-pay', true)).toBe(true);

    // And `clearSelectables` ends the input outright.
    await sendAndApply(s, m, [clear()]);
    expect(m.inputLive).toBe(false);
    expect(payingMana(m)).toBe(false);
  });

  it('a priority window with its own bar is not a payment, card or no card', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    await sendAndApply(s, m, [bar(true), prompt('Priority'), actionable([mine[0]!])]);
    expect(payingMana(m)).toBe(false);
  });
});

/*
 * Combat, read off the state channel (wave 24 §B.1 and §B.3).
 *
 * The phase and the attackers are structured facts that have been on the wire
 * all along — `GameView.Phase` / `PlayerTurn`, and each card's own `Attacking`.
 * Nothing here reads Forge's prompt text, which is the wave's rule §0b.
 */
describe('combat, off the state channel: the intent mark and the block target', () => {
  const attacking = (cardIds: number[]) =>
    stateDelta(
      Object.fromEntries(cardIds.map((id) => [String(id), { _type: WireType.Card, _id: id, Attacking: { t: 'bool', v: true } }])),
    );
  const me = (m: LiveMatch) => m.view!.players.find((p) => p.isViewer)!;
  const them = (m: LiveMatch) => m.view!.players.find((p) => !p.isViewer)!;

  it('the intent is recorded at SELECTION, and it is never a claim about tapped', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    const card = me(m).battlefield.find((c) => !c.tapped)!.id;
    await sendAndApply(s, m, [phase('COMBAT_DECLARE_ATTACKERS', me(m).id)]);
    expect(declaringAttackers(m)).toBe(true);
    await sendAndApply(s, m, [prompt('Declare attackers'), actionable([card, mine[1]!])]);

    expect(attackIntents(m).size).toBe(0);
    expect(selectCard(m, card)).toBe(true);
    await until('the act', () => s.clientFrames().length >= 1);
    expect(s.clientFrames()).toEqual([cardAct(card)]);
    // Sent, and only sent: Forge has not answered yet.
    expect(attackIntents(m).get(card)).toBe('sent');
    // THE SAFETY CONTROL: an intent is not a tapped state, and the view still
    // says what Forge says.
    expect(me(m).battlefield.find((c) => c.id === card)!.tapped).toBe(false);
    // And the card the player did not point at carries no intent.
    expect(attackIntents(m).has(mine[1]!)).toBe(false);
  });

  it('Forge answered and did not declare it: the intent says so rather than going quiet', async () => {
    const { s, m } = await fullGame();
    const card = me(m).battlefield.find((c) => !c.tapped)!.id;
    await sendAndApply(s, m, [phase('COMBAT_DECLARE_ATTACKERS', me(m).id)]);
    await sendAndApply(s, m, [prompt('Declare attackers'), actionable([card])]);
    expect(selectCard(m, card)).toBe(true);
    expect(attackIntents(m).get(card)).toBe('sent');

    // Forge re-offers the card: `pushAttackerCandidates` drops the ones it HAS
    // declared, so this is Forge saying it did not take the click.
    await sendAndApply(s, m, [actionable([card])]);
    expect(attackIntents(m).get(card)).toBe('refused');

    // Then it declares it, and Forge's own truth takes the mark over.
    await sendAndApply(s, m, [attacking([card])]);
    expect(attackIntents(m).get(card)).toBe('declared');
  });

  it('an intent does not survive the phase or the turn', async () => {
    const { s, m } = await fullGame();
    const card = me(m).battlefield.find((c) => !c.tapped)!.id;
    await sendAndApply(s, m, [phase('COMBAT_DECLARE_ATTACKERS', me(m).id)]);
    await sendAndApply(s, m, [prompt('Declare attackers'), actionable([card])]);
    expect(selectCard(m, card)).toBe(true);
    expect(attackIntents(m).size).toBe(1);

    await sendAndApply(s, m, [phase('COMBAT_DECLARE_BLOCKERS', me(m).id)]);
    expect(attackIntents(m).size).toBe(0);
    // Back in declare-attackers, but the NEXT turn: an old intent is not a new one.
    await sendAndApply(s, m, [
      stateDelta({
        [GAME_KEY]: {
          _type: WireType.Game,
          _id: 1,
          Phase: { t: 'enum', c: 'forge.game.phase.PhaseType', v: 'COMBAT_DECLARE_ATTACKERS' },
          PlayerTurn: { t: 'int', v: me(m).id },
          Turn: { t: 'int', v: m.view!.turn + 2 },
        },
      }),
    ]);
    expect(declaringAttackers(m)).toBe(true);
    expect(attackIntents(m).size).toBe(0);
  });

  /*
   * `selectionOpen` — lane A's arrange gesture stands down on it, so it has to
   * mean exactly one thing and keep meaning it.
   *
   * The distinction it draws is the one that turned `e2e/table-fit.spec.ts` red:
   * at ordinary priority Forge's ACTIONABLE set names most of a player's own
   * permanents, so `selectable` is large and arranging must still work. An OPEN
   * SELECTION is Forge asking, and that is when arranging stands down.
   */
  it('selectionOpen is Forge’s open selection and nothing else — not the actionable set', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    expect(boardInteraction(m).selectionOpen).toBe(false);

    // Priority: plenty offered, and NOT an open selection.
    await sendAndApply(s, m, [prompt('Priority'), actionable(mine)]);
    expect(boardInteraction(m).selectable.size).toBe(mine.length);
    expect(boardInteraction(m).selectionOpen).toBe(false);

    // A selection: open, and it closes with `clearSelectables`.
    await sendAndApply(s, m, [selectables([mine[0]!], 1, 1)]);
    expect(boardInteraction(m).selectionOpen).toBe(true);
    expect(boardInteraction(m).selectionOpen).toBe(m.selectables !== null);
    await sendAndApply(s, m, [clear()]);
    expect(boardInteraction(m).selectionOpen).toBe(false);
  });

  it('selectionOpen survives an ask and a dropped socket: it is about Forge’s input, not about us', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    await sendAndApply(s, m, [prompt('Choose a target'), selectables([mine[0]!], 1, 1)]);
    expect(boardInteraction(m).selectionOpen).toBe(true);

    // An ask queues in front: nothing is clickable, the selection is still open.
    await sendAndApply(s, m, [confirmAsk('c-open')]);
    expect(boardInteraction(m).selectable.size).toBe(0);
    expect(boardInteraction(m).selectionOpen).toBe(true);
    expect(answerConfirm(m, 'c-open', true)).toBe(true);

    // And the phase never enters it: combat declaration opens no selection.
    await sendAndApply(s, m, [clear()]);
    await sendAndApply(s, m, [phase('COMBAT_DECLARE_ATTACKERS', me(m).id), prompt('Declare attackers'), actionable(mine)]);
    expect(declaringCombat(m)).toBe(true);
    expect(boardInteraction(m).selectionOpen).toBe(false);
  });

  /*
   * `declaringCombat` — the predicate that partitions the press with lane A's
   * arrange gesture, and the reason it is not `selectionOpen`.
   *
   * `setSelectables` has exactly two game-side call sites,
   * `InputSelectTargets.java:68` and `InputSelectEntitiesFromList.java:57`.
   * `InputAttack` and `InputBlock` are neither, so a rule that only stood
   * arranging down for an open selection would leave the attacker and the
   * blocker natively draggable — which is §B.2 and §B.3 gone.
   */
  it('declaringCombat is the two combat inputs, and neither of them opens a selection', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    expect(declaringCombat(m)).toBe(false);

    await sendAndApply(s, m, [phase('COMBAT_DECLARE_ATTACKERS', me(m).id), prompt('Declare attackers'), actionable(mine)]);
    expect(declaringAttackers(m)).toBe(true);
    expect(declaringCombat(m)).toBe(true);
    expect(m.selectables).toBeNull();

    // The opponent's declare-attackers is not this seat's.
    await sendAndApply(s, m, [phase('COMBAT_DECLARE_ATTACKERS', them(m).id)]);
    expect(declaringCombat(m)).toBe(false);

    // Their attack, this seat's block.
    await sendAndApply(s, m, [phase('COMBAT_DECLARE_BLOCKERS', them(m).id)]);
    expect(declaringBlockers(m)).toBe(true);
    expect(declaringCombat(m)).toBe(true);
    expect(m.selectables).toBeNull();

    // And a phase that is neither is neither.
    await sendAndApply(s, m, [phase('MAIN2', me(m).id)]);
    expect(declaringCombat(m)).toBe(false);
  });

  /*
   * Wave 32, Q14. `InputAttack.onCardSelected` undeclares a declared attacker that is
   * clicked again, but `pushAttackerCandidates` drops declared attackers from the offer
   * (`PlayerControllerHuman.java:1613-1614`), so the click was refused client-side.
   */
  it('a declared attacker is clickable while InputAttack runs, so a second click can call it back', async () => {
    const { s, m } = await fullGame();
    const [a, b] = me(m).battlefield.map((c) => c.id);
    const bar2 = (label2: string) =>
      parseServerFrame({
        kind: 'notify',
        method: 'updateButtons',
        owner: { kind: 'player', id: 0 },
        label1: 'OK',
        label2,
        enable1: true,
        enable2: true,
        focus1: true,
      });
    await sendAndApply(s, m, [phase('COMBAT_DECLARE_ATTACKERS', me(m).id), prompt('Declare attackers'), bar2('Alpha Strike')]);
    // Forge offers the undeclared candidates only; `a` is declared and so is not among them.
    await sendAndApply(s, m, [attacking([a!]), actionable([b!])]);
    // Alpha Strike: no attacker is declared as far as Forge's own button says. Not offered.
    expect(boardInteraction(m).selectable.has(a!)).toBe(false);

    // `Call Back` is Forge saying an attacker is declared: now the declared one is offered too.
    await sendAndApply(s, m, [bar2('Call Back')]);
    expect(boardInteraction(m).selectable.has(a!)).toBe(true);
    expect(boardInteraction(m).selectable.has(b!)).toBe(true);
    expect(selectCard(m, a!)).toBe(true);

    // The priority window that follows reads `End Turn`: nothing is undeclared by a click there.
    await sendAndApply(s, m, [prompt('Priority'), bar2('End Turn'), actionable([b!])]);
    expect(boardInteraction(m).selectable.has(a!)).toBe(false);
  });

  it('the attackers become offerable while InputBlock is running, and only then', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    const attackers = them(m).battlefield.map((c) => c.id).slice(0, 2);
    expect(attackers).toHaveLength(2);
    await sendAndApply(s, m, [phase('COMBAT_DECLARE_BLOCKERS', them(m).id), attacking(attackers)]);
    expect(declaringBlockers(m)).toBe(true);

    // Forge's priority input in the same step: blocker candidates, no mark.
    // `setCurrentAttacker` is the only thing that marks here, so no mark means
    // this is not InputBlock, and no attacker is offered.
    await sendAndApply(s, m, [prompt('Priority'), actionable([mine[0]!])]);
    expect(boardInteraction(m).selectable.has(attackers[0]!)).toBe(false);
    expect(isBlockAssignment(m, mine[0]!, attackers[1]!)).toBe(false);
    expect(selectCard(m, attackers[1]!)).toBe(false);

    // InputBlock: the mark appears, and BOTH attackers become offerable — the
    // marked one through `setHighlighted`, the other through `blockTargets`.
    await sendAndApply(s, m, [mark([attackers[0]!])]);
    expect(boardInteraction(m).selectable.has(attackers[0]!)).toBe(true);
    expect(boardInteraction(m).selectable.has(attackers[1]!)).toBe(true);
    expect(isBlockAssignment(m, mine[0]!, attackers[1]!)).toBe(true);
    // The other way round is not a block: an attacker does not block.
    expect(isBlockAssignment(m, attackers[1]!, mine[0]!)).toBe(false);

    // Nothing of the viewer's own becomes a block target, whatever is marked.
    expect(isBlockAssignment(m, mine[0]!, mine[1]!)).toBe(false);
    await barrier(s, m, mine[0]!);
  });

  it('a card the viewer was never sent cannot become a block target', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    const attackers = them(m).battlefield.map((c) => c.id).slice(0, 1);
    await sendAndApply(s, m, [phase('COMBAT_DECLARE_BLOCKERS', them(m).id), attacking(attackers)]);
    await sendAndApply(s, m, [prompt('Select a blocker'), actionable([mine[0]!]), mark([attackers[0]!])]);
    const offered = boardInteraction(m).selectable;
    // Every offered id is a card this seat holds a projection of. An id Forge
    // never sent (999) is not one of them, marked or not.
    expect(offered.has(999)).toBe(false);
    expect(isBlockAssignment(m, mine[0]!, 999)).toBe(false);
    expect(selectCard(m, 999)).toBe(false);
    await barrier(s, m, mine[0]!);
  });
});

/*
 * X1/W14 — attacking a planeswalker or a player. `attackDefenders` (not
 * exported; read here through `boardInteraction`'s offer and through
 * `attackAssignment`'s own verdict) offers opponents' planeswalkers and
 * battles, and `boardInteraction`'s own player branch offers every opponent
 * while attackers are being declared. `attackAssignment` is what `commit.ts`
 * reads to decide the DEFENDER-FIRST order — `gestures/gestures.test.ts`'s
 * "X1/W14" block proves the two-frame drag end to end; this proves the
 * decision it is built on.
 */
describe('X1/W14 — attackDefenders and attackAssignment, off the state channel', () => {
  const me = (m: LiveMatch) => m.view!.players.find((p) => p.isViewer)!;
  const them = (m: LiveMatch) => m.view!.players.find((p) => !p.isViewer)!;

  /** Retype one of the opponent's existing battlefield cards a planeswalker — the fixture's capture has none. */
  function retypePlaneswalker(id: number): ServerFrame {
    return stateDelta({
      [deltaKey(WireType.CardState, id * 16)]: {
        _type: WireType.CardState,
        _id: id * 16,
        Type: { t: 'cardtype', sup: [], core: ['Planeswalker'], sub: ['Jace'], all: false, exc: [] },
      },
    });
  }

  it('a planeswalker is offered as a card target while declaring attackers, and attackAssignment says ASSIGN', async () => {
    const { s, m } = await fullGame();
    const attacker = me(m).battlefield.find((c) => !c.tapped)!.id;
    const pw = them(m).battlefield[0]!.id;
    await sendAndApply(s, m, [retypePlaneswalker(pw)]);
    expect(them(m).battlefield.find((c) => c.id === pw)!.card.typeLine).toContain('Planeswalker');

    await sendAndApply(s, m, [phase('COMBAT_DECLARE_ATTACKERS', me(m).id), prompt('Declare attackers'), actionable([attacker])]);
    expect(declaringAttackers(m)).toBe(true);
    expect(boardInteraction(m).selectable.has(pw)).toBe(true);
    expect(attackAssignment(m, attacker, { kind: 'card', id: pw })).toBe('assign');
  });

  it('the opponent is offered as a player target while declaring attackers, and attackAssignment says ASSIGN', async () => {
    const { s, m } = await fullGame();
    const attacker = me(m).battlefield.find((c) => !c.tapped)!.id;
    const opponent = them(m).id;
    await sendAndApply(s, m, [phase('COMBAT_DECLARE_ATTACKERS', me(m).id), prompt('Declare attackers'), actionable([attacker])]);
    expect(boardInteraction(m).selectablePlayers.has(opponent)).toBe(true);
    expect(attackAssignment(m, attacker, { kind: 'player', id: opponent })).toBe('assign');
  });

  it('a defender this attacker already attacks (Forge’s own CombatView) reads ALREADY, not assign', async () => {
    const { s, m } = await fullGame();
    const attacker = me(m).battlefield.find((c) => !c.tapped)!.id;
    const opponent = them(m).id;
    await sendAndApply(s, m, [
      phase('COMBAT_DECLARE_ATTACKERS', me(m).id),
      prompt('Declare attackers'),
      actionable([attacker]),
      stateDelta({
        [GAME_KEY]: {
          _type: WireType.Game,
          _id: 1,
          CombatView: { t: 'combat', atk: [[attacker]], def: [[1, opponent]], blk: [[]], pblk: [[]] },
        },
      }),
    ]);
    expect(attackAssignment(m, attacker, { kind: 'player', id: opponent })).toBe('already');
    // A DIFFERENT defender is still a fresh assignment.
    const pw = them(m).battlefield[0]!.id;
    await sendAndApply(s, m, [retypePlaneswalker(pw)]);
    expect(attackAssignment(m, attacker, { kind: 'card', id: pw })).toBe('assign');
  });

  it('is null outside declare-attackers, and null for a card that is not this seat’s own battlefield', async () => {
    const { s, m } = await fullGame();
    const attacker = me(m).battlefield[0]!.id;
    const opponent = them(m).id;
    const theirCard = them(m).battlefield[0]!.id;

    // Outside the phase at all.
    await sendAndApply(s, m, [phase('MAIN1', me(m).id)]);
    expect(attackAssignment(m, attacker, { kind: 'player', id: opponent })).toBeNull();

    // Inside the phase, but the "attacker" is the OPPONENT's own card.
    await sendAndApply(s, m, [phase('COMBAT_DECLARE_ATTACKERS', me(m).id)]);
    expect(attackAssignment(m, theirCard, { kind: 'player', id: opponent })).toBeNull();

    // And a target that is neither a legal player nor an offered planeswalker/battle.
    expect(attackAssignment(m, attacker, { kind: 'card', id: theirCard })).toBeNull();
  });
});

/*
 * X3 — the counterspell arc's client-side pairing. There is no wire fact for
 * "this stack item targets that one" when the target is itself a spell on the
 * stack (`gestures/stack.ts`'s `commitStackTarget` note; proven against the
 * real jar in `apps/server/src/play/scenario-w46-b-counterspell.jvm.test.ts`),
 * so `redraw` claims the pairing itself the moment the countering item
 * appears. These drive that claim/prune logic directly off synthetic stack
 * frames — `gestures/auto-targets.test.ts`'s `stackTargetArrows` block proves
 * what gets DRAWN from `stackTargetArcs` once it holds one.
 */
describe('X3 — stackTargetIntent/stackTargetArcs, the counterspell arc’s claim and prune', () => {
  const me = (m: LiveMatch) => m.view!.players.find((p) => p.isViewer)!;
  const them = (m: LiveMatch) => m.view!.players.find((p) => !p.isViewer)!;

  /** A brand new `StackItem` object (never a delta — it does not exist yet). */
  function newStackItem(id: number, activatingPlayer: number, description: string): ServerFrame {
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
            [deltaKey(WireType.StackItem, id)]: {
              _type: WireType.StackItem,
              _id: id,
              ActivatingPlayer: { t: 'int', v: activatingPlayer },
              Description: { t: 'str', v: description },
            },
          },
          objectDeltas: {},
          events: [],
        },
      },
    });
  }

  /** `Game.Stack`, top-first — `adapter.ts`'s own documented order. */
  const stackOf = (ids: number[]): ServerFrame =>
    stateDelta({
      [GAME_KEY]: { _type: WireType.Game, _id: 1, Stack: { t: 'list', v: ids.map((id) => ({ t: 'int', v: id })) } },
    });

  it('claims the intent once a NEW top item appears, controlled by this seat', async () => {
    const { s, m } = await fullGame();
    const target = 9001; // the opponent's spell, already on the stack
    await sendAndApply(s, m, [newStackItem(target, them(m).id, 'Memnite'), stackOf([target])]);
    expect(m.view!.stack.map((i) => i.id)).toEqual([target]);

    noteStackTargetIntent(m, target);
    expect(m.stackTargetIntent).toBe(target);
    expect(m.stackTargetArcs.size).toBe(0);

    // The countering spell lands: a NEW top item, controlled by THIS seat.
    const counter = 9002;
    await sendAndApply(s, m, [newStackItem(counter, me(m).id, 'Counterspell'), stackOf([counter, target])]);
    expect(m.stackTargetArcs.get(counter)).toBe(target);
    expect(m.stackTargetIntent).toBeNull();
  });

  it('does not claim a new top item controlled by someone ELSE — only this seat’s own cast claims it', async () => {
    const { s, m } = await fullGame();
    const target = 9011;
    await sendAndApply(s, m, [newStackItem(target, me(m).id, 'Shock'), stackOf([target])]);
    noteStackTargetIntent(m, target);

    // A trigger from the OPPONENT lands on top before this seat's own spell does.
    const theirTrigger = 9012;
    await sendAndApply(s, m, [newStackItem(theirTrigger, them(m).id, 'Some trigger'), stackOf([theirTrigger, target])]);
    expect(m.stackTargetArcs.has(theirTrigger)).toBe(false);
    // Still held, waiting for THIS seat's own item.
    expect(m.stackTargetIntent).toBe(target);
  });

  it('prunes an arc once either side leaves the stack — the target resolves', async () => {
    const { s, m } = await fullGame();
    const target = 9021;
    const counter = 9022;
    await sendAndApply(s, m, [newStackItem(target, them(m).id, 'Memnite'), stackOf([target])]);
    noteStackTargetIntent(m, target);
    await sendAndApply(s, m, [newStackItem(counter, me(m).id, 'Counterspell'), stackOf([counter, target])]);
    expect(m.stackTargetArcs.get(counter)).toBe(target);

    // The counterspell resolves, taking the targeted spell off the stack too.
    await sendAndApply(s, m, [stackOf([])]);
    expect(m.stackTargetArcs.size).toBe(0);
  });

  it('prunes an arc once the SOURCE leaves the stack (resolved before the target did)', async () => {
    const { s, m } = await fullGame();
    const target = 9031;
    const counter = 9032;
    await sendAndApply(s, m, [newStackItem(target, them(m).id, 'Memnite'), stackOf([target])]);
    noteStackTargetIntent(m, target);
    await sendAndApply(s, m, [newStackItem(counter, me(m).id, 'Counterspell'), stackOf([counter, target])]);
    expect(m.stackTargetArcs.get(counter)).toBe(target);

    // The counterspell itself resolves and leaves the stack; the arc goes with it.
    await sendAndApply(s, m, [stackOf([target])]);
    expect(m.stackTargetArcs.has(counter)).toBe(false);
  });

  /** A `getChoices` ask whose choices carry stack-item refs — `PlayBridge.java:288`'s own shape. */
  const getChoicesAsk = (callId: string, choices: { key: string; label: string; stackItemId: number }[]): ServerFrame =>
    parseServerFrame({
      kind: 'ask',
      callId,
      method: 'getChoices',
      message: 'Select target card',
      min: 1,
      max: 1,
      choices: choices.map((c) => ({ key: c.key, label: c.label, ref: { kind: 'stackItem', id: c.stackItemId } })),
      selected: [],
    });

  /*
   * The real bug this centralisation fixes: with exactly ONE legal stack
   * target, Forge's own ask is auto-answered by `LiveBoard.tsx`'s
   * `autoAnswer` → `rules.ts`'s `onlyStackTarget` — which calls `answerAsk`
   * DIRECTLY, never `gestures/stack.ts`'s `commitStackTarget`. Recording the
   * intent only in the gesture would miss the single-legal-target case
   * entirely, which is the COMMON one for a counterspell. This proves
   * `answerAsk` itself is the one place that has to record it.
   */
  it('answerAsk itself records the intent, so Forge’s own single-choice auto-answer (no click, no gesture) draws the arc too', async () => {
    const { s, m } = await fullGame();
    const target = 9041;
    await sendAndApply(s, m, [newStackItem(target, them(m).id, 'Memnite'), stackOf([target])]);

    s.send(getChoicesAsk('c-stack-1', [{ key: 'c0', label: 'Memnite', stackItemId: target }]));
    await until('the stack-target ask', () => currentAsk(m) !== null);

    // Answered directly — the shape `onlyStackTarget`'s own auto-answer uses,
    // never through the gesture layer.
    expect(answerAsk(m, 'c-stack-1', 'getChoices', ['c0'])).toBe(true);
    expect(m.stackTargetIntent).toBe(target);

    const counter = 9042;
    await sendAndApply(s, m, [newStackItem(counter, me(m).id, 'Counterspell'), stackOf([counter, target])]);
    expect(m.stackTargetArcs.get(counter)).toBe(target);
  });

  it('a getChoices answer naming something OTHER than a stack item records no intent', async () => {
    const { s, m } = await fullGame();
    await sendAndApply(s, m, [
      parseServerFrame({
        kind: 'ask',
        callId: 'c-ordinary',
        method: 'getChoices',
        message: 'Choose a mode',
        min: 1,
        max: 1,
        choices: [{ key: 'c0', label: 'Mode one', ref: null }],
        selected: [],
      }),
    ]);
    expect(answerAsk(m, 'c-ordinary', 'getChoices', ['c0'])).toBe(true);
    expect(m.stackTargetIntent).toBeNull();
  });
});

/*
 * Wave 49 §A — `stackTargetSpells`, the bridge's OWN wire fact for the same
 * pairing the X3 block above claims client-side. Unlike `stackTargetArcs`,
 * this needs no ask THIS seat answered: it is a SIBLING of the frame's own
 * `packet`, folded by `../fold.ts`'s `FoldResult.stackTargetSpells` and
 * surfaced on every `StackEntry.targetStackItemId` — `gestures/
 * auto-targets.test.ts`'s `stackTargetArrows` block proves what gets drawn
 * from it once it holds one.
 */
/*
 * The operator, 2026-10-04 and again 2026-10-06: clicking a land just tapped for
 * mana should untap it, without the Undo button. Forge's undo is last-in-first-out,
 * so the one land a click may untap is the last to tap.
 */
describe('the land tapped last is clickable while Forge offers Undo, and the click is that Undo', () => {
  const me = (m: LiveMatch) => m.view!.players.find((p) => p.isViewer)!;
  const tap = (id: number, tapped: boolean) =>
    stateDelta({ [String(id)]: { _type: WireType.Card, _id: id, Tapped: { t: 'bool', v: tapped } } });
  const bar = (label2: string, enable2 = true) =>
    parseServerFrame({ kind: 'notify', method: 'updateButtons', owner: { kind: 'player', id: 0 }, label1: 'OK', label2, enable1: true, enable2, focus1: true });

  /** A game at priority with this seat's lands untapped: two of them, and what Forge sends after a click. */
  async function atPriority() {
    const { s, m } = await fullGame();
    const lands = me(m).battlefield.filter((c) => c.card.typeLine.includes('Land')).map((c) => c.id);
    expect(lands.length, 'the fixture gives this seat two lands').toBeGreaterThanOrEqual(2);
    await sendAndApply(s, m, [...lands.map((id) => tap(id, false)), prompt('Priority'), bar('End Turn'), actionable(lands)]);
    const [a, b] = lands as [number, number];
    /** Forge taps `id` and shows priority again, offering the lands still untapped and its Undo. */
    const forgeTaps = (id: number, untapped: number[]) => sendAndApply(s, m, [tap(id, true), prompt('Priority'), bar('Undo (1)'), actionable(untapped)]);
    return { s, m, a, b, rest: lands.slice(2), forgeTaps };
  }

  it('only the LAST land to tap is offered, and clicking it presses Undo', async () => {
    const { s, m, a, b, rest, forgeTaps } = await atPriority();
    await forgeTaps(a, [b, ...rest]);
    expect(boardInteraction(m).selectable.has(a), 'the one land tapped is offered').toBe(true);
    await forgeTaps(b, rest);
    expect(boardInteraction(m).selectable.has(b), 'the land tapped last').toBe(true);
    expect(boardInteraction(m).selectable.has(a), 'not the one before it: Forge’s Undo would not untap that').toBe(false);

    expect(selectCard(m, b)).toBe(true);
    await until('the click at the server', () => s.clientFrames().length === 1);
    expect(s.clientFrames()[0]).toMatchObject({ ok: true, value: { kind: 'act', method: 'selectButtonCancel' } });

    // Forge untaps it. The land before it is now the last tapped, and Undo is still offered: its turn.
    await sendAndApply(s, m, [tap(b, false), prompt('Priority'), bar('Undo (1)'), actionable([b, ...rest])]);
    expect(boardInteraction(m).selectable.has(a)).toBe(true);
  });

  it('with no Undo on the bar a tapped land is not clickable, however recently it tapped', async () => {
    const { s, m, a, b, rest, forgeTaps } = await atPriority();
    await forgeTaps(a, [b, ...rest]);
    // The same board, and Forge's second button reads End Turn: nothing to undo (a new phase, or a spell cast with the mana).
    await sendAndApply(s, m, [prompt('Priority'), bar('End Turn'), actionable([b, ...rest])]);
    expect(boardInteraction(m).selectable.has(a)).toBe(false);
    expect(selectCard(m, a)).toBe(false);
    // Offered, but the button is disabled: the same answer.
    await sendAndApply(s, m, [bar('Undo (1)', false)]);
    expect(boardInteraction(m).selectable.has(a)).toBe(false);
    // And only Forge's own label: another input's button that merely starts with the word is not it.
    await sendAndApply(s, m, [bar('Undo')]);
    expect(boardInteraction(m).selectable.has(a)).toBe(false);
    expect(s.clientFrames()).toHaveLength(0);
  });

  it('two lands tapping in one update have no order: neither is offered', async () => {
    const { s, m, a, b, rest } = await atPriority();
    await sendAndApply(s, m, [
      stateDelta(Object.fromEntries([a, b].map((id) => [String(id), { _type: WireType.Card, _id: id, Tapped: { t: 'bool', v: true } }]))),
      prompt('Priority'),
      bar('Undo (1)'),
      actionable(rest),
    ]);
    expect(boardInteraction(m).selectable.has(a)).toBe(false);
    expect(boardInteraction(m).selectable.has(b)).toBe(false);
  });

  it('a tapped land Forge itself offers keeps its own click', async () => {
    const { s, m, a, b, rest, forgeTaps } = await atPriority();
    await forgeTaps(a, [a, b, ...rest]);
    expect(selectCard(m, a)).toBe(true);
    await until('the click at the server', () => s.clientFrames().length === 1);
    expect(s.clientFrames()[0]).toMatchObject({ ok: true, value: { kind: 'act', method: 'selectCard' } });
  });
});

describe('stackTargetSpells (wave 49 §A) — the bridge’s own wire fact', () => {
  /** A brand new `StackItem` object, same shape the X3 block's own helper builds. */
  function newStackItem(id: number, activatingPlayer: number, description: string): ServerFrame {
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
            [deltaKey(WireType.StackItem, id)]: {
              _type: WireType.StackItem,
              _id: id,
              ActivatingPlayer: { t: 'int', v: activatingPlayer },
              Description: { t: 'str', v: description },
            },
          },
          objectDeltas: {},
          events: [],
        },
      },
    });
  }

  const stackOf = (ids: number[]): ServerFrame =>
    stateDelta({
      [GAME_KEY]: { _type: WireType.Game, _id: 1, Stack: { t: 'list', v: ids.map((id) => ({ t: 'int', v: id })) } },
    });

  /** The same two-item stack `applyDelta` naming the pairing as a SIBLING of `packet`. */
  function applyDeltaWithPairs(pairs: readonly (readonly [number, number])[]): ServerFrame {
    seq += 1;
    return parseServerFrame({
      kind: 'notify',
      method: 'applyDelta',
      payload: {
        packet: { seq, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: {}, events: [] },
        stackTargetSpells: pairs,
      },
    });
  }

  it('folds onto LiveMatch.stackTargetSpells and onto the targeting item’s own StackEntry', async () => {
    const { s, m } = await fullGame();
    const target = 9101;
    const counter = 9102;
    await sendAndApply(s, m, [
      newStackItem(target, m.view!.players.find((p) => !p.isViewer)!.id, 'Memnite'),
      newStackItem(counter, m.view!.players.find((p) => p.isViewer)!.id, 'Counterspell'),
      stackOf([counter, target]),
      applyDeltaWithPairs([[counter, target]]),
    ]);
    expect(m.stackTargetSpells.get(counter)).toBe(target);
    const item = m.view!.stack.find((i) => i.id === counter);
    expect(item?.targetStackItemId).toBe(target);
    // The targeted item itself names no target of its own.
    const targetItem = m.view!.stack.find((i) => i.id === target);
    expect(targetItem?.targetStackItemId ?? null).toBeNull();
  });

  it('is empty before any frame ever carries it', async () => {
    const { m } = await fullGame();
    expect(m.stackTargetSpells.size).toBe(0);
  });

  it('a later applyDelta that carries no stackTargetSpells at all leaves the snapshot as it was', async () => {
    const { s, m } = await fullGame();
    const target = 9103;
    const counter = 9104;
    await sendAndApply(s, m, [
      newStackItem(target, m.view!.players.find((p) => !p.isViewer)!.id, 'Memnite'),
      newStackItem(counter, m.view!.players.find((p) => p.isViewer)!.id, 'Counterspell'),
      stackOf([counter, target]),
      applyDeltaWithPairs([[counter, target]]),
    ]);
    expect(m.stackTargetSpells.get(counter)).toBe(target);
    // An ordinary delta that touches something unrelated, and carries no
    // `stackTargetSpells` field at all — never produced by a real bridge
    // (every live frame carries it), but this proves the fold does not wipe
    // what it already knew just because one packet did not restate it.
    await sendAndApply(s, m, [phase('MAIN2', m.view!.players.find((p) => p.isViewer)!.id)]);
    expect(m.stackTargetSpells.get(counter)).toBe(target);
  });
});

describe('full control, restored after a refresh', () => {
  /*
   * `cursor` is seq 1 with no frames in it, which the contract allows and the
   * last case needs: `frames` is the STATE history and the cursor is the latest
   * of any kind, so a seat whose only frame so far was a prompt looks exactly
   * like this. It makes the seq-9 frame below a gap, and the gap is what makes
   * the resync happen.
   */
  const SNAPSHOT = { matchId: 'm', seat: 0, playerId: 0, cursor: { epoch: 'e', seq: 1 }, frames: [] as unknown[] };

  interface Stub {
    m: LiveMatch;
    /** Deliver a payload on `forge:full-control`, as the server does. */
    tell(payload: unknown): void;
    emitted: { event: string; payload: unknown }[];
    /** Answer the join (or a resync) with a snapshot. */
    ack(): void;
  }

  /** A fresh page: a new handle, the toggle off, nothing remembered. */
  function fresh(): Stub {
    const handlers = new Map<string, (payload: unknown) => void>();
    const emitted: { event: string; payload: unknown }[] = [];
    const acks: ((err: Error | null, response: unknown) => void)[] = [];
    const transport: MatchTransport = {
      on: (event, handler) => {
        handlers.set(event, handler);
      },
      emit: (event, payload) => emitted.push({ event, payload }),
      request: (_event, _payload, onAck) => acks.push(onAck),
      disconnect: () => {},
    };
    const m = startMatch({ matchId: 'm', transport });
    return {
      m,
      emitted,
      tell: (payload) => {
        const handler = handlers.get(MATCH_EVENTS.fullControl);
        if (handler === undefined) throw new Error('the handle does not listen on forge:full-control at all');
        handler(payload);
      },
      ack: () => acks.shift()!(null, SNAPSHOT),
    };
  }

  it('a page that joins into a seat the server holds in full control draws it ON', () => {
    const { m, tell, emitted, ack } = fresh();
    ack();
    // A fresh handle knows nothing: off is what it must draw until told.
    expect(m.fullControl).toBe(false);
    const before = m.revision;

    tell({ matchId: 'm', on: true });

    expect(m.fullControl).toBe(true);
    // It redrew: `LiveBoard` reads the flag through `subscribe`.
    expect(m.revision).toBeGreaterThan(before);
    // Nothing was sent back. The server is telling us; answering would loop.
    expect(emitted).toEqual([]);
    // And the toggle now agrees with the seat: the click that would turn it ON
    // is the documented no-op, and the one that turns it OFF is what crosses.
    expect(setFullControl(m, true)).toBe(false);
    expect(setFullControl(m, false)).toBe(true);
    expect(emitted).toEqual([{ event: MATCH_EVENTS.fullControl, payload: { matchId: 'm', on: false } }]);
  });

  it('the server has the last word: it turns the flag OFF as well as on', () => {
    const { m, tell, ack } = fresh();
    ack();
    tell({ matchId: 'm', on: true });
    expect(m.fullControl).toBe(true);
    tell({ matchId: 'm', on: false });
    expect(m.fullControl).toBe(false);
  });

  it('a payload for another match, or one the schema refuses, changes nothing and is counted', () => {
    const { m, tell, ack } = fresh();
    ack();
    for (const bad of [
      { matchId: 'someone-elses-match', on: true },
      { matchId: 'm', on: 'yes' },
      { matchId: 'm' },
      { matchId: 'm', on: true, seat: 0 },
      null,
    ]) {
      tell(bad);
      expect(m.fullControl, `${JSON.stringify(bad)} must not open the hatch`).toBe(false);
    }
    expect(m.stats.invalid).toBe(5);
    expect(m.lastInvalid).not.toBeNull();
  });

  it('a snapshot does not clear it: the echo lands after the ack, and a resync must not undo it', () => {
    const { m, tell, ack } = fresh();
    ack();
    tell({ matchId: 'm', on: true });
    // A resync adopts a fresh snapshot. It clears asks, selections and the log
    // — it must NOT clear a preference the server has not withdrawn.
    ingest(m, { matchId: 'm', cursor: { epoch: 'e', seq: 9 }, frame: FRAMES[0] });
    expect(m.stats.resyncsRequested).toBe(1);
    ack();
    expect(m.stats.snapshots).toBe(2);
    expect(m.fullControl).toBe(true);
  });
});

describe('the seat identities — item 4, wave 29 §A.6-8', () => {
  /*
   * Real players, off a real replay server (`fullGame`), because the join key
   * this joins by (`playerId`) has to be a real Forge player id — the whole
   * point of the claim is that it is THE SAME id `BoardPlayer.id` already is,
   * not a stand-in.
   */

  it('before forge:seats has ever arrived, the seat table is "not yet", not "arrived empty" — and nobody carries the key', async () => {
    const { m } = await fullGame();
    expect(m.avatarByPlayerId).toBeNull();
    for (const p of m.view!.players) expect(p).not.toHaveProperty('avatarId');
  });

  it('joins the avatar onto the viewer’s own BoardPlayer by playerId, and leaves the other seat’s key off entirely', async () => {
    const { s, m } = await fullGame();
    const viewerId = m.view!.players.find((p) => p.isViewer)!.id;
    const theirId = m.view!.players.find((p) => !p.isViewer)!.id;
    const before = m.revision;
    s.sendSeats([
      { seat: 0, claimed: true, playerId: viewerId, avatarId: 'wanderer' },
      { seat: 1, claimed: true, playerId: theirId },
    ]);
    await until('forge:seats to be adopted', () => m.avatarByPlayerId !== null);
    expect(m.revision, 'it redrew — PlayerFace reads this through subscribe').toBeGreaterThan(before);
    expect(m.view!.players.find((p) => p.isViewer)).toHaveProperty('avatarId', 'wanderer');
    expect(m.view!.players.find((p) => !p.isViewer)).not.toHaveProperty('avatarId');
  });

  it('a seat table that HAS arrived with nobody wearing a face is a real, empty Map — not null', async () => {
    const { s, m } = await fullGame();
    const viewerId = m.view!.players.find((p) => p.isViewer)!.id;
    s.sendSeats([{ seat: 0, claimed: true, playerId: viewerId }]);
    await until('forge:seats to be adopted', () => m.avatarByPlayerId !== null);
    expect(m.avatarByPlayerId).not.toBeNull();
    expect(m.avatarByPlayerId!.size).toBe(0);
  });

  it('null, "", whitespace and an absent key all collapse to no avatar — the client tolerates every shape the wire could carry', async () => {
    const { s, m } = await fullGame();
    const viewerId = m.view!.players.find((p) => p.isViewer)!.id;
    for (const avatarId of [null, '', '   ', undefined]) {
      const before = m.revision;
      s.sendSeats([{ seat: 0, claimed: true, playerId: viewerId, ...(avatarId === undefined ? {} : { avatarId }) }]);
      await until(`forge:seats(${JSON.stringify(avatarId)}) to be adopted`, () => m.revision > before);
      expect(m.view!.players.find((p) => p.isViewer), JSON.stringify(avatarId)).not.toHaveProperty('avatarId');
    }
  });

  it('a malformed forge:seats payload is recorded and invalid, and the seat table stays "not yet arrived"', async () => {
    const { s, m } = await fullGame();
    s.sendSeats('not an array of seats');
    await until('the payload to be refused', () => m.lastInvalid !== null);
    expect(m.avatarByPlayerId).toBeNull();
  });

  it('a seat naming no player id (playerId: null) cannot be joined to a board player, and is simply skipped', async () => {
    const { s, m } = await fullGame();
    s.sendSeats([{ seat: 1, claimed: false, playerId: null, avatarId: 'rogue' }]);
    await until('forge:seats to be adopted', () => m.avatarByPlayerId !== null);
    expect(m.avatarByPlayerId!.size).toBe(0);
    for (const p of m.view!.players) expect(p).not.toHaveProperty('avatarId');
  });
});

/*
 * Wave 31 §S: `forge:role`, `forge:seats`' `name`, and `over`.
 */
describe('spectator, names and the end of the game (wave 31 §S)', () => {
  it('a joining page is told player, and holds spectator = false', async () => {
    const { m } = await fullGame();
    await until('forge:role to land', () => m.stats.snapshots >= 1);
    expect(m.spectator).toBe(false);
  });

  it('forge:role spectator sets the flag, and promotion clears it', async () => {
    const { s, m } = await fullGame();
    const before = m.revision;
    s.sendRole('spectator');
    await until('the flag', () => m.spectator);
    expect(m.revision, 'subscribers are told').toBeGreaterThan(before);
    s.sendRole('player');
    await until('the promotion', () => !m.spectator);
  });

  it('a refreshed tab that joins as a spectator is promoted without a new snapshot', async () => {
    const s = (server = await startReplayServer());
    s.role = 'spectator';
    const m = await connect(s);
    await sendAndApply(s, m, FRAMES);
    await until('spectator', () => m.spectator);
    const snapshots = m.stats.snapshots;
    s.sendRole('player');
    await until('player', () => !m.spectator);
    expect(m.stats.snapshots).toBe(snapshots);
  });

  it('a malformed or foreign forge:role changes nothing and is recorded', async () => {
    const { s, m } = await fullGame();
    s.sendRole('admin');
    await until('the refusal', () => m.lastInvalid !== null);
    expect(m.spectator).toBe(false);
  });

  it('carries the seat name onto nameByPlayerId, only for a seat that has one', async () => {
    const { s, m } = await fullGame();
    const viewerId = m.view!.players.find((p) => p.isViewer)!.id;
    const theirId = m.view!.players.find((p) => !p.isViewer)!.id;
    expect(m.nameByPlayerId).toBeNull();
    s.sendSeats([
      { seat: 0, claimed: true, playerId: viewerId, name: 'Hadoku' },
      { seat: 1, claimed: true, playerId: theirId },
    ]);
    await until('forge:seats to be adopted', () => m.nameByPlayerId !== null);
    expect([...m.nameByPlayerId!]).toEqual([[viewerId, 'Hadoku']]);
  });

  it('draws the server’s seat name on the BoardPlayer, and leaves an unnamed seat with what Forge calls it', async () => {
    const { s, m } = await fullGame();
    const viewer = m.view!.players.find((p) => p.isViewer)!;
    const other = m.view!.players.find((p) => !p.isViewer)!;
    const forgeName = other.name;
    s.sendSeats([
      { seat: 0, claimed: true, playerId: viewer.id, name: 'Hadoku' },
      { seat: 1, claimed: true, playerId: other.id },
    ]);
    await until('forge:seats to be adopted', () => m.nameByPlayerId !== null);
    expect(m.view!.players.find((p) => p.isViewer)!.name).toBe('Hadoku');
    expect(m.view!.players.find((p) => !p.isViewer)!.name).toBe(forgeName);
  });

  it('over is false in a live game and true once the server’s ending notice has arrived', async () => {
    const { s, m } = await fullGame();
    expect(m.over).toBe(false);
    await sendAndApply(s, m, [
      parseServerFrame({ kind: 'notify', method: 'showErrorDialog', title: 'Match ended', message: 'Forge stopped.' }),
    ]);
    expect(m.over).toBe(true);
  });

  it('an unrelated error dialog does not end the game', async () => {
    const { s, m } = await fullGame();
    await sendAndApply(s, m, [parseServerFrame({ kind: 'notify', method: 'showErrorDialog', title: 'Oops', message: 'x' })]);
    expect(m.over).toBe(false);
  });
});
