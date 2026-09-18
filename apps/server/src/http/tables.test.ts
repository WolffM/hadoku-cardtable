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
import { LIBRARY, type LibraryCollection } from '@hadoku/deck/library';
import { loadTablesLibrary } from './library.js';

const EDGE_SECRET = 'test-edge-auth-secret';
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const CUBE_FILE = resolve(REPO_ROOT, 'apps/ui/src/draft/pool.json');

const BEN_STARK = 'pt-paris-2011-1-ben-stark';
const PAUL_RIETZL = 'pt-paris-2011-2-paul-rietzl';
const PT_PARIS = '2011-02-13';
const AFTER_BANS = '2011-07-01';
const PT_DKA = '2012-02-12';

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
		// Derived, not hardcoded. These assertions were rewritten on each of the
		// first three collections added, every time for the same reason: a count
		// pinned here duplicates a fact `LIBRARY` already states. The shape pin
		// that SHOULD fail when a collection appears lives in
		// `packages/deck/src/library/library.test.ts`, once, on purpose.
		expect(library.formats.map((f) => f.id)).toContain(PT_PARIS);
		expect(library.formats.map((f) => f.id)).toContain(PT_DKA);
		expect(library.formats.map((f) => f.pool.name)).toContain('Standard (MBS)');
		expect(library.decks).toHaveLength(LIBRARY.flatMap((c: LibraryCollection) => c.decks).length);
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
		// Count derived from the frozen pools, not restated here.
		expect(broken.formats.length).toBeGreaterThanOrEqual(3);
	});
});

/* ── the one check ───────────────────────────────────────────────────── */

