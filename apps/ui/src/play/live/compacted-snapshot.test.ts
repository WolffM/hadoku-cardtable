/**
 * The server compacts each seat's and the watcher's history at the start of every turn
 * (`apps/server/src/play/history.ts`), and a page joins, reconnects and resyncs on what is left. It
 * must leave the page exactly where the whole history would: the same board and the same state
 * facts, read by this client's own fold — `match.ts`'s `adoptSnapshot`, fed through its real
 * transport handlers — not by a server re-implementation of it.
 *
 * The stream is the recorded REAL transcript (`apps/server/src/play/fixtures/
 * bridge-two-seats.ndjson`), one seat's state frames as Forge sent them, carried on by hand-written
 * frames in the bridge's own shapes for what that transcript (recorded before the bridge sent them)
 * has none of: every state fact beside a packet, deaths, a counter, damage, a face emptied the way
 * `visibility.ts`'s `wipeFace` empties one and later written into again, two turn changes and a
 * `setGameView` reset mid-game.
 */

import { describe, expect, it } from 'vitest';
import { DELTA_TYPE, cardStateKey, deltaKey, parseServerFrame, type ServerFrame } from '@hadoku/forge-wire';
import { MatchSnapshotSchema, type MatchSnapshot, type ServerEnvelope } from '@hadoku/shared';

import { loadTranscript, replayFactory, type ReplayHost } from '../../../../server/src/play/fixtures/transcript.ts';
import type { BridgeLine } from '../../../../server/src/play/bridge-protocol.ts';
import { createStateHistory } from '../../../../server/src/play/history.ts';
import { createMatchRegistry, type Match } from '../../../../server/src/play/match.ts';
import { WATCHER_SEAT } from '../../../../server/src/play/match/forge-session.ts';
import { foldFrames, type StateFrame } from '../../../../server/src/play/visibility.ts';
import { closeMatch, startMatch, type LiveMatch, type MatchTransport } from './match.ts';

const TRANSCRIPT = loadTranscript();
const STATE = new Set(['openView', 'setGameView', 'applyDelta']);

const GAME = deltaKey(DELTA_TYPE.game, 1);
const int = (v: number) => ({ t: 'int', v });
const str = (v: string) => ({ t: 'str', v });

/** Seat 0's state frames in the transcript, as Forge sent them: openView, three setGameView resets, the opening deltas, turn 1. */
const SEAT0 = TRANSCRIPT.filter((l): l is Extract<BridgeLine, { t: 'frame' }> => l.t === 'frame' && l.seat === 0)
  .map((l) => l.frame as ServerFrame)
  .filter((f) => STATE.has(f.method));

/** Two cards the opening deals, and the face of the first: objects the board holds from turn 1 on. */
const [CARD_A, CARD_B] = (() => {
  const opening = SEAT0.find((f) => f.method === 'applyDelta') as unknown as Extract<StateFrame, { method: 'applyDelta' }>;
  const ids = Object.values(opening.payload.packet.newObjects)
    .filter((o) => o._type === DELTA_TYPE.card)
    .map((o) => o._id);
  return [ids[0]!, ids[1]!];
})();
const FACE_A = cardStateKey(CARD_A, 0);

let seq = 500;
/** One `applyDelta` in the bridge's shape: a packet, and whatever rides beside it. */
function delta(packet: { newObjects?: object; objectDeltas?: object }, beside: object = {}): ServerFrame {
  seq += 1;
  return parseServerFrame(
    { kind: 'notify', method: 'applyDelta', payload: { packet: { seq, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: {}, events: [], ...packet }, ...beside } },
    'hand-written delta',
  );
}

const turn = (n: number) => ({ [GAME]: { _type: DELTA_TYPE.game, _id: 1, Turn: int(n) } });
const life = (player: number, n: number) => ({ [deltaKey(DELTA_TYPE.player, player)]: { _type: DELTA_TYPE.player, _id: player, Life: int(n) } });
const CREATURE = { t: 'cardtype', sup: [], core: ['Creature'], sub: ['Bear'], all: false, exc: [] };
const EVERY_FACT = {
  stackTargetSpells: [[9001, 9000]],
  pendingTriggers: [{ id: 41, hostCard: CARD_A, controller: 0, key: 'k-41', current: true }],
  waitingEffects: [{ source: CARD_A, text: 'At the beginning of your upkeep, draw a card.', kind: 'trigger' }],
  tokenSources: [[CARD_B, CARD_A]],
  cantBlock: [CARD_B],
  printedTypes: [[CARD_A, CREATURE, false]],
  printedPT: [[CARD_A, 2, 2]],
  lifePaying: [[0, 2]],
  conditionMet: [CARD_B],
};

