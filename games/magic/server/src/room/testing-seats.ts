/**
 * For tests that arrange a room's seats themselves: everyone gives their seat back, pod and
 * tables alike. `Lobby.join` and `Lobby.create` seat a newcomer (`#autoSeat`), so a test that
 * sits people at chosen seats starts from here.
 */

import type { Lobby } from './lobby.ts';

export function standAll(lobby: Lobby, roomId: string): void {
	const room = lobby.get(roomId);
	if (room === undefined) throw new Error(`no room ${roomId}`);
	for (const member of room.members) {
		lobby.standPod(roomId, member.id);
		for (const table of room.tables) lobby.stand(roomId, table.id, member.id);
	}
}
