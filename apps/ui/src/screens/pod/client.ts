/*
 * The pod's own HTTP calls — wave 72 §R.
 *
 * The pod's screens read the room's record (`GET /api/rooms/:id`, `RoomView`):
 * `podContextOf` is everything they draw from it. Inside the room screen the pod
 * takes that screen's own reads (`relayedPodSource`); on a screen of its own
 * (`DeckScreen`) it follows the room itself (`livePodSource`).
 *
 * The sit/stand/rounds calls are raw fetches — no client exists for them.
 * Starting a pod table's game is NOT: `tables.ts`'s
 * `TablesClient` already has `ready`/`startRoom`, both already taking an
 * optional `tableId`, and a pod table is gated through the exact same two
 * calls a constructed table's is (confirmed against the real server — see
 * `startTableMatch`'s own header), so this imports and uses those instead
 * of a second, hand-rolled copy of them.
 */

import { useEffect, useRef, useState } from 'react';
import type { Look, RoomTable, SeriesPhase, TableGame } from '@hadoku/shared';

import { followTableOnce } from '../../play/live/matchStart.ts';
import { roomFeed } from '../../rooms/follow.ts';
import { latestReads } from '../../rooms/latest.ts';
import { roomsClient, type RoomsClient, type RoomView } from '../../rooms/api.ts';
import { apiUrl, bodyOf, isRecord, sendJson } from '../../http.ts';
import { tablesClient } from '../tables.ts';
import { useQueuePlace } from '../queue-place.ts';
import type { PodView } from './wire.ts';
import { faceOf, type Face } from '../../components/Avatar.tsx';

/**
 * Every entrant's display name and avatar, by entrant id: the room's members, and each AI entrant's own
 * character (`PodView.personas`). The one lookup every pod and tournament screen draws a player with.
 */
export function entrantLookup(pod: PodView | null, members: readonly { id: string; name: string; avatarId?: unknown; look?: Look }[]): Pick<PodContext, 'names' | 'avatars'> {
  const personas = Object.entries(pod?.personas ?? {});
  return {
    names: { ...Object.fromEntries(personas.map(([id, p]) => [id, p.name])), ...Object.fromEntries(members.map((m) => [m.id, m.name])) },
    avatars: {
      ...Object.fromEntries(personas.map(([id, p]): [string, Face] => [id, { id: p.avatarId }])),
      ...Object.fromEntries(
        members.flatMap((m): [string, Face][] => {
          const face = faceOf(m);
          return face.id === null && face.look === undefined ? [] : [[m.id, face]];
        }),
      ),
    },
  };
}

export interface PodContext {
  pod: PodView | null;
  /** This round's tables — `@hadoku/shared`'s own schema, safe to import (landed wave 71). */
  tables: RoomTable[];
  /** Each table's game (the room body's `tableGames`), for its card. */
  games: Record<string, TableGame>;
  /** Every entrant's display name, by id (`entrantLookup`) — for resolving `pod.built`/`pod.bye`/`pod.standings[].id`. */
  names: Record<string, string>;
  /** The room's members, in the room's order. */
  members: { id: string; name: string }[];
  /** The room owner's member id (`RoomView.leader`); `''` while unknown. */
  leaderId: string;
  /** Every entrant's face, by id: a member's avatar and look, each AI entrant's own character (`entrantLookup`). Absent for an id that is neither. */
  avatars: Record<string, Face>;
  /**
   * My member id in this room, from the server's own `you` — what the tables
   * and the pod name me by. Not whoami's id: for an admin session the two
   * differ, and "my table" was never found (2026-10-19, r-25e3eb4baa00).
   */
  me: string | null;
  /** The room's own name, what the pod's header calls it. `''` while unknown. */
  name: string;
  /** I own the room: mine is its Close. */
  leader: boolean;
  /** The server no longer has the room — closed by its owner, or never mine to see. */
  gone: boolean;
}

