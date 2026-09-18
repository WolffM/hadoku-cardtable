/**
 * The deck gate, end to end through the REAL play route.
 *
 * A real express app mounted the way `index.ts` mounts it — provenance, the
 * tier floor, `/api`, then `attachTables` BEFORE `attachPlay` — with play's
 * Forge replaced by the recorded-transcript `ReplayHost`, wrapped so the test
 * sees the exact `MatchSpec` Forge would have been launched with. So "the
 * illegal deck never reached Forge" is asserted on the host factory, not
 * inferred from a status code.
 *
 * The decks and pools are the committed library (`decks/`), read by the same
 * loader production uses. The illegal case is real history, not an invented
 * card: Standard as of 2011-07-01 banned Jace, the Mind Sculptor and
 * Stoneforge Mystic, and Ben Stark won PT Paris with four of each.
 */

import express from 'express';
import { readFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketIOServer } from 'socket.io';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { moveToMain } from '@hadoku/deck';

import { deckFromPool, dckTextOf } from '../../../ui/src/draft/deckFromPool.ts';
import type { MatchSpec } from '../play/host.js';
import { loadTranscript, replayFactory, type ReplayHost } from '../play/fixtures/transcript.js';
import { createDraftRooms, joinDraftRoom, stateOf, type DraftRooms } from '../room/draftRooms.js';
import { identityFromHeaders } from '../room/identity.js';
import { loadPool } from '../room/pool.js';
import { checkSeat, type SeatVerdict } from './gate.js';
import { loadTablesLibrary } from './library.js';

const EDGE_SECRET = 'test-edge-auth-secret';
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const CUBE_FILE = resolve(REPO_ROOT, 'apps/ui/src/draft/pool.json');

const BEN_STARK = 'pt-paris-2011-1-ben-stark';
const PAUL_RIETZL = 'pt-paris-2011-2-paul-rietzl';
const PT_PARIS = '2011-02-13';
const AFTER_BANS = '2011-07-01';

let routesMod: typeof import('./routes.ts');
let playMod: typeof import('../play/socket.ts');
let edgeMod: typeof import('../edge-auth.ts');

beforeAll(async () => {
	// config.ts reads the environment once, at load — same dance as play/socket.test.ts.
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	routesMod = await import('./routes.ts');
	playMod = await import('../play/socket.ts');
	edgeMod = await import('../edge-auth.ts');
});

function edgeHeaders(user: string, tier = 'friend'): Record<string, string> {
	return {
		'x-edge-auth': EDGE_SECRET,
		'x-hadoku-tier': tier,
		'x-user-id': `user-${user}`,
		'x-user-key': `friend-key-${user}`,
	};
}

/* ── the library, as production loads it ─────────────────────────────── */

const library = loadTablesLibrary(REPO_ROOT);

describe('the library', () => {
	it('loads every frozen pool and every catalogued deck, with no faults', () => {
		expect(library.faults).toEqual([]);
		expect(library.formats.map((f) => f.id)).toEqual([PT_PARIS, AFTER_BANS]);
		expect(library.formats.map((f) => f.pool.name)).toEqual(['Standard (MBS)', 'Standard (2011-07-01)']);
		expect(library.decks).toHaveLength(8);
	});

	it('names a file that will not load instead of refusing to boot', () => {
		const broken = loadTablesLibrary(REPO_ROOT, [
			{
				id: 'broken',
				directory: 'decks/no-such-collection',
				event: 'nothing',
				format: 'Standard (MBS)',
				date: PT_PARIS,
				source: 'nowhere',
				decks: [{ id: 'ghost', file: 'ghost.dck' }],
			},
		]);
		expect(broken.decks).toEqual([]);
		expect(broken.faults).toHaveLength(1);
		expect(broken.faults[0]).toContain('ghost.dck');
		// The formats still load: one broken deck costs one entry, not the picker.
		expect(broken.formats).toHaveLength(2);
	});
});

/* ── the one check ───────────────────────────────────────────────────── */

