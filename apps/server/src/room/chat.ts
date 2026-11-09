/**
 * Cardtable's own rooms' chat, served from cardtable's own origin.
 *
 * Before this file, every cardtable room's chat was stored and served by
 * watchparty: `RoomShell.tsx` mounted `RoomChrome` with one `serverOrigin`,
 * and the chat socket rode watchparty's server regardless of which room it
 * was for. That held up watchparty's deploys (a cardtable room counted as
 * "busy" the moment anyone had it open) and, separately, watchparty's own
 * join checks only the caller's account tier — it has no way to ask cardtable
 * "is this account actually a member of this room"
 * (`docs/requests/watchparty-chat-membership.md`). `@wolffm/watchparty-ui`
 * 0.45.62's `RoomChrome` grew a `chatOrigin` prop for exactly this: a host
 * that serves its own rooms' chat behind its own membership rule. This file
 * is cardtable's half.
 *
 * `@wolffm/rooms-server/chat`'s `serveRoomChat` puts the generic chat
 * pipeline (`createRoomChat`: parse → rate-limit → append → broadcast) on a
 * socket.io NAMESPACE (`/chat`) of THIS server, with `admit` as the one
 * membership checkpoint: nothing is sent to a socket — not `chat_history`,
 * not a later `chat_broadcast` — until `admit` has returned a `ChatAdmission`
 * for it, and `chat_send` is refused without one. So "a non-member reads and
 * sends nothing" is `admit` returning null, not a second gate.
 *
 * THE WIRE IS WATCHPARTY'S, UNCHANGED (`join`, `chat_send`, `chat_history`,
 * `chat_broadcast`, `error`), because `RoomChrome`'s chat client is one piece
 * of code whichever server it talks to — see `serveRoomChat`'s own doc.
 *
 * ## No second presence tracker
 *
 * This file does not track who is connected itself. `serveRoomChat` already
 * keeps its own live-sender map (`admitted`, package-internal) for exactly
 * what IT needs — naming a live message's sender and listing a room's
 * current chatters — and that is unrelated to the SEAT-release presence
 * `room/socket.ts` owns. `state.seatPresence` is the one instance a future
 * adoption of watchparty's own `serveRoom` would be handed; chat's admission
 * is a one-shot check per `join`/`chat_send`, not a connection count, so it
 * needs no tracker of its own at all.
 *
 * ## The room key: watchparty's format in, cardtable's id out
 *
 * `RoomChrome`'s `chatTransport` joins the chat socket with the SAME join
 * payload it would send watchparty — `room_key` is `roomKeyFor(id)`'s output
 * (`RoomShell.tsx`), `` `${APP_ID}-${id}` ``, never cardtable's bare room id.
 * `roomIdFromChatKey` is the inverse: strip the app prefix, then the SAME
 * `ROOM_ID_RE` a room id is already validated against everywhere else in this
 * server. `APP_ID` here must agree with `apps/ui/app-name.ts`'s `APP_ID`
 * (`'cardtable'`, matching hadoku_site's `spec/categories.json` id) — it is
 * not imported from there because a server importing UI source is the wrong
 * direction for this app's layering, so the one string is restated, not
 * shared.
 *
 * ## No delete hook yet — a documented gap, not an oversight
 *
 * `clearRoomChat` is watchparty's own answer to a chat file outliving its
 * room (`ChatHistoryConfig`'s doc: "outlives a delete notification"), wired
 * here from `lobby.onChange`: every write is read back with `lobby.get`, and
 * a room that is gone by then schedules the deferred wipe. `draftRooms.ts`
 * accepts the same trade for pods ("No GC" — "a slow leak … a much smaller
 * one than destroying a game in progress"): a few KB of chat text per closed
 * room is not worth building a second room-lifecycle signal for yet.
 */

import type { Server as SocketIOServer } from 'socket.io';
import { participantHandle } from '@wolffm/rooms-protocol';
import { createChatHistoryStore, serveRoomChat, type RoomChatMessage, type ServedRoomChat } from '@wolffm/rooms-server/chat';
import { ROOM_ID_RE } from '@hadoku/shared';

import { rankOf } from '../edge-auth.js';
import { handshakeTier } from './socket.js';
import { identityFromHeaders } from './identity.js';
import type { Lobby } from './lobby.js';

/**
 * Must match `apps/ui/app-name.ts`'s `APP_ID` — watchparty's join payload
 * (built by `RoomShell.tsx`'s `roomKeyFor`) prefixes every room key with it.
 * Restated rather than imported: see the module header.
 */
const APP_ID = 'cardtable';