/** The game after the transcript: what the transcript has none of, in the shapes the bridge sends it. */
const TAIL: ServerFrame[] = [
  delta({ objectDeltas: life(0, 18) }, { ...EVERY_FACT, deaths: [[CARD_B, 'DESTROYED']], damage: [[CARD_B, CARD_A, 3]] }),
  // A face emptied as `wipeFace` empties one: an object the page still holds, with no property left.
  delta({ newObjects: { [FACE_A]: { _type: DELTA_TYPE.cardState, _id: CARD_A * 16, Name: null } } }, { counteredStackItems: [9001], faceDamage: [[1, CARD_A, 2, true]] }),
  delta({ objectDeltas: { ...turn(2), ...life(1, 17) } }, { pendingTriggers: [], deaths: [[CARD_A, 'SACRIFICED'], [CARD_B, 'LETHAL_DAMAGE']] }),
  // Written into again: a page that had dropped the empty face would skip this.
  delta({ objectDeltas: { [FACE_A]: { _type: DELTA_TYPE.cardState, _id: CARD_A * 16, Name: str('Grizzly Bears') } } }, { waitingEffects: [], conditionMet: [CARD_A] }),
  delta({ objectDeltas: life(0, 15) }, { lifePaying: [], counteredStackItems: [9002] }),
  // A reset mid-game, naming two facts: every other one goes back to empty on the page. It carries what
  // happened since the last frame too, as Forge's whole view mid-game does: its deaths and counters are kept.
  (() => {
    const view = SEAT0.findLast((f) => f.method === 'setGameView') as unknown as Extract<StateFrame, { method: 'setGameView' }>;
    const gameView = { ...view.payload.gameView, [GAME]: { ...view.payload.gameView[GAME]!, Turn: int(3) } };
    seq += 1;
    return parseServerFrame(
      {
        kind: 'notify',
        method: 'setGameView',
        payload: { gameView, sequenceNumber: seq, stackTargetSpells: [], cantBlock: [CARD_A], deaths: [[CARD_A, 'DEATHTOUCH']], counteredStackItems: [9003], faceDamage: [[0, CARD_B, 1, true]] },
      },
      'hand-written reset',
    );
  })(),
  delta({ objectDeltas: { ...turn(4), ...life(1, 12) } }, { tokenSources: [[CARD_A, CARD_B]], deaths: [[CARD_B, 'ZERO_TOUGHNESS']] }),
  delta({ objectDeltas: life(0, 14) }, { printedPT: [[CARD_B, 1, 1]] }),
];

const GAME_FRAMES = [...SEAT0, ...TAIL];

/** A page's transport whose acks and socket events the test answers by hand. */
function page(playerId: number): { match: LiveMatch; answer(frames: readonly ServerFrame[]): void; reconnect(): void } {
  const acks: ((err: Error | null, response: unknown) => void)[] = [];
  const handlers = new Map<string, (payload: unknown) => void>();
  const transport: MatchTransport = {
    on: (event, handler) => void handlers.set(event, handler),
    emit: () => {},
    request: (_event, _payload, onAck) => void acks.push(onAck),
    disconnect: () => {},
  };
  const match = startMatch({ matchId: 'm', transport, tabId: 'compacted-snapshot-tab' });
  return {
    match,
    answer(frames) {
      const snapshot: MatchSnapshot = { matchId: 'm', seat: playerId, playerId, cursor: { epoch: 'e', seq: 1 }, frames: [...frames] };
      acks.shift()!(null, JSON.parse(JSON.stringify(snapshot)));
      handlers.get('connect')!(undefined);
    },
    reconnect() {
      handlers.get('disconnect')!('transport close');
      handlers.get('connect')!(undefined);
    },
  };
}

/** Everything a page holds that its snapshot's frames decide. */
function held(m: LiveMatch): unknown {
  return {
    error: m.lastError,
    snapshots: m.stats.snapshots,
    state: [...m.state].sort(([a], [b]) => Number(a) - Number(b)),
    forgeSeq: m.forgeSeq,
    stackTargetSpells: [...m.stackTargetSpells],
    pendingTriggers: m.pendingTriggers,
    waitingEffects: m.waitingEffects,
    tokenSources: [...m.tokenSources],
    cantBlock: [...m.cantBlock],
    printedTypes: [...m.printedTypes],
    printedPT: [...m.printedPT],
    lifePaying: [...m.lifePaying],
    conditionMet: [...m.conditionMet],
    deathCauses: [...m.deathCauses],
    counteredStackItems: [...m.counteredStackItems],
    hits: m.hits,
    faceHits: m.faceHits,
    over: m.over,
    view: m.view,
  };
}

