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
 * just changed theirs asks for a `fresh` read (`POST /api/rooms/:id/identity`).
 * The picture URL is relayed, never fetched: the browser loads it from
 * Discord, Steam or cdn.hadoku.me, all inside hadoku.me's img-src.
 */

import { resolveAvatars, type ResolvedPerson } from '@wolffm/prefs-client/avatar';
import { cleanWorn } from '@wolffm/prefs-client/cosmetics';
import { AVATAR_ID_MAX, LOOK_PICTURE_MAX, lookOrNone, type Look, type PersonFace } from '@hadoku/shared';

/** One person, as a screen shows them. */
export interface Person {
	/** Their display name now; null for an unknown or closed account. */
	name: string | null;
	/** Their watchparty character; null when they never picked one. A room hands its own out; a record of the past has only this. */
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

/** What `attachLooks` needs of the room registry (`room/lobby.ts`'s `Lobby`). */
export interface LookRooms {
	onChange(listener: (roomId: string) => void): () => void;
	/** The rooms people have open now (`Lobby.offered`): the ones whose looks are kept current. */
	offered(): readonly { id: string }[];
	get(roomId: string): { members: readonly { id: string; name: string }[] } | undefined;
	usersOf(roomId: string): { memberId: string; userId: string }[];
	setLook(roomId: string, memberId: string, look: Look | undefined): boolean;
	rename(caller: { id: string; name: string }): void;
}

export interface Looks {
	/** Read `memberId`'s look again now, skipping the cache: they have just changed it. */
	refresh(roomId: string, memberId: string): Promise<void>;
	/** Read every open room's members again, in one batch: a look changed in the fleet's popout reaches the table. */
	sweep(): Promise<void>;
	stop(): void;
}

/** How often every open room's looks are read again: the cache's own minute. */
export const LOOK_SWEEP_MS = 60_000;

/**
 * Keep every member's look current: whenever a room changes, its members are
 * resolved (from the cache, mostly) and what moved is set on the room; and the
 * name of a member a restart left `unnamed`, since a saved room keeps no names
 * (R12). The character is not set here: the browser asserts it the moment it
 * changes (`apps/ui/src/room/avatarAssert.ts`), and a minute-old cached answer
 * set from here would put the old one back.
 * Setting a look fires the room's change again, which then finds nothing to do.
 * Every minute (`sweep`) the open rooms are read again, all in one batch, so a
 * change made away from any room still reaches the table.
 */
export function attachLooks(rooms: LookRooms, people: People, unnamed: string, opts: { sweepMs?: number } = {}): Looks {
	const set = (roomId: string, users: readonly { memberId: string; userId: string }[], found: Map<string, Person>): void => {
		for (const { memberId, userId } of users) {
			const person = found.get(userId);
			if (person === undefined) continue;
			const member = rooms.get(roomId)?.members.find((m) => m.id === memberId);
			if (member === undefined) continue;
			if (person.name !== null && member.name === unnamed) rooms.rename({ id: memberId, name: person.name });
			rooms.setLook(roomId, memberId, person.look);
		}
	};
	const apply = async (roomId: string, only: string | null, fresh: boolean): Promise<void> => {
		const users = rooms.usersOf(roomId).filter((u) => only === null || u.memberId === only);
		if (users.length === 0) return;
		set(roomId, users, await people.resolve(users.map((u) => u.userId), { fresh }));
	};
	const sweep = async (): Promise<void> => {
		const open = rooms.offered().map((r) => ({ roomId: r.id, users: rooms.usersOf(r.id) }));
		const found = await people.resolve(open.flatMap((r) => r.users.map((u) => u.userId)));
		for (const r of open) set(r.roomId, r.users, found);
	};
	const stopChanges = rooms.onChange((roomId) => void apply(roomId, null, false));
	const timer = setInterval(() => void sweep(), opts.sweepMs ?? LOOK_SWEEP_MS);
	timer.unref();
	return {
		refresh: (roomId, memberId) => apply(roomId, memberId, true),
		sweep,
		stop: () => {
			clearInterval(timer);
			stopChanges();
		},
	};
}

/** How a person is drawn in a record of the past: their character and their look, as they are now. */
export function faceOfPerson(person: Person | undefined): PersonFace {
	if (person === undefined) return {};
	return { ...(person.sprite === null ? {} : { avatarId: person.sprite }), ...(person.look === undefined ? {} : { look: person.look }) };
}
