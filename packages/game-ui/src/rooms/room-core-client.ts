/*
 * The browser's client for game-server's generic room routes (`@hadoku/game-server/http/room-core`):
 * the room list, a room, create, join, leave, ready, close, reset, the seat ops (sit, stand, the
 * leader's close/open, bot in and out, remove, fewer seats, a new leader), the room's settings and an embed's binding to
 * its host's room. One copy, so every game
 * reads the same refusals the same way; a game supplies only how its room body parses
 * (`parse`), and adds its own routes with `write`/`read`.
 *
 * ## One answer for "wrong password" and "no such room"
 *
 * room-core answers both with the same refusal, on purpose (a 404-vs-403 would tell an enumerator
 * which rooms exist). A join refused with either status is `refused`, and nothing downstream can
 * tell which it was.
 *
 * ## The words
 *
 * A room write that fails reads `<what failed>: <the server's own sentence>.`; a seat op's refusal
 * is the server's own sentence as is (the seat strip shows it under the seats). A body that is not a
 * room is a refusal too, never a crash: a proxy's error page parses as nothing.
 */

import { apiBase, bodyOf, getJson, isRecord, pageFetch, sendJson, serverMessage, type Fetch } from '../http.ts';
import type { RoomFrontClient, RoomFrontJoinOutcome, RoomFrontRoom } from '../front/RoomFront.tsx';

/** A room write's answer: the room as the server now has it, or why not. */
export type RoomOutcome<R> = { ok: true; room: R } | { ok: false; message: string };

/** A write that ends the room for everyone (a close, a testing room's reset): answered with no room. */
export type RoomEndOutcome = { ok: true } | { ok: false; message: string };

export type RoomJoinOutcome<R> = RoomFrontJoinOutcome<R>;

export interface RoomCoreClientOptions<R> {
  /** The game's own room body, or `null` for a body that is not one (it is dropped from a list, refused elsewhere). */
  parse(body: unknown): R | null;
  fetch?: Fetch;
  /** The `/api/` base, `apiBase()` (this bundle's own) unless given. */
  base?: string;
}

export interface RoomCoreClient<R> {
  /** `GET /api/rooms`: every room the caller may see, and the whole body for a game's own extras (a featured pick, say). Throws a sentence. */
  list(): Promise<{ rooms: R[]; body: Record<string, unknown> }>;
  /** `GET /api/rooms/:id`: `null` on the usual 404, a thrown sentence for anything else. */
  get(roomId: string): Promise<R | null>;
  create(body: Record<string, unknown>): Promise<RoomOutcome<R>>;
  join(roomId: string, password?: string): Promise<RoomJoinOutcome<R>>;
  leave(roomId: string): Promise<RoomOutcome<R>>;
  ready(roomId: string, ready: boolean): Promise<RoomOutcome<R>>;
  close(roomId: string): Promise<RoomEndOutcome>;
  reset(roomId: string): Promise<RoomEndOutcome>;
  /** The viewer takes `seat`, or the first open one (the room grows by one when none is). */
  sit(roomId: string, seat?: number): Promise<RoomOutcome<R>>;
  /** The viewer gives their seat back. */
  stand(roomId: string): Promise<RoomOutcome<R>>;
  /** The leader closes an empty seat, or opens a closed one. */
  setSeatClosed(roomId: string, seat: number, closed: boolean): Promise<RoomOutcome<R>>;
  /** The leader puts the bot in `seat`, evicting a human holder first. */
  bot(roomId: string, seat: number): Promise<RoomOutcome<R>>;
  /** The leader takes the bot back out of `seat`. */
  botOff(roomId: string, seat: number): Promise<RoomOutcome<R>>;
  /** The leader moves a seated member to the spectators. */
  removeFromSeat(roomId: string, memberId: string): Promise<RoomOutcome<R>>;
  /** The leader closes seats from the top down until `count` are open. */
  lowerSeatCapacity(roomId: string, count: number): Promise<RoomOutcome<R>>;
  /** The leader hands the room to another member, seated or watching. */
  makeLeader(roomId: string, memberId: string): Promise<RoomOutcome<R>>;
  /** The room a host's room (watchparty's game slot) plays in, made on first use and joined after: the server derives it from `hostRoom`. */
  bindWatchparty(hostRoom: string): Promise<RoomOutcome<R>>;
  /** The leader changes some of the room's settings (`PATCH /:id { settings }`); a locked or bad one is refused in the server's words. */
  setSettings(roomId: string, patch: Record<string, unknown>): Promise<RoomOutcome<R>>;
  /** Any other write that answers with the room, under `/api/rooms`: `path` starts with `/` or is `''`. */
  write(path: string, payload: unknown, whatFailed: string, method?: 'POST' | 'PATCH' | 'PUT'): Promise<RoomOutcome<R>>;
  /** Any other read of one room under `/api/rooms`, as `get` reads one. */
  read(path: string): Promise<R | null>;
}

const UNREACHABLE = 'Could not reach the server.';
const NOT_A_ROOM = 'The server answered with something that is not a room.';
const id = (roomId: string): string => `/${encodeURIComponent(roomId)}`;

