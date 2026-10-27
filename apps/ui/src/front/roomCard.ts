/*
 * What a room's symbol card draws, derived from the room body alone (`docs/planning/wave77-2026-10-27.md`
 * §A: "Everything comes from the room body already on the wire"). Pure and framework-free on purpose —
 * `RoomList.tsx` is the only reader, but the derivation is the part worth testing directly, without
 * mounting a component for every `gameType` × mode × phase combination.
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

import { FREE_PICK, POD_SEATS, planDisplayName } from '@hadoku/shared';

import type { RoomView } from '../rooms/api.ts';
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

export type RoomPrimaryAction = 'Sit down' | 'Join' | 'Watch';

export interface RoomCardView {
  tournament: boolean;
  seatsFilled: number;
  seatsCapacity: number;
  mode: RoomModeChip;
  /** Bo1 / Bo3 — `null` when the room has no table yet to read a series length from. */
  series: 'Bo1' | 'Bo3' | null;
  state: RoomCardState;
  primaryAction: RoomPrimaryAction;
  /** A second, explicit Watch button beside the primary one: the room is in progress (any state but Lobby/Done), or a Forge match is actually running. */
  extraWatch: boolean;
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
  if (room.gameType === 'draft') {
    const pod = room.pod;
    const text = pod !== null && pod.plan !== null && pod.roundNames !== null ? planDisplayName(pod.plan, pod.roundNames) : 'Draft';
    return { icon: null, text };
  }
  if (room.mode === null) return { icon: null, text: 'Mode unset' };
  if (room.mode === 'classic') {
    // Ruling 5 (2026-10-27): a format era's id reads as a short label — "Standard 2018",
    // "Modern 2011", "Legacy 2011" — never its raw id. `formatEraLabel` is the one pure
    // formatter, tested on its own (`formatLabel.test.ts`).
    const text = room.format === FREE_PICK || room.format === '' ? 'Free pick' : formatEraLabel(room.format);
    return { icon: 'classic', text };
  }
  if (room.mode === 'gauntlet') {
    const opts = room.modeOptions as { family?: string; era?: string } | null;
    const text = opts?.family !== undefined ? capitalize(opts.family) : opts?.era !== undefined && opts.era !== '' ? formatEraLabel(opts.era) : 'Any era';
    return { icon: 'gauntlet', text };
  }
  // 'random'
  const opts = room.modeOptions as { pool?: string } | null;
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

function roomState(room: RoomView): RoomCardState {
  const pod = room.pod;
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
  const capacity = room.pod !== null ? POD_SEATS : 2;
  const seatOpen = state.key === 'lobby' && room.members.length < capacity;
  const primaryAction: RoomPrimaryAction = isMine ? 'Join' : seatOpen ? 'Sit down' : 'Watch';
  const inProgress = state.key !== 'lobby' && state.key !== 'done';
  const extraWatch = (inProgress || matchIsLive(room)) && primaryAction !== 'Watch';
  return { primaryAction, extraWatch };
}

/** Everything one room card draws, from the room body alone. `isMine`: the caller is already a member. */
export function roomCardView(room: RoomView, isMine: boolean): RoomCardView {
  const state = roomState(room);
  const capacity = room.pod !== null ? POD_SEATS : 2;
  const { primaryAction, extraWatch } = actions(room, state, isMine);
  return {
    tournament: room.gameType === 'draft' || room.settings.tournament,
    seatsFilled: room.members.length,
    seatsCapacity: capacity,
    mode: modeChip(room),
    series: seriesLabel(room),
    state,
    primaryAction,
    extraWatch,
  };
}
