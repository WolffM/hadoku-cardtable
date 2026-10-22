/**
 * `/api/decks` — the Decks page: every draft the caller finished, as a deck.
 *
 *   GET    /api/decks          → 200 { decks }
 *   PATCH  /api/decks/:podId   { name } → 200 { deck } | 400 | 404 | 409
 *   DELETE /api/decks/:podId   → 204 | 404 | 409
 *
 * The operator, 2026-10-19: *"whenever a draft is finished, we can consider
 * the pool a new deck … The draft deck should be eternally linked to the
 * unique draft-pool that it was created from."* So a deck is not a copy: it
 * is the caller's finished seat in a pod — the pod's pool, and the build
 * `PUT /api/drafts/:podId/deck` saved against it, whichever screen saved it.
 * Pods are never deleted (`draftRooms.ts`'s header), so the link holds.
 *
 * Renaming and deleting are allowed only once the pod's tournament has
 * concluded (operator, same day) — its room says `done`, or the room is gone.
 * A delete hides the deck from this list and from Free pick's "My decks"; the
 * pod keeps the pool.
 *
 * The caller is `identityFromHeaders`, the same id the draft socket seats
 * them by, so nobody can list or touch another drafter's deck.
 */

import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';

import { RenameDeckBodySchema, type MyDeck, type PodView } from '@hadoku/shared';
import { builtDeckOf, setDeckMeta, stateOf, viewForParticipant, type DraftRoom, type DraftRooms } from '../room/draftRooms.js';
import { identityFromHeaders } from '../room/identity.js';

export interface DecksDeps {
	/** Null when the server has no draft rooms (no cube pool loaded). */
	draftRooms: DraftRooms | null;
	/** The lobby room a pod belongs to, by the same id — its name and pod; undefined once it is gone. */
	room: (roomId: string) => { name: string; pod: PodView | null } | undefined;
	log?: (entry: Record<string, unknown>) => void;
}

/** The caller's deck in this pod, or null: no seat, the draft is not finished, or they deleted it. */
function deckIn(room: DraftRoom, caller: string, deps: DecksDeps, draftRooms: DraftRooms): MyDeck | null {
	if (room.app.state === null || stateOf(room).status !== 'complete') return null;
	const view = viewForParticipant(room, caller);
	if (view.viewer.kind !== 'seat') return null;
	const meta = room.app.deckMeta[caller];
	if (meta?.deleted === true) return null;
	const lobbyRoom = deps.room(room.roomId);
	const cube = draftRooms.cubeMetaOf(room).name;
	return {
		id: room.roomId,
		name: meta?.name ?? lobbyRoom?.name ?? cube,
		cube,
		createdAt: room.createdAt,
		pool: view.viewer.pool,
		deck: builtDeckOf(room, caller),
		concluded: lobbyRoom === undefined || lobbyRoom.pod?.phase === 'done',
	};
}

export function attachDecks(api: Router, deps: DecksDeps): void {
	const log = deps.log ?? ((entry) => console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'cardtable-decks', ...entry })));
	const decks = express.Router();
	decks.use(express.json({ limit: '4kb' }));

	const callerOf = (req: Request): string => identityFromHeaders(req.headers, `http-${randomUUID()}`);

	decks.get('/', (req: Request, res: Response) => {
		const draftRooms = deps.draftRooms;
		if (draftRooms === null) {
			res.json({ decks: [] });
			return;
		}
		const caller = callerOf(req);
		const mine = draftRooms
			.all()
			.flatMap((room) => deckIn(room, caller, deps, draftRooms) ?? [])
			.sort((a, b) => b.createdAt - a.createdAt);
		res.json({ decks: mine });
	});

	/** The caller's concluded deck in this pod, or the refusal already sent. */
	const concludedDeck = (req: Request, res: Response): { room: DraftRoom; caller: string; deck: MyDeck } | null => {
		const podId = String(req.params.podId);
		const room = deps.draftRooms?.find(podId);
		const caller = callerOf(req);
		const deck = room === undefined || deps.draftRooms === null ? null : deckIn(room, caller, deps, deps.draftRooms);
		if (room === undefined || deck === null) {
			res.status(404).json({ error: `you have no deck from ${JSON.stringify(podId)}` });
			return null;
		}
		if (!deck.concluded) {
			res.status(409).json({ error: 'the tournament this deck is from is still being played' });
			return null;
		}
		return { room, caller, deck };
	};

	decks.patch('/:podId', (req: Request, res: Response) => {
		const body = RenameDeckBodySchema.safeParse(req.body);
		if (!body.success) {
			res.status(400).json({ error: 'body is { name }, 1 to 60 characters' });
			return;
		}
		const found = concludedDeck(req, res);
		if (found === null) return;
		setDeckMeta(found.room, found.caller, { name: body.data.name });
		log({ evt: 'deck-renamed', podId: found.room.roomId });
		res.json({ deck: { ...found.deck, name: body.data.name } });
	});

	decks.delete('/:podId', (req: Request, res: Response) => {
		const found = concludedDeck(req, res);
		if (found === null) return;
		setDeckMeta(found.room, found.caller, { deleted: true });
		log({ evt: 'deck-deleted', podId: found.room.roomId });
		res.status(204).end();
	});

	api.use('/decks', decks);
	// `express.json()`'s parse failure, same shape as `http/drafts.ts`'s handler.
	api.use('/decks', (err: unknown, _req: Request, res: Response, next: NextFunction) => {
		if (res.headersSent) return next(err);
		const e = err as { type?: unknown; status?: unknown };
		if (e.type === 'entity.parse.failed' || (typeof e.status === 'number' && e.status >= 400 && e.status < 500)) {
			res.status(400).json({ error: 'the request body could not be read' });
			return;
		}
		next(err);
	});
}