/** A fresh page that joined on `frames`, as Forge's player `playerId`. */
function joined(frames: readonly ServerFrame[], playerId = 0): unknown {
  const p = page(playerId);
  p.answer(frames);
  expect(p.match.lastError).toBeNull();
  expect(p.match.stats.snapshots).toBe(1);
  const out = held(p.match);
  closeMatch(p.match);
  return out;
}

/** A page that joined on `first`, lost its socket, and came back to `then`: a mounted board's reconnect. */
function rejoined(first: readonly ServerFrame[], then: readonly ServerFrame[]): unknown {
  const p = page(0);
  p.answer(first);
  p.reconnect();
  p.answer(then);
  expect(p.match.lastError).toBeNull();
  expect(p.match.stats.snapshots).toBe(2);
  const out = held(p.match);
  closeMatch(p.match);
  return out;
}

const methods = (frames: readonly ServerFrame[]): string[] => frames.map((f) => f.method);

describe('a history compacted at the start of each turn', () => {
  it('is the base and the turn so far, and a page that joins on it holds what the whole history gives it, at every frame', () => {
    const history = createStateHistory();
    const turns: string[][] = [];
    for (const [i, frame] of GAME_FRAMES.entries()) {
      const before = history.length;
      history.push(frame);
      if (history.length <= before) turns.push(methods(history.frames()));
      const whole = GAME_FRAMES.slice(0, i + 1);
      expect(JSON.stringify([...history.board]), `board, frame ${i}`).toBe(JSON.stringify([...foldFrames(whole as unknown as StateFrame[])]));
      expect(joined(history.frames()), `frame ${i}`).toEqual(joined(whole));
    }
    // Turn 1 (the transcript's own), 2, 3 (the reset) and 4: four bases, each with the deaths and counters so far once there are any.
    expect(turns).toEqual([['openView', 'setGameView'], ...Array(3).fill(['openView', 'setGameView', 'applyDelta'])]);
    expect(history.length).toBeLessThan(GAME_FRAMES.length);
    // Not vacuous: every fact reaches a page, and the reset takes back all but the two it names.
    expect(joined(GAME_FRAMES.slice(0, SEAT0.length + 1))).toMatchObject({
      stackTargetSpells: [[9001, 9000]],
      pendingTriggers: EVERY_FACT.pendingTriggers,
      waitingEffects: EVERY_FACT.waitingEffects,
      tokenSources: [[CARD_B, CARD_A]],
      cantBlock: [CARD_B],
      printedTypes: [[CARD_A, { type: CREATURE, token: false }]],
      printedPT: [[CARD_A, { power: 2, toughness: 2 }]],
      lifePaying: [[0, 2]],
      conditionMet: [CARD_B],
      deathCauses: [[CARD_B, 'DESTROYED']],
    });
    expect(joined(GAME_FRAMES)).toMatchObject({
      stackTargetSpells: [],
      pendingTriggers: [],
      tokenSources: [[CARD_A, CARD_B]],
      cantBlock: [CARD_A],
      printedPT: [[CARD_B, { power: 1, toughness: 1 }]],
      conditionMet: [],
      deathCauses: [
        [CARD_A, 'DEATHTOUCH'],
        [CARD_B, 'ZERO_TOUGHNESS'],
      ],
      counteredStackItems: [9001, 9002, 9003],
      view: expect.objectContaining({ players: expect.any(Array) }),
    });
    expect(MatchSnapshotSchema.safeParse({ matchId: 'm', seat: 0, playerId: 0, cursor: null, frames: history.frames() }).success).toBe(true);
  });

  it('leaves a page where the whole history does, compacted after any frame, for a fresh page and a mounted board that reconnects', () => {
    const whole = joined(GAME_FRAMES);
    for (let k = 1; k <= GAME_FRAMES.length; k += 1) {
      const history = createStateHistory();
      for (const frame of GAME_FRAMES.slice(0, k)) history.push(frame);
      history.compact();
      const atK = history.frames();
      for (const frame of GAME_FRAMES.slice(k)) history.push(frame);
      expect(joined(history.frames()), `compacted after frame ${k - 1}`).toEqual(whole);
      expect(rejoined(atK, history.frames()), `reconnected after frame ${k - 1}`).toEqual(rejoined(GAME_FRAMES.slice(0, k), GAME_FRAMES));
    }
  });

  it('keeps an empty face as one null property, the frames that are not state after its base, and nothing before a baseline', () => {
    const early = createStateHistory();
    early.push(SEAT0.find((f) => f.method === 'openView')!);
    early.compact();
    expect(methods(early.frames())).toEqual(['openView']);

    const history = createStateHistory();
    for (const frame of GAME_FRAMES.slice(0, SEAT0.length + 2)) history.push(frame);
    const ended = { kind: 'notify', method: 'finishGame', losers: [1] } as unknown as ServerFrame;
    history.push(ended);
    history.compact();
    const frames = history.frames();
    expect(methods(frames)).toEqual(['openView', 'setGameView', 'applyDelta', 'finishGame']);
    const base = frames[1] as unknown as Extract<StateFrame, { method: 'setGameView' }>;
    expect(base.payload.gameView[FACE_A]).toEqual({ _type: DELTA_TYPE.cardState, _id: CARD_A * 16, Name: null });
    expect(history.board.get(FACE_A)).toEqual({ _type: DELTA_TYPE.cardState, _id: CARD_A * 16 });
    expect(frames.at(-1)).toBe(ended);
  });
});

