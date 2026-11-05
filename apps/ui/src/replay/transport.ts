/*
 * The replay HTTP client — contract 2 of wave 77's plan
 * (`docs/planning/wave77-2026-10-27.md`), the server half lane C builds in
 * parallel (`apps/server/src/http/replays.ts`).
 *
 *   GET /api/replays?limit=N       → { replays: [{ matchId, roomId, players,
 *                                      decks, startedAt, endedAt, winner, source }] }
 *   GET /api/replays/:matchId      → { header, envs: [{ at, env }], presence: [{ at, seat, playerId, presence }], end }
 *
 * `header`/`envs`/`end` mirror the recording's own three line kinds
 * (contract 1): a header, one `env` per frame the watcher channel emitted
 * (already a `ServerEnvelope` — `../play/live/transport.ts`'s own type, the
 * SAME shape `forge:s2c` carries), and an end. Every `env.env` is parsed
 * through `parseServerEnvelope`, the same function `match.ts`'s `ingest`
 * uses, so a malformed entry is dropped here rather than crashing the fold
 * later — a recording this client did not write is not assumed trustworthy.
 * A `presence` entry is the active seat's pointer (wave 81 part 2), checked by the same
 * `PresenceSchema` a live board's own messages are.
 *
 * This file does not know how the frames get INTO a board: that is
 * `./player.ts`, which folds `ReplayData` into a read-only board, paced.
 */

import { safeParseServerFrame } from '@hadoku/forge-wire';
import { z } from 'zod';
import { ArtCardSchema, PersonFaceSchema, PresenceSchema, type ArtCard, type PersonFace, type PresenceMessage } from '@hadoku/shared';

import { apiUrl, bodyOf, getJson, isRecord, sendJson, serverMessage, type Fetch } from '../http.ts';
import { parseServerEnvelope, type ServerEnvelope } from '../play/live/transport.ts';

/**
 * Whether the front page links to replays at all. Off from 2026-10-28 (the operator: "disable the
 * replay feature for now until we make it properly working") until wave 81 rebuilt the player.
 */
export const REPLAYS_ON = true;

/** The recorded public stream's header line (contract 1), as contract 2 serves it back. */
export interface ReplayHeader {
  matchId: string;
  roomId: string | null;
  /** Seat order: `[seat 0, seat 1]`. */
  players: readonly [string, string];
  ai: readonly [boolean, boolean];
  decks: readonly unknown[];
  /** Every card the match's decks name: what a replay warms. Empty for a header that names none. */
  art: readonly ArtCard[];
  startedAt: string;
}

/** One seat of the end line's roster: what `forge:seats` tells a live board about faces. */
export interface RecordedSeat {
  seat: number;
  claimed: boolean;
  playerId: number | null;
  avatarId?: string;
}

/** The recorded public stream's end line, or `null` for a replay of a match still in progress. */
export interface ReplayEnd {
  endedAt: string;
  winner: 0 | 1 | null;
  /** Empty for a recording made before the roster was kept: its players are drawn without avatars. */
  seats: readonly RecordedSeat[];
}

/** One line of the recording's `env` kind, timestamped from the match's own start. */
export interface RecordedEnv {
  /** Milliseconds since `header.startedAt`. */
  at: number;
  env: ServerEnvelope;
}

/** One recorded pointer message of the seat whose turn it was, timestamped like `RecordedEnv`. */
export interface RecordedPresence {
  at: number;
  seat: number;
  /** That seat's Forge player: the replay draws its cursor only while its player is at the bottom. */
  playerId: number;
  presence: PresenceMessage;
}

/** `GET /api/replays/:matchId`'s body, parsed and ready to drive a `MatchTransport`. */
export interface ReplayData {
  header: ReplayHeader;
  /** Oldest first. `fetchReplay` sorts defensively; a well-formed recording is already in order. */
  envs: readonly RecordedEnv[];
  /** Oldest first. Empty for a recording made before pointers were kept. */
  presence: readonly RecordedPresence[];
  end: ReplayEnd | null;
  /**
   * Who played, by seat, as they are now (`GET /api/replays/:id/people`): their name, character and
   * look. Empty when nobody could be looked up; the replay then draws what it recorded.
   */
  people?: Readonly<Record<number, ReplayPerson>>;
}