/** `cardtable-<id>` → `<id>`, or null when it is not one of ours or not a shape a room id takes. */
export function roomIdFromChatKey(roomKey: string): string | null {
	const prefix = `${APP_ID}-`;
	if (!roomKey.startsWith(prefix)) return null;
	const id = roomKey.slice(prefix.length);
	return ROOM_ID_RE.test(id) ? id : null;
}

/**
 * In-memory cap per room, and the default/max page a `GET …/chat` page asks
 * for — generous for a room's chat (a few hundred lines of small talk, not a
 * match log), matched loosely to watchparty's own history size.
 */
const MAX_MESSAGES_PER_ROOM = 500;
const PAGE_LIMIT = 50;
const PAGE_LIMIT_MAX = 100;

/**
 * A room's own chat file is read back for this long after boot; older than
 * that, it is deleted on sight rather than loaded. Cardtable rooms have no
 * fixed lifetime (unlike a draft pod's 45 minutes), so this is generous: 90
 * days is longer than any room this app has ever seen stay interesting, and
 * short enough that an abandoned room's chat does not accumulate forever.
 */
const CHAT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface ChatDeps {
	lobby: Lobby;
	/** `CONFIG.minTier` in production — the same floor `room/socket.ts` applies. */
	minTier: string;
	/** A thunk so a host can read a possibly test-overridden config lazily, on every call. */
	stateDir: () => string;
	/** Default `/chat`. Overridable for a test that wants its own namespace. */
	namespace?: string;
	onEvent?: (level: 'info' | 'warn', event: string, fields: Record<string, unknown>) => void;
}

/**
 * Mount cardtable's own chat namespace on `io`. `admit` is the whole gate: the
 * caller's tier (the same floor every cardtable socket applies), a room key
 * this app minted, and room MEMBERSHIP (`lobby.isMember`) — not merely that
 * the room exists, which is `watchparty-chat-membership.md`'s own finding
 * about watchparty's equivalent check.
 */
export async function attachRoomChat(io: SocketIOServer, deps: ChatDeps): Promise<ServedRoomChat<RoomChatMessage>> {
	const store = createChatHistoryStore<RoomChatMessage>({
		stateDir: deps.stateDir,
		maxMessages: MAX_MESSAGES_PER_ROOM,
		pageLimit: PAGE_LIMIT,
		pageLimitMax: PAGE_LIMIT_MAX,
		roomLifeMs: () => CHAT_RETENTION_MS,
		safeRoomId: ROOM_ID_RE,
		// The history store's `onEvent` takes `roomId` as its own positional
		// argument (a different shape from `serveRoomChat`'s below) — folded
		// into the same `fields` bag so one `onEvent` sees one shape.
		onEvent: deps.onEvent === undefined ? undefined : (level, event, roomId, fields) => deps.onEvent?.(level, event, { roomId, ...fields }),
	});
	// Awaited, like `rooms.ts`'s own `restoreRooms` — a room's chat is readable
	// from the moment this server starts listening, not some time after.
	await store.loadFromDisk(CHAT_RETENTION_MS);

	const served = serveRoomChat<RoomChatMessage>(io, {
		store,
		namespace: deps.namespace ?? '/chat',
		onEvent: deps.onEvent,
		admit(socket, join) {
			// Provenance sanitization is engine-wide (`gate.ts`'s `gateSocketIo`,
			// installed once by the draft socket on this same `io`), so these
			// headers are already trustworthy by the time a namespace's
			// `connection` fires — see `room/socket.ts`'s own module header.
			const tier = handshakeTier(socket.request.headers);
			if (rankOf(tier) < rankOf(deps.minTier)) return null;
			const roomId = roomIdFromChatKey(join.room_key);
			if (roomId === null) return null;
			const participantId = identityFromHeaders(socket.request.headers, socket.id);
			if (!deps.lobby.isMember(roomId, participantId)) return null;
			const member = deps.lobby.get(roomId)?.members.find((m) => m.id === participantId);
			return {
				roomId,
				sender: () => ({
					clientId: socket.id,
					// A stable handle, never the friend key and never the edge's
					// `X-User-Id` — the same string every other seat sees
					// (`draftRooms.ts`'s `joinDraftRoom` names a seat the same way).
					author: participantHandle(participantId),
					name: participantHandle(participantId),
					sprite: member?.avatarId ?? null,
				}),
			};
		},
	});

	deps.lobby.onChange((roomId) => {
		if (deps.lobby.get(roomId) === undefined) void store.clearRoomChat(roomId);
	});

	return served;
}
