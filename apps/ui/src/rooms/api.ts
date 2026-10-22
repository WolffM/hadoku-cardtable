/*
 * The rooms API, from the browser's side.
 *
 * The shape is `@hadoku/shared`'s `RoomBodySchema`, the same one the server
 * builds its answers as, and every response is parsed through it rather than
 * cast: a body that is not a room is dropped from the list, and a field it
 * lacks reads as the default that schema states.
 *
 * ## One answer for "wrong password" and "no such room"
 *
 * The server returns the same response for both, on purpose — a different
 * 404-vs-403 would tell an enumerator which rooms exist. This client keeps that
 * property: a join refused with either status is `refused`, and nothing
 * downstream can tell which it was.
 *
 * ## Readiness is the ROOM's, and a draft is what it starts (w23)
 *
 * A draft is a room: `RoomMember.ready`, which every member has to set before
 * the draft is dealt, and `RoomView.draftStartedAt`, which is null for the
 * whole lobby phase and an ISO string once the server has dealt the pod. A
 * restart mid-draft puts the room back in its lobby, and the room screen says
 * so in words.
 *
 * ## The pool is the ROOM's, and only the leader moves it (w25)
 *
 * `RoomView.format` is a `TableFormat.id` and the table's rules for BOTH seats;
 * it used to be per-seat, sent with each player's deck. `setFormat` is the
 * leader's setter — `PATCH /api/rooms/:id` with `{ format }`, the same route and
 * allow-list that carries `{ gameType }` — and a non-leader gets the server's
 * own refusal rather than a control that does nothing.
 *
 * `RoomView.you` is caller-scoped: `leader` is the only thing that can tell a
 * browser it owns the table's settings.
 */

import {
  RoomBodySchema,
  CubeSummarySchema,
  DraftCardSchema,
  DraftPresetSchema,
  PoolVerdictSchema,
  SetSummarySchema,
  type ClientMode,
  type ConstructedMode,
  type CubeSummary,
  type DraftCard,
  type DraftPlan,
  type DraftPreset,
  type GameType,
  type PoolVerdict,
  type RoomBody,
  type RoomMode,
  type RoomPod,
  type RoomSettings,
  type RoomTable,
  type SetSummary,
} from '@hadoku/shared';

import { apiBase, appBase, bodyOf, getJson, isRecord, sendJson, serverMessage, type Fetch } from '../http.ts';

export type { ClientMode, Fetch, GameType, RoomSettings };
export type { RoomMember, RoomYou } from '@hadoku/shared';

/** A room as the caller is told it: the public view plus their own row (`you`). */
export type RoomView = RoomBody;


/** The types the create form offers, as the operator named them (2026-10-21). The wire ids stay. */
export const GAME_TYPES: readonly { value: GameType; label: string }[] = [
  { value: 'constructed-1v1', label: 'Constructed' },
  { value: 'draft', label: 'Draft' },
];

export function gameTypeLabel(gameType: string): string {
  return GAME_TYPES.find((t) => t.value === gameType)?.label ?? gameType;
}

/** The mode in two or three words, for a list row or a header. */
export function clientModeLabel(mode: ClientMode): string {
  return mode === 'streamed' ? 'streamed Forge' : 'our table';
}

/**
 * Where one seat's stream lives: the server's room-keyed stream route.
 *
 * One expression, in one file, on purpose — the path shape is a contract with
 * the server's `stream/` module and repointing it must stay a one-line edit.
 * `base` is the app's deploy prefix (`/cardtable/`), so this is same-origin by
 * construction and no host is ever written down here.
 */
export function streamRoot(roomId: string, seat: number, base: string = appBase()): string {
  const prefix = base === '' ? '/' : base;
  const root = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `${root}stream/${encodeURIComponent(roomId)}/${seat}/`;
}

/**
 * The page a seat actually shows, and probes.
 *
 * **Not the seat's root.** websockify answers `/` with its own DIRECTORY
 * LISTING — `vnc.html`, `vnc_lite.html`, a few folders — which is a 200 with no
 * noVNC in it. A seat pointed at the root therefore framed a file listing and
 * probed as unreachable forever, so every streamed room sat on "waiting for the
 * stream" with a perfectly healthy container behind it. Found by
 * `e2e/streamed-live.spec.ts` on 2026-09-24, the first time anything drove a
 * real container.
 *
 * `path` tells noVNC where its websocket lives, RELATIVE to the origin and
 * with no leading slash, because we are served under a base prefix. This is
 * the same shape the static bench's links use, and they work.
 *
 * `autoconnect` so a player sees Forge rather than a Connect button;
 * `resize=scale` so the 1280x800 desktop fits the seat it is drawn in.
 */
