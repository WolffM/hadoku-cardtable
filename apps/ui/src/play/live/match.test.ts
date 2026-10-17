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
  drawnOffer,
  blockFocusOf,
  combatCandidates,
  declaringBlockers,
  pickedOf,
  declaringCombat,
  dismissReveal,
  lifePayable,
  lifePayer,
  payingMana,
  payWithLife,
  genuinelyAsked,
  isBlockAssignment,
  ingest,
  isAutoYieldOn,
  MAX_RESYNCS_WITHOUT_PROGRESS,
  nothingToDecide,
  attackersLeft,
  pressButton,
  REFUSED_MS,
  liveBar,
  selectCard,
  flipPerspective,
  selectPlayer,
  setAutoYield,
  setFullControl,
  setSameTarget,
  SAYS_KEPT,
  socketIoMatchTransport,
  startMatch,
  type LiveMatch,
  type MatchTransport,
} from './match.ts';
import { confirmAsk, fixtureFrames, startReplayServer, until, type ReplayServer } from './replay-server.ts';
import { BAR_HOLD_MAX_MS } from './bar-hold.ts';
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
/**
 * Forge's priority-time offer. `pushActionableCards` sends this, weighted.
 * `manaOnlyIds`, wave 53 T: w52 §S's own fact on the SAME frame — every
 * playable ability on these ids is a mana ability. Omitted (not an empty
 * array) when a case wants the "bridge could not tell" state.
 */