describe('checkSeat', () => {
	const ctx = { library, draftPool: null };

	it('passes every PT Paris deck in the format it was played in', () => {
		for (const d of library.decks) {
			const v = checkSeat({ deck: { library: d.id }, rules: { kind: 'standard', format: PT_PARIS } }, ctx);
			expect(v, d.id).toMatchObject({ legal: true, issues: [], note: null });
		}
	});

	it('refuses the same deck after the bans, naming each banned card', () => {
		const v = checkSeat({ deck: { library: BEN_STARK }, rules: { kind: 'standard', format: AFTER_BANS } }, ctx) as SeatVerdict;
		expect(v.legal).toBe(false);
		expect(v.issues.map((i) => [i.kind, i.cardName])).toEqual([
			['banned', 'Jace, the Mind Sculptor'],
			['banned', 'Stoneforge Mystic'],
		]);
		expect(v.issues[0]?.message).toBe('plays 4x Jace, the Mind Sculptor, which Standard (2011-07-01) bans');
		// Not a fault in the deck, and said separately.
		expect(v.note).toContain('is built for "Standard (MBS)"');
	});

	it('checks pasted .dck text the same way as a library deck', () => {
		const text = library.deck(BEN_STARK)?.text ?? '';
		const pasted = checkSeat({ deck: { dck: text }, rules: { kind: 'standard', format: AFTER_BANS } }, ctx) as SeatVerdict;
		const byId = checkSeat({ deck: { library: BEN_STARK }, rules: { kind: 'standard', format: AFTER_BANS } }, ctx) as SeatVerdict;
		expect(pasted.issues).toEqual(byId.issues);
		expect(pasted.text).toBe(byId.text);
	});

	it('answers an unknown deck or format as unresolved, not as an illegal deck', () => {
		expect(checkSeat({ deck: { library: 'nope' }, rules: { kind: 'standard', format: PT_PARIS } }, ctx)).toEqual({
			error: 'no library deck "nope"',
		});
		expect(checkSeat({ deck: { library: BEN_STARK }, rules: { kind: 'standard', format: '1999-01-01' } }, ctx)).toEqual({
			error: 'no format "1999-01-01"',
		});
	});
});

/* ── through the real play route ─────────────────────────────────────── */

/** Forge's recorded opening, up to its first question: enough for the route to answer 201. */
const TRANSCRIPT = loadTranscript();
const OPENING = TRANSCRIPT.slice(0, TRANSCRIPT.findIndex((l) => l.t === 'frame' && (l.frame as { kind: string }).kind === 'ask'));

interface Harness {
	port: number;
	specs: MatchSpec[];
	hosts: ReplayHost[];
	rooms: DraftRooms;
	close: () => Promise<void>;
}

let harness: Harness | null = null;

afterEach(async () => {
	if (harness !== null) await harness.close();
	harness = null;
});

async function boot(): Promise<Harness> {
	const cube = loadPool(CUBE_FILE);
	if (!cube.ok) throw new Error(`cube pool did not load: ${cube.detail}`);
	const rooms = createDraftRooms({ pool: cube.pool.cards, cube: cube.pool.meta, now: () => 1_700_000_000_000 });

	const { factory, hosts } = replayFactory();
	const specs: MatchSpec[] = [];
	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	api.use(express.json({ limit: '1mb' }));
	app.use('/api', api);
	const http: HttpServer = createServer(app);
	const io = new SocketIOServer(http, { serveClient: false });

	// The order index.ts uses, and the order that matters: the gate first.
	routesMod.attachTables(api, { repoRoot: REPO_ROOT, draftRooms: rooms, log: () => {} });
	const play = playMod.attachPlay(io, api, {
		minTier: 'friend',
		host: (id, spec, events) => {
			specs.push(spec);
			return factory(id, spec, events);
		},
		log: () => {},
		startTimeoutMs: 5000,
	});

	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	const port = (http.address() as AddressInfo).port;
	harness = {
		port,
		specs,
		hosts,
		rooms,
		close: async () => {
			play.close();
			io.close();
			await new Promise<void>((done) => http.close(() => done()));
		},
	};
	return harness;
}

