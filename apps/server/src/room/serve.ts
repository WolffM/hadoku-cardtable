/**
 * Cardtable's rooms, served by cardtable: `@wolffm/rooms-server/room`'s `serveRoom` on this
 * server's own socket.io, at the `/room` namespace `RoomChrome`'s `roomOrigin` connects to
 * (`apps/ui/src/room/RoomShell.tsx`). The chrome's whole room socket comes here — join, roster,
 * identity, chat — and none of it goes to watchparty, so an open cardtable room neither counts on
 * watchparty's server nor holds its deploys.
 *
 * ## One answer to "who is here"
 *
 * `presence` is `state.seatPresence`, the server's ONE `PresenceTracker` (`room/socket.ts`'s
 * `createSeatPresence`): the instance the lobby's seat grace and every draft pod's seat-hold already
 * run on. A room connection is a connection of the PERSON (`key` = their participant id, the
 * tracker's lobby key), beside their tab's feed and draft sockets. So the chrome's roster, the seat
 * grace and a pod's hold read one tracker, and a second tab is one person, not two.
 *
 * ## One answer to "who is this"
 *
 * `account` is `people.ts`'s lookup, keyed by the edge's `X-User-Id`, and always reads fresh:
 * serveRoom calls it on the chrome's `identity_update` after a rename or a new picture, on the
 * account's own join or chat once its copy is `accountStaleMs` old, and on a person's first join
 * since this server started. serveRoom pushes the answer to every connection of the
 * account and calls `apply`, which writes it into the lobby (`applyPerson`): the room list, the
 * table and the chrome all read the same name, picture and character, and a rename reaches the
 * other players' room list with nobody rejoining.
 *
 * ## Who may join
 *
 * `admit` is the gate: the tier floor (the same one every cardtable socket applies), a key this app
 * minted (`cardtable-<id>`, `RoomShell.tsx`'s `roomKeyFor`), and a place the lobby knows. A room's
 * own key admits its members only. A table's key (`<roomId>-<tableId>`, `App.tsx`'s `tableChatId`)
 * admits the room's members, and anyone at all while the room has no password, since anyone may
 * watch an open room's match; so does a match no room holds (a game against the AI, a scenario),
 * keyed by the match's own id. A refusal sends nothing of the room.
 *
 * `APP_ID` must agree with `apps/ui/app-name.ts`'s `APP_ID`; it is restated rather than imported,
 * since a server importing UI source is the wrong direction for this app's layering.
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { Server as SocketIOServer } from 'socket.io';
import { participantHandle } from '@wolffm/rooms-protocol';
import type { PresenceTracker } from '@wolffm/rooms-server';
import { createChatHistoryStore, type RoomChatMessage } from '@wolffm/rooms-server/chat';
import { serveRoom, type AccountIdentity, type ServedRoom } from '@wolffm/rooms-server/room';
import { ROOM_ID_RE } from '@hadoku/shared';

import { rankOf } from '../edge-auth.js';
import { applyPerson, type People } from '../people.js';
import { handshakeTier } from './socket.js';
import { identityFromHeaders } from './identity.js';
import type { Lobby } from './lobby.js';

const APP_ID = 'cardtable';

/** In memory per room, and the default/max page a `GET …/chat` page asks for. */
const MAX_MESSAGES_PER_ROOM = 500;
const PAGE_LIMIT = 50;
const PAGE_LIMIT_MAX = 100;

/** A room's chat file is read back for this long after boot; older, it is deleted on sight. */
const CHAT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * What a room key names: the served room (its chat and roster), and the lobby room it belongs to
 * (null for a match no room holds), and whether anyone at the floor may watch it.
 */
type RoomPlace = { served: string; roomId: string; kind: 'room' | 'table' } | { served: string; roomId: null; kind: 'match' };

/**
 * `cardtable-<id>` → the place it names, or null when it is not one of ours or names nothing live.
 * A table's key is `<roomId>-<tableId>`, or `<roomId>-<matchId>` when the screen's copy of the room
 * no longer names the table its match was played at (`App.tsx`'s `tableChatId`); either is the
 * room's table chat, the match found through the lobby's own memory of it (`roomOfMatch`).
 */
export function placeOfKey(lobby: Pick<Lobby, 'get' | 'roomOfMatch'>, isMatch: (id: string) => boolean, roomKey: string): RoomPlace | null {
	const prefix = `${APP_ID}-`;
	if (!roomKey.startsWith(prefix)) return null;
	const id = roomKey.slice(prefix.length);
	if (!ROOM_ID_RE.test(id)) return null;
	if (lobby.get(id) !== undefined) return { served: id, roomId: id, kind: 'room' };
	for (let at = id.indexOf('-'); at !== -1; at = id.indexOf('-', at + 1)) {
		const room = lobby.get(id.slice(0, at));
		if (room === undefined) continue;
		const rest = id.slice(at + 1);
		if (room.tables.some((t) => t.id === rest) || lobby.roomOfMatch(rest)?.id === room.id) return { served: id, roomId: room.id, kind: 'table' };
	}
	return isMatch(id) ? { served: id, roomId: null, kind: 'match' } : null;
}

