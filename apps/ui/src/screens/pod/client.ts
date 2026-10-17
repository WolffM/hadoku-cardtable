/*
 * The pod's own HTTP calls — wave 72 §R.
 *
 * `rooms/api.ts` (Q's) carries `RoomView.pod: unknown` in some read paths
 * and has no client method for the pod routes below
 * (`packages/shared/src/pod.ts` landed, `98f45240`, but the sit/stand/
 * rounds routes have no typed client anywhere yet). Rather than widen a
 * parser this lane does not own, this reads the room's own endpoint a
 * second time, raw, the same move `MatchScreen.tsx`'s `fetchRoomTables`
 * already makes for `tables` past wave 71's own parser gap.
 *
 * The sit/stand/rounds calls are raw fetches for that reason — no client
 * exists for them. Starting a pod table's game is NOT: `tables.ts`'s
 * `TablesClient` already has `ready`/`startRoom`, both already taking an
 * optional `tableId`, and a pod table is gated through the exact same two
 * calls a constructed table's is (confirmed against the real server — see
 * `startTableMatch`'s own header), so this imports and uses those instead
 * of a second, hand-rolled copy of them.
 */

import { RoomTablesSchema, type RoomTable } from '@hadoku/shared';

import { tablesClient } from '../tables.ts';
import { parsePodView, type PodView } from './wire.ts';

function appBase(): string {
  const base = import.meta.env?.BASE_URL;
  return typeof base === 'string' ? base : '/';
}

/** `/cardtable/api/`, matching `tables.ts`'s own `apiBase` for the same base URL. */
function podApiBase(): string {
  const base = appBase();
  return `${base}${base.endsWith('/') ? '' : '/'}api/`;
}

/** The room's raw body — `fetchRoomTables`'s sibling for `pod`. `null` on any failure. */
async function fetchRoomRaw(roomId: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${podApiBase()}rooms/${encodeURIComponent(roomId)}`, { credentials: 'same-origin' });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** `RoomView.pod`, narrowed. `null` for a constructed room, an unparseable body, or a failed read. */
export async function fetchPodView(roomId: string): Promise<PodView | null> {
  const body = await fetchRoomRaw(roomId);
  return body === null ? null : parsePodView(body.pod);
}

function isNamed(v: unknown): v is { id: string; name: string } {
  return typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string' && typeof (v as { name?: unknown }).name === 'string';
}

export interface PodContext {
  pod: PodView | null;
  /** This round's tables — `@hadoku/shared`'s own schema, safe to import (landed wave 71). */
  tables: RoomTable[];
  /** Every member's display name, by id — for resolving `pod.built`/`pod.bye`/`pod.standings[].id`. */
  names: Record<string, string>;
  /** `RoomView.leader` — the one member who may call `startPodRounds` below. `''` while unknown. */
  leaderId: string;
}

/**
 * Everything `PodScreen.tsx` needs for `building`/`rounds`/`done`, in one
 * read of the room's raw body — `pod`, `tables` (already landed, imported
 * directly) and a plain id→name map built from `members`, since neither
 * `PodView` nor `RoomTable.players` names everyone (a built-but-unpaired
 * drafter, a bye) the way the room's own member list does.
 */
export async function fetchPodContext(roomId: string): Promise<PodContext> {
  const body = await fetchRoomRaw(roomId);
  if (body === null) return { pod: null, tables: [], names: {}, leaderId: '' };
  const tables = RoomTablesSchema.safeParse(body.tables);
  const members = Array.isArray(body.members) ? body.members.filter(isNamed) : [];
  return {
    pod: parsePodView(body.pod),
    tables: tables.success ? tables.data : [],
    names: Object.fromEntries(members.map((m) => [m.id, m.name])),
    leaderId: typeof body.leader === 'string' ? body.leader : '',
  };
}

export interface PodActionOutcome {
  ok: boolean;
  /** The server's own refusal, shown as-is — never guessed at here. */
  message: string | null;
}

async function postPod(roomId: string, action: 'sit' | 'stand' | 'rounds', body: Record<string, unknown>): Promise<PodActionOutcome> {
  try {
    const res = await fetch(`${podApiBase()}rooms/${encodeURIComponent(roomId)}/pod/${action}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true, message: null };
    const parsed: unknown = await res.json().catch(() => null);
    const message = typeof parsed === 'object' && parsed !== null && 'error' in parsed ? String((parsed as { error: unknown }).error) : `The server refused that (${res.status}).`;
    return { ok: false, message };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Claims a pod seat — the leader's choice of `seat` (0-7), or the server's own pick when omitted. */
export function sitPod(roomId: string, seat?: number): Promise<PodActionOutcome> {
  return postPod(roomId, 'sit', seat === undefined ? {} : { seat });
}

/** Gives my own seat back. A no-op (refused, not thrown) once drafting has started. */
export function standPod(roomId: string): Promise<PodActionOutcome> {
  return postPod(roomId, 'stand', {});
}

/**
 * The leader's move from `building` to `rounds` — refused until every human
 * drafter is in `built` (the wire contract's own wording).
 */
export function startPodRounds(roomId: string): Promise<PodActionOutcome> {
  return postPod(roomId, 'rounds', {});
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