async function call(
	h: Harness,
	method: 'GET' | 'POST',
	path: string,
	body?: unknown,
	headers: Record<string, string> = edgeHeaders('alice'),
): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await fetch(`http://127.0.0.1:${h.port}${path}`, {
		method,
		headers: { ...headers, 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	return { status: res.status, body: text.startsWith('{') ? (JSON.parse(text) as Record<string, unknown>) : { text } };
}

/**
 * POST a match that should START: feed the host Forge's recorded opening once
 * it exists, as `play/socket.test.ts` does, so play's route can answer.
 */
async function start(h: Harness, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
	const pending = call(h, 'POST', '/api/play/matches', body);
	const deadline = Date.now() + 3000;
	while (h.hosts.length === 0) {
		if (Date.now() > deadline) return pending;
		await new Promise((r) => setTimeout(r, 5));
	}
	(h.hosts.at(-1) as ReplayHost).push(...OPENING);
	return pending;
}

const standard = (deck: string, format: string) => ({ deck: { library: deck }, rules: { kind: 'standard', format } });

describe('POST /api/play/matches, gated', () => {
	it('starts a match with two legal library decks, handing Forge the files byte for byte', async () => {
		const h = await boot();
		const res = await start(h, {
			opponent: 'human',
			seats: [standard(BEN_STARK, PT_PARIS), standard(PAUL_RIETZL, PT_PARIS)],
		});
		expect(res.status).toBe(201);
		expect(typeof res.body.matchId).toBe('string');
		expect(h.specs).toHaveLength(1);
		expect(h.specs[0]?.seats.map((s) => s.deck)).toEqual([
			readFileSync(resolve(REPO_ROOT, 'decks/standard-2011-02-13-pt-paris/1-ben-stark-mystic-caw-go.dck'), 'utf8'),
			readFileSync(resolve(REPO_ROOT, 'decks/standard-2011-02-13-pt-paris/2-paul-rietzl-boros-landfall.dck'), 'utf8'),
		]);
	});

	it('refuses an illegal deck with the offending card named, and never launches Forge', async () => {
		const h = await boot();
		const res = await call(h, 'POST', '/api/play/matches', {
			opponent: 'ai',
			seats: [standard(BEN_STARK, AFTER_BANS), standard(PAUL_RIETZL, AFTER_BANS)],
		});
		expect(res.status).toBe(422);
		expect(res.body.error).toBe(
			'Seat 1\'s deck "Mystic Caw Go (Ben Stark)" is not legal in Standard (2011-07-01): ' +
				'plays 4x Jace, the Mind Sculptor, which Standard (2011-07-01) bans (and 1 more)',
		);
		const seats = res.body.seats as { legal: boolean; issues: { cardName: string }[] }[];
		// Every PT Paris Top 8 deck played one of the two; the refusal leads with seat 1.
		expect(seats.map((s) => s.legal)).toEqual([false, false]);
		expect(seats[0]?.issues.map((i) => i.cardName)).toEqual(['Jace, the Mind Sculptor', 'Stoneforge Mystic']);
		// The .dck text stays on the server.
		expect(JSON.stringify(res.body)).not.toContain('[metadata]');
		expect(h.specs).toEqual([]);
	});

	it('refuses a raw .dck that skipped the gate', async () => {
		const h = await boot();
		const text = library.deck(BEN_STARK)?.text;
		const res = await call(h, 'POST', '/api/play/matches', { opponent: 'ai', decks: [text, null] });
		expect(res.status).toBe(422);
		expect(res.body.error).toContain('a deck must be checked');
		expect(h.specs).toEqual([]);
	});

	it("passes Forge's own random precons through untouched", async () => {
		const h = await boot();
		const res = await start(h, { opponent: 'human' });
		expect(res.status).toBe(201);
		expect(h.specs[0]?.seats.map((s) => s.deck)).toEqual([null, null]);
	});

	it('answers a malformed body or an unknown deck with 400, not a verdict', async () => {
		const h = await boot();
		const bad = await call(h, 'POST', '/api/play/matches', { seats: [standard(BEN_STARK, PT_PARIS)] });
		expect(bad).toMatchObject({ status: 400, body: { error: 'seats is a two-element array' } });
		const unknown = await call(h, 'POST', '/api/play/matches', {
			seats: [standard(BEN_STARK, PT_PARIS), standard('nope', PT_PARIS)],
		});
		expect(unknown).toMatchObject({ status: 400, body: { error: 'seat 2: no library deck "nope"', seat: 1 } });
		expect(h.specs).toEqual([]);
	});

	it('is behind the friend floor like every other route', async () => {
		const h = await boot();
		const res = await call(
			h,
			'POST',
			'/api/play/matches',
			{ seats: [standard(BEN_STARK, PT_PARIS), standard(PAUL_RIETZL, PT_PARIS)] },
			edgeHeaders('mallory', 'public'),
		);
		expect(res.status).toBe(404);
		expect((await call(h, 'GET', '/api/tables/formats', undefined, edgeHeaders('mallory', 'public'))).status).toBe(404);
		expect(h.specs).toEqual([]);
	});
});

describe('the catalog routes', () => {
	it('lists the formats and the decks', async () => {
		const h = await boot();
		const formats = await call(h, 'GET', '/api/tables/formats');
		expect(formats.status).toBe(200);
		expect((formats.body.formats as { id: string; banned: string[] }[]).map((f) => [f.id, f.banned])).toEqual([
			[PT_PARIS, []],
			[AFTER_BANS, ['Jace, the Mind Sculptor', 'Stoneforge Mystic']],
		]);
		const decks = await call(h, 'GET', '/api/tables/decks');
		const list = decks.body.decks as { id: string; name: string; main: { count: number }[] }[];
		expect(list).toHaveLength(8);
		expect(list[0]).toMatchObject({ id: BEN_STARK, name: 'Mystic Caw Go (Ben Stark)' });
		expect(list[0]?.main.reduce((n, e) => n + e.count, 0)).toBe(60);
	});

	it('checks a deck without starting anything', async () => {
		const h = await boot();
		const res = await call(h, 'POST', '/api/tables/check', standard(BEN_STARK, AFTER_BANS));
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ legal: false, rulesName: 'Standard (2011-07-01)' });
		expect(h.specs).toEqual([]);
	});
});

