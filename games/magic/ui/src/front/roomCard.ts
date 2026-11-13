/*
 * What a room's symbol card draws, derived from the room body alone (`docs/planning/wave77-2026-10-27.md`
 * §A: "Everything comes from the room body already on the wire"). Pure and framework-free on purpose —
 * `RoomList.tsx` and the banner's "Open seats now" page (`./wildcardItems.ts`, its seats) read it; the
 * derivation is the part worth testing directly, without mounting a component for every `gameType` ×
 * mode × phase combination.
 *
 * Draft pick numbers are NOT on the wire (the server never sends a pack or a pick), so `drafting`
 * carries no detail — showing the state without them is the brief's own instruction, not an omission.
 *
 * No tip text lives here (there used to be some, one per state and one per mode chip): the
 * operator, mid-wave, on the hover tooltips this card originally carried on every symbol — "i hate
 * all the tooltips, they all seem useless". The only tooltip the card still has (the room's own
 * name, shown in full when its ellipsis actually truncates it) needs no text computed here; it is
 * the name itself, and `RoomList.tsx` reads that straight off `room.name`.
 */

import { FREE_PICK, POD_MAX_SEATS, POD_SEATS, isPodAi, magicGame, planDisplayName, roomAiOf, type Look } from '@hadoku/shared';

import type { RoomView } from '../rooms/api.ts';
import { countdown } from '@hadoku/game-ui/front/countdown.ts';
import { formatEraLabel } from './formatLabel.ts';

export type RoomStateKey = 'lobby' | 'drafting' | 'building' | 'playing' | 'sideboarding' | 'rounds' | 'done';

export interface RoomCardState {
  key: RoomStateKey;
  label: string;
  /** One line, or none — "Game 2 · turn 7", "Round 2 of 3", "Waiting for players". */
  detail: string | null;
}

export interface RoomModeChip {
  /** Which mark the chip draws; `null` for a draft, which shows its cube instead (no mode icon). */
  icon: 'classic' | 'gauntlet' | 'random' | null;
  text: string;
}

export type RoomPrimaryAction = 'Join' | 'Watch';

/** One seat the card draws: who sits there (their face), or nobody. */
export type RoomCardSeat = { kind: 'taken'; id: string; name: string; avatarId: string | undefined; look: Look | undefined } | { kind: 'open' };

/** The most seats drawn; a bigger pod draws the seats it is filling now and counts the rest. */
const CARD_SEATS_MAX = POD_SEATS;

export interface RoomCardView {
  tournament: boolean;
  seatsFilled: number;
  seatsCapacity: number;
  /** The seats drawn, in seat order, at most `CARD_SEATS_MAX`. */
  seats: RoomCardSeat[];
  /** Taken seats not drawn (a pod past its first 8), shown as "+N". */
  seatsMore: number;
  /** Whether an open seat is a way in: the same press as Join. */
  seatJoinable: boolean;
  mode: RoomModeChip;
  /** Bo1 / Bo3 — `null` when the room has no table yet to read a series length from. */
  series: 'Bo1' | 'Bo3' | null;
  state: RoomCardState;
  primaryAction: RoomPrimaryAction;
  /** A second, explicit Watch button beside the primary one: the room is in progress (any state but Lobby/Done), or a Forge match is actually running. */
  extraWatch: boolean;
  /** Which background the card draws (`rooms.css`, `[data-family]`): the room's format family, or `draft`. */
  family: RoomFamily;
}

export type RoomFamily = 'standard' | 'modern' | 'legacy' | 'draft' | 'other';

/**
 * Whether this room is one of Magic's own two types. `@hadoku/shared`'s `magicGame()` already
 * answers `NO_MAGIC_GAME` (pod `null`, mode `null`, format `''`, …) for any other registered type
 * (bomberman, say) — a deliberate "never show Magic's fields for a game that is not Magic's"
 * refusal, not an accident. The consequence this file works around below: the SERVER already
 * computes a real `pod` for any `usesPod` room regardless of game (`room/pods.ts`'s `usesPod` asks
 * a registered type's OWN `seats.max`, not only `draft`), but the client-side `magicGame()` never
 * hands it back for a non-Magic room, so this file cannot read a non-Magic room's real seats or
 * capacity generically today. A platform room card is deliberately plainer for it instead: every
 * current member drawn as a filled seat, no claimed capacity above that. Showing a non-Magic
 * room's REAL growable capacity needs `magicGame()` (or the view itself) to stop refusing pod data
 * for a registered non-Magic type — flagged, not fixed, here (`magic-room.ts` is not this file's
 * to change, and the room view's Magic-copies migration already in flight is the more likely place
 * for it to land).
 */
