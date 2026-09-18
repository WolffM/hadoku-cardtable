/**
 * The constructed table's HTTP surface, and the gate in front of play's start
 * route. `attachTables` is the one call `src/index.ts` makes.
 *
 * ## Routes
 *
 * All on the `api` router `index.ts` mounts behind `requireMinTier`, so every
 * one of them is behind the same friend-tier floor as everything else. There is
 * no public tier here and nothing to configure one.
 *
 *   GET  /api/tables/formats   the frozen Standard pools, oldest first
 *   GET  /api/tables/decks     the deck library, with each list
 *   POST /api/tables/check     `{ deck, rules }` → the verdict, without starting anything
 *   POST /api/play/matches     GATED: see below
 *
 * ## The gate sits on play's own route, not beside it
 *
 * A second "start a match" endpoint would be a second thing to keep correct —
 * the concurrency cap, the 503 when Forge is absent, the warm spare lane C is
 * adding — so there is none. Instead this mounts a handler on the SAME path,
 * ahead of play's, and every request to it goes through the gate first:
 *
 *   - `{ opponent?, seats: [{ deck, rules }, { deck, rules }] }` — the product's
 *     body. Each seat is checked (`gate.ts`); any illegal seat answers **422**
 *     naming the deck and the card; otherwise the body is rewritten to play's
 *     own `{ opponent, decks: [dck, dck] }` and handed on with `next()`.
 *   - play's raw body with a non-null `decks` entry — refused with 422. A deck
 *     nobody checked does not reach Forge by the side door.
 *   - play's raw body with no decks, or null decks — handed on untouched. Those
 *     are Forge's own random precons, which belong to no format of ours, and it
 *     is what the dev tooling and the Wave 9 live check send.
 *
 * **This makes mount order load-bearing**: `attachTables` must be called BEFORE
 * `attachPlay`, or play's handler answers first and the gate never runs. The
 * README's `index.ts` edit places it that way, and `tables.test.ts` mounts the
 * two in the same order against the real `attachPlay`.
 */

import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';

import type { DraftRooms } from '../room/draftRooms.js';
import { viewForParticipant } from '../room/draftRooms.js';
import { identityFromHeaders } from '../room/identity.js';
import {
	checkSeat,
	parseSeatRequest,
	parseStartRequest,
	publicVerdict,
	refusalLine,
	type DraftPoolLookup,
	type GateContext,
	type SeatVerdict,
} from './gate.js';
import { loadTablesLibrary, type TablesLibrary } from './library.js';

export type TablesLog = (entry: Record<string, unknown>) => void;

export interface TablesDeps {
	/** The repository root; decks are read from `<repoRoot>/decks`. */
	repoRoot: string;
	/** The server's draft rooms, for the `draft` rule. Null when no cube pool loaded. */
	draftRooms: DraftRooms | null;
	log?: TablesLog;
	/** Tests hand in a library directly. Production reads `repoRoot`. */
	library?: TablesLibrary;
}

export interface TablesHandle {
	library: TablesLibrary;
}

function defaultLog(entry: Record<string, unknown>): void {
	console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'cardtable-tables', ...entry }));
}

/**
 * The caller's own drafted pool, found by their derived identity.
 *
 * The socket id argument is only reached when the edge named nobody, and then
 * the id is ephemeral and random, so it matches no seat — which is the right
 * answer for someone the edge could not name.
 */
function draftPoolFor(req: Request, rooms: DraftRooms | null): DraftPoolLookup | null {
	if (rooms === null) return null;
	return (draftId) => {
		const room = rooms.find(draftId);
		if (room === undefined) return { ok: false, error: `no draft ${JSON.stringify(draftId)} on this server` };
		const participant = identityFromHeaders(req.headers, `http-${randomUUID()}`);
		const view = viewForParticipant(room, participant);
		if (view.viewer.kind !== 'seat') return { ok: false, error: `you have no seat in draft ${JSON.stringify(draftId)}` };
		return { ok: true, pool: view.viewer.pool };
	};
}

