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
 * card: Standard as of 2011-07-15 banned Jace, the Mind Sculptor and
 * Stoneforge Mystic, and 2010's UG Polymorph (Antoine Ruel) played four Jaces
 * a year earlier, when it was still legal.
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
import { draftPoolId } from '../room/lobby.js';
import { identityFromHeaders } from '../room/identity.js';
import { loadPool } from '../room/pool.js';
import type { DraftCard } from '@hadoku/shared';
import { checkSeat, type SeatVerdict } from './gate.js';
import type { TablesRooms } from './routes.js';
import { LIBRARY, formatIdOf, type LibraryCollection } from '@hadoku/deck/library';
import { loadTablesLibrary } from './library.js';

const EDGE_SECRET = 'test-edge-auth-secret';
const HERE = dirname(fileURLToPath(import.meta.url));
// @reads decks/ apps/ui/src/draft/pool.json
const REPO_ROOT = resolve(HERE, '../../../..');
const CUBE_FILE = resolve(REPO_ROOT, 'apps/ui/src/draft/pool.json');

/**
 * Real cross-era history, the way `library.test.ts`'s own "failure path"
 * section uses it: 2010's UG Polymorph (Antoine Ruel) plays four Jace, the
 * Mind Sculptor, legal in its own era (`Standard (M11)`, 2010-07-16) and
 * banned the moment `Standard (M12)` (2011-07-15) takes effect — two of its
 * other cards (Essence Scatter, Polymorph) are ALSO illegal there, rotated out
 * independently of the ban, which is real Magic history and not tidied away.
 */
const UG_POLYMORPH = 'power-2010-3-antoine-ruel-ug-polymorph';
const POWER_2010 = '2010-07-16';
const POWER_2011 = '2011-07-15';
const POWER_2012 = '2012-07-13';
/**
 * Two more real decks, because a room has ONE pool (wave 25 §A) and a test
 * that needs one legal deck and one illegal one now needs both of them in the
 * SAME pool. `ELDRAZI_GREEN` is one of the twelve decks the 2011 era's own
 * catalogue carries, so it is legal in `POWER_2011` by construction
 * (`validate-library.ts`, 0 issues) — the same pool `UG_POLYMORPH` fails.
 */
const ELDRAZI_GREEN = 'power-2011-1-daniel-royde-eldrazi-green';
/**
 * The generic "second real deck", legal in `POWER_2010` alongside
 * `UG_POLYMORPH` (both native to the 2010 era), used wherever a test needs
 * "another deck" and nothing more specific — including every `bothLoaded`
 * call, which opens a room on `POWER_2010` by default.
 */
const SECOND_DECK = 'power-2010-1-emanuele-giusti-jund';
/** A real deck native to the 2011 era, used ONLY for the one test that needs a deck legal in `POWER_2011` and not in `POWER_2010`. */
const CAW_BLADE = 'power-2011-1-marcello-calvetta-caw-blade';
/**
 * Legal in literally any pool: a basic land is exempt from both the
 * pool-membership check and the copy limit (`format.ts`), so sixty Islands
 * passes every era's gate with zero issues. Used where a test needs a SECOND
 * deck that stays legal across a room's format change — no real two decks in
 * this library's nine eras are guaranteed to both survive a jump between two
 * of them, because each era is deliberately the far side of a full rotation
 * from its neighbours (`catalog.ts`'s own header).
 */
const ALWAYS_LEGAL_DCK = '[metadata]\nName=Basics\nDeck Type=Constructed\n[Main]\n60 Island\n';

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
		expect(library.formats.map((f) => f.id)).toContain(POWER_2010);
		expect(library.formats.map((f) => f.id)).toContain(POWER_2012);
		expect(library.formats.map((f) => f.pool.name)).toContain('Standard (M11)');
		expect(library.decks).toHaveLength(LIBRARY.flatMap((c: LibraryCollection) => c.decks).length);
	});

	it('names a file that will not load instead of refusing to boot', () => {
		const broken = loadTablesLibrary(REPO_ROOT, [
			{
				id: 'broken',
				family: 'standard',
				directory: 'decks/no-such-collection',
				event: 'nothing',
				format: 'Standard (M11)',
				date: POWER_2010,
				source: 'nowhere',
				decks: [{ id: 'ghost', file: 'ghost.dck' }],
			},
		]);
		expect(broken.decks).toEqual([]);
		expect(broken.faults).toHaveLength(1);
		expect(broken.faults[0]).toContain('ghost.dck');
		// The format still loads: one broken deck costs one entry, not the picker.
		// Exactly one, because the loader reads pools for the PASSED-IN library's
		// own dates (wave 34 §D), and this synthetic library names only one.
		expect(broken.formats).toHaveLength(1);
		expect(broken.formats[0]?.id).toBe(POWER_2010);
	});
});

/* ── the one check ───────────────────────────────────────────────────── */