export function roomCoreClient<R>({ parse, fetch: fetchImpl = pageFetch, base = apiBase() }: RoomCoreClientOptions<R>): RoomCoreClient<R> {
  const url = (path: string): string => `${base}rooms${path}`;

  /** A write answered with the room; `whatFailed` null for a seat op, whose refusal is the server's own sentence. */
  const send = async (path: string, payload: unknown, whatFailed: string | null, method = 'POST'): Promise<RoomOutcome<R>> => {
    let res: Response;
    try {
      res = await sendJson(url(path), method, payload, fetchImpl);
    } catch {
      return { ok: false, message: UNREACHABLE };
    }
    const body = await bodyOf(res);
    if (!res.ok) return { ok: false, message: whatFailed === null ? serverMessage(body, res.status) : `${whatFailed}: ${serverMessage(body, res.status)}.` };
    const room = parse(body);
    return room === null ? { ok: false, message: NOT_A_ROOM } : { ok: true, room };
  };

  const end = async (roomId: string, verb: 'close' | 'reset', whatFailed: string): Promise<RoomEndOutcome> => {
    let res: Response;
    try {
      res = await sendJson(url(`${id(roomId)}/${verb}`), 'POST', {}, fetchImpl);
    } catch {
      return { ok: false, message: UNREACHABLE };
    }
    if (res.ok) return { ok: true };
    return { ok: false, message: `${whatFailed}: ${serverMessage(await bodyOf(res), res.status)}.` };
  };

  const read = async (path: string): Promise<R | null> => {
    let res: Response;
    try {
      res = await getJson(url(path), fetchImpl);
    } catch {
      throw new Error(UNREACHABLE);
    }
    if (res.status === 404) return null;
    const body = await bodyOf(res);
    if (!res.ok) throw new Error(`Could not load the room: ${serverMessage(body, res.status)}.`);
    const room = parse(body);
    if (room === null) throw new Error('The server sent something that is not a room.');
    return room;
  };

  const seat = (roomId: string, op: string, payload: unknown): Promise<RoomOutcome<R>> => send(`${id(roomId)}/${op}`, payload, null);

  return {
    async list() {
      let res: Response;
      try {
        res = await getJson(url(''), fetchImpl);
      } catch {
        throw new Error(UNREACHABLE);
      }
      const body = await bodyOf(res);
      if (!res.ok) throw new Error(`Could not load the rooms: ${serverMessage(body, res.status)}.`);
      if (!isRecord(body) || !Array.isArray(body.rooms)) throw new Error('Could not load the rooms: the server sent something that is not a room list.');
      const rooms = body.rooms.map(parse).filter((r): r is R => r !== null);
      return { rooms, body };
    },

    get: (roomId) => read(id(roomId)),

    create: (body) => send('', body, 'Could not create the room'),

    async join(roomId, password) {
      let res: Response;
      try {
        res = await sendJson(url(`${id(roomId)}/join`), 'POST', password === undefined || password === '' ? {} : { password }, fetchImpl);
      } catch {
        return { ok: false, reason: 'error', message: UNREACHABLE };
      }
      if (res.status === 403 || res.status === 404) return { ok: false, reason: 'refused' };
      if (res.status === 429) return { ok: false, reason: 'rate-limited' };
      const body = await bodyOf(res);
      if (!res.ok) return { ok: false, reason: 'error', message: `Could not join: ${serverMessage(body, res.status)}.` };
      const room = parse(body);
      if (room === null) return { ok: false, reason: 'error', message: 'The server answered the join with something that is not a room.' };
      return { ok: true, room };
    },

    leave: (roomId) => send(`${id(roomId)}/leave`, {}, 'Could not leave the room'),
    ready: (roomId, ready) => send(`${id(roomId)}/ready`, { ready }, 'Could not change your readiness'),
    close: (roomId) => end(roomId, 'close', 'Could not close the room'),
    reset: (roomId) => end(roomId, 'reset', 'Could not reset the room'),

    sit: (roomId, at) => seat(roomId, 'seats/sit', at === undefined ? {} : { seat: at }),
    stand: (roomId) => seat(roomId, 'seats/stand', {}),
    setSeatClosed: (roomId, at, closed) => seat(roomId, 'seats/close', { seat: at, closed }),
    bot: (roomId, at) => seat(roomId, 'seats/bot', { seat: at }),
    botOff: (roomId, at) => seat(roomId, 'seats/bot-off', { seat: at }),
    removeFromSeat: (roomId, memberId) => seat(roomId, 'seats/remove', { memberId }),
    lowerSeatCapacity: (roomId, count) => seat(roomId, 'seats/capacity', { count }),
    makeLeader: (roomId, memberId) => seat(roomId, 'leader', { memberId }),
    bindWatchparty: (hostRoom) => send('/watchparty', { room: hostRoom }, 'Could not open this room’s table'),
    setSettings: (roomId, patch) => send(id(roomId), { settings: patch }, 'Could not change the settings', 'PATCH'),

    write: (path, payload, whatFailed, method = 'POST') => send(path, payload, whatFailed, method),
    read,
  };
}

/**
 * `RoomFront`'s client over a core client: the game's own projection of its room (`toFront`: the
 * seats, the state and the primary action a row draws) applied to every list, create and join.
 * `reset` offers an admin's Reset on the game's seeded testing rooms.
 */
export function roomFrontClient<R, V extends RoomFrontRoom>(core: RoomCoreClient<R>, toFront: (room: R) => V, opts: { reset?: boolean } = {}): RoomFrontClient<V> {
  return {
    async list() {
      const { rooms } = await core.list();
      return { rooms: rooms.map(toFront) };
    },
    async create(body) {
      const outcome = await core.create(body);
      return outcome.ok ? { ok: true, room: toFront(outcome.room) } : outcome;
    },
    async join(roomId, password) {
      const outcome = await core.join(roomId, password);
      return outcome.ok ? { ok: true, room: toFront(outcome.room) } : outcome;
    },
    ...(opts.reset === true ? { reset: (roomId: string) => core.reset(roomId) } : {}),
  };
}
