/**
 * TEST SCAFFOLDING for a product gap: the buttons the board does not have.
 *
 * ## The gap, measured by the spec before this is ever connected
 *
 * The browser's board ANSWERS asks (`LiveBoard` → the prompt components →
 * `answerAsk`), but it cannot ACT. Nothing in `apps/ui/src/play/` sends a
 * `ClientAct`: `live/match.ts` exports `answerAsk`, `answerConfirm`, `abortAsk`
 * and nothing that emits `selectButtonOk`, `selectCard` or `selectPlayer`;
 * `Board.tsx` renders no control; and `showPromptMessage` / `updateButtons` /
 * `setSelectables` reach the browser and are dropped (`live/match.ts`
 * `foldFrames` reads only `setGameView`, `applyDelta` and `openView`). Almost
 * everything a player does in Forge — play or draw, keep or mulligan, pass
 * priority, play a land, cast a spell, discard to hand size — is an `Input`
 * driven by acts, not an ask. So a match started from the product UI stops at
 * the coin toss, with each browser showing a board and nothing to press. The
 * spec records that first.
 *
 * ## What this does about it, and what it does not
 *
 * One extra socket.io connection per friend, through the SAME stand-in edge
 * with the SAME session cookie, so the server binds it to that friend's seat
 * (`Match.claim` is per participant, and permanent). It sends only acts, the
 * way `apps/ui/src/play/live/game-driver.ts` does in the JVM prompt test:
 * play first and keep; on its own turn's first main phase, a land and then any
 * spell its untapped lands cover; OK for Forge's Auto mana payment; the
 * opponent as a target; a card when Forge asks for cards (the cleanup
 * discard); OK otherwise. It NEVER answers an ask: every ask is left to the
 * browser, so every answer the spec counts was given by the board.
 *
 * It keeps out of the refresh measurement: the spec closes a seat's hands
 * before reloading that seat's page, so the reload really leaves the seat with
 * no connection, and the server's reconnect grace is what holds it.
 */

import { manaCostTokens } from '../../apps/ui/src/play/adapter.ts';
import { isSnapshot, type Frame } from './frames.ts';
import { applyFrame, keyOf, TYPE, type State, type WireObj } from './isolation.ts';
import { connectSio, type SioClient } from './sio.ts';

interface Notes {
  prompt: string;
  enable1: boolean;
  enable2: boolean;
  selectables: { cards: number[]; min: number } | null;
  version: number;
  /** An ask this seat's stream showed and has not moved past yet. */
  askOpen: boolean;
}

export interface Hands {
  seat: number;
  /** What this connection did, for the evidence file. */
  log: string[];
  acts: number;
  /** Spells it put on the stack, by name. */
  cast: string[];
  /** Stop acting (the connection stays up). */
  pause(): void;
  resume(): void;
  close(): Promise<void>;
}

const IDLE_MS = 3000;
const TICK_MS = 150;

function ids(obj: WireObj | undefined, prop: string): number[] {
  return ((obj?.[prop] as { v?: { v: number }[] } | undefined)?.v ?? []).map((x) => x.v);
}