function isMagicRoom(room: RoomView): boolean {
  return room.gameType === 'draft' || room.gameType === 'constructed-1v1';
}

/**
 * A room's format family: a draft is `draft`; a constructed room reads its Gauntlet era, its All Random
 * pool, or its own `format` id (`<family>-<date>` for Modern/Legacy, a bare date for Standard,
 * `formatLabel.ts`); anything else — Free pick, the full random pool — is `other`.
 */
export function roomFamily(room: RoomView): RoomFamily {
  if (room.gameType === 'draft') return 'draft';
  const fromId = (id: string | undefined): RoomFamily => {
    if (id === undefined || id === 'free') return 'other';
    if (id.startsWith('modern')) return 'modern';
    if (id.startsWith('legacy')) return 'legacy';
    return /^\d{4}-\d{2}-\d{2}$/.test(id) || id === 'standard' ? 'standard' : 'other';
  };
  const { mode, modeOptions, format } = magicGame(room);
  const options = modeOptions as { family?: string; pool?: string } | null;
  if (mode === 'gauntlet') return fromId(options?.family ?? 'standard');
  if (mode === 'random') return fromId(options?.pool);
  return fromId(format);
}

const STATE_LABEL: Readonly<Record<RoomStateKey, string>> = {
  lobby: 'Lobby',
  drafting: 'Drafting',
  building: 'Building',
  playing: 'Playing',
  sideboarding: 'Sideboarding',
  rounds: 'Rounds',
  done: 'Done',
};

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/** The mode chip: Classic/Gauntlet/All Random with their format or pool, or the draft's cube — no mode icon there. */
function modeChip(room: RoomView): RoomModeChip {
  // A non-Magic room has no mode to unset: the chip names the game itself instead of the
  // Magic-only "Mode unset" fallback below, which would otherwise read as a Magic room gone wrong.
  if (!isMagicRoom(room)) return { icon: null, text: capitalize(room.gameType) };
  const { pod, mode, modeOptions, format } = magicGame(room);
  if (room.gameType === 'draft') {
    const text = pod !== null && pod.plan !== null && pod.roundNames !== null ? planDisplayName(pod.plan, pod.roundNames) : 'Draft';
    return { icon: null, text };
  }
  if (mode === null) return { icon: null, text: 'Mode unset' };
  if (mode === 'classic') {
    // Ruling 5 (2026-10-27): a format era's id reads as a short label — "Standard 2018",
    // "Modern 2011", "Legacy 2011" — never its raw id. `formatEraLabel` is the one pure
    // formatter, tested on its own (`formatLabel.test.ts`).
    const text = format === FREE_PICK || format === '' ? 'Free pick' : formatEraLabel(format);
    return { icon: 'classic', text };
  }
  if (mode === 'gauntlet') {
    const opts = modeOptions as { family?: string; year?: number } | null;
    const text = [opts?.family === undefined ? null : capitalize(opts.family), opts?.year ?? null].filter((w) => w !== null).join(' ') || 'Any era';
    return { icon: 'gauntlet', text };
  }
  // 'random'
  const opts = modeOptions as { pool?: string } | null;
  const pool = opts?.pool ?? 'full';
  return { icon: 'random', text: pool === 'full' ? 'Full' : capitalize(pool) };
}

/** Bo1 / Bo3, read off the room's first table — every room has at least one once the server has sent it. */
function seriesLabel(room: RoomView): 'Bo1' | 'Bo3' | null {
  const table = room.tables[0];
  if (table === undefined) return null;
  return table.series.length === 3 ? 'Bo3' : 'Bo1';
}