/** One seat's holder as the people route answers: absent fields are what the recording kept. */
export type ReplayPerson = PersonFace & { name?: string };

const ReplayPeopleSchema = z.object({ people: z.record(z.string(), PersonFaceSchema.extend({ name: z.string().min(1).optional().catch(undefined) }).nullable().catch(null)) });

/**
 * A replay's people. Asked beside the replay, not inside it: the replay's body is cached for good,
 * and who someone is now is not. Any failure is no people, never a replay that will not load.
 */
export async function fetchReplayPeople(matchId: string, fetchImpl: Fetch = defaultFetch): Promise<Record<number, ReplayPerson>> {
  try {
    const res = await getJson(apiUrl(`replays/${encodeURIComponent(matchId)}/people`), fetchImpl);
    if (!res.ok) return {};
    const parsed = ReplayPeopleSchema.safeParse(await bodyOf(res));
    if (!parsed.success) return {};
    const out: Record<number, ReplayPerson> = {};
    for (const [seat, person] of Object.entries(parsed.data.people)) if (person !== null && /^\d+$/.test(seat)) out[Number(seat)] = person;
    return out;
  } catch {
    return {};
  }
}

/** One row of `GET /api/replays`'s list — enough to link a replay, never its frames. */
export interface ReplayListing {
  matchId: string;
  roomId: string | null;
  players: readonly [string, string];
  decks: readonly unknown[];
  startedAt: string;
  endedAt: string | null;
  winner: 0 | 1 | null;
  /** `'stream'`: the public stream is still on disk. `'rebuild'`: gone, but D's rebuild can make it again. `'none'`: neither. */
  source: 'stream' | 'rebuild' | 'none';
  /** How busy the recording is (`@hadoku/shared`'s `ReplayPace`); null when the server did not measure it. */
  pace: { envs: number; durationMs: number; waitMs: number } | null;
}

