/**
 * The isolation check for a match, over what each browser actually received.
 *
 * The server's leak control (`apps/server/src/play/match.jvm.test.ts`, oracle in
 * `apps/server/src/play/fixtures/transcript.ts`) builds its secrets from
 * Forge's RAW stream, which only the server has. A browser does not. So this
 * builds them from the OTHER browser: each seat legitimately sees its own hand,
 * whole, in its own stream — and that is exactly the thing the other seat must
 * never be sent. Nothing here reads `visibility.ts`; the definition is zones.
 *
 * Pure: logs in, verdict out, so the spec runs it on the live capture and on
 * committed fixtures with the other seat's hand spliced in, where it must FAIL.
 *
 * ## The rules
 *
 * 1. **Structural, at every step.** Fold each browser's stream the way its
 *    client does (a snapshot starts over; a frame applies only at the next
 *    cursor; frames that arrive while a snapshot is in flight are held and
 *    replayed after it). After every step, each card in an OPPONENT's `Hand`
 *    or `Sideboard` list must carry no name — no `Name` / `OracleName`, and no face
 *    (`CardStateView`) with a name.
 * 2. **Raw tokens, in every message.** Every string that identifies a card
 *    which sat in the other seat's hand or sideboard (read from THAT seat's
 *    stream) and that this seat never legitimately saw — not on the stack or
 *    any battlefield, graveyard, exile or command zone, not in its own hand or
 *    sideboard, not revealed to it — must not occur,
 *    JSON-quoted, anywhere in the raw text of any `forge:s2c` event or join /
 *    resync ACK this browser received. A string this seat can see on any card
 *    it did see is not a secret (two decks can both run a Mountain).
 * 3. **Whose seat.** Every snapshot names this browser's seat and one player.
 *
 * **Reveals are not leaks.** Forge lets a player look at a card in another's
 * hand when a card says to reveal it (Stoneforge Mystic's search, for one):
 * the card carries `PlayerMayLook` naming the viewer, and Forge's own
 * `canBeShownTo` shows it (`forge-game/.../card/CardView.java:603`, `mayPlayerLook`, used at `:671`). A card
 * whose object, in the viewer's own stream, names the viewer in `PlayerMayLook`
 * is therefore exempt from rule 1 at that step, and counts as legitimately seen
 * for rule 2. The same property marks a player's OWN library cards while they
 * search or scry it (Stoneforge Mystic, Preordain), and those names are
 * legitimately theirs to see too. Before the exemption existed, runs to turn 5
 * failed three times out of three on exactly these: bob shown alice's Sylvok
 * Lifestaff, searched up and revealed (`PlayerMayLook: [1]`, a `tempShowZones`
 * "Looking at cards in Seat 1's hand", wiped one frame later); the same for a
 * Sword of Feast and Famine; and a "Day of Judgment" string that matched bob's
 * hidden card 112 while alice's stream carried it — only rule 2 fired, and
 * that run's alice had cast Preordain, whose scry names two of her own library
 * cards; both decks run four Day of Judgment. That last one is inferred: its
 * capture was overwritten before it was read.
 *
 * A card on the stack is public too (`CardView.java:630-637`) and sits in no
 * player's zone list, so it also counts as seen.
 *
 * The counts are returned so the spec can refuse a check that looked at
 * nothing.
 */

import { isSnapshot, type Cursor, type Frame, type PlayMessage, type ServerEnvelope } from './frames.ts';

/**
 * The zones only their owner may look into. The hand, and the sideboard —
 * Forge shows a player their own sideboard and nobody else's. The first live
 * run of this check flagged "Sword of Body and Mind" in alice's stream as bob's
 * hand card: it was alice's OWN sideboard copy (card 75), correctly named to
 * her. That was this oracle's false positive, not a leak, and is why the
 * sideboard is here.
 */
const PRIVATE_ZONES = ['Hand', 'Sideboard'];