/**
 * Everything the pod's screens need for `building`/`rounds`/`done`, from one
 * read of the room's record: `pod`, `tables`, and every entrant's name and
 * face (`entrantLookup`), since neither `PodView` nor `RoomTable.players` names
 * everyone (a built-but-unpaired drafter, a bye) the way the room's own member
 * list does.
 */
export function podContextOf(room: RoomView): PodContext {
  return {
    pod: room.pod,
    tables: room.tables,
    games: room.tableGames ?? {},
    ...entrantLookup(room.pod, room.members),
    members: room.members.map((m) => ({ id: m.id, name: m.name })),
    leaderId: room.leader,
    name: room.name,
    me: room.you.id === '' ? null : room.you.id,
    leader: room.you.leader,
    gone: false,
  };
}

const NO_CONTEXT: PodContext = { pod: null, tables: [], games: {}, names: {}, members: [], leaderId: '', avatars: {}, me: null, name: '', leader: false, gone: false };

/** One read of the room (`podContextOf`): `gone` on the server's 404, and an empty context on any other failure. */
export async function fetchPodContext(roomId: string, rooms: Pick<RoomsClient, 'get'> = roomsClient()): Promise<PodContext> {
  let room: RoomView | null;
  try {
    room = await rooms.get(roomId);
  } catch (err) {
    console.warn('[pod] could not read the room', roomId, err);
    return NO_CONTEXT;
  }
  return room === null ? { ...NO_CONTEXT, gone: true } : podContextOf(room);
}

/** Where a screen's `PodContext` comes from. Tests pass a stub; production gets `livePodSource`. */
export interface PodSource {
  /** Calls `onRead` with a fresh read every time the room changes (and once at the start). Returns the stop. */
  follow(roomId: string, onRead: (ctx: PodContext) => void): () => void;
}

/**
 * The pod on a screen of its own: the room feed's pings, each answered with one `fetchPodContext`; an
 * answer a newer read overtook is dropped (`../../rooms/latest.ts`).
 */
export const livePodSource: PodSource = {
  follow: (roomId, onRead) => {
    const reads = latestReads();
    return roomFeed().follow({ room: roomId }, () => {
      const landed = reads.read();
      void fetchPodContext(roomId).then((ctx) => {
        if (landed() === 'keep') onRead(ctx);
      });
    });
  },
};

/**
 * The pod inside a screen that already follows its room (`ConstructedScreen`): it takes that
 * screen's reads of the room rather than following the room and reading it a second time on every
 * ping. `land` hands it each record the screen keeps, for this room only; the newest is a new
 * follower's first read.
 */
export function relayedPodSource(roomId: string): PodSource & { land(room: RoomView): void } {
  let last: PodContext | null = null;
  const followers = new Set<(ctx: PodContext) => void>();
  return {
    land(room) {
      if (room.id !== roomId) return;
      last = podContextOf(room);
      for (const onRead of followers) onRead(last);
    },
    follow(_roomId, onRead) {
      followers.add(onRead);
      if (last !== null) onRead(last);
      return () => {
        followers.delete(onRead);
      };
    },
  };
}

/** The room's pod context, kept current. `null` until the first read has answered. */
export function usePodContext(roomId: string, source: PodSource = livePodSource): PodContext | null {
  const [ctx, setCtx] = useState<PodContext | null>(null);
  useEffect(() => {
    let live = true;
    setCtx(null);
    const stop = source.follow(roomId, (c) => {
      if (live) setCtx(c);
    });
    return () => {
      live = false;
      stop();
    };
  }, [roomId, source]);
  return ctx;
}

export interface PodActionOutcome {
  ok: boolean;
  /** The server's own refusal, shown as-is — never guessed at here. */
  message: string | null;
}

