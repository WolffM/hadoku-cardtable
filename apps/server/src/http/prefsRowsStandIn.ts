/**
 * prefs-api's `_service/:app/rows` routes, held in memory, for the server's tests and the e2e edge. Not
 * imported by the server itself, so it never reaches the bundle.
 *
 * The contract is hadoku_site `workers/prefs-api/src/routes/service.ts` (f56acf8e):
 *   POST /api/v1/_service/:app/rows/:appId/read  { userIds } → { rows, next: null }
 *                                                { limit?, after? } → { rows, next } (by userId)
 *   PUT  /api/v1/_service/:app/rows/:appId       { userKey, patch, expectedVersion? }
 *        → { blob, version, updatedAt } | 403 (a key that signs nobody in) | 409 { current }
 * An appId outside `app` / `app-*` is 403, and so is a caller without the service key, which is what
 * the edge's `prefs-<app>` allow list does in front of the real one. Patches merge shallowly.
 *
 * And people, as `workers/prefs-api/src/routes/avatar.ts` resolves them for a server:
 *   POST /api/v1/_avatar/resolve  { userIds } → { avatars: { [userId]: ResolvedPerson } }
 * every id answered, an unknown one `{ source: 'sprite', name }` with the name `nameOf` gives (null without it). What a person looks like is
 * set by a spec through a route the real one does not have, by their key, as their own popout would:
 *   PUT  /api/v1/_stand-in/avatar { userKey, avatar } → { ok: true }
 *
 * And the caller's OWN avatar, as `@wolffm/prefs-client/avatar`'s `createAvatarClient().get()`
 * reads it directly from the BROWSER (the room chrome's own read of the viewer's character):
 *   GET /api/v1/_avatar → AvatarSettings, keyed by `headers.key` the same way `_stand-in/avatar`'s
 *   PUT is keyed by `userKey` — both resolve through `userOfKey`. No session (`key` null or unknown):
 *   403. Nothing picked: the same `{ source: 'sprite', name: null }` fallback as resolve, `sprite: null`.
 * And the fleet settings popout's own write (`@wolffm/task-ui-components`' AvatarPicker, a character pressed):
 *   PUT /api/v1/_avatar { source?, sprite? } → AvatarSettings, the same person `_stand-in/avatar` dresses.
 * Nothing is linked or uploaded, and nothing is worn: the popout draws the character tab and no more.
 */

import type { AvatarSettings } from '@wolffm/prefs-client/avatar';
import { emptyLoadout } from '@wolffm/prefs-client/cosmetics';

export interface PrefsRowsStandIn {
	/** Answer one request; null when the path is not a `_service/:app/rows` route. */
	handle(method: string, path: string, headers: { key: string | null }, body: unknown): { status: number; json: unknown } | null;
	/** The rows of one app, by userId. */
	rows(appId: string): Map<string, { blob: Record<string, unknown>; version: number; updatedAt: number }>;
}

const AVATAR_RESOLVE = '/api/v1/_avatar/resolve';
const AVATAR_OWN = '/api/v1/_avatar';
const AVATAR_SET = '/api/v1/_stand-in/avatar';

/** What `AVATAR_SET` stores, as far as `AVATAR_OWN` reads it back: `ResolvedAvatar`'s own three fields. */
interface StoredAvatar {
	source?: unknown;
	url?: unknown;
	sprite?: unknown;
}

