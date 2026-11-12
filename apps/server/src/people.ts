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
 * Resolved with this server's own service key. A failure answers nobody and
 * is logged, never thrown: a missing look costs a face its dressing, not a
 * join. Cached a minute, so a room's joins share one lookup; a person who has
 * just changed theirs is read `fresh` (the served room's `account`, `room/serve.ts`).
 * The picture URL is relayed, never fetched: the browser loads it from
 * Discord, Steam or cdn.hadoku.me, all inside hadoku.me's img-src.
 */

import { resolveAvatars, type ResolvedPerson } from '@wolffm/prefs-client/avatar';
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
const CACHE_PRUNE_THRESHOLD = 1024;
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

/** No key, no lookups: every answer is empty and nothing is called. */
export function createPeople(opts: PeopleOptions): ForgetfulPeople {
	const now = opts.now ?? Date.now;
	const cache = new Map<string, { person: Person; expiresAt: number }>();
	const baseUrl = opts.baseUrl.replace(/\/+$/, '');
	// hadoku.me's WAF challenges a bare client user-agent, and a lookup that
	// never answers must not hold a join's promise open.
	const lookupFetch: typeof fetch = (input, init) =>
		(opts.fetch ?? fetch)(input, {
			...init,
			headers: { ...(init?.headers as Record<string, string> | undefined), 'User-Agent': 'hadoku-cardtable-people/1' },
			signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
		});
	let inflight: Promise<void> = Promise.resolve();

	const peek = (userId: string): Person | undefined => {
		const hit = cache.get(userId);
		return hit !== undefined && hit.expiresAt > now() ? hit.person : undefined;
	};

	return {
		peek,
		forget: (userId) => (cache.delete(userId) ? 1 : 0),
		async resolve(userIds, { fresh = false } = {}) {
			const out = new Map<string, Person>();
			const missing: string[] = [];
			for (const id of new Set(userIds)) {
				const hit = fresh ? undefined : peek(id);
				if (hit !== undefined) out.set(id, hit);
				else missing.push(id);
			}
			if (missing.length === 0 || (opts.serviceKey === '' && opts.keyless !== true)) return out;
			// One lookup at a time: a burst of joins after a restart asks once per
			// id rather than once per join.
			const run = inflight.then(async () => {
				const still = fresh ? missing : missing.filter((id) => peek(id) === undefined);
				if (still.length === 0) return;
				try {
					const answer = await resolveAvatars({ baseUrl, serviceKey: opts.serviceKey, fetch: lookupFetch }, still);
					const at = now();
					for (const id of still) cache.set(id, { person: personOf(answer[id]), expiresAt: at + CACHE_TTL_MS });
					if (cache.size > CACHE_PRUNE_THRESHOLD) for (const [k, e] of cache) if (e.expiresAt <= at) cache.delete(k);
				} catch (err) {
					opts.log({ evt: 'people-resolve-failed', ids: still.length, error: (err as Error).message });
				}
			});
			inflight = run;
			await run;
			for (const id of missing) {
				const hit = cache.get(id);
				if (hit !== undefined) out.set(id, hit.person);
			}
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
