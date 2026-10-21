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
 *
 * ## The client mode is the ROOM's, and a missing one is `builtin`
 *
 * D19a: which client a room's players sit in front of is chosen once, at
 * create, and never again. `parseRoomView` therefore treats anything that is
 * not exactly `'streamed'` — absent, misspelled, a number, a server older than
 * this field — as `'builtin'`. That direction is deliberate: rendering our own
 * table for a room that turns out to be streamed is a wrong-looking screen,
 * while rendering stream frames for a room nobody provisioned containers for
 * is a page of dead iframes pointed at a route that does not exist.
 *
 * ## Readiness is the ROOM's, and a draft is what it starts (w23)
 *
 * A draft used to be a separate object with a client-minted id, dealt the
 * moment a socket connected. It is a room now, so two fields carry the whole
 * difference: `RoomMember.ready`, which every member has to set before the
 * draft is dealt, and `RoomView.draftStartedAt`, which is null for the whole
 * lobby phase and an ISO string once the server has dealt the pod.
 *
 * Both are parsed the same defensive direction as `clientMode`: a server that
 * predates them sends neither, `ready` reads as `false` and `draftStartedAt` as
 * `null`, so an older server's room renders as a lobby nobody has readied in
 * rather than as a pod with no cards behind it. `draftStartedAt` is also never
 * restored from disk (`lobby.ts`), which is why a restart mid-draft puts the
 * room back in this state and the room screen says so in words.
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
 * browser it owns the table's settings, because `leader` is a hashed
 * participant id no client can derive. Both fields default FALSE and `format`
 * defaults to the empty string, which is the same discipline as `clientMode`:
 * an older server, or a body that lost the field, leaves nobody in charge and
 * the room screen falls back to the newest pool rather than pretending to know
 * one.
 */

import {
  RoomTablesSchema,
  RoomPodSchema,
  RoomModeSchema,
  DEFAULT_MATCH_LENGTH,
  type ConstructedMode,
  type GameType,
  type MatchLength,
  type ModeOptions,
  type RoomMode,
  type RoomPod,
  type RoomTable,
} from '@hadoku/shared';

import { apiBase } from '../screens/tables.ts';
import { normalizeAvatarId } from '../room/avatar.ts';

export type { GameType };

/**
 * Which client a room's players sit in front of. The server's own
 * `room/lobby.ts` owns this type too; it is written down again here because
 * the wire is the contract.
 */
export type ClientMode = 'builtin' | 'streamed';

export interface RoomMember {
  id: string;
  name: string;
  joinedAt: string;
  /** The room's readiness, which is what a draft starts on. Missing ⇒ false. */
  ready: boolean;
  /**
   * The character this member picked in watchparty's room, when they have one.
   *
   * **Absent or a non-blank string — never `null`, never `''`.** The server folds
   * all three of `avatarId`'s upstream states into those two before it answers
   * (`apps/server/src/room/lobby.ts`'s `avatarIdOf`), and `parseMember` folds
   * them again here, so a consumer's fallback is one `=== undefined` check.
   * `room/avatar.ts` turns it into a URL.
   */
  avatarId?: string;
}

/**
 * What the CALLER is in this room, which nothing else in the view can say.
 *
 * `leader` compared against `RoomView.leader` is not a question a browser can
 * answer: the leader is a hashed participant id and no client holds its own. So
 * the server answers it per caller, and `ready` comes with it — a reload while
 * ready used to relabel the Ready button, because the only thing that knew was
 * a latch set by our own call (wave 23's known gap).
 */
export interface RoomYou {
  /** My member id in this room, as the server names me — `''` from a server that does not say. Never whoami's id, which can differ (an admin session). */
  id: string;
  leader: boolean;
  ready: boolean;
}

export interface RoomView {
  id: string;
  name: string;
  creator: string;
  leader: string;
  /** Kept as a string: a type the server adds later is shown, not dropped. */
  gameType: string;
  /**
   * The table's pool — a `TableFormat.id`, the rules BOTH seats are checked
   * against, and the leader's to change. Empty only when the server did not
   * send one, which the room screen reads as "fall back to the newest pool".
   */
  format: string;
  /** How the room's matches are dealt; the leader's to change (`setSettings`). */
  settings: RoomSettings;
  /**
   * A constructed room's mode, null until the leader chooses one (`setRoomMode`)
   * and for a draft room. `modeOptions` is null exactly when `mode` is; a pair
   * this build does not know reads as unchosen.
   */
  mode: ConstructedMode | null;
  modeOptions: ModeOptions | null;
  /** Caller-scoped. Both halves default false; see the header. */
  you: RoomYou;
  /** Fixed at create, for the room's whole life. Missing on the wire ⇒ builtin. */
  clientMode: ClientMode;
  locked: boolean;
  members: RoomMember[];
  matchId: string | null;
  /**
   * When the draft was dealt, or null for the whole lobby phase. Never
   * restored from disk, so a restart mid-draft reads as null here.
   */
  draftStartedAt: string | null;
  createdAt: string;
  /**
   * The room's tables (wave 71 §D's wire contract), parsed through
   * `@hadoku/shared`'s own `RoomTablesSchema` rather than a hand-written
   * stand-in — a room always carries at least one, so a body this fails to
   * parse (an old server, a malformed one) reads as none rather than a
   * guessed single table nobody asked for.
   *
   * `MatchScreen.tsx` used to read this off the room's raw body a second
   * time, past this parser, because it did not carry the field yet (wave 71
   * §G's own note); wave 72 §Q closes that gap here.
   */
  tables: RoomTable[];
  /**
   * The room's pod, or null for a constructed room (`@hadoku/shared`'s own
   * `RoomPod` — `packages/shared/src/pod.ts`, landed wave 72 §P). Parsed
   * through `RoomPodSchema`, so a body that fails to parse (an old server,
   * a malformed one) reads as `null` rather than a guessed phase.
   */
  pod: RoomPod;
}

