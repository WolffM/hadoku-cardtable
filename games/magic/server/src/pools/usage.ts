/**
 * How much each cube and set is played, for the cube and set listings (`GET /api/pools/cubes`,
 * `GET /api/pools/sets`) to sort by: drafts recorded from it and matches played from it.
 *
 *   drafts   the server's own draft record (`history/`'s `countBySource()`), read on every listing:
 *            it is in memory, so a draft that just ended counts on the next listing.
 *   matches  game-stats, from each finished match's `cube` / `set` attr (`stats/report.ts`). Read
 *            at most every {@link USAGE_TTL_MS}, newest first and only back to the newest match
 *            already counted, so a refresh after the first costs a page.
 *
 * ## Matches, not seats
 *
 * game-stats' `breakdown(attr)` cannot count these. It groups by a SEAT attr
 * (`json_each(p.attrs, '$.<attr>')` over `game_match_players`, prefs-api `games/store.ts`) and
 * totals `COUNT(*)` of seat rows, so a match attr such as `cube` never forms a row, and a seat attr
 * would count a two-seat match twice. `matches({ player: '*', match: { source } })` reads matches,
 * one row each, filtered on the match attr the report writes; this module tallies their `cube` and
 * `set` attrs itself.
 *
 * ## An outage is not a failed listing
 *
 * A game-stats read that fails, or takes longer than {@link USAGE_WAIT_MS}, is logged
 * (`pool-usage-stats-failed`) and the listing answers with the matches counted so far: zero on a
 * cold start, the last good count after one. Drafts never depend on game-stats.
 */

import type { PoolUsage } from '@hadoku/shared';
import { createGameStatsClient, type MatchView, type StatAttrs } from '@wolffm/prefs-client/games';

/** The slice of the draft record (`history/`'s `DraftRecordStore`) this module reads. */
export interface DraftCounts {
	/** `cube:<id>` | `set:<code>` → drafts completed from it, and the newest one's `endedAt`. */
	countBySource(): ReadonlyMap<string, { drafts: number; lastAt: number }>;
}

/** The slice of game-stats' client this module reads: one page of matches, newest first. */
export interface MatchPages {
	matches(scope: {
		player: '*';
		match?: Readonly<Record<string, readonly string[]>>;
		limit?: number;
		before?: number;
	}): Promise<{ matches: readonly Pick<MatchView, 'matchId' | 'endedAt' | 'attrs'>[]; nextBefore: number | null }>;
}

export interface PoolUsageSource {
	/** Every pool anything was counted for, by pool key. Never rejects. */
	usage(): Promise<ReadonlyMap<string, PoolUsage>>;
}

/** How long a matches count is answered before game-stats is read again. */
export const USAGE_TTL_MS = 5 * 60_000;
/** How long a listing waits on game-stats before it answers with what it has. */
export const USAGE_WAIT_MS = 3_000;
/** A page of game-stats' matches, at its own most. */
const PAGE = 50;
/** A refresh reads at most this many pages (10,000 matches) and logs when it stops short. */
const MAX_PAGES = 200;
/** The match sources (`stats/report.ts`'s `source` attr) that can name a cube or a set. */
const COUNTED_SOURCES = ['cube', 'set', 'custom'] as const;

export const NO_USAGE: PoolUsage = { drafts: 0, matches: 0, lastPlayedAt: null };

/** A match's pool keys, from the attrs the match report writes. */
function poolKeysOf(attrs: StatAttrs): string[] {
	const keys: string[] = [];
	if (typeof attrs.cube === 'string' && attrs.cube !== '') keys.push(`cube:${attrs.cube}`);
	if (typeof attrs.set === 'string' && attrs.set !== '') keys.push(`set:${attrs.set}`);
	return keys;
}

export interface CreatePoolUsageOpts {
	drafts: DraftCounts;
	/** `null`: no game-stats to read (no service key); every match count is 0. */
	stats: MatchPages | null;
	log: (entry: Record<string, unknown>) => void;
	now?: () => number;
	ttlMs?: number;
	waitMs?: number;
}