describe('checkSeat', () => {
	const ctx = { library, draftPool: null };

	// Every deck, checked against ITS OWN collection's format rather than one
	// hardcoded date. The previous version iterated the whole library against
	// PT_PARIS, which was correct only while the library held one collection —
	// the same shape of bug as asserting a collection's size against a
	// library-wide total. A DKA deck is legal in DKA and is not legal in a 2011
	// pool, and both of those are the right answer.
	it('passes every deck in the format it was actually played in', () => {
		// Each deck against ITS OWN collection's date, looked up rather than
		// guessed from the id — the prefix test that preceded this was a third
		// hardcoding of the same fact.
		const formatOf = new Map<string, string>(
			LIBRARY.flatMap((c: LibraryCollection) => c.decks.map((d) => [d.id, c.date] as [string, string])),
		);
		for (const d of library.decks) {
			const format = formatOf.get(d.id) ?? PT_PARIS;
			const v = checkSeat({ deck: { library: d.id }, rules: { kind: 'standard', format } }, ctx);
			expect(v, `${d.id} in ${format}`).toMatchObject({ legal: true, issues: [], note: null });
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
	contentType = 'application/json',
): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await fetch(`http://127.0.0.1:${h.port}${path}`, {
		method,
		headers: { ...headers, 'content-type': contentType },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	return { status: res.status, body: text.startsWith('{') ? (JSON.parse(text) as Record<string, unknown>) : { text } };
}

/**
 * POST a match that should START: feed the host Forge's recorded opening once
 * it exists, as `play/socket.test.ts` does, so play's route can answer.
 */
async function start(
	h: Harness,
	body: unknown,
	path = '/api/play/matches',
	contentType = 'application/json',
): Promise<{ status: number; body: Record<string, unknown> }> {
	const pending = call(h, 'POST', path, body, edgeHeaders('alice'), contentType);
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
		const rows = (formats.body.formats as { id: string; banned: string[] }[]).map((f) => [f.id, f.banned]);
		expect(rows).toContainEqual([PT_PARIS, []]);
		expect(rows).toContainEqual([AFTER_BANS, ['Jace, the Mind Sculptor', 'Stoneforge Mystic']]);
		expect(rows).toContainEqual([PT_DKA, []]);
		const decks = await call(h, 'GET', '/api/tables/decks');
		const list = decks.body.decks as { id: string; name: string; main: { count: number }[] }[];
		expect(list).toHaveLength(LIBRARY.flatMap((c: LibraryCollection) => c.decks).length);
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
		// The convergence, asserted: one request, a drafted 40-of-45 in seat 1 and a
		// prebuilt 60 in seat 2, and both arrive in the SAME field of the SAME spec
		// Forge is launched with — each exactly the text its own rule checked.
		expect(h.specs).toHaveLength(1);
		expect(h.specs[0]?.seats.map((s) => s.deck)).toEqual([text, library.deck(PAUL_RIETZL)?.text]);
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

/* ── every way a client might get a deck past the gate ───────────────── */

/**
 * Each case here posts a deck that must NOT reach Forge, by a different door,
 * and asserts three things: the answer is a refusal, it names the card, and
 * `specs` — what the host factory was handed — is empty. The smuggled card is
 * Black Lotus, which is in no Standard pool and in no cube pool we deal, so any
 * route that lets it through has let an unchecked card reach Forge.
 *
 * The `.dck`-shape cases were each run against a real Forge before the check
 * existed (Wave 11 lane D): `[Planes]` and a `\u00A0[junk]` header each gave
 * seat 1 a 64-card library with the Lotuses in it; `[main\u0001]` REPLACED the
 * main deck with the four Lotuses (library 4). All three were 201s.
 */
describe('bypass routes, each refused with the card named', () => {
	const LOTUS = '4 Black Lotus|LEA';
	const legalText = (): string => library.deck(PAUL_RIETZL)?.text ?? '';
	const seatsFor = (dck: string) => ({
		opponent: 'ai',
		seats: [{ deck: { dck }, rules: { kind: 'standard', format: PT_PARIS } }, standard(BEN_STARK, PT_PARIS)],
	});
	/** Put `insert` just before the sideboard, so the lines after it are the sideboard in both readers. */
	const beforeSideboard = (insert: string): string => {
		const text = legalText();
		const at = text.indexOf('[Sideboard]');
		return `${text.slice(0, at)}${insert}\n${text.slice(at)}`;
	};

	function expectRefusedNamingLotus(res: { status: number; body: Record<string, unknown> }, h: Harness): void {
		expect(res.status).toBe(422);
		const seats = res.body.seats as { legal: boolean; issues: { cardName: string | null }[] }[];
		expect(seats[0]?.legal).toBe(false);
		expect(seats[0]?.issues.map((i) => i.cardName)).toContain('Black Lotus');
		expect(h.specs).toEqual([]);
	}

	it('the legal base deck itself starts, so every refusal below is the smuggled part', async () => {
		const h = await boot();
		const res = await start(h, seatsFor(legalText()));
		expect(res.status).toBe(201);
		expect(h.specs[0]?.seats[0]?.deck).toBe(legalText());
	});

	/* ── the door: play's own body, and the path it is reached by ─────── */

	it("play's raw body with the unchecked deck in seat 2", async () => {
		const h = await boot();
		const res = await call(h, 'POST', '/api/play/matches', { opponent: 'ai', decks: [null, legalText() + `\n[Main]\n${LOTUS}\n`] });
		expect(res.status).toBe(422);
		expect(res.body.error).toContain('a deck must be checked');
		expect(h.specs).toEqual([]);
	});

	it("play's raw body with a one-element decks array", async () => {
		const h = await boot();
		const res = await call(h, 'POST', '/api/play/matches', { decks: [`[metadata]\nName=x\n[Main]\n${LOTUS}\n`] });
		expect(res.status).toBe(422);
		expect(h.specs).toEqual([]);
	});

	it('seats and a raw decks array in the same body', async () => {
		const h = await boot();
		const res = await call(h, 'POST', '/api/play/matches', { ...seatsFor(legalText()), decks: [`[Main]\n${LOTUS}`, null] });
		expect(res).toMatchObject({ status: 400, body: { error: 'body: unknown field decks' } });
		expect(h.specs).toEqual([]);
	});

	for (const path of ['/api/PLAY/Matches', '/api/play/matches/', '/api/Play/MATCHES/']) {
		it(`the same route spelled ${path}`, async () => {
			const h = await boot();
			const raw = await call(h, 'POST', path, { opponent: 'ai', decks: [`[metadata]\nName=x\n[Main]\n${LOTUS}\n`, null] });
			expect(raw.status).toBe(422);
			const seats = await call(h, 'POST', path, seatsFor(beforeSideboard(`[Planes]\n${LOTUS}`)));
			expectRefusedNamingLotus(seats, h);
		});
	}

	it('the route under a charset-qualified JSON content type', async () => {
		const h = await boot();
		const res = await call(
			h,
			'POST',
			'/api/play/matches',
			{ opponent: 'ai', decks: [`[metadata]\nName=x\n[Main]\n${LOTUS}\n`, null] },
			edgeHeaders('alice'),
			'application/json; charset=utf-8',
		);
		expect(res.status).toBe(422);
		expect(h.specs).toEqual([]);
	});

	it('a body that is not JSON to the gate is not JSON to play either: no deck reaches Forge', async () => {
		const h = await boot();
		const res = await start(
			h,
			{ opponent: 'ai', decks: [`[metadata]\nName=x\n[Main]\n${LOTUS}\n`, null] },
			'/api/play/matches',
			'text/plain',
		);
		// Neither parser reads text/plain, so play sees an empty body: Forge's random
		// precons, human v human. The Lotus text never reaches the host.
		expect(res.status).toBe(201);
		expect(h.specs.map((s) => s.seats.map((seat) => seat.deck))).toEqual([[null, null]]);
	});

	/* ── the deck: text our reader and Forge's read as two decks ──────── */

	const shapes: [string, () => string, string][] = [
		['a card in [Planes], which Forge moves into the main deck', () => beforeSideboard(`[Planes]\n${LOTUS}`), 'unchecked-section'],
		['a card in [Commander]', () => beforeSideboard(`[Commander]\n${LOTUS}`), 'unchecked-section'],
		['a card in [Avatar], at the end of the file', () => `${legalText()}\n[Avatar]\n${LOTUS}\n`, 'unchecked-section'],
		['a section Forge case-folds to Main and JS does not ([ma\u0130n])', () => `${legalText()}\n[ma\u0130n]\n${LOTUS}\n`, 'unchecked-section'],
		['a section Forge case-folds to Sideboard and JS does not ([\u017Fideboard])', () => `${legalText()}\n[\u017Fideboard]\n${LOTUS}\n`, 'unchecked-section'],
		['a control character Java trims and JS does not ([main\\u0001])', () => `${legalText()}\n[main\u0001]\n${LOTUS}\n`, 'ambiguous-character'],
		['a no-break space JS trims and Java does not (\\u00A0[junk])', () => beforeSideboard(`\u00A0[junk]\n${LOTUS}`), 'ambiguous-character'],
		['a byte-order mark before a header (\\uFEFF[junk])', () => beforeSideboard(`\uFEFF[junk]\n${LOTUS}`), 'ambiguous-character'],
	];

	for (const [what, text, kind] of shapes) {
		it(`${what}: refused by the start route and by /check`, async () => {
			const h = await boot();
			const res = await call(h, 'POST', '/api/play/matches', seatsFor(text()));
			expectRefusedNamingLotus(res, h);
			const seats = res.body.seats as { issues: { kind: string }[] }[];
			expect(seats[0]?.issues[0]?.kind).toBe(kind);
			expect(res.body.error).toMatch(/^Seat 1's deck "Boros Landfall \(Paul Rietzl\)" is not legal in Standard \(MBS\): plays 4x Black Lotus /);

			const check = await call(h, 'POST', '/api/tables/check', seatsFor(text()).seats[0]);
			expect(check.status).toBe(200);
			expect(check.body.legal).toBe(false);
			expect(h.specs).toEqual([]);
		});
	}

	it('the unchecked-section refusal says which card, where, and why', async () => {
		const h = await boot();
		const res = await call(h, 'POST', '/api/play/matches', seatsFor(beforeSideboard(`[Planes]\n${LOTUS}`)));
		expect(res.body.error).toBe(
			'Seat 1\'s deck "Boros Landfall (Paul Rietzl)" is not legal in Standard (MBS): plays 4x Black Lotus in [planes], ' +
				'which is not the main deck or sideboard — Forge would read it, and move ordinary cards from it into the main deck',
		);
	});

	it('a file without an exact [metadata] header, which Forge would not load at all', async () => {
		const h = await boot();
		const res = await call(h, 'POST', '/api/play/matches', seatsFor(legalText().replace('[metadata]', '[Metadata]')));
		expect(res.status).toBe(422);
		const seats = res.body.seats as { issues: { kind: string }[] }[];
		expect(seats[0]?.issues.map((i) => i.kind)).toEqual(['no-metadata']);
		expect(h.specs).toEqual([]);
	});

	it('the draft arm refuses the same smuggling', async () => {
		const h = await boot();
		const room = h.rooms.open('amber-lantern-k7q4');
		const alice = identityFromHeaders(edgeHeaders('alice'), 'sock-a');
		const seat = joinDraftRoom(room, 'sock-a', alice, 'friend').seat;
		if (seat === null) throw new Error('alice was not seated');
		const state = stateOf(room);
		const pool = state.packs.flat().slice(0, 45);
		state.pools[seat] = pool;
		let deck = deckFromPool('amber-lantern-k7q4', pool);
		for (const card of pool.slice(0, 40)) {
			const entry = deck.sideboard.find((e) => e.card.name === card.name && e.card.set === (card.setCode || null));
			if (entry !== undefined) deck = moveToMain(deck, entry.card, 1);
		}
		const text = `${dckTextOf(deck)}\n[Planes]\n${LOTUS}\n`;
		const res = await call(h, 'POST', '/api/play/matches', {
			opponent: 'ai',
			seats: [{ deck: { dck: text }, rules: { kind: 'draft', draftId: 'amber-lantern-k7q4' } }, standard(BEN_STARK, PT_PARIS)],
		});
		expectRefusedNamingLotus(res, h);
	});
});
