/**
 * The room ids this TAB has joined — the fix for the bug the operator found
 * in the room itself, not the server: *"'this room needs a password' this
 * one exposed a bug in the site, the chat shouldn't load if the room hasn't
 * been joined yet."* `App.tsx` reads this to decide whether a `room` route's
 * watchparty chrome mounts at all; before this existed it mounted as soon as
 * `whoami` answered, which is BEFORE the room's own join (or password) had.
 *
 * ## Backed by `sessionStorage`, read synchronously
 *
 * A member who reloads their own room must still get the chat on the FIRST
 * paint — there is no round trip budget for that, and a frame or two with no
 * chrome is the exact regression wave 72 §R fixed for the match route (see
 * `App.tsx`'s `useMatchRoomId`). `sessionStorage` answers synchronously, so
 * `isJoined` can be read straight out of a render with no `useEffect` lag, and
 * it survives a reload of the SAME tab while staying scoped to it — a second
 * tab, or the same room visited fresh tomorrow, starts with nothing marked
 * and has to join (or pass a password) again, exactly as a fresh identity
 * should.
 *
 * ## Marked on proof of membership, not only on a fresh join
 *
 * `ConstructedScreen` marks a room joined whenever it has PROOF the viewer is
 * a member: a `rooms.join` call that came back `ok`, or — just as good — a
 * table read that succeeded without one, which is what happens for a member
 * who already has an active session cookie's worth of membership (its own
 * join effect never fires because the first read already works). Both are
 * "the server just told me I am in this room"; only one of them is spelled
 * `join`.
 */
import { useSyncExternalStore } from 'react';

const KEY = 'cardtable:joinedRooms';

type Listener = () => void;
const listeners = new Set<Listener>();

function hasSessionStorage(): boolean {
  try {
    return typeof sessionStorage !== 'undefined';
  } catch {
    // Some private-browsing modes throw merely on the property access.
    return false;
  }
}

function readAll(): ReadonlySet<string> {
  if (!hasSessionStorage()) return new Set();
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    // Malformed storage (another version's shape, a hand-edit) reads as "nothing joined" —
    // never a crash, and never a reason to treat the viewer as already a member of anything.
    return new Set();
  }
}

function writeAll(ids: ReadonlySet<string>): void {
  if (!hasSessionStorage()) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    // A full or disabled store just loses the mark across a reload; the in-memory
    // listeners still fire, so the CURRENT tab's render is correct either way.
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Whether this tab has already joined `roomId`. A plain, synchronous read — never a hook. */
export function isJoined(roomId: string): boolean {
  return readAll().has(roomId);
}

/** Marks `roomId` joined. Idempotent: marking an already-joined room notifies nobody. */
export function markJoined(roomId: string): void {
  const ids = readAll();
  if (ids.has(roomId)) return;
  writeAll(new Set(ids).add(roomId));
  notify();
}

/** Clears `roomId`'s mark — the room ended, or the viewer stepped out of it. */
export function clearJoined(roomId: string): void {
  const ids = readAll();
  if (!ids.has(roomId)) return;
  const next = new Set(ids);
  next.delete(roomId);
  writeAll(next);
  notify();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * `true` once this tab has joined `roomId`; always `false` for `null` (the
 * routes with no room to gate — see `App.tsx`'s `roomIdFor`). Re-renders the
 * caller on every `markJoined`/`clearJoined`, for ANY room id — the store is
 * small enough that a coarser-than-perfect subscription costs nothing, and a
 * per-room subscription would need its own teardown bookkeeping for no
 * measurable benefit.
 */
export function useJoined(roomId: string | null): boolean {
  return useSyncExternalStore(subscribe, () => roomId !== null && isJoined(roomId));
}
