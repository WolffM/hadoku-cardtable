/**
 * A room's own tier floor, above the app's: a room made friends-only (`minTier: 'friend'`) is, to
 * anyone below that tier, as if it did not exist — absent from the list, 404 on every route, refused
 * on the room and relay sockets. The app's floor (`CONFIG.minTier`) still applies first; this only
 * ever narrows it.
 *
 * Read against the edge's tier EXACTLY as the edge named it (`edgeTierOf`), never `tierOf`, which
 * promotes a member to friend for cardtable's own gates: a friends-only room means the fleet's
 * friend tier and above, and a verified member is not that.
 */
import { rankOf } from '../edge-auth.js';

/** The stricter of two floors; undefined when neither is set. */
export function stricterTier(a: string | undefined, b: string | undefined): string | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return rankOf(b) > rankOf(a) ? b : a;
}

/** Whether a caller of `tier` (the edge's own name for it) may see a room whose floor is `minTier`. */
export function tierAdmits(minTier: string | undefined, tier: string): boolean {
	return minTier === undefined || rankOf(tier) >= rankOf(minTier);
}


/**
 * Whether a room lets someone in at all — its chat socket (`./serve.ts`) and its relay match's socket
 * (`../play/relay-socket.ts`) ask the same question: never below the room's own floor; its members;
 * and anyone else only while it has no password.
 */
export function roomAdmits(room: { minTier?: string; locked: boolean } | undefined, isMember: boolean, tier: string): boolean {
	if (room === undefined || !tierAdmits(room.minTier, tier)) return false;
	return isMember || !room.locked;
}
