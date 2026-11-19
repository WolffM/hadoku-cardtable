/**
 * Who a person is and what they look like, from hadoku_site's prefs-api: their
 * live display name, their avatar picture and the cosmetics they wear. One
 * batched call (`resolveAvatars`) answers all three by userId.
 *
 * The operator, 2026-11-05: *"picture/character are the same thing and all
 * over the entire site it's the same avatar. we must display all
 * customizations everywhere."* A person picks all of it in the fleet's avatar
 * settings, never here; this module only reads it.
 *
 * Resolved with this server's own service key, through prefs-client's shared
 * people lookup (`createPeopleLookup`). A failure answers nobody and is logged,
 * never thrown: a missing look costs a face its dressing, not a join. Cached a
 * minute, so a room's joins share one lookup; a person who has
 * just changed theirs is read `fresh` (the served room's `account`, `room/serve.ts`).
 * The picture URL is relayed, never fetched: the browser loads it from
 * Discord, Steam or cdn.hadoku.me, all inside hadoku.me's img-src.
 */

import type { ResolvedPerson } from '@wolffm/prefs-client/avatar';
import { createPeopleLookup } from '@wolffm/prefs-client/people';
import { cleanWorn } from '@wolffm/prefs-client/cosmetics';
import { AVATAR_ID_MAX, LOOK_PICTURE_MAX, lookOrNone, type Look, type PersonFace } from '@hadoku/platform-wire/look';

/** One person, as a screen shows them. */
export interface Person {
	/** Their display name now; null for an unknown or closed account. */
	name: string | null;
	/**
	 * Their watchparty character. prefs-api answers one for every account, drawing and keeping one for an
	 * account that never picked, so null only when an answer carried none.
	 */
	sprite: string | null;
	look: Look | undefined;
}

export interface People {
	/** Every id in the answer; one the lookup could not reach is absent, not a default. */
	resolve(userIds: readonly string[], opts?: { fresh?: boolean }): Promise<Map<string, Person>>;
	/** The cached answer for one id, or undefined when there is none fresh. */
	peek(userId: string): Person | undefined;
}

/** What account erase asks of the lookup, beside what everyone else does. */
export interface ForgetfulPeople extends People {
	/** Drop the cached answer for one id; 1 when one was held, else 0. */
	forget(userId: string): number;
}

export interface PeopleOptions {
	baseUrl: string;
	serviceKey: string;
	/** Look people up with no key: only the e2e stand-in answers that. Default: only with a key. */
	keyless?: boolean;
	log: (entry: Record<string, unknown>) => void;
	now?: () => number;
	fetch?: typeof fetch;
}

const CACHE_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 5000;

/** What one resolved entry means here. Exported for its test. */
export function personOf(r: ResolvedPerson | undefined): Person {
	const picture = r !== undefined && r.source !== 'sprite' && typeof r.url === 'string' && r.url.startsWith('https://') && r.url.length <= LOOK_PICTURE_MAX ? r.url : undefined;
	const cosmetics = cleanWorn(r?.cosmetics);
	return {
		name: typeof r?.name === 'string' && r.name.trim() !== '' ? r.name : null,
		sprite: typeof r?.sprite === 'string' && r.sprite.trim() !== '' && r.sprite.length <= AVATAR_ID_MAX ? r.sprite : null,
		look: lookOrNone({ ...(picture === undefined ? {} : { picture }), ...(cosmetics === undefined ? {} : { cosmetics }) }),
	};
}

/**
 * The lookup is prefs-client's (`createPeopleLookup`, the one every hadoku server shows people
 * through: watchparty's too): cached a minute, one lookup per id at a time, a failure answers
 * nobody and is not cached, and no key means no lookups. This adds only cardtable's reading of
 * an answer (`personOf`).
 */