export const TYPE = { card: 0, player: 1, stackItem: 2, game: 3, cardState: 4 } as const;

export interface WireObj {
  _type: number;
  _id: number;
  [property: string]: unknown;
}

export type State = Map<string, WireObj>;

export interface PlaySeatLog {
  name: string;
  seat: number;
  messages: readonly PlayMessage[];
}

export interface PlayIsolationReport {
  ok: boolean;
  violations: string[];
  counts: {
    /** Inbound s2c events + acks examined, all browsers. */
    messages: number;
    snapshots: number;
    /** Folded states checked by rule 1. */
    states: number;
    /** Opponent hand + sideboard card slots checked by rule 1, summed over states. */
    opponentHandCards: number;
    /** Of those slots, ones exempt because Forge revealed the card to the viewer. */
    revealed: number;
    /** Distinct cards that sat in some seat's hand or sideboard. */
    handCards: number;
    /** Secret strings, summed over viewers (rule 2). */
    secrets: number;
    /** message × secret probes (rule 2). */
    probes: number;
  };
}

type Table = Record<string, WireObj>;

function put(state: State, table: Table | undefined, replace: boolean): void {
  for (const [k, o] of Object.entries(table ?? {})) {
    const existing = state.get(k);
    if (!replace && existing === undefined) continue; // a delta for an object never created
    const base: WireObj = replace || existing === undefined ? { _type: o._type, _id: o._id } : { ...existing };
    for (const [p, v] of Object.entries(o)) {
      if (p === '_type' || p === '_id') continue;
      if (v === null) delete base[p];
      else base[p] = v;
    }
    state.set(k, base);
  }
}

/** Fold one frame onto `state`. True when it was a state frame. */
export function applyFrame(state: State, frame: Frame): boolean {
  if (frame.method === 'setGameView') {
    state.clear();
    put(state, frame.payload?.gameView as Table, true);
    return true;
  }
  if (frame.method === 'applyDelta') {
    const packet = frame.payload?.packet as { newObjects?: Table; objectDeltas?: Table } | undefined;
    put(state, packet?.newObjects, true);
    put(state, packet?.objectDeltas, false);
    return true;
  }
  return false;
}

export interface SeatStream {
  /** The state after every step that changed it, in order. */
  states: State[];
  playerIds: Set<number>;
  seats: Set<number>;
  snapshots: number;
  /** The last cursor applied, and the state then. */
  cursor: Cursor | null;
  final: State;
}

/** Replay a browser's inbound stream the way `apps/ui/src/play/live/match.ts` does. */
export function foldStream(messages: readonly PlayMessage[]): SeatStream {
  let state: State = new Map();
  let cursor: Cursor | null = null;
  let awaiting = false;
  let held: ServerEnvelope[] = [];
  const out: SeatStream = { states: [], playerIds: new Set(), seats: new Set(), snapshots: 0, cursor: null, final: state };

  const ingest = (env: ServerEnvelope): void => {
    if (awaiting) {
      held.push(env);
      return;
    }
    const c = env.cursor;
    if (cursor !== null && c.epoch === cursor.epoch && c.seq <= cursor.seq) return; // duplicate
    if (cursor !== null && (c.epoch !== cursor.epoch || c.seq !== cursor.seq + 1)) return; // gap / epoch: the client resyncs
    cursor = c;
    if (applyFrame(state, env.frame)) out.states.push(new Map(state));
  };

  for (const m of messages) {
    if (m.dir === 'out') {
      if (m.kind === 'join' || m.kind === 'resync') awaiting = true;
      continue;
    }
    if (m.kind === 'ack' && isSnapshot(m.msg)) {
      awaiting = false;
      out.snapshots += 1;
      out.playerIds.add(m.msg.playerId);
      out.seats.add(m.msg.seat);
      state = new Map();
      for (const f of m.msg.frames) applyFrame(state, f);
      cursor = m.msg.cursor;
      out.states.push(new Map(state));
      const replay = held;
      held = [];
      for (const env of replay) ingest(env);
    } else if (m.kind === 'ack') {
      awaiting = false;
      held = [];
    } else if (m.kind === 's2c') {
      ingest(m.msg as ServerEnvelope);
    }
  }
  out.cursor = cursor;
  out.final = state;
  return out;
}

