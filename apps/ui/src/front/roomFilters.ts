/*
 * The room list's own filters (the operator's rulings, 2026-10-27, ruling 6): a [Draft | Constructed]
 * pair, a [Not full] toggle and a [Tournament | Duel] pair, each pair picking at most one at a time
 * (click the pressed one again to clear it). Several on at once means a room must match ALL of them.
 *
 * Matching rooms are never hidden — a room that stops matching keeps its Watch and its buttons
 * working — they just sort to the top and the rest are drawn dimmed (`RoomList.tsx`'s own CSS).
 *
 * Pure here on purpose, same reason `roomCard.ts` is: every combination is a table, not a mount.
 */
import type { RoomView } from '../rooms/api.ts';
import type { RoomCardView } from './roomCard.ts';

export interface RoomFilters {
  type: 'draft' | 'constructed' | null;
  notFull: boolean;
  kind: 'tournament' | 'duel' | null;
}

export const DEFAULT_ROOM_FILTERS: RoomFilters = { type: null, notFull: false, kind: null };

/** Whether `filters` carries any choice at all — the "nothing is being filtered" case the list treats specially (no dimming). */
export function hasActiveFilter(filters: RoomFilters): boolean {
  return filters.type !== null || filters.notFull || filters.kind !== null;
}

/** Whether `room` (its card view `view`) matches every filter that is ON. An unset filter never excludes a room. */
export function matchesRoomFilters(room: RoomView, view: RoomCardView, filters: RoomFilters): boolean {
  if (filters.type === 'draft' && room.gameType !== 'draft') return false;
  if (filters.type === 'constructed' && room.gameType === 'draft') return false;
  if (filters.notFull && view.seatsFilled >= view.seatsCapacity) return false;
  if (filters.kind === 'tournament' && !view.tournament) return false;
  if (filters.kind === 'duel' && view.tournament) return false;
  return true;
}

/**
 * `rooms`, with every matching one (by `matches`) moved ahead of every room that is not — a stable
 * partition, so rooms on the same side of the line keep whatever order they arrived in (the list's
 * own "your own rooms first" ordering, upstream of this one).
 */
export function orderByMatch<T>(rooms: readonly T[], matches: (room: T) => boolean): T[] {
  return [...rooms.filter(matches), ...rooms.filter((r) => !matches(r))];
}

const STORAGE_KEY = 'cardtable.rooms.filters';

function isFilters(v: unknown): v is RoomFilters {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  const type = r.type;
  const kind = r.kind;
  return (
    (type === 'draft' || type === 'constructed' || type === null) &&
    typeof r.notFull === 'boolean' &&
    (kind === 'tournament' || kind === 'duel' || kind === null)
  );
}

/**
 * The viewer's own filters, remembered across visits — a per-viewer convenience, never shared state.
 * Wrapped in `try`/`catch`: a private window, cleared site data or a blocked store must still render
 * the list correctly, just unremembered.
 */
export function loadRoomFilters(): RoomFilters {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return DEFAULT_ROOM_FILTERS;
    const parsed = JSON.parse(raw);
    return isFilters(parsed) ? parsed : DEFAULT_ROOM_FILTERS;
  } catch {
    return DEFAULT_ROOM_FILTERS;
  }
}

export function saveRoomFilters(filters: RoomFilters): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // Unremembered is the whole fallback; nothing else to do.
  }
}
