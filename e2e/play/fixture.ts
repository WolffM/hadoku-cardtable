/**
 * The committed capture the play isolation check is shown to bite on.
 *
 * `fixtures/two-seat-play.json` is cut from a real run of `../play.spec.ts`
 * against a real Forge by `make-fixture.ts`: for each browser, every message up
 * to and including its first match snapshot and the next `S2C_AFTER` frames,
 * unedited. It needs no Forge to use, so the check runs in CI.
 *
 * `mutations` re-serialises one captured message the way socket.io would, with
 * something the other seat must never be sent, and each must make the check
 * FAIL — for the reason named in `expect`.
 */

import { resolve } from 'node:path';

import { isSnapshot, type Frame, type PlayMessage, type ServerEnvelope } from './frames.ts';
import { foldStream, keyOf, TYPE, type PlaySeatLog, type State, type WireObj } from './isolation.ts';

export const FIXTURE_FILE = resolve(import.meta.dirname, 'fixtures', 'two-seat-play.json');

/** What is stored: the raw text only; `msg` is re-parsed from it on load. */
export interface StoredMessage {
  t: number;
  dir: PlayMessage['dir'];
  via: PlayMessage['via'];
  kind: PlayMessage['kind'];
  event: string;
  raw: string;
}

export interface PlayFixture {
  source: string;
  logs: PlaySeatLog[];
}

export function store(m: PlayMessage): StoredMessage {
  return { t: m.t, dir: m.dir, via: m.via, kind: m.kind, event: m.event, raw: m.raw };
}

export function load(stored: { source: string; logs: { name: string; seat: number; messages: StoredMessage[] }[] }): PlayFixture {
  return {
    source: stored.source,
    logs: stored.logs.map((l) => ({
      name: l.name,
      seat: l.seat,
      messages: l.messages.map((m) => {
        const arr = JSON.parse(m.raw) as unknown[];
        return { ...m, msg: m.kind === 'ack' ? arr[0] : arr[1] };
      }),
    })),
  };
}

function reserialise(m: PlayMessage, msg: unknown): PlayMessage {
  const raw = m.kind === 'ack' ? JSON.stringify([msg]) : JSON.stringify([m.event, msg]);
  return { ...m, msg, raw };
}

function playerIdOf(log: PlaySeatLog): number {
  const snap = log.messages.find((m) => m.kind === 'ack' && isSnapshot(m.msg));
  if (snap === undefined || !isSnapshot(snap.msg)) throw new Error(`${log.name}: the fixture has no snapshot`);
  return snap.msg.playerId;
}

/** `log`'s last `applyDelta`: by then both opening hands have been dealt. */
function lastDelta(log: PlaySeatLog): number {
  const i = log.messages.findLastIndex(
    (m) => m.dir === 'in' && m.kind === 's2c' && (m.msg as ServerEnvelope).frame.method === 'applyDelta',
  );
  if (i < 0) throw new Error(`${log.name}: the fixture has no applyDelta`);
  return i;
}

function handOf(state: State, playerId: number): number[] {
  return ((state.get(keyOf(TYPE.player, playerId))?.Hand as { v?: { v: number }[] } | undefined)?.v ?? []).map((x) => x.v);
}

/**
 * A card in `owner`'s hand, as `owner` holds it (the card and its faces), that
 * `viewer`'s state after message `at` also places in `owner`'s hand — so the
 * splice lands on a card the viewer knows is in that hand, as a leak would —
 * and whose name the viewer's capture never carries. Two draw-go decks share
 * most of their names, and a name the viewer holds on a card of its own is
 * rightly not a secret, so it would prove nothing.
 */
function ownHandCard(owner: PlaySeatLog, viewer: PlaySeatLog, at: number): { id: number; name: string; objects: Record<string, WireObj> } {
  const mine: State = foldStream(owner.messages).final;
  const theirs: State = foldStream(viewer.messages.slice(0, at + 1)).final;
  const ownerId = playerIdOf(owner);
  const seenInHand = new Set(handOf(theirs, ownerId));
  const viewerText = viewer.messages.map((m) => m.raw).join('\n');
  for (const id of handOf(mine, ownerId)) {
    const card = mine.get(keyOf(TYPE.card, id));
    const name = (card?.Name as { v?: unknown } | undefined)?.v;
    if (card === undefined || !seenInHand.has(id) || typeof name !== 'string' || name.length < 4) continue;
    if (viewerText.includes(JSON.stringify(name))) continue;
    const objects: Record<string, WireObj> = { [keyOf(TYPE.card, id)]: card };
    for (let o = 0; o < 16; o++) {
      const k = keyOf(TYPE.cardState, id * 16 + o);
      const face = mine.get(k);
      if (face !== undefined) objects[k] = face;
    }
    return { id, name, objects };
  }
  throw new Error(`${owner.name}: no named hand card that ${viewer.name} places in that hand and has never seen named`);
}

function replaceAt(log: PlaySeatLog, i: number, m: PlayMessage): PlaySeatLog {
  const messages = [...log.messages];
  messages[i] = m;
  return { ...log, messages };
}

export interface Mutation {
  name: string;
  logs: PlaySeatLog[];
  expect: RegExp;
}