/**
 * The types the create form offers, and whether it lets you pick them. Draft
 * was offered but not pickable from 2026-10-10 to 2026-10-17 (the operator:
 * *"make 'Draft' unselectable … and add a "(Coming Soon)" behind it"*). The
 * glue that was missing — building a deck from the pool and playing it — now
 * exists, so both types are pickable.
 */
export const GAME_TYPES: readonly { value: GameType; label: string; ready: boolean }[] = [
  { value: 'constructed-1v1', label: 'Constructed 1v1', ready: true },
  { value: 'draft', label: 'Draft', ready: true },
];

export function gameTypeLabel(gameType: string): string {
  if (gameType === 'constructed-1v1') return 'Constructed 1v1';
  if (gameType === 'draft') return 'Draft';
  return gameType;
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
export function streamRoot(roomId: string, seat: number, base: string = defaultAppBase()): string {
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
export function streamPath(roomId: string, seat: number, base: string = defaultAppBase()): string {
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

/** The server's own id rule — the same one `roomKeyFor` enforces. */
const ROOM_ID = /^[a-z0-9-]{1,40}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseMember(v: unknown): RoomMember | null {
  if (!isRecord(v)) return null;
  const { id, name, joinedAt, ready, avatarId } = v;
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  // `ready === true` and nothing else: an absent flag, a string, a 1 all read
  // as not ready, so the only way to be counted towards a draft start is for
  // the server to have said so in a boolean.
  const member: RoomMember = {
    id,
    name,
    joinedAt: typeof joinedAt === 'string' ? joinedAt : '',
    ready: ready === true,
  };
  // Parsed through the same two-state rule the server answers with, and
  // ASSIGNED CONDITIONALLY: `avatarId: normalizeAvatarId(...) ?? undefined`
  // would put the key on every member, so the absent case would no longer be
  // absent for an in-process reader. A server that sent `null`, `''` or a
  // 33-character id leaves the field off rather than reaching a face.
  const avatar = normalizeAvatarId(avatarId);
  if (avatar !== null) member.avatarId = avatar;
  return member;
}

/**
 * The room's client mode, as read off the wire.
 *
 * Only the exact string `'streamed'` makes a streamed room. Everything else —
 * absent, `null`, `'Streamed'`, a server that predates the field — is
 * `'builtin'`. See the header: this is the control that stops an older server
 * rendering as streamed, and it is asserted directly in `rooms.test.ts`.
 */
function parseClientMode(v: unknown): ClientMode {
  return v === 'streamed' ? 'streamed' : 'builtin';
}

/**
 * What the caller is, read strictly.
 *
 * `=== true` and nothing else, the same rule `parseMember` uses for `ready`: the
 * only way a browser draws the leader's controls is for the server to have said
 * so in a boolean. A missing `you` leaves nobody in charge, which costs the
 * leader a control and costs nobody a wrong one.
 */
function parseYou(v: unknown): RoomYou {
  const o = isRecord(v) ? v : {};
  return { id: typeof o.id === 'string' ? o.id : '', leader: o.leader === true, ready: o.ready === true };
}

/**
 * The room's match settings, as `room/lobby.ts`'s `RoomSettings` states them.
 * A setting the body does not carry reads as the server's own default.
 */
export interface RoomSettings {
  /** The opening hand nearer the deck's land ratio, and each mulligan weighted toward it. On by default. */
  handSmoothing: boolean;
  /** Best-of-one (default) or forced-rematch best-of-three. The leader's to change (`setSettings`). */
  matchLength: MatchLength;
  /**
   * Sideboarding between games. The server's own rule (`lobby.ts`'s
   * `effectiveSideboarding`): a `bo3` room reads `true` here no matter what
   * is stored, because bo3 implies it; `bo1` reads whatever was set, off by
   * default.
   */
  sideboarding: boolean;
}

function parseSettings(v: unknown): RoomSettings {
  const o = isRecord(v) ? v : {};
  const matchLength: MatchLength = o.matchLength === 'bo3' ? 'bo3' : DEFAULT_MATCH_LENGTH;
  return {
    handSmoothing: o.handSmoothing !== false,
    matchLength,
    sideboarding: matchLength === 'bo3' ? true : o.sideboarding === true,
  };
}

/** `RoomView.tables`, or none when the body does not carry a parseable list — see the field's own note. */
function parseTables(v: unknown): RoomTable[] {
  const parsed = RoomTablesSchema.safeParse(v);
  return parsed.success ? parsed.data : [];
}

/** `RoomView.pod`, or none when the body does not carry a parseable one — see the field's own note. */
function parsePod(v: unknown): RoomPod {
  const parsed = RoomPodSchema.safeParse(v ?? null);
  return parsed.success ? parsed.data : null;
}

function parseMode(mode: unknown, modeOptions: unknown): Pick<RoomView, 'mode' | 'modeOptions'> {
  const parsed = RoomModeSchema.safeParse({ mode, modeOptions });
  return parsed.success ? parsed.data : { mode: null, modeOptions: null };
}

/** A RoomView, or null when the body is not one. */
export function parseRoomView(v: unknown): RoomView | null {
  if (!isRecord(v)) return null;
  const { id, name, creator, leader, gameType, format, settings, mode, modeOptions, you, clientMode, locked, members, matchId, draftStartedAt, createdAt, tables, pod } = v;
  if (typeof id !== 'string' || !ROOM_ID.test(id)) return null;
  if (typeof name !== 'string' || typeof gameType !== 'string' || typeof locked !== 'boolean') return null;
  if (!Array.isArray(members)) return null;
  return {
    id,
    name,
    creator: typeof creator === 'string' ? creator : '',
    leader: typeof leader === 'string' ? leader : '',
    gameType,
    format: typeof format === 'string' ? format : '',
    settings: parseSettings(settings),
    ...parseMode(mode, modeOptions),
    you: parseYou(you),
    clientMode: parseClientMode(clientMode),
    locked,
    members: members.map(parseMember).filter((m): m is RoomMember => m !== null),
    matchId: typeof matchId === 'string' ? matchId : null,
    draftStartedAt: typeof draftStartedAt === 'string' ? draftStartedAt : null,
    createdAt: typeof createdAt === 'string' ? createdAt : '',
    tables: parseTables(tables),
    pod: parsePod(pod),
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
  /**
   * Deal the draft. Any member may ask — like constructed, where either browser
   * may start the match and the server answers one start to both — and asking
   * twice is not an error: a room whose draft has already started answers with
   * its view.
   */
  start(roomId: string): Promise<RoomOutcome>;
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

function defaultAppBase(): string {
  const base = import.meta.env?.BASE_URL;
  return typeof base === 'string' ? base : '/';
}

function defaultApiBase(): string {
  return apiBase(defaultAppBase());
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export function roomsClient(
  fetchImpl: Fetch = (i, init) => fetch(i, init),
  base: string = defaultApiBase(),
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
  const write = async (
    path: string,
    payload: unknown,
    whatFailed: string,
    method: 'POST' | 'PATCH' = 'POST',
  ): Promise<RoomOutcome> => {
    let res: Response;
    try {
      res = await fetchImpl(url(path), {
        method,
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        body: JSON.stringify(payload),
      });
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
      res = await fetchImpl(url(path), { credentials: 'same-origin' });
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

    get(roomId) {
      return read(`/${encodeURIComponent(roomId)}`);
    },

    roomOfMatch(matchId) {
      return read(`/of-match/${encodeURIComponent(matchId)}`);
    },

    async create(req) {
      const payload: Record<string, unknown> = { name: req.name, gameType: req.gameType, clientMode: req.clientMode };
      if (req.password !== undefined && req.password !== '') payload.password = req.password;
      if (req.mode !== undefined) Object.assign(payload, req.mode);
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

    ready(roomId, ready) {
      return write(`/${encodeURIComponent(roomId)}/ready`, { ready }, 'Could not change your readiness');
    },

    leave(roomId) {
      return write(`/${encodeURIComponent(roomId)}/leave`, {}, 'Could not leave the room');
    },

    async close(roomId) {
      let res: Response;
      try {
        res = await fetchImpl(url(`/${encodeURIComponent(roomId)}/close`), { method: 'POST', credentials: 'same-origin', headers: JSON_HEADERS, body: '{}' });
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

    start(roomId) {
      return write(`/${encodeURIComponent(roomId)}/start`, {}, 'Could not start the draft');
    },

    bindWatchparty(watchpartyRoom) {
      return write('/watchparty', { room: watchpartyRoom }, 'Could not open this room’s table');
    },
    setAvatar(roomId, avatarId) {
      return write(`/${encodeURIComponent(roomId)}/identity`, { avatarId }, 'Could not set your avatar');
    },
  };
}