export function attachTables(api: Router, deps: TablesDeps): TablesHandle {
	const log = deps.log ?? defaultLog;
	const library = deps.library ?? loadTablesLibrary(deps.repoRoot);
	log({ evt: 'library', formats: library.formats.length, decks: library.decks.length, faults: library.faults });

	const context = (req: Request): GateContext => ({ library, draftPool: draftPoolFor(req, deps.draftRooms) });

	/* ── the catalog ────────────────────────────────────────────────── */

	const tables = express.Router();
	tables.use(express.json({ limit: '256kb' }));

	tables.get('/formats', (_req: Request, res: Response) => {
		res.json({
			formats: library.formats.map((f) => ({
				id: f.id,
				name: f.fixture.name,
				effective: f.fixture.effective,
				sets: f.fixture.sets,
				banned: f.fixture.banned,
				cardCount: f.fixture.cards.length,
				source: f.fixture.source,
			})),
		});
	});

	tables.get('/decks', (_req: Request, res: Response) => {
		const list = (section: string, file: TablesLibrary['decks'][number]['deck']['file']) =>
			(file.sections.get(section) ?? []).map((e) => ({ count: e.count, name: e.card.name }));
		res.json({
			decks: library.decks.map((d) => ({
				id: d.id,
				collection: d.collection,
				name: d.deck.name,
				format: d.deck.format,
				date: d.deck.date,
				provenance: d.deck.provenance,
				citation: d.deck.citation,
				main: list('main', d.deck.file),
				sideboard: list('sideboard', d.deck.file),
			})),
		});
	});

	tables.post('/check', (req: Request, res: Response) => {
		const parsed = parseSeatRequest(req.body, 'body');
		if (!parsed.ok) {
			res.status(400).json({ error: parsed.error });
			return;
		}
		const verdict = checkSeat(parsed.value, context(req));
		if ('error' in verdict) {
			res.status(400).json({ error: verdict.error });
			return;
		}
		res.json(publicVerdict(verdict));
	});

	api.use('/tables', tables);

	/* ── the gate on play's start route ─────────────────────────────── */

	const gate = express.Router();
	gate.use(express.json({ limit: '256kb' }));

	gate.post('/matches', (req: Request, res: Response, next: NextFunction) => {
		const body = (req.body ?? {}) as Record<string, unknown>;

		if (typeof body !== 'object' || Array.isArray(body) || !('seats' in body)) {
			const decks = (body as { decks?: unknown }).decks;
			if (Array.isArray(decks) && decks.some((d) => d !== null)) {
				log({ evt: 'unchecked-deck-refused' });
				res.status(422).json({
					error: 'a deck must be checked before a match starts: send { seats: [{ deck, rules }, { deck, rules }] }',
				});
				return;
			}
			next();
			return;
		}

		const parsed = parseStartRequest(body);
		if (!parsed.ok) {
			res.status(400).json({ error: parsed.error });
			return;
		}
		const ctx = context(req);
		const verdicts: SeatVerdict[] = [];
		for (const [i, seat] of parsed.value.seats.entries()) {
			const verdict = checkSeat(seat, ctx);
			if ('error' in verdict) {
				res.status(400).json({ error: `seat ${i + 1}: ${verdict.error}`, seat: i });
				return;
			}
			verdicts.push(verdict);
		}

		const illegal = verdicts.findIndex((v) => !v.legal);
		if (illegal !== -1) {
			const error = refusalLine(illegal, verdicts[illegal] as SeatVerdict);
			log({ evt: 'illegal-deck-refused', seat: illegal, issues: verdicts[illegal]?.issues.length });
			res.status(422).json({ error, seats: verdicts.map(publicVerdict) });
			return;
		}

		// Play's own body. `decks` is the checked text, byte for byte.
		req.body = { opponent: parsed.value.opponent, decks: verdicts.map((v) => v.text) };
		log({ evt: 'decks-checked', decks: verdicts.map((v) => v.deckName), rules: verdicts.map((v) => v.rulesName) });
		next();
	});

	api.use('/play', gate);

	return { library };
}
