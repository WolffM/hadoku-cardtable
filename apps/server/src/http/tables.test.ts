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
import type { MatchRegistry } from '../play/match.js';
import { loadTranscript, replayFactory, type ReplayHost } from '../play/fixtures/transcript.js';
import { createDraftRooms, joinDraftRoom, stateOf, type DraftRooms } from '../room/draftRooms.js';
import { identityFromHeaders } from '../room/identity.js';
import { loadPool } from '../room/pool.js';
import { checkSeat, type SeatVerdict } from './gate.js';
import type { TablesRooms } from './routes.js';
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

/* ── a stand-in for lane A's lobby ───────────────────────────────────── */

/**
 * The A↔C room contract as an in-memory fake. `apps/server/src/room/lobby.ts`
 * is lane A's file and was not on the branch when this was written, so the
 * routes take the subset they need (`TablesRooms`) as a structural type and
 * this implements it. When A lands, `index.ts` passes the real `Lobby`.
 */
interface FakeRoom {
	id: string;
	name: string;
	gameType: string;
	members: { id: string; name: string }[];
	matchId: string | null;
	state: Map<string, unknown>;
}

interface FakeLobby extends TablesRooms {
	open(id: string, members: { id: string; name: string }[], gameType?: string): FakeRoom;
	room(id: string): FakeRoom | undefined;
}

function fakeLobby(): FakeLobby {
	const held = new Map<string, FakeRoom>();
	const member = (roomId: string, memberId: string): FakeRoom | undefined => {
		const room = held.get(roomId);
		return room !== undefined && room.members.some((m) => m.id === memberId) ? room : undefined;
	};
	return {
		open(id, members, gameType = 'constructed-1v1') {
			const room: FakeRoom = { id, name: `room ${id}`, gameType, members, matchId: null, state: new Map() };
			held.set(id, room);
			return room;
		},
		room: (id) => held.get(id),
		get: (id) => held.get(id),
		playerState: (roomId, memberId) => member(roomId, memberId)?.state.get(memberId),
		setPlayerState(roomId, memberId, state) {
			const room = member(roomId, memberId);
			if (room === undefined) return false;
			// Through JSON, as a persisted lobby would: a state this route cannot
			// read back after a restart is a state it must not depend on.
			room.state.set(memberId, JSON.parse(JSON.stringify(state)) as unknown);
			return true;
		},
		setMatch(roomId, matchId) {
			const room = held.get(roomId);
			if (room === undefined) return false;
			room.matchId = matchId;
			return true;
		},
	};
}

const idOf = (user: string): string => identityFromHeaders(edgeHeaders(user), `http-${user}`);
const ALICE = idOf('alice');
const BOB = idOf('bob');
const CAROL = idOf('carol');

interface Harness {
	port: number;
	specs: MatchSpec[];
	hosts: ReplayHost[];
	rooms: DraftRooms;
	lobby: FakeLobby;
	matches: MatchRegistry;
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
	const lobby = fakeLobby();
	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	api.use(express.json({ limit: '1mb' }));
	app.use('/api', api);
	const http: HttpServer = createServer(app);
	const io = new SocketIOServer(http, { serveClient: false });

