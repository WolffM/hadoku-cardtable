/*
 * The rooms API, from the browser's side.
 *
 * The server's `apps/server/src/room/lobby.ts` owns the shape; this file writes
 * it down again as a type rather than importing it, because the UI does not
 * depend on the server package and the wire is the contract. Every response is
 * parsed, not cast: a room with a missing field is dropped from the list
 * rather than rendered as `undefined`.
 *
 * ## One answer for "wrong password" and "no such room"
 *
 * The server returns the same response for both, on purpose — a different
 * 404-vs-403 would tell an enumerator which rooms exist. This client keeps that
 * property: a join refused with either status is `refused`, and nothing
 * downstream can tell which it was.
 */

import { apiBase } from '../screens/tables.ts';

export type GameType = 'constructed-1v1' | 'draft';

export interface RoomMember {
  id: string;
  name: string;
  joinedAt: string;
}

export interface RoomView {
  id: string;
  name: string;
  creator: string;
  leader: string;
  /** Kept as a string: a type the server adds later is shown, not dropped. */
  gameType: string;
  locked: boolean;
  members: RoomMember[];
  matchId: string | null;
  createdAt: string;
}

/** The types the create form offers, and whether this build can play them. */
export const GAME_TYPES: readonly { value: GameType; label: string; ready: boolean }[] = [
  { value: 'constructed-1v1', label: 'Constructed 1v1', ready: true },
  { value: 'draft', label: 'Draft (coming soon)', ready: false },
];

export function gameTypeLabel(gameType: string): string {
  if (gameType === 'constructed-1v1') return 'Constructed 1v1';
  if (gameType === 'draft') return 'Draft';
  return gameType;
}

/** The server's own id rule — the same one `roomKeyFor` enforces. */
const ROOM_ID = /^[a-z0-9-]{1,40}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseMember(v: unknown): RoomMember | null {
  if (!isRecord(v)) return null;
  const { id, name, joinedAt } = v;
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  return { id, name, joinedAt: typeof joinedAt === 'string' ? joinedAt : '' };
}

/** A RoomView, or null when the body is not one. */
export function parseRoomView(v: unknown): RoomView | null {
  if (!isRecord(v)) return null;
  const { id, name, creator, leader, gameType, locked, members, matchId, createdAt } = v;
  if (typeof id !== 'string' || !ROOM_ID.test(id)) return null;
  if (typeof name !== 'string' || typeof gameType !== 'string' || typeof locked !== 'boolean') return null;
  if (!Array.isArray(members)) return null;
  return {
    id,
    name,
    creator: typeof creator === 'string' ? creator : '',
    leader: typeof leader === 'string' ? leader : '',
    gameType,
    locked,
    members: members.map(parseMember).filter((m): m is RoomMember => m !== null),
    matchId: typeof matchId === 'string' ? matchId : null,
    createdAt: typeof createdAt === 'string' ? createdAt : '',
  };
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type JoinOutcome =
  | { ok: true; room: RoomView }
  /** Wrong password OR no such room — deliberately one case. */
  | { ok: false; reason: 'refused' }
  | { ok: false; reason: 'rate-limited' }
  | { ok: false; reason: 'error'; message: string };

export type CreateOutcome = { ok: true; room: RoomView } | { ok: false; message: string };

export interface CreateRequest {
  name: string;
  gameType: GameType;
  /** Omitted from the body when empty: an empty string is not a password. */
  password?: string;
}

export interface RoomsClient {
  /** Throws with a sentence a person can read when the list cannot be loaded. */
  list(): Promise<RoomView[]>;
  create(req: CreateRequest): Promise<CreateOutcome>;
  join(roomId: string, password?: string): Promise<JoinOutcome>;
}

async function bodyOf(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function serverMessage(body: unknown, status: number): string {
  if (isRecord(body) && typeof body.error === 'string' && body.error !== '') return body.error;
  return `the server answered HTTP ${status}`;
}

function defaultApiBase(): string {
  const base = import.meta.env?.BASE_URL;
  return apiBase(typeof base === 'string' ? base : '/');
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export function roomsClient(fetchImpl: Fetch = (i, init) => fetch(i, init), base: string = defaultApiBase()): RoomsClient {
  const url = (path: string): string => `${base}rooms${path}`;

  return {
    async list() {
      let res: Response;
      try {
        res = await fetchImpl(url(''), { credentials: 'same-origin' });
      } catch {
        throw new Error('Could not reach the server.');
      }
      const body = await bodyOf(res);
      if (!res.ok) throw new Error(`Could not load the rooms: ${serverMessage(body, res.status)}.`);
      if (!isRecord(body) || !Array.isArray(body.rooms)) {
        throw new Error('Could not load the rooms: the server sent something that is not a room list.');
      }
      return body.rooms.map(parseRoomView).filter((r): r is RoomView => r !== null);
    },

    async create(req) {
      const payload: Record<string, string> = { name: req.name, gameType: req.gameType };
      if (req.password !== undefined && req.password !== '') payload.password = req.password;
      let res: Response;
      try {
        res = await fetchImpl(url(''), {
          method: 'POST',
          credentials: 'same-origin',
          headers: JSON_HEADERS,
          body: JSON.stringify(payload),
        });
      } catch {
        return { ok: false, message: 'Could not reach the server.' };
      }
      const body = await bodyOf(res);
      if (!res.ok) return { ok: false, message: `Could not create the room: ${serverMessage(body, res.status)}.` };
      const room = parseRoomView(body);
      if (room === null) return { ok: false, message: 'The server created something that is not a room.' };
      return { ok: true, room };
    },

    async join(roomId, password) {
      let res: Response;
      try {
        res = await fetchImpl(url(`/${encodeURIComponent(roomId)}/join`), {
          method: 'POST',
          credentials: 'same-origin',
          headers: JSON_HEADERS,
          body: JSON.stringify(password === undefined || password === '' ? {} : { password }),
        });
      } catch {
        return { ok: false, reason: 'error', message: 'Could not reach the server.' };
      }
      const body = await bodyOf(res);
      if (res.status === 403 || res.status === 404) return { ok: false, reason: 'refused' };
      if (res.status === 429) return { ok: false, reason: 'rate-limited' };
      if (!res.ok) return { ok: false, reason: 'error', message: `Could not join: ${serverMessage(body, res.status)}.` };
      const room = parseRoomView(body);
      if (room === null) return { ok: false, reason: 'error', message: 'The server answered the join with something that is not a room.' };
      return { ok: true, room };
    },
  };
}
