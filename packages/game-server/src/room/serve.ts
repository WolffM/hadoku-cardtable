/**
 * A game's rooms, served by its own server: `@wolffm/rooms-server/room`'s `serveRoom` on this
 * server's own socket.io, at the `/room` namespace `RoomChrome`'s `roomOrigin` connects to
 * (`packages/game-ui/src/room/RoomShell.tsx`). The chrome's whole room socket comes here — join,
 * roster, identity, chat — and none of it goes to watchparty, so an open room neither counts on
 * watchparty's server nor holds its deploys.
 *
 * Moved here from `games/magic/server/src/room/serve.ts` (wave 119 §S): the only two things that
 * were Magic-only were a `Lobby` type import and one `magicView(...).tables` read inside
 * `placeOfKey`. Both are gone — the `Lobby` here is `ServeLobby<V>`, a structural slice any
 * `RoomLobby` satisfies (`room/lobby.ts`'s own `LobbyCore` trick in `http/room-core.ts`), and the
 * table/match lookup is `RoomTypeHooks.subPlaceOf`, which Magic implements and a game with no
 * sub-places (bomberman, `plainRoomType`'s) simply never answers yes to.
 *
 * ## One answer to "who is here"
 *
 * `presence` is the server's ONE `PresenceTracker`: the instance the lobby's seat grace and every
 * draft pod's seat-hold already run on. A room connection is a connection of the PERSON (`key` =
 * their participant id, the tracker's lobby key), beside their tab's feed and draft sockets. So
 * the chrome's roster, the seat grace and a pod's hold read one tracker, and a second tab is one
 * person, not two.
 *
 * ## One answer to "who is this"
 *
 * `account` is the app's own account lookup, keyed by the edge's `X-User-Id`, and always reads
 * fresh: serveRoom calls it on the chrome's `identity_update` after a rename or a new picture, on
 * the account's own join or chat once its copy is stale, and on a person's first join since this
 * server started. serveRoom pushes the answer to every connection of the account and calls
 * `apply`, which writes it into the lobby: the room list, the table and the chrome all read the
 * same name, picture and character, and a rename reaches the other players' room list with
 * nobody rejoining.
 *
 * ## Who may join
 *
 * `admit` is the gate: the tier floor (the same one every socket applies), a key this app minted
 * (`<appId>-<id>`, `RoomShell.tsx`'s `roomKeyFor`), and a place the lobby knows. A room has one
 * chat, its own key, on its lobby and on every game at its tables. It admits the room's members,
 * and anyone at all while the room has no password, since anyone may watch an open room's match;
 * a locked room admits its members only. A match no room holds (a game against the AI, a
 * scenario) admits anyone, keyed by the match's own id. A table's key (`<roomId>-<tableId>`) is
 * what screens built before 2026-11-11 joined during a game, and is gated as its room is. A
 * refusal sends nothing of the room.
 *
 * ## Who is in a room now
 *
 * `here(roomId)` is the chat's own roster by participant id: everyone with a live room connection to
 * the room, at its lobby, a table of it or a game at one. A member with no screen on the room is a
 * member still (their seat, their sign-up, their place in a locked room) and is not in it. The
 * spectator row reads this (`http/room-core.ts`'s `here`), so it names who is watching, never who
 * once visited (the operator, 2026-11-19). `onRoster` says a room's answer changed.
 *
 * `appId` must agree with the UI's own app id; it is passed in rather than imported, since a
 * server importing UI source is the wrong direction for any app's layering.
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { Server as SocketIOServer } from 'socket.io';
import { participantHandle } from '@wolffm/rooms-protocol';
import type { PresenceTracker } from '@wolffm/rooms-server';
import { createChatHistoryStore, type RoomChatMessage } from '@wolffm/rooms-server/chat';
import { serveRoom, type AccountIdentity, type ServedRoom } from '@wolffm/rooms-server/room';
import type { Look } from '@hadoku/platform-wire/look';

import { rankOf } from '../edge-auth.js';
import { applyPerson, type People } from '../people.js';
import { handshakeEdgeTier, handshakeTier } from './socket-auth.js';
import { roomAdmits } from './tier-floor.js';
import { identityFromHeaders } from './identity.js';

/** In memory per room, and the default/max page a `GET …/chat` page asks for. */
const MAX_MESSAGES_PER_ROOM = 500;
const PAGE_LIMIT = 50;
const PAGE_LIMIT_MAX = 100;

