/**
 * The room feed, bound to the lobby: an open screen is told its room (or the room list) changed,
 * so it never reads on a timer. The feed itself is the rooms core's (`@wolffm/rooms-server`'s
 * `attachRoomBookFeed`, over `@wolffm/rooms-protocol`'s `feed.ts` wire): one ping per room per turn,
 * a watch is the whole set a socket follows and replaces the last. What this file adds is
 * cardtable's own:
 *
 * - **Who hears a room.** Rooms are private: a socket hears a room's ping only while its participant
 *   is a member, checked when the ping goes out (an invite link watches before its join lands).
 * - **What drives it.** Every room write goes through the lobby's one persist, which bumps the
 *   room's `updatedAt` and says so (`Lobby.onChange`) — joins and leaves included, so a member
 *   count reaches the list on the write that changed it.
 * - **Presence.** A hidden screen reads nothing, so the watch itself keeps a room offered on the
 *   front page: every watched room is touched for its member when the watch arrives and every
 *   `FEED_TOUCH_MS` after, for as long as the socket stays.
 *
 * No gate of its own: `attachDraftSocket` and `attachPlay` already put the edge's provenance and the
 * tier floor in front of every handshake on the default namespace (`room/socket.ts`'s header).
 */

import type { Server as SocketIOServer, Socket } from 'socket.io';
import { ROOM_FEED_CHANNEL, parseRoomWatch } from '@wolffm/rooms-protocol';
import { attachRoomBookFeed, type RoomFeedHandle } from '@wolffm/rooms-server';
import { jsonLogger } from '@hadoku/service-kernel/log';

import { identityFromHeaders } from './identity.js';
import { ROOM_STALE_MS } from './constants.js';

/** Well inside `ROOM_STALE_MS`, so an open room never stops being offered. */
const FEED_TOUCH_MS = ROOM_STALE_MS / 6;

/** A narrow slice of `room/lobby.ts`'s `Lobby` — declared here, not imported, so this platform file carries no edge into the tangled lobby. `FileLobby` satisfies it structurally. */
export interface RoomFeedLobby {
	touch(roomId: string, memberId: string): void;
	isMember(roomId: string, memberId: string): boolean;
	onChange(listener: (roomId: string) => void): () => void;
}

interface RoomFeedDeps {
	lobby: RoomFeedLobby;
	log?: (line: Record<string, unknown>) => void;
	/** Injected for tests. */
	touchEveryMs?: number;
}

const participantOf = (socket: Socket): string => identityFromHeaders(socket.request.headers, socket.id);

export function attachRoomFeed(io: SocketIOServer, deps: RoomFeedDeps): RoomFeedHandle {
	const { lobby } = deps;
	/** Each watching socket's participant and rooms, for the touch. */
	const watching = new Map<string, { participantId: string; rooms: readonly string[] }>();
	const touch = ({ participantId, rooms }: { participantId: string; rooms: readonly string[] }): void => {
		for (const room of rooms) lobby.touch(room, participantId);
	};
	const touching = setInterval(() => {
		for (const watcher of watching.values()) touch(watcher);
	}, deps.touchEveryMs ?? FEED_TOUCH_MS);
	touching.unref();

	io.on('connection', (socket) => {
		const participantId = participantOf(socket);
		socket.on(ROOM_FEED_CHANNEL.watch, (raw: unknown) => {
			const watch = parseRoomWatch(raw);
			if (watch === null) return;
			if (watch.rooms.length === 0 && !watch.list) {
				watching.delete(socket.id);
				return;
			}
			const watcher = { participantId, rooms: watch.rooms };
			watching.set(socket.id, watcher);
			touch(watcher);
		});
		socket.on('disconnect', () => watching.delete(socket.id));
	});

	const feed = attachRoomBookFeed(io, {
		wire: { channel: ROOM_FEED_CHANNEL, parseWatch: parseRoomWatch },
		onChange: (listener) => lobby.onChange(listener),
		isMember: (room, participantId) => lobby.isMember(room, participantId),
		participantId: participantOf,
		log: deps.log ?? jsonLogger('cardtable-feed'),
	});
	return {
		changed: feed.changed,
		close(): void {
			feed.close();
			clearInterval(touching);
			watching.clear();
		},
	};
}
