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
 *
 * A deck drafted from a cube carries the cube's own cover (`coverArtId`, the id
 * `CubeArt` draws), which its tile shows when none of its cards has art.
 *
 * ## Yours, or still the draft's (wave 125)
 *
 * The Library sorts a deck by whether it is yours yet (operator, 2026-11-23): a drafted deck is
 * `touched` once renamed, starred, or played outside its tournament, and `inTournament` while its
 * tournament runs (no rename, delete or art rule applies then). `concludedAt` is when the
 * tournament ended: the pod's own `endedAt`, kept since pods record it; for a pod that finished
 * before that (or whose room is gone) the tournament record's `endedAt` (`tournaments.json`, one per
 * pod that played a round); null when neither knows, and then no game counts as "outside" it.
 * "Played outside" is the deck's `lastPlayedAt` (the caller's own document, `users/`) after
 * `concludedAt`. A build saved after the tournament would count too, but the pod keeps no time for
 * a save, so it does not yet.
 */

import express, { type Request, type Response, type Router } from 'express';

import { RenameDeckBodySchema, type DraftPlan, type MyDeck, type PodView } from '@hadoku/shared';
import { builtDeckOf, setDeckMeta, stateOf, viewForParticipant, type DraftRoom, type DraftRooms } from '../room/draftRooms.js';
import { bodyErrors, httpCaller } from '@hadoku/game-server/http/request';
import { accountIdOf } from '@hadoku/game-server/edge-auth';
import { isStorableUserId } from '@hadoku/game-server/users/store';
import { jsonLogger } from '@hadoku/service-kernel/log';
import type { MagicUserDoc, MagicUserStore } from '../users/index.js';

export interface DecksDeps {
	/** Null when the server has no draft rooms (no cube pool loaded). */
	draftRooms: DraftRooms | null;
	/** The lobby room a pod belongs to, by the same id — its name, pod and plan; undefined once it is gone. */
	room: (roomId: string) => { name: string; game?: { pod: (PodView & { endedAt?: number }) | null; plan?: DraftPlan } } | undefined;
	/** A cube's cover art id (`CubeSummary.artId`), or null when it has none. */
	cubeCover?: (cubeId: string) => string | null;
	log?: (entry: Record<string, unknown>) => void;
	/** The caller's own document: their stars and last-played stamps. Absent: nothing is starred or played. */
	users?: Pick<MagicUserStore, 'get'>;
	/** Every kept tournament record's id (`<roomId>-<draftStartedAt>`) and end, for a pod that kept no end of its own. */
	tournamentEnds?: () => Promise<readonly { id: string; endedAt: number }[]>;
}

/** What a deck's place in the Library is read from, beyond the pod: the caller's document and the tournaments' ends. */
interface LibraryFacts {
	doc: MagicUserDoc | null;
	ends: readonly { id: string; endedAt: number }[];
}

const NO_FACTS: LibraryFacts = { doc: null, ends: [] };

/** The stats and document id of a drafted deck (`http/routes.ts`'s `draftedDeckId`). */
const deckIdOf = (podId: string): string => `draft:${podId}`;

/** When this pod's tournament ended, or null: its own `endedAt`, else its tournament record's, the first to end after its deal. */
function concludedAtOf(podId: string, createdAt: number, pod: { endedAt?: number } | null | undefined, ends: LibraryFacts['ends']): number | null {
	if (pod?.endedAt !== undefined) return pod.endedAt;
	const mine = ends.filter((t) => t.id.startsWith(`${podId}-`) && t.endedAt >= createdAt).sort((a, b) => a.endedAt - b.endedAt);
	return mine[0]?.endedAt ?? null;
}