/** Whether a Forge match is actually running anywhere in the room right now. */
function matchIsLive(room: RoomView): boolean {
  if (room.matchId !== null) return true;
  if (room.tableGames === undefined) return false;
  return Object.values(room.tableGames).some((g) => g.live !== null);
}

/**
 * A room made for an event (`scheduledFor`) reads "Scheduled · in 2d 3h" while it waits in its
 * lobby for the start; it is still a lobby to every action, so only what it says changes.
 */
function roomState(room: RoomView, now: number): RoomCardState {
  const state = phaseState(room);
  const startsAt = room.scheduledFor;
  if (state.key !== 'lobby' || startsAt === null || !(Date.parse(startsAt) > now)) return state;
  return { key: 'lobby', label: 'Scheduled', detail: countdown(startsAt, now) };
}

function phaseState(room: RoomView): RoomCardState {
  const { pod } = magicGame(room);
  // Ruling 9 (2026-10-27): "Waiting for players", not "Waiting for a player".
  const waitingForPlayers = room.members.length < 2;
  if (pod !== null) {
    if (pod.phase === 'lobby') return { key: 'lobby', label: STATE_LABEL.lobby, detail: waitingForPlayers ? 'Waiting for players' : null };
    if (pod.phase === 'drafting') return { key: 'drafting', label: STATE_LABEL.drafting, detail: null };
    if (pod.phase === 'building') return { key: 'building', label: STATE_LABEL.building, detail: null };
    if (pod.phase === 'rounds') return { key: 'rounds', label: STATE_LABEL.rounds, detail: pod.round > 0 ? `Round ${String(pod.round)} of ${String(pod.rounds)}` : null };
    return { key: 'done', label: STATE_LABEL.done, detail: null };
  }

  const table = room.tables[0];
  if (table === undefined) return { key: 'lobby', label: STATE_LABEL.lobby, detail: waitingForPlayers ? 'Waiting for players' : null };
  const phase = table.series.phase;
  const gameNo = table.series.games.length + 1;
  const live = room.tableGames?.[table.id]?.live ?? null;

  if (phase === 'seating') return { key: 'lobby', label: STATE_LABEL.lobby, detail: waitingForPlayers ? 'Waiting for players' : null };
  if (phase === 'playing') return { key: 'playing', label: STATE_LABEL.playing, detail: live === null ? `Game ${String(gameNo)}` : `Game ${String(gameNo)} · turn ${String(live.turn)}` };
  if (phase === 'sideboarding' || phase === 'between') return { key: 'sideboarding', label: STATE_LABEL.sideboarding, detail: `Game ${String(gameNo)} next` };
  return { key: 'done', label: STATE_LABEL.done, detail: null };
}

/**
 * The primary action and whether a second Watch belongs beside it.
 *
 * The operator (2026-10-27, ruling 7): *"an inprogress room should always have watch"* — every
 * state but Lobby and Done. `matchIsLive` stays as a second trigger alongside it rather than in
 * place of it: a room can carry a live `matchId` the moment it is announced, a tick before its
 * table's own series phase (and so this card's `state.key`) has caught up.
 */
function actions(room: RoomView, state: RoomCardState, isMine: boolean): { primaryAction: RoomPrimaryAction; extraWatch: boolean } {
  // A non-Magic room's real ceiling is not readable here yet (`isMagicRoom`'s own doc) — generous
  // rather than wrong: the server's own `sitPod`/`usesPod` is still what actually refuses an 11th.
  const seatOpen = state.key === 'lobby' && room.members.length < (!isMagicRoom(room) ? POD_MAX_SEATS : magicGame(room).pod !== null ? POD_MAX_SEATS : 2);
  // One way in, member or not (the operator, 2026-10-29: a separate button for each "seems pointless").
  const primaryAction: RoomPrimaryAction = isMine || seatOpen ? 'Join' : 'Watch';
  const inProgress = state.key !== 'lobby' && state.key !== 'done';
  const extraWatch = (inProgress || matchIsLive(room)) && primaryAction !== 'Watch';
  return { primaryAction, extraWatch };
}

/**
 * The seats a card counts out of. A pod room past 8 drafts as several pods of up to 8 (`POD_MAX_SEATS` in
 * all), so it counts the pod now filling: 5 of 8, 8 of 16, and 64 of 64 once it is full.
 */