export function createPoolUsage(opts: CreatePoolUsageOpts): PoolUsageSource {
	const now = opts.now ?? Date.now;
	const ttlMs = opts.ttlMs ?? USAGE_TTL_MS;
	const waitMs = opts.waitMs ?? USAGE_WAIT_MS;

	const matches = new Map<string, { matches: number; lastAt: number }>();
	/** The newest `endedAt` counted, and the match ids that ended exactly then: where the next refresh stops. */
	let watermark: number | null = null;
	let atWatermark = new Set<string>();
	let readAt: number | null = null;
	let inFlight: Promise<void> | null = null;

	const counted = (m: Pick<MatchView, 'matchId' | 'endedAt'>): boolean =>
		watermark !== null && (m.endedAt < watermark || (m.endedAt === watermark && atWatermark.has(m.matchId)));

	/** Every match newer than the watermark, tallied and only then kept: a read that fails part-way counts nothing twice. */
	async function readMatches(stats: MatchPages): Promise<void> {
		const tally = new Map<string, { matches: number; lastAt: number }>();
		let newest = watermark;
		let newestIds = new Set(atWatermark);
		let before: number | undefined;
		let pages = 0;
		read: for (;;) {
			const page = await stats.matches({ player: '*', match: { source: COUNTED_SOURCES }, limit: PAGE, ...(before === undefined ? {} : { before }) });
			for (const m of page.matches) {
				if (counted(m)) {
					if (m.endedAt < watermark!) break read;
					continue;
				}
				if (newest === null || m.endedAt > newest) {
					newest = m.endedAt;
					newestIds = new Set([m.matchId]);
				} else if (m.endedAt === newest) newestIds.add(m.matchId);
				for (const key of poolKeysOf(m.attrs)) {
					const t = tally.get(key) ?? { matches: 0, lastAt: 0 };
					tally.set(key, { matches: t.matches + 1, lastAt: Math.max(t.lastAt, m.endedAt) });
				}
			}
			if (page.nextBefore === null || (before !== undefined && page.nextBefore >= before)) break;
			if (++pages >= MAX_PAGES) {
				opts.log({ evt: 'pool-usage-pages-capped', pages });
				break;
			}
			before = page.nextBefore;
		}
		for (const [key, t] of tally) {
			const was = matches.get(key) ?? { matches: 0, lastAt: 0 };
			matches.set(key, { matches: was.matches + t.matches, lastAt: Math.max(was.lastAt, t.lastAt) });
		}
		watermark = newest;
		atWatermark = newestIds;
	}

	/** A refresh when the count is older than the TTL, shared by every listing that asks meanwhile. Never rejects. */
	function refresh(stats: MatchPages): Promise<void> {
		if (inFlight !== null) return inFlight;
		if (readAt !== null && now() - readAt < ttlMs) return Promise.resolve();
		inFlight = readMatches(stats)
			.catch((err: unknown) => opts.log({ evt: 'pool-usage-stats-failed', error: (err as Error).message }))
			.finally(() => {
				readAt = now();
				inFlight = null;
			});
		return inFlight;
	}

	/** `refresh`, or `waitMs`, whichever ends first. A refresh still running carries on for the next listing. */
	async function freshEnough(stats: MatchPages): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<'late'>((done) => {
			timer = setTimeout(() => done('late'), waitMs);
			timer.unref?.();
		});
		const outcome = await Promise.race([refresh(stats).then(() => 'read' as const), late]);
		clearTimeout(timer);
		if (outcome === 'late') opts.log({ evt: 'pool-usage-stats-failed', error: `no answer in ${waitMs} ms` });
	}

	return {
		async usage() {
			if (opts.stats !== null) await freshEnough(opts.stats);
			const out = new Map<string, PoolUsage>();
			const add = (key: string, drafts: number, matchCount: number, at: number): void => {
				const was = out.get(key) ?? NO_USAGE;
				const last = Math.max(was.lastPlayedAt ?? 0, at);
				out.set(key, { drafts: was.drafts + drafts, matches: was.matches + matchCount, lastPlayedAt: last > 0 ? last : null });
			};
			for (const [key, d] of opts.drafts.countBySource()) add(key, d.drafts, 0, d.lastAt);
			for (const [key, m] of matches) add(key, 0, m.matches, m.lastAt);
			return out;
		},
	};
}

/** Each listed pool with its usage, {@link NO_USAGE} for one nothing was counted for. */
export function joinUsage<T extends object>(items: readonly T[], keyOf: (item: T) => string, usage: ReadonlyMap<string, PoolUsage>): (T & { usage: PoolUsage })[] {
	return items.map((item) => ({ ...item, usage: usage.get(keyOf(item)) ?? NO_USAGE }));
}

/**
 * game-stats' matches as this server reads them: its service key on every read. `null` without a
 * key, which is how a dev server runs: the listing then counts drafts only.
 */
export function gameStatsMatchPages(opts: { serviceKey: string; baseUrl: string; fetch?: typeof fetch }): MatchPages | null {
	if (opts.serviceKey === '') return null;
	const base = opts.fetch ?? fetch;
	return createGameStatsClient({
		gameId: 'cardtable',
		baseUrl: opts.baseUrl,
		fetch: (input, init) => base(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), 'X-User-Key': opts.serviceKey } }),
	});
}