	// The order index.ts uses, and the order that matters: the gate first. Play
	// is attached after, so the gate reads its registry lazily — the same wiring
	// index.ts will have.
	let attached: ReturnType<typeof playMod.attachPlay> | null = null;
	routesMod.attachTables(api, {
		repoRoot: REPO_ROOT,
		draftRooms: rooms,
		log: () => {},
		rooms: lobby,
		matches: () => attached?.matches ?? null,
	});
	const play = playMod.attachPlay(io, api, {
		minTier: 'friend',
		host: (id, spec, events) => {
			specs.push(spec);
			return factory(id, spec, events);
		},
		log: () => {},
		startTimeoutMs: 5000,
	});
	attached = play;

	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	const port = (http.address() as AddressInfo).port;
	harness = {
		port,
		specs,
		hosts,
		rooms,
		lobby,
		matches: play.matches,
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
	method: 'GET' | 'POST' | 'PUT',
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
	headers: Record<string, string> = edgeHeaders('alice'),
): Promise<{ status: number; body: Record<string, unknown> }> {
	const pending = call(h, 'POST', path, body, headers, contentType);
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
	it('starts a match against the AI with two legal library decks, handing Forge the files byte for byte', async () => {
		const h = await boot();
		const res = await start(h, {
			opponent: 'ai',
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
			opponent: 'ai',
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
			opponent: 'ai',
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

/* ── the room's table: each player loads their own deck ──────────────── */

/**
 * Wave 13 §C, end to end through the same real play route: two members of one
 * room each load THEIR OWN deck, each readies up, and the server assembles the
 * two decks. The old shape — one body carrying two decks against a person — is
 * closed, and closed with a test rather than only removed from the screen.
 *
 * The lobby here is the in-memory `fakeLobby` above: lane A owns the real one,
 * and the routes take only the four methods they need as a structural type.
 */
describe('a room table', () => {
	const MEMBERS = [
		{ id: ALICE, name: 'user-alice' },
		{ id: BOB, name: 'user-bob' },
	];
	const ROOM = 'r-table';

	const openRoom = (h: Harness, gameType?: string) => h.lobby.open(ROOM, [...MEMBERS], gameType);
	const putDeck = (h: Harness, user: string, seat: unknown, roomId = ROOM) =>
		call(h, 'PUT', `/api/tables/rooms/${roomId}/deck`, seat, edgeHeaders(user));
	const setReady = (h: Harness, user: string, ready = true, roomId = ROOM) =>
		call(h, 'POST', `/api/tables/rooms/${roomId}/ready`, { ready }, edgeHeaders(user));
	const view = (h: Harness, user: string, roomId = ROOM) =>
		call(h, 'GET', `/api/tables/rooms/${roomId}`, undefined, edgeHeaders(user));
	const startRoom = (h: Harness, user: string, roomId = ROOM) =>
		start(h, { room: roomId }, '/api/play/matches', 'application/json', edgeHeaders(user));

	interface PlayerRow {
		seat: number;
		name: string;
		you: boolean;
		deckName: string;
		legal: boolean;
		ready: boolean;
		issueCount: number;
		verdict: { issues: { cardName: string | null }[] } | null;
	}
	const players = (body: Record<string, unknown>): PlayerRow[] => body.players as PlayerRow[];

	/** Both members seated with a legal deck, each choosing only their own. */
	async function bothLoaded(h: Harness): Promise<void> {
		expect((await putDeck(h, 'alice', standard(BEN_STARK, PT_PARIS))).status).toBe(200);
		expect((await putDeck(h, 'bob', standard(PAUL_RIETZL, PT_PARIS))).status).toBe(200);
	}

	it('starts the match from the room, each player in the seat their own deck is in', async () => {
		const h = await boot();
		openRoom(h);
		await bothLoaded(h);
		expect((await setReady(h, 'alice')).status).toBe(200);
		const second = await setReady(h, 'bob');
		expect(second.status).toBe(200);
		expect(players(second.body).map((p) => [p.deckName, p.ready])).toEqual([
			['Mystic Caw Go (Ben Stark)', true],
			['Boros Landfall (Paul Rietzl)', true],
		]);

		const res = await startRoom(h, 'alice');
		expect(res.status).toBe(201);
		const matchId = res.body.matchId as string;

		// The decks Forge is launched with, in the order the two players loaded
		// them — each the text that player's own rule checked, byte for byte.
		expect(h.specs).toHaveLength(1);
		expect(h.specs[0]?.seats.map((s) => s.deck)).toEqual([library.deck(BEN_STARK)?.text, library.deck(PAUL_RIETZL)?.text]);

		// And the seats are BOUND, so neither browser can arrive into the other
		// player's deck: `Match.claim` is otherwise first-come-first-served.
		const match = h.matches.get(matchId);
		expect(match?.seatOf(ALICE)).toBe(0);
		expect(match?.seatOf(BOB)).toBe(1);
		expect(h.lobby.room(ROOM)?.matchId).toBe(matchId);
	});

	it('answers the same match to whoever presses start second, without a second JVM', async () => {
		const h = await boot();
		openRoom(h);
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		const first = await startRoom(h, 'alice');
		expect(first.status).toBe(201);
		const again = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('bob'));
		expect(again).toMatchObject({ status: 200, body: { matchId: first.body.matchId } });
		expect(h.specs).toHaveLength(1);
	});

	it('launches one JVM when both players press start at the same moment', async () => {
		const h = await boot();
		openRoom(h);
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		// Both in flight before either is answered — no awaiting one first.
		const both = call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('alice'));
		const race = call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('bob'));
		const deadline = Date.now() + 3000;
		while (h.hosts.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
		(h.hosts.at(-1) as ReplayHost).push(...OPENING);
		const answers = await Promise.all([both, race]);

		// ONE JVM. That is the claim; which of the two interleavings happened is
		// not, and pinning it is what made an earlier version of this flake: the
		// second request is refused as in-flight (409) if it arrives while the
		// first is still starting, and answered the same match (200) if it
		// arrives after — both correct, and the race decides which.
		expect(h.specs).toHaveLength(1);
		const statuses = answers.map((r) => r.status);
		expect(statuses.filter((s) => s === 201)).toHaveLength(1);
		expect(statuses.filter((s) => s === 200 || s === 409)).toHaveLength(1);
		// Whoever was told a match id was told the SAME one, and it is the match
		// that was started.
		const started = answers.find((r) => r.status === 201)?.body.matchId;
		expect(typeof started).toBe('string');
		for (const answer of answers) {
			if ('matchId' in answer.body) expect(answer.body.matchId).toBe(started);
		}
		expect(h.lobby.room(ROOM)?.matchId).toBe(started);
		expect(h.matches.get(started as string)?.seatOf(ALICE)).toBe(0);
		expect(h.matches.get(started as string)?.seatOf(BOB)).toBe(1);
	});

	it('refuses a body that names two decks against a person, and says where a match starts', async () => {
		const h = await boot();
		const res = await call(h, 'POST', '/api/play/matches', {
			opponent: 'human',
			seats: [standard(BEN_STARK, PT_PARIS), standard(PAUL_RIETZL, PT_PARIS)],
		});
		expect(res.status).toBe(422);
		expect(res.body.error).toContain('starts from a room');
		expect(h.specs).toEqual([]);
		// The default opponent is 'human', so the shape is closed without one too.
		const bare = await call(h, 'POST', '/api/play/matches', {
			seats: [standard(BEN_STARK, PT_PARIS), standard(PAUL_RIETZL, PT_PARIS)],
		});
		expect(bare.status).toBe(422);
		expect(h.specs).toEqual([]);
	});

	it('answers a room that does not exist and a room you are not in the same way', async () => {
		const h = await boot();
		openRoom(h);
		const missing = await view(h, 'alice', 'r-nope');
		const outsider = await view(h, 'carol');
		expect(missing).toEqual({ status: 404, body: { error: 'no such room' } });
		expect(outsider).toEqual(missing);
		expect(await call(h, 'PUT', '/api/tables/rooms/r-nope/deck', standard(BEN_STARK, PT_PARIS), edgeHeaders('alice'))).toEqual(
			missing,
		);
		expect(await putDeck(h, 'carol', standard(BEN_STARK, PT_PARIS))).toEqual(missing);
		expect(await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('carol'))).toEqual(missing);
		expect(await call(h, 'POST', '/api/play/matches', { room: 'r-nope' }, edgeHeaders('alice'))).toEqual(missing);
		expect(h.specs).toEqual([]);
		expect(CAROL).not.toBe(ALICE);
	});

	it('blocks only the player whose deck is illegal, naming the card', async () => {
		const h = await boot();
		openRoom(h);
		const loaded = await putDeck(h, 'alice', standard(BEN_STARK, AFTER_BANS));
		expect(loaded.status).toBe(200);
		expect(players(loaded.body)[0]).toMatchObject({ legal: false, issueCount: 2 });
		expect(players(loaded.body)[0]?.verdict?.issues.map((i) => i.cardName)).toEqual([
			'Jace, the Mind Sculptor',
			'Stoneforge Mystic',
		]);

		const refused = await setReady(h, 'alice');
		expect(refused.status).toBe(422);
		expect(refused.body.error).toContain('Jace, the Mind Sculptor');

		// The other player is untouched by it: they load, they ready.
		expect((await putDeck(h, 'bob', standard(PAUL_RIETZL, PT_PARIS))).status).toBe(200);
		expect((await setReady(h, 'bob')).status).toBe(200);

		const blocked = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('bob'));
		expect(blocked.status).toBe(409);
		expect(blocked.body.error).toContain('user-alice');
		expect(h.specs).toEqual([]);

		// And a legal deck unblocks it: same player, same room, no restart.
		expect((await putDeck(h, 'alice', standard(BEN_STARK, PT_PARIS))).status).toBe(200);
		expect((await setReady(h, 'alice')).status).toBe(200);
		expect((await startRoom(h, 'bob')).status).toBe(201);
	});

	it('un-readies a player who loads a different deck', async () => {
		const h = await boot();
		openRoom(h);
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		const reloaded = await putDeck(h, 'alice', standard(PAUL_RIETZL, PT_PARIS));
		expect(players(reloaded.body).map((p) => p.ready)).toEqual([false, true]);
		const res = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('bob'));
		expect(res).toMatchObject({ status: 409, body: { error: 'user-alice is not ready yet' } });
		expect(h.specs).toEqual([]);
	});

	it('will not seat a third member, and will not let anyone name another member’s deck', async () => {
		const h = await boot();
		h.lobby.open(ROOM, [...MEMBERS, { id: CAROL, name: 'user-carol' }]);
		await bothLoaded(h);
		const third = await putDeck(h, 'carol', standard(BEN_STARK, PT_PARIS));
		expect(third).toMatchObject({ status: 409, body: { error: 'this table already has two players' } });
		// There is no field that names a member — a body that invents one is refused.
		const named = await putDeck(h, 'carol', { ...standard(BEN_STARK, PT_PARIS), member: ALICE });
		expect(named).toMatchObject({ status: 400, body: { error: 'body: unknown field member' } });
		// Carol sees the table, as a member of the room who is not playing.
		const seen = await view(h, 'carol');
		expect(seen.body.you).toEqual({ player: false });
		expect(players(seen.body).map((p) => p.you)).toEqual([false, false]);
	});

	it('shows the other player’s state without their issues or their .dck', async () => {
		const h = await boot();
		openRoom(h);
		await putDeck(h, 'alice', standard(BEN_STARK, AFTER_BANS));
		await putDeck(h, 'bob', standard(PAUL_RIETZL, PT_PARIS));
		const seen = await view(h, 'bob');
		const [mine, theirs] = [players(seen.body)[1], players(seen.body)[0]];
		expect(mine).toMatchObject({ you: true, legal: true });
		expect(mine?.verdict).not.toBeNull();
		// Alice's faults reach Bob as a count and a name, never as a card list:
		// a draft verdict would say what she drafted.
		expect(theirs).toMatchObject({ you: false, legal: false, issueCount: 2, deckName: 'Mystic Caw Go (Ben Stark)' });
		expect(theirs?.verdict).toBeNull();
		expect(JSON.stringify(seen.body)).not.toContain('[metadata]');
	});

	it('refuses a table in a room that is not constructed 1v1', async () => {
		const h = await boot();
		h.lobby.open(ROOM, [...MEMBERS], 'draft');
		const res = await putDeck(h, 'alice', standard(BEN_STARK, PT_PARIS));
		expect(res.status).toBe(409);
		expect(res.body.error).toContain('constructed-1v1');
		expect(await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('alice'))).toMatchObject({ status: 409 });
		expect(h.specs).toEqual([]);
	});

	it('forgets a match id the registry no longer has, so a restart does not strand the room', async () => {
		const h = await boot();
		const room = openRoom(h);
		room.matchId = 'm-deadbeef0000';
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		const seen = await view(h, 'alice');
		expect((seen.body.room as { matchId: string | null }).matchId).toBeNull();
		expect((await startRoom(h, 'alice')).status).toBe(201);
	});

	/**
	 * The hazard the stored verdict exists for: a `draft` rule resolves the pool
	 * of whoever is making the request. Alice's drafted deck is checked against
	 * ALICE's pool when she loads it, and BOB presses start — so if the gate
	 * re-checked at start time, Alice's deck would be checked against Bob's
	 * (empty) pool and the match would never launch.
	 */
	it('starts a drafted deck the other player pressed start on', async () => {
		const h = await boot();
		openRoom(h);
		const draftId = 'amber-lantern-k7q4';
		const draftRoom = h.rooms.open(draftId);
		const seat = joinDraftRoom(draftRoom, 'sock-a', ALICE, 'friend').seat;
		if (seat === null) throw new Error('alice was not seated');
		const state = stateOf(draftRoom);
		const pool = state.packs.flat().slice(0, 45);
		state.pools[seat] = pool;
		let built = deckFromPool(draftId, pool);
		for (const card of pool.slice(0, 40)) {
			const entry = built.sideboard.find((e) => e.card.name === card.name && e.card.set === (card.setCode || null));
			if (entry !== undefined) built = moveToMain(built, entry.card, 1);
		}
		const text = dckTextOf(built);

		expect((await putDeck(h, 'alice', { deck: { dck: text }, rules: { kind: 'draft', draftId } })).status).toBe(200);
		expect((await putDeck(h, 'bob', standard(PAUL_RIETZL, PT_PARIS))).status).toBe(200);
		await setReady(h, 'alice');
		await setReady(h, 'bob');

		// Bob cannot check Alice's deck himself — that is the hazard, stated.
		const asBob = await call(
			h,
			'POST',
			'/api/tables/check',
			{ deck: { dck: text }, rules: { kind: 'draft', draftId } },
			edgeHeaders('bob'),
		);
		expect(asBob).toMatchObject({ status: 400, body: { error: `you have no seat in draft "${draftId}"` } });

		const res = await startRoom(h, 'bob');
		expect(res.status).toBe(201);
		expect(h.specs[0]?.seats.map((s) => s.deck)).toEqual([text, library.deck(PAUL_RIETZL)?.text]);
		expect(h.matches.get(res.body.matchId as string)?.seatOf(ALICE)).toBe(0);
	});

	it('refuses a start before both players have loaded a deck', async () => {
		const h = await boot();
		openRoom(h);
		const empty = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('alice'));
		expect(empty).toMatchObject({ status: 409, body: { error: 'both players have to load a deck first' } });
		await putDeck(h, 'alice', standard(BEN_STARK, PT_PARIS));
		await setReady(h, 'alice');
		const alone = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('alice'));
		expect(alone.status).toBe(409);
		expect(h.specs).toEqual([]);
	});

	it('answers a malformed room body with 400 rather than a room', async () => {
		const h = await boot();
		openRoom(h);
		expect(await call(h, 'POST', '/api/play/matches', { room: ROOM, decks: [null, null] }, edgeHeaders('alice'))).toMatchObject(
			{ status: 400, body: { error: 'body: unknown field decks' } },
		);
		expect(await call(h, 'POST', '/api/play/matches', { room: 42 }, edgeHeaders('alice'))).toMatchObject({ status: 400 });
		expect(await call(h, 'POST', `/api/tables/rooms/${ROOM}/ready`, {}, edgeHeaders('alice'))).toMatchObject({
			status: 400,
			body: { error: 'body is { ready: boolean }' },
		});
		expect(await call(h, 'POST', `/api/tables/rooms/${ROOM}/ready`, { ready: 'yes' }, edgeHeaders('alice'))).toMatchObject({
			status: 400,
		});
		expect(h.specs).toEqual([]);
	});

	it('is behind the friend floor like every other route', async () => {
		const h = await boot();
		openRoom(h);
		expect((await view(h, 'alice')).status).toBe(200);
		const res = await call(h, 'GET', `/api/tables/rooms/${ROOM}`, undefined, edgeHeaders('alice', 'public'));
		expect(res.status).toBe(404);
		expect(res.body.error).not.toBe('no such room');
	});
});