export function streamPath(roomId: string, seat: number, base: string = appBase()): string {
  const root = streamRoot(roomId, seat, base);
  const socket = `${root}websockify`.replace(/^\//, '');
  return `${root}vnc.html?path=${encodeURIComponent(socket)}&autoconnect=true&resize=scale`;
}

/**
 * A string that appears in noVNC's page and in nothing this app serves.
 *
 * The reachability probe below needs POSITIVE evidence, because a 200 proves
 * nothing here: with no containers the server's SPA fallback answers every
 * `/stream/**` path with our own `index.html` and HTTP 200, so `res.ok` is
 * true for a stream that does not exist — and a frame on it renders this app
 * inside itself. Asking "does this look like noVNC" is false for our page,
 * false for an error page and false for no answer at all, and each of those
 * gets the stated waiting state instead of a frame that lies.
 */
export const STREAM_MARK = 'noVNC';

/** True only when the seat's page really is the stream's. Never throws. */
export async function streamReachable(url: string, fetchImpl: Fetch = (i, init) => fetch(i, init)): Promise<boolean> {
  let res: Response;
  try {
    res = await fetchImpl(url, { credentials: 'same-origin' });
  } catch {
    // Not reachable IS the answer this returns; there is nothing being
    // swallowed here, and the caller renders the waiting state either way.
    return false;
  }
  if (!res.ok) return false;
  try {
    return (await res.text()).includes(STREAM_MARK);
  } catch {
    return false;
  }
}

/** A RoomView, or null when the body is not one. */
export function parseRoomView(v: unknown): RoomView | null {
  const parsed = RoomBodySchema.safeParse(v);
  return parsed.success ? parsed.data : null;
}

export type JoinOutcome =
  | { ok: true; room: RoomView }
  /** Wrong password OR no such room — deliberately one case. */
  | { ok: false; reason: 'refused' }
  | { ok: false; reason: 'rate-limited' }
  | { ok: false; reason: 'error'; message: string };

export type CreateOutcome = { ok: true; room: RoomView } | { ok: false; message: string };

/**
 * A room the server changed, or the sentence it refused with.
 *
 * One shape for both writes, because a person reading the screen needs the same
 * thing from either: the room as it now is, or words. The refusal is the
 * server's own — `start` answers 409 with a sentence for "this room does not
 * play draft" and for "somebody is not ready" — so nothing here paraphrases it.
 */
export type RoomOutcome = { ok: true; room: RoomView } | { ok: false; message: string };

export interface CreateRequest {
  name: string;
  gameType: GameType;
  /**
   * Always sent, never inferred. The create form no longer offers a choice
   * (2026-10-10) and always sends `builtin`; the API still takes `streamed`.
   */
  clientMode: ClientMode;
  /** Omitted from the body when empty: an empty string is not a password. */
  password?: string;
  /** A constructed room's mode, chosen at create. Omitted: the leader chooses it in the room. */
  mode?: RoomMode;
}

export interface RoomsClient {
  /** Throws with a sentence a person can read when the list cannot be loaded. */
  list(): Promise<RoomView[]>;
  /**
   * One room: `null` when the server answers its usual 404 (no such room, or
   * one it will not admit to), and a thrown sentence for anything else — a
   * reachability problem is not the same fact as "there is no such room".
   */
  get(roomId: string): Promise<RoomView | null>;
  create(req: CreateRequest): Promise<CreateOutcome>;
  join(roomId: string, password?: string): Promise<JoinOutcome>;
  /** Your own readiness in this room. The server resolves who you are. */
  ready(roomId: string, ready: boolean): Promise<RoomOutcome>;
  /**
   * Step out of a room (R16): removed from `members`, your ready flag and deck
   * hold gone with you. If you were the leader, leadership passes to whoever
   * remains and joined earliest — the server's ruling, not a choice made here.
   *
   * This is the result screen's "Main menu" button: leave, then go to the
   * lobby list. "Rematch" never calls this — it stays a member and readies at
   * the room's table.
   */
  leave(roomId: string): Promise<RoomOutcome>;
  /** The owner ends the room for everyone: its games stop and it leaves the list. */
  close(roomId: string): Promise<{ ok: true } | { ok: false; message: string }>;
  /**
   * Set the table's pool. The LEADER's call: anyone else gets the server's
   * `only the room leader…` refusal, in its own words, and the screen does not
   * offer the control in the first place.
   *
   * `PATCH /api/rooms/:id`, the same route and the same allow-list that carries
   * `{ gameType }` — so `{ format }` is the whole body, and a field that is not
   * on the list is a 400 rather than a write nobody notices.
   */
  setFormat(roomId: string, format: string): Promise<RoomOutcome>;
  /** Change some of the room's settings. The LEADER's call, through the same PATCH as `setFormat`. */
  setSettings(roomId: string, settings: Partial<RoomSettings>): Promise<RoomOutcome>;
  /**
   * Choose a constructed room's mode and its options. The LEADER's call, through
   * the same PATCH as `setFormat`; refused once a seated player is ready.
   */
  setRoomMode(roomId: string, mode: RoomMode): Promise<RoomOutcome>;
  /** Make the room Constructed or Draft. The LEADER's call, through the same PATCH, under the mode's lock. */
  setGameType(roomId: string, gameType: GameType): Promise<RoomOutcome>;
  /**
   * Deal the draft. Any member may ask — like constructed, where either browser
   * may start the match and the server answers one start to both — and asking
   * twice is not an error: a room whose draft has already started answers with
   * its view.
   */
  start(roomId: string): Promise<RoomOutcome>;
  /**
   * Set a draft room's pool — the LEADER's call, lobby phase only
   * (`PUT /api/rooms/:id/pod/plan`, wave 73 §A's contract).
   *
   * The server runs the verdict before accepting: a refusal is a 409 carrying
   * the verdict that failed it, and the room's plan is left exactly as it
   * was — this is the one write whose failure body is meaningful beyond a
   * sentence, so it gets its own outcome type rather than `RoomOutcome`.
   */
  setPlan(roomId: string, plan: DraftPlan): Promise<SetPlanOutcome>;
}

/**
 * `RoomsClient.setPlan`'s own outcome: a refusal carries the verdict that
 * failed it (`null` only when the server's refusal body itself did not parse —
 * a reachability problem, not a verdict), so the picker can show the
 * unplayable/missing names without a second round trip.
 */
export type SetPlanOutcome = { ok: true; room: RoomView } | { ok: false; message: string; verdict: PoolVerdict | null };

/** A 409 refusal's own body — `{ verdict }`, per the contract. `null` for anything else. */
function refusalVerdict(body: unknown): PoolVerdict | null {
  if (!isRecord(body)) return null;
  const parsed = PoolVerdictSchema.safeParse(body.verdict);
  return parsed.success ? parsed.data : null;
}

/**
 * The embed's one room call (D21), and like `RoomIdentityClient` below not a
 * screen's: the table a watchparty room's game slot is bound to, made on first
 * use and joined after. `watchpartyRoom` names the watchparty room; the server
 * derives the cardtable room id from it, so every member arrives at one table.
 */
export interface RoomBindClient {
  bindWatchparty(watchpartyRoom: string): Promise<RoomOutcome>;
}

/**
 * The match screen's one room call: which room started this match. Its route
 * carries only the match id, and the result screen readies at that room's
 * table for a Rematch. The server remembers a room's recent matches past their
 * end and past a restart, so a reload on a finished match still finds it;
 * `null` is the server's 404 (not a room match, or not your room).
 */
export interface RoomOfMatchClient {
  roomOfMatch(matchId: string): Promise<RoomView | null>;
}

/**
 * The room's identity write, deliberately NOT on `RoomsClient`.
 *
 * `RoomsClient` is what a SCREEN does to a room: list it, enter it, ready up,
 * choose the pool, start the draft. Asserting which avatar you are wearing is
 * none of those — it is the watchparty seam's own write, made once per room by
 * `room/RoomShell.tsx`, and no screen calls it or should have to stub it. Two
 * interfaces keep each one exactly as wide as its consumers; `roomsClient()`
 * returns both.
 */
export interface RoomIdentityClient {
  /**
   * Tell the room which avatar you are wearing — YOUR row and nobody else's.
   *
   * The server resolves who you are from the edge's headers, exactly as `ready`
   * does, so the body names a value and never a member. `null` clears it.
   *
   * A room you are not in, and an id that is not a room at all, are the server's
   * usual single 404; a caller that asserts against a MATCH id therefore gets a
   * refusal and should ignore it rather than surface it (see `RoomShell`).
   */
  setAvatar(roomId: string, avatarId: string | null): Promise<RoomOutcome>;
}

export function roomsClient(
  fetchImpl: Fetch = (i, init) => fetch(i, init),
  base: string = apiBase(),
): RoomsClient & RoomIdentityClient & RoomBindClient & RoomOfMatchClient {
  const url = (path: string): string => `${base}rooms${path}`;

  /**
   * The room writes that answer with the room. Same shape, same refusals.
   *
   * The method is a parameter because the pool's setter is a PATCH on the room
   * itself while readiness and the start are POSTs to sub-paths; everything
   * after the request is identical, including the refusal wording, so there is
   * one of these and not two.
   */
  const write = async (path: string, payload: unknown, whatFailed: string, method: 'POST' | 'PATCH' = 'POST'): Promise<RoomOutcome> => {
    let res: Response;
    try {
      res = await sendJson(url(path), method, payload, fetchImpl);
    } catch {
      return { ok: false, message: 'Could not reach the server.' };
    }
    const body = await bodyOf(res);
    if (!res.ok) return { ok: false, message: `${whatFailed}: ${serverMessage(body, res.status)}.` };
    const room = parseRoomView(body);
    if (room === null) return { ok: false, message: 'The server answered with something that is not a room.' };
    return { ok: true, room };
  };

  /** One room's view: `null` on the server's usual 404, a thrown sentence for anything else. */
  const read = async (path: string): Promise<RoomView | null> => {
    let res: Response;
    try {
      res = await getJson(url(path), fetchImpl);
    } catch {
      throw new Error('Could not reach the server.');
    }
    if (res.status === 404) return null;
    const body = await bodyOf(res);
    if (!res.ok) throw new Error(`Could not load the room: ${serverMessage(body, res.status)}.`);
    const room = parseRoomView(body);
    if (room === null) throw new Error('The server sent something that is not a room.');
    return room;
  };

  return {
    async list() {
      let res: Response;
      try {
        res = await getJson(url(''), fetchImpl);
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

    get(roomId) {
      return read(`/${encodeURIComponent(roomId)}`);
    },

    roomOfMatch(matchId) {
      return read(`/of-match/${encodeURIComponent(matchId)}`);
    },

    create(req) {
      const payload: Record<string, unknown> = { name: req.name, gameType: req.gameType, clientMode: req.clientMode };
      if (req.password !== undefined && req.password !== '') payload.password = req.password;
      if (req.mode !== undefined) Object.assign(payload, req.mode);
      return write('', payload, 'Could not create the room');
    },

    async join(roomId, password) {
      let res: Response;
      try {
        res = await sendJson(url(`/${encodeURIComponent(roomId)}/join`), 'POST', password === undefined || password === '' ? {} : { password }, fetchImpl);
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

    ready(roomId, ready) {
      return write(`/${encodeURIComponent(roomId)}/ready`, { ready }, 'Could not change your readiness');
    },

    leave(roomId) {
      return write(`/${encodeURIComponent(roomId)}/leave`, {}, 'Could not leave the room');
    },

    async close(roomId) {
      let res: Response;
      try {
        res = await sendJson(url(`/${encodeURIComponent(roomId)}/close`), 'POST', {}, fetchImpl);
      } catch {
        return { ok: false, message: 'Could not reach the server.' };
      }
      if (res.ok) return { ok: true };
      return { ok: false, message: `Could not close the room: ${serverMessage(await bodyOf(res), res.status)}.` };
    },

    setFormat(roomId, format) {
      return write(`/${encodeURIComponent(roomId)}`, { format }, 'Could not change the pool', 'PATCH');
    },

    setSettings(roomId, settings) {
      return write(`/${encodeURIComponent(roomId)}`, { settings }, 'Could not change the room settings', 'PATCH');
    },

    setRoomMode(roomId, mode) {
      return write(`/${encodeURIComponent(roomId)}`, mode, 'Could not change the room mode', 'PATCH');
    },
    setGameType(roomId, gameType) {
      return write(`/${encodeURIComponent(roomId)}`, { gameType }, 'Could not change the game type', 'PATCH');
    },

    start(roomId) {
      return write(`/${encodeURIComponent(roomId)}/start`, {}, 'Could not start the draft');
    },

    async setPlan(roomId, plan) {
      let res: Response;
      try {
        res = await sendJson(url(`/${encodeURIComponent(roomId)}/pod/plan`), 'PUT', { plan }, fetchImpl);
      } catch {
        return { ok: false, message: 'Could not reach the server.', verdict: null };
      }
      const body = await bodyOf(res);
      if (res.status === 409) {
        return { ok: false, message: 'That pool is not Forge-playable.', verdict: refusalVerdict(body) };
      }
      if (!res.ok) return { ok: false, message: `Could not set the pool: ${serverMessage(body, res.status)}.`, verdict: null };
      const room = parseRoomView(body);
      if (room === null) return { ok: false, message: 'The server answered with something that is not a room.', verdict: null };
      return { ok: true, room };
    },

    bindWatchparty(watchpartyRoom) {
      return write('/watchparty', { room: watchpartyRoom }, 'Could not open this room’s table');
    },
    setAvatar(roomId, avatarId) {
      return write(`/${encodeURIComponent(roomId)}/identity`, { avatarId }, 'Could not set your avatar');
    },
  };
}

/* ── pools: the cube picker's own list (C's routes, wave 73 §C) ────────── */

/**
 * `GET/POST/DELETE /api/pools/cubes…` — C's own store, mounted by A's
 * `index.ts`. Not room-scoped (a cube is shared across every room), so this
 * is its own client rather than a method on `RoomsClient`; it lives beside it
 * because the wire surface is small and the picker is this wave's only
 * caller.
 */
export interface PoolsClient {
  /** Imported first (newest first), then the shortlist, in file order — the server's own order, kept. */
  listCubes(): Promise<CubeSummary[]>;
  importCube(link: string): Promise<{ ok: true; cube: CubeSummary } | { ok: false; message: string }>;
  refreshCube(id: string): Promise<{ ok: true; cube: CubeSummary } | { ok: false; message: string }>;
  /** 403 (not the importer) and 400 (a shortlist cube) both read as a plain refusal — the picker never offers the control to anyone else. */
  deleteCube(id: string): Promise<{ ok: true } | { ok: false; message: string }>;
  /**
   * A cube's own cards, for warming its art before the deal
   * (`GET /api/pools/cubes/:id/cards`, lane C's follow-up). `null` for an id
   * the server does not know (404) — never thrown: a cube that disappeared
   * between the room's plan and this call costs a warm-up, not a screen.
   */
  cubeCards(id: string): Promise<DraftCard[] | null>;
  /**
   * Every set Forge has a draft booster template for (ruling 8), newest
   * first — `GET /api/pools/sets` (wave 74 §E). `verdict` is cached-only; this
   * never triggers a check.
   */
  listSets(): Promise<SetSummary[]>;
  /** Named custom plans, shared with the group (wave 74 §G). `GET /api/pools/presets`. */
  listPresets(): Promise<DraftPreset[]>;
  /** `POST /api/pools/presets`. The caller is the server's own resolved friend id, same as a cube import. */
  savePreset(name: string, plan: DraftPlan): Promise<{ ok: true; preset: DraftPreset } | { ok: false; message: string }>;
  /** `DELETE /api/pools/presets/:id` → 204, or a refusal — 403 unless the caller is the preset's own creator (same rule as a cube import, ruling 4/the plan's "Presets" ruling). */
  deletePreset(id: string): Promise<{ ok: true } | { ok: false; message: string }>;
}

export function poolsClient(fetchImpl: Fetch = (i, init) => fetch(i, init), base: string = apiBase()): PoolsClient {
  const url = (path: string): string => `${base}pools/cubes${path}`;
  /** Sets and presets sit beside `pools/cubes`, not under it — the pools root, same base. */
  const poolsUrl = (path: string): string => `${base}pools${path}`;

  return {
    async listCubes() {
      let res: Response;
      try {
        res = await getJson(url(''), fetchImpl);
      } catch {
        throw new Error('Could not reach the server.');
      }
      const body = await bodyOf(res);
      if (!res.ok) throw new Error(`Could not load the cube list: ${serverMessage(body, res.status)}.`);
      const parsed = CubeSummarySchema.array().safeParse(body);
      if (!parsed.success) throw new Error('The server sent something that is not a cube list.');
      return parsed.data;
    },

    async importCube(link) {
      let res: Response;
      try {
        res = await sendJson(url('/import'), 'POST', { link }, fetchImpl);
      } catch {
        return { ok: false, message: 'Could not reach the server.' };
      }
      const body = await bodyOf(res);
      if (!res.ok) return { ok: false, message: `Could not import that cube: ${serverMessage(body, res.status)}.` };
      const parsed = CubeSummarySchema.safeParse(body);
      if (!parsed.success) return { ok: false, message: 'The server imported something that is not a cube.' };
      return { ok: true, cube: parsed.data };
    },

    async refreshCube(id) {
      let res: Response;
      try {
        res = await sendJson(url(`/${encodeURIComponent(id)}/refresh`), 'POST', {}, fetchImpl);
      } catch {
        return { ok: false, message: 'Could not reach the server.' };
      }
      const body = await bodyOf(res);
      if (!res.ok) return { ok: false, message: `Could not refresh that cube: ${serverMessage(body, res.status)}.` };
      const parsed = CubeSummarySchema.safeParse(body);
      if (!parsed.success) return { ok: false, message: 'The server refreshed something that is not a cube.' };
      return { ok: true, cube: parsed.data };
    },

    async deleteCube(id) {
      let res: Response;
      try {
        res = await fetchImpl(url(`/${encodeURIComponent(id)}`), { method: 'DELETE', credentials: 'same-origin' });
      } catch {
        return { ok: false, message: 'Could not reach the server.' };
      }
      if (res.ok) return { ok: true };
      const body = await bodyOf(res);
      return { ok: false, message: `Could not delete that cube: ${serverMessage(body, res.status)}.` };
    },

    async cubeCards(id) {
      let res: Response;
      try {
        res = await getJson(url(`/${encodeURIComponent(id)}/cards`), fetchImpl);
      } catch {
        return null;
      }
      if (!res.ok) return null;
      const body = await bodyOf(res);
      const parsed = DraftCardSchema.array().safeParse(body);
      return parsed.success ? parsed.data : null;
    },

    async listSets() {
      let res: Response;
      try {
        res = await fetchImpl(poolsUrl('/sets'), { credentials: 'same-origin' });
      } catch {
        throw new Error('Could not reach the server.');
      }
      const body = await bodyOf(res);
      if (!res.ok) throw new Error(`Could not load the set list: ${serverMessage(body, res.status)}.`);
      const parsed = SetSummarySchema.array().safeParse(body);
      if (!parsed.success) throw new Error('The server sent something that is not a set list.');
      return parsed.data;
    },

    async listPresets() {
      let res: Response;
      try {
        res = await fetchImpl(poolsUrl('/presets'), { credentials: 'same-origin' });
      } catch {
        throw new Error('Could not reach the server.');
      }
      const body = await bodyOf(res);
      if (!res.ok) throw new Error(`Could not load the presets: ${serverMessage(body, res.status)}.`);
      const parsed = DraftPresetSchema.array().safeParse(body);
      if (!parsed.success) throw new Error('The server sent something that is not a preset list.');
      return parsed.data;
    },

    async savePreset(name, plan) {
      let res: Response;
      try {
        res = await fetchImpl(poolsUrl('/presets'), {
          method: 'POST',
          credentials: 'same-origin',
          headers: JSON_HEADERS,
          body: JSON.stringify({ name, plan }),
        });
      } catch {
        return { ok: false, message: 'Could not reach the server.' };
      }
      const body = await bodyOf(res);
      if (!res.ok) return { ok: false, message: `Could not save that preset: ${serverMessage(body, res.status)}.` };
      const parsed = DraftPresetSchema.safeParse(body);
      if (!parsed.success) return { ok: false, message: 'The server saved something that is not a preset.' };
      return { ok: true, preset: parsed.data };
    },

    async deletePreset(id) {
      let res: Response;
      try {
        res = await fetchImpl(poolsUrl(`/presets/${encodeURIComponent(id)}`), { method: 'DELETE', credentials: 'same-origin' });
      } catch {
        return { ok: false, message: 'Could not reach the server.' };
      }
      if (res.ok) return { ok: true };
      const body = await bodyOf(res);
      return { ok: false, message: `Could not delete that preset: ${serverMessage(body, res.status)}.` };
    },
  };
}
