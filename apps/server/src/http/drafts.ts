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
 * ## Saving is not playing
 *
 * The PUT stores any build made of the caller's own pool plus basics, finished
 * or not: the builder autosaves every move, and a build on its way to forty is
 * work a reload must not lose. So it refuses what can never become a legal
 * deck — a card the caller did not draft, a malformed `.dck` — and nothing
 * else. Deck size is not a save condition. The table is where a build is
 * judged as a deck: `checkSeat` at `POST …/rooms/:id/ready` and at a start
 * refuses one under forty, whatever this route stored.
 *
 * Both routes resolve the caller the same way `http/routes.ts`'s
 * `draftPoolForMember` does: `identityFromHeaders`, never a body field — a
 * drafted pool is the caller's own hidden information, so there is no way to
 * ask for somebody else's by naming them.
 *
 * ## Why a seat check happens twice on the PUT path
 *
 * Once here (`viewForParticipant`, for the 404) and once inside `checkSeat`
 * (via `routes.ts`'s `draftPoolForMember`, the lookup every table route uses,
 * for the pool itself). Both read the same `viewForParticipant`, so they can
 * never disagree about WHETHER the caller has a seat — only the second one also
 * returns the pool's cards, which the first one does not need.
 *
 * ## `checkSeat` needs a `GateContext`, and this route has no library
 *
 * `GateContext.library` is read only by the `library` deck-ref arm and the
 * `standard` rules arm (`gate.ts`'s `checkSeat`) — neither of which a draft
 * save ever takes, since the body is always `{ dck }` against `{ kind: 'draft'
 * }`. `EMPTY_LIBRARY` below is never read on this path; it exists only because
 * the type is not optional.
 */

import express, { type Request, type Response, type Router } from 'express';

import { builtDeckOf, saveBuiltDeck, viewForParticipant, type DraftRooms } from '../room/draftRooms.js';
import { checkSeat, MAX_DCK_BYTES, type GateContext, type WireIssue } from './gate.js';
import type { TablesLibrary } from './library.js';
import { bodyErrors, httpCaller } from './request.js';
import { draftPoolForMember } from './routes.js';
import { jsonLogger } from '../log.js';

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

/** What a table refuses and a save does not: an unfinished build is still a build. */
const UNFINISHED: ReadonlySet<WireIssue['kind']> = new Set(['under-minimum-size']);

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

export function attachDrafts(api: Router, deps: DraftsDeps): void {
	const log = deps.log ?? jsonLogger('cardtable-drafts');

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

		const caller = httpCaller(req);
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

		const caller = httpCaller(req);
		const view = viewForParticipant(room, caller);
		if (view.viewer.kind !== 'seat') return noSeat(res, podId);

		const body = parseSaveBody(req.body);
		if (!body.ok) {
			res.status(400).json({ issues: [body.error] });
			return;
		}

		// The gate's own draft rule, minus what only a finished deck must meet
		// (this module's header): a save refuses a card from outside the pool
		// and a malformed file, never a build that is merely short.
		const ctx: GateContext = { library: EMPTY_LIBRARY, draftPool: draftPoolForMember(caller, draftRooms) };
		const verdict = checkSeat({ deck: { dck: body.dck }, rules: { kind: 'draft', draftId: podId } }, ctx);
		if ('error' in verdict) {
			res.status(400).json({ issues: [verdict.error] });
			return;
		}
		const refused = verdict.issues.filter((issue) => !UNFINISHED.has(issue.kind));
		if (refused.length > 0) {
			res.status(400).json({ issues: refused.map((issue) => issue.message) });
			return;
		}

		saveBuiltDeck(room, caller, verdict.text);
		log({ evt: 'deck-saved', podId, bytes: verdict.text.length });
		res.json({ deck: verdict.text });
	});

	api.use('/drafts', drafts);

	api.use('/drafts', bodyErrors((name) => log({ evt: 'drafts-error', name })));
}
