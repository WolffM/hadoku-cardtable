/**
 * The cardtable room a watchparty room's game slot is bound to.
 *
 * A digest, not the watchparty name. Watchparty hands the embed its room ID
 * (the same for the leader and viewers), but that id is opaque to us — any
 * length or alphabet — and a room id must fit `ROOM_ID_RE` and is printed in
 * the list and every log line. Were a leader KEY ever passed by mistake
 * (`<room>-<16 hex>`, a credential), the digest still never prints it. `wp-`
 * keeps it apart from `r-` (minted) ids; 20 hex is 80 bits.
 *
 * Generic: a non-Magic room binds to a watchparty slot the same way a Magic
 * one does (D21). Split out of `room/lobby.ts` (wave 110 §L).
 */
import { createHash } from 'node:crypto';

export function watchpartyRoomId(watchpartyRoom: string): string {
	return `wp-${createHash('sha256').update(watchpartyRoom).digest('hex').slice(0, 20)}`;
}

/**
 * Whether `roomId` is one a watchparty room's game slot is bound to. Such a room is drawn inside
 * watchparty's own page, whose chat and roster are watchparty's: nobody at it holds a connection to
 * this server's room socket, so this server cannot say who is in it now.
 */
export function isWatchpartyRoomId(roomId: string): boolean {
	return roomId.startsWith('wp-');
}