export async function connectHands(origin: string, session: string, matchId: string): Promise<Hands> {
  const sio: SioClient = await connectSio(origin, session);
  const notes: Notes = { prompt: '', enable1: false, enable2: false, selectables: null, version: 0, askOpen: false };
  const state: State = new Map();
  const picked = new Map<string, number[]>();
  const tried = new Set<string>();
  const log: string[] = [];
  let seen = -1;
  let idleSince = Date.now();
  let paused = false;

  const onFrame = (frame: Frame): void => {
    // A seat's stream pauses behind its open ask (the bridge's per-seat
    // serial thread), so any later frame means the browser answered it.
    notes.askOpen = frame.kind === 'ask';
    if (applyFrame(state, frame)) return;
    if (frame.method === 'showPromptMessage') notes.prompt = String(frame.message ?? '');
    else if (frame.method === 'updateButtons') {
      notes.enable1 = frame.enable1 === true;
      notes.enable2 = frame.enable2 === true;
    } else if (frame.method === 'setSelectables') {
      const cards = ((frame.cards as { id: number }[] | undefined) ?? []).map((c) => c.id);
      notes.selectables = { cards, min: Number(frame.min ?? 0) };
    } else if (frame.method === 'clearSelectables') notes.selectables = null;
    else return;
    notes.version += 1;
  };
  sio.on('forge:s2c', (payload) => onFrame((payload as { frame: Frame }).frame));

  const joined = await sio.request('forge:join', { matchId });
  if (!isSnapshot(joined)) throw new Error(`hands for ${session} could not join ${matchId}: ${JSON.stringify(joined)}`);
  for (const f of joined.frames) applyFrame(state, f);
  const seat = joined.seat;
  const me = joined.playerId;
  const myName = `Seat ${seat + 1}`;

  const face = (id: number): WireObj | undefined => state.get(keyOf(TYPE.cardState, id * 16));
  const nameOf = (id: number): string => String((face(id)?.Name as { v?: unknown } | undefined)?.v ?? `#${id}`);
  const isLand = (id: number): boolean => ((face(id)?.Type as { core?: string[] } | undefined)?.core ?? []).includes('Land');
  const manaValue = (id: number): number => {
    const cost = face(id)?.ManaCost as { v?: unknown } | undefined;
    return typeof cost?.v === 'string' ? manaCostTokens(cost.v).manaValue : Number.POSITIVE_INFINITY;
  };

  const act = (why: string, frame: Record<string, unknown>): void => {
    log.push(`${new Date().toISOString()} seat ${seat}: ${why} [${notes.prompt.replace(/\s+/g, ' ').slice(0, 100)}]`);
    hands.acts += 1;
    sio.emit('forge:c2s', { matchId, frame: { kind: 'act', ...frame } });
  };
  const ok = (why: string): void => act(why, { method: 'selectButtonOk' });
  const cancel = (why: string): void => act(why, { method: 'selectButtonCancel' });
  const selectCard = (why: string, id: number): void =>
    act(why, { method: 'selectCard', card: { kind: 'card', id }, otherCardViewsToSelect: [], triggerEvent: null });

  /** On my own turn's first main phase with an empty stack: a land, then a spell. */
  function mainPhase(turn: string): boolean {
    const player = state.get(keyOf(TYPE.player, me));
    const hand = ids(player, 'Hand');
    const land = hand.find(isLand);
    if (land !== undefined && !tried.has(`${turn}:land`)) {
      tried.add(`${turn}:land`);
      selectCard(`play land ${nameOf(land)}`, land);
      return true;
    }
    const untapped = ids(player, 'Battlefield').filter(
      (id) => isLand(id) && (state.get(keyOf(TYPE.card, id))?.Tapped as { v?: unknown } | undefined)?.v !== true,
    ).length;
    const spell = hand.find((id) => !isLand(id) && manaValue(id) <= untapped && !tried.has(`${turn}:${id}`));
    if (spell !== undefined) {
      tried.add(`${turn}:${spell}`);
      hands.cast.push(nameOf(spell));
      selectCard(`cast ${nameOf(spell)} (mana value ${manaValue(spell)}, ${untapped} untapped)`, spell);
      return true;
    }
    return false;
  }

  function decide(): void {
    const msg = notes.prompt;
    const turn = /Turn: (\d+)/.exec(msg)?.[1] ?? '?';
    if (msg.startsWith(`Priority: ${myName}`)) {
      if (msg.includes(`(${myName})`) && msg.includes('Main phase, precombat') && msg.includes('Stack: Empty') && mainPhase(turn)) return;
      if (notes.enable1) ok('pass');
      return;
    }
    if (/Pay Mana Cost/i.test(msg)) {
      if (notes.enable1) ok('Auto-pay');
      else if (notes.enable2) cancel('cannot pay: cancel');
      return;
    }
    if (/target/i.test(msg)) {
      const opponent = [...state.values()].find((o) => o._type === TYPE.player && o._id !== me);
      if (opponent !== undefined && !tried.has(`${turn}:target:${msg}`)) {
        tried.add(`${turn}:target:${msg}`);
        act(`target player ${opponent._id}`, { method: 'selectPlayer', player: { kind: 'player', id: opponent._id }, triggerEvent: null });
        return;
      }
      if (notes.enable1) ok('targets done');
      else if (notes.enable2) cancel('no target: cancel');
      return;
    }
    const sel = notes.selectables;
    if (sel !== null && sel.min > 0 && sel.cards.length > 0) {
      const done = picked.get(msg) ?? [];
      const next = sel.cards.find((id) => !done.includes(id));
      if (done.length < sel.min && next !== undefined) {
        picked.set(msg, [...done, next]);
        selectCard(`choose ${nameOf(next)}`, next);
        return;
      }
    }
    if (notes.enable1) ok('OK');
  }

  const timer = setInterval(() => {
    if (paused || sio.closed || notes.askOpen) return;
    if (/^Waiting/.test(notes.prompt)) return;
    if (notes.version === seen) {
      // Nothing new since the last act: it changed nothing (a spell it cannot
      // actually pay for, a target it cannot choose). Move on rather than wait.
      if (Date.now() - idleSince > IDLE_MS) {
        idleSince = Date.now();
        if (notes.enable1) ok('idle → OK');
        else if (notes.enable2) cancel('idle → Cancel');
      }
      return;
    }
    seen = notes.version;
    idleSince = Date.now();
    decide();
  }, TICK_MS);

  const hands: Hands = {
    seat,
    log,
    acts: 0,
    cast: [],
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      seen = -1;
    },
    close: async () => {
      clearInterval(timer);
      await sio.close();
    },
  };
  return hands;
}
