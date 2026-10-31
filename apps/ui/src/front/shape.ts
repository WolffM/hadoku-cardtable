/*
 * What the front page looked like last time, so its skeleton can stand in the same boxes before any
 * read has answered: whether the live slot was there (it decides how wide every banner card is), how
 * many rooms the list drew and how many events Upcoming did. Remembered per browser, written each
 * time the page has shown itself. A first visit assumes the live slot is there, as it is whenever a
 * replay is kept.
 */

export interface FrontShape {
  live: boolean;
  rooms: number;
  events: number;
}

/** The most room placeholders drawn: enough to fill any window; the rest of a long list is below the fold. */
export const MAX_ROOM_GHOSTS = 12;

const STORAGE_KEY = 'cardtable:front-shape';

export const FIRST_VISIT: FrontShape = { live: true, rooms: 6, events: 3 };

const count = (n: unknown, max: number, fallback: number): number => (typeof n === 'number' && Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback);

export function parseFrontShape(raw: string | null): FrontShape {
  if (raw === null) return FIRST_VISIT;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    // Not ours, or from an older page: the first visit's shape.
    return FIRST_VISIT;
  }
  if (typeof body !== 'object' || body === null) return FIRST_VISIT;
  const { live, rooms, events } = body as Record<string, unknown>;
  return {
    live: typeof live === 'boolean' ? live : FIRST_VISIT.live,
    rooms: count(rooms, MAX_ROOM_GHOSTS, FIRST_VISIT.rooms),
    events: count(events, 3, FIRST_VISIT.events),
  };
}

/*
 * Wrapped in `try`/`catch`, as `./roomFilters.ts` is: a private window, cleared site data or a blocked
 * store must still draw the page, with the first visit's shape.
 */
export function loadFrontShape(): FrontShape {
  try {
    return parseFrontShape(globalThis.localStorage?.getItem(STORAGE_KEY) ?? null);
  } catch {
    return FIRST_VISIT;
  }
}

export function saveFrontShape(shape: FrontShape): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(shape));
  } catch {
    // Not remembered: the next visit draws the first visit's skeleton, and nothing else changes.
  }
}