/** The caller's deck in this pod, or null: no seat, the draft is not finished, or they deleted it. */
function deckIn(room: DraftRoom, caller: string, deps: DecksDeps, draftRooms: DraftRooms, facts: LibraryFacts = NO_FACTS): MyDeck | null {
	if (room.app.state === null || stateOf(room).status !== 'complete') return null;
	const view = viewForParticipant(room, caller);
	if (view.viewer.kind !== 'seat') return null;
	const meta = room.app.deckMeta[caller];
	if (meta?.deleted === true) return null;
	const lobbyRoom = deps.room(room.roomId);
	const cube = draftRooms.cubeMetaOf(room).name;
	// Round 1's source, as `cubeMetaOf` names it.
	const source = lobbyRoom?.game?.plan?.rounds[0];
	const coverArtId = source?.kind === 'cube' ? (deps.cubeCover?.(source.cubeId) ?? null) : null;
	const concluded = lobbyRoom === undefined || lobbyRoom.game?.pod?.phase === 'done';
	const concludedAt = concluded ? concludedAtOf(room.roomId, room.createdAt, lobbyRoom?.game?.pod, facts.ends) : null;
	const deckId = deckIdOf(room.roomId);
	const lastPlayedAt = facts.doc?.decks[deckId]?.lastPlayedAt;
	const playedOutside = concludedAt !== null && lastPlayedAt !== undefined && lastPlayedAt > concludedAt;
	return {
		id: room.roomId,
		name: meta?.name ?? lobbyRoom?.name ?? cube,
		cube,
		createdAt: room.createdAt,
		pool: view.viewer.pool,
		deck: builtDeckOf(room, caller),
		concluded,
		...(coverArtId === null ? {} : { coverArtId }),
		touched: meta?.name !== undefined || facts.doc?.favourites[deckId] !== undefined || playedOutside,
		inTournament: !concluded,
		concludedAt,
	};
}

export function attachDecks(api: Router, deps: DecksDeps): void {
	const log = deps.log ?? jsonLogger('cardtable-decks');
	const decks = express.Router();
	decks.use(express.json({ limit: '4kb' }));

	/** The caller's document and the tournaments' ends. A store that cannot answer costs the Library its order, never the list: logged, and read as nothing. */
	const factsFor = async (req: Request): Promise<LibraryFacts> => {
		const userId = accountIdOf(req);
		const [doc, ends] = await Promise.all([
			userId === null || !isStorableUserId(userId) || deps.users === undefined
				? null
				: deps.users.get(userId).catch((err: unknown) => {
						log({ evt: 'decks-doc-unreadable', error: (err as Error).message });
						return null;
					}),
			(deps.tournamentEnds?.() ?? Promise.resolve([])).catch((err: unknown) => {
				log({ evt: 'decks-tournaments-unreadable', error: (err as Error).message });
				return [];
			}),
		]);
		return { doc, ends };
	};

	decks.get('/', (req: Request, res: Response) => {
		const draftRooms = deps.draftRooms;
		if (draftRooms === null) {
			res.json({ decks: [] });
			return;
		}
		const caller = httpCaller(req);
		void factsFor(req).then((facts) => {
			const mine = draftRooms
				.all()
				.flatMap((room) => deckIn(room, caller, deps, draftRooms, facts) ?? [])
				.sort((a, b) => b.createdAt - a.createdAt);
			res.json({ decks: mine });
		});
	});

	/** The caller's concluded deck in this pod, or the refusal already sent. */
	const concludedDeck = (req: Request, res: Response): { room: DraftRoom; caller: string; deck: MyDeck } | null => {
		const podId = String(req.params.podId);
		const room = deps.draftRooms?.find(podId);
		const caller = httpCaller(req);
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
		res.json({ deck: { ...found.deck, name: body.data.name, touched: true } });
	});

	decks.delete('/:podId', (req: Request, res: Response) => {
		const found = concludedDeck(req, res);
		if (found === null) return;
		setDeckMeta(found.room, found.caller, { deleted: true });
		log({ evt: 'deck-deleted', podId: found.room.roomId });
		res.status(204).end();
	});

	api.use('/decks', decks);
	api.use('/decks', bodyErrors());
}