function idList(obj: WireObj | undefined, prop: string): number[] {
  const v = obj?.[prop] as { v?: { v: number }[] } | undefined;
  return Array.isArray(v?.v) ? v.v.map((x) => x.v) : [];
}

function players(state: State): WireObj[] {
  return [...state.values()].filter((o) => o._type === TYPE.player);
}

/** Forge's object key: the type in the top four bits (`visibility.ts` `keyOf`). */
export function keyOf(type: number, id: number): string {
  return String(((type << 28) | (id & 0x0fffffff)) >>> 0);
}

function card(state: State, id: number): WireObj | undefined {
  return state.get(keyOf(TYPE.card, id));
}

/** Does `card`'s `PlayerMayLook` name `viewer`? Forge's reveal. */
function mayLook(obj: WireObj | undefined, viewer: number | undefined): boolean {
  const v = obj?.PlayerMayLook as { v?: { v?: unknown }[] } | undefined;
  return viewer !== undefined && Array.isArray(v?.v) && v.v.some((x) => x.v === viewer);
}

function strOf(obj: WireObj | undefined, prop: string): string | null {
  const v = obj?.[prop] as { t?: string; v?: unknown } | undefined;
  return v?.t === 'str' && typeof v.v === 'string' && v.v !== '' ? v.v : null;
}

/** A card's faces: `CardStateView` ids `id * 16 + ordinal`, ordinals 0–15. */
function faces(state: State, id: number): WireObj[] {
  const out: WireObj[] = [];
  for (let ordinal = 0; ordinal < 16; ordinal++) {
    const f = state.get(keyOf(TYPE.cardState, id * 16 + ordinal));
    if (f !== undefined) out.push(f);
  }
  return out;
}

/** Every string that says WHICH card this is — the oracle's `identifyingStrings`. */
export function identifyingStrings(state: State, id: number): string[] {
  const out: string[] = [];
  const c = card(state, id);
  for (const p of ['Name', 'OracleName']) {
    const s = strOf(c, p);
    if (s !== null && s.length >= 4) out.push(s);
  }
  for (const f of faces(state, id)) {
    for (const [p, v] of Object.entries(f)) {
      const t = v as { t?: string; v?: unknown } | null;
      if (p !== '_type' && p !== '_id' && t?.t === 'str' && typeof t.v === 'string' && t.v.length >= 4) out.push(t.v);
    }
  }
  return out;
}

/** Every string anywhere on a card's objects — the oracle's `everyString`. */
export function everyString(state: State, id: number): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (typeof node === 'object' && node !== null) {
      for (const [k, v] of Object.entries(node)) if (k !== 't' && k !== 'c') walk(v);
    }
  };
  walk(card(state, id));
  for (const f of faces(state, id)) walk(f);
  return out;
}

/** The first name a card carries in `state`, for a violation message. */
function nameIn(state: State, id: number): string | null {
  const c = card(state, id);
  const direct = strOf(c, 'Name') ?? strOf(c, 'OracleName');
  if (direct !== null) return direct;
  for (const f of faces(state, id)) {
    const n = strOf(f, 'Name');
    if (n !== null) return n;
  }
  return null;
}