/* ── the drafted deck takes the same path ────────────────────────────── */

describe('a drafted deck', () => {
	/** Seat alice in a pod and hand her seat 45 cube cards, as a finished draft would. */
	function draftedPool(h: Harness, draftId: string) {
		const room = h.rooms.open(draftId);
		const alice = identityFromHeaders(edgeHeaders('alice'), 'sock-a');
		const seat = joinDraftRoom(room, 'sock-a', alice, 'friend').seat;
		if (seat === null) throw new Error('alice was not seated');
		const state = stateOf(room);
		const pool = state.packs.flat().slice(0, 45);
		state.pools[seat] = pool;
		return pool;
	}

	/** The deck the BROWSER writes: the UI's own `deckFromPool` and `.dck` writer. */
	function builtDeck(draftId: string, pool: ReturnType<typeof draftedPool>, extra?: string): string {
		let deck = deckFromPool(draftId, pool);
		for (const card of pool.slice(0, 40)) {
			const entry = deck.sideboard.find((e) => e.card.name === card.name && e.card.set === (card.setCode || null));
			if (entry !== undefined) deck = moveToMain(deck, entry.card, 1);
		}
		const text = dckTextOf(deck);
		return extra === undefined ? text : text.replace('[Main]\n', `[Main]\n${extra}\n`).replace('[main]\n', `[main]\n${extra}\n`);
	}

	it('starts a match through the same gate, checked against the caller’s own pool', async () => {
		const h = await boot();
		const pool = draftedPool(h, 'amber-lantern-k7q4');
		const text = builtDeck('amber-lantern-k7q4', pool);
		const res = await start(h, {
			opponent: 'human',
			seats: [
				{ deck: { dck: text }, rules: { kind: 'draft', draftId: 'amber-lantern-k7q4' } },
				standard(PAUL_RIETZL, PT_PARIS),
			],
		});
		expect(res.status).toBe(201);
		expect(h.specs[0]?.seats[0]?.deck).toBe(text);
	});

	it('refuses a card the caller did not draft, by name', async () => {
		const h = await boot();
		const pool = draftedPool(h, 'amber-lantern-k7q4');
		const text = builtDeck('amber-lantern-k7q4', pool, '1 Black Lotus|LEA');
		const res = await call(h, 'POST', '/api/tables/check', {
			deck: { dck: text },
			rules: { kind: 'draft', draftId: 'amber-lantern-k7q4' },
		});
		expect(res.status).toBe(200);
		expect(res.body.legal).toBe(false);
		expect(res.body.issues).toEqual([
			{ kind: 'more-copies-than-drafted', message: 'plays 1x Black Lotus but drafted 0', cardName: 'Black Lotus', count: 1, limit: 0 },
		]);
	});

	it('will not check a deck against someone else’s pool', async () => {
		const h = await boot();
		const pool = draftedPool(h, 'amber-lantern-k7q4');
		const text = builtDeck('amber-lantern-k7q4', pool);
		const res = await call(
			h,
			'POST',
			'/api/tables/check',
			{ deck: { dck: text }, rules: { kind: 'draft', draftId: 'amber-lantern-k7q4' } },
			edgeHeaders('bob'),
		);
		expect(res).toMatchObject({ status: 400, body: { error: 'you have no seat in draft "amber-lantern-k7q4"' } });
	});
});