/** A room's chat file is read back for this long after boot; older, it is deleted on sight. */
const CHAT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** The minimal room-view shape this file touches, whatever the game. The real `PlatformRoomView` (and Magic's `RoomView`) satisfy it. */
export interface ServeRoomView {
	id: string;
	locked: boolean;
	/** The room's own tier floor (`./tier-floor.ts`); absent for none. */
	minTier?: string;
	members: readonly { id: string; name: string; avatarId?: string }[];
}

/**
 * The slice of `room/lobby.ts`'s `RoomLobby` this file calls, typed against `V` alone — never the
 * real game-specific view. Method syntax (not property) is load-bearing, same as
 * `http/room-core.ts`'s `LobbyCore`: it is what lets a real, narrower-typed `Lobby` satisfy this
 * interface with no cast, through TypeScript's bivariant parameter checking.
 */
export interface ServeLobby<V extends ServeRoomView> {
	get(roomId: string): V | undefined;
	isMember(roomId: string, participantId: string): boolean;
	onChange(listener: (roomId: string) => void): () => void;
	/** `RoomLobby.subPlaceOf`: whether `rest` names a sub-place (a table, a remembered match) inside this room. */
	subPlaceOf(roomId: string, rest: string): boolean;
	/** `people.ts`'s `applyPerson`, writing an account's name, character and look onto a member. */
	rename(caller: { id: string; name: string }): void;
	setAvatar(roomId: string, memberId: string, avatarId: string | null): boolean;
	setLook(roomId: string, memberId: string, look: Look | undefined): boolean;
}

/**
 * What a room key names: the served room (its chat and roster), and the lobby room it belongs to
 * (null for a match no room holds), and whether anyone at the floor may watch it.
 */
type RoomPlace = { served: string; roomId: string; kind: 'room' | 'table' } | { served: string; roomId: null; kind: 'match' };

/**
 * `<appId>-<id>` → the place it names, or null when it is not one of ours or names nothing live.
 * A table's key is `<roomId>-<tableId>`, or `<roomId>-<matchId>` when the screen's copy of the
 * room no longer names the table its match was played at; either is the room's table chat, the
 * match found through the room's own `subPlaceOf`. Screens since 2026-11-11 join the room's own
 * key on every screen; a page loaded before that still joins a table's.
 */
export function placeOfKey<V extends ServeRoomView>(
	lobby: Pick<ServeLobby<V>, 'get' | 'subPlaceOf'>,
	isMatch: (id: string) => boolean,
	appId: string,
	roomKey: string,
	roomIdRe: RegExp,
): RoomPlace | null {
	const prefix = `${appId}-`;
	if (!roomKey.startsWith(prefix)) return null;
	const id = roomKey.slice(prefix.length);
	if (!roomIdRe.test(id)) return null;
	if (lobby.get(id) !== undefined) return { served: id, roomId: id, kind: 'room' };
	for (let at = id.indexOf('-'); at !== -1; at = id.indexOf('-', at + 1)) {
		const room = lobby.get(id.slice(0, at));
		if (room === undefined) continue;
		const rest = id.slice(at + 1);
		// A room of a game with no idea of a sub-place answers `subPlaceOf` false for every `rest`.
		if (lobby.subPlaceOf(room.id, rest)) return { served: id, roomId: room.id, kind: 'table' };
	}
	return isMatch(id) ? { served: id, roomId: null, kind: 'match' } : null;
}

/** Whether `participantId`, of edge tier `tier`, may be in `place`: as its room admits them (`./tier-floor.ts`'s `roomAdmits`); anyone at a match. */
function mayJoin<V extends ServeRoomView>(lobby: Pick<ServeLobby<V>, 'get' | 'isMember'>, place: RoomPlace, participantId: string, tier: string): boolean {
	if (place.roomId === null) return true;
	return roomAdmits(lobby.get(place.roomId), lobby.isMember(place.roomId, participantId), tier);
}

function accountOfHeaders(headers: IncomingHttpHeaders): string | undefined {
	const id = headers['x-user-id'];
	return typeof id === 'string' && id !== '' ? id : undefined;
}

export interface ServeDeps<V extends ServeRoomView> {
	lobby: ServeLobby<V>;
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
	/** What a room key is prefixed with: `<appId>-<id>` (`RoomShell.tsx`'s `roomKeyFor`). Must agree with the UI's own app id. */
	appId: string;
	/** A room id's shape, for `placeOfKey`'s own validation. */
	roomIdRe: RegExp;
	/** Default `/room`. */
	namespace?: string;
	onEvent?: (level: 'info' | 'warn' | 'debug', event: string, fields: Record<string, unknown>) => void;
	/** A lobby room's `here` changed: someone's room connection opened or closed. */
	onRoster?: (roomId: string) => void;
}

/** The served rooms, and who is in each lobby room now. */
export interface ServedRooms extends ServedRoom<string, RoomChatMessage> {
	/** The participants with a live room connection to `roomId` (see this file's header). */
	here(roomId: string): ReadonlySet<string>;
}

/**
 * The `/room` handshake floor — refused HERE, a forged or headerless socket never reaches
 * `connection` at all. `serveRoom`'s own `admit` is called only once a client has CONNECTED and
 * sent `join`; before this existed, that was the one tier check this namespace had, so a socket
 * that simply never sent `join` stayed connected with no refusal ever reaching it (bm1-BS: a
 * headerless `socket.io-client` connect to this namespace succeeded). `gate.ts`'s own
 * `gateSocketIo` cannot cover this either — `io.use` is Socket.IO's shortcut for
 * `io.of('/').use`, the DEFAULT namespace only, never one this file names of its own
 * (`docs/planning/s3-2026-11-17.md` §G.2). `next(new Error('not found'))` is the same refusal
 * shape `gateSocketIo` uses for the default namespace: a `connect_error` on the client, never a
 * reason string that confirms this namespace exists to a caller never meant to reach it.
 */
function gateRoomHandshake(namespace: ReturnType<SocketIOServer['of']>, minTier: string, onEvent: ServeDeps<ServeRoomView>['onEvent']): void {
	namespace.use((socket, next) => {
		if (rankOf(handshakeTier(socket.request.headers)) < rankOf(minTier)) {
			onEvent?.('warn', 'room.refused', { sid: socket.id, gate: 'tier' });
			next(new Error('not found'));
			return;
		}
		next();
	});
}

/** Mount a game's rooms on `io` (see this file's header). */
export async function attachServedRoom<V extends ServeRoomView>(io: SocketIOServer, deps: ServeDeps<V>): Promise<ServedRooms> {
	const { lobby, people } = deps;
	// Each admitted socket's lobby room (a table's and a game's key name their room's), and each
	// lobby room's joined connections by socket id.
	const lobbyRoomOf = new WeakMap<object, string>();
	const joined = new Map<string, Map<string, string>>();
	gateRoomHandshake(io.of(deps.namespace ?? '/room'), deps.minTier, deps.onEvent);
	const store = createChatHistoryStore<RoomChatMessage>({
		stateDir: deps.stateDir,
		maxMessages: MAX_MESSAGES_PER_ROOM,
		pageLimit: PAGE_LIMIT,
		pageLimitMax: PAGE_LIMIT_MAX,
		roomLifeMs: () => CHAT_RETENTION_MS,
		safeRoomId: deps.roomIdRe,
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
			// No 'tier' case here any more: `gateRoomHandshake` above refuses a below-floor socket before
			// it ever reaches `connection`, so nothing that sends `join` at all can be under the floor —
			// one gate for it, not two copies of "sanitize then rank" agreeing by construction.
			const refuse = (gate: 'no-place' | 'not-member'): null => {
				deps.onEvent?.('warn', 'room.refused', { sid: socket.id, room_key: join.room_key, gate });
				return null;
			};
			const place = placeOfKey(lobby, deps.isMatch, deps.appId, join.room_key, deps.roomIdRe);
			if (place === null) return refuse('no-place');
			const participantId = identityFromHeaders(headers, socket.id);
			if (!mayJoin(lobby, place, participantId, handshakeEdgeTier(headers))) return refuse('not-member');
			const roomId = place.roomId;
			if (roomId !== null) lobbyRoomOf.set(socket, roomId);
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
		onJoined(socket, admission) {
			const roomId = lobbyRoomOf.get(socket);
			if (roomId === undefined) return;
			let sockets = joined.get(roomId);
			if (sockets === undefined) joined.set(roomId, (sockets = new Map()));
			sockets.set(socket.id, admission.key);
			deps.onRoster?.(roomId);
		},
		onLeave(socket) {
			const roomId = lobbyRoomOf.get(socket);
			const sockets = roomId === undefined ? undefined : joined.get(roomId);
			if (roomId === undefined || sockets === undefined || !sockets.delete(socket.id)) return;
			if (sockets.size === 0) joined.delete(roomId);
			deps.onRoster?.(roomId);
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

	return Object.assign(served, {
		here(roomId: string): ReadonlySet<string> {
			const here = new Set<string>();
			// Live on the tracker too, as the chat's roster reads it: a connection gone silent is not here.
			for (const [socketId, key] of joined.get(roomId) ?? []) if (deps.presence.keyOf(socketId) === key) here.add(key);
			return here;
		},
	});
}
