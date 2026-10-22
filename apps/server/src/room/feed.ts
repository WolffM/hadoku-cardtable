/**
 * The room feed: tell an open screen that its room changed, so it never has to
 * ask on a timer.
 *
 * Every room screen, the room list and every match's result screen used to read
 * the room about once a second and a half for as long as it stayed open
 * (hadoku_site's request log: ~7,500 reads in 6 h from five rooms). Everything
 * that changes a room is a write on this server, and every write goes through
 * the lobby's one persist — so the lobby says which room changed (`Lobby.onChange`) and this sends that id to the
 * sockets that asked to follow it. The screen then reads the route it always
 * read. The wire is `@hadoku/shared`'s `room-feed.ts`; its header says why a
 * ping carries no room.
 *
 * ## Who hears a room
 *
 * A socket names the rooms it follows, but hears a room's ping only while its
 * participant is a MEMBER of that room — checked when the ping goes out, not
 * when the watch arrives, because an invite link watches the room before the
 * screen's own join has made it a member. A non-member therefore learns
 * nothing about a room, the same as every room route answers it. The list
 * ping says only that the list may have moved; the list route decides what a
 * caller sees in it.
 *
 * ## One ping per room per turn
 *
 * A match start writes the room three times in one request (the match, then
 * both players' spent Readys). Changes are collected and sent once the request
 * that made them has finished its synchronous work, so a screen reads once.
 *
 * ## Presence
 *
 * The front page stops offering a room nobody has touched for `ROOM_STALE_MS`.
 * A screen that is open but hidden reads nothing, so the watch itself is
 * presence: every followed room is touched for its member when the watch
 * arrives and every `FEED_TOUCH_MS` after, for as long as the socket stays.
 *
 * ## The gate
 *
 * This adds handlers to the default namespace and installs no gate of its own:
 * `attachDraftSocket` and `attachPlay` already put the edge's provenance and
 * the tier floor in front of every handshake on it (`room/socket.ts`'s header).
 * Identity is derived the same way they derive it, from those sanitized headers.
 */

import type { Server as SocketIOServer, Socket } from 'socket.io';
import { ROOM_FEED_CHANNEL, RoomWatchSchema, type RoomChanged } from '@hadoku/shared';

import { identityFromHeaders } from './identity.js';
import { ROOM_STALE_MS, type Lobby } from './lobby.js';
import { jsonLogger } from '../log.js';

/** Well inside `ROOM_STALE_MS`, so an open room never stops being offered. */
const FEED_TOUCH_MS = ROOM_STALE_MS / 6;

interface RoomFeedDeps {
	lobby: Lobby;
	log?: (line: Record<string, unknown>) => void;
	/** Injected for tests. */
	touchEveryMs?: number;
}

interface RoomFeedHandle {
	close(): void;
}

interface Watcher {
	socket: Socket;
	participantId: string;
	rooms: ReadonlySet<string>;
	list: boolean;
}

const defaultLog = jsonLogger('cardtable-feed');

export function attachRoomFeed(io: SocketIOServer, deps: RoomFeedDeps): RoomFeedHandle {
	const log = deps.log ?? defaultLog;
	/** By socket id. Only sockets that sent a watch: a match or a pod socket never appears here. */
	const watchers = new Map<string, Watcher>();
	const changed = new Set<string>();
	let flushing = false;

	const send = (socket: Socket, message: RoomChanged): void => {
		socket.emit(ROOM_FEED_CHANNEL.changed, message);
	};

	const flush = (): void => {
		flushing = false;
		const rooms = [...changed];
		changed.clear();
		for (const watcher of watchers.values()) {
			for (const room of rooms) {
				if (watcher.rooms.has(room) && deps.lobby.isMember(room, watcher.participantId)) send(watcher.socket, { room });
			}
			if (watcher.list) send(watcher.socket, { list: true });
		}
	};

	const stopListening = deps.lobby.onChange((roomId) => {
		changed.add(roomId);
		if (flushing) return;
		flushing = true;
		setImmediate(flush);
	});

	const touch = (watcher: Watcher): void => {
		for (const room of watcher.rooms) deps.lobby.touch(room, watcher.participantId);
	};
	const touching = setInterval(() => {
		for (const watcher of watchers.values()) touch(watcher);
	}, deps.touchEveryMs ?? FEED_TOUCH_MS);
	touching.unref();

	io.on('connection', (socket) => {
		const participantId = identityFromHeaders(socket.request.headers, socket.id);
		// Acknowledged once it is in force: a change made before then was never going to
		// be said, so the client reads again on the ack (`apps/ui/src/rooms/feed.ts`).
		socket.on(ROOM_FEED_CHANNEL.watch, (raw: unknown, ack?: unknown) => {
			const parsed = RoomWatchSchema.safeParse(raw);
			if (!parsed.success) {
				log({ evt: 'watch-malformed', participantId, detail: parsed.error.issues[0]?.message });
				return;
			}
			const watcher: Watcher = { socket, participantId, rooms: new Set(parsed.data.rooms), list: parsed.data.list };
			if (watcher.rooms.size === 0 && !watcher.list) {
				watchers.delete(socket.id);
			} else {
				watchers.set(socket.id, watcher);
				touch(watcher);
			}
			if (typeof ack === 'function') ack();
		});
		socket.on('disconnect', () => {
			watchers.delete(socket.id);
		});
	});

	return {
		close(): void {
			stopListening();
			clearInterval(touching);
			watchers.clear();
		},
	};
}
