/**
 * One-time backfill of "last played" (wave 125): read the match history this server has been
 * reporting to prefs-api's game-stats store, and stamp each person's deck in their own document
 * in the per-person store (`users/`), as the server stamps a finished match from now on
 * (`stats/index.ts`). It READS our history out of Cloudflare once; nothing is written there.
 *
 * The history names a seat by its registry name, never its userId. So the people are the ones
 * this site has seen (`callers-seen.json`), named now by the same lookup the server uses, and a
 * seat is stamped only when its name is exactly one of them. A name two people share, or a name
 * nobody seen has, is counted and left.
 *
 * A stamp never moves backwards: a deck the server has already stamped later keeps its stamp.
 * Nothing is written without `--write`: without it the run prints what it would stamp and stops.
 *
 *   tsx games/magic/server/src/cli/backfill-last-played.ts --site prod|ppe [--write]
 *       [--key-file <.devvault.local.json>] [--prefs <base url>]
 *
 * `--site` reads `$CARDTABLE_STATE_ROOT` (default `~/srv-data`), the root hadoku_site's PM2 wrapper
 * gives each site. The service key comes from the main checkout's `.devvault.local.json` and is
 * never printed.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createGameStatsClient, type MatchView } from '@wolffm/prefs-client/games';
import { createPeople } from '@hadoku/game-server/people';
import { createMagicUserStore } from '../users/index.js';

const SITES = { prod: 'cardtable', ppe: 'cardtable-ppe' } as const;
const PAGE = 50;
const NAME_BATCH = 100;

/** Per userId, per deck id, the newest `endedAt` the history has them playing it. */
export type Stamps = Map<string, Map<string, number>>;

export interface BackfillCounts {
	matches: number;
	/** Seats with a deck id, a person's (not the AI's). */
	seats: number;
	stamped: number;
	/** Seats whose name is nobody seen here. */
	unknownName: number;
	/** Seats whose name two or more people seen here share. */
	ambiguousName: number;
}

/**
 * The stamps a history gives, by name → userId. `userIdsOf(name)` answers every userId that name
 * is now (empty for nobody). A seat is the AI's when its kind is `bot`.
 */
export function stampsFromHistory(matches: readonly MatchView[], userIdsOf: (name: string) => readonly string[]): { stamps: Stamps; counts: BackfillCounts } {
	const stamps: Stamps = new Map();
	const counts: BackfillCounts = { matches: matches.length, seats: 0, stamped: 0, unknownName: 0, ambiguousName: 0 };
	for (const match of matches) {
		for (const seat of match.seats) {
			const deckId = seat.attrs.deckId;
			if (seat.kind === 'bot' || typeof deckId !== 'string' || deckId === '') continue;
			counts.seats++;
			const ids = seat.name === null ? [] : userIdsOf(seat.name);
			if (ids.length === 0) {
				counts.unknownName++;
				continue;
			}
			if (ids.length > 1) {
				counts.ambiguousName++;
				continue;
			}
			const userId = ids[0]!;
			const decks = stamps.get(userId) ?? new Map<string, number>();
			stamps.set(userId, decks);
			decks.set(deckId, Math.max(match.endedAt, decks.get(deckId) ?? 0));
			counts.stamped++;
		}
	}
	return { stamps, counts };
}

/** Every match in the store, newest first, page by page. */
async function allMatches(client: ReturnType<typeof createGameStatsClient>): Promise<MatchView[]> {
	const out: MatchView[] = [];
	let before: number | undefined;
	for (;;) {
		const page = await client.matches({ player: '*', limit: PAGE, ...(before === undefined ? {} : { before }) });
		out.push(...page.matches);
		if (page.nextBefore === null || page.matches.length === 0) return out;
		before = page.nextBefore;
	}
}

function fail(message: string): never {
	console.error(`backfill-last-played: ${message}`);
	process.exit(1);
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			site: { type: 'string' },
			write: { type: 'boolean', default: false },
			'key-file': { type: 'string', default: join(homedir(), 'repos', 'hadoku-cardtable', '.devvault.local.json') },
			prefs: { type: 'string', default: process.env.CARDTABLE_PREFS_BASE_URL ?? 'https://hadoku.me/prefs' },
		},
	});
	const site = values.site;
	if (site === undefined || !(site in SITES)) fail('say which site: --site prod|ppe');
	const dataDir = join(process.env.CARDTABLE_STATE_ROOT ?? join(homedir(), 'srv-data'), SITES[site as keyof typeof SITES]);
	const key = (JSON.parse(await readFile(values['key-file'], 'utf8')) as { key?: unknown }).key;
	if (typeof key !== 'string' || key === '') fail(`no service key in ${values['key-file']}`);

	// The people this site has seen, named now.
	const seen = JSON.parse(await readFile(join(dataDir, 'callers-seen.json'), 'utf8')) as string[];
	const people = createPeople({ baseUrl: values.prefs, serviceKey: key, log: (e) => console.error('people:', JSON.stringify(e)) });
	const byName = new Map<string, string[]>();
	for (let i = 0; i < seen.length; i += NAME_BATCH) {
		const found = await people.resolve(seen.slice(i, i + NAME_BATCH));
		for (const [userId, person] of found) if (person.name !== null) byName.set(person.name, [...(byName.get(person.name) ?? []), userId]);
	}

	// The history, read with the service key; the stats client sends a browser's cookies otherwise.
	const client = createGameStatsClient({
		gameId: 'cardtable',
		baseUrl: values.prefs,
		fetch: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), 'X-User-Key': key, 'User-Agent': 'hadoku-cardtable-backfill/1' } }),
	});
	const matches = await allMatches(client);
	const { stamps, counts } = stampsFromHistory(matches, (name) => byName.get(name) ?? []);

	const deckStamps = [...stamps.values()].reduce((n, decks) => n + decks.size, 0);
	console.log(`site ${site}: ${seen.length} people seen, ${byName.size} names resolved`);
	console.log(`history: ${counts.matches} matches, ${counts.seats} seats with a deck; ${counts.stamped} matched a person, ${counts.unknownName} named nobody seen here, ${counts.ambiguousName} a shared name`);
	console.log(`would stamp ${deckStamps} decks for ${stamps.size} people in ${join(dataDir, 'users')}`);
	if (!values.write) {
		console.log('dry run: nothing written (--write to write)');
		return;
	}
	const users = createMagicUserStore(join(dataDir, 'users'), (e) => console.error('users:', JSON.stringify(e)));
	let moved = 0;
	for (const [userId, decks] of stamps) {
		await users.update(userId, (doc) => {
			for (const [deckId, at] of decks) {
				if ((doc.decks[deckId]?.lastPlayedAt ?? 0) >= at) continue;
				doc.decks[deckId] = { lastPlayedAt: at };
				moved++;
			}
		});
	}
	console.log(`written: ${moved} stamps set or moved forward`);
}

if (import.meta.main) await main();