function isPair<T>(v: unknown, isT: (x: unknown) => x is T): v is readonly [T, T] {
  return Array.isArray(v) && v.length === 2 && isT(v[0]) && isT(v[1]);
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

/** `null` on anything that is not a well-formed header — a server bug, not this viewer's to recover from. */
function parseHeader(v: unknown): ReplayHeader | null {
  if (!isRecord(v)) return null;
  const { matchId, roomId, players, ai, decks, art, startedAt } = v;
  if (!isString(matchId) || matchId === '') return null;
  if (!isPair(players, isString)) return null;
  if (!isPair(ai, isBoolean)) return null;
  if (!Array.isArray(decks)) return null;
  if (!isString(startedAt)) return null;
  const cards = Array.isArray(art) ? art.flatMap((c) => (ArtCardSchema.safeParse(c).success ? [c as ArtCard] : [])) : [];
  return { matchId, roomId: isString(roomId) ? roomId : null, players, ai, decks, art: cards, startedAt };
}

const isSeatNumber = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** `null` drops the seat: a roster entry is a face, never worth refusing the whole replay over. */
function parseSeat(v: unknown): RecordedSeat | null {
  if (!isRecord(v)) return null;
  const { seat, claimed, playerId, avatarId } = v;
  if (!isSeatNumber(seat) || !isBoolean(claimed)) return null;
  if (playerId !== null && !isSeatNumber(playerId)) return null;
  return { seat, claimed, playerId, ...(isString(avatarId) ? { avatarId } : {}) };
}

function parseEnd(v: unknown): ReplayEnd | null {
  if (!isRecord(v)) return null;
  const { endedAt, winner, seats } = v;
  if (!isString(endedAt)) return null;
  if (winner !== 0 && winner !== 1 && winner !== null) return null;
  const roster = Array.isArray(seats) ? seats.flatMap((s) => parseSeat(s) ?? []) : [];
  return { endedAt, winner, seats: roster };
}

/**
 * One `{at, env}` entry. `null` drops it — see this file's header on why a
 * bad entry is dropped, not thrown. `parseServerEnvelope` alone leaves `frame`
 * unchecked (it is the two-stage parse `match.ts`'s `ingest` uses, checking
 * the frame only once the cursor says to apply it) — a frame this client
 * never plays live still needs checking NOW, since nothing re-checks it later.
 */
function parseRecordedEnv(v: unknown): RecordedEnv | null {
  if (!isRecord(v)) return null;
  const { at, env } = v;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const envelope = parseServerEnvelope(env);
  if (!envelope.ok) return null;
  const frame = safeParseServerFrame(envelope.value.frame);
  if (!frame.ok) return null;
  return { at, env: { ...envelope.value, frame: frame.value } };
}

function parseRecordedPresence(v: unknown): RecordedPresence | null {
  if (!isRecord(v)) return null;
  const { at, seat, playerId, presence } = v;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  if (!Number.isInteger(seat) || !Number.isInteger(playerId)) return null;
  const parsed = PresenceSchema.safeParse(presence);
  return parsed.success ? { at, seat: seat as number, playerId: playerId as number, presence: parsed.data } : null;
}

/** `null` on anything this client cannot use as a replay — a 404, a malformed body, a network error. */
export function parseReplayData(body: unknown): ReplayData | null {
  if (!isRecord(body)) return null;
  const header = parseHeader(body.header);
  if (header === null) return null;
  if (!Array.isArray(body.envs)) return null;
  const envs = body.envs.map(parseRecordedEnv).filter((e): e is RecordedEnv => e !== null);
  const sorted = [...envs].sort((a, b) => a.at - b.at);
  const presence = (Array.isArray(body.presence) ? body.presence : [])
    .map(parseRecordedPresence)
    .filter((p): p is RecordedPresence => p !== null)
    .sort((a, b) => a.at - b.at);
  const end = body.end === null || body.end === undefined ? null : parseEnd(body.end);
  // Nobody is looked up from the body itself: `fetchReplay` asks for the people beside it.
  return { header, envs: sorted, presence, end };
}

function parseSource(v: unknown): ReplayListing['source'] {
  return v === 'stream' || v === 'rebuild' ? v : 'none';
}

function parsePace(v: unknown): ReplayListing['pace'] {
  if (!isRecord(v)) return null;
  const { envs, durationMs, waitMs } = v;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  return ok(envs) && ok(durationMs) && ok(waitMs) ? { envs, durationMs, waitMs } : null;
}

function parseListing(v: unknown): ReplayListing | null {
  if (!isRecord(v)) return null;
  const { matchId, roomId, players, decks, startedAt, endedAt, winner, source, pace } = v;
  if (!isString(matchId) || matchId === '') return null;
  if (!isPair(players, isString)) return null;
  if (!Array.isArray(decks)) return null;
  if (!isString(startedAt)) return null;
  if (winner !== 0 && winner !== 1 && winner !== null) return null;
  return {
    matchId,
    roomId: isString(roomId) ? roomId : null,
    players,
    decks,
    startedAt,
    endedAt: isString(endedAt) ? endedAt : null,
    winner,
    source: parseSource(source),
    pace: parsePace(pace),
  };
}

const defaultFetch: Fetch = (i, init) => fetch(i, init);

/** `GET /api/replays?limit=N`, newest first — whatever the server sent, in its own order. */
export async function fetchReplays(limit: number, fetchImpl: Fetch = defaultFetch): Promise<ReplayListing[]> {
  let res: Response;
  try {
    res = await getJson(apiUrl(`replays?limit=${encodeURIComponent(String(limit))}`), fetchImpl);
  } catch {
    throw new Error('Could not reach the server.');
  }
  const body = await bodyOf(res);
  if (!res.ok) throw new Error(`Could not load the replays: ${serverMessage(body, res.status)}.`);
  if (!isRecord(body) || !Array.isArray(body.replays)) {
    throw new Error('Could not load the replays: the server sent something that is not a replay list.');
  }
  return body.replays.map(parseListing).filter((r): r is ReplayListing => r !== null);
}

/** The most the server lists (`MAX_LIST_LIMIT` in the server's `http/replays.ts`). */
const RANDOM_POOL = 100;

/** Fewer frames, or a shorter span, than this is a game abandoned at the start, not one to watch. */
const MIN_GAME_ENVS = 100;
const MIN_GAME_MS = 60_000;

/** A whole game, with its pace measured. */
function isGame(r: ReplayListing): boolean {
  return r.pace !== null && r.pace.envs >= MIN_GAME_ENVS && r.pace.durationMs >= MIN_GAME_MS;
}

/**
 * How strongly a game is preferred: things happening per minute, times the share of the game nobody
 * was waiting, squared so the busiest games are clearly likelier than the slowest ones.
 */
export function replayWeight(r: ReplayListing): number {
  if (r.pace === null || r.pace.durationMs <= 0) return 1;
  const minutes = r.pace.durationMs / 60_000;
  const active = 1 - Math.min(r.pace.waitMs, r.pace.durationMs) / r.pace.durationMs;
  return ((r.pace.envs / minutes) * active) ** 2;
}

/** One of `pool`, each as likely as its weight. */
function weightedPick(pool: readonly ReplayListing[], random: () => number): ReplayListing | null {
  const weights = pool.map(replayWeight);
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return pool[Math.floor(random() * pool.length)] ?? null;
  let left = random() * total;
  for (let i = 0; i < pool.length; i++) {
    left -= weights[i]!;
    if (left < 0) return pool[i]!;
  }
  return pool[pool.length - 1] ?? null;
}

/**
 * One of the newest replays, at random, or `null` when there is none yet. Busy games — many things
 * happening, little waiting — are likelier ({@link replayWeight}); a game abandoned at the start is
 * taken only when there is nothing else, as is one the server would have to rebuild, which costs it a
 * game's worth of work.
 */
export async function fetchRandomReplay(fetchImpl: Fetch = defaultFetch, random: () => number = Math.random): Promise<ReplayListing | null> {
  const listed = await fetchReplays(RANDOM_POOL, fetchImpl);
  const streams = listed.filter((r) => r.source === 'stream');
  const games = streams.filter(isGame);
  return weightedPick(games.length > 0 ? games : streams.length > 0 ? streams : listed, random);
}

/** `GET /api/replays/:matchId`. `null` on the server's 404 (no stream, and `rebuild` could not make one); throws on anything else. */
export async function fetchReplay(matchId: string, fetchImpl: Fetch = defaultFetch): Promise<ReplayData | null> {
  let res: Response;
  try {
    res = await getJson(apiUrl(`replays/${encodeURIComponent(matchId)}`), fetchImpl);
  } catch {
    throw new Error('Could not reach the server.');
  }
  if (res.status === 404) return null;
  const people = fetchReplayPeople(matchId, fetchImpl);
  const body = await bodyOf(res);
  if (!res.ok) throw new Error(`Could not load the replay: ${serverMessage(body, res.status)}.`);
  const data = parseReplayData(body);
  if (data === null) throw new Error('The server sent something that is not a replay.');
  return { ...data, people: await people };
}

export type ReplayTrouble = 'load-failed' | 'player-error';

/** A replay this viewer could not play, told to the server log (`POST /api/replays/report`): the page shows nothing. */
export function reportReplayTrouble(what: ReplayTrouble, matchId: string | null, detail: Record<string, unknown>, fetchImpl: Fetch = defaultFetch): void {
  void sendJson(apiUrl('replays/report'), 'POST', { what, matchId, ui: __HADOKU_UI_VERSION__, detail }, fetchImpl, { keepalive: true }).catch((err: unknown) =>
    console.warn('[replay] could not report', what, err),
  );
}
