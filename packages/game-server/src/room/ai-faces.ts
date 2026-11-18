/**
 * Who an AI seat is: one of the platform's characters, named after it (the operator,
 * 2026-10-19: an AI plays as a character, by that character's own name). Generic to every
 * room — Magic's pods and tournaments draw their AIs here, and so does every plain room
 * (`plainRoomType`'s view, `seatPersonas`), so a bot looks and is named the same in every game.
 *
 * Drawn, never dealt in pool order: every room's first bot used to be the pool's first
 * character. Seeded by room and seat, so every reader of the same room — every page, every
 * restart — sees the same face, with nothing stored.
 */
import type { AiPersona } from '@hadoku/platform-wire/seats';
import { AVATAR_POOL } from '@wolffm/rooms-protocol';

export type { AiPersona };

type Face = string | null | undefined;

/** FNV-1a: a stable 32-bit number for a string, so a seeded pick is the same on every run. */
function seedOf(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
	return h >>> 0;
}

/** `knight` → Knight. */
export function personaOf(avatarId: string): AiPersona {
	return { name: avatarId.charAt(0).toUpperCase() + avatarId.slice(1), avatarId };
}

/**
 * A character drawn at random — seeded by `seed`, so the same room and seat
 * always draws the same face — from the pool's least-used ones. `tiers` are
 * compared in turn: a character that appears fewer times in the first is
 * preferred, a tie goes to the next tier, and what is still tied is drawn
 * from. So nobody shares a face while one is free, and past all of the pool
 * it cycles rather than repeating one face (the operator, 2026-11-01).
 */
export function drawAvatar(seed: string, ...tiers: readonly (readonly Face[])[]): string {
	const counts = tiers.map((faces) => {
		const n = new Map<string, number>();
		for (const f of faces) if (f !== null && f !== undefined) n.set(f, (n.get(f) ?? 0) + 1);
		return n;
	});
	let least: string[] = [...AVATAR_POOL];
	for (const n of counts) {
		const min = Math.min(...least.map((a) => n.get(a) ?? 0));
		least = least.filter((a) => (n.get(a) ?? 0) === min);
	}
	return least[seedOf(seed) % least.length]!;
}

/** The pool in an order of `seed`'s own: the same seed, the same order (a seeded Fisher–Yates). */
function poolOrder(seed: string): string[] {
	const order = [...AVATAR_POOL];
	let state = seedOf(seed) || 1;
	for (let i = order.length - 1; i > 0; i--) {
		// xorshift32: enough spread for a shuffle of a couple of dozen faces.
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		const j = (state >>> 0) % (i + 1);
		[order[i], order[j]] = [order[j]!, order[i]!];
	}
	return order;
}

/** What `seatPersonas` reads of a room: its id, who holds each seat, and the faces its members wear. */
export interface PersonaRoom {
	id: string;
	seats: readonly (string | null)[];
	members: readonly { id: string; avatarId?: string | undefined }[];
}

/**
 * The AI at each of `room`'s seats (`aiMarker` holds it), in seat order; null for every other
 * seat. Each AI walks its own seeded order of the pool (room id and seat) and takes the first
 * face nobody wears — no member, no AI at an earlier seat. So a bot keeps its face while people
 * come and go, and only redraws when a person puts on exactly that face; and past the pool's
 * size, faces repeat as `drawAvatar`'s least-used rule picks them.
 */
export function seatPersonas(room: PersonaRoom, aiMarker: string): (AiPersona | null)[] {
	const worn = new Set<string>();
	for (const m of room.members) if (m.avatarId !== undefined) worn.add(m.avatarId);
	const drawn: string[] = [];
	return room.seats.map((holder, seat) => {
		if (holder !== aiMarker) return null;
		const seed = `${room.id}:${seat}`;
		const face = poolOrder(seed).find((a) => !worn.has(a)) ?? drawAvatar(seed, [...room.members.map((m) => m.avatarId), ...drawn]);
		worn.add(face);
		drawn.push(face);
		return personaOf(face);
	});
}
