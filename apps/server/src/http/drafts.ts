/**
 * `/api/drafts` — a drafter's own pool, and the build they have saved against it.
 *
 * Mounted on the `api` router the same way `/api/rooms`/`/api/sounds` are —
 * after `requireMinTier`, so every caller here is already friend tier (see
 * `index.ts`'s header).
 *
 *   GET /api/drafts/:podId/mine   → 200 { pool, deck } | 404 — no seat in that pod
 *   PUT /api/drafts/:podId/deck   { dck } → 200 { deck } | 400 { issues } | 404
 *
 * Both routes resolve the caller the same way `http/routes.ts`'s
 * `draftPoolForMember` does: `identityFromHeaders`, never a body field — a
 * drafted pool is the caller's own hidden information, so there is no way to
 * ask for somebody else's by naming them.
 *
 * ## Why a seat check happens twice on the PUT path
 *
 * Once here (`viewForParticipant`, for the 404) and once inside `checkSeat`
 * (via the `draftPool` lookup built below, for the pool itself). Both read the
 * same `viewForParticipant`, so they can never disagree about WHETHER the
 * caller has a seat — only the second one also returns the pool's cards, which
 * the first one does not need. Not deduplicated against `routes.ts`'s own
 * private `draftPoolForMember`: that function is not exported, and this file
 * does not edit `routes.ts`.
 *
 * ## `checkSeat` needs a `GateContext`, and this route has no library
 *
 * `GateContext.library` is read only by the `library` deck-ref arm and the
 * `standard` rules arm (`gate.ts`'s `checkSeat`) — neither of which a draft
 * save ever takes, since the body is always `{ dck }` against `{ kind: 'draft'
 * }`. `EMPTY_LIBRARY` below is never read on this path; it exists only because
 * the type is not optional.
 */

import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';

import { builtDeckOf, saveBuiltDeck, viewForParticipant, type DraftRooms } from '../room/draftRooms.js';
import { identityFromHeaders } from '../room/identity.js';
import { checkSeat, MAX_DCK_BYTES, type DraftPoolLookup, type GateContext } from './gate.js';
import type { TablesLibrary } from './library.js';

export interface DraftsDeps {
	/** Null when the server has no draft rooms (no cube pool loaded). */
	draftRooms: DraftRooms | null;
	log?: (entry: Record<string, unknown>) => void;
}

/** Never read on this path — see this module's header. */
const EMPTY_LIBRARY: TablesLibrary = {
	formats: [],
	decks: [],
	faults: [],
	format: () => undefined,
	deck: () => undefined,
};

function callerIdOf(req: Request): string {
	return identityFromHeaders(req.headers, `http-${randomUUID()}`);
}

function noSuchPod(res: Response, podId: string): void {
	res.status(404).json({ error: `no draft ${JSON.stringify(podId)} on this server` });
}

function noSeat(res: Response, podId: string): void {
	res.status(404).json({ error: `you have no seat in draft ${JSON.stringify(podId)}` });
}

/** `{ dck: string }`, and nothing else. The PUT body is never `{ library }` — this route has no catalogue to look one up in. */
function parseSaveBody(raw: unknown): { ok: true; dck: string } | { ok: false; error: string } {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'body is { dck }' };
	const keys = Object.keys(raw as Record<string, unknown>);
	if (keys.length !== 1 || keys[0] !== 'dck') return { ok: false, error: 'body is { dck }' };
	const dck = (raw as { dck?: unknown }).dck;
	if (typeof dck !== 'string' || dck.trim() === '' || dck.length > MAX_DCK_BYTES) {
		return { ok: false, error: `body.dck is .dck text (at most ${MAX_DCK_BYTES} bytes)` };
	}
	return { ok: true, dck };
}

/**
 * The caller's own pool, by pod — exactly `draftPoolForMember`'s shape
 * (`routes.ts:319`), independently built because that function is not
 * exported. `checkSeat`'s draft rule calls this to find what the submitted
 * `.dck` is checked against.
 */