describe('checkSeat', () => {
	const ctx = { library, draftPool: null };

	// Every deck, checked against ITS OWN collection's format rather than one
	// hardcoded date. The previous version iterated the whole library against
	// POWER_2010, which was correct only while the library held one collection —
	// the same shape of bug as asserting a collection's size against a
	// library-wide total. A DKA deck is legal in DKA and is not legal in a 2011
	// pool, and both of those are the right answer.
	it('passes every deck in the format it was actually played in', () => {
		// Each deck against ITS OWN collection's id, looked up rather than
		// guessed from the id — the prefix test that preceded this was a third
		// hardcoding of the same fact. `formatIdOf`, not the bare `c.date` (w48
		// §U): a Modern or Legacy deck's own era shares its date with Standard's
		// same-year era, and the bare date names the WRONG (Standard) pool.
		const formatOf = new Map<string, string>(
			LIBRARY.flatMap((c: LibraryCollection) => c.decks.map((d) => [d.id, formatIdOf(c)] as [string, string])),
		);
		for (const d of library.decks) {
			const format = formatOf.get(d.id) ?? POWER_2010;
			const v = checkSeat({ deck: { library: d.id }, rules: { kind: 'standard', format } }, ctx);
			expect(v, `${d.id} in ${format}`).toMatchObject({ legal: true, issues: [], note: null });
		}
	});

	/*
	 * The data behind the picker's era filter (wave 22 §B.4).
	 *
	 * `ConstructedScreen` narrows the deck dropdown to the decks legal in the
	 * chosen era, and it does so by asking THIS — one `POST /api/tables/check`
	 * per deck per era — rather than by arithmetic over the set list the browser
	 * is sent. That makes the filter the gate's answer instead of a guess, and
	 * it makes this test the thing that says the answer is usable: **no era
	 * narrows the list to nothing**, and **no deck is unreachable** through some
	 * era, so neither end of the picker has a dead option in it.
	 *
	 * Also the cost, measured rather than assumed: the whole matrix is 441 gate
	 * runs and this test is one of the fast ones. What the browser pays is round
	 * trips, which is why the screen asks once per era and remembers.
	 *
	 * Every count here is derived. A new collection or a new frozen pool moves
	 * all of them and must not fail this.
	 */
	it('answers the era filter for every deck and every era, with no dead option at either end', () => {
		const offered = new Map<string, string[]>();
		for (const format of library.formats) {
			const legal = library.decks
				.filter((d) => {
					const v = checkSeat({ deck: { library: d.id }, rules: { kind: 'standard', format: format.id } }, ctx);
					return 'legal' in v && v.legal;
				})
				.map((d) => d.id);
			offered.set(format.id, legal);
		}

		// An era that offered nothing would be a dead end a person can select.
		expect([...offered].filter(([, ids]) => ids.length === 0).map(([id]) => id)).toEqual([]);
		// A deck no era offers could never be chosen at all.
		const reachable = new Set([...offered.values()].flat());
		expect(library.decks.filter((d) => !reachable.has(d.id)).map((d) => d.id)).toEqual([]);

		// And the filter does NARROW: a deck offered by its own era is not
		// necessarily offered by another — UG Polymorph is legal in 2010 and the
		// bans (plus the rotation that comes with a year passing) cost it 2011.
		// Comparing the two eras' TOTAL counts would not show this: 2011 offers
		// more decks overall than 2010 simply because it has more decks native to
		// it (12 against 8), which has nothing to do with the ban.
		expect(offered.get(POWER_2010)).toContain(UG_POLYMORPH);
		expect(offered.get(POWER_2011)).not.toContain(UG_POLYMORPH);
	});

	it('refuses the same deck a year later, naming the banned card and the rotation', () => {
		const v = checkSeat({ deck: { library: UG_POLYMORPH }, rules: { kind: 'standard', format: POWER_2011 } }, ctx) as SeatVerdict;
		expect(v.legal).toBe(false);
		// Real cross-era history, not tidied: Essence Scatter and Polymorph rotated
		// out independently of the ban, so the deck fails three ways, not one.
		expect(v.issues.map((i) => [i.kind, i.cardName])).toEqual([
			['not-in-pool', 'Essence Scatter'],
			['not-in-pool', 'Polymorph'],
			['banned', 'Jace, the Mind Sculptor'],
		]);
		expect(v.issues.find((i) => i.kind === 'banned')?.message).toBe(
			'plays 4x Jace, the Mind Sculptor, which Standard (M12) bans',
		);
		// Not a fault in the deck, and said separately.
		expect(v.note).toContain('is built for "Standard (M11)"');
	});

	it('checks pasted .dck text the same way as a library deck', () => {
		const text = library.deck(UG_POLYMORPH)?.text ?? '';
		const pasted = checkSeat({ deck: { dck: text }, rules: { kind: 'standard', format: POWER_2011 } }, ctx) as SeatVerdict;
		const byId = checkSeat({ deck: { library: UG_POLYMORPH }, rules: { kind: 'standard', format: POWER_2011 } }, ctx) as SeatVerdict;
		expect(pasted.issues).toEqual(byId.issues);
		expect(pasted.text).toBe(byId.text);
	});

	it('answers an unknown deck or format as unresolved, not as an illegal deck', () => {
		expect(checkSeat({ deck: { library: 'nope' }, rules: { kind: 'standard', format: POWER_2010 } }, ctx)).toEqual({
			error: 'no library deck "nope"',
		});
		expect(checkSeat({ deck: { library: UG_POLYMORPH }, rules: { kind: 'standard', format: '1999-01-01' } }, ctx)).toEqual({
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
	/** The room's pool: one per table, for both seats. Mutable here, so a test can put a room in a state the leader's setter would never leave it in. */
	format: string;
	leader: string;
	/** `avatarId` optional and never blank, exactly as `RoomViewLike` states it. */
	members: { id: string; name: string; avatarId?: string }[];
	matchId: string | null;
	state: Map<string, unknown>;
}

interface FakeLobby extends TablesRooms {
	open(id: string, members: FakeRoom['members'], gameType?: string, format?: string): FakeRoom;
	room(id: string): FakeRoom | undefined;
}

function fakeLobby(): FakeLobby {
	const held = new Map<string, FakeRoom>();
	const member = (roomId: string, memberId: string): FakeRoom | undefined => {
		const room = held.get(roomId);
		return room !== undefined && room.members.some((m) => m.id === memberId) ? room : undefined;
	};
	return {
		open(id, members, gameType = 'constructed-1v1', format = POWER_2010) {
			// The first member is the leader, as `lobby.create` makes the creator one.
			const room: FakeRoom = {
				id,
				name: `room ${id}`,
				gameType,
				format,
				leader: members[0]?.id ?? '',
				members,
				matchId: null,
				state: new Map(),
			};
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
		releaseMatch(roomId) {
			const room = held.get(roomId);
			if (room === undefined) return false;
			room.matchId = null;
			// Every member's table state (the deck hold and its own `ready`) is
			// opaque to this fake, same as the real lobby: kept whole.
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
			seats: [standard(UG_POLYMORPH, POWER_2010), standard(SECOND_DECK, POWER_2010)],
		});
		expect(res.status).toBe(201);
		expect(typeof res.body.matchId).toBe('string');
		expect(h.specs).toHaveLength(1);
		expect(h.specs[0]?.seats.map((s) => s.deck)).toEqual([
			readFileSync(resolve(REPO_ROOT, 'decks/standard-2010/3-antoine-ruel-ug-polymorph.dck'), 'utf8'),
			readFileSync(resolve(REPO_ROOT, 'decks/standard-2010/1-emanuele-giusti-jund.dck'), 'utf8'),
		]);
	});

	it('refuses an illegal deck with the offending card named, and never launches Forge', async () => {
		const h = await boot();
		const res = await call(h, 'POST', '/api/play/matches', {
			opponent: 'ai',
			seats: [standard(UG_POLYMORPH, POWER_2011), standard(SECOND_DECK, POWER_2011)],
		});
		expect(res.status).toBe(422);
		expect(res.body.error).toBe(
			'Seat 1\'s deck "UG Polymorph (Antoine Ruel)" is not legal in Standard (M12): ' +
				'plays 1x Essence Scatter, which is not in Standard (M12) (and 2 more)',
		);
		const seats = res.body.seats as { legal: boolean; issues: { cardName: string }[] }[];
		// Both of these 2010 decks have rotated out of the 2011 pool; the refusal leads with seat 1.
		expect(seats.map((s) => s.legal)).toEqual([false, false]);
		expect(seats[0]?.issues.map((i) => i.cardName)).toEqual(['Essence Scatter', 'Polymorph', 'Jace, the Mind Sculptor']);
		// The .dck text stays on the server.
		expect(JSON.stringify(res.body)).not.toContain('[metadata]');
		expect(h.specs).toEqual([]);
	});

	it('refuses a raw .dck that skipped the gate', async () => {
		const h = await boot();
		const text = library.deck(UG_POLYMORPH)?.text;
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
		const bad = await call(h, 'POST', '/api/play/matches', { seats: [standard(UG_POLYMORPH, POWER_2010)] });
		expect(bad).toMatchObject({ status: 400, body: { error: 'seats is a two-element array' } });
		const unknown = await call(h, 'POST', '/api/play/matches', {
			opponent: 'ai',
			seats: [standard(UG_POLYMORPH, POWER_2010), standard('nope', POWER_2010)],
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
			{ seats: [standard(UG_POLYMORPH, POWER_2010), standard(SECOND_DECK, POWER_2010)] },
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
		expect(rows).toContainEqual([POWER_2010, []]);
		expect(rows).toContainEqual([POWER_2011, ['Jace, the Mind Sculptor', 'Stoneforge Mystic']]);
		expect(rows).toContainEqual([POWER_2012, []]);
		// The era's ruleset family (w48 §U) — every era on main today is Standard,
		// and the UI groups its tabs on this, never on a parsed `name`.
		const families = (formats.body.formats as { family: string }[]).map((f) => f.family);
		expect(families.length).toBeGreaterThan(0);
		expect(families.every((f) => f === 'standard' || f === 'modern' || f === 'legacy')).toBe(true);
		const decks = await call(h, 'GET', '/api/tables/decks');
		const list = decks.body.decks as { id: string; name: string; main: { count: number }[] }[];
		expect(list).toHaveLength(LIBRARY.flatMap((c: LibraryCollection) => c.decks).length);
		// The very first deck in catalog order: the oldest era, first deck chosen.
		// Derived from the loaded library itself, never a hardcoded id/name — w48
		// moved this exact pin once already (2008 → 2003, Standard backfilled five
		// more years), and a count fact restated here is a second copy free to go
		// stale the next time an era is added at the front.
		expect(list[0]).toMatchObject({ id: library.decks[0]!.id, name: library.decks[0]!.deck.name });
		expect(list[0]?.main.reduce((n, e) => n + e.count, 0)).toBe(60);
	});

	// Every era against every deck, by the route and one deck at a time: about 21,000 legality
	// checks. 0.95 s on hokon; past vitest's 5 s default on warm-claw-4 under the full check
	// (CI run 37588858089, 2026-10-07). The budget below is the measurement with room, not a pin.
	it('answers an era’s own legal decks in one call, the same answer as checking each deck', { timeout: 30_000 }, async () => {
		const h = await boot();
		const ctx = { library, draftPool: null };
		for (const format of library.formats) {
			const res = await call(h, 'GET', `/api/tables/legal/${encodeURIComponent(format.id)}`);
			expect(res.status, format.id).toBe(200);
			const oneByOne = library.decks
				.filter((d) => {
					if (d.era !== format.id) return false;
					const v = checkSeat({ deck: { library: d.id }, rules: { kind: 'standard', format: format.id } }, ctx);
					return 'legal' in v && v.legal;
				})
				.map((d) => d.id);
			expect(res.body, format.id).toEqual({ format: format.id, legal: oneByOne });
		}
		expect(h.specs).toEqual([]);
	});

	// The operator, 2026-10-09: "every year of modern has the same decks". Legality
	// alone offered every year the same Modern-legal Standard decks first.
	it('offers each Modern year its own decks, and no two years the same list', async () => {
		const h = await boot();
		const lists: string[] = [];
		for (const format of library.formats.filter((f) => f.family === 'modern')) {
			const res = await call(h, 'GET', `/api/tables/legal/${encodeURIComponent(format.id)}`);
			const ids = (res.body as { legal: string[] }).legal;
			expect(ids.length, format.id).toBeGreaterThan(0);
			for (const id of ids) expect(library.deck(id)?.era, `${format.id} offers ${id}`).toBe(format.id);
			lists.push(ids.join());
		}
		expect(lists.length).toBeGreaterThan(1);
		expect(new Set(lists).size).toBe(lists.length);
	});

	it('offers the whole library on Free pick', async () => {
		const h = await boot();
		const res = await call(h, 'GET', '/api/tables/legal/free');
		expect(res.status).toBe(200);
		expect((res.body as { legal: string[] }).legal).toEqual(library.decks.map((d) => d.id));
		const formats = (await call(h, 'GET', '/api/tables/formats')).body as { formats: { id: string; source: string }[] };
		expect(formats.formats.filter((f) => f.id === 'free')).toEqual([expect.objectContaining({ name: 'Free pick', source: 'free' })]);
	});

	it('refuses an era it does not have', async () => {
		const h = await boot();
		const res = await call(h, 'GET', '/api/tables/legal/1999-01-01');
		expect(res.status).toBe(400);
		expect(res.body).toEqual({ error: 'no format "1999-01-01"' });
	});

	it('checks a deck without starting anything', async () => {
		const h = await boot();
		const res = await call(h, 'POST', '/api/tables/check', standard(UG_POLYMORPH, POWER_2011));
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ legal: false, rulesName: 'Standard (M12)' });
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
				standard(SECOND_DECK, POWER_2010),
			],
		});
		expect(res.status).toBe(201);
		// The convergence, asserted: one request, a drafted 40-of-45 in seat 1 and a
		// prebuilt 60 in seat 2, and both arrive in the SAME field of the SAME spec
		// Forge is launched with — each exactly the text its own rule checked.
		expect(h.specs).toHaveLength(1);
		expect(h.specs[0]?.seats.map((s) => s.deck)).toEqual([text, library.deck(SECOND_DECK)?.text]);
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
	const legalText = (): string => library.deck(SECOND_DECK)?.text ?? '';
	const seatsFor = (dck: string) => ({
		opponent: 'ai',
		seats: [{ deck: { dck }, rules: { kind: 'standard', format: POWER_2010 } }, standard(UG_POLYMORPH, POWER_2010)],
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
			expect(res.body.error).toMatch(/^Seat 1's deck "Jund \(Emanuele Giusti\)" is not legal in Standard \(M11\): plays 4x Black Lotus /);

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
			'Seat 1\'s deck "Jund (Emanuele Giusti)" is not legal in Standard (M11): plays 4x Black Lotus in [planes], ' +
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
			seats: [{ deck: { dck: text }, rules: { kind: 'draft', draftId: 'amber-lantern-k7q4' } }, standard(UG_POLYMORPH, POWER_2010)],
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

	const openRoom = (h: Harness, gameType?: string, format?: string) =>
		h.lobby.open(ROOM, [...MEMBERS], gameType, format);
	const putDeck = (h: Harness, user: string, seat: unknown, roomId = ROOM) =>
		call(h, 'PUT', `/api/tables/rooms/${roomId}/deck`, seat, edgeHeaders(user));
	/**
	 * What a browser now sends: the deck, and no rules. The rules are the room's
	 * format, for both seats, and a body that names them is refused (§A.3).
	 */
	const deckBody = (deck: string) => ({ deck: { library: deck } });
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
		rulesName: string;
		legal: boolean;
		ready: boolean;
		issueCount: number;
		/** Present only for a player who has one — see the avatar test below. */
		avatarId?: string;
	}
	const players = (body: Record<string, unknown>): PlayerRow[] => body.players as PlayerRow[];

	/** Both members seated with a legal deck, each choosing only their own. */
	async function bothLoaded(h: Harness): Promise<void> {
		expect((await putDeck(h, 'alice', deckBody(UG_POLYMORPH))).status).toBe(200);
		expect((await putDeck(h, 'bob', deckBody(SECOND_DECK))).status).toBe(200);
	}

	it('starts the match from the room, each player in the seat their own deck is in', async () => {
		const h = await boot();
		openRoom(h);
		await bothLoaded(h);
		expect((await setReady(h, 'alice')).status).toBe(200);
		const second = await setReady(h, 'bob');
		expect(second.status).toBe(200);
		expect(players(second.body).map((p) => [p.deckName, p.ready])).toEqual([
			['UG Polymorph (Antoine Ruel)', true],
			['Jund (Emanuele Giusti)', true],
		]);

		const res = await startRoom(h, 'alice');
		expect(res.status).toBe(201);
		const matchId = res.body.matchId as string;

		// The decks Forge is launched with, in the order the two players loaded
		// them — each the text that player's own rule checked, byte for byte.
		expect(h.specs).toHaveLength(1);
		expect(h.specs[0]?.seats.map((s) => s.deck)).toEqual([library.deck(UG_POLYMORPH)?.text, library.deck(SECOND_DECK)?.text]);

		// And the seats are BOUND, so neither browser can arrive into the other
		// player's deck: `Match.claim` is otherwise first-come-first-served.
		const match = h.matches.get(matchId);
		expect(match?.seatOf(ALICE)).toBe(0);
		expect(match?.seatOf(BOB)).toBe(1);
		expect(h.lobby.room(ROOM)?.matchId).toBe(matchId);
	});

	// The operator, 2026-10-11: "let's make it 5 max per person".
	it('refuses a person a sixth match at once, by name, and a finished match frees the slot', async () => {
		const h = await boot();
		const startIn = async (roomId: string) => {
			h.lobby.open(roomId, [...MEMBERS]);
			expect((await putDeck(h, 'alice', deckBody(UG_POLYMORPH), roomId)).status).toBe(200);
			expect((await putDeck(h, 'bob', deckBody(SECOND_DECK), roomId)).status).toBe(200);
			await setReady(h, 'alice', true, roomId);
			await setReady(h, 'bob', true, roomId);
			return startNew(roomId);
		};
		// `start` feeds Forge's opening to the LAST host once there is one; for a sixth start the
		// last host is an earlier match's, so this waits for a new one or for the refusal.
		const startNew = async (roomId: string) => {
			const before = h.hosts.length;
			const pending = call(h, 'POST', '/api/play/matches', { room: roomId }, edgeHeaders('alice'));
			const deadline = Date.now() + 3000;
			let settled = false;
			void pending.then(() => (settled = true));
			while (h.hosts.length === before && !settled && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
			if (h.hosts.length > before) (h.hosts.at(-1) as ReplayHost).push(...OPENING);
			return pending;
		};
		for (let i = 1; i <= routesMod.MAX_MATCHES_PER_PERSON; i++) expect((await startIn(`r-cap-${String(i)}`)).status).toBe(201);
		const sixth = await startIn('r-cap-6');
		expect(sixth.status).toBe(409);
		expect(sixth.body.error).toBe(`user-alice is already playing ${routesMod.MAX_MATCHES_PER_PERSON} matches`);
		expect(h.specs).toHaveLength(routesMod.MAX_MATCHES_PER_PERSON);

		// One of them ends (a concession is a game over): it no longer counts.
		h.hosts[0]!.push({ t: 'gameover', winner: 'Seat 1' });
		await vi.waitFor(() => expect(h.matches.active().some((m) => m.status === 'over')).toBe(true));
		expect((await startNew('r-cap-6')).status).toBe(201);
	});

	// The operator, 2026-10-09: "a lobby toggle for 'Free pick' which allows anyone
	// to pick any deck regardless of format to play against each other".
	it('on Free pick, seats a Legacy deck against a Modern one and starts', async () => {
		const h = await boot();
		openRoom(h, undefined, 'free');
		const legacy = library.decks.find((d) => d.era.startsWith('legacy-'))!;
		const modern = library.decks.find((d) => d.era.startsWith('modern-'))!;
		expect((await putDeck(h, 'alice', deckBody(legacy.id))).status).toBe(200);
		const loaded = await putDeck(h, 'bob', deckBody(modern.id));
		expect(players(loaded.body).map((p) => [p.legal, p.rulesName])).toEqual([
			[true, 'Free pick'],
			[true, 'Free pick'],
		]);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		expect((await startRoom(h, 'alice')).status).toBe(201);
		expect(h.specs[0]?.seats.map((s) => s.deck)).toEqual([legacy.text, modern.text]);
	});

	/*
	 * A bot (the operator, 2026-10-02): the room's only member plays Forge's AI.
	 * The bot's deck is a random library deck legal in the room's own pool, and
	 * the player is seated in their own deck's seat, exactly as a room start does.
	 */
	describe('against a bot', () => {
		const startBot = (h: Harness, user: string, body: Record<string, unknown> = { room: ROOM, bot: true }) =>
			start(h, body, '/api/play/matches', 'application/json', edgeHeaders(user));

		it("starts the room's only player against Forge's AI with a legal library deck in seat 2", async () => {
			const h = await boot();
			h.lobby.open(ROOM, [{ id: ALICE, name: 'user-alice', avatarId: 'wanderer' }]);
			expect((await putDeck(h, 'alice', deckBody(UG_POLYMORPH))).status).toBe(200);

			const res = await startBot(h, 'alice');
			expect(res.status).toBe(201);
			expect(h.specs).toHaveLength(1);
			const seats = h.specs[0]!.seats as { deck: string | null; ai: boolean; name?: string; avatarId?: string }[];
			expect(seats[0]?.deck).toBe(library.deck(UG_POLYMORPH)?.text);
			expect(seats[0]?.ai).toBe(false);
			expect(seats[0]?.avatarId).toBe('wanderer');
			expect(seats[1]?.ai).toBe(true);
			// The bot plays a real library deck, and one that is legal in this room's pool.
			const botDeck = library.decks.find((d) => d.text === seats[1]?.deck);
			expect(botDeck).toBeDefined();
			// Checked the way a player's own deck is, in a second room on the same pool.
			h.lobby.open('r-check', [{ id: ALICE, name: 'user-alice' }], undefined, h.lobby.room(ROOM)?.format);
			const verdict = await putDeck(h, 'alice', deckBody(botDeck!.id), 'r-check');
			expect(verdict.status).toBe(200);
			expect(players(verdict.body)[0]?.legal).toBe(true);

			const matchId = res.body.matchId as string;
			expect(h.matches.get(matchId)?.seatOf(ALICE)).toBe(0);
			expect(h.lobby.room(ROOM)?.matchId).toBe(matchId);
		});

		it('plays a library deck from any era on Free pick', async () => {
			const h = await boot();
			h.lobby.open(ROOM, [{ id: ALICE, name: 'user-alice' }], undefined, 'free');
			expect((await putDeck(h, 'alice', deckBody(UG_POLYMORPH))).status).toBe(200);
			const res = await startBot(h, 'alice');
			expect(res.status).toBe(201);
			const seats = h.specs[0]!.seats as { deck: string | null }[];
			expect(library.decks.some((d) => d.text === seats[1]?.deck)).toBe(true);
		});

		it('is refused when a second person is in the room: they play each other', async () => {
			const h = await boot();
			openRoom(h);
			await bothLoaded(h);
			const res = await startBot(h, 'alice');
			expect(res.status).toBe(409);
			expect(res.body.error).toMatch(/one player/);
			expect(h.specs).toHaveLength(0);
		});

		it('is refused until the player has loaded a deck', async () => {
			const h = await boot();
			h.lobby.open(ROOM, [{ id: ALICE, name: 'user-alice' }]);
			const res = await startBot(h, 'alice');
			expect(res.status).toBe(409);
			expect(h.specs).toHaveLength(0);
		});

		it('refuses a bot field that is not true', async () => {
			const h = await boot();
			h.lobby.open(ROOM, [{ id: ALICE, name: 'user-alice' }]);
			expect((await putDeck(h, 'alice', deckBody(UG_POLYMORPH))).status).toBe(200);
			const res = await startBot(h, 'alice', { room: ROOM, bot: 'yes' });
			expect(res.status).toBe(400);
			expect(h.specs).toHaveLength(0);
		});
	});

	/*
	 * Item 4's server half (wave 29 §B), one hop further than the table-view
	 * test below: `startFromRoom` puts each player's `avatarId` on the SPEC
	 * Forge is launched with, in the same seat order as `decks` — never on
	 * `seats[].name` (`socket.ts`'s own note: "Forge shows these names to both
	 * seats; they are never an identity"). `play/socket.test.ts`'s
	 * `forge:seats` suite is where the CLIENT-facing shape of this is proved;
	 * this is where the ROOM member lands in the right seat.
	 */
	it("puts the right player's avatarId on the right seat of the spec Forge is launched with", async () => {
		const h = await boot();
		h.lobby.open(ROOM, [
			{ id: ALICE, name: 'user-alice', avatarId: 'wanderer' },
			{ id: BOB, name: 'user-bob' },
		]);
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');

		const res = await startRoom(h, 'alice');
		expect(res.status).toBe(201);
		expect(h.specs).toHaveLength(1);
		const seats = h.specs[0]?.seats as ({ avatarId?: string } | undefined)[];
		// Alice's deck (`UG_POLYMORPH`) is seat 0 and bob's (`SECOND_DECK`) is seat 1
		// (`bothLoaded`), so this is also an assertion that the identity travels
		// in the SAME order as the deck it rides beside.
		expect(seats[0]?.avatarId).toBe('wanderer');
		// ABSENT, not `undefined`-as-a-value and not `''` — `avatarId` in seats[1]
		// is never set at all (`D-avatar-field.md` §3).
		expect(seats[1]).not.toHaveProperty('avatarId');
		expect(JSON.stringify(seats)).not.toContain('"avatarId":""');
	});

	/*
	 * Wave 31 shape 1: the room's display names ride the start body (`names`, in
	 * `decks` order) and land on the Forge seats, so Forge's own prompts say
	 * "user-alice" and not "Seat 1".
	 */
	it("puts each member's display name on the seat their deck is in", async () => {
		const h = await boot();
		h.lobby.open(ROOM, [
			{ id: ALICE, name: 'user-alice' },
			{ id: BOB, name: 'user-bob' },
		]);
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');

		const res = await startRoom(h, 'alice');
		expect(res.status).toBe(201);
		const seats = h.specs[0]?.seats as { name: string }[];
		expect(seats.map((s) => s.name)).toEqual(['user-alice', 'user-bob']);
	});

	/*
	 * Item 4 of the 2026-09-28 play test: *"i noticed you're still not pulling in
	 * the watchparty selected avatars. why not?"*
	 *
	 * `avatarId` has been on `@wolffm/rooms-protocol`'s `RosterIdentity` and on
	 * `packages/room-store`'s `SerializedMember` all along; what was missing was
	 * this hop — the room member's field reaching the TABLE's players, beside the
	 * name the room already carried. `playersOf` hands the member row through
	 * verbatim and `tableView` spreads it, so both assertions below are about the
	 * same one line and the second is the one that can regress quietly.
	 *
	 * The three states of `avatarId?: string | null` collapse to TWO here — a
	 * non-blank string, or an ABSENT key — and the absence is asserted with
	 * `toHaveProperty`, not with `toBeUndefined()`: `avatarId: undefined` passes
	 * the latter and is exactly the shape that makes an in-process reader and a
	 * JSON reader disagree.
	 */
	it("carries a member's avatarId to the table view, and leaves the key off a member with none", async () => {
		const h = await boot();
		// Alice picked a character in watchparty's room; Bob never did. Both are
		// members of the same room, so one table answers both cases.
		h.lobby.open(ROOM, [
			{ id: ALICE, name: 'user-alice', avatarId: 'wanderer' },
			{ id: BOB, name: 'user-bob' },
		]);
		await bothLoaded(h);

		const seen = await view(h, 'alice');
		expect(seen.status).toBe(200);
		const rows = players(seen.body);
		expect(rows.map((p) => p.name)).toEqual(['user-alice', 'user-bob']);
		expect(rows[0]?.avatarId).toBe('wanderer');
		// ABSENT, not empty and not null. `call` parses the response TEXT, so a
		// key missing here is a key missing on the wire — and an empty string
		// would be the real hazard: it survives a `!== undefined` check and then
		// resolves to `…/square_.png`, which draws as a broken image exactly where
		// the caller wanted its fallback.
		expect(rows[1]).not.toHaveProperty('avatarId');
		const wire = JSON.stringify(seen.body);
		expect(wire).toContain('"avatarId":"wanderer"');
		expect(wire).not.toContain('"avatarId":""');
		expect(wire).not.toContain('"avatarId":null');

		// The other player's copy of the table says the same thing. A face is not
		// hidden information — both seats already read each other's names — so
		// unlike `choice` this field is not caller-scoped.
		const theirs = players((await view(h, 'bob')).body);
		expect(theirs[0]?.avatarId).toBe('wanderer');
		expect(theirs[1]).not.toHaveProperty('avatarId');
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

		// ONE JVM, and the second ask is never a refusal: whether it arrives while
		// the first is still starting (it waits and joins) or after (the room's
		// live match), it is answered the match that was started.
		expect(h.specs).toHaveLength(1);
		expect(answers.map((r) => r.status).sort()).toEqual([200, 201]);
		const started = answers.find((r) => r.status === 201)?.body.matchId;
		expect(typeof started).toBe('string');
		for (const answer of answers) expect(answer.body.matchId).toBe(started);
		expect(h.lobby.room(ROOM)?.matchId).toBe(started);
		expect(h.matches.get(started as string)?.seatOf(ALICE)).toBe(0);
		expect(h.matches.get(started as string)?.seatOf(BOB)).toBe(1);
	});

	/** Both ready, alice's start in flight and Forge not yet up: what bob's browser meets when it asks too. */
	async function aliceStarting(h: Harness, signal?: AbortSignal): Promise<{ pending: Promise<Response> }> {
		openRoom(h);
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		const pending = fetch(`http://127.0.0.1:${h.port}/api/play/matches`, {
			method: 'POST',
			headers: { ...edgeHeaders('alice'), 'content-type': 'application/json' },
			body: JSON.stringify({ room: ROOM }),
			signal,
		});
		const deadline = Date.now() + 3000;
		while (h.hosts.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
		expect(h.hosts).toHaveLength(1);
		return { pending };
	}

	it('answers an ask made while the start is in flight with that same match once it is up, not a refusal', async () => {
		const h = await boot();
		const { pending: first } = await aliceStarting(h);
		const second = call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('bob'));
		await new Promise((r) => setTimeout(r, 50));
		h.hosts[0]!.push(...OPENING);
		const [a, b] = [await first, await second];
		const started = ((await a.json()) as { matchId: string }).matchId;
		expect(a.status).toBe(201);
		expect(b).toMatchObject({ status: 200, body: { matchId: started } });
		expect(h.specs).toHaveLength(1);
	});

	it('gives an ask that joined a failing start the same refusal', async () => {
		const h = await boot();
		const { pending: first } = await aliceStarting(h);
		const second = call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('bob'));
		await new Promise((r) => setTimeout(r, 50));
		h.hosts[0]!.exit('the JVM died');
		const [a, b] = [await first, await second];
		const refusal = (await a.json()) as { error: string };
		expect(a.status).toBe(500);
		expect(b.status).toBe(500);
		expect(b.body.error).toBe(refusal.error);
		// Freed: the next ask starts afresh.
		const again = call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('alice'));
		const deadline = Date.now() + 3000;
		while (h.hosts.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
		h.hosts[1]!.push(...OPENING);
		expect((await again).status).toBe(201);
	});

	it('keeps one start when the asker reloads mid-start: the reloaded ask joins it rather than launching a second JVM', async () => {
		const h = await boot();
		const gone = new AbortController();
		const { pending: first } = await aliceStarting(h, gone.signal);
		gone.abort();
		await first.catch(() => undefined);
		await new Promise((r) => setTimeout(r, 50));
		const reloaded = call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('alice'));
		await new Promise((r) => setTimeout(r, 50));
		h.hosts[0]!.push(...OPENING);
		const answer = await reloaded;
		expect(answer.status).toBe(200);
		expect(h.specs).toHaveLength(1);
		expect(h.lobby.room(ROOM)?.matchId).toBe(answer.body.matchId);
	});

	it('refuses a body that names two decks against a person, and says where a match starts', async () => {
		const h = await boot();
		const res = await call(h, 'POST', '/api/play/matches', {
			opponent: 'human',
			seats: [standard(UG_POLYMORPH, POWER_2010), standard(SECOND_DECK, POWER_2010)],
		});
		expect(res.status).toBe(422);
		expect(res.body.error).toContain('starts from a room');
		expect(h.specs).toEqual([]);
		// The default opponent is 'human', so the shape is closed without one too.
		const bare = await call(h, 'POST', '/api/play/matches', {
			seats: [standard(UG_POLYMORPH, POWER_2010), standard(SECOND_DECK, POWER_2010)],
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
		expect(await call(h, 'PUT', '/api/tables/rooms/r-nope/deck', deckBody(UG_POLYMORPH), edgeHeaders('alice'))).toEqual(
			missing,
		);
		expect(await putDeck(h, 'carol', deckBody(UG_POLYMORPH))).toEqual(missing);
		expect(await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('carol'))).toEqual(missing);
		expect(await call(h, 'POST', '/api/play/matches', { room: 'r-nope' }, edgeHeaders('alice'))).toEqual(missing);
		expect(h.specs).toEqual([]);
		expect(CAROL).not.toBe(ALICE);
	});

	it('blocks only the player whose deck is illegal, naming the card', async () => {
		const h = await boot();
		// One pool for the table, and UG_POLYMORPH is the deck the bans cost: alice is
		// illegal in it and ELDRAZI_GREEN is legal in the same pool, so the asymmetry under
		// test is between two decks rather than between two players' formats.
		openRoom(h, undefined, POWER_2011);
		const loaded = await putDeck(h, 'alice', deckBody(UG_POLYMORPH));
		expect(loaded.status).toBe(200);
		expect(players(loaded.body)[0]).toMatchObject({ legal: false, issueCount: 3 });
		// A count, not a list: the card is named once, by the refusal below.
		expect(players(loaded.body)[0]).not.toHaveProperty('verdict');

		const refused = await setReady(h, 'alice');
		expect(refused.status).toBe(422);
		// The refusal leads with the FIRST issue, which for this deck is a
		// rotated-out card rather than the ban — both are real faults of the
		// same deck a year on.
		expect(refused.body.error).toContain('Essence Scatter');

		// The other player is untouched by it: they load, they ready.
		expect((await putDeck(h, 'bob', deckBody(ELDRAZI_GREEN))).status).toBe(200);
		expect((await setReady(h, 'bob')).status).toBe(200);

		const blocked = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('bob'));
		expect(blocked.status).toBe(409);
		expect(blocked.body.error).toContain('user-alice');
		expect(h.specs).toEqual([]);

		// And a legal deck unblocks it: same player, same room, same pool — what
		// changes is the deck, because the pool is not the player's to change.
		expect((await putDeck(h, 'alice', deckBody(ELDRAZI_GREEN))).status).toBe(200);
		expect((await setReady(h, 'alice')).status).toBe(200);
		expect((await startRoom(h, 'bob')).status).toBe(201);
	});

	it('un-readies a player who loads a different deck', async () => {
		const h = await boot();
		openRoom(h);
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		const reloaded = await putDeck(h, 'alice', deckBody(SECOND_DECK));
		expect(players(reloaded.body).map((p) => p.ready)).toEqual([false, true]);
		const res = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('bob'));
		expect(res).toMatchObject({ status: 409, body: { error: 'user-alice is not ready yet' } });
		expect(h.specs).toEqual([]);
	});

	it('will not seat a third member, and will not let anyone name another member’s deck', async () => {
		const h = await boot();
		h.lobby.open(ROOM, [...MEMBERS, { id: CAROL, name: 'user-carol' }]);
		await bothLoaded(h);
		const third = await putDeck(h, 'carol', deckBody(UG_POLYMORPH));
		expect(third).toMatchObject({ status: 409, body: { error: 'this table already has two players' } });
		// There is no field that names a member — a body that invents one is refused.
		const named = await putDeck(h, 'carol', { ...deckBody(UG_POLYMORPH), member: ALICE });
		expect(named).toMatchObject({ status: 400, body: { error: 'body: unknown field member' } });
		// Carol sees the table, as a member of the room who is not playing — and she
		// is not its leader either, which alice is.
		const seen = await view(h, 'carol');
		expect(seen.body.you).toEqual({ player: false, leader: false });
		expect(players(seen.body).map((p) => p.you)).toEqual([false, false]);
	});

	it('shows the other player’s state without their issues or their .dck', async () => {
		const h = await boot();
		openRoom(h, undefined, POWER_2011);
		await putDeck(h, 'alice', deckBody(UG_POLYMORPH));
		await putDeck(h, 'bob', deckBody(ELDRAZI_GREEN));
		const seen = await view(h, 'bob');
		const [mine, theirs] = [players(seen.body)[1], players(seen.body)[0]];
		expect(mine).toMatchObject({ you: true, legal: true });
		// Alice's faults reach Bob as a count and a name, never as a card list:
		// a draft verdict would say what she drafted.
		expect(theirs).toMatchObject({ you: false, legal: false, issueCount: 3, deckName: 'UG Polymorph (Antoine Ruel)' });
		for (const row of [mine, theirs]) expect(row).not.toHaveProperty('verdict');
		expect(JSON.stringify(seen.body)).not.toContain('[metadata]');
	});

	it('refuses a table in a room that is not constructed 1v1', async () => {
		const h = await boot();
		h.lobby.open(ROOM, [...MEMBERS], 'draft');
		const res = await putDeck(h, 'alice', deckBody(UG_POLYMORPH));
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
	 * The operator's game, 2026-10-10: a deploy mid-match restored the room
	 * without its match (rooms restore `matchId: null`; the match itself carried
	 * on) but WITH both players still ready, so the first table read after the
	 * game — one press of Rematch — started a new match with nobody else asking.
	 * A start spends both Readys, so a room that loses its match id finds
	 * nobody ready.
	 */
	it('a start spends both Readys: a room that loses its match id mid-game starts nothing on its own', async () => {
		const h = await boot();
		openRoom(h);
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		const started = await startRoom(h, 'alice');
		expect(started.status).toBe(201);
		const during = await view(h, 'bob');
		expect(players(during.body).map((p) => p.ready)).toEqual([false, false]);

		// What a restart's restore does to the room while the match plays on.
		h.lobby.setMatch(ROOM, null);
		const refused = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('alice'));
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/is not ready yet/);
	});

	/**
	 * R16. `over` sits for `overGraceMs` (ten minutes) before a host actually
	 * stops, and before this fix only `stopped`/`failed` released a room's
	 * match — so reading the room during that whole window (exactly what
	 * clicking "Rematch" does next) sent a returning player straight back into
	 * the match that just ended. A REAL `Match`, driven to `over` by a genuine
	 * `gameover` line on its host, not a fake registry: the fact under test is
	 * `match.ts`'s own status transition reaching `liveMatchId`.
	 */
	it('releases the room once its match is OVER, not only once it is stopped or failed', async () => {
		const h = await boot();
		openRoom(h);
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		const started = await startRoom(h, 'alice');
		expect(started.status).toBe(201);
		const matchId = started.body.matchId as string;
		expect(h.matches.get(matchId)?.status).toBe('running');

		(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: null });
		expect(h.matches.get(matchId)?.status).toBe('over');

		const seen = await view(h, 'alice');
		expect((seen.body.room as { matchId: string | null }).matchId).toBeNull();
		// Un-matched, both decks still held for a Rematch, and nobody ready: the
		// start spent both Readys.
		expect(players(seen.body).map((p) => [p.deckName !== '', p.ready])).toEqual([
			[true, false],
			[true, false],
		]);
		expect(h.lobby.room(ROOM)?.matchId).toBeNull();

		// Reverted (comment out the `=== 'over'` arm of `finished` in
		// `liveMatchId`): this exact assertion is what fails — `matchId` comes
		// back as the finished match's id instead of null. 1 failed.
		// Restored: passes. 1 passed.

		// A Rematch: both ready again with the decks they hold, and a new match starts.
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		// NOT `startRoom`/`start()`: both assume `h.hosts` starts empty, which is
		// true for every OTHER test (one `boot()`, one match) and false here —
		// this is the SECOND match on one harness. Reused as-is, `start()` would
		// see `h.hosts.length` already > 0, skip waiting for the NEW host, and
		// push `OPENING` to the FIRST (already-finished) one instead — exactly
		// `socket.test.ts`'s own `startMatch` pattern, done by hand.
		const hostsBefore = h.hosts.length;
		const pending = call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('alice'));
		const deadline = Date.now() + 3000;
		while (h.hosts.length <= hostsBefore) {
			if (Date.now() > deadline) break;
			await new Promise((r) => setTimeout(r, 5));
		}
		(h.hosts.at(-1) as ReplayHost).push(...OPENING);
		const again = await pending;
		expect(again.status).toBe(201);
		expect(again.body.matchId).not.toBe(matchId);
	});

	/**
	 * Wave 25 §A, the consequence stated: a drafted deck is not brought to a room
	 * table at all, because a room table's rules are its room's pool and a drafted
	 * pool is nobody's format. That path is `POST /api/play/matches` with `seats`
	 * against the AI, which still carries `rules` per seat — the describe block
	 * above exercises it, including the refusal of a card the caller did not draft.
	 *
	 * The hazard that shape used to carry is why the room's pool had to become the
	 * rule rather than a per-seat one: a `{ kind: 'draft' }` rule resolves the pool
	 * of whoever is making the REQUEST, so Bob pressing start would have had
	 * Alice's deck checked against Bob's (empty) pool. One pool per table, named by
	 * the room, cannot do that to anybody.
	 */
	it('refuses a drafted deck at a room table, because the room owns the rules', async () => {
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

		const refused = await putDeck(h, 'alice', { deck: { dck: text }, rules: { kind: 'draft', draftId } });
		expect(refused.status).toBe(400);
		expect(refused.body.error).toContain('unknown field rules');
		// Nothing was held: the refusal is whole, so alice is not a player.
		expect(players((await view(h, 'alice')).body)).toEqual([]);

		// The same `.dck`, with no rules, is checked against the ROOM's pool — and
		// a cube deck is not legal in a Standard pool, which is the honest answer
		// rather than a pool of the caller's choosing.
		const asIs = await putDeck(h, 'alice', { deck: { dck: text } });
		expect(asIs.status).toBe(200);
		expect(players(asIs.body)[0]).toMatchObject({ legal: false, rulesName: 'Standard (M11)' });

		// And `/api/tables/check` still takes rules, because it starts nothing and
		// belongs to no room: this is where a drafted deck is still checked.
		const checked = await call(
			h,
			'POST',
			'/api/tables/check',
			{ deck: { dck: text }, rules: { kind: 'draft', draftId } },
			edgeHeaders('alice'),
		);
		expect(checked).toMatchObject({ status: 200, body: { legal: true } });
		expect(h.specs).toEqual([]);
	});

	it('refuses a start before both players have loaded a deck', async () => {
		const h = await boot();
		openRoom(h);
		const empty = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('alice'));
		expect(empty).toMatchObject({ status: 409, body: { error: 'both players have to load a deck first' } });
		await putDeck(h, 'alice', deckBody(UG_POLYMORPH));
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

	/* ── the pool is the room's, and the leader's (wave 25 §A) ─────────── */

	it('refuses a PUT deck that carries rules', async () => {
		const h = await boot();
		openRoom(h);
		const refused = await putDeck(h, 'alice', standard(UG_POLYMORPH, POWER_2011));
		expect(refused.status).toBe(400);
		expect(refused.body.error).toBe(
			"body: unknown field rules — a table's rules are its room's format, which only the room leader changes",
		);
		// Refused WHOLE: no deck was held under the caller's own idea of the format.
		expect(players((await view(h, 'alice')).body)).toEqual([]);
		// And `rules` is refused even smuggled in beside a deck that would be fine,
		// which is what makes this a stated refusal rather than a silent ignore.
		expect((await putDeck(h, 'alice', { ...deckBody(UG_POLYMORPH), rules: null })).status).toBe(400);
		expect((await putDeck(h, 'alice', deckBody(UG_POLYMORPH))).status).toBe(200);
	});

	it('checks the deck against the ROOM’s pool, and says so in the verdict', async () => {
		const h = await boot();
		// The same deck, the same body, two rooms on two pools: the verdict follows
		// the ROOM. Nothing in the request says which pool, because nothing may.
		h.lobby.open('r-mbs', [...MEMBERS], undefined, POWER_2010);
		h.lobby.open('r-bans', [...MEMBERS], undefined, POWER_2011);

		const inMbs = await putDeck(h, 'alice', deckBody(UG_POLYMORPH), 'r-mbs');
		expect(inMbs.status).toBe(200);
		expect(players(inMbs.body)[0]).toMatchObject({ legal: true, rulesName: 'Standard (M11)' });
		expect((inMbs.body.room as { format: string }).format).toBe(POWER_2010);

		const inBans = await putDeck(h, 'alice', deckBody(UG_POLYMORPH), 'r-bans');
		expect(inBans.status).toBe(200);
		expect(players(inBans.body)[0]).toMatchObject({ legal: false, rulesName: 'Standard (M12)' });
		expect((inBans.body.room as { format: string }).format).toBe(POWER_2011);
	});

	it('refuses a start when a deck is illegal in the room’s pool though legal in another', async () => {
		const h = await boot();
		// Both legal in the 2011 era's pool: CAW_BLADE is native to it, and sixty
		// Islands is legal in any pool by construction (a basic is exempt from both
		// the pool-membership check and the copy limit). Both players ready, the
		// match would start. Then the room moves to the 2010 era's pool instead —
		// where CAW_BLADE plays cards (Mana Leak|M12, Gideon Jura, Timely
		// Reinforcements…) that did not exist yet, and the Islands still do.
		const room = openRoom(h, undefined, POWER_2011);
		expect((await putDeck(h, 'alice', deckBody(CAW_BLADE))).status).toBe(200);
		expect((await putDeck(h, 'bob', { deck: { dck: ALWAYS_LEGAL_DCK } })).status).toBe(200);
		expect((await setReady(h, 'alice')).status).toBe(200);
		expect((await setReady(h, 'bob')).status).toBe(200);

		// Set directly, which is a state the leader's setter would never leave
		// behind — it drops every hold and both ready flags. That is the point: the
		// start route does not trust the stored verdict, it checks the room's pool.
		room.format = POWER_2010;
		const refused = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('bob'));
		expect(refused.status).toBe(422);
		expect(refused.body.error).toBe("user-alice's deck is not legal in Standard (M11)");
		// The card is NOT named: bob pressed start, and what is wrong with alice's
		// deck is alice's to read.
		expect(JSON.stringify(refused.body)).not.toContain('Squadron Hawk');
		expect(refused.body.verdict).toBeUndefined();
		expect(refused.body.issues).toBeUndefined();
		expect(h.specs).toEqual([]);

		// Back on the pool both decks are legal in, the same two holds start.
		room.format = POWER_2011;
		expect((await startRoom(h, 'bob')).status).toBe(201);
	});

	it('tells exactly one member the room is theirs to set: you.leader', async () => {
		const h = await boot();
		h.lobby.open(ROOM, [...MEMBERS, { id: CAROL, name: 'user-carol' }]);
		const seen = await Promise.all([view(h, 'alice'), view(h, 'bob'), view(h, 'carol')]);
		expect(seen.map((r) => (r.body.you as { leader: boolean }).leader)).toEqual([true, false, false]);
		// The flag is the room's leader and nothing else: alice leads without a deck.
		expect(seen.map((r) => r.body.you)).toEqual([
			{ player: false, leader: true },
			{ player: false, leader: false },
			{ player: false, leader: false },
		]);
	});

	it('answers 409 for a room whose pool this server does not have', async () => {
		const h = await boot();
		const room = openRoom(h, undefined, '1999-01-01');
		const loaded = await putDeck(h, 'alice', deckBody(UG_POLYMORPH));
		expect(loaded).toMatchObject({
			status: 409,
			body: { error: 'this room\'s format "1999-01-01" is not one this server has' },
		});
		// A room that goes unknown UNDER a loaded table refuses the start too, and
		// with the same sentence: nothing is checked against a pool nobody froze.
		room.format = POWER_2010;
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		room.format = 'unavailable';
		const started = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('alice'));
		expect(started).toMatchObject({ status: 409, body: { error: 'this room\'s format "unavailable" is not one this server has' } });
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

/* ── a room on a DRAFTED pool: the two halves finally meet (wave 26 §F) ── */

/**
 * A drafted deck against a FRIEND, which until wave 26 was not a thing the
 * server could do.
 *
 * The hole wave 25 exposed: a room's pool was a `FormatId`, a match against a
 * person starts from a room, and a drafted pool could not be named as a room's
 * pool — so "cube drafting + Magic play for a private friend group" had two
 * halves that never met. The reason it could not be done by simply allowing the
 * rule was real, and it is what these tests are about: a `{ kind: 'draft' }`
 * rule resolves ONE PERSON's pool, so a start route that re-checks both decks in
 * the REQUESTER's context measures the other player's deck against the
 * requester's 45 and reads every card of it as undrafted.
 *
 * The fix is that the room owns the POD and each player owns their own 45:
 * `routes.ts` re-checks each stored deck in `contextFor(thatPlayer.member.id)`,
 * and a room member's id is the participant id the pod seated them with.
 *
 * Two pools that share no card, so "checked against the wrong player's pool" is
 * not a subtle difference — it is every card in the deck. The disjointness is
 * asserted rather than assumed, because the cube being singleton is what makes
 * it true.
 */
describe('a room on a drafted pool', () => {
	const MEMBERS = [
		{ id: ALICE, name: 'user-alice' },
		{ id: BOB, name: 'user-bob' },
	];
	const ROOM = 'r-drafted';
	const POD = 'amber-lantern-k7q4';

	interface Pod {
		alice: DraftCard[];
		bob: DraftCard[];
	}

	/** One row of the table view. Its own copy: the describe above owns its own. */
	interface Row {
		seat: number;
		you: boolean;
		legal: boolean;
		rulesName: string;
		issueCount: number;
	}
	const players = (body: Record<string, unknown>): Row[] => body.players as Row[];

	/**
	 * One pod, both members seated, each holding 45 cards the other does not.
	 *
	 * `swap` seats them with each other's halves — the state a second pod is put
	 * in so that "the start re-checks, per player" can be caught failing.
	 */
	function pod(h: Harness, draftId = POD, swap = false): Pod {
		const room = h.rooms.open(draftId);
		const seatA = joinDraftRoom(room, `sock-a-${draftId}`, ALICE, 'friend').seat;
		const seatB = joinDraftRoom(room, `sock-b-${draftId}`, BOB, 'friend').seat;
		if (seatA === null || seatB === null) throw new Error('both drafters must be seated');
		const state = stateOf(room);
		const cards = state.packs.flat();
		const first = cards.slice(0, 45);
		const second = cards.slice(45, 90);
		const alice = swap ? second : first;
		const bob = swap ? first : second;
		state.pools[seatA] = alice;
		state.pools[seatB] = bob;
		// The property every assertion below rests on. A cube is singleton, so the
		// two halves of its packs name no card in common — said out loud, because a
		// cube that ever stopped being singleton would make these tests pass for
		// the wrong reason.
		const names = new Set(alice.map((c) => c.name));
		expect(bob.filter((c) => names.has(c.name))).toEqual([]);
		return { alice, bob };
	}

	/** A 40-card maindeck out of one person's own 45. The browser's own writer. */
	function built(pool: readonly DraftCard[], draftId = POD): string {
		let deck = deckFromPool(draftId, pool);
		for (const card of pool.slice(0, 40)) {
			const entry = deck.sideboard.find((e) => e.card.name === card.name && e.card.set === (card.setCode || null));
			if (entry !== undefined) deck = moveToMain(deck, entry.card, 1);
		}
		return dckTextOf(deck);
	}

	const openRoom = (h: Harness, format = draftPoolId(POD)) => h.lobby.open(ROOM, [...MEMBERS], undefined, format);
	const putDeck = (h: Harness, user: string, dck: string) =>
		call(h, 'PUT', `/api/tables/rooms/${ROOM}/deck`, { deck: { dck } }, edgeHeaders(user));
	const setReady = (h: Harness, user: string) =>
		call(h, 'POST', `/api/tables/rooms/${ROOM}/ready`, { ready: true }, edgeHeaders(user));

	/**
	 * THE test. Two people, one pod, one room, two decks from two different 45s,
	 * and a real match.
	 *
	 * The per-caller resolution is what this asserts, and it asserts it where it
	 * is load-bearing: the start is pressed by ALICE, so a start route that used
	 * the requester's context would check bob's deck against alice's pool. Every
	 * card of it would come back `plays 1x X but drafted 0` and the answer would
	 * be a 422 instead of a 201.
	 */
	it('starts a human match with each seat checked against its OWN drafted pool', async () => {
		const h = await boot();
		const pools = pod(h);
		openRoom(h);

		const mine = await putDeck(h, 'alice', built(pools.alice));
		expect(mine.status).toBe(200);
		const theirs = await putDeck(h, 'bob', built(pools.bob));
		expect(theirs.status).toBe(200);
		// Each verdict is taken in that player's OWN pool, and each says so in the
		// first person to its own owner.
		expect(players(mine.body)[0]).toMatchObject({ legal: true, rulesName: `your pool from ${POD}` });
		expect(players(theirs.body)[1]).toMatchObject({ legal: true, rulesName: `your pool from ${POD}` });
		// And the room says what pool it is on, without the client having to know
		// how a drafted pool id is spelled.
		expect(mine.body.room).toMatchObject({ format: draftPoolId(POD), draftId: POD });

		expect((await setReady(h, 'alice')).status).toBe(200);
		expect((await setReady(h, 'bob')).status).toBe(200);

		const res = await start(h, { room: ROOM }, '/api/play/matches', 'application/json', edgeHeaders('alice'));
		expect(res.status).toBe(201);
		const matchId = res.body.matchId as string;

		// Forge is launched with both drafted decks, each the text its own owner's
		// pool checked, byte for byte — and the seats are bound to their owners.
		expect(h.specs).toHaveLength(1);
		expect(h.specs[0]?.seats.map((s) => s.deck)).toEqual([built(pools.alice), built(pools.bob)]);
		expect(h.matches.get(matchId)?.seatOf(ALICE)).toBe(0);
		expect(h.matches.get(matchId)?.seatOf(BOB)).toBe(1);
	});

	/**
	 * The same table, started by the OTHER player. Both directions, because "the
	 * room's drafted pool resolves to the leader's" and "…to the requester's" are
	 * two different wrong answers and only one of them is caught by starting as
	 * the leader. Alice is the leader here (`fakeLobby` makes the first member
	 * one), so bob pressing start is the case where the leader is neither the
	 * requester nor the owner of the seat being checked.
	 */
	it('starts the same table when the player who is NOT the leader presses start', async () => {
		const h = await boot();
		const pools = pod(h);
		const room = openRoom(h);
		expect(room.leader).toBe(ALICE);
		await putDeck(h, 'alice', built(pools.alice));
		await putDeck(h, 'bob', built(pools.bob));
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		const res = await start(h, { room: ROOM }, '/api/play/matches', 'application/json', edgeHeaders('bob'));
		expect(res.status).toBe(201);
		expect(h.specs[0]?.seats.map((s) => s.deck)).toEqual([built(pools.alice), built(pools.bob)]);
	});

	/**
	 * A player cannot load a deck from somebody else's drafted pool.
	 *
	 * Bob sends ALICE's deck — the exact text she loaded, which the server has
	 * just accepted from her — and it is refused for him, by name, because the
	 * pool his deck is checked against is HIS. There is no field in the body that
	 * could say otherwise: the pod comes from the room and the person comes from
	 * the edge headers.
	 *
	 * And the refusal is his own to read: alice's row shows him a count and the
	 * room's pool in the third person, never a card from her 45.
	 */
	it('refuses a deck built from the other player’s pool, and names the card to its owner only', async () => {
		const h = await boot();
		const pools = pod(h);
		openRoom(h);
		expect((await putDeck(h, 'alice', built(pools.alice))).status).toBe(200);

		const stolen = await putDeck(h, 'bob', built(pools.alice));
		expect(stolen.status).toBe(200);
		const bobsRow = players(stolen.body)[1];
		// Every card of it, because the two pools share none.
		expect(bobsRow).toMatchObject({ you: true, legal: false, issueCount: 45 });
		// An illegal deck cannot be readied, so it can never reach a start — and
		// the refusal names the card, to HIM: it is his deck, and the cards in it
		// are the ones he sent.
		const refused = await setReady(h, 'bob');
		expect(refused.status).toBe(422);
		expect(refused.body.error).toContain(pools.alice[0]?.name);
		expect((await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('bob'))).status).toBe(409);
		expect(h.specs).toEqual([]);

		// What ALICE is told about bob's row: a count, and the pool in the third
		// person — never his issue list, and never his `.dck`. (Her own row echoes
		// her own choice back to her, which is what restores her picker; the rule is
		// about somebody ELSE's row.)
		const seen = await call(h, 'GET', `/api/tables/rooms/${ROOM}`, undefined, edgeHeaders('alice'));
		const hisRow = players(seen.body)[1];
		expect(hisRow).toMatchObject({ you: false, legal: false, issueCount: 45, rulesName: `their own pool from ${POD}` });
		expect(hisRow).not.toHaveProperty('verdict');
	});

	/**
	 * The start refusal names the PLAYER and the pool, and never a card.
	 *
	 * Reached the way the frozen-era version of this test reaches it: the room's
	 * pool is moved under two loaded, readied decks — a state the leader's setter
	 * would never leave behind, because moving the pool drops both holds. That is
	 * the point. The start does not trust the stored verdicts; it re-checks, once
	 * per player, in that player's own context.
	 *
	 * The second pod holds the same two 45s with the owners SWAPPED, so after the
	 * move each player's deck is made entirely of cards the other one drafted.
	 * Bob presses start, and what comes back names alice and the pool with not one
	 * of her cards in it — which is the whole privacy rule, and it matters more on
	 * a drafted pool than on a frozen era, because a drafted pool IS the hidden
	 * information.
	 */
	it('refuses a start naming the player and the pool, never a card', async () => {
		const h = await boot();
		const pools = pod(h);
		const room = openRoom(h);
		await putDeck(h, 'alice', built(pools.alice));
		await putDeck(h, 'bob', built(pools.bob));
		await setReady(h, 'alice');
		await setReady(h, 'bob');

		const OTHER = 'r-pod-swapped';
		pod(h, OTHER, true);
		room.format = draftPoolId(OTHER);

		const refused = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('bob'));
		expect(refused.status).toBe(422);
		expect(refused.body.error).toBe(`user-alice's deck is not legal in their own pool from ${OTHER}`);
		for (const card of pools.alice.slice(0, 5)) {
			expect(JSON.stringify(refused.body)).not.toContain(card.name);
		}
		expect(refused.body.verdict).toBeUndefined();
		expect(refused.body.issues).toBeUndefined();
		expect(h.specs).toEqual([]);

		// Back on the pod both decks were drafted in, the same two holds start.
		room.format = draftPoolId(POD);
		expect((await start(h, { room: ROOM }, '/api/play/matches', 'application/json', edgeHeaders('bob'))).status).toBe(201);
	});

	/** A member of the room who never drafted is told so, in the first person. */
	it('tells a member with no seat in the pod that they have none', async () => {
		const h = await boot();
		const pools = pod(h);
		h.lobby.open(ROOM, [...MEMBERS, { id: CAROL, name: 'user-carol' }], undefined, draftPoolId(POD));
		const res = await putDeck(h, 'carol', built(pools.alice));
		expect(res).toMatchObject({ status: 400, body: { error: `you have no seat in draft ${JSON.stringify(POD)}` } });
	});

	/**
	 * A pod this server does not have is a 409 about the ROOM, the same shape a
	 * missing frozen pool gets. A pod is in memory only, so this is also what a
	 * room on a drafted pool says after a restart.
	 */
	it('answers 409 for a room whose pod this server does not have', async () => {
		const h = await boot();
		const pools = pod(h);
		// A real drafted deck, and a room pointing at a pod that was never opened —
		// which is every room on a drafted pool after a restart, because a pod lives
		// in memory only.
		openRoom(h, draftPoolId('r-no-such-pod'));
		expect(await putDeck(h, 'alice', built(pools.alice))).toMatchObject({
			status: 409,
			body: { error: 'this room\'s draft "r-no-such-pod" is not one this server has' },
		});
		expect(h.specs).toEqual([]);
	});

	/** The leader's picker is offered the pods the CALLER is seated in, and nobody else's. */
	it('offers the caller’s own pods as pools, newest frozen era still last', async () => {
		const h = await boot();
		pod(h);
		const seen = await call(h, 'GET', '/api/tables/formats', undefined, edgeHeaders('alice'));
		const formats = seen.body.formats as { id: string; source: string; cardCount: number; sets: string[] }[];
		expect(formats[0]).toMatchObject({ id: draftPoolId(POD), source: 'draft', cardCount: 45, sets: [] });
		// `newestFormat` on both sides is `formats.at(-1)`: a pod must never become
		// the pool a new room opens on.
		expect(formats.at(-1)?.source).not.toBe('draft');
		expect(formats.at(-1)?.id).toBe(library.formats.at(-1)?.id);

		// Carol drafted nothing, so she is offered no pod at all.
		const hers = await call(h, 'GET', '/api/tables/formats', undefined, edgeHeaders('carol'));
		expect((hers.body.formats as { source: string }[]).filter((f) => f.source === 'draft')).toEqual([]);
	});
});