export function createPeople(opts: PeopleOptions): ForgetfulPeople {
	const lookup = createPeopleLookup({
		baseUrl: opts.baseUrl,
		serviceKey: opts.serviceKey,
		...(opts.keyless === true ? { keyless: true } : {}),
		userAgent: 'hadoku-cardtable-people/1',
		ttlMs: CACHE_TTL_MS,
		timeoutMs: LOOKUP_TIMEOUT_MS,
		onError: (err, ids) => opts.log({ evt: 'people-resolve-failed', ids: ids.length, error: (err as Error).message }),
		...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
		...(opts.now === undefined ? {} : { now: opts.now }),
	});
	const peek = (userId: string): Person | undefined => {
		const hit = lookup.peek(userId);
		return hit === undefined ? undefined : personOf(hit ?? undefined);
	};
	return {
		peek,
		forget: (userId) => lookup.forget(userId),
		async resolve(userIds, options = {}) {
			const out = new Map<string, Person>();
			for (const [id, answer] of await lookup.resolve(userIds, options)) out.set(id, personOf(answer ?? undefined));
			return out;
		},
	};
}

/** What a person is written into: the room registry (`room/lobby.ts`'s `Lobby`). */
interface PersonRooms {
	get(roomId: string): { members: readonly { id: string }[] } | undefined;
	rename(caller: { id: string; name: string }): void;
	setAvatar(roomId: string, memberId: string, avatarId: string | null): boolean;
	setLook(roomId: string, memberId: string, look: Look | undefined): boolean;
}

/**
 * Write `person` onto member `memberId` of `roomId`: their name in every room they are in, their
 * character and their look in this one. The account is the one source of all three (the operator,
 * 2026-11-05: *"all over the entire site it's the same avatar"*); a field the lookup has no answer
 * for leaves what the room already holds.
 */
export function applyPerson(rooms: PersonRooms, roomId: string, memberId: string, person: Person): void {
	if (rooms.get(roomId)?.members.some((m) => m.id === memberId) !== true) return;
	if (person.name !== null) rooms.rename({ id: memberId, name: person.name });
	if (person.sprite !== null) rooms.setAvatar(roomId, memberId, person.sprite);
	rooms.setLook(roomId, memberId, person.look);
}

/** What `attachPeople` needs of the room registry. */
export interface PeopleRooms extends PersonRooms {
	onChange(listener: (roomId: string) => void): () => void;
	/** The rooms people have open now (`Lobby.offered`). */
	offered(): readonly { id: string }[];
	usersOf(roomId: string): { memberId: string; userId: string }[];
}

/**
 * Every member of a room that changes is written from their account (`applyPerson`, from the
 * cache mostly), so a joiner and a member a restart left unnamed (R12) are named and dressed
 * whether or not they have the room open. A change made while the room IS open reaches it live
 * through the served room (`room/serve.ts`); `sweep` is the boot's one read of the restored rooms,
 * and `arrived` reads one person fresh as they come into a room, so a change made since the
 * cache's last answer is what the room gets (as the served room re-reads an account on its join).
 */
export function attachPeople(
	rooms: PeopleRooms,
	people: People,
): { sweep(): Promise<void>; arrived(roomId: string, memberId: string, userId: string): Promise<void>; stop(): void } {
	const write = async (open: readonly string[]): Promise<void> => {
		const users = open.map((roomId) => ({ roomId, users: rooms.usersOf(roomId) }));
		const found = await people.resolve(users.flatMap((r) => r.users.map((u) => u.userId)));
		for (const r of users) {
			for (const { memberId, userId } of r.users) {
				const person = found.get(userId);
				if (person !== undefined) applyPerson(rooms, r.roomId, memberId, person);
			}
		}
	};
	const stop = rooms.onChange((roomId) => void write([roomId]));
	const arrived = async (roomId: string, memberId: string, userId: string): Promise<void> => {
		const person = (await people.resolve([userId], { fresh: true })).get(userId);
		if (person !== undefined) applyPerson(rooms, roomId, memberId, person);
	};
	return { sweep: () => write(rooms.offered().map((r) => r.id)), arrived, stop };
}

/** How a person is drawn in a record of the past: their character and their look, as they are now. */
export function faceOfPerson(person: Person | undefined): PersonFace {
	if (person === undefined) return {};
	return { ...(person.sprite === null ? {} : { avatarId: person.sprite }), ...(person.look === undefined ? {} : { look: person.look }) };
}