function draftPoolLookup(draftRooms: DraftRooms, participantId: string): DraftPoolLookup {
	return (draftId) => {
		const room = draftRooms.find(draftId);
		if (room === undefined) return { ok: false, error: `no draft ${JSON.stringify(draftId)} on this server` };
		const view = viewForParticipant(room, participantId);
		if (view.viewer.kind !== 'seat') return { ok: false, error: `you have no seat in draft ${JSON.stringify(draftId)}` };
		return { ok: true, pool: view.viewer.pool };
	};
}

export function attachDrafts(api: Router, deps: DraftsDeps): void {
	const log =
		deps.log ??
		((entry: Record<string, unknown>) =>
			console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'cardtable-drafts', ...entry })));

	const drafts = express.Router();
	// A tighter limit than the `api` router's own 1mb: `.dck` text is checked
	// against MAX_DCK_BYTES below regardless, so nothing legitimate needs more.
	drafts.use(express.json({ limit: '256kb' }));

	drafts.get('/:podId/mine', (req: Request, res: Response) => {
		const draftRooms = deps.draftRooms;
		const podId = String(req.params.podId);
		if (draftRooms === null) return noSuchPod(res, podId);
		const room = draftRooms.find(podId);
		if (room === undefined) return noSuchPod(res, podId);

		const caller = callerIdOf(req);
		const view = viewForParticipant(room, caller);
		if (view.viewer.kind !== 'seat') return noSeat(res, podId);

		res.json({ pool: view.viewer.pool, deck: builtDeckOf(room, caller) });
	});

	drafts.put('/:podId/deck', (req: Request, res: Response) => {
		const draftRooms = deps.draftRooms;
		const podId = String(req.params.podId);
		if (draftRooms === null) return noSuchPod(res, podId);
		const room = draftRooms.find(podId);
		if (room === undefined) return noSuchPod(res, podId);

		const caller = callerIdOf(req);
		const view = viewForParticipant(room, caller);
		if (view.viewer.kind !== 'seat') return noSeat(res, podId);

		const body = parseSaveBody(req.body);
		if (!body.ok) {
			res.status(400).json({ issues: [body.error] });
			return;
		}

		// The gate's own draft rule — the same check a table start will make —
		// so a save that lands here is exactly what will be accepted there.
		const ctx: GateContext = { library: EMPTY_LIBRARY, draftPool: draftPoolLookup(draftRooms, caller) };
		const verdict = checkSeat({ deck: { dck: body.dck }, rules: { kind: 'draft', draftId: podId } }, ctx);
		if ('error' in verdict) {
			res.status(400).json({ issues: [verdict.error] });
			return;
		}
		if (!verdict.legal) {
			res.status(400).json({ issues: verdict.issues.map((issue) => issue.message) });
			return;
		}

		saveBuiltDeck(room, caller, verdict.text);
		log({ evt: 'deck-saved', podId, bytes: verdict.text.length });
		res.json({ deck: verdict.text });
	});

	api.use('/drafts', drafts);

	// Errors on /drafts — chiefly `express.json()`'s parse failure, raised on
	// the api router before `drafts` runs. Same shape as `http/sounds.ts`'s own
	// handler, for the same reason.
	api.use('/drafts', (err: unknown, _req: Request, res: Response, next: NextFunction) => {
		if (res.headersSent) return next(err);
		const e = err as { type?: unknown; status?: unknown; name?: unknown };
		if (e.type === 'entity.parse.failed') {
			res.status(400).json({ error: 'body is not valid JSON' });
			return;
		}
		if (typeof e.status === 'number' && e.status >= 400 && e.status < 500) {
			res.status(400).json({ error: 'the request body could not be read' });
			return;
		}
		log({ evt: 'drafts-error', name: typeof e.name === 'string' ? e.name : 'unknown' });
		res.status(500).json({ error: 'internal error' });
	});
}