async function postRoom(roomId: string, path: string, body: Record<string, unknown>): Promise<PodActionOutcome> {
  try {
    const res = await sendJson(apiUrl(`rooms/${encodeURIComponent(roomId)}/${path}`), 'POST', body);
    if (res.ok) return { ok: true, message: null };
    const parsed = await bodyOf(res);
    const message = isRecord(parsed) && 'error' in parsed ? String(parsed.error) : `The server refused that (${res.status}).`;
    return { ok: false, message };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function postPod(roomId: string, action: 'sit' | 'stand' | 'play' | 'ai' | 'close' | 'split', body: Record<string, unknown>): Promise<PodActionOutcome> {
  return postRoom(roomId, `pod/${action}`, body);
}

/** Claims a pod seat — the leader's choice of `seat`, or the server's own pick when omitted. */
export function sitPod(roomId: string, seat?: number): Promise<PodActionOutcome> {
  return postPod(roomId, 'sit', seat === undefined ? {} : { seat });
}

/** The AI button on an open pod seat (`on`), or taking the AI back out of it. */
export function aiPod(roomId: string, seat: number, on: boolean): Promise<PodActionOutcome> {
  return postPod(roomId, 'ai', { seat, on });
}

/** The owner closes an empty pod seat (`closed`), or opens a closed one. */
export function closePod(roomId: string, seat: number, closed: boolean): Promise<PodActionOutcome> {
  return postPod(roomId, 'close', { seat, closed });
}

/** Gives my own seat back. A no-op (refused, not thrown) once drafting has started. */
export function standPod(roomId: string): Promise<PodActionOutcome> {
  return postPod(roomId, 'stand', {});
}

/** Split & randomize: the leader splits a ready room of more than 8 into random pods (`room/lobby.ts`'s `splitPod`). */
export function splitPod(roomId: string): Promise<PodActionOutcome> {
  return postPod(roomId, 'split', {});
}

/** The leader's Start draft for a split room: the server deals each pod its draft, and the room's feed carries it to everyone. */
export function startSplitDraft(roomId: string): Promise<PodActionOutcome> {
  return postRoom(roomId, 'start', {});
}

/**
 * Done building — the deck editor's Play. Refused until my saved deck is
 * legal; the last drafter's press deals round 1 (`room/lobby.ts`'s `playPod`).
 */
export function playPod(roomId: string): Promise<PodActionOutcome> {
  return postPod(roomId, 'play', {});
}

export type StartTableMatchOutcome = { ok: true; matchId: string | null } | { ok: false; message: string };

const tableClient = tablesClient();

/**
 * Readies my own seat at a pod table that has no live match yet
 * (`RoomTable.matchId === null`, `series.phase === 'seating'`), then tries
 * to start it — `tables.ts`'s own `ready`/`startRoom`, both already taking
 * an optional table id. A pod table is gated the SAME way a constructed
 * one is — confirmed against the real server, which refused `startRoom`
 * with "e2e-alice is not ready yet" until `ready` had been called for her
 * seat. The FIRST of the table's two players to call this is refused the
 * start half (the OTHER seat not ready yet) — `matchId: null` reports
 * that as the benign, expected half of this call rather than a failure;
 * the SECOND player's call succeeds once both are readied. A refusal for
 * any OTHER reason is reported.
 */
export async function startTableMatch(roomId: string, tableId: string): Promise<StartTableMatchOutcome> {
  const readied = await tableClient.ready(roomId, true, tableId);
  if (!readied.ok) return { ok: false, message: readied.error };
  const started = await tableClient.startRoom(roomId, tableId);
  if (started.ok) return { ok: true, matchId: started.matchId };
  // The other seat has not readied yet — expected the first time either
  // player clicks, and self-corrects once they do (`PodScreen.tsx`'s own
  // table-watching effect carries both to the match once it exists).
  if (/not ready/i.test(started.error)) return { ok: true, matchId: null };
  return { ok: false, message: started.error };
}

/**
 * Whether my table, with no match on it, starts its next game by itself: a new
 * series (`seating`), a game that died (`playing`, `releaseTableMatch`), or the
 * next game of a series with no sideboarding (`between`, Gauntlet's Bo3).
 * `sideboarding` waits for both seats; `done` is over.
 */
export function nextGameStarts(phase: SeriesPhase): boolean {
  return phase === 'seating' || phase === 'playing' || phase === 'between';
}

/**
 * Starts the next game at my pod table, whoever is at it: the AI's table (one
 * player — the one drafter of a pod of bots) starts against the bot; a table of
 * two readies me and starts once the other has too (`startTableMatch`).
 */
export async function startMyTable(roomId: string, table: RoomTable): Promise<StartTableMatchOutcome> {
  if (table.players.length !== 1) return startTableMatch(roomId, table.id);
  const started = await tableClient.startVsBot(roomId, table.id);
  return started.ok ? { ok: true, matchId: started.matchId } : { ok: false, message: started.error };
}

/** A read made at one table, kept with that table's id (`heldFor`). */
export interface HeldAt<T> {
  tableId: string;
  value: T;
}

/**
 * `held`, when it was read at `tableId`; else `null`. A tournament's next round replaces my table
 * while the last one's read is still held, and that read (the deck the last round played) must
 * never answer for the new table: a round can now start while I sit in the room, when its last bot
 * game reports, and the held read let the new table start before its deck was picked.
 */
export function heldFor<T>(held: HeldAt<T> | null, tableId: string | undefined): T | null {
  return held !== null && held.tableId === tableId ? held.value : null;
}

/**
 * My table in the CURRENT round: among the pod's live pairings, never by
 * membership alone, since an earlier round's table is still mine, and finished.
 */
export function myCurrentTable(pod: PodView | null, tables: readonly RoomTable[], memberId: string | null): RoomTable | undefined {
  if (pod === null || memberId === null) return undefined;
  const current = new Set(pod.pairings.map((p) => p.tableId));
  return tables.find((t) => current.has(t.id) && t.players.some((p) => p.memberId === memberId));
}

/**
 * My table's next game starts with nobody pressing anything (the operator,
 * 2026-10-18: *"it should just go immediately into a game"*): being on my
 * table page with no game on it is the signal, and the second of its two
 * players to arrive starts it (`startMyTable`). `canStart` is the mode's own
 * gate (a re-picked deck, Gauntlet's banpick). Asked once per game; a refusal
 * is returned with `retry`.
 */
export function useTableStart(roomId: string, table: RoomTable | undefined, canStart: boolean): { error: string | null; retry: () => void; queuePlace: number | null } {
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const asked = useRef<string | null>(null);
  const start = (t: RoomTable, ask: string): void => {
    asked.current = ask;
    setError(null);
    setStarting(true);
    startMyTable(roomId, t).then((r) => {
      setStarting(false);
      if (!r.ok) setError(r.message);
    });
  };
  const ask = table === undefined ? null : `${table.id}:${table.series.games.length}:${table.series.phase}`;
  useEffect(() => {
    if (table === undefined || ask === null || !canStart || table.matchId !== null || !nextGameStarts(table.series.phase)) return;
    if (asked.current === ask) return;
    start(table, ask);
  });
  const retry = (): void => {
    if (table !== undefined) start(table, `${table.id}:retry`);
  };
  const queuePlace = useQueuePlace(starting && table?.matchId === null, tableClient.queuePlace);
  return { error, retry, queuePlace };
}

/**
 * Carries a paired player to their own table page, once per pairing
 * (`followTableOnce`), from the hub or from last round's table. `atTable` is
 * the route's table.
 */
export function useFollowMyTable(roomId: string, pod: PodView | null, tables: readonly RoomTable[], memberId: string | null, atTable: string | undefined): void {
  const mine = pod?.phase === 'rounds' ? myCurrentTable(pod, tables, memberId)?.id : undefined;
  useEffect(() => {
    if (mine !== undefined) followTableOnce(roomId, mine, atTable);
  }, [roomId, mine, atTable]);
}