/* ── Through a real Match: both seats' snapshots and the watcher's ──────── */

interface Harness {
  match: Match;
  host: ReplayHost;
  sent: { seat: number; envelope: ServerEnvelope }[];
}

function harness(): Harness {
  const { factory, hosts } = replayFactory();
  const sent: Harness['sent'] = [];
  const registry = createMatchRegistry({ host: factory, log: () => undefined, overGraceMs: 60_000, emit: (_match, seat, envelope) => sent.push({ seat, envelope }) });
  const match = registry.create({
    seats: [
      { name: 'Seat 1', ai: false, deck: null },
      { name: 'Seat 2', ai: false, deck: null },
    ],
  });
  return { match, host: hosts[0] as ReplayHost, sent };
}

/** The transcript, carried on to turn 3 for both seats by hand-written deltas, and ended. */
const LINES: BridgeLine[] = [
  ...TRANSCRIPT,
  ...[turn(2), life(1, 16), turn(3), life(0, 11)].flatMap((objectDeltas) => {
    const frame = delta({ objectDeltas });
    return [0, 1].map((s) => ({ t: 'frame', seat: s, frame }) as BridgeLine);
  }),
  { t: 'gameover', winner: 'Seat 1' } as BridgeLine,
];

describe("a Match's snapshots", () => {
  it('leave every page where the whole channel would, for both seats and the watcher: the board after every line, the page at each new base and at the end', () => {
    const h = harness();
    const sorted = (frames: readonly unknown[]): string => JSON.stringify([...foldFrames(frames as StateFrame[])].sort(([a], [b]) => Number(a) - Number(b)));
    const bases = new Map<number, ServerFrame[]>();
    for (const [i, line] of LINES.entries()) {
      h.host.push(line);
      for (const seat of [0, 1, WATCHER_SEAT]) {
        const snap = seat === WATCHER_SEAT ? h.match.watcherSnapshot() : h.match.snapshot(seat);
        if (!('frames' in snap)) continue;
        const channel = h.sent.filter((s) => s.seat === seat).map((s) => s.envelope.frame);
        // The old snapshot: every state frame the channel was sent, and the watcher's ending.
        const whole = channel.filter((f) => STATE.has(f.method) || (seat === WATCHER_SEAT && f.method === 'finishGame'));
        expect(MatchSnapshotSchema.safeParse(snap).success, `seat ${seat}, line ${i}`).toBe(true);
        expect(snap.cursor?.seq).toBe(channel.length);
        expect(sorted(snap.frames), `seat ${seat}, line ${i}`).toBe(sorted(whole));
        // A new base: the history was just compacted, so its `setGameView` is one no frame of the channel is.
        const base = snap.frames[1]!;
        const based = !channel.includes(base) && !(bases.get(seat) ?? []).includes(base);
        if (based) bases.set(seat, [...(bases.get(seat) ?? []), base]);
        if (based || i === LINES.length - 1) expect(joined(snap.frames, snap.playerId), `seat ${seat}, line ${i}`).toEqual(joined(whole, snap.playerId));
      }
    }
    // Turns 1, 2 and 3 each began with a new base, on every channel.
    expect(Object.fromEntries([...bases].map(([seat, b]) => [seat, b.length]))).toEqual({ 0: 3, 1: 3, [WATCHER_SEAT]: 3 });
  });
});