const actionable = (ids: number[], manaOnlyIds?: number[]) =>
  parseServerFrame({
    kind: 'notify',
    method: 'setWeaklySelectable',
    cards: ids.map((id) => ({ kind: 'card', id })),
    manaOnly: manaOnlyIds === undefined ? undefined : manaOnlyIds.map((id) => ({ kind: 'card', id })),
  });
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

  /*
   * J12 (wave 64): `lastSelectedCard` used to survive a card-less ask
   * entirely, so `clickOrigin`'s fallback (`gestures/install.ts`) could
   * still anchor a click-targeting arrow to a card the player clicked for a
   * PREVIOUS, already-finished action — stale by the time a plain yes/no
   * opens with nothing to do with it. `showConfirmDialog`/`showOptionDialog`/
   * `showInputDialog` never carry a card on their own wire shape
   * (`packages/forge-wire/src/tier-a.ts`); a NEW one of these clears it.
   */
  it('J12: a card-less ask (showOptionDialog) clears `lastSelectedCard` — a stale click must not supply the next arrow a tail', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    await sendAndApply(s, m, [prompt('Priority'), actionable([mine[0]!])]);
    expect(selectCard(m, mine[0]!)).toBe(true);
    expect(m.lastSelectedCard).toBe(mine[0]);
    s.send(optionAsk('c-ae-j12'));
    await until('the card-less ask', () => currentAsk(m) !== null);
    expect(m.lastSelectedCard).toBeNull();
  });

  it('a refusal marks the card whose click began the act — not a target picked after it — and the mark goes', async () => {
    const { s, m } = await fullGame();
    const { mine, theirs } = ids(m);
    const flash = parseServerFrame({ kind: 'notify', method: 'flashIncorrectAction' });
    await sendAndApply(s, m, [prompt('Priority'), bar(true), actionable([mine[0]!])]);
    expect(selectCard(m, mine[0]!)).toBe(true);
    await sendAndApply(s, m, [prompt('Select target'), selectables([theirs[0]!], 1, 1)]);
    expect(selectCard(m, theirs[0]!)).toBe(true);
    expect(m.actCard).toBe(mine[0]);
    await sendAndApply(s, m, [clear(), prompt('Priority'), bar(true), flash]);
    expect(m.refused).toEqual({ card: mine[0], seq: 1 });
    const at = Date.now();
    await until('the mark to go', () => m.refused === null);
    expect(Date.now() - at).toBeGreaterThanOrEqual(REFUSED_MS - 50);
  });

  it('a refusal with no act of this seat behind it marks nothing', async () => {
    const { s, m } = await fullGame();
    await sendAndApply(s, m, [prompt('Priority'), bar(true), parseServerFrame({ kind: 'notify', method: 'flashIncorrectAction' })]);
    expect(m.refused).toBeNull();
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

  it('a press holds the bar back until Forge shows the next one, and never longer than BAR_HOLD_MAX_MS', async () => {
    const { s, m } = await fullGame();
    await sendAndApply(s, m, [prompt('Priority'), bar(true)]);
    const pressedAt = Date.now();
    expect(pressButton(m, 'ok')).toBe(true);
    expect(m.barHold?.reason).toBe('pressed-ok');
    // The server's bar is never edited: the hold is the only thing between it and the screen.
    expect(m.buttons?.enable1).toBe(true);
    expect(liveBar(m)?.enable1).toBe(false);
    expect(pressButton(m, 'ok')).toBe(false);
    // Forge says nothing more: the bar it showed is live again, as are the board's clicks.
    await until('the hold to lapse', () => m.barHold === null, BAR_HOLD_MAX_MS + 2000);
    expect(Date.now() - pressedAt).toBeGreaterThanOrEqual(BAR_HOLD_MAX_MS - 50);
    expect(liveBar(m)?.enable1).toBe(true);
    expect(m.inputLive).toBe(true);
    expect(pressButton(m, 'ok')).toBe(true);
    await until('both presses', () => s.clientFrames().length === 2);
  });

  it('the next updateButtons lifts a hold at once, whatever it says', async () => {
    const { s, m } = await fullGame();
    await sendAndApply(s, m, [prompt('Priority'), bar(true)]);
    expect(pressButton(m, 'ok')).toBe(true);
    await sendAndApply(s, m, [bar(true)]);
    expect(m.barHold).toBeNull();
    expect(liveBar(m)?.enable1).toBe(true);
  });

  it('"same target for all" rides on the pick while identical triggers wait, and is gone with the next question', async () => {
    const { s, m } = await fullGame();
    const { theirs } = ids(m);
    const target = (more: number) =>
      parseServerFrame({
        kind: 'notify',
        method: 'showPromptMessage',
        player: { kind: 'player', id: 0 },
        message: 'Valakut, the Molten Pinnacle - Select any target',
        card: null,
        targetAbility: { hostCard: { kind: 'card', id: 40 }, abilityId: 7, trigger: '40:9', more },
      });
    await sendAndApply(s, m, [target(2), selectables([theirs[0]!], 1, 1)]);
    expect(m.promptTargetMore).toBe(2);
    setSameTarget(m, true);
    expect(selectPlayer(m, 1)).toBe(true);
    await until('the act', () => s.clientFrames().length === 1);
    expect(s.clientFrames()[0]).toEqual({ ok: true, value: { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: 1 }, triggerEvent: null, sameTarget: true } });

    await sendAndApply(s, m, [target(0), selectables([theirs[0]!], 1, 1)]);
    expect(m.sameTarget, 'unticked for each new question').toBe(false);
    setSameTarget(m, true);
    expect(selectPlayer(m, 1)).toBe(true);
    await until('the second act', () => s.clientFrames().length === 2);
    expect(s.clientFrames()[1], 'nothing waits behind the last one').toEqual({ ok: true, value: { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: 1 }, triggerEvent: null } });
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
/**
 * The operator, 2026-10-16, on activating Nomads en-Kor and choosing its target: *"everything
 * turns black then things turn green again … can we remove the intermittent flashing to black?"*
 * Between a click and Forge's next input the board is told "nothing" several times over — the
 * input stopping, the asks the browser answers itself — and `drawnOffer` keeps the last offer
 * drawn through that silence. `boardInteraction`, what a click may SEND, never holds.
 */
describe('the offer through a click’s turnaround', () => {
  /** `getAbilityToPlay` with one ability: the browser answers it itself (`selfAnswer`). */
  const oneAbility = (callId: string, host: number) =>
    parseServerFrame({ kind: 'ask', callId, method: 'getAbilityToPlay', hostCard: { kind: 'card', id: host }, abilities: [{ kind: 'spellAbility', id: 9001 }], triggerEvent: null });
  const openZones = (callId: string) =>
    parseServerFrame({ kind: 'ask', callId, method: 'openZones', controller: { kind: 'player', id: 0 }, zones: ['Battlefield'], players: [{ kind: 'player', id: 0 }], backupLastZones: true });

  it('activate → its own asks → the target selection: the rest of the offer is drawn throughout, and only Forge’s offer takes a click', async () => {
    const { s, m } = await fullGame();
    const { mine, theirs } = ids(m);
    const [nomads, bears, land] = [mine[0]!, mine[1]!, theirs[0]!];
    await sendAndApply(s, m, [prompt('Priority'), bar(true), actionable([nomads, land])]);
    expect(selectCard(m, nomads)).toBe(true);
    // The clicked card goes dark at once; the rest stays drawn through each "nothing".
    expect(drawnOffer(m).selectable).toEqual(new Set([land]));
    const drawnThrough = (step: string): void => {
      expect(boardInteraction(m).selectable.size, `Forge offers nothing after ${step}`).toBe(0);
      expect(drawnOffer(m).selectable, `the board still draws the offer after ${step}`).toEqual(new Set([land]));
    };
    await sendAndApply(s, m, [clearActionable()]);
    drawnThrough('clearWeaklySelectable');
    await sendAndApply(s, m, [oneAbility('s0-1', nomads)]);
    drawnThrough('getAbilityToPlay');
    // A held outline is not refused, and not sent either: the press waits for Forge's word.
    expect(selectCard(m, land)).toBe(true);
    const selects = () => s.clientFrames().filter((f) => f.ok && 'method' in f.value && f.value.method === 'selectCard').length;
    expect(selects(), 'only the Nomads went out').toBe(1);
    expect(answerAsk(m, 's0-1', 'getAbilityToPlay', { kind: 'spellAbility', id: 9001 })).toBe(true);
    await sendAndApply(s, m, [openZones('s0-2')]);
    drawnThrough('openZones');
    expect(abortAsk(m, 's0-2', 'unsupported', 'answered on mount in the board')).toBe(true);
    drawnThrough('the asks closing');
    await sendAndApply(s, m, [selectables([nomads, bears], 1, 1)]);
    expect(drawnOffer(m).selectable).toEqual(new Set([nomads, bears]));
    expect(drawnOffer(m).selectionOpen).toBe(true);
    // The press waiting on the held land is a play, never an answer to the target question: dropped.
    expect(selects(), 'the kept press never answers a selection').toBe(1);
    await sendAndApply(s, m, [clear(), prompt('Priority'), bar(true), actionable([land])]);
    expect(selects(), 'nor goes out later, once dropped').toBe(1);
  });

  /*
   * e2e/w59-stack.spec.ts's chain reaction, red three times on 2026-10-17: alice cast, her outlines
   * were held through the turnaround, bob responded inside the server's 150 ms grace on telling her
   * she was waiting, and her press on the still-drawn Quicken was refused — the card floated home and
   * nothing was sent, though Forge offered it a moment later.
   */
  it('a press on a held outline is sent the moment Forge offers that card again', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    const [first, second] = [mine[0]!, mine[1]!];
    const selected = () => s.clientFrames().flatMap((f) => (f.ok && 'method' in f.value && f.value.method === 'selectCard' ? [f.value.card.id] : []));
    await sendAndApply(s, m, [prompt('Priority'), bar(true), actionable([first, second])]);
    expect(selectCard(m, first)).toBe(true);
    await sendAndApply(s, m, [clearActionable()]);
    expect(drawnOffer(m).selectable).toEqual(new Set([second]));
    expect(selectCard(m, second), 'the held outline takes the press').toBe(true);
    expect(selected(), 'not sent while Forge has not offered it').toEqual([first]);
    await sendAndApply(s, m, [prompt('Priority'), bar(true), actionable([second])]);
    expect(selected(), 'sent once Forge offers it').toEqual([first, second]);
  });

  it('a press on a held outline is dropped when the hold ends without that card', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    const [first, second] = [mine[0]!, mine[1]!];
    const selected = () => s.clientFrames().flatMap((f) => (f.ok && 'method' in f.value && f.value.method === 'selectCard' ? [f.value.card.id] : []));
    await sendAndApply(s, m, [prompt('Priority'), bar(true), actionable([first, second])]);
    expect(selectCard(m, first)).toBe(true);
    await sendAndApply(s, m, [clearActionable()]);
    expect(selectCard(m, second)).toBe(true);
    await sendAndApply(s, m, [actionable([])]);
    await sendAndApply(s, m, [prompt('Priority'), bar(true), actionable([second])]);
    expect(selected(), 'Forge named a set without it: the press was dropped there').toEqual([first]);
  });

  it('choose the target → Forge stops the selection and the ability resolves: still drawn, until priority names its set', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    const [nomads, bears] = [mine[0]!, mine[1]!];
    await sendAndApply(s, m, [prompt('Target'), bar(false), selectables([nomads, bears], 1, 1)]);
    expect(selectCard(m, bears)).toBe(true);
    await sendAndApply(s, m, [clear()]);
    expect(drawnOffer(m).selectable).toEqual(new Set([nomads]));
    // The caster's own priority, passed by the server: its set shows, then clears — the newest is held.
    await sendAndApply(s, m, [actionable([nomads, bears]), clearActionable()]);
    expect(drawnOffer(m).selectable).toEqual(new Set([nomads, bears]));
    await sendAndApply(s, m, [actionable([nomads])]);
    expect(drawnOffer(m).selectable).toEqual(new Set([nomads]));
  });

  it('Forge naming an EMPTY set ends the hold: nothing is drawn', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    await sendAndApply(s, m, [prompt('Priority'), bar(true), actionable([mine[0]!, mine[1]!])]);
    expect(selectCard(m, mine[0]!)).toBe(true);
    await sendAndApply(s, m, [clearActionable()]);
    expect(drawnOffer(m).selectable.size).toBe(1);
    await sendAndApply(s, m, [actionable([])]);
    expect(drawnOffer(m).selectable.size).toBe(0);
  });

  it('a question this seat answers by hand ends the hold: nothing is drawn under it', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    await sendAndApply(s, m, [prompt('Priority'), bar(true), actionable([mine[0]!, mine[1]!])]);
    expect(selectCard(m, mine[0]!)).toBe(true);
    await sendAndApply(s, m, [clearActionable(), optionAsk('s0-9')]);
    expect(drawnOffer(m).selectable.size).toBe(0);
  });

  it('a click on a button holds nothing: passing priority clears the board at once', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    await sendAndApply(s, m, [prompt('Priority'), bar(true), actionable([mine[0]!, mine[1]!])]);
    expect(pressButton(m, 'ok')).toBe(true);
    await sendAndApply(s, m, [clearActionable()]);
    expect(drawnOffer(m).selectable.size).toBe(0);
  });
});

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

  /*
   * Wave 53 T, w52 follow-up: End Turn was not highlighted for a seat whose
   * only offer was a Signet, because `weaklySelectable`'s only exemption was
   * the viewer's own lands. `manaOnly` (w52 §S, the SAME `setWeaklySelectable`
   * frame) is the fix: a NON-land offered id still clears the loop when it is
   * also named there.
   */
  it('true when the actionable set names ONLY a manaOnly source (a Signet, not a land)', async () => {
    const { s, m } = await fullGame();
    const rock = myNonLand(m); // stands in for a mana rock on the viewer's own battlefield
    await sendAndApply(s, m, [pastAttackers(m), prompt('Priority'), actionable([rock], [rock])]);
    expect(nothingToDecide(m)).toBe(true);
    await barrier(s, m, rock);
  });

  it('false for the SAME non-land card when manaOnly is absent — not every non-land is excused, only one the bridge named', async () => {
    const { s, m } = await fullGame();
    const rock = myNonLand(m);
    await sendAndApply(s, m, [pastAttackers(m), prompt('Priority'), actionable([rock])]);
    expect(nothingToDecide(m)).toBe(false);
    await barrier(s, m, rock);
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
 * `genuinelyAsked` — T9. `LiveBoard.tsx`'s own board-flag gate (wave 63 lane
 * F's "seam filter") combined the SAME two facts by hand; this is the one
 * place that does it now, so a future reader has one function to call rather
 * than a formula to copy correctly.
 */
describe('genuinelyAsked: the fact the board’s priority flag gates on (T9)', () => {
  it('"you": true on the bare bar case — Forge\'s bar live, nothing else open', async () => {
    const { s, m } = await fullGame();
    await sendAndApply(s, m, [prompt('Priority'), bar(true)]);
    expect(genuinelyAsked(m, 'you', { ownDecisionOpen: false, waitingForOpponent: false })).toBe(true);
  });

  it('"you": true whenever the caller\'s own pop-ups say so, even with no bar at all', async () => {
    const { s, m } = await fullGame();
    await sendAndApply(s, m, [prompt('Priority')]);
    expect(genuinelyAsked(m, 'you', { ownDecisionOpen: true, waitingForOpponent: false })).toBe(true);
  });

  it('"you": false once Forge\'s own yield window is up ("Yielding until…"), even with an enabled bar', async () => {
    const { s, m } = await fullGame();
    await sendAndApply(s, m, [prompt('Yielding until end of turn. You may cancel this.'), bar(true)]);
    expect(genuinelyAsked(m, 'you', { ownDecisionOpen: false, waitingForOpponent: false })).toBe(false);
  });

  it('"you": false on the press itself, before Forge sends the next bar, and live again if the hold lapses', async () => {
    const { s, m } = await fullGame();
    await sendAndApply(s, m, [prompt('Priority'), bar(true)]);
    expect(pressButton(m, 'ok')).toBe(true);
    expect(genuinelyAsked(m, 'you', { ownDecisionOpen: false, waitingForOpponent: true })).toBe(false);
    expect(genuinelyAsked(m, 'them', { ownDecisionOpen: false, waitingForOpponent: true })).toBe(true);
    await until('the hold to lapse', () => m.barHold === null, BAR_HOLD_MAX_MS + 2000);
    expect(genuinelyAsked(m, 'you', { ownDecisionOpen: false, waitingForOpponent: false })).toBe(true);
  });

  it('"them": the server\'s waitingForOpponent fact, but never while the viewer\'s own is also open', async () => {
    const { s, m } = await fullGame();
    await sendAndApply(s, m, [prompt('Priority'), bar(false)]);
    expect(genuinelyAsked(m, 'them', { ownDecisionOpen: false, waitingForOpponent: true })).toBe(true);
    expect(genuinelyAsked(m, 'them', { ownDecisionOpen: true, waitingForOpponent: true })).toBe(false);
    expect(genuinelyAsked(m, 'them', { ownDecisionOpen: false, waitingForOpponent: false })).toBe(false);
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
  const texts = (m: LiveMatch): string[] => m.says.map((say) => say.text);
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
    expect(texts(m)).toHaveLength(n);
    expect(texts(m)[0]).toBe('line 1');
    expect(texts(m).at(-1)).toBe(`line ${n}`);
  });

  it('is still bounded, so a very long game cannot grow the log forever', async () => {
    const { s, m } = await fullGame();
    // Fill to exactly the cap in ONE round trip (`sendAndApply` sends the
    // whole batch, then waits once), rather than one await per line — the cap
    // is 2000, and a per-line await would make this test absurdly slow.
    const filler = Array.from({ length: SAYS_KEPT - 1 }, (_, i) => says(`filler ${i}`));
    await sendAndApply(s, m, [says('before the cap'), ...filler]);
    expect(texts(m)).toHaveLength(SAYS_KEPT);
    expect(texts(m)[0]).toBe('before the cap');
    // One more line past the cap: the oldest line is the one that goes.
    await sendAndApply(s, m, [says('one too many')]);
    expect(texts(m)).toHaveLength(SAYS_KEPT);
    expect(texts(m)).not.toContain('before the cap');
    expect(texts(m).at(-1)).toBe('one too many');
  });

  it('a say with no text is not a line', async () => {
    const { s, m } = await fullGame();
    await sendAndApply(s, m, [says(''), says('auto-passed Upkeep step')]);
    expect(texts(m)).toEqual(['auto-passed Upkeep step']);
  });

  it("a line of Forge's game log keeps its entry type and the cards it names", async () => {
    const { s, m } = await fullGame();
    const log = { type: 'STACK_ADD' as const, cards: [{ id: 70, name: 'Opt' }] };
    await sendAndApply(s, m, [parseServerFrame({ kind: 'notify', method: 'message', message: 'Alice cast Opt', title: '', log }), says('full control on')]);
    expect(m.says).toEqual([
      { text: 'Alice cast Opt', log },
      { text: 'full control on', log: null },
    ]);
  });

  it('a snapshot clears the log, and the lines that come after it refill it', async () => {
    const { s, m } = await fullGame();
    await sendAndApply(s, m, [says('auto-passed Upkeep step'), says('paid U — Volcanic Island')]);
    expect(texts(m)).toHaveLength(2);

    s.lose(says('lost')); // a gap: the client must resync, and the server re-sends its kept says
    s.send(says('after the gap'));
    await until('the resync', () => m.stats.snapshots === 2);
    expect(texts(m)).toEqual([]);
    await sendAndApply(s, m, [says('auto-passed Draw step')]);
    expect(texts(m)).toEqual(['auto-passed Draw step']);
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
    expect(texts(m)).toEqual(['auto-passed Upkeep step']);
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

describe('the auto-yield toggle (opponent’s-turn only, one turn)', () => {
  it('sends its event only when the EFFECTIVE state changes, and a turn change expires it with nothing run to clear it', async () => {
    const { s, m } = await fullGame();
    const turn = m.view!.turn;
    expect(isAutoYieldOn(m)).toBe(false);
    expect(setAutoYield(m, false)).toBe(false); // already off: nothing crosses
    expect(s.received.filter((r) => r.event === MATCH_EVENTS.autoYield)).toEqual([]);

    expect(setAutoYield(m, true)).toBe(true);
    expect(isAutoYieldOn(m)).toBe(true);
    expect(setAutoYield(m, true)).toBe(false); // already on, same turn: nothing crosses

    // The turn moves on: the SAME stored toggle now reads off, by the lazy
    // compare alone — nothing here runs on the turn changing.
    await sendAndApply(s, m, [stateDelta({ [GAME_KEY]: { _type: WireType.Game, _id: 1, Turn: { t: 'int', v: turn + 1 } } })]);
    expect(isAutoYieldOn(m)).toBe(false);
    // So pressing Auto Yield again, on the new turn, is a real change and crosses again.
    expect(setAutoYield(m, true)).toBe(true);

    await until('both auto-yield emits', () => s.received.filter((r) => r.event === MATCH_EVENTS.autoYield).length >= 2);
    const seen = s.received.filter((r) => r.event === MATCH_EVENTS.autoYield);
    expect(seen).toEqual([
      { event: MATCH_EVENTS.autoYield, payload: { matchId: s.matchId, on: true } },
      { event: MATCH_EVENTS.autoYield, payload: { matchId: s.matchId, on: true } },
    ]);
    // A preference, not a frame: nothing of it crossed forge:c2s.
    expect(s.clientFrames()).toEqual([]);
  });

  it('Cancel Yield (on=false) sent mid-turn reads off at once, the same turn', async () => {
    const { s, m } = await fullGame();
    expect(setAutoYield(m, true)).toBe(true);
    expect(isAutoYieldOn(m)).toBe(true);
    expect(setAutoYield(m, false)).toBe(true);
    expect(isAutoYieldOn(m)).toBe(false);
    await until('both emits', () => s.received.filter((r) => r.event === MATCH_EVENTS.autoYield).length >= 2);
    expect(s.received.filter((r) => r.event === MATCH_EVENTS.autoYield).map((r) => r.payload)).toEqual([
      { matchId: s.matchId, on: true },
      { matchId: s.matchId, on: false },
    ]);
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

  it('a payment Forge says takes life is paid with a press, one shard each, and the life total is no target', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    const me = m.view!.players.find((p) => p.isViewer)!.id;
    // `InputPayManaOfCostPayment.getMessage`: the Phyrexian line, under a cost no land can pay.
    await sendAndApply(s, m, [payBar(false), promptFor('Gitaxian Probe\n\nPay Mana Cost: {U/P}{U/P}\n(Click on your life total to pay life for phyrexian mana.)', mine[0]!), actionable([])]);
    expect(lifePayable(m)).toBe(true);
    expect([...boardInteraction(m).selectablePlayers]).toEqual([]);
    expect(selectPlayer(m, me)).toBe(false);
    expect(lifePayer(m)).toBe(me);
    const before = s.clientFrames().length;
    expect(payWithLife(m)).toBe(true);
    await until('the life payment reached the server', () => s.clientFrames().length > before);
    expect(s.clientFrames().at(-1)).toMatchObject({ ok: true, value: { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: me } } });
    // Spent until Forge's next frame: {U/P}{U/P} is two presses, each answered first.
    expect(lifePayer(m)).toBeNull();
    expect(payWithLife(m)).toBe(false);
    await sendAndApply(s, m, [payBar(false), promptFor('Pay Mana Cost: {U/P} (2 life paid for phyrexian mana)\n(Click on your life total to pay life for phyrexian mana.)', mine[0]!), actionable([])]);
    expect(lifePayer(m)).toBe(me);
    // A payment with no life line takes no life.
    await sendAndApply(s, m, [payBar(true), promptFor('Pay Mana Cost: {1}{U}', mine[0]!), actionable([mine[0]!])]);
    expect(lifePayable(m)).toBe(false);
    expect(payWithLife(m)).toBe(false);
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
 * A Forge window's two halves, applied together.
 *
 * `showPromptMessage` and `updateButtons` are two notifies, in each input's own order: a
 * confirm sends its Yes/No first (`InputConfirm.showMessage`), a priority window its line first
 * (`InputPassPriority.showMessage`). The server pairs them (`holdPromptWindow`) and marks the
 * first `pairsWithNext`; the client holds it until the second, so `prompt` and `buttons` never
 * belong to two different inputs — measured on a claw as "Priority: Alice … Stack: Empty"
 * under "Search your hand?"'s Yes/No, and "Select a card from your hand" under "Cancel Search?"'s.
 */
describe('a window is applied whole: a prompt never stands under another input’s bar', () => {
  const yesNo = parseServerFrame({
    kind: 'notify',
    method: 'updateButtons',
    owner: { kind: 'player', id: 0 },
    label1: 'Yes',
    label2: 'No',
    enable1: true,
    enable2: true,
    focus1: true,
  });

  /** Deliver `frame` marked `pairsWithNext`, and wait until the client has taken it. */
  async function firstHalf(s: ReplayServer, m: LiveMatch, frame: ServerFrame): Promise<void> {
    const target = m.stats.applied + 1;
    const cursor = s.lose(frame);
    s.sendRaw({ ...s.sent(cursor.seq), pairsWithNext: true });
    await until('the first half taken', () => m.stats.applied >= target);
  }

  it("a confirm's Yes/No, sent before its question, is not drawn under the priority line", async () => {
    const { s, m } = await fullGame();
    await sendAndApply(s, m, [prompt('Priority: Alice'), bar(true)]);

    await firstHalf(s, m, yesNo);
    expect(m.prompt).toBe('Priority: Alice');
    expect(liveBar(m)).toMatchObject({ label1: 'OK', label2: 'Cancel' });

    await sendAndApply(s, m, [prompt('Search your hand?')]);
    expect(m.prompt).toBe('Search your hand?');
    expect(liveBar(m)).toMatchObject({ label1: 'Yes', label2: 'No', enable1: true, enable2: true });
    expect(m.windowHalf).toBeNull();
  });

  it("a priority line, sent before its bar, is not drawn over the last window's Yes/No", async () => {
    const { s, m } = await fullGame();
    await sendAndApply(s, m, [yesNo, prompt('Cancel Search?')]);

    await firstHalf(s, m, prompt('Priority: Alice'));
    expect(m.prompt).toBe('Cancel Search?');
    expect(liveBar(m)).toMatchObject({ label1: 'Yes', label2: 'No' });

    await sendAndApply(s, m, [bar(true)]);
    expect(m.prompt).toBe('Priority: Alice');
    expect(liveBar(m)).toMatchObject({ label1: 'OK', label2: 'Cancel' });
  });

  it('a resync drops a held half: the server re-sends the window whole after the snapshot', async () => {
    const { s, m } = await fullGame();
    await sendAndApply(s, m, [prompt('Priority: Alice'), bar(true)]);
    await firstHalf(s, m, yesNo);
    expect(m.windowHalf).not.toBeNull();

    // A frame lost on the way: the gap asks for a snapshot, and nothing held from before it survives.
    s.lose(prompt('Search your hand?'));
    s.send(sentinel());
    await until('the resync snapshot', () => m.stats.snapshots === 2);
    expect(m.windowHalf).toBeNull();
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
  it('blocking: Forge’s current attacker is the block focus, never a picked card (the operator, 2026-10-09: "a green checkmark on one of the attackers? that\'s weird")', async () => {
    const { s, m } = await fullGame();
    const { theirs } = ids(m);
    // InputBlock marks the attacker the next blocker click goes to (`InputBlock.java:192`).
    await sendAndApply(s, m, [phase('COMBAT_DECLARE_BLOCKERS', them(m).id), mark([theirs[0]!])]);
    expect(declaringBlockers(m)).toBe(true);
    expect(blockFocusOf(m)).toBe(theirs[0]);
    expect(pickedOf(m).size, 'no check on it').toBe(0);
    // Outside the block step the same mark is a pick, as before.
    await sendAndApply(s, m, [phase('MAIN2', me(m).id)]);
    expect(blockFocusOf(m)).toBeNull();
    expect(pickedOf(m).has(theirs[0]!)).toBe(true);
  });

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

  /*
   * `InputBlock.onCardSelected` undoes a block when the click lands on a
   * creature already blocking the current attacker
   * (`InputBlock.java:132-146`, "lblRemoveFromCombat"), but
   * `pushBlockerCandidates` drops a creature from the offer once it IS
   * assigned, so the second click that would undo it had nowhere to land.
   * `declaredBlockers` (through `boardInteraction`) reads the wire's own
   * planned map (`adapter.ts`'s `CombatBand.plannedBlockers`) to offer it
   * back, and stops offering it the moment Forge's own next frame no longer
   * carries the assignment — with no click of ours in between, so this is
   * the map's own say, not `spent` catching up with one.
   */
  it('a creature already blocking is offered too, and stops being offered once Forge drops the assignment', async () => {
    const { s, m } = await fullGame();
    const { mine } = ids(m);
    const attackers = them(m).battlefield.map((c) => c.id).slice(0, 1);
    const combat = (pblk: number[]) =>
      stateDelta({
        [GAME_KEY]: {
          _type: WireType.Game,
          _id: 1,
          CombatView: { t: 'combat', atk: [attackers], def: [[1, me(m).id]], blk: [[]], pblk: [pblk] },
        },
      });
    await sendAndApply(s, m, [
      phase('COMBAT_DECLARE_BLOCKERS', them(m).id),
      prompt('Select a blocker'),
      attacking(attackers),
      // InputBlock's own signature: its current attacker, marked (`InputBlock.setCurrentAttacker`).
      highlight([{ kind: 'card', id: attackers[0]! }], true),
    ]);
    expect(declaringBlockers(m)).toBe(true);
    // Not offered before the wire says this creature is blocking anything.

    await sendAndApply(s, m, [combat([mine[0]!])]);
    expect(boardInteraction(m).selectable.has(mine[0]!)).toBe(true);

    // Forge's own next frame drops the assignment: the offer drops with it,
    // with nothing of ours sent in between.
    await sendAndApply(s, m, [combat([])]);

    // And once offered again, the click out is an ordinary `selectCard` —
    // Forge decides what it means, same as every other offer.
    await sendAndApply(s, m, [combat([mine[0]!])]);
    expect(selectCard(m, mine[0]!)).toBe(true);
    await until('the undo act', () => s.clientFrames().length >= 1);
    expect(s.clientFrames()).toEqual([cardAct(mine[0]!)]);

    // Blocks confirmed: `InputBlock.onOk` unmarks its current attacker. The step's priority stop
    // that follows takes neither the attacker nor the blocker — nothing of combat is offered.
    await sendAndApply(s, m, [highlight([{ kind: 'card', id: attackers[0]! }], false)]);
    expect(boardInteraction(m).selectable.has(mine[0]!), 'the blocker, at priority').toBe(false);
    expect(boardInteraction(m).selectable.has(attackers[0]!), 'the attacker, at priority').toBe(false);
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

  /**
   * `InputAttack`'s own bar — button 2 reads `Alpha Strike` before anything
   * is declared, `Call Back` once something is (`CALL_BACK_LABEL`'s own
   * note). The one bar shape that should ever make the opponent a drop
   * target.
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
  /**
   * A genuinely live, forwarded bar that is NOT about attacking — Forge's
   * own `InputPassPriority.showYieldSuggestionPrompt` ("Accept"/"Decline",
   * `en-US.properties`' `lblAccept`/`lblDecline`), which can land on this
   * seat's screen DURING `COMBAT_DECLARE_ATTACKERS` while End Turn is
   * skipping it (confirmed against a real jar: this exact shape reached the
   * wire and lit the opponent up before this gate read the label).
   */
  const yieldSuggestionBar = () =>
    parseServerFrame({
      kind: 'notify',
      method: 'updateButtons',
      owner: { kind: 'player', id: 0 },
      label1: 'Accept',
      label2: 'Decline',
      enable1: true,
      enable2: true,
      focus1: true,
    });

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

  it('a creature given every creature type reads (All), as Forge’s own type line does', async () => {
    const { s, m } = await fullGame();
    const creature = them(m).battlefield.find((c) => c.card.typeLine.startsWith('Creature'))!;
    const sub = creature.card.typeLine.split(' — ')[1]?.split(' ') ?? [];
    const allTypes = (exc: string[]) =>
      stateDelta({
        [deltaKey(WireType.CardState, creature.id * 16)]: {
          _type: WireType.CardState,
          _id: creature.id * 16,
          Type: { t: 'cardtype', sup: [], core: ['Creature'], sub, all: true, exc },
        },
      });
    await sendAndApply(s, m, [allTypes([])]);
    const all = them(m).battlefield.find((c) => c.id === creature.id)!;
    expect(all.card.typeLine).toBe([`Creature —`, ...sub, '(All)'].join(' '));
    await sendAndApply(s, m, [allTypes(['Elf'])]);
    expect(them(m).battlefield.find((c) => c.id === creature.id)!.card.typeLine).toMatch(/\(All except Elf\)$/);
  });

  it('combatCandidates: Forge’s attack candidates while InputAttack is live, and nothing at the same step’s priority', async () => {
    const { s, m } = await fullGame();
    const attacker = me(m).battlefield.find((c) => !c.tapped)!.id;
    expect(combatCandidates(m).size).toBe(0);
    await sendAndApply(s, m, [phase('COMBAT_DECLARE_ATTACKERS', me(m).id), prompt('Declare attackers'), attackBar(), actionable([attacker])]);
    expect([...combatCandidates(m)]).toEqual([attacker]);
    // Attacks confirmed: the step's own priority pushes an ordinary actionable set, which is not this.
    await sendAndApply(s, m, [yieldSuggestionBar(), actionable([attacker])]);
    expect(combatCandidates(m).size).toBe(0);
  });

  it('combatCandidates: the attack window closes on the OK press itself, and is live again if the hold lapses', async () => {
    const { s, m } = await fullGame();
    const attacker = me(m).battlefield.find((c) => !c.tapped)!.id;
    await sendAndApply(s, m, [phase('COMBAT_DECLARE_ATTACKERS', me(m).id), prompt('Declare attackers'), attackBar(true), actionable([attacker])]);
    expect([...combatCandidates(m)]).toEqual([attacker]);
    expect(pressButton(m, 'ok')).toBe(true);
    expect(combatCandidates(m).size).toBe(0);
    await until('the hold to lapse', () => m.barHold === null, BAR_HOLD_MAX_MS + 2000);
    expect([...combatCandidates(m)]).toEqual([attacker]);
  });

  it('a planeswalker is offered as a card target while declaring attackers, and attackAssignment says ASSIGN', async () => {
    const { s, m } = await fullGame();
    const attacker = me(m).battlefield.find((c) => !c.tapped)!.id;
    const pw = them(m).battlefield[0]!.id;
    await sendAndApply(s, m, [retypePlaneswalker(pw)]);
    expect(them(m).battlefield.find((c) => c.id === pw)!.card.typeLine).toContain('Planeswalker');

    await sendAndApply(s, m, [phase('COMBAT_DECLARE_ATTACKERS', me(m).id), prompt('Declare attackers'), attackBar(), actionable([attacker])]);
    expect(declaringAttackers(m)).toBe(true);
    expect(boardInteraction(m).selectable.has(pw)).toBe(true);
    expect(attackAssignment(m, attacker, { kind: 'card', id: pw })).toBe('assign');
  });

  /*
   * The operator, 2026-10-13: "enemy planeswalker is showing as clickable". Production match
   * m-a58ab8a6bb79: at the attacker's own priority stop in declare attackers (OK / End Turn, Forge's
   * offer naming none of the opponent's cards) the seat clicked the opponent's planeswalker, the board
   * sent it, and Forge never answered (`act-unanswered`). A defender is InputAttack's click only.
   */
  it('the opponent’s planeswalker is not offered at the declare-attackers priority stop, nor under any bar but InputAttack’s', async () => {
    const { s, m } = await fullGame();
    const attacker = me(m).battlefield.find((c) => !c.tapped)!.id;
    const pw = them(m).battlefield[0]!.id;
    await sendAndApply(s, m, [retypePlaneswalker(pw)]);
    await sendAndApply(s, m, [phase('COMBAT_DECLARE_ATTACKERS', me(m).id), prompt('Declare attackers'), attackBar(true), actionable([attacker])]);
    expect(boardInteraction(m).selectable.has(pw), 'InputAttack takes it').toBe(true);
    // Attacks confirmed: the same step's priority — Forge's own OK / End Turn bar and its ordinary offer.
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
    await sendAndApply(s, m, [prompt('Priority'), endTurnBar, actionable([attacker])]);
    expect(declaringAttackers(m)).toBe(true);
    expect(boardInteraction(m).selectable.has(pw), 'the priority stop does not').toBe(false);
    expect(attackAssignment(m, attacker, { kind: 'card', id: pw })).toBe(null);
    await sendAndApply(s, m, [yieldSuggestionBar()]);
    expect(boardInteraction(m).selectable.has(pw), 'nor a yield suggestion').toBe(false);
  });

  it('the opponent is offered as a player target while declaring attackers, and attackAssignment says ASSIGN', async () => {
    const { s, m } = await fullGame();
    const attacker = me(m).battlefield.find((c) => !c.tapped)!.id;
    const opponent = them(m).id;
    // The live window itself, bar included — real Forge opens InputAttack
    // with a pressable bar (`w51-control-box.spec.ts`'s own "declaring:
    // Forge's OK is the pop-up's"), not merely a phase change.
    await sendAndApply(s, m, [phase('COMBAT_DECLARE_ATTACKERS', me(m).id), prompt('Declare attackers'), attackBar(), actionable([attacker])]);
    expect(boardInteraction(m).selectablePlayers.has(opponent)).toBe(true);
    expect(attackAssignment(m, attacker, { kind: 'player', id: opponent })).toBe('assign');
  });

  it('the opponent is NOT offered as a player target merely because the phase changed and the seat’s own creatures were named — the bar itself has to be live', async () => {
    const { s, m } = await fullGame();
    const attacker = me(m).battlefield.find((c) => !c.tapped)!.id;
    const opponent = them(m).id;
    // The seat's own last bar is already disabled (e.g. its own End Turn
    // click just disabled it) when the phase moves to declare-attackers and
    // a weakly-selectable update for the seat's own creatures still arrives
    // — the shape a window the server is about to auto-pass leaves on the
    // wire. No live bar ever follows it, so the opponent must not light up.
    await sendAndApply(s, m, [bar(false)]);
    await sendAndApply(s, m, [phase('COMBAT_DECLARE_ATTACKERS', me(m).id), actionable([attacker])]);
    expect(declaringAttackers(m)).toBe(true);
    expect(boardInteraction(m).selectablePlayers.has(opponent)).toBe(false);
  });

  it('a genuinely live bar that is not InputAttack’s own does not make the opponent a target either — the yield-suggestion prompt, confirmed against a real jar', async () => {
    const { s, m } = await fullGame();
    const attacker = me(m).battlefield.find((c) => !c.tapped)!.id;
    const opponent = them(m).id;
    // Forge's own End-Turn yield can open ITS OWN, unrelated question
    // (Accept/Decline the yield) while the phase already reads
    // COMBAT_DECLARE_ATTACKERS — a real, live, forwarded bar, just not this
    // one. `boardInteraction` must tell the two apart by Forge's own button
    // label, not merely "something is pressable".
    await sendAndApply(s, m, [phase('COMBAT_DECLARE_ATTACKERS', me(m).id), prompt('Yielding until end of turn.'), yieldSuggestionBar(), actionable([attacker])]);
    expect(declaringAttackers(m)).toBe(true);
    expect(boardInteraction(m).selectablePlayers.has(opponent)).toBe(false);
  });

  it('a defender this attacker already attacks (Forge’s own CombatView) reads ALREADY, not assign', async () => {
    const { s, m } = await fullGame();
    const attacker = me(m).battlefield.find((c) => !c.tapped)!.id;
    const opponent = them(m).id;
    await sendAndApply(s, m, [
      phase('COMBAT_DECLARE_ATTACKERS', me(m).id),
      prompt('Declare attackers'),
      attackBar(true),
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
 * X3 — the counterspell arc's CLIENT-SIDE pairing (`stackTargetIntent`/
 * `stackTargetArcs`, claimed from inside `answerAsk`) is gone (wave 64/J6):
 * its one reader, `gestures/auto-targets.ts`'s `stackTargetArrows`, had no
 * caller left once `live/placed.ts` started drawing the arc straight off the
 * bridge's own wire fact, `stackTargetSpells` (wave 49 §A,
 * `StackEntry.targetStackItemId`) — true for every seat already, caster and
 * opponent alike, with no ask to answer and no claim-and-prune. That wire
 * fact's own fold (`fold.ts`'s `FoldResult.stackTargetSpells`) is still
 * covered, by the adapter and fold suites that exercise it directly.
 */
/*
 * A permanent tapped for mana untaps on a click when its mana is unspent and the
 * tap fired nothing, in any order (the operator, six times; ledger V6, AC7, AE21).
 * Forge decides which ones: it offers each such permanent in its actionable set
 * (`AvailableActions.cardHasActionable`) and undoes that one activation on the
 * click (`InputPassPriority.onCardSelected` → `PlayerControllerHuman.tryUndo`).
 * The board keeps no record of its own: the click is a plain `selectCard`.
 */
describe('a tapped permanent is clicked to untap exactly when Forge offers it', () => {
  const me = (m: LiveMatch) => m.view!.players.find((p) => p.isViewer)!;
  const tap = (id: number, tapped: boolean) =>
    stateDelta({ [String(id)]: { _type: WireType.Card, _id: id, Tapped: { t: 'bool', v: tapped } } });
  const bar = (label2: string, enable2 = true) =>
    parseServerFrame({ kind: 'notify', method: 'updateButtons', owner: { kind: 'player', id: 0 }, label1: 'OK', label2, enable1: true, enable2, focus1: true });

  async function twoTapped() {
    const { s, m } = await fullGame();
    const lands = me(m).battlefield.filter((c) => c.card.typeLine.includes('Land')).map((c) => c.id);
    expect(lands.length, 'the fixture gives this seat two lands').toBeGreaterThanOrEqual(2);
    const [a, b] = lands as [number, number];
    await sendAndApply(s, m, [tap(a, true), tap(b, true), prompt('Priority'), bar('Undo (2)')]);
    return { s, m, a, b };
  }

  it('the FIRST of two tapped lands, offered by Forge, is clicked as a selectCard — no Undo button press', async () => {
    const { s, m, a, b } = await twoTapped();
    await sendAndApply(s, m, [actionable([a, b])]);
    expect(boardInteraction(m).selectable.has(a)).toBe(true);
    expect(selectCard(m, a)).toBe(true);
    await until('the click at the server', () => s.clientFrames().length === 1);
    expect(s.clientFrames()[0]).toMatchObject({ ok: true, value: { kind: 'act', method: 'selectCard', card: { kind: 'card', id: a } } });
  });

  it('a tapped land Forge does not offer is not clickable, whatever the bar says', async () => {
    const { s, m, a, b } = await twoTapped();
    await sendAndApply(s, m, [actionable([b])]);
    expect(boardInteraction(m).selectable.has(a)).toBe(false);
    expect(selectCard(m, a)).toBe(false);
    expect(s.clientFrames()).toHaveLength(0);
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

describe('cantBlock — the bridge’s own wire fact', () => {
  function applyDeltaWith(payload: Record<string, unknown>): ServerFrame {
    seq += 1;
    return parseServerFrame({
      kind: 'notify',
      method: 'applyDelta',
      payload: { packet: { seq, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: {}, events: [] }, ...payload },
    });
  }

  it('folds onto LiveMatch.cantBlock and onto the creature’s own BoardCard, and a delta without it keeps it', async () => {
    const { s, m } = await fullGame();
    expect(m.cantBlock.size, 'empty before any frame carries it').toBe(0);
    const id = m.view!.players.find((p) => p.isViewer)!.battlefield[0]!.id;
    await sendAndApply(s, m, [applyDeltaWith({ cantBlock: [id] })]);
    expect([...m.cantBlock]).toEqual([id]);
    expect(m.view!.players.flatMap((p) => p.battlefield).filter((c) => c.cantBlock === true).map((c) => c.id)).toEqual([id]);
    await sendAndApply(s, m, [phase('MAIN2', m.view!.players.find((p) => p.isViewer)!.id)]);
    expect([...m.cantBlock]).toEqual([id]);
    await sendAndApply(s, m, [applyDeltaWith({ cantBlock: [] })]);
    expect(m.view!.players.flatMap((p) => p.battlefield).some((c) => c.cantBlock === true)).toBe(false);
  });
});

describe('printedTypes — the bridge’s own wire fact', () => {
  function applyDeltaWith(payload: Record<string, unknown>): ServerFrame {
    seq += 1;
    return parseServerFrame({
      kind: 'notify',
      method: 'applyDelta',
      payload: { packet: { seq, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: {}, events: [] }, ...payload },
    });
  }

  it('folds onto the permanent’s own changedFrom, and a delta without it keeps it', async () => {
    const { s, m } = await fullGame();
    const changed = () => m.view!.players.flatMap((p) => p.battlefield).filter((c) => c.changedFrom != null);
    expect(changed(), 'nothing is changed before a frame says so').toEqual([]);
    const permanent = m.view!.players.find((p) => p.isViewer)!.battlefield[0]!;
    const printed = { t: 'cardtype', sup: ['Legendary'], core: ['Tribal'], sub: [], all: false, exc: [] };
    await sendAndApply(s, m, [applyDeltaWith({ printedTypes: [[permanent.id, printed]] })]);
    expect(changed().map((c) => [c.id, c.changedFrom])).toEqual([[permanent.id, { name: permanent.card.name, printed: 'Legendary Tribal' }]]);
    await sendAndApply(s, m, [phase('MAIN2', m.view!.players.find((p) => p.isViewer)!.id)]);
    expect(changed().map((c) => c.id)).toEqual([permanent.id]);
    await sendAndApply(s, m, [applyDeltaWith({ printedTypes: [] })]);
    expect(changed()).toEqual([]);
  });
});

describe('lifePaying — life committed to an open payment', () => {
  function applyDeltaWith(payload: Record<string, unknown>, objectDeltas: Record<string, unknown> = {}): ServerFrame {
    seq += 1;
    return parseServerFrame({
      kind: 'notify',
      method: 'applyDelta',
      payload: { packet: { seq, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas, events: [] }, ...payload },
    });
  }
  const lifeDelta = (pid: number, life: number) => ({ [deltaKey(WireType.Player, pid)]: { _type: WireType.Player, _id: pid, Life: { t: 'int', v: life } } });
  const lives = (m: LiveMatch) => Object.fromEntries(m.view!.players.map((p) => [p.isViewer ? 'me' : 'them', p.life]));

  it('each press comes off the payer’s life on the board, and the payment’s end draws Forge’s own total without a step back', async () => {
    const { s, m } = await fullGame();
    const me = m.view!.players.find((p) => p.isViewer)!;
    const start = lives(m);
    await sendAndApply(s, m, [applyDeltaWith({ lifePaying: [[me.id, 2]] })]);
    expect(lives(m)).toEqual({ ...start, me: me.life - 2 });
    await sendAndApply(s, m, [applyDeltaWith({ lifePaying: [[me.id, 4]] })]);
    expect(lives(m)).toEqual({ ...start, me: me.life - 4 });
    // A delta that does not restate it keeps it.
    await sendAndApply(s, m, [phase('MAIN2', me.id)]);
    expect(lives(m)).toEqual({ ...start, me: me.life - 4 });
    // Forge takes the life: the frame with the new total no longer holds the payment.
    await sendAndApply(s, m, [applyDeltaWith({ lifePaying: [] }, lifeDelta(me.id, me.life - 4))]);
    expect(lives(m)).toEqual({ ...start, me: me.life - 4 });
  });

  it('a cancelled payment gives the life back: Forge never took it', async () => {
    const { s, m } = await fullGame();
    const me = m.view!.players.find((p) => p.isViewer)!;
    await sendAndApply(s, m, [applyDeltaWith({ lifePaying: [[me.id, 2]] })]);
    expect(m.view!.players.find((p) => p.isViewer)!.life).toBe(me.life - 2);
    await sendAndApply(s, m, [applyDeltaWith({ lifePaying: [] })]);
    expect(m.view!.players.find((p) => p.isViewer)!.life).toBe(me.life);
  });

  it('the opponent’s payment shows on the opponent’s total', async () => {
    const { s, m } = await fullGame();
    const them = m.view!.players.find((p) => !p.isViewer)!;
    await sendAndApply(s, m, [applyDeltaWith({ lifePaying: [[them.id, 2]] })]);
    expect(lives(m)).toEqual({ me: m.view!.players.find((p) => p.isViewer)!.life, them: them.life - 2 });
  });
});

describe('deaths — the bridge’s causes', () => {
  function applyDeltaWith(payload: Record<string, unknown>): ServerFrame {
    seq += 1;
    return parseServerFrame({
      kind: 'notify',
      method: 'applyDelta',
      payload: { packet: { seq, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: {}, events: [] }, ...payload },
    });
  }

  it('each death’s cause lands on BoardView.deathCauses by card id, the newest kept', async () => {
    const { s, m } = await fullGame();
    expect(m.view!.deathCauses).toBeUndefined();
    await sendAndApply(s, m, [applyDeltaWith({ deaths: [[901, 'LETHAL_DAMAGE'], [902, 'DESTROYED']] }), applyDeltaWith({ deaths: [[901, 'SACRIFICED']] })]);
    expect([...m.view!.deathCauses!]).toEqual([
      [902, 'DESTROYED'],
      [901, 'SACRIFICED'],
    ]);
  });
});

describe('damage — the bridge’s own hits', () => {
  function applyDeltaWith(payload: Record<string, unknown>): ServerFrame {
    seq += 1;
    return parseServerFrame({
      kind: 'notify',
      method: 'applyDelta',
      payload: { packet: { seq, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: {}, events: [] }, ...payload },
    });
  }

  it('each hit is numbered as it comes onto LiveMatch.hits and BoardView.hits, a source of -1 is none, and a delta without any keeps them', async () => {
    const { s, m } = await fullGame();
    expect(m.view!.hits, 'no hits before any frame carries one').toBeUndefined();
    const id = m.view!.players.find((p) => p.isViewer)!.battlefield[0]!.id;
    await sendAndApply(s, m, [applyDeltaWith({ damage: [[id, 131, 3]] }), applyDeltaWith({ damage: [[id, -1, 1]] })]);
    expect(m.view!.hits).toEqual([
      { seq: 1, cardId: id, sourceId: 131, amount: 3 },
      { seq: 2, cardId: id, sourceId: null, amount: 1 },
    ]);
    await sendAndApply(s, m, [phase('MAIN2', m.view!.players.find((p) => p.isViewer)!.id)]);
    expect(m.view!.hits?.map((h) => h.seq), 'an event list: kept, and never drawn twice (numbers reads above the last seq)').toEqual([1, 2]);
  });
});

describe('conditionMet — the bridge’s own wire fact', () => {
  function applyDeltaWith(payload: Record<string, unknown>): ServerFrame {
    seq += 1;
    return parseServerFrame({
      kind: 'notify',
      method: 'applyDelta',
      payload: { packet: { seq, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: {}, events: [] }, ...payload },
    });
  }

  it('folds onto LiveMatch.conditionMet and onto the card’s own BoardCard, and a delta without it keeps it', async () => {
    const { s, m } = await fullGame();
    expect(m.conditionMet.size, 'empty before any frame carries it').toBe(0);
    const viewer = m.view!.players.find((p) => p.isViewer)!;
    const field = viewer.battlefield[0]!.id;
    const held = viewer.hand![0]!.id;
    await sendAndApply(s, m, [applyDeltaWith({ conditionMet: [field, held] })]);
    expect([...m.conditionMet]).toEqual([field, held]);
    const lit = () => m.view!.players.flatMap((p) => [...p.battlefield, ...(p.hand ?? [])]).filter((c) => c.conditionMet === true).map((c) => c.id);
    expect(lit()).toEqual([field, held]);
    await sendAndApply(s, m, [phase('MAIN2', viewer.id)]);
    expect([...m.conditionMet]).toEqual([field, held]);
    await sendAndApply(s, m, [applyDeltaWith({ conditionMet: [] })]);
    expect(lit()).toEqual([]);
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

/**
 * `forge:seats`' `waitingOn`, keyed by SEAT rather than
 * player id because an ask can precede `openView`.
 */
describe('waitingOn', () => {
  it('is null before forge:seats has ever arrived', async () => {
    const { m } = await fullGame();
    expect(m.waitingOn).toBeNull();
  });

  it('carries a seat that has one, and leaves the key off the entry for a seat that does not', async () => {
    const { s, m } = await fullGame();
    s.sendSeats([
      { seat: 0, claimed: true, playerId: 0, waitingOn: { method: 'getChoices', hostCard: 'Thirst for Knowledge' } },
      { seat: 1, claimed: true, playerId: 1 },
    ]);
    await until('forge:seats to be adopted', () => m.waitingOn !== null);
    expect(m.waitingOn!.get(0)).toEqual({ method: 'getChoices', hostCard: 'Thirst for Knowledge' });
    expect(m.waitingOn!.has(1)).toBe(false);
  });

  it('a later forge:seats with nobody waiting replaces the map rather than leaving a stale entry', async () => {
    const { s, m } = await fullGame();
    s.sendSeats([{ seat: 0, claimed: true, playerId: 0, waitingOn: { method: 'confirm', hostCard: null } }]);
    await until('forge:seats to be adopted', () => (m.waitingOn?.size ?? 0) > 0);
    s.sendSeats([{ seat: 0, claimed: true, playerId: 0 }]);
    await until('the clear to be adopted', () => (m.waitingOn?.size ?? -1) === 0);
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

  it('forge:role watcher: a spectator with no seat, both hands as counts, a perspective of its own — and a promotion puts the table back (2026-10-12)', async () => {
    const { s, m } = await fullGame();
    const bottom = m.view!.players.find((p) => p.isViewer)!.id;
    expect(m.view!.players.find((p) => p.isViewer)!.hand, 'a seat sees its own hand').not.toBeNull();
    expect(flipPerspective(m), 'a seat’s own window cannot turn the table').toBe(false);
    s.sendRole('watcher');
    await until('the flag', () => m.watcher);
    expect(m.spectator, 'a watcher is also a spectator: every gate holds').toBe(true);
    expect(m.view!.players.every((p) => p.hand === null), 'both hands are counts').toBe(true);
    expect(m.view!.players.find((p) => p.isViewer)!.id, 'the snapshot’s side is the default').toBe(bottom);
    const before = m.revision;
    expect(flipPerspective(m)).toBe(true);
    expect(m.view!.players.find((p) => p.isViewer)!.id).not.toBe(bottom);
    expect(m.perspective).not.toBeNull();
    expect(m.revision, 'subscribers are told').toBeGreaterThan(before);
    expect(m.view!.players.every((p) => p.hand === null), 'still counts, from the other side').toBe(true);
    s.sendRole('player');
    await until('the promotion', () => !m.watcher);
    expect(m.spectator).toBe(false);
    expect(m.perspective).toBeNull();
    expect(m.view!.players.find((p) => p.isViewer)!.id).toBe(bottom);
    expect(m.view!.players.find((p) => p.isViewer)!.hand).not.toBeNull();
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

describe('a display-only reveal is a notice, never a question', () => {
  function reveal(callId: string): ServerFrame {
    return parseServerFrame({
      kind: 'ask',
      callId,
      method: 'getChoices',
      message: 'Looking at cards in your library',
      min: -1,
      max: -1,
      choices: [{ key: 'c0', label: 'Genju of the Spires (121)', ref: { kind: 'card', id: 121 } }],
      selected: [],
    });
  }

  /** Stamp `frame` on the replay server's stream, deliver it marked `displayOnly`, and wait until it is applied. */
  async function showReveal(s: ReplayServer, m: LiveMatch, frame: ServerFrame): Promise<void> {
    const target = m.stats.applied + 1;
    const cursor = s.lose(frame);
    s.sendRaw({ ...s.sent(cursor.seq), displayOnly: true });
    await until('the reveal applied', () => m.stats.applied >= target);
  }

  it('is held as the reveal, opens no ask, and sends nothing back', async () => {
    const { s, m } = await fullGame();
    await showReveal(s, m, reveal('r1'));
    expect(m.reveal?.callId).toBe('r1');
    expect(m.asks).toEqual([]);
    expect(currentAsk(m)).toBeNull();
    expect(s.clientFrames().filter((f) => f.ok && f.value.kind !== 'act')).toEqual([]);
  });

  it("the seat's next real question takes its place", async () => {
    const { s, m } = await fullGame();
    await showReveal(s, m, reveal('r2'));
    await sendAndApply(s, m, [optionAsk('o2')]);
    expect(m.reveal).toBeNull();
    expect(currentAsk(m)?.callId).toBe('o2');
  });

  it('dismissing it clears it; a stale dismissal of another reveal does not', async () => {
    const { s, m } = await fullGame();
    await showReveal(s, m, reveal('r3'));
    dismissReveal(m, 'r-old');
    expect(m.reveal?.callId).toBe('r3');
    dismissReveal(m, 'r3');
    expect(m.reveal).toBeNull();
  });

  it('only a getChoices reveal may be display-only: anything else so marked is counted invalid', async () => {
    const { s, m } = await fullGame();
    const invalid = m.stats.invalid;
    await showReveal(s, m, optionAsk('o4'));
    expect(m.reveal).toBeNull();
    expect(m.asks).toEqual([]);
    expect(m.stats.invalid).toBe(invalid + 1);
  });
});