export function mutations(fixture: PlayFixture): Mutation[] {
  const [alice, bob] = fixture.logs;
  const at = lastDelta(alice);
  const bobCard = ownHandCard(bob, alice, at);
  const out: Mutation[] = [];

  // 1. Bob's hand card, whole, re-sent to alice in a real delta of hers.
  {
    const i = at;
    const env = structuredClone(alice.messages[i].msg) as ServerEnvelope;
    const packet = (env.frame.payload as { packet: { newObjects: Record<string, WireObj> } }).packet;
    Object.assign(packet.newObjects, bobCard.objects);
    out.push({
      name: `bob's hand card ${bobCard.id} ("${bobCard.name}"), face and all, spliced into alice's delta`,
      logs: [replaceAt(alice, i, reserialise(alice.messages[i], env)), bob],
      expect: new RegExp(`hand card ${bobCard.id} is named|"${bobCard.name}"`),
    });
  }

  // 2. Only the bare name, in a field nobody reads.
  {
    const i = at;
    const env = structuredClone(alice.messages[i].msg) as ServerEnvelope & { debug?: string };
    env.debug = bobCard.name;
    out.push({
      name: `the bare name "${bobCard.name}" in an unread field of alice's delta`,
      logs: [replaceAt(alice, i, reserialise(alice.messages[i], env)), bob],
      expect: new RegExp(`carries "${bobCard.name}"`),
    });
  }

  // 3. Bob's hand card's name written onto the redacted card alice already holds for it.
  {
    const i = at;
    const env = structuredClone(alice.messages[i].msg) as ServerEnvelope;
    const packet = (env.frame.payload as { packet: { objectDeltas: Record<string, Partial<WireObj>> } }).packet;
    packet.objectDeltas[keyOf(TYPE.card, bobCard.id)] = {
      _type: TYPE.card,
      _id: bobCard.id,
      Name: { t: 'str', v: bobCard.name },
    };
    out.push({
      name: `a delta naming bob's hand card ${bobCard.id} on alice's side`,
      logs: [replaceAt(alice, i, reserialise(alice.messages[i], env)), bob],
      expect: new RegExp(`hand card ${bobCard.id} is named`),
    });
  }

  // 4. Alice's snapshot, addressed to seat 1.
  {
    const i = alice.messages.findIndex((m) => m.kind === 'ack' && isSnapshot(m.msg));
    const snap = structuredClone(alice.messages[i].msg) as { seat: number; frames: Frame[] };
    snap.seat = 1;
    out.push({
      name: "alice's snapshot seating her at 1",
      logs: [replaceAt(alice, i, reserialise(alice.messages[i], snap)), bob],
      expect: /a snapshot seated it at 1, expected 0/,
    });
  }

  // 5. Alice received nothing.
  out.push({
    name: "alice's log empty",
    logs: [{ ...alice, messages: [] }, bob],
    expect: /alice: received no match snapshot/,
  });

  return out;
}

export interface UnseenCase {
  name: string;
  /** Alice's log, as the case leaves it. */
  alice: PlaySeatLog;
  /** The names asked about. */
  names: string[];
  /** The violation it must report, or null for a case that must pass. */
  expect: RegExp | null;
}

function libraryOf(state: State, playerId: number): number[] {
  return ((state.get(keyOf(TYPE.player, playerId))?.Library as { v?: { v: number }[] } | undefined)?.v ?? []).map((x) => x.v);
}

/**
 * The cases `unseenNamed` must tell apart, on alice's real stream: a card of bob's named where alice
 * may not look — in his hand, in his library — is a leak; the same name on a card in alice's own
 * hand is not. That last is what a scenario match's opening precon hand looks like: dealt to alice,
 * hers to read, before the scenario replaces it — and a check by text alone calls it bob's card.
 */
export function unseenCases(fixture: PlayFixture): UnseenCase[] {
  const [alice, bob] = fixture.logs;
  const at = lastDelta(alice);
  const bobCard = ownHandCard(bob, alice, at);
  const aliceId = playerIdOf(alice);
  const bobId = playerIdOf(bob);
  const theirs: State = foldStream(alice.messages.slice(0, at + 1)).final;
  const named = (id: number, name: string): Partial<WireObj> => ({ _type: TYPE.card, _id: id, Name: { t: 'str', v: name } });
  const withDelta = (objectDeltas: Record<string, Partial<WireObj>>): PlaySeatLog => {
    const env = structuredClone(alice.messages[at].msg) as ServerEnvelope;
    const packet = (env.frame.payload as { packet: { objectDeltas: Record<string, Partial<WireObj>> } }).packet;
    Object.assign(packet.objectDeltas, objectDeltas);
    return replaceAt(alice, at, reserialise(alice.messages[at], env));
  };
  const ownCard = handOf(theirs, aliceId)[0];
  const bobLibraryCard = libraryOf(theirs, bobId)[0];
  if (ownCard === undefined || bobLibraryCard === undefined) throw new Error('the fixture has no hand card of alice’s or no library card of bob’s — regenerate it');
  return [
    { name: 'the real capture', alice, names: [bobCard.name], expect: null },
    {
      name: `alice's own hand card ${ownCard} named "${bobCard.name}", the name of a card in bob's hand`,
      alice: withDelta({ [keyOf(TYPE.card, ownCard)]: named(ownCard, bobCard.name) }),
      names: [bobCard.name],
      expect: null,
    },
    {
      name: `bob's hand card ${bobCard.id} named on alice's side`,
      alice: withDelta({ [keyOf(TYPE.card, bobCard.id)]: named(bobCard.id, bobCard.name) }),
      names: [bobCard.name],
      expect: new RegExp(`player ${bobId}'s hand card ${bobCard.id} is named "${bobCard.name}"`),
    },
    {
      name: `bob's library card ${bobLibraryCard} named "${bobCard.name}" on alice's side`,
      alice: withDelta({ [keyOf(TYPE.card, bobLibraryCard)]: named(bobLibraryCard, bobCard.name) }),
      names: [bobCard.name],
      expect: new RegExp(`player ${bobId}'s library card ${bobLibraryCard} is named "${bobCard.name}"`),
    },
  ];
}