function seatsCapacity(room: RoomView): number {
  // The platform card: every member drawn as filled, no claimed capacity above that (`isMagicRoom`'s own doc).
  if (!isMagicRoom(room)) return room.members.length;
  if (magicGame(room).pod === null) return 2;
  return Math.min(POD_MAX_SEATS, Math.max(POD_SEATS, Math.ceil((room.members.length + 1) / POD_SEATS) * POD_SEATS));
}

/**
 * Who sits where. A 1v1 room's table players and its open seats; a pod in its lobby, its own seat
 * order. A pod past its lobby clears its seats, so it draws its members. Past `CARD_SEATS_MAX`, the
 * window the pod is filling now (its last 8 of `capacity`), and the taken seats before it as a count.
 */
function cardSeats(room: RoomView, capacity: number): { seats: RoomCardSeat[]; seatsMore: number } {
  const ai = roomAiOf(room);
  const member = (id: string, name: string, avatarId?: string): RoomCardSeat => {
    if (isPodAi(id)) return { kind: 'taken', id, name: ai?.name ?? name, avatarId: avatarId ?? ai?.avatarId, look: undefined };
    const m = room.members.find((x) => x.id === id);
    return { kind: 'taken', id, name: m?.name ?? name, avatarId: m?.avatarId ?? avatarId, look: m?.look };
  };
  const open: RoomCardSeat = { kind: 'open' };
  if (!isMagicRoom(room)) {
    // The platform card: every member is a filled seat (no open-seat concept drawn generically yet,
    // `isMagicRoom`'s own doc) — "faces", not Magic's table/pod split.
    const all = room.members.map((m) => member(m.id, m.name, m.avatarId));
    if (all.length <= CARD_SEATS_MAX) return { seats: all, seatsMore: 0 };
    return { seats: all.slice(0, CARD_SEATS_MAX), seatsMore: all.length - CARD_SEATS_MAX };
  }
  const { pod } = magicGame(room);
  let all: RoomCardSeat[];
  if (pod === null) {
    // The host first, as the room's link preview draws it (`games/magic/server/src/http/preview.ts`): host vs the other seat.
    const host = room.leader || room.creator;
    const players = [...(room.tables[0]?.players ?? [])].sort((a, b) => Number(b.memberId === host) - Number(a.memberId === host));
    all = Array.from({ length: capacity }, (_, i) => {
      const p = players[i];
      return p === undefined ? open : member(p.memberId, p.name);
    });
  } else if (pod.phase === 'lobby') {
    all = Array.from({ length: capacity }, (_, i) => {
      const s = pod.seats[i] ?? null;
      return s === null ? open : member(s.memberId, s.name, s.avatarId);
    });
  } else {
    all = room.members.map((m) => member(m.id, m.name));
  }
  if (all.length <= CARD_SEATS_MAX) return { seats: all, seatsMore: 0 };
  const from = pod?.phase === 'lobby' ? all.length - CARD_SEATS_MAX : 0;
  const seats = all.slice(from, from + CARD_SEATS_MAX);
  return { seats, seatsMore: all.filter((s) => s.kind === 'taken').length - seats.filter((s) => s.kind === 'taken').length };
}

/** Everything one room card draws, from the room body alone. `isMine`: the caller is already a member. */
export function roomCardView(room: RoomView, isMine: boolean, now: number = Date.now()): RoomCardView {
  const state = roomState(room, now);
  const capacity = seatsCapacity(room);
  const { primaryAction, extraWatch } = actions(room, state, isMine);
  return {
    tournament: room.gameType === 'draft' || room.settings.tournament,
    seatsFilled: room.members.length,
    seatsCapacity: capacity,
    ...cardSeats(room, capacity),
    seatJoinable: state.key === 'lobby' && primaryAction === 'Join',
    mode: modeChip(room),
    // Bo1/Bo3 is Magic's own match-length jargon; a non-Magic room shows no series chip at all.
    series: isMagicRoom(room) ? seriesLabel(room) : null,
    state,
    primaryAction,
    extraWatch,
    family: roomFamily(room),
  };
}
