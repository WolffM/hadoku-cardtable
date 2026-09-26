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

import { boardFromFixture, PLAY_FIXTURES } from '../fixtures.ts';
import {
  abortAsk,
  answerAsk,
  answerConfirm,
  boardInteraction,
  closeMatch,
  currentAsk,
  ingest,
  MAX_RESYNCS_WITHOUT_PROGRESS,
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

/** Card ids on the fixture board: the viewer's battlefield, and the opponent's. */
function ids(m: LiveMatch): { mine: number[]; theirs: number[] } {
  const players = m.view!.players;
  const mine = players.find((p) => p.isViewer)!.battlefield.map((c) => c.id);
  const theirs = players.find((p) => !p.isViewer)!.battlefield.map((c) => c.id);
  expect(mine.length).toBeGreaterThan(1);
  expect(theirs.length).toBeGreaterThan(0);
  return { mine, theirs };
}

const cardAct = (id: number) => ({
  ok: true,
  value: { kind: 'act', method: 'selectCard', card: { kind: 'card', id }, otherCardViewsToSelect: [], triggerEvent: null },
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
    expect(m.selectables).toEqual({ cards: new Set([mine[0], theirs[0]]), min: 1, max: 2 });
    expect(boardInteraction(m).selectable).toEqual(new Set([mine[0], theirs[0]]));

    await sendAndApply(s, m, [selectables([mine[1]!], 0, 1)]);
    expect(m.selectables).toEqual({ cards: new Set([mine[1]]), min: 0, max: 1 });
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

  it('selectPlayer carries the player, and a snapshot drops a selection the server will not re-send', async () => {
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
    expect(m.selectables).toBeNull();
    expect(m.weaklySelectable).toBeNull();
    expect(selectCard(m, theirs[0]!)).toBe(false);
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

  it('holds the last things said, newest last, capped at eight', async () => {
    const { s, m } = await fullGame();
    for (let i = 1; i <= SAYS_KEPT + 1; i += 1) await sendAndApply(s, m, [says(`line ${i}`)]);
    expect(m.says).toEqual(['line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9']);
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