export function createPrefsRowsStandIn(opts: {
	app: string;
	serviceKey: string;
	/** A person's live key → their userId. */
	userOfKey: (key: string) => string | null;
	/** A person's display name by userId, as the real one answers it from the registry. */
	nameOf?: (userId: string) => string | null;
}): PrefsRowsStandIn {
	const store = new Map<string, Map<string, { blob: Record<string, unknown>; version: number; updatedAt: number }>>();
	const rowsOf = (appId: string) => {
		let rows = store.get(appId);
		if (rows === undefined) store.set(appId, (rows = new Map()));
		return rows;
	};
	const route = new RegExp(`^/api/v1/_service/${opts.app}/rows/([a-z0-9-]+)(/read)?$`);
	const people = new Map<string, unknown>();
	return {
		rows: rowsOf,
		handle(method, path, headers, body) {
			const b0 = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
			if (path === AVATAR_RESOLVE && method === 'POST') {
				if (headers.key !== opts.serviceKey) return { status: 403, json: { error: 'forbidden', required: 'service' } };
				const ids = Array.isArray(b0.userIds) ? b0.userIds.filter((id): id is string => typeof id === 'string') : [];
				return { status: 200, json: { avatars: Object.fromEntries(ids.map((id) => [id, people.get(id) ?? { source: 'sprite', name: opts.nameOf?.(id) ?? null }])) } };
			}
			if (path === AVATAR_OWN && (method === 'GET' || method === 'PUT')) {
				const userId = headers.key !== null ? opts.userOfKey(headers.key) : null;
				if (userId === null) return { status: 403, json: { error: 'Forbidden', message: 'No session' } };
				const prev = (people.get(userId) ?? { source: 'sprite', name: null }) as StoredAvatar;
				const stored = method === 'PUT' ? { ...prev, ...b0 } : prev;
				if (method === 'PUT') people.set(userId, stored);
				const sprite = typeof stored.sprite === 'string' ? stored.sprite : null;
				const source = (stored.source ?? 'sprite') as AvatarSettings['avatar']['source'];
				const settings: AvatarSettings = {
					avatar: { source, ...(typeof stored.url === 'string' ? { url: stored.url } : {}), ...(sprite !== null ? { sprite } : {}) },
					choice: sprite !== null ? source : null,
					sprite,
					linked: {},
					upload: null,
					providers: { discord: false, steam: false },
					limits: { maxBytes: 0, minDimension: 0, maxDimension: 0, acceptedTypes: [], perDay: 0, outputSize: 0 },
					cosmetics: { owned: [], loadout: emptyLoadout() },
				};
				return { status: 200, json: settings };
			}
			if (path === AVATAR_SET && method === 'PUT') {
				const userId = typeof b0.userKey === 'string' ? opts.userOfKey(b0.userKey) : null;
				if (userId === null) return { status: 403, json: { error: 'Forbidden', message: 'That key does not sign anyone in' } };
				people.set(userId, b0.avatar);
				return { status: 200, json: { ok: true } };
			}
			const m = route.exec(path);
			if (m === null) return null;
			if (headers.key !== opts.serviceKey) return { status: 403, json: { error: 'forbidden', required: 'service' } };
			const appId = m[1]!;
			if (appId !== opts.app && !appId.startsWith(`${opts.app}-`)) return { status: 403, json: { error: 'Forbidden', message: `Not ${opts.app}'s app` } };
			const rows = rowsOf(appId);
			const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
			if (m[2] === '/read' && method === 'POST') {
				const view = ([userId, row]: [string, { blob: Record<string, unknown>; version: number; updatedAt: number }]) => ({ userId, ...row });
				if (Array.isArray(b.userIds)) {
					const ids = b.userIds.filter((id): id is string => typeof id === 'string');
					return { status: 200, json: { rows: ids.flatMap((id) => (rows.has(id) ? [view([id, rows.get(id)!])] : [])), next: null } };
				}
				const limit = typeof b.limit === 'number' && b.limit > 0 ? Math.floor(b.limit) : 200;
				const after = typeof b.after === 'string' ? b.after : '';
				const sorted = [...rows.entries()].sort(([a], [z]) => (a < z ? -1 : 1)).filter(([id]) => id > after);
				const page = sorted.slice(0, limit);
				return { status: 200, json: { rows: page.map(view), next: sorted.length > limit ? page.at(-1)![0] : null } };
			}
			if (m[2] === undefined && method === 'PUT') {
				if (typeof b.userKey !== 'string') return { status: 400, json: { error: 'Bad Request', message: 'userKey is required' } };
				if (typeof b.patch !== 'object' || b.patch === null || Array.isArray(b.patch)) return { status: 400, json: { error: 'Bad Request', message: 'patch must be a JSON object' } };
				const userId = opts.userOfKey(b.userKey);
				if (userId === null) return { status: 403, json: { error: 'Forbidden', message: 'That key does not sign anyone in' } };
				const prev = rows.get(userId);
				if (typeof b.expectedVersion === 'number' && b.expectedVersion !== (prev?.version ?? 0)) {
					return { status: 409, json: { error: 'Conflict', current: prev ?? null } };
				}
				const row = { blob: { ...(prev?.blob ?? {}), ...(b.patch as Record<string, unknown>) }, version: (prev?.version ?? 0) + 1, updatedAt: Date.now() };
				rows.set(userId, row);
				return { status: 200, json: row };
			}
			return { status: 404, json: { error: 'Not Found' } };
		},
	};
}

/** The stand-in as a `fetch`, for a prefs client pointed at `base`. */
export function standInFetch(standIn: PrefsRowsStandIn, base: string): typeof fetch {
	return async (input, init) => {
		const url = new URL(String(input));
		const path = url.pathname.slice(new URL(base).pathname.replace(/\/$/, '').length);
		const key = new Headers(init?.headers).get('x-user-key');
		const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
		const out = standIn.handle(init?.method ?? 'GET', path, { key }, body) ?? { status: 404, json: { error: 'Not Found' } };
		return new Response(JSON.stringify(out.json), { status: out.status, headers: { 'content-type': 'application/json' } });
	};
}