/** Whether `participantId` may be in `place`: a room's members; a table's too, or anyone while its room has no password; anyone at a match. */
function mayJoin(lobby: Lobby, place: RoomPlace, participantId: string): boolean {
	if (place.roomId === null) return true;
	if (lobby.isMember(place.roomId, participantId)) return true;
	return place.kind === 'table' && lobby.get(place.roomId)?.locked === false;
}

function accountOfHeaders(headers: IncomingHttpHeaders): string | undefined {
	const id = headers['x-user-id'];
	return typeof id === 'string' && id !== '' ? id : undefined;
}

interface ServeDeps {
	lobby: Lobby;
	/** The server's one tracker (`state.seatPresence`). */
	presence: PresenceTracker<string>;
	/** The account lookup (`state.people`). */
	people: People;
	/** Whether a match by this id is live or just ended (`state.play.matches.find`). */
	isMatch: (id: string) => boolean;
	/** `CONFIG.minTier` in production — the same floor `room/socket.ts` applies. */
	minTier: string;
	/** Where chat history is kept; a thunk, read on every call. */
	stateDir: () => string;
	/** Default `/room`. */
	namespace?: string;
	onEvent?: (level: 'info' | 'warn' | 'debug', event: string, fields: Record<string, unknown>) => void;
}

/** Mount cardtable's rooms on `io` (see the header). */
export async function attachServedRoom(io: SocketIOServer, deps: ServeDeps): Promise<ServedRoom<string, RoomChatMessage>> {
	const { lobby, people } = deps;
	const store = createChatHistoryStore<RoomChatMessage>({
		stateDir: deps.stateDir,
		maxMessages: MAX_MESSAGES_PER_ROOM,
		pageLimit: PAGE_LIMIT,
		pageLimitMax: PAGE_LIMIT_MAX,
		roomLifeMs: () => CHAT_RETENTION_MS,
		safeRoomId: ROOM_ID_RE,
		onEvent: deps.onEvent === undefined ? undefined : (level, event, roomId, fields) => deps.onEvent?.(level, event, { roomId, ...fields }),
	});
	// A room's chat is readable from the moment this server listens, not some time after.
	await store.loadFromDisk(CHAT_RETENTION_MS);

	const served = serveRoom<string, RoomChatMessage>(io, {
		store,
		presence: deps.presence,
		...(deps.namespace === undefined ? {} : { namespace: deps.namespace }),
		...(deps.onEvent === undefined ? {} : { onEvent: deps.onEvent }),
		admit(socket, join) {
			// Provenance is sanitized engine-wide (`gate.ts`'s `gateSocketIo`, installed by the draft
			// socket on this same `io`) before any namespace's `connection` fires.
			const headers = socket.request.headers;
			// Which gate refused, and the key it refused: a refusal the log cannot explain is one nobody can fix.
			const refuse = (gate: 'tier' | 'no-place' | 'not-member'): null => {
				deps.onEvent?.('warn', 'room.refused', { sid: socket.id, room_key: join.room_key, gate });
				return null;
			};
			if (rankOf(handshakeTier(headers)) < rankOf(deps.minTier)) return refuse('tier');
			const place = placeOfKey(lobby, deps.isMatch, join.room_key);
			if (place === null) return refuse('no-place');
			const participantId = identityFromHeaders(headers, socket.id);
			if (!mayJoin(lobby, place, participantId)) return refuse('not-member');
			const roomId = place.roomId;
			const accountId = accountOfHeaders(headers);
			return {
				roomId: place.served,
				key: participantId,
				...(accountId === undefined ? {} : { accountId }),
				member: () => {
					const row = roomId === null ? undefined : lobby.get(roomId)?.members.find((m) => m.id === participantId);
					// A stable handle, never the friend key and never the edge's `X-User-Id`.
					return { author: participantHandle(participantId), name: row?.name ?? participantHandle(participantId), sprite: row?.avatarId ?? null };
				},
				apply: () => {
					const person = accountId === undefined ? undefined : people.peek(accountId);
					if (person !== undefined && roomId !== null) applyPerson(lobby, roomId, participantId, person);
				},
			};
		},
		// Always read fresh. serveRoom asks without `fresh` only for a person it holds no copy of (their
		// first join or line since this server started), and people's cache may predate a change they
		// made while their socket was down: a restart's resumed match fills it, and the chrome's
		// `identity_update` for a pick made before the socket rejoined is dropped ("join the room
		// first"), so this read is the only one that sees the pick.
		async account(accountId) {
			const person = (await people.resolve([accountId], { fresh: true })).get(accountId);
			if (person === undefined) return null;
			// `sprite` rides along so a change of character alone is a change of identity too.
			const identity: AccountIdentity & { sprite?: string } = {
				...(person.name === null ? {} : { name: person.name }),
				...(person.look?.picture === undefined ? {} : { avatarUrl: person.look.picture }),
				...(person.look?.cosmetics === undefined ? {} : { cosmetics: person.look.cosmetics }),
				...(person.sprite === null ? {} : { sprite: person.sprite }),
			};
			return identity;
		},
	});

	lobby.onChange((roomId) => {
		if (lobby.get(roomId) === undefined) void store.clearRoomChat(roomId);
	});

	return served;
}