export function checkPlayIsolation(logs: readonly PlaySeatLog[]): PlayIsolationReport {
  const violations: string[] = [];
  const counts = { messages: 0, snapshots: 0, states: 0, opponentHandCards: 0, revealed: 0, handCards: 0, secrets: 0, probes: 0 };

  const streams = new Map<string, SeatStream>();
  const me = new Map<string, number>();

  for (const log of logs) {
    const stream = foldStream(log.messages);
    streams.set(log.name, stream);
    const inbound = log.messages.filter((m) => m.dir === 'in' && (m.kind === 's2c' || m.kind === 'ack'));
    counts.messages += inbound.length;
    counts.snapshots += stream.snapshots;
    if (stream.snapshots === 0) violations.push(`${log.name}: received no match snapshot at all`);

    // Rule 3.
    for (const s of stream.seats) if (s !== log.seat) violations.push(`${log.name}: a snapshot seated it at ${s}, expected ${log.seat}`);
    if (stream.playerIds.size > 1) violations.push(`${log.name}: snapshots named players ${[...stream.playerIds].join(',')}`);
    const playerId = [...stream.playerIds][0];
    if (playerId !== undefined) me.set(log.name, playerId);

    // Rule 1.
    stream.states.forEach((state, i) => {
      counts.states += 1;
      for (const p of players(state)) {
        if (p._id === playerId) continue;
        for (const zone of PRIVATE_ZONES) {
          for (const id of idList(p, zone)) {
            if (mayLook(card(state, id), playerId)) {
              counts.revealed += 1;
              continue;
            }
            counts.opponentHandCards += 1;
            const name = nameIn(state, id);
            if (name !== null) {
              violations.push(`${log.name} state #${i}: opponent ${p._id}'s ${zone.toLowerCase()} card ${id} is named "${name}"`);
            }
          }
        }
      }
    });
  }

  // Rule 2: X's hand, as X saw it, against everything Y received.
  const handCards = new Set<number>();
  for (const x of logs) {
    const xs = streams.get(x.name);
    const xId = me.get(x.name);
    if (xs === undefined || xId === undefined) continue;
    const handStrings = new Map<number, Set<string>>();
    for (const state of xs.states) {
      const mine = players(state).find((p) => p._id === xId);
      for (const id of PRIVATE_ZONES.flatMap((z) => idList(mine, z))) {
        handCards.add(id);
        const set = handStrings.get(id) ?? new Set<string>();
        for (const s of identifyingStrings(state, id)) set.add(s);
        handStrings.set(id, set);
      }
    }

    for (const y of logs) {
      if (y === x) continue;
      const ys = streams.get(y.name);
      const yId = me.get(y.name);
      if (ys === undefined || yId === undefined) continue;
      const shown = new Set<number>();
      const allowed = new Set<string>();
      for (const state of ys.states) {
        for (const o of state.values()) {
          // Revealed to this viewer, or on the stack — public in Forge
          // (`CardView.java:630-637`), and no player's zone list names it.
          const zone = (o.Zone as { v?: unknown } | undefined)?.v;
          if (o._type === TYPE.card && (mayLook(o, yId) || zone === 'Stack')) {
            shown.add(o._id);
            for (const s of everyString(state, o._id)) allowed.add(s);
          }
        }
        for (const p of players(state)) {
          const zones = ['Battlefield', 'Graveyard', 'Exile', 'Command', ...(p._id === yId ? PRIVATE_ZONES : [])];
          for (const z of zones) {
            for (const id of idList(p, z)) {
              shown.add(id);
              for (const s of everyString(state, id)) allowed.add(s);
            }
          }
        }
      }
      const secrets = new Map<string, number>();
      for (const [id, strings] of handStrings) {
        if (shown.has(id)) continue;
        for (const s of strings) if (!allowed.has(s)) secrets.set(s, id);
      }
      counts.secrets += secrets.size;
      const inbound = y.messages.filter((m) => m.dir === 'in' && (m.kind === 's2c' || m.kind === 'ack'));
      inbound.forEach((m, i) => {
        for (const [s, id] of secrets) {
          counts.probes += 1;
          if (m.raw.includes(JSON.stringify(s))) {
            violations.push(`${y.name} message #${i} (${m.kind}) carries "${s}" — card ${id} from ${x.name}'s hand or sideboard`);
          }
        }
      });
    }
  }
  counts.handCards = handCards.size;

  return { ok: violations.length === 0, violations, counts };
}
