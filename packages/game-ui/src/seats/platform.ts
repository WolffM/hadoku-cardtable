/**
 * A platform room's seats, read for `SeatList` and `SpectatorRow`: the one reading every game whose
 * room is the platform's own (`@hadoku/game-server`'s `plainRoomType` with `markedSeats`) draws
 * its lineup from, so no game classifies seats, names bots or picks faces of its own.
 *
 * - A member's face is their account's — `avatarId` AND `look` (the picture they chose, their
 *   cosmetics) — exactly as chat draws them, never a character drawn in their place.
 * - A bot is the server's persona for its seat (`aiSeats`, `ai-faces.ts`'s `seatPersonas`): the
 *   character it plays as, by that character's name, the same on every page.
 * - The "+1" slot is drawn only when every seat is taken (none open, none closed) and the room
 *   can still grow — Magic's pod rule. A room that keeps one seat open by itself (`keepOneOpen`) never draws it.
 */
import type { Look } from '@hadoku/platform-wire/look';
import { AI_SEAT, CLOSED_SEAT, type AiPersona } from '@hadoku/platform-wire/seats';

import type { SeatOccupant, SeatSlot } from './SeatChip.tsx';

/** What this reads of a room's view (`PlatformRoomView` and `PlainRoomView`). */
export interface PlatformSeatRoom {
  leader: string;
  /** As stored: a member id, `AI_SEAT`, `CLOSED_SEAT` or null. */
  seats: readonly (string | null)[];
  members: readonly { id: string; name: string; ready?: boolean; avatarId?: string; look?: Look }[];
  /** The bot at each seat, in seat order. Absent (an older server): a bot is drawn faceless, as "Bot". */
  aiSeats?: readonly (AiPersona | null)[];
}

export interface PlatformSeats {
  slots: SeatSlot[];
  /** `SeatList`'s `realSeatCount`: the seats the room has, without the "+1" slot. */
  realSeatCount: number;
  /** The viewer's seat, or null while watching. */
  mySeat: number | null;
  /** Every member who holds no seat, as `SpectatorRow` takes them. */
  spectators: { id: string; name: string; avatarId?: string; look?: Look }[];
}

export interface PlatformSeatsOptions {
  /** The most seats the room can grow to: no "+1" slot at or past it. */
  ceiling: number;
  /** `false` for a game with no Ready step (its Start is a press, never a readiness gate): every member reads ready, so no ring says "not ready" for no reason. */
  readiness?: boolean;
}

export function platformSeats(room: PlatformSeatRoom, myId: string | null, opts: PlatformSeatsOptions): PlatformSeats {
  const memberOf = (id: string) => room.members.find((m) => m.id === id);
  const occupantOf = (holder: string | null, seat: number): SeatOccupant => {
    if (holder === null) return { kind: 'open' };
    if (holder === CLOSED_SEAT) return { kind: 'closed' };
    if (holder === AI_SEAT) {
      const persona = room.aiSeats?.[seat] ?? null;
      return persona === null ? { kind: 'bot', name: 'Bot' } : { kind: 'bot', name: persona.name, avatarId: persona.avatarId };
    }
    const member = memberOf(holder);
    // A holder who is no longer a member is nobody's seat — the server's own reading of it.
    if (member === undefined) return { kind: 'open' };
    return {
      kind: 'member',
      id: member.id,
      name: member.name,
      ...(member.avatarId === undefined ? {} : { avatarId: member.avatarId }),
      ...(member.look === undefined ? {} : { look: member.look }),
      ready: opts.readiness === false || member.ready === true,
      leader: member.id === room.leader,
      mine: member.id === myId,
    };
  };
  const slots: SeatSlot[] = room.seats.map((holder, seat) => ({ seat, occupant: occupantOf(holder, seat) }));
  const seat = myId === null ? -1 : room.seats.indexOf(myId);
  const mySeat = seat === -1 ? null : seat;
  const realSeatCount = slots.length;
  // Full: no open seat, and none closed either — a closed seat is the leader's to open, not grown past.
  const full = slots.every((s) => s.occupant.kind !== 'open' && s.occupant.kind !== 'closed');
  if (full && realSeatCount < opts.ceiling) slots.push({ seat: realSeatCount, occupant: { kind: 'open' } });
  const seated = new Set(room.seats);
  const spectators = room.members
    .filter((m) => !seated.has(m.id))
    .map((m) => ({ id: m.id, name: m.name, ...(m.avatarId === undefined ? {} : { avatarId: m.avatarId }), ...(m.look === undefined ? {} : { look: m.look }) }));
  return { slots, realSeatCount, mySeat, spectators };
}
